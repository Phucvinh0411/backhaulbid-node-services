import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { DepositStatus } from '../../../common/enums/deposit-status.enum';
import { ParticipationFeeStatus } from '../../../common/enums/participation-fee-status.enum';
import { RegistrationPaymentStatus } from '../../../common/enums/registration-payment-status.enum';
import { RegistrationStatus } from '../../../common/enums/registration-status.enum';

export type AuctionRegistrationDocument = HydratedDocument<AuctionRegistration>;

@Schema({
  collection: 'auction_registrations',
  timestamps: true,
  versionKey: false,
})
export class AuctionRegistration {
  @Prop({ type: String, default: () => randomUUID() })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  auctionId!: string;

  @Prop({ type: String, required: true, index: true })
  carrierId!: string;

  @Prop({ type: String, required: true })
  vehicleId!: string;

  @Prop({
    type: String,
    enum: RegistrationStatus,
    default: RegistrationStatus.REGISTERED,
  })
  status!: RegistrationStatus;

  @Prop({ type: String, enum: RegistrationPaymentStatus, required: true })
  paymentStatus!: RegistrationPaymentStatus;

  @Prop({ type: String, enum: DepositStatus, required: true })
  depositStatus!: DepositStatus;

  @Prop({ type: String, enum: ParticipationFeeStatus, required: true })
  participationFeeStatus!: ParticipationFeeStatus;

  @Prop({ type: MongooseSchema.Types.Decimal128, required: true })
  participationFeeAmount!: Types.Decimal128;

  @Prop({ type: MongooseSchema.Types.Decimal128, default: null })
  depositAmount!: Types.Decimal128 | null;

  @Prop({ type: String, default: null })
  depositHoldId!: string | null;

  @Prop({ type: String, default: null })
  participationFeeTransactionId!: string | null;

  @Prop({ type: String, required: true })
  idempotencyKey!: string;

  @Prop({ type: String, default: null })
  paymentErrorCode!: string | null;

  @Prop({ type: Number, default: 0 })
  paymentAttempt?: number;

  registeredAt!: Date;
  createdAt!: Date;
  updatedAt!: Date;
}

export const AuctionRegistrationSchema =
  SchemaFactory.createForClass(AuctionRegistration);
AuctionRegistrationSchema.index(
  { auctionId: 1, carrierId: 1 },
  { unique: true },
);
AuctionRegistrationSchema.index({ auctionId: 1, status: 1 });
AuctionRegistrationSchema.index({ carrierId: 1, status: 1 });
AuctionRegistrationSchema.index({ paymentStatus: 1, depositStatus: 1, updatedAt: 1 });
AuctionRegistrationSchema.index({ auctionId: 1, depositStatus: 1 });
