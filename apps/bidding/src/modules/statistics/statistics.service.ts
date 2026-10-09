import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Auction } from '../auction/schemas/auction.schema';
import { AuctionRegistration } from '../auction-registration/schemas/auction-registration.schema';
import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { StatisticsBucket, StatisticsRange, bucketDateKey, parseStatisticsRange, statisticsBucketStarts } from './statistics-range';

const COUNT_STATUSES = Object.values(AuctionStatus);
const statusMap = (rows: Array<{ _id: string; count: number }>) => {
  const values = Object.fromEntries(COUNT_STATUSES.map((status) => [status, 0]));
  rows.forEach((row) => { values[row._id] = row.count; });
  return values;
};

function series(rows: Array<{ _id: Date | string; count: number }>, range: StatisticsRange) {
  const indexed = new Map(rows.map((row) => [bucketDateKey(row._id), row.count]));
  return statisticsBucketStarts(range).map((start) => ({ date: bucketDateKey(start), count: indexed.get(bucketDateKey(start)) || 0 }));
}

@Injectable()
export class StatisticsService {
  constructor(
    @InjectModel(Auction.name) private readonly auctions: Model<any>,
    @InjectModel(AuctionRegistration.name) private readonly registrations: Model<any>,
  ) {}

  async mine(actorId: string | undefined, roleInput: string | undefined, query: { dateFrom?: string; dateTo?: string; bucket?: string }) {
    if (!actorId) throw new UnauthorizedException('Authenticated account is required');
    const role = (roleInput || '').toUpperCase();
    if (role !== 'SHIPPER' && role !== 'CARRIER') throw new ForbiddenException('Statistics are available to shippers and carriers');
    const range = parseStatisticsRange(query);
    return role === 'SHIPPER' ? this.shipper(actorId, range) : this.carrier(actorId, range);
  }

  async admin(roleInput: string | undefined, query: { dateFrom?: string; dateTo?: string; bucket?: string }) {
    if ((roleInput || '').toUpperCase() !== 'ADMIN') throw new ForbiddenException('Administrator role is required');
    const range = parseStatisticsRange(query);
    return this.allAuctions(range);
  }

  private async shipper(actorId: string, range: StatisticsRange) {
    const match = { shipperId: actorId, createdAt: { $gte: range.dateFrom, $lt: range.dateTo } };
    const [totals, statuses, trend] = await Promise.all([
      this.auctions.countDocuments(match),
      this.auctions.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      this.auctions.aggregate([
        { $match: match },
        { $group: { _id: { $dateTrunc: { date: '$createdAt', unit: mongoUnit(range.bucket), timezone: 'Asia/Ho_Chi_Minh', ...(range.bucket === 'WEEK' ? { startOfWeek: 'monday' } : {}) } }, count: { $sum: 1 } } },
      ]),
    ]);
    return {
      role: 'SHIPPER', dateFrom: range.dateFrom.toISOString(), dateTo: range.dateTo.toISOString(), bucket: range.bucket,
      total: totals, byStatus: statusMap(statuses), series: series(trend, range), refreshedAt: new Date().toISOString(),
    };
  }

  private async carrier(actorId: string, range: StatisticsRange) {
    const [result] = await this.registrations.aggregate([
      // createdAt is supplied by the persisted Mongoose timestamps; registeredAt is not a schema field.
      { $match: { carrierId: actorId, status: 'REGISTERED', paymentStatus: 'COMPLETED', createdAt: { $gte: range.dateFrom, $lt: range.dateTo } } },
      { $lookup: { from: 'auctions', localField: 'auctionId', foreignField: '_id', as: 'auction' } },
      { $unwind: '$auction' },
      { $lookup: {
        from: 'bids',
        let: { auctionId: '$auctionId', winningBidId: '$auction.winningBidId', carrierId: actorId },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ['$auctionId', '$$auctionId'] }, { $eq: ['$_id', '$$winningBidId'] }, { $eq: ['$carrierId', '$$carrierId'] },
          ] } } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: 'winningBid',
      } },
      { $facet: {
        summary: [{ $group: { _id: null,
          participations: { $sum: 1 },
          decidedAuctions: { $sum: { $cond: [{ $eq: ['$auction.status', AuctionStatus.COMPLETED] }, 1, 0] } },
          wonAuctions: { $sum: { $cond: [{ $and: [{ $eq: ['$auction.status', AuctionStatus.COMPLETED] }, { $gt: [{ $size: '$winningBid' }, 0] }] }, 1, 0] } },
        } }],
        byStatus: [{ $group: { _id: '$auction.status', count: { $sum: 1 } } }],
        series: [{ $group: { _id: { $dateTrunc: { date: '$createdAt', unit: mongoUnit(range.bucket), timezone: 'Asia/Ho_Chi_Minh', ...(range.bucket === 'WEEK' ? { startOfWeek: 'monday' } : {}) } }, count: { $sum: 1 } } }],
      } },
    ]);
    const summary = result?.summary?.[0] || { participations: 0, decidedAuctions: 0, wonAuctions: 0 };
    const decided = summary.decidedAuctions || 0;
    return {
      role: 'CARRIER', dateFrom: range.dateFrom.toISOString(), dateTo: range.dateTo.toISOString(), bucket: range.bucket,
      total: summary.participations || 0,
      participations: summary.participations || 0,
      decidedAuctions: decided,
      wonAuctions: summary.wonAuctions || 0,
      winRate: decided ? Math.round((summary.wonAuctions / decided) * 10000) / 100 : null,
      byStatus: statusMap(result?.byStatus || []),
      series: series(result?.series || [], range), refreshedAt: new Date().toISOString(),
    };
  }

  private async allAuctions(range: StatisticsRange) {
    const match = { createdAt: { $gte: range.dateFrom, $lt: range.dateTo } };
    const [total, statuses, trend] = await Promise.all([
      this.auctions.countDocuments(match),
      this.auctions.aggregate([{ $match: match }, { $group: { _id: '$status', count: { $sum: 1 } } }]),
      this.auctions.aggregate([
        { $match: match },
        { $group: { _id: { $dateTrunc: { date: '$createdAt', unit: mongoUnit(range.bucket), timezone: 'Asia/Ho_Chi_Minh', ...(range.bucket === 'WEEK' ? { startOfWeek: 'monday' } : {}) } }, count: { $sum: 1 } } },
      ]),
    ]);
    return {
      dateFrom: range.dateFrom.toISOString(), dateTo: range.dateTo.toISOString(), bucket: range.bucket,
      total, byStatus: statusMap(statuses), series: series(trend, range), refreshedAt: new Date().toISOString(),
    };
  }
}

function mongoUnit(bucket: StatisticsBucket): 'day' | 'week' | 'month' {
  return bucket.toLowerCase() as 'day' | 'week' | 'month';
}
