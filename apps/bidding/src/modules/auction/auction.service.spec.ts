import { AuctionService } from './auction.service';
import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { AuctionType } from '../../common/enums/auction-type.enum';

describe('AuctionService (Fraud Flag & Lifecycle)', () => {
  let service: AuctionService;
  let mockAuctionRepo: any;
  let mockBidModel: any;
  let mockEventsService: any;
  let mockWalletClient: any;
  let mockAwardService: any;

  beforeEach(() => {
    mockAuctionRepo = {
      create: jest.fn(),
      findByIdempotencyKey: jest.fn(),
      findById: jest.fn(),
      find: jest.fn(),
      count: jest.fn(),
      updateById: jest.fn(),
    };
    mockBidModel = {
      findOne: jest.fn(),
    };

    mockEventsService = {
      attachServer: jest.fn(),
      emitBidPlaced: jest.fn(),
      emitAuctionStatusChanged: jest.fn(),
    };
    mockWalletClient = {
      charge: jest.fn().mockResolvedValue({
        status: 'COMPLETED',
        transactionId: 'wallet-tx-1',
        amount: '100000',
      }),
      hold: jest.fn().mockResolvedValue({
        status: 'COMPLETED',
        transactionId: 'wallet-hold-tx-1',
        holdId: 'wallet-hold-1',
        amount: '100000',
      }),
      release: jest.fn().mockResolvedValue({
        status: 'RELEASED',
        transactionId: 'wallet-release-1',
      }),
      forfeit: jest.fn().mockResolvedValue({
        status: 'FORFEITED',
        transactionId: 'wallet-forfeit-1',
      }),
    };
    mockAwardService = { createForWinner: jest.fn() };

    service = new AuctionService(
      mockAuctionRepo,
      mockBidModel,
      mockWalletClient,
      mockEventsService,
      mockAwardService,
    );
  });

  const validCreateDto = () => ({
    title: 'Cargo HCM - Dong Nai',
    goodsType: 'Electronics',
    weight: 5,
    volume: 20,
    goodsValue: '100000000',
    vehicleTypeRequired: 'TRUCK_MEDIUM',
    pickupLocation: {
      locationName: 'Warehouse A',
      province: 'Ho Chi Minh City',
      address: '12 Nguyen Hue',
    },
    deliveryLocation: {
      locationName: 'Warehouse B',
      province: 'Dong Nai',
      address: 'Bien Hoa Industrial Park',
    },
    auctionType: AuctionType.PUBLIC,
    maxPrice: '12000000',
    priceStep: '100000',
    participationFeeTier: 'LEVEL_3',
    maxBids: 5,
    images: ['https://cdn.example.test/cargo.jpg'],
    notes: 'Handle with care',
    isDepositRequired: true,
    depositAmount: '1000000',
    registrationStartTime: new Date(Date.now() + 60_000),
    registrationEndTime: new Date(Date.now() + 120_000),
    startTime: new Date(Date.now() + 180_000),
    endTime: new Date(Date.now() + 600_000),
  });

  it('creates a pending auction after charging the creation fee', async () => {
    const createdAuction: any = {
      ...validCreateDto(),
      _id: 'auction-created-1',
      shipperId: 'shipper-1',
      origin: 'Ho Chi Minh City - Warehouse A',
      destination: 'Dong Nai - Warehouse B',
      maxPrice: { toString: () => '12000000.00' },
      priceStep: { toString: () => '100000.00' },
      goodsValue: { toString: () => '100000000.00' },
      depositAmount: { toString: () => '1000000.00' },
      participationFeeAmount: { toString: () => '50000' },
      creationFeeTier: 'LEVEL_2',
      creationFeeAmount: { toString: () => '100000' },
      status: AuctionStatus.PENDING,
      creationFeeStatus: 'HELD',
      creationFeeHoldId: 'wallet-hold-1',
      creationFeeTransactionId: null,
      images: ['https://cdn.example.test/cargo.jpg'],
      winningBidId: null,
      fraudFlag: false,
      fraudReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      save: jest.fn().mockResolvedValue(true),
    };
    mockAuctionRepo.create.mockResolvedValue(createdAuction);

    const result = await service.create('shipper-1', validCreateDto() as any);

    expect(mockWalletClient.hold).toHaveBeenCalledWith(
      'shipper-1',
      expect.objectContaining({
        auctionId: expect.any(String),
        purpose: 'AUCTION_CREATION_FEE',
        idempotencyKey: expect.stringContaining('auction_creation_fee_'),
      }),
    );
    expect(mockWalletClient.forfeit).toHaveBeenCalledWith(
      'wallet-hold-1',
      expect.stringContaining('auction_creation_fee_'),
    );
    expect(mockAuctionRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        shipperId: 'shipper-1',
        status: AuctionStatus.PENDING,
        images: ['https://cdn.example.test/cargo.jpg'],
      }),
    );
    expect(result.id).toBe('auction-created-1');
    expect(result.status).toBe(AuctionStatus.PENDING);
  });

  it('rejects an invalid schedule before charging the creation fee', async () => {
    const dto = validCreateDto();
    dto.registrationEndTime = new Date(Date.now() + 300_000);
    dto.startTime = new Date(Date.now() + 180_000);

    await expect(service.create('shipper-1', dto as any)).rejects.toThrow(
      'Auction time order must be registrationEndTime <= startTime < endTime',
    );

    expect(mockWalletClient.charge).not.toHaveBeenCalled();
    expect(mockAuctionRepo.create).not.toHaveBeenCalled();
  });

  it('does not create an auction when the wallet charge fails', async () => {
    mockWalletClient.hold.mockRejectedValue(new Error('Insufficient balance'));

    await expect(
      service.create('shipper-1', validCreateDto() as any),
    ).rejects.toThrow('Insufficient balance');

    expect(mockAuctionRepo.create).not.toHaveBeenCalled();
  });

  it('returns a clear service error when the wallet hold response is incomplete', async () => {
    mockWalletClient.hold.mockResolvedValue({
      status: 'COMPLETED',
      transactionId: 'wallet-hold-tx-1',
      amount: '100000',
    });

    await expect(
      service.create('shipper-1', validCreateDto() as any),
    ).rejects.toThrow('Wallet service did not return a valid creation fee hold');

    expect(mockAuctionRepo.create).not.toHaveBeenCalled();
  });

  it('releases the creation fee hold when auction persistence fails', async () => {
    mockAuctionRepo.create.mockRejectedValue(new Error('Database unavailable'));

    await expect(
      service.create('shipper-1', validCreateDto() as any),
    ).rejects.toThrow('Database unavailable');

    expect(mockWalletClient.release).toHaveBeenCalledWith(
      'wallet-hold-1',
      expect.stringContaining('auction_creation_fee_'),
    );
    expect(mockWalletClient.forfeit).not.toHaveBeenCalled();
  });

  it('returns the existing auction for a repeated creation idempotency key', async () => {
    const createdAuction: any = {
      ...validCreateDto(),
      _id: 'auction-idempotent-1',
      shipperId: 'shipper-1',
      origin: 'Ho Chi Minh City - Warehouse A',
      destination: 'Dong Nai - Warehouse B',
      maxPrice: { toString: () => '12000000.00' },
      priceStep: { toString: () => '100000.00' },
      goodsValue: { toString: () => '100000000.00' },
      depositAmount: { toString: () => '1000000.00' },
      participationFeeAmount: { toString: () => '50000' },
      creationFeeTier: 'LEVEL_2',
      creationFeeAmount: { toString: () => '100000' },
      status: AuctionStatus.PENDING,
      creationFeeStatus: 'HELD',
      creationFeeHoldId: 'wallet-hold-1',
      creationFeeTransactionId: null,
      images: [],
      winningBidId: null,
      fraudFlag: false,
      fraudReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      save: jest.fn().mockResolvedValue(true),
    };
    mockAuctionRepo.create.mockResolvedValue(createdAuction);
    mockAuctionRepo.findByIdempotencyKey
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(createdAuction);

    const firstResult = await service.create(
      'shipper-1',
      validCreateDto() as any,
      'create-request-1',
    );
    const secondResult = await service.create(
      'shipper-1',
      validCreateDto() as any,
      'create-request-1',
    );

    expect(secondResult.id).toBe(firstResult.id);
    expect(mockAuctionRepo.create).toHaveBeenCalledTimes(1);
    expect(mockWalletClient.hold).toHaveBeenCalledTimes(1);
    expect(mockWalletClient.forfeit).toHaveBeenCalledTimes(1);
  });

  it('marks a persisted auction for reconciliation when fee settlement fails', async () => {
    const createdAuction: any = {
      ...validCreateDto(),
      _id: 'auction-reconcile-1',
      shipperId: 'shipper-1',
      origin: 'Ho Chi Minh City - Warehouse A',
      destination: 'Dong Nai - Warehouse B',
      maxPrice: { toString: () => '12000000.00' },
      priceStep: { toString: () => '100000.00' },
      goodsValue: { toString: () => '100000000.00' },
      depositAmount: { toString: () => '1000000.00' },
      participationFeeAmount: { toString: () => '50000' },
      creationFeeTier: 'LEVEL_2',
      creationFeeAmount: { toString: () => '100000' },
      status: AuctionStatus.PENDING,
      creationFeeStatus: 'HELD',
      creationFeeHoldId: 'wallet-hold-1',
      creationFeeTransactionId: null,
      images: [],
      winningBidId: null,
      fraudFlag: false,
      fraudReason: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      save: jest.fn().mockResolvedValue(true),
    };
    mockAuctionRepo.create.mockResolvedValue(createdAuction);
    mockWalletClient.forfeit.mockRejectedValue(new Error('Wallet unavailable'));

    await expect(
      service.create('shipper-1', validCreateDto() as any, 'create-request-2'),
    ).rejects.toThrow('Wallet unavailable');

    expect(createdAuction.creationFeeStatus).toBe('RECONCILIATION_REQUIRED');
    expect(createdAuction.creationFeeHoldId).toBe('wallet-hold-1');
    expect(createdAuction.save).toHaveBeenCalled();
  });

  it('should flag auction for fraud with reason', async () => {
    const mockAuction: any = {
      _id: 'auction-1',
      shipperId: 'shipper-1',
      title: 'Chuyến hàng HN-SG',
      goodsType: 'Hàng khô',
      weight: 10,
      vehicleTypeRequired: 'TRUCK_HEAVY',
      maxPrice: { toString: () => '15000000' },
      participationFeeTier: 'TIER_1',
      participationFeeAmount: { toString: () => '100000' },
      registrationEndTime: new Date(),
      startTime: new Date(),
      endTime: new Date(),
      status: AuctionStatus.OPEN,
      save: jest.fn().mockResolvedValue(true),
    };

    mockAuctionRepo.findById.mockResolvedValue(mockAuction);

    const result = await service.flag('auction-1', {
      reason: 'Nghi vấn thông thầu giữa 2 tài xế',
    });

    expect(mockAuction.fraudFlag).toBe(true);
    expect(mockAuction.fraudReason).toBe('Nghi vấn thông thầu giữa 2 tài xế');
    expect(mockAuction.save).toHaveBeenCalled();
    expect(result.fraudFlag).toBe(true);
    expect(result.fraudReason).toBe('Nghi vấn thông thầu giữa 2 tài xế');
  });

  it('lets the shipper select a winner for a completed sealed auction', async () => {
    const mockAuction: any = {
      _id: 'auction-sealed',
      shipperId: 'shipper-1',
      auctionType: AuctionType.SEALED,
      status: AuctionStatus.COMPLETED,
      maxPrice: { toString: () => '10000000' },
      priceStep: { toString: () => '100000' },
      participationFeeAmount: { toString: () => '20000' },
      winningBidId: null,
      save: jest.fn().mockResolvedValue(true),
    };
    const winningBid = {
      _id: 'bid-2',
      bidAmount: { toString: () => '8000000' },
    };
    mockAuctionRepo.findById.mockResolvedValue(mockAuction);
    mockBidModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(winningBid),
    });

    const result = await service.selectWinner(
      'auction-sealed',
      'bid-2',
      'shipper-1',
      'SHIPPER',
    );

    expect(mockBidModel.findOne).toHaveBeenCalledWith({
      _id: 'bid-2',
      auctionId: 'auction-sealed',
    });
    expect(mockAuction.winningBidId).toBe('bid-2');
    expect(mockAuction.save).toHaveBeenCalled();
    expect(result.winningBidId).toBe('bid-2');
  });

  it('backfills creation fees before synchronizing a legacy auction', async () => {
    const mockAuction: any = {
      _id: 'auction-legacy',
      shipperId: 'shipper-1',
      title: 'Legacy auction',
      goodsType: 'General goods',
      weight: 10,
      vehicleTypeRequired: 'TRUCK_MEDIUM',
      origin: 'Hanoi',
      destination: 'Da Nang',
      maxPrice: { toString: () => '12000000' },
      priceStep: { toString: () => '100000' },
      participationFeeAmount: { toString: () => '50000' },
      registrationStartTime: new Date(Date.now() - 20_000),
      registrationEndTime: new Date(Date.now() - 10_000),
      startTime: new Date(Date.now() - 5_000),
      endTime: new Date(Date.now() + 60_000),
      status: AuctionStatus.PENDING,
      save: jest.fn().mockResolvedValue(true),
    };

    mockAuctionRepo.findById.mockResolvedValue(mockAuction);

    const result = await service.findById('auction-legacy');

    expect(mockAuction.creationFeeTier).toBe('LEVEL_2');
    expect(mockAuction.creationFeeAmount.toString()).toBe('100000');
    expect(mockAuction.save).toHaveBeenCalled();
    expect(result.creationFeeTier).toBe('LEVEL_2');
    expect(result.creationFeeAmount).toBe('100000');
  });

  it('rejects update when reducing maxPrice below existing required deposit', async () => {
    const now = Date.now();
    const pendingAuction: any = {
      _id: 'auction-update-1',
      shipperId: 'shipper-1',
      status: AuctionStatus.PENDING,
      registrationStartTime: new Date(now - 5_000),
      registrationEndTime: new Date(now + 60_000),
      startTime: new Date(now + 120_000),
      endTime: new Date(now + 600_000),
      maxPrice: { toString: () => '5000000.00' },
      priceStep: { toString: () => '100000.00' },
      isDepositRequired: true,
      depositAmount: { toString: () => '2000000.00' },
      participationFeeAmount: { toString: () => '20000' },
      creationFeeTier: 'LEVEL_1',
      creationFeeAmount: { toString: () => '50000' },
      save: jest.fn().mockResolvedValue(true),
    };
    mockAuctionRepo.findById.mockResolvedValue(pendingAuction);

    await expect(
      service.update('auction-update-1', 'shipper-1', 'SHIPPER', {
        maxPrice: '1000000',
      } as any),
    ).rejects.toThrow('depositAmount cannot exceed maxPrice');

    expect(mockAuctionRepo.updateById).not.toHaveBeenCalled();
  });

  it('stores cancellation reason when shipper cancels an auction', async () => {
    const now = Date.now();
    const cancellableAuction: any = {
      _id: 'auction-cancel-1',
      shipperId: 'shipper-1',
      status: AuctionStatus.OPEN,
      registrationStartTime: new Date(now - 300_000),
      registrationEndTime: new Date(now - 240_000),
      startTime: new Date(now - 180_000),
      endTime: new Date(now + 180_000),
      title: 'Auction to cancel',
      goodsType: 'General goods',
      weight: 3,
      vehicleTypeRequired: 'TRUCK_SMALL',
      origin: 'A',
      destination: 'B',
      maxPrice: { toString: () => '3000000.00' },
      priceStep: { toString: () => '50000.00' },
      participationFeeTier: 'LEVEL_2',
      participationFeeAmount: { toString: () => '20000' },
      creationFeeTier: 'LEVEL_1',
      creationFeeAmount: { toString: () => '50000' },
      isDepositRequired: false,
      images: [],
      notes: null,
      winningBidId: null,
      cancellationReason: null,
      fraudFlag: false,
      fraudReason: null,
      save: jest.fn().mockResolvedValue(true),
      createdAt: new Date(now - 600_000),
      updatedAt: new Date(now),
    };
    mockAuctionRepo.findById.mockResolvedValue(cancellableAuction);

    const result = await service.cancel(
      'auction-cancel-1',
      'shipper-1',
      'SHIPPER',
      'Đổi kế hoạch giao nhận',
    );

    expect(cancellableAuction.status).toBe(AuctionStatus.CANCELLED);
    expect(cancellableAuction.cancellationReason).toBe('Đổi kế hoạch giao nhận');
    expect(cancellableAuction.save).toHaveBeenCalled();
    expect(result.cancellationReason).toBe('Đổi kế hoạch giao nhận');
  });
});
