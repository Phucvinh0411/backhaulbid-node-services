import { BadRequestException, ConflictException } from '@nestjs/common';
import { Types } from 'mongoose';
import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { CreationFeeStatus } from '../../common/enums/creation-fee-status.enum';
import { AuctionAwardService } from './auction-award.service';
import { AuctionService } from './auction.service';
import { CreationFeeTier, ParticipationFeeTier } from './fee-policy';

function makePendingAuctionDoc(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    _id: 'auc-upd-1',
    shipperId: 'shipper-1',
    title: 'Lo hang mau',
    goodsType: 'GENERAL',
    weight: 2000,
    volume: null,
    goodsValue: null,
    vehicleTypeRequired: 'TRUCK_MEDIUM',
    requiredTemp: null,
    vehicleSpecs: null,
    origin: 'TP.HCM - Kho A',
    destination: 'Ha Noi - Kho B',
    pickupLocation: {
      locationName: 'Kho A',
      address: '1 Le Loi',
      province: 'TP.HCM',
    },
    deliveryLocation: {
      locationName: 'Kho B',
      address: '2 Giai Phong',
      province: 'Ha Noi',
    },
    auctionType: 'PUBLIC',
    requireCarrierCoverage: false,
    maxPrice: Types.Decimal128.fromString('5000000.00'),
    priceStep: Types.Decimal128.fromString('100000.00'),
    maxBids: null,
    images: [],
    notes: '',
    isDepositRequired: false,
    depositAmount: null,
    participationFeeTier: ParticipationFeeTier.LEVEL_2,
    participationFeeAmount: Types.Decimal128.fromString('20000.00'),
    creationFeeTier: CreationFeeTier.LEVEL_1,
    creationFeeAmount: Types.Decimal128.fromString('50000.00'),
    creationFeeStatus: CreationFeeStatus.SETTLED,
    registrationStartTime: new Date(now + 10 * 60_000),
    registrationEndTime: new Date(now + 60 * 60_000),
    startTime: new Date(now + 90 * 60_000),
    endTime: new Date(now + 180 * 60_000),
    status: AuctionStatus.PENDING,
    awardAttempts: [],
    createdAt: new Date(now),
    updatedAt: new Date(now),
    save: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('AuctionService update schedule & creation fee consistency', () => {
  it('rejects updating registrationStartTime after registrationEndTime instead of validating old start time', async () => {
    const existing = makePendingAuctionDoc();
    const auctionRepo = {
      findById: jest.fn().mockResolvedValue(existing),
      updateById: jest.fn().mockResolvedValue(existing),
    };

    const service = new AuctionService(
      auctionRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    const invalidStartAfterEnd = new Date(
      existing.registrationEndTime.getTime() + 5 * 60_000,
    );

    await expect(
      service.update('auc-upd-1', 'shipper-1', 'SHIPPER', {
        registrationStartTime: invalidStartAfterEnd,
      } as any),
    ).rejects.toThrow(BadRequestException);

    expect(auctionRepo.updateById).not.toHaveBeenCalled();
  });

  it('rejects null registrationStartTime during update', async () => {
    const existing = makePendingAuctionDoc();
    const auctionRepo = {
      findById: jest.fn().mockResolvedValue(existing),
      updateById: jest.fn().mockResolvedValue(existing),
    };

    const service = new AuctionService(
      auctionRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      service.update('auc-upd-1', 'shipper-1', 'SHIPPER', {
        registrationStartTime: null,
      } as any),
    ).rejects.toThrow(BadRequestException);

    expect(auctionRepo.updateById).not.toHaveBeenCalled();
  });

  it('rejects changing maxPrice into a different creation fee tier and never overwrites charged creationFeeAmount', async () => {
    const existing = makePendingAuctionDoc({
      maxPrice: Types.Decimal128.fromString('5000000.00'),
      creationFeeTier: CreationFeeTier.LEVEL_1,
      creationFeeAmount: Types.Decimal128.fromString('50000.00'),
    });
    const auctionRepo = {
      findById: jest.fn().mockResolvedValue(existing),
      updateById: jest.fn().mockImplementation((_id, update) =>
        Promise.resolve({
          ...existing,
          ...update,
          maxPrice: Types.Decimal128.fromString(String(update.maxPrice)),
        }),
      ),
    };

    const service = new AuctionService(
      auctionRepo as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    // Tier boundary: 5,000,000 is LEVEL_1 (50,000), 60,000,000 is LEVEL_3 (150,000)
    await expect(
      service.update('auc-upd-1', 'shipper-1', 'SHIPPER', {
        maxPrice: '60000000',
      }),
    ).rejects.toThrow(ConflictException);
    expect(auctionRepo.updateById).not.toHaveBeenCalled();

    // Updating maxPrice within the same LEVEL_1 (< 10,000,000) succeeds and keeps 50,000 fee intact
    const updated = await service.update('auc-upd-1', 'shipper-1', 'SHIPPER', {
      maxPrice: '8000000',
    });
    const updatePayload = auctionRepo.updateById.mock.calls[0][1];
    expect(updatePayload.creationFeeAmount).toBeUndefined();
    expect(updatePayload.creationFeeTier).toBeUndefined();

    // Award refund after NO_CARRIER_SIGNED still refunds the exact 50000.00 originally charged
    const walletClient = {
      refund: jest.fn().mockResolvedValue({
        status: 'SUCCESS',
        transactionId: 'tx-refund-1',
        amount: '50000.00',
      }),
    };
    const awardService = new AuctionAwardService(
      {} as any,
      {} as any,
      {
        find: jest
          .fn()
          .mockReturnValue({ exec: jest.fn().mockResolvedValue([]) }),
      } as any,
      {} as any,
      walletClient as any,
      { notify: jest.fn().mockResolvedValue(undefined) } as any,
    );

    const noCarrierAuction = makePendingAuctionDoc({
      maxPrice: Types.Decimal128.fromString(updated.maxPrice),
      creationFeeAmount: existing.creationFeeAmount,
      creationFeeStatus: CreationFeeStatus.SETTLED,
    });
    await (awardService as any).finishWithoutCarrier(noCarrierAuction);

    expect(walletClient.refund).toHaveBeenCalledWith(
      'shipper-1',
      expect.objectContaining({
        amount: '50000.00',
        purpose: 'AUCTION_CREATION_FEE_REFUND',
      }),
    );
  });
});
