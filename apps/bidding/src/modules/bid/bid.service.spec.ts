import { ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { AuctionType } from '../../common/enums/auction-type.enum';
import { BidService } from './bid.service';

describe('BidService distributed lock (replicas > 1)', () => {
  function makeDeps(redisLockImpl: jest.Mock) {
    const bidModel = {
      findOne: jest.fn().mockReturnValue({
        sort: jest
          .fn()
          .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
        exec: jest.fn().mockResolvedValue(null),
      }),
      countDocuments: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(0) }),
      create: jest.fn().mockResolvedValue({
        _id: new Types.ObjectId(),
        auctionId: 'auc-1',
        carrierId: 'carrier-1',
        bidAmount: { toString: () => '900000' },
        bidTime: new Date(),
      }),
    } as any;

    const auctionService = {
      findById: jest.fn().mockResolvedValue({
        id: 'auc-1',
        status: AuctionStatus.OPEN,
        roomOpen: true,
        auctionType: AuctionType.PUBLIC,
        maxPrice: '1000000',
        maxBids: 5,
        priceStep: '50000',
        requireCarrierCoverage: false,
      }),
    } as any;

    const registrationService = {
      getAccess: jest
        .fn()
        .mockResolvedValue({ canEnter: true, accessStatus: 'APPROVED' }),
    } as any;

    const coverageClient = { assertEligible: jest.fn() } as any;
    const verificationClient = {
      assertVerified: jest.fn().mockResolvedValue(undefined),
    } as any;
    const redis = {
      tryAcquireLock: redisLockImpl,
      releaseLock: jest.fn().mockResolvedValue(undefined),
    } as any;

    const service = new BidService(
      bidModel,
      auctionService,
      registrationService,
      coverageClient,
      verificationClient,
      redis,
    );
    return { service, redis, bidModel };
  }

  it('acquires and releases Redis lock around bid placement', async () => {
    const tryAcquireLock = jest.fn().mockResolvedValue(true);
    const { service, redis } = makeDeps(tryAcquireLock);

    const res = await service.place('auc-1', 'carrier-1', {
      bidAmount: '900000',
    });

    expect(res.bidAmount).toBe('900000');
    expect(tryAcquireLock).toHaveBeenCalledWith(
      'bidding:bid:lock:auc-1',
      expect.any(String),
      expect.any(Number),
    );
    expect(redis.releaseLock).toHaveBeenCalledWith(
      'bidding:bid:lock:auc-1',
      tryAcquireLock.mock.calls[0][1],
    );
  });

  it('retries briefly and throws ConflictException when another pod holds the auction lock', async () => {
    const tryAcquireLock = jest.fn().mockResolvedValue(false);
    const { service, bidModel } = makeDeps(tryAcquireLock);

    await expect(
      service.place('auc-1', 'carrier-1', { bidAmount: '900000' } as any),
    ).rejects.toThrow(ConflictException);
    expect(tryAcquireLock.mock.calls.length).toBeGreaterThan(1);
    expect(bidModel.create).not.toHaveBeenCalled();
  });

  it('verifies carrier account before acquiring the Redis auction lock', async () => {
    const tryAcquireLock = jest.fn().mockResolvedValue(true);
    const { service } = makeDeps(tryAcquireLock);
    (service as any).verificationClient.assertVerified = jest
      .fn()
      .mockRejectedValue(new ConflictException('Unverified carrier'));

    await expect(
      service.place('auc-1', 'carrier-1', { bidAmount: '900000' } as any),
    ).rejects.toThrow(ConflictException);
    expect(tryAcquireLock).not.toHaveBeenCalled();
  });
});
