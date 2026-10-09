import { ConflictException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { AuctionService } from '../auction/auction.service';
import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { AuctionType } from '../../common/enums/auction-type.enum';
import { AuctionRegistrationService } from '../auction-registration/auction-registration.service';
import { CarrierCoverageClient } from '../../integrations/identity/carrier-coverage.client';
import { ListBidsQueryDto } from './dto/list-bids-query.dto';
import { PlaceBidDto } from './dto/place-bid.dto';
import { Bid, BidDocument } from './schemas/bid.schema';

@Injectable()
export class BidService {
  private readonly auctionLocks = new Map<string, Promise<void>>();

  constructor(
    @InjectModel(Bid.name)
    private readonly bidModel: Model<BidDocument>,
    private readonly auctionService: AuctionService,
    private readonly registrationService: AuctionRegistrationService,
    private readonly coverageClient: CarrierCoverageClient,
  ) {}

  async place(auctionId: string, carrierId: string, dto: PlaceBidDto) {
    return this.withAuctionLock(auctionId, async () => {
      const idempotencyKey = dto.idempotencyKey?.trim();
      if (idempotencyKey) {
        const existing = await this.bidModel
          .findOne({ auctionId, carrierId, idempotencyKey })
          .exec();
        if (existing) return this.serialize(existing);
      }

      const access = await this.registrationService.getAccess(
        auctionId,
        carrierId,
      );
      if (!access.canEnter) {
        throw new ConflictException(`Carrier cannot bid: ${access.accessStatus}`);
      }

      const auction = await this.auctionService.findById(auctionId);
      if (auction.status !== AuctionStatus.OPEN || !auction.roomOpen) {
        throw new ConflictException('Auction is not accepting bids');
      }

      // Only auctions the shipper marked require a verified certificate; other auctions are unchanged.
      if (auction.requireCarrierCoverage === true) {
        await this.coverageClient.assertEligible(carrierId);
      }

      const amount = Number(dto.bidAmount);
      const maxPrice = Number(auction.maxPrice);
      if (!Number.isFinite(amount) || amount <= 0 || amount > maxPrice) {
        throw new ConflictException(
          'Bid amount must be positive and not exceed maxPrice',
        );
      }

      if (auction.maxBids != null) {
        const carrierBidCount = await this.bidModel
          .countDocuments({ auctionId, carrierId })
          .exec();
        if (carrierBidCount >= Number(auction.maxBids)) {
          throw new ConflictException(
            'Carrier has reached the maximum number of bids',
          );
        }
      }

      if (auction.auctionType !== AuctionType.SEALED) {
        const currentLowest = await this.bidModel
          .findOne({ auctionId })
          .sort({ bidAmount: 1, bidTime: 1 })
          .exec();
        if (currentLowest && amount >= Number(currentLowest.bidAmount.toString())) {
          throw new ConflictException(
            'Bid must be lower than the current lowest bid',
          );
        }
        if (currentLowest && auction.priceStep != null) {
          const step = Number(auction.priceStep);
          const lowest = Number(currentLowest.bidAmount.toString());
          if (Number.isFinite(step) && step > 0 && amount > lowest - step) {
            throw new ConflictException(
              'Bid must improve the current lowest bid by at least the price step',
            );
          }
        }
      }

      const bid = await this.bidModel.create({
        auctionId,
        carrierId,
        bidAmount: Types.Decimal128.fromString(amount.toFixed(2)),
        bidTime: new Date(),
        idempotencyKey: idempotencyKey ?? null,
      });
      return this.serialize(bid);
    });
  }

  async list(
    auctionId: string,
    viewerId: string,
    role: string,
    query: ListBidsQueryDto,
  ) {
    const auction = await this.auctionService.findById(auctionId);
    const sort = query.sortOrder === 'asc' ? 1 : -1;
    const filter =
      auction.auctionType === AuctionType.SEALED && role === 'CARRIER'
        ? { auctionId, carrierId: viewerId }
        : { auctionId };
    const skip = (query.page - 1) * query.pageSize;
    const ownBidCount =
      role === 'CARRIER'
        ? await this.bidModel.countDocuments({ auctionId, carrierId: viewerId }).exec()
        : null;
    const [items, totalItems] = await Promise.all([
      this.bidModel
        .find(filter)
        .sort({ bidTime: sort })
        .skip(skip)
        .limit(query.pageSize)
        .exec(),
      this.bidModel.countDocuments(filter).exec(),
    ]);
    return {
      data: items.map((item) => this.serialize(item)),
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        totalItems,
        totalPages: Math.ceil(totalItems / query.pageSize),
        remainingBids:
          role === 'CARRIER' && auction.maxBids != null
            ? Math.max(0, Number(auction.maxBids) - Number(ownBidCount))
            : null,
      },
    };
  }

  private async withAuctionLock<T>(auctionId: string, work: () => Promise<T>) {
    const previous = this.auctionLocks.get(auctionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.auctionLocks.set(auctionId, queued);

    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.auctionLocks.get(auctionId) === queued) {
        this.auctionLocks.delete(auctionId);
      }
    }
  }

  private serialize(bid: BidDocument) {
    return {
      id: bid._id,
      auctionId: bid.auctionId,
      carrierId: bid.carrierId,
      bidAmount: bid.bidAmount.toString(),
      bidTime: bid.bidTime,
      idempotencyKey: bid.idempotencyKey ?? null,
    };
  }
}
