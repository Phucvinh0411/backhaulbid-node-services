import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuctionService } from '../auction/auction.service';
import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { DepositStatus } from '../../common/enums/deposit-status.enum';
import { ParticipationFeeStatus } from '../../common/enums/participation-fee-status.enum';
import { RegistrationPaymentStatus } from '../../common/enums/registration-payment-status.enum';
import { RegistrationStatus } from '../../common/enums/registration-status.enum';
import {
  WalletClient,
  WalletClientError,
} from '../../integrations/wallet/wallet.client';
import { RegisterAuctionDto } from './dto/register-auction.dto';
import { RetryPaymentDto } from './dto/retry-payment.dto';
import { ListMyRegistrationsQueryDto } from './dto/list-my-registrations-query.dto';
import {
  CarrierReputationClient,
  MINIMUM_AUCTION_REPUTATION_SCORE,
} from '../../integrations/fleet/carrier-reputation.client';
import { CarrierVehicleClient } from '../../integrations/fleet/carrier-vehicle.client';
import {
  AccountVerificationClient,
  AccountVerificationStatus,
} from '../../integrations/identity/account-verification.client';
import { CarrierCoverageClient } from '../../integrations/identity/carrier-coverage.client';
import {
  AuctionRegistration,
  AuctionRegistrationDocument,
} from './schemas/auction-registration.schema';
import { toAuctionRegistrationResponse } from './auction-registration.mapper';

type AuctionView = Awaited<ReturnType<AuctionService['findById']>>;

@Injectable()
export class AuctionRegistrationService {
  constructor(
    @InjectModel(AuctionRegistration.name)
    private readonly registrationModel: Model<AuctionRegistrationDocument>,
    private readonly auctionService: AuctionService,
    private readonly walletClient: WalletClient,
    private readonly reputationClient: CarrierReputationClient,
    private readonly vehicleClient: CarrierVehicleClient,
    private readonly verificationClient: AccountVerificationClient,
    private readonly coverageClient: CarrierCoverageClient,
  ) {}

  async register(
    auctionId: string,
    carrierId: string,
    dto: RegisterAuctionDto,
  ) {
    await this.verificationClient.assertVerified(carrierId);
    const auction = await this.auctionService.findById(auctionId);
    this.assertRegistrationOpen(auction);
    if (auction.requireCarrierCoverage === true) {
      await this.coverageClient.assertEligible(carrierId);
    }
    const reputationScore = await this.reputationClient.getScore(carrierId);
    if (reputationScore < MINIMUM_AUCTION_REPUTATION_SCORE) {
      throw new ForbiddenException({
        code: 'REPUTATION_TOO_LOW',
        message: `Cần tối thiểu ${MINIMUM_AUCTION_REPUTATION_SCORE} điểm uy tín để tham gia đấu giá`,
        reputationScore,
        minimumReputationScore: MINIMUM_AUCTION_REPUTATION_SCORE,
      });
    }

    const existing = await this.registrationModel
      .findOne({ auctionId, carrierId })
      .exec();
    if (existing) {
      if (existing.status === RegistrationStatus.CANCELLED) {
        throw new ConflictException(
          'Carrier registration was cancelled and cannot be reused',
        );
      }
      if (existing.paymentStatus === RegistrationPaymentStatus.COMPENSATING) {
        throw new ConflictException(
          'Registration deposit compensation is still in progress. Please retry in a moment.',
        );
      }
      if (existing.paymentStatus === RegistrationPaymentStatus.COMPLETED) {
        return toAuctionRegistrationResponse(existing, auction);
      }
      await this.vehicleClient.assertVerifiedVehicle(carrierId, dto.vehicleId);
      if (existing.vehicleId !== dto.vehicleId) {
        existing.vehicleId = dto.vehicleId;
      }
      await this.prepareRegistrationForRetry(existing, auction);
      return this.completePayment(existing, auction);
    }

    await this.vehicleClient.assertVerifiedVehicle(carrierId, dto.vehicleId);

    const registration = await this.registrationModel.create({
      auctionId,
      carrierId,
      vehicleId: dto.vehicleId,
      status: RegistrationStatus.REGISTERED,
      paymentStatus: RegistrationPaymentStatus.PENDING,
      depositStatus: auction.isDepositRequired
        ? DepositStatus.PENDING
        : DepositStatus.NOT_REQUIRED,
      participationFeeStatus: ParticipationFeeStatus.PENDING,
      participationFeeAmount: Types.Decimal128.fromString(
        auction.participationFeeAmount,
      ),
      depositAmount: auction.isDepositRequired
        ? Types.Decimal128.fromString(this.requireDepositAmount(auction))
        : null,
      idempotencyKey: dto.idempotencyKey,
    });

    return this.completePayment(registration, auction);
  }

  async retryPayment(
    auctionId: string,
    registrationId: string,
    carrierId: string,
    dto: RetryPaymentDto,
  ) {
    void dto;
    await this.verificationClient.assertVerified(carrierId);
    const auction = await this.auctionService.findById(auctionId);
    const registration = await this.registrationModel
      .findOne({ _id: registrationId, auctionId, carrierId })
      .exec();
    if (!registration) throw new NotFoundException('Registration not found');
    if (registration.status === RegistrationStatus.CANCELLED) {
      throw new ConflictException('Registration is cancelled');
    }
    if (registration.paymentStatus === RegistrationPaymentStatus.COMPENSATING) {
      throw new ConflictException(
        'Registration deposit compensation is still in progress. Please retry in a moment.',
      );
    }
    if (registration.paymentStatus === RegistrationPaymentStatus.COMPLETED) {
      return toAuctionRegistrationResponse(registration, auction);
    }
    if (new Date() >= auction.startTime) {
      throw new ConflictException(
        'Payment retry is closed after the auction starts',
      );
    }
    if (auction.requireCarrierCoverage === true) {
      await this.coverageClient.assertEligible(carrierId);
    }
    await this.vehicleClient.assertVerifiedVehicle(
      carrierId,
      registration.vehicleId,
    );
    await this.prepareRegistrationForRetry(registration, auction);
    return this.completePayment(registration, auction);
  }

  async getAccess(auctionId: string, carrierId: string) {
    const [auction, verification, reputationScore] = await Promise.all([
      this.auctionService.findById(auctionId),
      this.verificationClient.getStatus(carrierId),
      this.reputationClient.getScore(carrierId),
    ]);
    const isAccountVerified =
      verification.ekycVerified &&
      verification.businessVerified &&
      verification.fullyVerified;
    const coverageEligible =
      isAccountVerified && auction.requireCarrierCoverage === true
        ? await this.coverageClient.isEligible(carrierId)
        : true;
    const canQueryRegistration =
      isAccountVerified &&
      coverageEligible &&
      reputationScore >= MINIMUM_AUCTION_REPUTATION_SCORE;
    const registration = canQueryRegistration
      ? await this.registrationModel.findOne({ auctionId, carrierId }).exec()
      : null;

    return this.computeAccessForAuction(
      auction,
      registration,
      verification,
      reputationScore,
      coverageEligible,
    );
  }

  async getBatchAccess(auctionIds: string[], carrierId: string) {
    const uniqueIds = Array.from(
      new Set(auctionIds.map((id) => id.trim()).filter((id) => id.length > 0)),
    ).slice(0, 200);
    if (uniqueIds.length === 0) return {};

    const [auctions, verification, reputationScore] = await Promise.all([
      this.auctionService.findByIds(uniqueIds),
      this.verificationClient.getStatus(carrierId),
      this.reputationClient.getScore(carrierId),
    ]);
    if (auctions.length === 0) return {};

    const validIds = auctions.map((auction) => String(auction.id));
    const isAccountVerified =
      verification.ekycVerified &&
      verification.businessVerified &&
      verification.fullyVerified;
    const needsCoverage =
      isAccountVerified &&
      auctions.some((auction) => auction.requireCarrierCoverage === true);

    const [coverageEligible, registrations] = await Promise.all([
      needsCoverage
        ? this.coverageClient.isEligible(carrierId)
        : Promise.resolve(true),
      this.registrationModel
        .find({ auctionId: { $in: validIds }, carrierId })
        .exec(),
    ]);

    const registrationByAuctionId = new Map<
      string,
      AuctionRegistrationDocument
    >();
    for (const reg of registrations) {
      registrationByAuctionId.set(reg.auctionId, reg);
    }

    const result: Record<
      string,
      ReturnType<AuctionRegistrationService['computeAccessForAuction']>
    > = {};
    for (const auction of auctions) {
      const id = String(auction.id);
      result[id] = this.computeAccessForAuction(
        auction,
        registrationByAuctionId.get(id) ?? null,
        verification,
        reputationScore,
        coverageEligible,
      );
    }
    return result;
  }

  private computeAccessForAuction(
    auction: AuctionView,
    registration: AuctionRegistrationDocument | null,
    verification: AccountVerificationStatus,
    reputationScore: number,
    coverageEligible: boolean,
  ) {
    const reputation = {
      ekycVerified: verification.ekycVerified,
      businessVerified: verification.businessVerified,
      reputationScore,
      minimumReputationScore: MINIMUM_AUCTION_REPUTATION_SCORE,
    };
    if (!verification.ekycVerified) {
      return {
        canRegister: false,
        canEnter: false,
        accessStatus: 'EKYC_REQUIRED',
        ...reputation,
      };
    }
    if (!verification.businessVerified || !verification.fullyVerified) {
      return {
        canRegister: false,
        canEnter: false,
        accessStatus: 'ACCOUNT_VERIFICATION_REQUIRED',
        ...reputation,
      };
    }
    if (auction.requireCarrierCoverage === true && !coverageEligible) {
      return {
        canRegister: false,
        canEnter: false,
        accessStatus: 'CARRIER_COVERAGE_REQUIRED',
        ...reputation,
      };
    }
    if (reputationScore < MINIMUM_AUCTION_REPUTATION_SCORE) {
      return {
        canRegister: false,
        canEnter: false,
        accessStatus: 'REPUTATION_TOO_LOW',
        ...reputation,
      };
    }
    if (!registration) {
      return {
        ...reputation,
        canRegister: auction.registrationOpen,
        canEnter: false,
        accessStatus: auction.registrationOpen
          ? 'REGISTRATION_REQUIRED'
          : 'REGISTRATION_CLOSED',
        startTime: auction.startTime,
        registrationEndTime: auction.registrationEndTime,
      };
    }

    if (registration.status === RegistrationStatus.CANCELLED) {
      return {
        ...reputation,
        canRegister: false,
        canEnter: false,
        accessStatus: 'REGISTRATION_CANCELLED',
        registrationId: registration._id,
      };
    }

    if (registration.paymentStatus !== RegistrationPaymentStatus.COMPLETED) {
      return {
        ...reputation,
        canRegister: false,
        canEnter: false,
        accessStatus: 'PAYMENT_INCOMPLETE',
        paymentStatus: registration.paymentStatus,
        registrationId: registration._id,
        startTime: auction.startTime,
      };
    }

    const now = new Date();
    if (auction.status === AuctionStatus.CANCELLED) {
      return {
        ...reputation,
        canRegister: false,
        canEnter: false,
        accessStatus: 'AUCTION_CANCELLED',
      };
    }
    if (auction.status === AuctionStatus.COMPLETED || now >= auction.endTime) {
      return {
        ...reputation,
        canRegister: false,
        canEnter: false,
        accessStatus: 'AUCTION_COMPLETED',
      };
    }
    if (now < auction.startTime) {
      return {
        ...reputation,
        canRegister: false,
        canEnter: false,
        accessStatus: 'WAITING_FOR_START',
        registrationId: registration._id,
        startTime: auction.startTime,
      };
    }

    return {
      ...reputation,
      canRegister: false,
      canEnter: true,
      accessStatus: 'AUCTION_OPEN',
      registrationId: registration._id,
      startTime: auction.startTime,
      endTime: auction.endTime,
    };
  }

  async listMine(carrierId: string, query: ListMyRegistrationsQueryDto) {
    const skip = (query.page - 1) * query.pageSize;
    const [registrations, totalItems] = await Promise.all([
      this.registrationModel
        .find({ carrierId })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(query.pageSize)
        .exec(),
      this.registrationModel.countDocuments({ carrierId }).exec(),
    ]);

    const data = await Promise.all(
      registrations.map(async (registration) => {
        const auction = await this.auctionService.findById(
          registration.auctionId,
        );
        const access = await this.getAccess(registration.auctionId, carrierId);
        return {
          registration: toAuctionRegistrationResponse(registration, auction),
          auction,
          access,
        };
      }),
    );

    return {
      data,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
      },
    };
  }

  async cancel(auctionId: string, registrationId: string, carrierId: string) {
    const auction = await this.auctionService.findById(auctionId);
    const registration = await this.registrationModel
      .findOne({ _id: registrationId, auctionId, carrierId })
      .exec();
    if (!registration) throw new NotFoundException('Registration not found');
    if (registration.status === RegistrationStatus.CANCELLED) {
      return toAuctionRegistrationResponse(registration, auction);
    }

    if (
      registration.depositStatus === DepositStatus.LOCKED &&
      registration.depositHoldId
    ) {
      await this.walletClient.release(
        registration.depositHoldId,
        `${registration._id}:deposit:release`,
      );
      registration.depositStatus = DepositStatus.REFUNDED;
    }
    registration.status = RegistrationStatus.CANCELLED;
    await registration.save();
    return toAuctionRegistrationResponse(registration, auction);
  }

  async releaseLoserDeposits(auctionId: string, winningCarrierId?: string) {
    const filter: Record<string, any> = {
      auctionId,
      depositStatus: DepositStatus.LOCKED,
    };
    if (winningCarrierId) {
      filter.carrierId = { $ne: winningCarrierId };
    }

    const registrations = await this.registrationModel.find(filter).exec();
    let releasedCount = 0;

    for (const reg of registrations) {
      if (reg.depositHoldId) {
        try {
          await this.walletClient.release(
            reg.depositHoldId,
            `${reg._id}:deposit:refund:loser`,
          );
          reg.depositStatus = DepositStatus.REFUNDED;
          await reg.save();
          releasedCount++;
        } catch {
          // Bỏ qua lỗi hold riêng lẻ để tiếp tục hoàn cho các bên khác
        }
      }
    }

    return {
      auctionId,
      releasedCount,
      totalEligible: registrations.length,
    };
  }

  private async prepareRegistrationForRetry(
    registration: AuctionRegistrationDocument,
    auction: AuctionView,
  ): Promise<void> {
    if (registration.paymentStatus === RegistrationPaymentStatus.FAILED) {
      registration.paymentAttempt = (registration.paymentAttempt ?? 0) + 1;
      registration.paymentStatus = RegistrationPaymentStatus.PENDING;
      registration.paymentErrorCode = null;
      if (
        auction.isDepositRequired &&
        registration.depositStatus !== DepositStatus.LOCKED
      ) {
        registration.depositStatus = DepositStatus.PENDING;
        registration.depositHoldId = null;
      }
      if (registration.participationFeeStatus !== ParticipationFeeStatus.PAID) {
        registration.participationFeeStatus = ParticipationFeeStatus.PENDING;
        registration.participationFeeTransactionId = null;
      }
      await registration.save();
    } else if (registration.isModified?.('vehicleId')) {
      await registration.save();
    }
  }

  private async completePayment(
    registration: AuctionRegistrationDocument,
    auction: AuctionView,
  ) {
    const attempt = registration.paymentAttempt ?? 0;
    const keySuffix = attempt > 0 ? `:${attempt}` : '';
    const depositHoldKey = `${registration._id}:deposit:hold${keySuffix}`;
    const depositReleaseKey = `${registration._id}:deposit:release${keySuffix}`;
    const feeChargeKey = `${registration._id}:fee:charge${keySuffix}`;

    try {
      const depositAmount = auction.depositAmount;
      if (
        auction.isDepositRequired &&
        depositAmount &&
        registration.depositStatus === DepositStatus.PENDING
      ) {
        const hold = await this.walletClient.hold(registration.carrierId, {
          auctionId: registration.auctionId,
          registrationId: registration._id,
          amount: depositAmount,
          purpose: 'AUCTION_DEPOSIT',
          idempotencyKey: depositHoldKey,
        });
        registration.depositStatus = DepositStatus.LOCKED;
        registration.depositHoldId = hold.holdId ?? hold.transactionId;
        await registration.save();
      }

      if (
        registration.participationFeeStatus === ParticipationFeeStatus.PENDING
      ) {
        const charge = await this.walletClient.charge(registration.carrierId, {
          auctionId: registration.auctionId,
          registrationId: registration._id,
          amount: auction.participationFeeAmount,
          purpose: 'AUCTION_PARTICIPATION_FEE',
          idempotencyKey: feeChargeKey,
        });
        registration.participationFeeStatus = ParticipationFeeStatus.PAID;
        registration.participationFeeTransactionId = charge.transactionId;
        await registration.save();
      }

      registration.paymentStatus = RegistrationPaymentStatus.COMPLETED;
      registration.paymentErrorCode = null;
      await registration.save();
      return toAuctionRegistrationResponse(registration, auction);
    } catch (error) {
      let compensationPending = false;
      if (
        registration.depositStatus === DepositStatus.LOCKED &&
        registration.depositHoldId
      ) {
        registration.paymentStatus = RegistrationPaymentStatus.COMPENSATING;
        await registration.save();
        try {
          await this.walletClient.release(
            registration.depositHoldId,
            depositReleaseKey,
          );
          registration.depositStatus = DepositStatus.REFUNDED;
        } catch {
          compensationPending = true;
          registration.paymentErrorCode = 'DEPOSIT_COMPENSATION_PENDING';
        }
      }
      await this.markFailed(registration, error, compensationPending);
      throw this.mapWalletError(error);
    }
  }

  private async markFailed(
    registration: AuctionRegistrationDocument,
    error: unknown,
    preserveCompensationCode = false,
  ) {
    registration.paymentStatus = RegistrationPaymentStatus.FAILED;
    registration.participationFeeStatus =
      registration.participationFeeStatus === ParticipationFeeStatus.PAID
        ? ParticipationFeeStatus.COMPENSATED
        : ParticipationFeeStatus.FAILED;
    if (!preserveCompensationCode) {
      registration.paymentErrorCode =
        error instanceof WalletClientError
          ? `WALLET_${error.statusCode ?? 'ERROR'}`
          : 'PAYMENT_FAILED';
    }
    await registration.save();
  }

  private mapWalletError(error: unknown): Error {
    if (error instanceof WalletClientError && error.statusCode === 422) {
      return new UnprocessableEntityException(error.message);
    }
    if (error instanceof WalletClientError) {
      return new ServiceUnavailableException(error.message);
    }
    return error instanceof Error
      ? error
      : new ServiceUnavailableException('Payment failed');
  }

  private assertRegistrationOpen(auction: AuctionView) {
    const now = new Date();
    if (!auction.registrationOpen || now >= auction.registrationEndTime) {
      throw new ConflictException('Registration for this auction is closed');
    }
    if (
      auction.status === AuctionStatus.CANCELLED ||
      auction.status === AuctionStatus.COMPLETED
    ) {
      throw new ConflictException('Auction is not accepting registrations');
    }
  }

  private requireDepositAmount(auction: AuctionView): string {
    if (!auction.depositAmount) {
      throw new ConflictException('Auction deposit configuration is invalid');
    }
    return auction.depositAmount;
  }
}
