import { AuctionRegistrationService } from './auction-registration.service';
import { DepositStatus } from '../../common/enums/deposit-status.enum';
import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { ParticipationFeeStatus } from '../../common/enums/participation-fee-status.enum';
import { RegistrationPaymentStatus } from '../../common/enums/registration-payment-status.enum';
import { RegistrationStatus } from '../../common/enums/registration-status.enum';

describe('AuctionRegistrationService (Release Loser Deposits)', () => {
  let service: AuctionRegistrationService;
  let mockRegistrationModel: any;
  let mockAuctionService: any;
  let mockWalletClient: any;
  let mockReputationClient: any;

  beforeEach(() => {
    mockRegistrationModel = {
      findOne: jest.fn(),
      find: jest.fn(),
      countDocuments: jest.fn(),
      create: jest.fn(),
    };
    mockAuctionService = {
      findById: jest.fn(),
    };
    mockWalletClient = {
      lockDeposit: jest.fn(),
      payFee: jest.fn(),
      release: jest.fn(),
    };
    mockReputationClient = { getScore: jest.fn().mockResolvedValue(100) };

    service = new AuctionRegistrationService(
      mockRegistrationModel,
      mockAuctionService,
      mockWalletClient,
      mockReputationClient,
    );
  });

  it('should refund deposits for losing carriers when auction completes', async () => {
    const regLoser1 = {
      _id: 'reg-1',
      carrierId: 'carrier-loser-1',
      depositHoldId: 'hold-123',
      depositStatus: DepositStatus.LOCKED,
      save: jest.fn().mockResolvedValue(true),
    };
    const regLoser2 = {
      _id: 'reg-2',
      carrierId: 'carrier-loser-2',
      depositHoldId: 'hold-456',
      depositStatus: DepositStatus.LOCKED,
      save: jest.fn().mockResolvedValue(true),
    };

    mockRegistrationModel.find.mockReturnValue({
      exec: jest.fn().mockResolvedValue([regLoser1, regLoser2]),
    });

    mockWalletClient.release.mockResolvedValue({ status: 'RELEASED' });

    const result = await service.releaseLoserDeposits(
      'auction-1',
      'carrier-winner',
    );

    expect(mockRegistrationModel.find).toHaveBeenCalledWith({
      auctionId: 'auction-1',
      depositStatus: DepositStatus.LOCKED,
      carrierId: { $ne: 'carrier-winner' },
    });

    expect(mockWalletClient.release).toHaveBeenCalledTimes(2);
    expect(regLoser1.depositStatus).toBe(DepositStatus.REFUNDED);
    expect(regLoser2.depositStatus).toBe(DepositStatus.REFUNDED);
    expect(result.releasedCount).toBe(2);
    expect(result.totalEligible).toBe(2);
  });

  it('lists the authenticated carrier registrations with auction access', async () => {
    const registration = {
      _id: 'registration-1',
      auctionId: 'auction-1',
      carrierId: 'carrier-1',
      vehicleId: 'vehicle-1',
      status: RegistrationStatus.REGISTERED,
      paymentStatus: RegistrationPaymentStatus.COMPLETED,
      depositStatus: DepositStatus.NOT_REQUIRED,
      participationFeeStatus: ParticipationFeeStatus.PAID,
      participationFeeAmount: { toString: () => '20000.00' },
      depositAmount: null,
      depositHoldId: null,
      participationFeeTransactionId: 'fee-1',
      paymentErrorCode: null,
      registeredAt: new Date('2026-08-14T08:00:00.000Z'),
      createdAt: new Date('2026-08-14T08:00:00.000Z'),
      updatedAt: new Date('2026-08-14T08:00:00.000Z'),
    };
    const query = {
      page: 2,
      pageSize: 10,
    };
    const auction = {
      id: 'auction-1',
      status: AuctionStatus.OPEN,
      registrationOpen: false,
      startTime: new Date(Date.now() - 60_000),
      endTime: new Date(Date.now() + 60_000),
    };
    const chain = {
      sort: jest.fn().mockReturnThis(),
      skip: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([registration]),
    };

    mockRegistrationModel.find.mockReturnValue(chain);
    mockRegistrationModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(registration),
    });
    mockRegistrationModel.countDocuments.mockReturnValue({
      exec: jest.fn().mockResolvedValue(11),
    });
    mockAuctionService.findById.mockResolvedValue(auction);

    const result = await service.listMine('carrier-1', query);

    expect(mockRegistrationModel.find).toHaveBeenCalledWith({
      carrierId: 'carrier-1',
    });
    expect(chain.skip).toHaveBeenCalledWith(10);
    expect(chain.limit).toHaveBeenCalledWith(10);
    expect(mockRegistrationModel.countDocuments).toHaveBeenCalledWith({
      carrierId: 'carrier-1',
    });
    expect(result.data).toHaveLength(1);
    expect(result.data[0].registration.id).toBe('registration-1');
    expect(result.data[0].auction).toBe(auction);
    expect(result.data[0].access.canEnter).toBe(true);
    expect(result.pagination).toEqual({
      page: 2,
      pageSize: 10,
      totalItems: 11,
      totalPages: 2,
    });
  });

  it('does not reopen an auction room after the carrier cancels registration', async () => {
    const registration = {
      _id: 'registration-cancelled',
      auctionId: 'auction-1',
      carrierId: 'carrier-1',
      status: RegistrationStatus.CANCELLED,
      paymentStatus: RegistrationPaymentStatus.COMPLETED,
    };
    mockRegistrationModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(registration),
    });
    mockAuctionService.findById.mockResolvedValue({
      status: AuctionStatus.OPEN,
      registrationOpen: false,
      startTime: new Date(Date.now() - 60_000),
      endTime: new Date(Date.now() + 60_000),
    });

    await expect(service.getAccess('auction-1', 'carrier-1')).resolves.toMatchObject({
      canEnter: false,
      accessStatus: 'REGISTRATION_CANCELLED',
    });
  });
});
