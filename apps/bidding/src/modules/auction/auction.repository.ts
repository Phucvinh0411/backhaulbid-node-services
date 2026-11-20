import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Auction, AuctionDocument } from './schemas/auction.schema';

@Injectable()
export class AuctionRepository {
  constructor(
    @InjectModel(Auction.name)
    private readonly model: Model<AuctionDocument>,
  ) {}

  async create(data: Partial<Auction>): Promise<AuctionDocument> {
    const created = new this.model(data);
    return created.save();
  }

  async findByIdempotencyKey(
    shipperId: string,
    creationIdempotencyKey: string,
  ): Promise<AuctionDocument | null> {
    return this.model.findOne({ shipperId, creationIdempotencyKey }).exec();
  }

  async findById(id: string): Promise<AuctionDocument | null> {
    return this.model.findById(id).exec();
  }

  async findByIds(ids: string[]): Promise<AuctionDocument[]> {
    if (ids.length === 0) return [];
    return this.model.find({ _id: { $in: ids } }).exec();
  }

  async find(
    filter: Record<string, any>,
    skip = 0,
    limit = 10,
  ): Promise<AuctionDocument[]> {
    return this.model
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .exec();
  }

  async count(filter: Record<string, any>): Promise<number> {
    return this.model.countDocuments(filter).exec();
  }

  async updateById(
    id: string,
    updateData: Record<string, any>,
  ): Promise<AuctionDocument | null> {
    return this.model
      .findByIdAndUpdate(id, updateData, { new: true, runValidators: true })
      .exec();
  }
}
