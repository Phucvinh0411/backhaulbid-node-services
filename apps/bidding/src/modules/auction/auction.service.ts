import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuctionDocument } from './schemas/auction.schema';
import { toAuctionResponse, toAuctionResponses } from './auction.mapper';
import {
  ownerValueDocumentView,
  parseValueDocumentInputs,
  recordsFromInputs,
  ValueDocumentRecord,
  valueDocumentChecklist,
  valueDocumentsOf,
} from './value-documents';
import { AuctionRepository } from './auction.repository';
import { CreateAuctionDto } from './dto/create-auction.dto';
import { ListAuctionsQueryDto } from './dto/list-auctions-query.dto';
import { UpdateAuctionDto } from './dto/update-auction.dto';
import { FlagAuctionDto } from './dto/flag-auction.dto';
import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { AuctionType } from '../../common/enums/auction-type.enum';
import { CreationFeeStatus } from '../../common/enums/creation-fee-status.enum';
import { calculateParticipationFee, calculateCreationFee } from './fee-policy';
import {
  WalletClient,
  WalletClientError,
} from '../../integrations/wallet/wallet.client';
import { Bid, BidDocument } from '../bid/schemas/bid.schema';
import { GlobalEventBus } from '../../common/events';
import {
  AuctionStatusPayload,
  BiddingEventsService,
} from '../bidding/bidding-events.service';
import { AuctionAwardService } from './auction-award.service';
import { BiddingSagaService } from './bidding-saga.service';
import { MediaFileClient } from '../../integrations/media/media-file.client';
import { AccountVerificationClient } from '../../integrations/identity/account-verification.client';
import { confirmedLocation } from '../../common/location-coordinates';

@Injectable()
export class AuctionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuctionService.name);
  private dueAuctionsInterval: NodeJS.Timeout | null = null;
  private synchronizingDueAuctions = false;

  constructor(
    private readonly auctionRepo: AuctionRepository,
    @InjectModel(Bid.name)
    private readonly bidModel: Model<BidDocument>,
    private readonly walletClient: WalletClient,
    private readonly eventsService: BiddingEventsService,
    private readonly awardService: AuctionAwardService,
    private readonly mediaFiles: MediaFileClient,
    private readonly verificationClient: AccountVerificationClient,
    @Optional()
    private readonly biddingSaga?: BiddingSagaService,
  ) {}

  onModuleInit(): void {
    this.scheduleDueAuctionSynchronization();
    this.dueAuctionsInterval = setInterval(
      () => this.scheduleDueAuctionSynchronization(),
      5_000,
    );
    this.dueAuctionsInterval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.dueAuctionsInterval) clearInterval(this.dueAuctionsInterval);
  }

  private scheduleDueAuctionSynchronization(): void {
    void this.synchronizeDueAuctions().catch((error: unknown) => {
      this.logger.error(
        'Could not synchronize due auctions',
        error instanceof Error ? error.stack : String(error),
      );
    });
  }

  private async synchronizeDueAuctions(): Promise<void> {
    if (this.synchronizingDueAuctions) return;
    this.synchronizingDueAuctions = true;

    const now = new Date();
    const dueFilter = {
      status: { $in: [AuctionStatus.PENDING, AuctionStatus.OPEN] },
      $or: [
        { endTime: { $lte: now } },
        { status: AuctionStatus.PENDING, startTime: { $lte: now } },
      ],
    };

    try {
      let due = await this.auctionRepo.find(dueFilter, 0, 100);
      while (due.length > 0) {
        for (const auction of due) {
          await this.getAndSynchronizeStatus(String(auction._id));
        }
        due = await this.auctionRepo.find(dueFilter, 0, 100);
      }
    } finally {
      this.synchronizingDueAuctions = false;
    }
  }

  async create(
    shipperId: string,
    dto: CreateAuctionDto,
    idempotencyKey?: string,
  ) {
    await this.verificationClient.assertVerified(shipperId);
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
    // Value documents are stored as private object keys only; they never reach a provider.
    const { valueDocuments, ...auctionInput } = dto;
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
    const inputs = parseValueDocumentInputs(valueDocuments);
    const documents = recordsFromInputs(inputs, {
      uploadedBy: shipperId,
      uploadedAt: new Date(),
    });
    this.assertValueDocumentChecklist(
      dto.requireCarrierCoverage === true,
      dto.goodsValue ?? null,
      documents,
    );

    const origin = `${dto.pickupLocation.province} - ${dto.pickupLocation.locationName}`;
    const destination = `${dto.deliveryLocation.province} - ${dto.deliveryLocation.locationName}`;
    const pickupLocation = confirmedLocation(dto.pickupLocation);
    const deliveryLocation = confirmedLocation(dto.deliveryLocation);

    const auctionId = randomUUID();
    const holdKey = `auction_creation_fee_${auctionId}`;

    await this.biddingSaga?.beginCreationFeeHold(holdKey, auctionId, shipperId);

    let creationFeeHold: Awaited<ReturnType<WalletClient['hold']>>;
    try {
      creationFeeHold = await this.walletClient.hold(shipperId, {
        auctionId,
        amount: creationFee.amount,
        purpose: 'AUCTION_CREATION_FEE',
        idempotencyKey: holdKey,
      });
    } catch (error) {
      if (
        error instanceof WalletClientError &&
        error.statusCode !== undefined &&
        error.statusCode >= 400 &&
        error.statusCode < 500
      ) {
        await this.biddingSaga?.markCreationFeeCompensated(holdKey);
      }
      throw error;
    }
    if (!creationFeeHold.holdId) {
      throw new ServiceUnavailableException(
        'Wallet service did not return a valid creation fee hold',
      );
    }

    await this.biddingSaga?.claimCreationFeeHoldForCommit(
      holdKey,
      creationFeeHold.holdId,
    );

    let auction: AuctionDocument;
    try {
      auction = await this.auctionRepo.create({
        _id: auctionId,
        shipperId,
        ...auctionInput,
        requireCarrierCoverage: dto.requireCarrierCoverage === true,
        valueDocuments: documents,
        valueDocumentKeys: [],
        pickupLocation,
        deliveryLocation,
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
      await this.biddingSaga?.markCreationFeeCommitted(
        holdKey,
        creationFeeHold.holdId,
      );
    } catch (error) {
      const releaseReason =
        creationIdempotencyKey && this.isDuplicateKeyError(error)
          ? 'duplicate-release'
          : 'release';
      try {
        await this.walletClient.release(
          creationFeeHold.holdId,
          `${holdKey}:${releaseReason}`,
        );
        await this.biddingSaga?.markCreationFeeCompensated(
          holdKey,
          creationFeeHold.holdId,
        );
      } catch (releaseError) {
        this.logger.warn(
          `[CreationFeeSaga] Immediate release failed for ${holdKey}, queued for background compensation: ${releaseError instanceof Error ? releaseError.message : String(releaseError)}`,
        );
        await this.biddingSaga?.recordCreationFeeHoldId(
          holdKey,
          creationFeeHold.holdId,
        );
      }
      if (creationIdempotencyKey && this.isDuplicateKeyError(error)) {
        const existing = await this.auctionRepo.findByIdempotencyKey(
          shipperId,
          creationIdempotencyKey,
        );
        if (existing) return this.returnExistingCreation(existing);
      }
      throw error;
    }

    await this.settleCreationFee(auction);

    const serializedAuction = toAuctionResponse(auction);

    // Phát sự kiện để báo cho BiddingGateway thực hiện so khớp (matching) xe rỗng
    GlobalEventBus.emit('auction_created', serializedAuction);

    return serializedAuction;
  }

  private async returnExistingCreation(auction: AuctionDocument) {
    if (auction.creationFeeStatus !== CreationFeeStatus.SETTLED) {
      await this.settleCreationFee(auction);
      const serializedAuction = toAuctionResponse(auction);
      GlobalEventBus.emit('auction_created', serializedAuction);
      return serializedAuction;
    }
    return toAuctionResponse(auction);
  }

  private async settleCreationFee(auction: AuctionDocument) {
    if (this.biddingSaga) {
      return this.biddingSaga.settleCreationFee(auction);
    }
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
      data: toAuctionResponses(items),
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
    return toAuctionResponse(auction);
  }

  async findByIds(auctionIds: string[]) {
    const uniqueIds = Array.from(
      new Set(auctionIds.map((id) => id.trim()).filter((id) => id.length > 0)),
    );
    if (uniqueIds.length === 0) return [];
    const docs = await this.auctionRepo.findByIds(uniqueIds);
    const synchronized = await Promise.all(
      docs.map((doc) => this.synchronizeAuctionDocument(doc)),
    );
    return toAuctionResponses(synchronized);
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

    const nextRegistrationStart =
      dto.registrationStartTime !== undefined
        ? dto.registrationStartTime
        : (auction.registrationStartTime ?? new Date());
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

    // Documents are replaced as a whole and checked against the auction as it will be after this update.
    const { valueDocuments, ...changes } = dto;
    const update: Record<string, unknown> = { ...changes };
    let documents: ValueDocumentRecord[] | null = null;
    if (valueDocuments !== undefined) {
      documents = recordsFromInputs(
        parseValueDocumentInputs(valueDocuments),
        { uploadedBy: actorId, uploadedAt: new Date() },
        valueDocumentsOf(auction),
      );
      update.valueDocuments = documents;
      update.valueDocumentKeys = [];
    }
    if (
      documents ||
      dto.goodsValue !== undefined ||
      dto.requireCarrierCoverage !== undefined
    ) {
      this.assertValueDocumentChecklist(
        (dto.requireCarrierCoverage ?? auction.requireCarrierCoverage) === true,
        dto.goodsValue ?? auction.goodsValue?.toString() ?? null,
        documents ?? valueDocumentsOf(auction),
      );
    }

    if (dto.pickupLocation) {
      update.origin = `${dto.pickupLocation.province} - ${dto.pickupLocation.locationName}`;
      update.pickupLocation = confirmedLocation(dto.pickupLocation);
    }
    if (dto.deliveryLocation) {
      update.destination = `${dto.deliveryLocation.province} - ${dto.deliveryLocation.locationName}`;
      update.deliveryLocation = confirmedLocation(dto.deliveryLocation);
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
      const creationFee = calculateCreationFee(maxPrice);
      const currentCreationFeeTier =
        auction.creationFeeTier ??
        calculateCreationFee(Number(auction.maxPrice.toString())).tier;
      if (creationFee.tier !== currentCreationFeeTier) {
        throw new ConflictException(
          'Cannot update maxPrice into a different creation fee tier after the creation fee has been charged',
        );
      }

      const fee = calculateParticipationFee(maxPrice);
      update.maxPrice = maxPrice.toFixed(2);
      update.participationFeeTier = fee.tier;
      update.participationFeeAmount = fee.amount;

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
    return toAuctionResponse(updated);
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
    return toAuctionResponse(auction);
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
    await this.biddingSaga?.releaseCancelledAuctionDeposits(String(auction._id));
    this.emitStatus(auction);
    return toAuctionResponse(auction);
  }

  async complete(auctionId: string, actorId: string, role: string) {
    const auction = await this.getAndSynchronizeStatus(auctionId);
    this.assertOwnerOrAdmin(auction, actorId, role);
    if (auction.status !== AuctionStatus.OPEN) {
      if (auction.status === AuctionStatus.COMPLETED) {
        await this.ensureAward(auction);
        return toAuctionResponse(auction);
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
    return toAuctionResponse(auction);
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
    return toAuctionResponse(auction);
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
    return toAuctionResponse(auction);
  }

  /**
   * The owner's list of value documents with the checklist state. Only the auction's shipper or an admin may call it,
   * so no bidder or other shipper learns which documents exist.
   */
  async listValueDocuments(auctionId: string, actorId: string, role: string) {
    const auction = await this.getAuctionForOwner(auctionId, actorId, role);
    const documents = valueDocumentsOf(auction);
    const checklist = valueDocumentChecklist({
      requireCarrierCoverage: auction.requireCarrierCoverage === true,
      goodsValue: auction.goodsValue?.toString() ?? null,
      documents,
    });
    return {
      data: documents.map((record) =>
        ownerValueDocumentView(record, auctionId),
      ),
      checklist,
    };
  }

  /** One value document's bytes, read from private storage after the owner check. */
  async valueDocumentFile(
    auctionId: string,
    documentId: string,
    actorId: string,
    role: string,
  ) {
    const auction = await this.getAuctionForOwner(auctionId, actorId, role);
    const document = valueDocumentsOf(auction).find(
      (record) => record.documentId === documentId.toLowerCase(),
    );
    if (!document) throw new NotFoundException('Value document not found');
    return this.mediaFiles.fetchPrivateFile(document.objectKey);
  }

  private async getAuctionForOwner(
    auctionId: string,
    actorId: string,
    role: string,
  ) {
    const auction = await this.auctionRepo.findById(auctionId);
    if (!auction) throw new NotFoundException('Auction not found');
    this.assertOwnerOrAdmin(auction, actorId, role);
    return auction;
  }

  private assertValueDocumentChecklist(
    requireCarrierCoverage: boolean,
    goodsValue: string | null,
    documents: ValueDocumentRecord[],
  ) {
    const checklist = valueDocumentChecklist({
      requireCarrierCoverage,
      goodsValue,
      documents,
    });
    if (!checklist.satisfied) {
      throw new BadRequestException({
        message:
          'Phiên yêu cầu nhà xe có bảo hiểm cần hoàn tất checklist chuẩn bị của nền tảng trước khi đăng. Checklist này không bảo đảm nhà bảo hiểm chấp thuận.',
        missingItems: checklist.missingItems,
      });
    }
  }

  async flag(auctionId: string, dto: FlagAuctionDto) {
    const auction = await this.auctionRepo.findById(auctionId);
    if (!auction) throw new NotFoundException('Auction not found');
    auction.fraudFlag = true;
    auction.fraudReason = dto.reason.trim();
    await auction.save();
    return toAuctionResponse(auction);
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
    return this.synchronizeAuctionDocument(auction);
  }

  private async synchronizeAuctionDocument(
    auction: AuctionDocument,
  ): Promise<AuctionDocument> {
    const previousStatus = auction.status;
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
    if (shouldSave && auction.status !== previousStatus) {
      this.emitStatus(auction);
    }
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
    const isValidDate = (value: unknown): value is Date =>
      value instanceof Date && !Number.isNaN(value.getTime());
    if (
      !isValidDate(registrationStartTime) ||
      !isValidDate(registrationEndTime) ||
      !isValidDate(startTime) ||
      !isValidDate(endTime)
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
}
