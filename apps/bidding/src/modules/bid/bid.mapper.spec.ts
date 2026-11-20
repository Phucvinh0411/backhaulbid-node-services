import { Types } from 'mongoose';
import { BidDocument } from './schemas/bid.schema';
import { toBidResponse, toBidResponses } from './bid.mapper';

describe('bid.mapper', () => {
  it('maps bid documents to BidResponseDto cleanly', () => {
    const bidTime = new Date('2026-11-20T10:15:00.000Z');
    const doc = {
      _id: 'bid-1',
      __v: 0,
      auctionId: 'auc-1',
      carrierId: 'carrier-1',
      bidAmount: Types.Decimal128.fromString('12500000.00'),
      bidTime,
      idempotencyKey: 'idem-1',
    } as unknown as BidDocument;

    const dto = toBidResponse(doc);
    expect(dto).toEqual({
      id: 'bid-1',
      auctionId: 'auc-1',
      carrierId: 'carrier-1',
      bidAmount: '12500000.00',
      bidTime,
      idempotencyKey: 'idem-1',
    });
    expect(dto).not.toHaveProperty('_id');
    expect(toBidResponses([doc])).toHaveLength(1);
  });
});
