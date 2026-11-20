import { Types } from 'mongoose';
import { AuctionRegistrationDocument } from './schemas/auction-registration.schema';
import { toAuctionRegistrationResponse } from './auction-registration.mapper';

describe('auction-registration.mapper', () => {
  it('maps registration document without leaking mongoose internals', () => {
    const startTime = new Date('2026-11-20T12:00:00.000Z');
    const createdAt = new Date('2026-11-20T09:00:00.000Z');
    const doc = {
      _id: 'reg-1',
      __v: 0,
      auctionId: 'auc-1',
      carrierId: 'carrier-1',
      vehicleId: 'veh-1',
      status: 'APPROVED',
      paymentStatus: 'PAID',
      depositStatus: 'HELD',
      participationFeeStatus: 'CAPTURED',
      participationFeeAmount: Types.Decimal128.fromString('50000.00'),
      depositAmount: Types.Decimal128.fromString('1000000.00'),
      depositHoldId: 'hold-1',
      participationFeeTransactionId: 'tx-1',
      paymentErrorCode: null,
      createdAt,
      updatedAt: createdAt,
    } as unknown as AuctionRegistrationDocument;

    const dto = toAuctionRegistrationResponse(doc, { startTime });

    expect(dto).toEqual({
      id: 'reg-1',
      auctionId: 'auc-1',
      carrierId: 'carrier-1',
      vehicleId: 'veh-1',
      status: 'APPROVED',
      paymentStatus: 'PAID',
      depositStatus: 'HELD',
      participationFeeStatus: 'CAPTURED',
      participationFeeAmount: '50000.00',
      depositAmount: '1000000.00',
      depositHoldId: 'hold-1',
      participationFeeTransactionId: 'tx-1',
      paymentErrorCode: null,
      startTime,
      registeredAt: createdAt,
      updatedAt: createdAt,
    });
    expect(dto).not.toHaveProperty('_id');
    expect(dto).not.toHaveProperty('__v');
  });
});
