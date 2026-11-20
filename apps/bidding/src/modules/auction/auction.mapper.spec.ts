import { Types } from 'mongoose';
import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { AuctionDocument } from './schemas/auction.schema';
import { toAuctionResponse } from './auction.mapper';

describe('auction.mapper', () => {
  it('maps auction fields and strictly excludes private value document object keys and mongoose internals', () => {
    const now = new Date('2026-11-20T10:00:00.000Z');
    const doc = {
      _id: 'auc-1',
      __v: 2,
      shipperId: 'shipper-1',
      title: 'Tuyen HCM - Ha Noi',
      goodsType: 'ELECTRONICS',
      weight: 5000,
      volume: 20,
      goodsValue: Types.Decimal128.fromString('250000000.00'),
      vehicleTypeRequired: 'TRUCK',
      requiredTemp: null,
      vehicleSpecs: { length: 6.2, width: 2.2, height: 2.3 },
      origin: 'TP.HCM',
      destination: 'Ha Noi',
      pickupLocation: {
        locationName: 'Kho A',
        address: '123 Le Loi',
        province: 'TP.HCM',
        contactName: 'An',
        contactPhone: '0909123456',
        earliestTime: new Date('2026-11-21T08:00:00.000Z'),
        latestTime: new Date('2026-11-21T12:00:00.000Z'),
      },
      deliveryLocation: {
        locationName: 'Kho B',
        address: '456 Giai Phong',
        province: 'Ha Noi',
        contactName: 'Binh',
        contactPhone: '0912345678',
        earliestTime: new Date('2026-11-23T08:00:00.000Z'),
        latestTime: new Date('2026-11-23T18:00:00.000Z'),
      },
      auctionType: 'OPEN',
      requireCarrierCoverage: true,
      maxPrice: Types.Decimal128.fromString('15000000.00'),
      priceStep: Types.Decimal128.fromString('200000.00'),
      maxBids: 5,
      images: ['https://cdn.example/img1.jpg'],
      notes: 'Giao dung gio',
      isDepositRequired: true,
      depositAmount: Types.Decimal128.fromString('1500000.00'),
      participationFeeTier: 'TIER_2',
      participationFeeAmount: Types.Decimal128.fromString('100000.00'),
      creationFeeTier: 'TIER_1',
      creationFeeAmount: Types.Decimal128.fromString('50000.00'),
      creationFeeStatus: 'CAPTURED',
      registrationStartTime: new Date('2026-11-20T08:00:00.000Z'),
      registrationEndTime: new Date('2026-11-20T09:30:00.000Z'),
      startTime: new Date('2026-11-20T09:30:00.000Z'),
      endTime: new Date('2026-11-20T11:00:00.000Z'),
      status: AuctionStatus.OPEN,
      valueDocumentKeys: ['goods-value-docs/00000000-0000-0000-0000-000000000001.pdf'],
      valueDocuments: [
        {
          documentId: '00000000-0000-0000-0000-000000000001',
          kind: 'INVOICE',
          objectKey: 'goods-value-docs/00000000-0000-0000-0000-000000000001.pdf',
          uploadedBy: 'shipper-1',
          uploadedAt: now,
        },
      ],
      awardAttempts: [
        {
          attemptNumber: 1,
          status: 'AWAITING_CARRIER_SIGNATURE',
          signingDeadlineAt: new Date('2026-11-20T15:00:00.000Z'),
        },
      ],
      createdAt: now,
      updatedAt: now,
    } as unknown as AuctionDocument;

    const dto = toAuctionResponse(doc, now);

    expect(dto.id).toBe('auc-1');
    expect(dto.maxPrice).toBe('15000000.00');
    expect(dto.priceStep).toBe('200000.00');
    expect(dto.goodsValue).toBe('250000000.00');
    expect(dto.roomOpen).toBe(true);
    expect(dto.registrationOpen).toBe(false);
    expect(dto.awardProgress).toEqual({
      currentAttempt: 1,
      maximumAttempts: 4,
      status: 'AWAITING_CARRIER_SIGNATURE',
      signingDeadlineAt: new Date('2026-11-20T15:00:00.000Z'),
    });

    expect(dto).not.toHaveProperty('_id');
    expect(dto).not.toHaveProperty('__v');
    expect(dto).not.toHaveProperty('valueDocuments');
    expect(dto).not.toHaveProperty('valueDocumentKeys');
    expect(JSON.stringify(dto)).not.toContain('goods-value-docs/');
  });
});
