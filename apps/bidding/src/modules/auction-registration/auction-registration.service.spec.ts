import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { DepositStatus } from '../../common/enums/deposit-status.enum';
import { ParticipationFeeStatus } from '../../common/enums/participation-fee-status.enum';
import { RegistrationPaymentStatus } from '../../common/enums/registration-payment-status.enum';
import { RegistrationStatus } from '../../common/enums/registration-status.enum';
import { BiddingSagaService } from '../auction/bidding-saga.service';
import { AuctionRegistrationService } from './auction-registration.service';

describe('AuctionRegistrationService registration window & fee compensation', () => {
  it('blocks register() before registrationStartTime even if registrationOpen flag is stale/true', async () => {
    const now = Date.now();
    const auctionService = {
      findById: jest.fn().mockResolvedValue({
        id: 'auc-preopen-1',
        status: AuctionStatus.PENDING,
        registrationStartTime: new Date(now + 30 * 60_000),
        registrationEndTime: new Date(now + 90 * 60_000),
        startTime: new Date(now + 120 * 60_000),
        endTime: new Date(now + 180 * 60_000),
        registrationOpen: true,
        isDepositRequired: false,
        depositAmount: null,
        participationFeeAmount: '50000',
        requireCarrierCoverage: false,
      }),
    };
    const walletClient = {
      hold: jest.fn(),
      charge: jest.fn(),
      refund: jest.fn(),
    };
    const registrationModel = { findOne: jest.fn(), create: jest.fn() };

    const service = new AuctionRegistrationService(
      registrationModel as any,
      auctionService as any,
      walletClient as any,
      { getScore: jest.fn().mockResolvedValue(95) } as any,
      { assertVerifiedVehicle: jest.fn().mockResolvedValue(undefined) } as any,
      { assertVerified: jest.fn().mockResolvedValue(undefined) } as any,
      { assertEligible: jest.fn().mockResolvedValue(undefined) } as any,
    );

    await expect(
      service.register('auc-preopen-1', 'carrier-1', {
        vehicleId: 'veh-1',
        idempotencyKey: 'idem-preopen-1',
      }),
    ).rejects.toThrow(ConflictException);

    expect(walletClient.hold).not.toHaveBeenCalled();
    expect(walletClient.charge).not.toHaveBeenCalled();
    expect(registrationModel.create).not.toHaveBeenCalled();
  });

  it('refunds participation fee immediately when saving registration fails after wallet charge succeeds', async () => {
    let saveCalls = 0;
    const registrationDoc = {
      _id: 'reg-fee-fail-1',
      auctionId: 'auc-1',
      carrierId: 'carrier-1',
      vehicleId: 'veh-1',
      status: RegistrationStatus.REGISTERED,
      paymentStatus: RegistrationPaymentStatus.PENDING,
      depositStatus: DepositStatus.NOT_REQUIRED,
      participationFeeStatus: ParticipationFeeStatus.PENDING,
      participationFeeAmount: '50000',
      depositHoldId: null,
      participationFeeTransactionId: null as string | null,
      paymentErrorCode: null as string | null,
      paymentAttempt: 0,
      save: jest.fn().mockImplementation(() => {
        saveCalls += 1;
        // 1st save right after wallet.charge fails; 2nd save inside markFailed succeeds
        if (saveCalls === 1) {
          return Promise.reject(new Error('Mongo write timeout'));
        }
        return Promise.resolve(undefined);
      }),
    };

    const registrationModel = {
      findOne: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      create: jest.fn().mockResolvedValue(registrationDoc),
    };
    const now = Date.now();
    const auctionService = {
      findById: jest.fn().mockResolvedValue({
        id: 'auc-1',
        status: AuctionStatus.PENDING,
        registrationStartTime: new Date(now - 60_000),
        registrationEndTime: new Date(now + 3600_000),
        startTime: new Date(now + 7200_000),
        endTime: new Date(now + 10800_000),
        registrationOpen: true,
        isDepositRequired: false,
        depositAmount: null,
        participationFeeAmount: '50000',
        requireCarrierCoverage: false,
      }),
    };
    const walletClient = {
      charge: jest.fn().mockResolvedValue({
        status: 'SUCCESS',
        transactionId: 'tx-fee-1',
        amount: '50000',
      }),
      refund: jest.fn().mockResolvedValue({
        status: 'SUCCESS',
        transactionId: 'tx-fee-refund-1',
        amount: '50000',
      }),
    };

    const service = new AuctionRegistrationService(
      registrationModel as any,
      auctionService as any,
      walletClient as any,
      { getScore: jest.fn().mockResolvedValue(95) } as any,
      { assertVerifiedVehicle: jest.fn().mockResolvedValue(undefined) } as any,
      { assertVerified: jest.fn().mockResolvedValue(undefined) } as any,
      { assertEligible: jest.fn().mockResolvedValue(undefined) } as any,
    );

    await expect(
      service.register('auc-1', 'carrier-1', {
        vehicleId: 'veh-1',
        idempotencyKey: 'idem-fee-1',
      }),
    ).rejects.toThrow('Mongo write timeout');

    expect(walletClient.refund).toHaveBeenCalledWith(
      'carrier-1',
      expect.objectContaining({
        auctionId: 'auc-1',
        registrationId: 'reg-fee-fail-1',
        amount: '50000',
        purpose: 'AUCTION_PARTICIPATION_FEE_REFUND',
      }),
    );
    expect(registrationDoc.paymentStatus).toBe(
      RegistrationPaymentStatus.FAILED,
    );
    expect(registrationDoc.participationFeeStatus).toBe(
      ParticipationFeeStatus.COMPENSATED,
    );
  });

  it('keeps PAID (not fake COMPENSATED) when immediate refund fails, avoids double-charge on retry, and lets saga sweeper refund it', async () => {
    let saveCalls = 0;
    const registrationDoc = {
      _id: 'reg-fee-stuck-1',
      auctionId: 'auc-1',
      carrierId: 'carrier-1',
      vehicleId: 'veh-1',
      status: RegistrationStatus.REGISTERED,
      paymentStatus: RegistrationPaymentStatus.PENDING,
      depositStatus: DepositStatus.NOT_REQUIRED,
      participationFeeStatus: ParticipationFeeStatus.PENDING,
      participationFeeAmount: '50000',
      depositHoldId: null,
      participationFeeTransactionId: null as string | null,
      paymentErrorCode: null as string | null,
      paymentAttempt: 0,
      save: jest.fn().mockImplementation(() => {
        saveCalls += 1;
        if (saveCalls === 1) {
          return Promise.reject(new Error('DB transient error'));
        }
        return Promise.resolve(undefined);
      }),
    };

    const registrationModel = {
      findOne: jest
        .fn()
        .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      create: jest.fn().mockResolvedValue(registrationDoc),
    };
    const now = Date.now();
    const auctionService = {
      findById: jest.fn().mockResolvedValue({
        id: 'auc-1',
        status: AuctionStatus.PENDING,
        registrationStartTime: new Date(now - 60_000),
        registrationEndTime: new Date(now + 3600_000),
        startTime: new Date(now + 7200_000),
        endTime: new Date(now + 10800_000),
        registrationOpen: true,
        isDepositRequired: false,
        depositAmount: null,
        participationFeeAmount: '50000',
        requireCarrierCoverage: false,
      }),
    };
    const walletClient = {
      charge: jest.fn().mockResolvedValue({
        status: 'SUCCESS',
        transactionId: 'tx-fee-stuck-1',
        amount: '50000',
      }),
      refund: jest
        .fn()
        .mockRejectedValue(new ServiceUnavailableException('Wallet down')),
    };

    const service = new AuctionRegistrationService(
      registrationModel as any,
      auctionService as any,
      walletClient as any,
      { getScore: jest.fn().mockResolvedValue(95) } as any,
      { assertVerifiedVehicle: jest.fn().mockResolvedValue(undefined) } as any,
      { assertVerified: jest.fn().mockResolvedValue(undefined) } as any,
      { assertEligible: jest.fn().mockResolvedValue(undefined) } as any,
    );

    await expect(
      service.register('auc-1', 'carrier-1', {
        vehicleId: 'veh-1',
        idempotencyKey: 'idem-stuck-1',
      }),
    ).rejects.toThrow('DB transient error');

    expect(registrationDoc.paymentStatus).toBe(
      RegistrationPaymentStatus.FAILED,
    );
    expect(registrationDoc.participationFeeStatus).toBe(
      ParticipationFeeStatus.PAID,
    );
    expect(registrationDoc.paymentErrorCode).toBe(
      'PARTICIPATION_FEE_COMPENSATION_PENDING',
    );

    // Retrying before background refund completes must NOT charge the participation fee a second time
    registrationModel.findOne.mockReturnValue({
      exec: jest.fn().mockResolvedValue(registrationDoc),
    });
    walletClient.charge.mockClear();
    const retried = await service.retryPayment(
      'auc-1',
      'reg-fee-stuck-1',
      'carrier-1',
      { idempotencyKey: 'retry-1' },
    );
    expect(walletClient.charge).not.toHaveBeenCalled();
    expect(retried.paymentStatus).toBe(RegistrationPaymentStatus.COMPLETED);

    // And if stuck in FAILED+PAID without retry, background sweeper refunds it and marks COMPENSATED
    const stuckForSweeper = {
      _id: 'reg-fee-sweep-1',
      auctionId: 'auc-1',
      carrierId: 'carrier-1',
      paymentStatus: RegistrationPaymentStatus.FAILED,
      participationFeeStatus: ParticipationFeeStatus.PAID,
      participationFeeAmount: '50000',
      participationFeeTransactionId: 'tx-fee-sweep-1',
      paymentErrorCode: 'PARTICIPATION_FEE_COMPENSATION_PENDING',
      paymentAttempt: 0,
      save: jest.fn().mockResolvedValue(undefined),
    };
    const sagaRegModel = {
      find: jest.fn().mockReturnValue({
        sort: jest.fn().mockReturnValue({
          limit: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue([stuckForSweeper]),
          }),
        }),
      }),
    };
    const sagaWallet = {
      refund: jest.fn().mockResolvedValue({
        status: 'SUCCESS',
        transactionId: 'tx-sweep-refund-1',
        amount: '50000',
      }),
    };
    const sagaService = new BiddingSagaService(
      {} as any,
      {} as any,
      sagaRegModel as any,
      sagaWallet as any,
    );

    await sagaService.reconcileStuckRegistrationFees();

    expect(sagaWallet.refund).toHaveBeenCalledWith(
      'carrier-1',
      expect.objectContaining({
        auctionId: 'auc-1',
        registrationId: 'reg-fee-sweep-1',
        amount: '50000',
        purpose: 'AUCTION_PARTICIPATION_FEE_REFUND',
      }),
    );
    expect(stuckForSweeper.participationFeeStatus).toBe(
      ParticipationFeeStatus.COMPENSATED,
    );
    expect(stuckForSweeper.paymentErrorCode).toBe(
      'PARTICIPATION_FEE_COMPENSATED',
    );
  });

  it('preserves terminal auction states even when carrier reputation dropped below threshold', async () => {
    const now = Date.now();
    const completedAuction = {
      id: 'auc-done-1',
      status: AuctionStatus.COMPLETED,
      startTime: new Date(now - 7200_000),
      endTime: new Date(now - 3600_000),
      registrationEndTime: new Date(now - 10800_000),
      registrationOpen: false,
      requireCarrierCoverage: false,
    };
    const cancelledAuction = {
      id: 'auc-cancel-1',
      status: AuctionStatus.CANCELLED,
      startTime: new Date(now + 3600_000),
      endTime: new Date(now + 7200_000),
      registrationEndTime: new Date(now + 1800_000),
      registrationOpen: false,
      requireCarrierCoverage: false,
    };
    const openAuction = {
      id: 'auc-open-1',
      status: AuctionStatus.OPEN,
      startTime: new Date(now - 600_000),
      endTime: new Date(now + 3600_000),
      registrationEndTime: new Date(now - 1800_000),
      registrationOpen: false,
      requireCarrierCoverage: false,
    };

    const auctionService = {
      findById: jest.fn().mockImplementation((id: string) =>
        Promise.resolve(
          id === 'auc-done-1'
            ? completedAuction
            : id === 'auc-cancel-1'
              ? cancelledAuction
              : openAuction,
        ),
      ),
    };
    const registrationModel = {
      findOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue({
          _id: 'reg-1',
          status: RegistrationStatus.REGISTERED,
          paymentStatus: RegistrationPaymentStatus.COMPLETED,
        }),
      }),
    };
    const service = new AuctionRegistrationService(
      registrationModel as any,
      auctionService as any,
      {} as any,
      { getScore: jest.fn().mockResolvedValue(55) } as any,
      { assertVerifiedVehicle: jest.fn() } as any,
      { getStatus: jest.fn().mockResolvedValue({ ekycVerified: true, businessVerified: true, fullyVerified: true }) } as any,
      { isEligible: jest.fn().mockResolvedValue(true) } as any,
    );

    const doneAccess = await service.getAccess('auc-done-1', 'carrier-1');
    const cancelledAccess = await service.getAccess('auc-cancel-1', 'carrier-1');
    const openAccess = await service.getAccess('auc-open-1', 'carrier-1');

    expect(doneAccess.accessStatus).toBe('AUCTION_COMPLETED');
    expect(cancelledAccess.accessStatus).toBe('AUCTION_CANCELLED');
    expect(openAccess.accessStatus).toBe('REPUTATION_TOO_LOW');
    expect(openAccess.canEnter).toBe(false);
  });
});
