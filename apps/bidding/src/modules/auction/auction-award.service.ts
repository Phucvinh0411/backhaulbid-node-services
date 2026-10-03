import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { DepositStatus } from '../../common/enums/deposit-status.enum';
import { RegistrationPaymentStatus } from '../../common/enums/registration-payment-status.enum';
import { CreationFeeStatus } from '../../common/enums/creation-fee-status.enum';
import { WalletClient } from '../../integrations/wallet/wallet.client';
import { ContractAwardClient } from '../../integrations/contracts/contract-award.client';
import { AuctionNotificationClient } from '../../integrations/notifications/auction-notification.client';
import {
  AuctionRegistration,
  AuctionRegistrationDocument,
} from '../auction-registration/schemas/auction-registration.schema';
import { Bid, BidDocument } from '../bid/schemas/bid.schema';
import {
  Auction,
  AuctionAwardAttempt,
  AuctionAwardAttemptStatus,
  AuctionDocument,
} from './schemas/auction.schema';

const SIGNING_WINDOW_MS = 24 * 60 * 60 * 1000;
const BACKUP_CARRIER_LIMIT = 3;
const AWARD_POLL_INTERVAL_MS = 30_000;

@Injectable()
export class AuctionAwardService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuctionAwardService.name);
  private pollTimer: NodeJS.Timeout | undefined;

  constructor(
    @InjectModel(Auction.name)
    private readonly auctionModel: Model<AuctionDocument>,
    @InjectModel(Bid.name)
    private readonly bidModel: Model<BidDocument>,
    @InjectModel(AuctionRegistration.name)
    private readonly registrationModel: Model<AuctionRegistrationDocument>,
    private readonly contractAwardClient: ContractAwardClient,
    private readonly walletClient: WalletClient,
    private readonly notificationClient: AuctionNotificationClient,
  ) {}

  onModuleInit() {
    this.pollTimer = setInterval(() => {
      void this.processAwardAttempts().catch((error) => {
        this.logger.error(`Award deadline processing failed: ${this.errorMessage(error)}`);
      });
    }, AWARD_POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
    void this.processAwardAttempts().catch((error) => {
      this.logger.error(`Initial award deadline processing failed: ${this.errorMessage(error)}`);
    });
  }

  onModuleDestroy() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  async createForWinner(auction: AuctionDocument, winningBid: BidDocument | null) {
    if (!winningBid) {
      auction.awardStatus = 'NO_WINNER';
      auction.awardError = null;
      await auction.save();
      return;
    }

    if (auction.awardAttempts?.length) {
      const failedCreationIndex = auction.awardAttempts.findIndex(
        (attempt) => attempt.status === AuctionAwardAttemptStatus.CREATION_FAILED,
      );
      if (failedCreationIndex >= 0) await this.startAttempt(auction, failedCreationIndex);
      return;
    }

    const bids = await this.bidModel
      .find({ auctionId: auction._id })
      .sort({ bidAmount: 1, bidTime: 1 })
      .exec();
    const registrations = await this.registrationModel
      .find({ auctionId: auction._id })
      .exec();
    const registrationByCarrier = new Map(
      registrations.map((registration) => [registration.carrierId, registration]),
    );
    const selected: BidDocument[] = [winningBid];
    const seenCarriers = new Set([winningBid.carrierId]);

    for (const bid of bids) {
      if (selected.length >= BACKUP_CARRIER_LIMIT + 1) break;
      if (seenCarriers.has(bid.carrierId)) continue;
      const registration = registrationByCarrier.get(bid.carrierId);
      if (!this.isEligible(registration, auction.isDepositRequired)) continue;
      seenCarriers.add(bid.carrierId);
      selected.push(bid);
    }

    const awardAttempts = selected.map((bid, index) => ({
      attemptId: randomUUID(),
      attemptNumber: index + 1,
      bidId: bid._id,
      carrierId: bid.carrierId,
      bidAmount: bid.bidAmount.toString(),
      status: AuctionAwardAttemptStatus.QUEUED,
      signingDeadlineAt: null,
      tripId: null,
      contractId: null,
      failureReason: null,
    })) as AuctionAwardAttempt[];
    const claim = await this.auctionModel.updateOne(
      {
        _id: auction._id,
        $or: [
          { awardAttempts: { $exists: false } },
          { awardAttempts: { $size: 0 } },
        ],
      },
      {
        $set: {
          awardAttempts,
          awardStatus: 'PENDING',
          awardError: null,
          awardCleanupCompleted: false,
        },
      },
    ).exec();
    if (claim.matchedCount === 0) return;

    auction.awardAttempts = awardAttempts;
    auction.awardStatus = 'PENDING';
    auction.awardError = null;
    await this.startAttempt(auction, 0);
  }

  async processAwardAttempts() {
    const auctions = await this.auctionModel
      .find({
        awardAttempts: {
          $elemMatch: {
            status: {
              $in: [
                AuctionAwardAttemptStatus.CREATING,
                AuctionAwardAttemptStatus.CREATION_FAILED,
                AuctionAwardAttemptStatus.AWAITING_CARRIER_SIGNATURE,
                AuctionAwardAttemptStatus.AWAITING_SHIPPER_SIGNATURE,
              ],
            },
          },
        },
      })
      .limit(100)
      .exec();

    for (const auction of auctions) {
      try {
        const index = auction.awardAttempts.findIndex((attempt) =>
          [
            AuctionAwardAttemptStatus.CREATING,
            AuctionAwardAttemptStatus.CREATION_FAILED,
            AuctionAwardAttemptStatus.AWAITING_CARRIER_SIGNATURE,
            AuctionAwardAttemptStatus.AWAITING_SHIPPER_SIGNATURE,
          ].includes(attempt.status),
        );
        if (index < 0) continue;
        const attempt = auction.awardAttempts[index];

        if (
          attempt.status === AuctionAwardAttemptStatus.CREATION_FAILED ||
          attempt.status === AuctionAwardAttemptStatus.CREATING
        ) {
          await this.startAttempt(auction, index);
          continue;
        }
        if (!attempt.contractId) continue;

        let status = await this.contractAwardClient.status(attempt.attemptId);
        if (status.status === 'SIGNED') {
          await this.finishSignedAttempt(auction, attempt);
          continue;
        }

        if (status.carrierSigned && !status.shipperSigned) {
          if (attempt.status !== AuctionAwardAttemptStatus.AWAITING_SHIPPER_SIGNATURE) {
            attempt.status = AuctionAwardAttemptStatus.AWAITING_SHIPPER_SIGNATURE;
            attempt.signingDeadlineAt = status.signingDeadlineAt
              ? new Date(status.signingDeadlineAt)
              : null;
            await auction.save();
            await this.notifyShipperSignatureRequired(auction, attempt);
          }
        }

        const deadline = status.signingDeadlineAt
          ? new Date(status.signingDeadlineAt)
          : attempt.signingDeadlineAt;
        if (status.status === 'EXPIRED' || (deadline && deadline.getTime() <= Date.now())) {
          status = await this.contractAwardClient.expire(attempt.attemptId);
          if (status.status === 'EXPIRED' || status.status === 'CANCELLED') {
            await this.finishExpiredAttempt(auction, attempt, status.carrierSigned);
          }
        }
      } catch (error) {
        this.logger.warn(
          `Unable to process award ${auction._id}: ${this.errorMessage(error)}`,
        );
      }
    }

    await this.retryExpiredCarrierDeposits();
    await this.retryTerminalActions();
  }

  private async retryExpiredCarrierDeposits() {
    const auctions = await this.auctionModel
      .find({
        awardAttempts: {
          $elemMatch: { status: AuctionAwardAttemptStatus.CARRIER_EXPIRED },
        },
      })
      .limit(100)
      .exec();
    for (const auction of auctions) {
      for (const attempt of auction.awardAttempts) {
        if (attempt.status !== AuctionAwardAttemptStatus.CARRIER_EXPIRED) continue;
        await this.releaseCarrierDeposit(auction._id, attempt.carrierId, attempt.attemptId);
      }
    }
  }

  private async retryTerminalActions() {
    const auctions = await this.auctionModel
      .find({
        awardCleanupCompleted: { $ne: true },
        awardStatus: {
          $in: ['SIGNED', 'NO_CARRIER_SIGNED', 'SHIPPER_SIGNATURE_EXPIRED'],
        },
      })
      .limit(100)
      .exec();

    for (const auction of auctions) {
      try {
        let cleanupCompleted = false;
        if (auction.awardStatus === 'NO_CARRIER_SIGNED') {
          const depositsReleased = await this.releaseDeposits(auction._id);
          const feeRefunded = await this.refundCreationFee(auction);
          await this.notifyNoCarrierSigned(auction, feeRefunded);
          cleanupCompleted = depositsReleased && feeRefunded;
        } else if (auction.awardStatus === 'SHIPPER_SIGNATURE_EXPIRED') {
          cleanupCompleted = await this.releaseDeposits(auction._id);
        } else if (auction.awardStatus === 'SIGNED') {
          const winner = auction.awardAttempts.find(
            (attempt) => attempt.status === AuctionAwardAttemptStatus.SIGNED,
          );
          cleanupCompleted = await this.releaseDeposits(auction._id, winner?.carrierId);
          if (winner) {
            await this.notifyShipperContractSigned(auction, winner);
            await this.notifyCarrierContractSigned(auction, winner);
          }
        }
        if (cleanupCompleted) {
          auction.awardCleanupCompleted = true;
          await auction.save();
        }
      } catch (error) {
        this.logger.warn(
          `Unable to complete award cleanup for ${auction._id}: ${this.errorMessage(error)}`,
        );
      }
    }
  }

  private async startAttempt(auction: AuctionDocument, index: number) {
    for (let currentIndex = index; currentIndex < auction.awardAttempts.length; currentIndex++) {
      const attempt = auction.awardAttempts[currentIndex];
      const registration = await this.registrationModel
        .findOne({ auctionId: auction._id, carrierId: attempt.carrierId })
        .exec();
      if (!this.isEligible(registration, auction.isDepositRequired)) {
        attempt.status = AuctionAwardAttemptStatus.SKIPPED;
        attempt.failureReason = 'Nhà xe không còn đăng ký hoặc không đủ điều kiện thanh toán';
        await auction.save();
        continue;
      }

      const deadlineAt = new Date(Date.now() + SIGNING_WINDOW_MS);
      attempt.status = AuctionAwardAttemptStatus.CREATING;
      attempt.signingDeadlineAt = deadlineAt;
      attempt.failureReason = null;
      auction.winningBidId = attempt.bidId;
      auction.awardStatus = 'CREATING_CONTRACT';
      auction.awardError = null;
      await auction.save();

      try {
        const award = await this.contractAwardClient.create({
          auctionId: auction._id,
          awardAttemptId: attempt.attemptId,
          winningBidId: attempt.bidId,
          shipperId: auction.shipperId,
          carrierId: attempt.carrierId,
          vehicleId: registration.vehicleId,
          pickupLocation: auction.origin,
          deliveryLocation: auction.destination,
          agreedPrice: attempt.bidAmount,
          expectedDeliveryAt: auction.deliveryLocation?.latestTime?.toISOString() ?? null,
          depositHoldId:
            registration.depositStatus === DepositStatus.LOCKED
              ? registration.depositHoldId
              : null,
          depositAmount:
            registration.depositStatus === DepositStatus.LOCKED
              ? registration.depositAmount?.toString() ?? null
              : null,
          signingDeadlineAt: deadlineAt.toISOString(),
        });
        attempt.status = AuctionAwardAttemptStatus.AWAITING_CARRIER_SIGNATURE;
        attempt.tripId = award.tripId;
        attempt.contractId = award.contractId;
        auction.awardTripId = award.tripId;
        auction.awardStatus = 'AWAITING_CARRIER_SIGNATURE';
        await auction.save();
        await this.notifyCarrierInvited(auction, attempt);
        await this.notifyShipperCarrierInvited(auction, attempt);
      } catch (error) {
        attempt.status = AuctionAwardAttemptStatus.CREATION_FAILED;
        attempt.failureReason = this.errorMessage(error).slice(0, 500);
        auction.awardStatus = 'CREATION_FAILED';
        auction.awardError = attempt.failureReason;
        await auction.save();
      }
      return;
    }

    await this.finishWithoutCarrier(auction);
  }

  private async finishExpiredAttempt(
    auction: AuctionDocument,
    attempt: AuctionAwardAttempt,
    carrierSigned: boolean,
  ) {
    if (carrierSigned) {
      attempt.status = AuctionAwardAttemptStatus.SHIPPER_EXPIRED;
      attempt.failureReason = 'Chủ hàng không ký hợp đồng đúng hạn';
      auction.awardStatus = 'SHIPPER_SIGNATURE_EXPIRED';
      auction.awardError = attempt.failureReason;
      auction.awardCleanupCompleted = false;
      await auction.save();
      const cleanupCompleted = await this.releaseDeposits(auction._id);
      await this.notifyShipperSignatureExpired(auction, attempt);
      await this.notifyCarrierAwardClosed(auction, attempt);
      if (cleanupCompleted) {
        auction.awardCleanupCompleted = true;
        await auction.save();
      }
      return;
    }

    attempt.status = AuctionAwardAttemptStatus.CARRIER_EXPIRED;
    attempt.failureReason = 'Nhà xe không ký hợp đồng đúng hạn';
    await auction.save();
    await this.releaseCarrierDeposit(auction._id, attempt.carrierId, attempt.attemptId);
    await this.notifyCarrierExpired(auction, attempt);
    await this.notifyShipperCarrierExpired(auction, attempt);
    await this.startAttempt(auction, auction.awardAttempts.indexOf(attempt) + 1);
  }

  private async finishSignedAttempt(
    auction: AuctionDocument,
    attempt: AuctionAwardAttempt,
  ) {
    attempt.status = AuctionAwardAttemptStatus.SIGNED;
    attempt.failureReason = null;
    auction.awardStatus = 'SIGNED';
    auction.awardError = null;
    auction.awardCleanupCompleted = false;
    auction.winningBidId = attempt.bidId;
    auction.awardTripId = attempt.tripId;
    await auction.save();
    const cleanupCompleted = await this.releaseDeposits(auction._id, attempt.carrierId);
    await this.notifyShipperContractSigned(auction, attempt);
    await this.notifyCarrierContractSigned(auction, attempt);
    if (cleanupCompleted) {
      auction.awardCleanupCompleted = true;
      await auction.save();
    }
  }

  private async finishWithoutCarrier(auction: AuctionDocument) {
    auction.awardStatus = 'NO_CARRIER_SIGNED';
    auction.awardError = 'Người thắng và các nhà xe dự phòng đều không ký hợp đồng đúng hạn';
    auction.awardCleanupCompleted = false;
    await auction.save();
    const depositsReleased = await this.releaseDeposits(auction._id);
    const feeRefunded = await this.refundCreationFee(auction);
    await this.notifyNoCarrierSigned(auction, feeRefunded);
    if (depositsReleased && feeRefunded) {
      auction.awardCleanupCompleted = true;
      await auction.save();
    }
  }

  private notifyNoCarrierSigned(auction: AuctionDocument, feeRefunded: boolean) {
    return this.notificationClient.notify({
      userId: auction.shipperId,
      title: feeRefunded
        ? 'Phiên đấu giá không tìm được nhà xe'
        : 'Đang xử lý hoàn phí phiên đấu giá',
      message: feeRefunded
        ? 'Người thắng và tối đa 3 nhà xe dự phòng đều không ký đúng hạn. Phí tạo phiên đã được hoàn vào ví.'
        : 'Người thắng và tối đa 3 nhà xe dự phòng đều không ký đúng hạn. Hệ thống đang xử lý hoàn phí tạo phiên; vui lòng kiểm tra lại số dư ví sau.',
      auctionId: auction._id,
      dedupeKey: feeRefunded
        ? `auction:${auction._id}:no-carrier-signed`
        : `auction:${auction._id}:creation-fee-refund-pending`,
      type: feeRefunded
        ? 'AUCTION_NO_CARRIER_SIGNED'
        : 'AUCTION_CREATION_FEE_REFUND_PENDING',
    });
  }

  private async refundCreationFee(auction: AuctionDocument): Promise<boolean> {
    if (auction.creationFeeStatus === CreationFeeStatus.REFUNDED) return true;
    const amount = auction.creationFeeAmount?.toString();
    if (!amount || Number(amount) <= 0) return true;

    auction.creationFeeStatus = CreationFeeStatus.REFUND_PENDING;
    await auction.save();
    try {
      const result = await this.walletClient.refund(auction.shipperId, {
        auctionId: auction._id,
        amount,
        purpose: 'AUCTION_CREATION_FEE_REFUND',
        idempotencyKey: `auction_creation_fee_${auction._id}:refund`,
      });
      auction.creationFeeStatus = CreationFeeStatus.REFUNDED;
      auction.creationFeeTransactionId = result.transactionId;
      await auction.save();
      return true;
    } catch (error) {
      auction.creationFeeStatus = CreationFeeStatus.REFUND_RECONCILIATION_REQUIRED;
      auction.awardError = `Không hoàn được phí tạo phiên: ${this.errorMessage(error)}`.slice(0, 500);
      await auction.save();
      this.logger.error(`Creation fee refund needs reconciliation for ${auction._id}`);
      return false;
    }
  }

  private async releaseCarrierDeposit(
    auctionId: string,
    carrierId: string,
    attemptId: string,
  ) {
    const registration = await this.registrationModel
      .findOne({ auctionId, carrierId })
      .exec();
    if (!registration) return;
    await this.releaseRegistrationDeposit(registration, `award-attempt:${attemptId}`);
  }

  private async releaseDeposits(auctionId: string, keepCarrierId?: string): Promise<boolean> {
    const registrations = await this.registrationModel
      .find({ auctionId, depositStatus: DepositStatus.LOCKED })
      .exec();
    let released = true;
    for (const registration of registrations) {
      if (keepCarrierId && registration.carrierId === keepCarrierId) continue;
      const result = await this.releaseRegistrationDeposit(
        registration,
        keepCarrierId ? 'award-loser' : 'award-unsuccessful',
      );
      if (!result) released = false;
    }
    return released;
  }

  private async releaseRegistrationDeposit(
    registration: AuctionRegistrationDocument,
    reason: string,
  ): Promise<boolean> {
    if (
      registration.depositStatus !== DepositStatus.LOCKED ||
      !registration.depositHoldId
    ) return registration.depositStatus !== DepositStatus.LOCKED;
    try {
      await this.walletClient.release(
        registration.depositHoldId,
        `${registration._id}:deposit:${reason}`,
      );
      registration.depositStatus = DepositStatus.REFUNDED;
      await registration.save();
      return true;
    } catch (error) {
      this.logger.warn(
        `Could not release deposit for registration ${registration._id}: ${this.errorMessage(error)}`,
      );
      return false;
    }
  }

  private isEligible(
    registration: AuctionRegistrationDocument | null | undefined,
    depositRequired: boolean,
  ): registration is AuctionRegistrationDocument {
    return Boolean(
      registration &&
        registration.paymentStatus === RegistrationPaymentStatus.COMPLETED &&
        (!depositRequired || registration.depositStatus === DepositStatus.LOCKED),
    );
  }

  private notifyCarrierInvited(auction: AuctionDocument, attempt: AuctionAwardAttempt) {
    const deadline = attempt.signingDeadlineAt
      ? new Intl.DateTimeFormat('vi-VN', {
          dateStyle: 'short',
          timeStyle: 'short',
          timeZone: 'Asia/Ho_Chi_Minh',
        }).format(attempt.signingDeadlineAt)
      : 'hạn quy định';
    return this.notificationClient.notify({
      userId: attempt.carrierId,
      title: 'Bạn được mời ký hợp đồng vận chuyển',
      message: `Bạn đang được xét cho phiên ${auction.title}. Vui lòng ký hợp đồng trước ${deadline}.`,
      auctionId: auction._id,
      dedupeKey: `auction:${auction._id}:attempt:${attempt.attemptId}:carrier-invited`,
      type: 'AUCTION_AWARD_INVITATION',
    });
  }

  private notifyShipperCarrierInvited(auction: AuctionDocument, attempt: AuctionAwardAttempt) {
    return this.notificationClient.notify({
      userId: auction.shipperId,
      title: 'Đang chờ nhà xe ký hợp đồng',
      message: `Nhà xe được xét cho phiên ${auction.title} có 24 giờ để ký. Hệ thống sẽ mời nhà xe tiếp theo nếu quá hạn.`,
      auctionId: auction._id,
      dedupeKey: `auction:${auction._id}:attempt:${attempt.attemptId}:shipper-invited`,
      type: 'AUCTION_AWARD_PENDING',
    });
  }

  private notifyShipperSignatureRequired(auction: AuctionDocument, attempt: AuctionAwardAttempt) {
    return this.notificationClient.notify({
      userId: auction.shipperId,
      title: 'Nhà xe đã ký hợp đồng',
      message: `Nhà xe đã ký hợp đồng phiên ${auction.title}. Vui lòng ký trong 24 giờ tiếp theo.`,
      auctionId: auction._id,
      dedupeKey: `auction:${auction._id}:attempt:${attempt.attemptId}:shipper-sign`,
      type: 'AUCTION_SHIPPER_SIGNATURE_REQUIRED',
    });
  }

  private notifyCarrierExpired(auction: AuctionDocument, attempt: AuctionAwardAttempt) {
    return this.notificationClient.notify({
      userId: attempt.carrierId,
      title: 'Lượt nhận chuyến đã hết hạn',
      message: `Bạn chưa ký hợp đồng phiên ${auction.title} trong thời hạn 24 giờ. Hệ thống đang xét nhà xe dự phòng tiếp theo nếu còn.`,
      auctionId: auction._id,
      dedupeKey: `auction:${auction._id}:attempt:${attempt.attemptId}:carrier-expired`,
      type: 'AUCTION_AWARD_EXPIRED',
    });
  }

  private notifyShipperCarrierExpired(auction: AuctionDocument, attempt: AuctionAwardAttempt) {
    return this.notificationClient.notify({
      userId: auction.shipperId,
      title: 'Nhà xe được xét chưa ký đúng hạn',
      message: `Nhà xe vừa được xét không ký đúng hạn. Hệ thống đang xử lý nhà xe dự phòng tiếp theo nếu còn; nếu không còn nhà xe nào ký, phí tạo phiên sẽ được hoàn.`,
      auctionId: auction._id,
      dedupeKey: `auction:${auction._id}:attempt:${attempt.attemptId}:shipper-expired`,
      type: 'AUCTION_BACKUP_CARRIER_INVITED',
    });
  }

  private notifyShipperSignatureExpired(auction: AuctionDocument, attempt: AuctionAwardAttempt) {
    return this.notificationClient.notify({
      userId: auction.shipperId,
      title: 'Hợp đồng đã hết hạn ký',
      message: `Bạn chưa ký hợp đồng phiên ${auction.title} trong thời hạn 24 giờ. Hệ thống đã dừng việc mời nhà xe dự phòng.`,
      auctionId: auction._id,
      dedupeKey: `auction:${auction._id}:attempt:${attempt.attemptId}:shipper-expired`,
      type: 'AUCTION_SHIPPER_SIGNATURE_EXPIRED',
    });
  }

  private notifyCarrierAwardClosed(auction: AuctionDocument, attempt: AuctionAwardAttempt) {
    return this.notificationClient.notify({
      userId: attempt.carrierId,
      title: 'Phiên đấu giá đã dừng xét nhà xe',
      message: `Chủ hàng chưa ký hợp đồng phiên ${auction.title} đúng hạn. Bạn không bị xem là bên vi phạm thời hạn ký.`,
      auctionId: auction._id,
      dedupeKey: `auction:${auction._id}:attempt:${attempt.attemptId}:carrier-closed`,
      type: 'AUCTION_AWARD_CLOSED',
    });
  }

  private notifyShipperContractSigned(auction: AuctionDocument, attempt: AuctionAwardAttempt) {
    return this.notificationClient.notify({
      userId: auction.shipperId,
      title: 'Hợp đồng đã được ký đầy đủ',
      message: `Nhà xe và chủ hàng đã ký hợp đồng cho phiên ${auction.title}.`,
      auctionId: auction._id,
      dedupeKey: `auction:${auction._id}:attempt:${attempt.attemptId}:signed-shipper`,
      type: 'AUCTION_CONTRACT_SIGNED',
    });
  }

  private notifyCarrierContractSigned(auction: AuctionDocument, attempt: AuctionAwardAttempt) {
    return this.notificationClient.notify({
      userId: attempt.carrierId,
      title: 'Hợp đồng đã được ký đầy đủ',
      message: `Hợp đồng vận chuyển cho phiên ${auction.title} đã có đủ chữ ký.`,
      auctionId: auction._id,
      dedupeKey: `auction:${auction._id}:attempt:${attempt.attemptId}:signed-carrier`,
      type: 'AUCTION_CONTRACT_SIGNED',
    });
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : 'Lỗi không xác định';
  }
}
