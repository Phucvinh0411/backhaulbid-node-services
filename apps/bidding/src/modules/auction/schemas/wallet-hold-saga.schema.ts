import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type WalletHoldSagaStatus =
  | 'HOLDING'
  | 'COMPENSATING'
  | 'COMMITTED'
  | 'COMPENSATED';

const COMPLETED_SAGA_TTL_SECONDS = 7 * 24 * 60 * 60;

@Schema({ collection: 'wallet_hold_sagas', timestamps: true })
export class WalletHoldSaga {
  @Prop({ type: String, required: true })
  _id!: string;

  @Prop({ type: String, required: true, index: true })
  auctionId!: string;

  @Prop({ type: String, required: true })
  shipperId!: string;

  @Prop({ type: String, default: null })
  holdId!: string | null;

  @Prop({
    type: String,
    enum: ['HOLDING', 'COMPENSATING', 'COMMITTED', 'COMPENSATED'],
    default: 'HOLDING',
  })
  status!: WalletHoldSagaStatus;

  @Prop({ type: Date, default: null })
  completedAt!: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type WalletHoldSagaDocument = HydratedDocument<WalletHoldSaga>;
export const WalletHoldSagaSchema = SchemaFactory.createForClass(WalletHoldSaga);
WalletHoldSagaSchema.index({ status: 1, createdAt: 1 });
WalletHoldSagaSchema.index({ status: 1, updatedAt: 1 });
WalletHoldSagaSchema.index(
  { completedAt: 1 },
  {
    expireAfterSeconds: COMPLETED_SAGA_TTL_SECONDS,
    partialFilterExpression: { completedAt: { $type: 'date' } },
  },
);
