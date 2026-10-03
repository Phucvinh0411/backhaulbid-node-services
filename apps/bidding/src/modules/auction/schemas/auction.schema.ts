import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { AuctionStatus } from '../../../common/enums/auction-status.enum';
import { AuctionType } from '../../../common/enums/auction-type.enum';
import { CreationFeeStatus } from '../../../common/enums/creation-fee-status.enum';
import { ParticipationFeeTier, CreationFeeTier } from '../fee-policy';
import {
  LocationDetail,
  LocationDetailSchema,
} from '../../../common/schemas/location.schema';
import {
  VehicleSpecs,
  VehicleSpecsSchema,
} from '../../../common/schemas/vehicle.schema';

export type AuctionDocument = HydratedDocument<Auction>;

export enum AuctionAwardAttemptStatus {
  QUEUED = 'QUEUED',
  CREATING = 'CREATING',
  CREATION_FAILED = 'CREATION_FAILED',
  AWAITING_CARRIER_SIGNATURE = 'AWAITING_CARRIER_SIGNATURE',
  AWAITING_SHIPPER_SIGNATURE = 'AWAITING_SHIPPER_SIGNATURE',
  SIGNED = 'SIGNED',
  CARRIER_EXPIRED = 'CARRIER_EXPIRED',
  SHIPPER_EXPIRED = 'SHIPPER_EXPIRED',
  SKIPPED = 'SKIPPED',
}

@Schema({ _id: false })
export class AuctionAwardAttempt {
  @Prop({ type: String, required: true })
  attemptId!: string;

  @Prop({ type: Number, required: true })
  attemptNumber!: number;

  @Prop({ type: String, required: true })
  bidId!: string;

  @Prop({ type: String, required: true })
  carrierId!: string;

  @Prop({ type: String, required: true })
  bidAmount!: string;

  @Prop({ type: String, enum: AuctionAwardAttemptStatus, required: true })
  status!: AuctionAwardAttemptStatus;

  @Prop({ type: Date, default: null })
  signingDeadlineAt!: Date | null;

  @Prop({ type: String, default: null })
  tripId!: string | null;

  @Prop({ type: String, default: null })
  contractId!: string | null;

  @Prop({ type: String, default: null, maxlength: 500 })
  failureReason!: string | null;
}

export const AuctionAwardAttemptSchema = SchemaFactory.createForClass(AuctionAwardAttempt);

@Schema({ collection: 'auctions', timestamps: true, versionKey: false })
export class Auction {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  shipperId!: string;

  @Prop({ type: String, required: true, trim: true })
  title!: string;

  @Prop({ type: String, required: true, trim: true })
  goodsType!: string;

  @Prop({ type: Number, required: true, min: 0 })
  weight!: number;

  @Prop({ type: Number, min: 0 })
  volume?: number;

  @Prop({ type: MongooseSchema.Types.Decimal128 })
  goodsValue?: Types.Decimal128;

  @Prop({ type: String, required: true, trim: true })
  vehicleTypeRequired!: string;

  @Prop({ type: String, trim: true })
  requiredTemp?: string;

  @Prop({ type: VehicleSpecsSchema })
  vehicleSpecs?: VehicleSpecs;

  // Origin/Destination kept for backward compatibility or simple queries, but enriched via sub-documents
  @Prop({ type: String, required: true, trim: true })
  origin!: string;

  @Prop({ type: String, required: true, trim: true })
  destination!: string;

  @Prop({ type: LocationDetailSchema, required: true })
  pickupLocation!: LocationDetail;

  @Prop({ type: LocationDetailSchema, required: true })
  deliveryLocation!: LocationDetail;

  @Prop({ type: String, enum: AuctionType, default: AuctionType.PUBLIC })
  auctionType!: AuctionType;

  @Prop({ type: MongooseSchema.Types.Decimal128, required: true })
  maxPrice!: Types.Decimal128;

  @Prop({ type: MongooseSchema.Types.Decimal128, required: true })
  priceStep!: Types.Decimal128;

  @Prop({ type: Number })
  maxBids?: number;

  @Prop({ type: [String], default: [] })
  images!: string[];

  @Prop({ type: String, default: null })
  notes!: string | null;

  @Prop({ type: Boolean, required: true, default: false })
  isDepositRequired!: boolean;

  @Prop({ type: MongooseSchema.Types.Decimal128, default: null })
  depositAmount!: Types.Decimal128 | null;

  @Prop({ type: String, enum: ParticipationFeeTier, required: true })
  participationFeeTier!: ParticipationFeeTier;

  @Prop({ type: MongooseSchema.Types.Decimal128, required: true })
  participationFeeAmount!: Types.Decimal128;

  @Prop({ type: String, enum: CreationFeeTier, required: true })
  creationFeeTier!: CreationFeeTier;

  @Prop({ type: MongooseSchema.Types.Decimal128, required: true })
  creationFeeAmount!: Types.Decimal128;

  @Prop({ type: String, default: null, index: true })
  creationIdempotencyKey!: string | null;

  @Prop({
    type: String,
    enum: CreationFeeStatus,
    default: CreationFeeStatus.SETTLED,
  })
  creationFeeStatus!: CreationFeeStatus;

  @Prop({ type: String, default: null })
  creationFeeHoldId!: string | null;

  @Prop({ type: String, default: null })
  creationFeeTransactionId!: string | null;

  @Prop({ type: Date, default: null })
  registrationStartTime!: Date | null;

  @Prop({ type: Date, required: true })
  registrationEndTime!: Date;

  @Prop({ type: Date, required: true, index: true })
  startTime!: Date;

  @Prop({ type: Date, required: true, index: true })
  endTime!: Date;

  @Prop({
    type: String,
    enum: AuctionStatus,
    default: AuctionStatus.PENDING,
    index: true,
  })
  status!: AuctionStatus;

  @Prop({ type: String, default: null })
  winningBidId!: string | null;

  @Prop({ type: String, default: null })
  awardStatus!: string | null;

  @Prop({ type: String, default: null })
  awardTripId!: string | null;

  @Prop({ type: String, default: null, maxlength: 500 })
  awardError!: string | null;

  @Prop({ type: [AuctionAwardAttemptSchema], default: [] })
  awardAttempts!: AuctionAwardAttempt[];

  @Prop({ type: Boolean, default: false })
  awardCleanupCompleted!: boolean;

  @Prop({ type: String, default: null, trim: true })
  cancellationReason!: string | null;

  @Prop({ type: Boolean, default: false })
  fraudFlag!: boolean;

  @Prop({ type: String, default: null, trim: true })
  fraudReason!: string | null;

  createdAt!: Date;
  updatedAt!: Date;
}

export const AuctionSchema = SchemaFactory.createForClass(Auction);
AuctionSchema.index({ shipperId: 1, createdAt: -1 });
AuctionSchema.index(
  { shipperId: 1, creationIdempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      creationIdempotencyKey: { $type: 'string' },
    },
  },
);
AuctionSchema.index({ status: 1, startTime: 1 });
AuctionSchema.index({ status: 1, endTime: 1 });
