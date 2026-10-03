import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuctionDocument } from './schemas/auction.schema';
import { AuctionRepository } from './auction.repository';
import { CreateAuctionDto } from './dto/create-auction.dto';
import { ListAuctionsQueryDto } from './dto/list-auctions-query.dto';
import { UpdateAuctionDto } from './dto/update-auction.dto';
import { FlagAuctionDto } from './dto/flag-auction.dto';
import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { AuctionType } from '../../common/enums/auction-type.enum';
import { CreationFeeStatus } from '../../common/enums/creation-fee-status.enum';
import { calculateParticipationFee, calculateCreationFee } from './fee-policy';
import { WalletClient } from '../../integrations/wallet/wallet.client';
import { Bid, BidDocument } from '../bid/schemas/bid.schema';
import { GlobalEventBus } from '../../common/events';
import {
  AuctionStatusPayload,
  BiddingEventsService,
} from '../bidding/bidding-events.service';
import { AuctionAwardService } from './auction-award.service';

@Injectable()
export class AuctionService {
  constructor(
    private readonly auctionRepo: AuctionRepository,
    @InjectModel(Bid.name)
    private readonly bidModel: Model<BidDocument>,
    private readonly walletClient: WalletClient,
    private readonly eventsService: BiddingEventsService,
    private readonly awardService: AuctionAwardService,
  ) {}

  async create(
    shipperId: string,
    dto: CreateAuctionDto,
    idempotencyKey?: string,
  ) {
    const creationIdempotencyKey = idempotencyKey?.trim() || undefined;
    if (creationIdempotencyKey) {
      const existing = await this.auctionRepo.findByIdempotencyKey(
        shipperId,
        creationIdempotencyKey,
      );
      if (existing) return this.returnExistingCreation(existing);
    }

    const registrationStartTime = dto.registrationStartTime ?? new Date();
    this.validateSchedule(
      registrationStartTime,
      dto.registrationEndTime,
      dto.startTime,
      dto.endTime,
    );
    const maxPrice = this.parseAmount(dto.maxPrice, 'maxPrice');
    const priceStep = this.parseAmount(dto.priceStep, 'priceStep');
    const fee = calculateParticipationFee(maxPrice);
    const creationFee = calculateCreationFee(maxPrice);
    const depositAmount = dto.isDepositRequired
      ? this.parseAmount(dto.depositAmount, 'depositAmount')
      : null;

    if (depositAmount !== null && depositAmount > maxPrice) {
      throw new BadRequestException('depositAmount cannot exceed maxPrice');
    }

    const origin = `${dto.pickupLocation.province} - ${dto.pickupLocation.locationName}`;
    const destination = `${dto.deliveryLocation.province} - ${dto.deliveryLocation.locationName}`;

    const auctionId = randomUUID();

    const creationFeeHold = await this.walletClient.hold(shipperId, {
      auctionId,
      amount: creationFee.amount,
      purpose: 'AUCTION_CREATION_FEE',
      idempotencyKey: `auction_creation_fee_${auctionId}`,
    });
    if (!creationFeeHold.holdId) {
      throw new ServiceUnavailableException(
        'Wallet service did not return a valid creation fee hold',
      );
    }

    let auction: AuctionDocument;
    try {
      auction = await this.auctionRepo.create({
        _id: auctionId,
        shipperId,
        ...dto,
        origin,
        destination,
        registrationStartTime,
        maxPrice: Types.Decimal128.fromString(maxPrice.toFixed(2)),
        priceStep: Types.Decimal128.fromString(priceStep.toFixed(2)),
        goodsValue: dto.goodsValue
          ? Types.Decimal128.fromString(Number(dto.goodsValue).toFixed(2))
          : undefined,
        depositAmount:
          depositAmount === null
            ? null
            : Types.Decimal128.fromString(depositAmount.toFixed(2)),
        participationFeeAmount: Types.Decimal128.fromString(fee.amount),
        creationFeeTier: creationFee.tier,
        creationFeeAmount: Types.Decimal128.fromString(creationFee.amount),
        creationIdempotencyKey: creationIdempotencyKey ?? null,
        creationFeeStatus: CreationFeeStatus.HELD,
        creationFeeHoldId: creationFeeHold.holdId,
        creationFeeTransactionId: null,
        status: AuctionStatus.PENDING,
      });
    } catch (error) {
      if (creationIdempotencyKey && this.isDuplicateKeyError(error)) {
        await this.walletClient.release(
          creationFeeHold.holdId,
          `auction_creation_fee_${auctionId}:duplicate-release`,
        );
        const existing = await this.auctionRepo.findByIdempotencyKey(
          shipperId,
          creationIdempotencyKey,
        );
        if (existing) return this.returnExistingCreation(existing);
      }
      await this.walletClient.release(
        creationFeeHold.holdId,
        `auction_creation_fee_${auctionId}:release`,
      );
      throw error;
    }

    await this.settleCreationFee(auction);

    const serializedAuction = this.serialize(auction);

    // Phát sự kiện để báo cho BiddingGateway thực hiện so khớp (matching) xe rỗng
    GlobalEventBus.emit('auction_created', serializedAuction);

    return serializedAuction;
  }

  private async returnExistingCreation(auction: AuctionDocument) {
    if (auction.creationFeeStatus !== CreationFeeStatus.SETTLED) {
      await this.settleCreationFee(auction);
      const serializedAuction = this.serialize(auction);
      GlobalEventBus.emit('auction_created', serializedAuction);
      return serializedAuction;
    }
    return this.serialize(auction);
  }

  private async settleCreationFee(auction: AuctionDocument) {
    if (auction.creationFeeStatus === CreationFeeStatus.SETTLED) return;
    if (!auction.creationFeeHoldId) {
      throw new Error('Auction creation fee hold is missing');
    }

    try {
      const settled = await this.walletClient.forfeit(
        auction.creationFeeHoldId,
        `auction_creation_fee_${auction._id}:forfeit`,
      );
      auction.creationFeeStatus = CreationFeeStatus.SETTLED;
      auction.creationFeeTransactionId = settled.transactionId;
      await auction.save();
    } catch (error) {
      auction.creationFeeStatus = CreationFeeStatus.RECONCILIATION_REQUIRED;
      try {
        await auction.save();
      } catch {
        // Keep the original wallet/database error; the persisted hold remains retryable.
      }
      throw error;
    }
  }

  private isDuplicateKeyError(error: unknown): boolean {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 11000
    );
  }

  async list(query: ListAuctionsQueryDto) {
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.shipperId) filter.shipperId = query.shipperId;

    const skip = (query.page - 1) * query.pageSize;
    const [items, totalItems] = await Promise.all([
      this.auctionRepo.find(filter, skip, query.pageSize),
      this.auctionRepo.count(filter),
    ]);

    return {
      data: items.map((item) => this.serialize(item)),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
      },
    };
  }

  async findById(auctionId: string) {
    const auction = await this.getAndSynchronizeStatus(auctionId);
    return this.serialize(auction);
  }

  async update(
    auctionId: string,
    actorId: string,
    role: string,
    dto: UpdateAuctionDto,
  ) {
    const auction = await this.getAndSynchronizeStatus(auctionId);
    this.assertOwnerOrAdmin(auction, actorId, role);
    if (auction.status !== AuctionStatus.PENDING) {
      throw new ConflictException('Only pending auctions can be updated');
    }

    const nextRegistrationStart = auction.registrationStartTime ?? new Date();
    const nextRegistrationEnd =
      dto.registrationEndTime ?? auction.registrationEndTime;
    const nextStart = dto.startTime ?? auction.startTime;
    const nextEnd = dto.endTime ?? auction.endTime;
    this.validateSchedule(
      nextRegistrationStart,
      nextRegistrationEnd,
      nextStart,
      nextEnd,
    );

    const update: Record<string, unknown> = { ...dto };

    if (dto.pickupLocation) {
      update.origin = `${dto.pickupLocation.province} - ${dto.pickupLocation.locationName}`;
    }
    if (dto.deliveryLocation) {
      update.destination = `${dto.deliveryLocation.province} - ${dto.deliveryLocation.locationName}`;
    }

    if (dto.priceStep !== undefined) {
      update.priceStep = this.parseAmount(dto.priceStep, 'priceStep').toFixed(
        2,
      );
    }
    if (dto.goodsValue !== undefined) {
      update.goodsValue = Number(dto.goodsValue).toFixed(2);
    }

    if (dto.maxPrice !== undefined) {
      const maxPrice = this.parseAmount(dto.maxPrice, 'maxPrice');
      const fee = calculateParticipationFee(maxPrice);
      update.maxPrice = maxPrice.toFixed(2);
      update.participationFeeTier = fee.tier;
      update.participationFeeAmount = fee.amount;

      const creationFee = calculateCreationFee(maxPrice);
      update.creationFeeTier = creationFee.tier;
      update.creationFeeAmount = creationFee.amount;

      if (dto.isDepositRequired === undefined && auction.isDepositRequired) {
        update.depositAmount = auction.depositAmount?.toString() ?? null;
      }
    }

    if (dto.isDepositRequired === false) update.depositAmount = null;
    if (dto.isDepositRequired === true && dto.depositAmount === undefined) {
      throw new BadRequestException(
        'depositAmount is required when deposit is enabled',
      );
    }
    if (dto.depositAmount !== undefined) {
      const depositAmount = this.parseAmount(
        dto.depositAmount,
        'depositAmount',
      );
      const maxPrice = Number(update.maxPrice ?? auction.maxPrice.toString());
      if (depositAmount > maxPrice) {
        throw new BadRequestException('depositAmount cannot exceed maxPrice');
      }
      update.depositAmount = depositAmount.toFixed(2);
    }
    if (
      dto.maxPrice !== undefined &&
      dto.depositAmount === undefined &&
      dto.isDepositRequired !== false &&
      update.depositAmount !== null
    ) {
      const maxPrice = Number(update.maxPrice ?? auction.maxPrice.toString());
      const currentDeposit = Number(
        update.depositAmount ?? auction.depositAmount?.toString() ?? 0,
      );
      if (currentDeposit > maxPrice) {
        throw new BadRequestException('depositAmount cannot exceed maxPrice');
      }
    }

    const updated = await this.auctionRepo.updateById(auctionId, update);
    if (!updated) throw new NotFoundException('Auction not found');
    return this.serialize(updated);
  }

  async open(auctionId: string, actorId: string, role: string) {
    const auction = await this.getAndSynchronizeStatus(auctionId);
    this.assertOwnerOrAdmin(auction, actorId, role);
    const now = new Date();
    if (auction.status !== AuctionStatus.PENDING) {
      throw new ConflictException('Only pending auctions can be opened');
    }
    if (now < auction.startTime) {
      throw new ConflictException('Auction has not reached its start time');
    }
    if (now >= auction.endTime) {
      throw new ConflictException('Auction has already ended');
    }

    auction.status = AuctionStatus.OPEN;
    await auction.save();
    this.emitStatus(auction);
    return this.serialize(auction);
  }

  async cancel(
    auctionId: string,
    actorId: string,
    role: string,
    reason?: string,
  ) {
    const auction = await this.getAndSynchronizeStatus(auctionId);
    this.assertOwnerOrAdmin(auction, actorId, role);
    if (![AuctionStatus.PENDING, AuctionStatus.OPEN].includes(auction.status)) {
      throw new ConflictException(
        'Only pending or open auctions can be cancelled',
      );
    }
    auction.status = AuctionStatus.CANCELLED;
    auction.cancellationReason = reason?.trim() || null;
    await auction.save();
    this.emitStatus(auction);
    return this.serialize(auction);
  }

  async complete(auctionId: string, actorId: string, role: string) {
    const auction = await this.getAndSynchronizeStatus(auctionId);
    this.assertOwnerOrAdmin(auction, actorId, role);
    if (auction.status !== AuctionStatus.OPEN) {
      if (auction.status === AuctionStatus.COMPLETED) {
        await this.ensureAward(auction);
        return this.serialize(auction);
      }
      throw new ConflictException('Only open auctions can be completed');
    }
    if (new Date() < auction.endTime) {
      throw new ConflictException('Auction has not reached its end time');
    }
    auction.status = AuctionStatus.COMPLETED;
    const winningBid =
      auction.auctionType === AuctionType.PUBLIC
        ? await this.bidModel
            .findOne({ auctionId: auction._id })
            .sort({ bidAmount: 1, bidTime: 1 })
            .exec()
        : null;
    auction.winningBidId = winningBid?._id ?? null;
    await auction.save();
    await this.awardService.createForWinner(auction, winningBid);
    this.emitStatus(auction, winningBid?.bidAmount?.toString() ?? null);
    return this.serialize(auction);
  }

  async selectWinner(
    auctionId: string,
    bidId: string,
    actorId: string,
    role: string,
  ) {
    const auction = await this.getAndSynchronizeStatus(auctionId);
    this.assertOwnerOrAdmin(auction, actorId, role);
    if (auction.auctionType !== AuctionType.SEALED) {
      throw new ConflictException(
        'Only sealed auctions require winner selection',
      );
    }
    if (auction.status !== AuctionStatus.COMPLETED) {
      throw new ConflictException(
        'Auction must be completed before selecting a winner',
      );
    }

    const winningBid = await this.bidModel
      .findOne({ _id: bidId, auctionId: auction._id })
      .exec();
    if (!winningBid) throw new NotFoundException('Winning bid not found');

    auction.winningBidId = winningBid._id;
    await auction.save();
    await this.awardService.createForWinner(auction, winningBid);
    this.emitStatus(auction, winningBid.bidAmount.toString());
    return this.serialize(auction);
  }

  async retryAward(auctionId: string, actorId: string, role: string) {
    const auction = await this.auctionRepo.findById(auctionId);
    if (!auction) throw new NotFoundException('Auction not found');
    this.assertOwnerOrAdmin(auction, actorId, role);
    if (auction.status !== AuctionStatus.COMPLETED || !auction.winningBidId) {
      throw new ConflictException('A completed auction with a selected winner is required');
    }
    const winningBid = await this.bidModel
      .findOne({ _id: auction.winningBidId, auctionId: auction._id })
      .exec();
    if (!winningBid) throw new NotFoundException('Winning bid not found');
    await this.awardService.createForWinner(auction, winningBid);
    return this.serialize(auction);
  }

  async flag(auctionId: string, dto: FlagAuctionDto) {
    const auction = await this.auctionRepo.findById(auctionId);
    if (!auction) throw new NotFoundException('Auction not found');
    auction.fraudFlag = true;
    auction.fraudReason = dto.reason.trim();
    await auction.save();
    return this.serialize(auction);
  }

  private emitStatus(
    auction: AuctionDocument,
    winningBidAmount: string | null = null,
  ): void {
    const now = new Date();
    const payload: AuctionStatusPayload = {
      auctionId: auction._id,
      status: auction.status,
      roomOpen:
        auction.status === AuctionStatus.OPEN &&
        now >= auction.startTime &&
        now < auction.endTime,
      endTime: auction.endTime,
    };
    if (winningBidAmount) {
      payload.winningBidAmount = winningBidAmount;
    }
    this.eventsService.emitAuctionStatusChanged(payload);
  }

  private async getAndSynchronizeStatus(
    auctionId: string,
  ): Promise<AuctionDocument> {
    const auction = await this.auctionRepo.findById(auctionId);
    if (!auction) throw new NotFoundException('Auction not found');

    const now = new Date();
    let shouldSave = false;
    if (!auction.creationFeeTier || !auction.creationFeeAmount) {
      const creationFee = calculateCreationFee(
        Number(auction.maxPrice.toString()),
      );
      auction.creationFeeTier = creationFee.tier;
      auction.creationFeeAmount = Types.Decimal128.fromString(
        creationFee.amount,
      );
      shouldSave = true;
    }

    if (
      auction.status === AuctionStatus.PENDING &&
      now >= auction.startTime &&
      now < auction.endTime
    ) {
      auction.status = AuctionStatus.OPEN;
      shouldSave = true;
    } else if (
      auction.status === AuctionStatus.PENDING &&
      now >= auction.endTime
    ) {
      auction.status = AuctionStatus.COMPLETED;
      const winningBid =
        auction.auctionType === AuctionType.PUBLIC
          ? await this.bidModel
              .findOne({ auctionId: auction._id })
              .sort({ bidAmount: 1, bidTime: 1 })
              .exec()
          : null;
      auction.winningBidId = winningBid?._id ?? null;
      shouldSave = true;
    } else if (
      auction.status === AuctionStatus.OPEN &&
      now >= auction.endTime
    ) {
      auction.status = AuctionStatus.COMPLETED;
      const winningBid =
        auction.auctionType === AuctionType.PUBLIC
          ? await this.bidModel
              .findOne({ auctionId: auction._id })
              .sort({ bidAmount: 1, bidTime: 1 })
              .exec()
          : null;
      auction.winningBidId = winningBid?._id ?? null;
      shouldSave = true;
    }
    if (shouldSave) await auction.save();
    if (shouldSave && auction.status === AuctionStatus.COMPLETED) {
      await this.ensureAward(auction);
    }
    return auction;
  }

  private async ensureAward(auction: AuctionDocument) {
    if (auction.awardStatus === 'CREATED' || auction.awardStatus === 'NO_WINNER') return;
    if (!auction.winningBidId && auction.auctionType === AuctionType.SEALED) return;
    const winningBid = auction.winningBidId
      ? await this.bidModel.findOne({ _id: auction.winningBidId, auctionId: auction._id }).exec()
      : null;
    await this.awardService.createForWinner(auction, winningBid);
  }

  private validateSchedule(
    registrationStartTime: Date,
    registrationEndTime: Date,
    startTime: Date,
    endTime: Date,
  ) {
    const now = new Date();
    if (
      !(registrationStartTime instanceof Date) ||
      !(registrationEndTime instanceof Date) ||
      !(startTime instanceof Date) ||
      !(endTime instanceof Date)
    ) {
      throw new BadRequestException('Auction times must be valid dates');
    }
    if (registrationStartTime > registrationEndTime) {
      throw new BadRequestException(
        'registrationStartTime must be before registrationEndTime',
      );
    }
    if (registrationEndTime <= now) {
      throw new BadRequestException(
        'registrationEndTime must be in the future',
      );
    }
    if (registrationEndTime > startTime || startTime >= endTime) {
      throw new BadRequestException(
        'Auction time order must be registrationEndTime <= startTime < endTime',
      );
    }
  }

  private parseAmount(value: string | undefined, field: string): number {
    const parsed = Number(value);
    if (!value || !Number.isFinite(parsed) || parsed <= 0) {
      throw new BadRequestException(`${field} must be greater than zero`);
    }
    return parsed;
  }

  private assertOwnerOrAdmin(
    auction: AuctionDocument,
    actorId: string,
    role: string,
  ) {
    if (
      role !== 'ADMIN' &&
      !(role === 'SHIPPER' && auction.shipperId === actorId)
    ) {
      throw new ForbiddenException(
        'Only the auction owner or an admin can perform this action',
      );
    }
  }

  private serialize(auction: AuctionDocument) {
    const now = new Date();
    return {
      id: auction._id,
      shipperId: auction.shipperId,
      title: auction.title,
      goodsType: auction.goodsType,
      weight: auction.weight,
      volume: auction.volume ?? null,
      goodsValue: auction.goodsValue?.toString() ?? null,
      vehicleTypeRequired: auction.vehicleTypeRequired,
      requiredTemp: auction.requiredTemp ?? null,
      vehicleSpecs: auction.vehicleSpecs ?? null,
      requiredVehicleDims: auction.vehicleSpecs
        ? {
            length: auction.vehicleSpecs.length,
            width: auction.vehicleSpecs.width,
            height: auction.vehicleSpecs.height,
          }
        : null,
      origin: auction.origin,
      destination: auction.destination,
      pickupLocation: auction.pickupLocation,
      deliveryLocation: auction.deliveryLocation,
      originLocationName: auction.pickupLocation?.locationName ?? null,
      originAddress: auction.pickupLocation?.address ?? null,
      originProvince: auction.pickupLocation?.province ?? null,
      originContactName: auction.pickupLocation?.contactName ?? null,
      originContactPhone: auction.pickupLocation?.contactPhone ?? null,
      destinationLocationName: auction.deliveryLocation?.locationName ?? null,
      destinationAddress: auction.deliveryLocation?.address ?? null,
      destinationProvince: auction.deliveryLocation?.province ?? null,
      destinationContactName: auction.deliveryLocation?.contactName ?? null,
      destinationContactPhone: auction.deliveryLocation?.contactPhone ?? null,
      earliestPickup: auction.pickupLocation?.earliestTime ?? null,
      latestPickup: auction.pickupLocation?.latestTime ?? null,
      earliestDelivery: auction.deliveryLocation?.earliestTime ?? null,
      latestDelivery: auction.deliveryLocation?.latestTime ?? null,
      auctionType: auction.auctionType,
      maxPrice: auction.maxPrice.toString(),
      priceStep: auction.priceStep ? auction.priceStep.toString() : null,
      maxBids: auction.maxBids ?? null,
      images: auction.images,
      notes: auction.notes,
      isDepositRequired: auction.isDepositRequired,
      depositAmount: auction.depositAmount?.toString() ?? null,
      participationFeeTier: auction.participationFeeTier,
      participationFeeAmount: auction.participationFeeAmount.toString(),
      creationFeeTier: auction.creationFeeTier || null,
      creationFeeAmount: auction.creationFeeAmount
        ? auction.creationFeeAmount.toString()
        : null,
      creationFeeStatus: auction.creationFeeStatus ?? null,
      registrationStartTime: auction.registrationStartTime ?? null,
      registrationEndTime: auction.registrationEndTime,
      startTime: auction.startTime,
      endTime: auction.endTime,
      status: auction.status,
      registrationOpen:
        auction.status === AuctionStatus.PENDING &&
        now < auction.registrationEndTime,
      roomOpen:
        auction.status === AuctionStatus.OPEN &&
        now >= auction.startTime &&
        now < auction.endTime,
      winningBidId: auction.winningBidId ?? null,
      awardStatus: auction.awardStatus ?? null,
      awardTripId: auction.awardTripId ?? null,
      awardError: auction.awardError ?? null,
      awardProgress: this.serializeAwardProgress(auction),
      cancellationReason: auction.cancellationReason ?? null,
      fraudFlag: auction.fraudFlag ?? false,
      fraudReason: auction.fraudReason ?? null,
      createdAt: auction.createdAt,
      updatedAt: auction.updatedAt,
    };
  }

  private serializeAwardProgress(auction: AuctionDocument) {
    const attempts = auction.awardAttempts ?? [];
    const current = attempts.find((attempt) =>
      [
        'CREATING',
        'CREATION_FAILED',
        'AWAITING_CARRIER_SIGNATURE',
        'AWAITING_SHIPPER_SIGNATURE',
      ].includes(attempt.status),
    );
    return {
      currentAttempt: current?.attemptNumber ?? attempts.length,
      maximumAttempts: 1 + 3,
      status: current?.status ?? auction.awardStatus ?? null,
      signingDeadlineAt: current?.signingDeadlineAt ?? null,
    };
  }
}
