import { AuctionAwardService } from './auction-award.service';
import { AuctionService } from './auction.service';

describe('Auction schedulers distributed lock (replicas > 1)', () => {
  it('skips synchronizeDueAuctions when another pod holds Redis lock, and releases when acquired', async () => {
    const auctionRepo = {
      find: jest.fn().mockResolvedValue([]),
    } as any;
    const redis = {
      tryAcquireLock: jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    } as any;

    const service = new AuctionService(
      auctionRepo,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      redis,
    );

    await (service as any).synchronizeDueAuctions();
    expect(auctionRepo.find).not.toHaveBeenCalled();
    expect(redis.releaseLock).not.toHaveBeenCalled();

    await (service as any).synchronizeDueAuctions();
    expect(auctionRepo.find).toHaveBeenCalledTimes(1);
    expect(redis.releaseLock).toHaveBeenCalledWith(
      'bidding:auction:sync:lock',
      expect.any(String),
    );
  });

  it('skips processAwardAttempts when another pod holds Redis sweep lock', async () => {
    const auctionModel = {
      find: jest.fn().mockReturnValue({
        limit: jest
          .fn()
          .mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
      }),
    } as any;
    const redis = {
      tryAcquireLock: jest
        .fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    } as any;

    const awardService = new AuctionAwardService(
      auctionModel,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      redis,
    );

    await awardService.processAwardAttempts();
    expect(auctionModel.find).not.toHaveBeenCalled();

    await awardService.processAwardAttempts();
    expect(auctionModel.find).toHaveBeenCalledTimes(3);
    expect(redis.releaseLock).toHaveBeenCalledWith(
      'bidding:award:sweep:lock',
      expect.any(String),
    );
  });
});
