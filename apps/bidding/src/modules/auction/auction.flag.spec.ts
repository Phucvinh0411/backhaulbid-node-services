import { NotFoundException } from '@nestjs/common';
import { AuctionService } from './auction.service';

describe('AuctionService flag and unflag', () => {
  it('sets and clears fraudFlag cleanly', async () => {
    const auction: Record<string, unknown> = {
      _id: 'auc-1',
      shipperId: 'shipper-1',
      auctionType: 'PUBLIC',
      status: 'OPEN',
      maxPrice: '10000000',
      participationFeeAmount: '50000',
      registrationEndTime: new Date(),
      startTime: new Date(),
      endTime: new Date(),
      fraudFlag: false,
      fraudReason: null,
      save: jest.fn(async () => undefined),
    };
    const auctionRepo = {
      findById: jest.fn(async (id: string) => (id === 'auc-1' ? auction : null)),
    };
    const service = new AuctionService(
      auctionRepo as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    const flagged = await service.flag('auc-1', { reason: '  Test nghi van  ' });
    expect(flagged.fraudFlag).toBe(true);
    expect(flagged.fraudReason).toBe('Test nghi van');

    const unflagged = await service.unflag('auc-1');
    expect(unflagged.fraudFlag).toBe(false);
    expect(unflagged.fraudReason).toBeNull();
    expect(auction.save).toHaveBeenCalledTimes(2);

    await expect(service.unflag('missing')).rejects.toThrow(NotFoundException);
  });
});
