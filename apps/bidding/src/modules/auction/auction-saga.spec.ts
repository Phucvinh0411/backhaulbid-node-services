import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuctionService } from './auction.service';
import { AuctionAwardService } from './auction-award.service';
import {
  BiddingSagaService,
  MAX_SETTLEMENT_RETRIES,
} from './bidding-saga.service';
import { ContractAwardConsumer } from './contract-award.consumer';
import { AuctionRegistrationService } from '../auction-registration/auction-registration.service';
import { CreationFeeStatus } from '../../common/enums/creation-fee-status.enum';
import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { DepositStatus } from '../../common/enums/deposit-status.enum';
import { ParticipationFeeStatus } from '../../common/enums/participation-fee-status.enum';
import { RegistrationPaymentStatus } from '../../common/enums/registration-payment-status.enum';
import { RegistrationStatus } from '../../common/enums/registration-status.enum';
import {
  WalletClient,
  WalletClientError,
} from '../../integrations/wallet/wallet.client';
import { AuctionAwardAttemptStatus } from './schemas/auction.schema';

function makeCreateAuctionDto() {
  const now = Date.now();
  return {
    title: 'Vận chuyển nông sản TP.HCM - Đà Nẵng',
    goodsType: 'Nông sản khô',
    weight: 8,
    vehicleTypeRequired: 'TRUCK_MEDIUM',
    pickupLocation: {
      locationName: 'Kho Thủ Đức',
      address: 'Thủ Đức, TP.HCM',
      province: 'TP. Hồ Chí Minh',
      latitude: 10.849,
      longitude: 106.771,
      coordinateConfirmedAt: new Date(now).toISOString(),
      earliestTime: new Date(now + 48 * 3600_000).toISOString(),
      latestTime: new Date(now + 72 * 3600_000).toISOString(),
    },
    deliveryLocation: {
      locationName: 'Kho Hòa Vang',
      address: 'Hòa Vang, Đà Nẵng',
      province: 'Đà Nẵng',
      latitude: 16.047,
      longitude: 108.206,
      coordinateConfirmedAt: new Date(now).toISOString(),
      earliestTime: new Date(now + 72 * 3600_000).toISOString(),
      latestTime: new Date(now + 96 * 3600_000).toISOString(),
    },
    maxPrice: '9000000',
    priceStep: '100000',
    auctionType: 'PUBLIC',
    isDepositRequired: false,
    registrationEndTime: new Date(now + 4 * 3600_000),
    startTime: new Date(now + 5 * 3600_000),
    endTime: new Date(now + 8 * 3600_000),
  } as any;
}

describe('Bidding Distributed Saga Recovery & Event Coordination', () => {
  describe('BiddingSagaService.reconcileOrphanedCreationHolds', () => {
    it('atomically claims HOLDING saga and compensates via releaseByHoldKey when auction was never persisted', async () => {
      const sagaDoc = {
        _id: 'auction_creation_fee_orphan-1',
        auctionId: 'orphan-1',
        shipperId: 'shipper-1',
        holdId: null,
        status: 'COMPENSATING',
        completedAt: null as Date | null,
        save: jest.fn().mockResolvedValue(undefined),
      };
      const holdSagaModel = {
        findOneAndUpdate: jest
          .fn()
          .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(sagaDoc) })
          .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      };
      const auctionModel = {
        findById: jest
          .fn()
          .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      };
      const walletClient = {
        releaseByHoldKey: jest.fn().mockResolvedValue({
          status: 'SUCCESS',
          transactionId: 'tx-unfreeze-1',
          amount: '50000.00',
        }),
        release: jest.fn(),
        forfeit: jest.fn(),
      };

      const sagaService = new BiddingSagaService(
        auctionModel as any,
        holdSagaModel as any,
        {} as any,
        walletClient as any,
      );

      await sagaService.reconcileOrphanedCreationHolds();

      expect(walletClient.releaseByHoldKey).toHaveBeenCalledWith(
        'auction_creation_fee_orphan-1',
        'auction_creation_fee_orphan-1:saga-compensate',
      );
      expect(sagaDoc.status).toBe('COMPENSATED');
      expect(sagaDoc.completedAt).toBeInstanceOf(Date);
      expect(sagaDoc.save).toHaveBeenCalledTimes(1);
    });

    it('marks claimed saga COMMITTED with completedAt without releasing funds when auction already exists', async () => {
      const sagaDoc = {
        _id: 'auction_creation_fee_saved-1',
        auctionId: 'saved-1',
        shipperId: 'shipper-1',
        holdId: null,
        status: 'COMPENSATING',
        completedAt: null as Date | null,
        save: jest.fn().mockResolvedValue(undefined),
      };
      const holdSagaModel = {
        findOneAndUpdate: jest
          .fn()
          .mockReturnValueOnce({ exec: jest.fn().mockResolvedValue(sagaDoc) })
          .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
      };
      const auctionModel = {
        findById: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue({
            _id: 'saved-1',
            creationFeeHoldId: 'hold-999',
          }),
        }),
      };
      const walletClient = {
        releaseByHoldKey: jest.fn(),
        release: jest.fn(),
      };

      const sagaService = new BiddingSagaService(
        auctionModel as any,
        holdSagaModel as any,
        {} as any,
        walletClient as any,
      );

      await sagaService.reconcileOrphanedCreationHolds();

      expect(walletClient.releaseByHoldKey).not.toHaveBeenCalled();
      expect(walletClient.release).not.toHaveBeenCalled();
      expect(sagaDoc.status).toBe('COMMITTED');
      expect(sagaDoc.holdId).toBe('hold-999');
      expect(sagaDoc.completedAt).toBeInstanceOf(Date);
      expect(sagaDoc.save).toHaveBeenCalledTimes(1);
    });
  });

  describe('BiddingSagaService.reconcileUnsettledCreationFees', () => {
    it('forward-recovers unsettled creation fees stuck in RECONCILIATION_REQUIRED', async () => {
      const stuckAuction = {
        _id: 'auc-stuck-1',
        status: AuctionStatus.PENDING,
        creationFeeStatus: CreationFeeStatus.RECONCILIATION_REQUIRED,
        creationFeeHoldId: 'hold-stuck-1',
        creationFeeTransactionId: null,
        creationFeeRetryCount: 1,
        creationFeeLastAttemptAt: null as Date | null,
        save: jest.fn().mockResolvedValue(undefined),
      };
      const auctionModel = {
        find: jest.fn().mockReturnValue({
          sort: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
              exec: jest.fn().mockResolvedValue([stuckAuction]),
            }),
          }),
        }),
      };
      const walletClient = {
        forfeit: jest.fn().mockResolvedValue({
          status: 'SUCCESS',
          transactionId: 'tx-forfeit-1',
          amount: '50000.00',
        }),
      };

      const sagaService = new BiddingSagaService(
        auctionModel as any,
        {} as any,
        {} as any,
        walletClient as any,
      );

      await sagaService.reconcileUnsettledCreationFees();

      expect(walletClient.forfeit).toHaveBeenCalledWith(
        'hold-stuck-1',
        'auction_creation_fee_auc-stuck-1:forfeit',
      );
      expect(stuckAuction.creationFeeStatus).toBe(CreationFeeStatus.SETTLED);
      expect(stuckAuction.creationFeeTransactionId).toBe('tx-forfeit-1');
    });

    it('halts infinite retries immediately on permanent 4xx wallet error during settleCreationFee', async () => {
      const stuckAuction = {
        _id: 'auc-422-1',
        creationFeeStatus: CreationFeeStatus.HELD,
        creationFeeHoldId: 'hold-released-1',
        creationFeeRetryCount: 0,
        creationFeeLastAttemptAt: null as Date | null,
        save: jest.fn().mockResolvedValue(undefined),
      };
      const walletClient = {
        forfeit: jest
          .fn()
          .mockRejectedValue(
            new WalletClientError('Deposit hold has no remaining amount', 422),
          ),
      };
      const sagaService = new BiddingSagaService(
        {} as any,
        {} as any,
        {} as any,
        walletClient as any,
      );

      await expect(
        sagaService.settleCreationFee(stuckAuction as any),
      ).rejects.toThrow(WalletClientError);
      expect(stuckAuction.creationFeeStatus).toBe(
        CreationFeeStatus.RECONCILIATION_REQUIRED,
      );
      expect(stuckAuction.creationFeeRetryCount).toBe(MAX_SETTLEMENT_RETRIES);
      expect(stuckAuction.creationFeeLastAttemptAt).toBeInstanceOf(Date);
    });
  });

  describe('AuctionService.create & AuctionService.cancel Saga integration', () => {
    it('aborts auction creation before DB insert when saga was already claimed by sweeper (prevents free-auction race)', async () => {
      const auctionRepo = {
        findByIdempotencyKey: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      };
      const walletClient = {
        hold: jest.fn().mockResolvedValue({
          status: 'SUCCESS',
          transactionId: 'tx-hold-1',
          holdId: 'hold-1',
          amount: '50000.00',
        }),
      };
      const verificationClient = {
        assertVerified: jest.fn().mockResolvedValue(undefined),
      };
      const biddingSaga = {
        beginCreationFeeHold: jest.fn().mockResolvedValue(undefined),
        claimCreationFeeHoldForCommit: jest
          .fn()
          .mockRejectedValue(
            new ServiceUnavailableException('Saga timed out'),
          ),
        markCreationFeeCommitted: jest.fn(),
        markCreationFeeCompensated: jest.fn(),
        recordCreationFeeHoldId: jest.fn(),
        settleCreationFee: jest.fn(),
      };

      const service = new AuctionService(
        auctionRepo as any,
        {} as any,
        walletClient as any,
        {} as any,
        {} as any,
        {} as any,
        verificationClient as any,
        biddingSaga as any,
      );

      await expect(
        service.create('shipper-1', makeCreateAuctionDto()),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(biddingSaga.beginCreationFeeHold).toHaveBeenCalledTimes(1);
      expect(auctionRepo.create).not.toHaveBeenCalled();
    });

    it('marks saga COMPENSATED immediately on 422 wallet hold rejection and leaves HOLDING on 503 network error', async () => {
      const verificationClient = {
        assertVerified: jest.fn().mockResolvedValue(undefined),
      };
      const biddingSaga = {
        beginCreationFeeHold: jest.fn().mockResolvedValue(undefined),
        markCreationFeeCompensated: jest.fn().mockResolvedValue(undefined),
      };

      const service422 = new AuctionService(
        { findByIdempotencyKey: jest.fn() } as any,
        {} as any,
        {
          hold: jest
            .fn()
            .mockRejectedValue(new WalletClientError('Insufficient funds', 422)),
        } as any,
        {} as any,
        {} as any,
        {} as any,
        verificationClient as any,
        biddingSaga as any,
      );
      await expect(
        service422.create('shipper-1', makeCreateAuctionDto()),
      ).rejects.toThrow(WalletClientError);
      expect(biddingSaga.markCreationFeeCompensated).toHaveBeenCalledTimes(1);

      biddingSaga.markCreationFeeCompensated.mockClear();
      const service503 = new AuctionService(
        { findByIdempotencyKey: jest.fn() } as any,
        {} as any,
        {
          hold: jest
            .fn()
            .mockRejectedValue(new ServiceUnavailableException('Timeout')),
        } as any,
        {} as any,
        {} as any,
        {} as any,
        verificationClient as any,
        biddingSaga as any,
      );
      await expect(
        service503.create('shipper-1', makeCreateAuctionDto()),
      ).rejects.toThrow(ServiceUnavailableException);
      expect(biddingSaga.markCreationFeeCompensated).not.toHaveBeenCalled();
    });

    it('releases locked carrier deposits when an auction is cancelled', async () => {
      const auctionDoc = {
        _id: 'auc-cancel-1',
        shipperId: 'shipper-1',
        status: AuctionStatus.PENDING,
        startTime: new Date(Date.now() + 3600_000),
        endTime: new Date(Date.now() + 7200_000),
        registrationStartTime: new Date(Date.now() - 3600_000),
        registrationEndTime: new Date(Date.now() + 1800_000),
        maxPrice: '9000000',
        priceStep: '100000',
        participationFeeAmount: '50000',
        creationFeeAmount: '50000',
        isDepositRequired: true,
        depositAmount: '500000',
        cancellationReason: null as string | null,
        save: jest.fn().mockResolvedValue(undefined),
      };
      const auctionRepo = {
        findById: jest.fn().mockResolvedValue(auctionDoc),
      };
      const eventsService = { emitAuctionStatusChanged: jest.fn() };
      const biddingSaga = {
        releaseCancelledAuctionDeposits: jest.fn().mockResolvedValue(2),
      };

      const service = new AuctionService(
        auctionRepo as any,
        {} as any,
        {} as any,
        eventsService as any,
        {} as any,
        {} as any,
        {} as any,
        biddingSaga as any,
      );

      await service.cancel('auc-cancel-1', 'shipper-1', 'SHIPPER', 'Đổi kế hoạch');

      expect(auctionDoc.status).toBe(AuctionStatus.CANCELLED);
      expect(biddingSaga.releaseCancelledAuctionDeposits).toHaveBeenCalledWith(
        'auc-cancel-1',
      );
    });
  });

  describe('Registration deposit compensation & cancellation recovery', () => {
    it('preserves DEPOSIT_COMPENSATION_PENDING when immediate deposit release fails during register()', async () => {
      const registrationDoc = {
        _id: 'reg-comp-1',
        auctionId: 'auc-1',
        carrierId: 'carrier-1',
        vehicleId: 'veh-1',
        status: RegistrationStatus.REGISTERED,
        paymentStatus: RegistrationPaymentStatus.PENDING,
        depositStatus: DepositStatus.PENDING,
        participationFeeStatus: ParticipationFeeStatus.PENDING,
        depositHoldId: null as string | null,
        participationFeeTransactionId: null as string | null,
        paymentErrorCode: null as string | null,
        save: jest.fn().mockResolvedValue(undefined),
      };
      const registrationModel = {
        findOne: jest
          .fn()
          .mockReturnValue({ exec: jest.fn().mockResolvedValue(null) }),
        create: jest.fn().mockResolvedValue(registrationDoc),
      };
      const auctionService = {
        findById: jest.fn().mockResolvedValue({
          id: 'auc-1',
          status: AuctionStatus.PENDING,
          registrationOpen: true,
          registrationEndTime: new Date(Date.now() + 3600_000),
          isDepositRequired: true,
          depositAmount: '500000',
          participationFeeAmount: '50000',
          requireCarrierCoverage: false,
        }),
      };
      const walletClient = {
        hold: jest.fn().mockResolvedValue({
          status: 'SUCCESS',
          transactionId: 'tx-dep-1',
          holdId: 'hold-dep-1',
          amount: '500000',
        }),
        charge: jest
          .fn()
          .mockRejectedValue(new WalletClientError('Insufficient funds', 422)),
        release: jest
          .fn()
          .mockRejectedValue(new ServiceUnavailableException('Wallet down')),
      };

      const regService = new AuctionRegistrationService(
        registrationModel as any,
        auctionService as any,
        walletClient as any,
        { getScore: jest.fn().mockResolvedValue(95) } as any,
        { assertVerifiedVehicle: jest.fn().mockResolvedValue(undefined) } as any,
        { assertVerified: jest.fn().mockResolvedValue(undefined) } as any,
        { assertEligible: jest.fn().mockResolvedValue(undefined) } as any,
      );

      await expect(
        regService.register('auc-1', 'carrier-1', {
          vehicleId: 'veh-1',
          idempotencyKey: 'idem-1',
        }),
      ).rejects.toThrow();

      expect(registrationDoc.paymentStatus).toBe(
        RegistrationPaymentStatus.FAILED,
      );
      expect(registrationDoc.depositStatus).toBe(DepositStatus.LOCKED);
      expect(registrationDoc.paymentErrorCode).toBe(
        'DEPOSIT_COMPENSATION_PENDING',
      );
    });

    it('sweeper compensates both stuck LOCKED failed registrations and stale PENDING crashed registrations', async () => {
      const failedLocked = {
        _id: 'reg-locked-1',
        depositHoldId: 'hold-dep-1',
        depositStatus: DepositStatus.LOCKED,
        paymentStatus: RegistrationPaymentStatus.FAILED,
        paymentErrorCode: 'DEPOSIT_COMPENSATION_PENDING',
        save: jest.fn().mockResolvedValue(undefined),
      };
      const stalePending = {
        _id: 'reg-crash-2',
        depositHoldId: null,
        depositStatus: DepositStatus.PENDING,
        paymentStatus: RegistrationPaymentStatus.PENDING,
        paymentErrorCode: null as string | null,
        save: jest.fn().mockResolvedValue(undefined),
      };
      const registrationModel = {
        find: jest
          .fn()
          .mockReturnValueOnce({
            sort: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue([failedLocked]),
              }),
            }),
          })
          .mockReturnValueOnce({
            sort: jest.fn().mockReturnValue({
              limit: jest.fn().mockReturnValue({
                exec: jest.fn().mockResolvedValue([stalePending]),
              }),
            }),
          }),
      };
      const walletClient = {
        release: jest.fn().mockResolvedValue({
          status: 'SUCCESS',
          transactionId: 'tx-rel-1',
          amount: '500000',
        }),
        releaseByHoldKey: jest.fn().mockResolvedValue({
          status: 'SUCCESS',
          transactionId: 'tx-rel-2',
          amount: '500000',
        }),
      };

      const sagaService = new BiddingSagaService(
        {} as any,
        {} as any,
        registrationModel as any,
        walletClient as any,
      );

      await sagaService.reconcileStuckRegistrationDeposits();

      expect(walletClient.release).toHaveBeenCalledWith(
        'hold-dep-1',
        'reg-locked-1:deposit:release',
      );
      expect(failedLocked.depositStatus).toBe(DepositStatus.REFUNDED);
      expect(failedLocked.paymentErrorCode).toBe('DEPOSIT_COMPENSATED');

      expect(walletClient.releaseByHoldKey).toHaveBeenCalledWith(
        'reg-crash-2:deposit:hold',
        'reg-crash-2:deposit:saga-compensate',
      );
      expect(stalePending.depositStatus).toBe(DepositStatus.REFUNDED);
      expect(stalePending.paymentStatus).toBe(RegistrationPaymentStatus.FAILED);
    });

    it('re-holds deposit and re-charges fee with new attempt keys when retryPayment runs after prior compensation', async () => {
      const registrationDoc = {
        _id: 'reg-retry-1',
        auctionId: 'auc-1',
        carrierId: 'carrier-1',
        vehicleId: 'veh-1',
        status: RegistrationStatus.REGISTERED,
        paymentStatus: RegistrationPaymentStatus.FAILED,
        depositStatus: DepositStatus.REFUNDED,
        participationFeeStatus: ParticipationFeeStatus.FAILED,
        participationFeeAmount: '50000',
        depositAmount: '500000',
        depositHoldId: 'old-released-hold',
        participationFeeTransactionId: null as string | null,
        paymentErrorCode: 'WALLET_422',
        paymentAttempt: 0,
        startTime: new Date(Date.now() + 3600_000),
        save: jest.fn().mockResolvedValue(undefined),
      };
      const registrationModel = {
        findOne: jest
          .fn()
          .mockReturnValue({ exec: jest.fn().mockResolvedValue(registrationDoc) }),
      };
      const auctionService = {
        findById: jest.fn().mockResolvedValue({
          id: 'auc-1',
          status: AuctionStatus.PENDING,
          startTime: new Date(Date.now() + 3600_000),
          isDepositRequired: true,
          depositAmount: '500000',
          participationFeeAmount: '50000',
          requireCarrierCoverage: false,
        }),
      };
      const walletClient = {
        hold: jest.fn().mockResolvedValue({
          status: 'SUCCESS',
          transactionId: 'tx-dep-2',
          holdId: 'hold-dep-2',
          amount: '500000',
        }),
        charge: jest.fn().mockResolvedValue({
          status: 'SUCCESS',
          transactionId: 'tx-fee-2',
          amount: '50000',
        }),
      };

      const regService = new AuctionRegistrationService(
        registrationModel as any,
        auctionService as any,
        walletClient as any,
        { getScore: jest.fn().mockResolvedValue(95) } as any,
        { assertVerifiedVehicle: jest.fn().mockResolvedValue(undefined) } as any,
        { assertVerified: jest.fn().mockResolvedValue(undefined) } as any,
        { assertEligible: jest.fn().mockResolvedValue(undefined) } as any,
      );

      const serialized = await regService.retryPayment(
        'auc-1',
        'reg-retry-1',
        'carrier-1',
        { idempotencyKey: 'retry-idem-1' },
      );

      expect(registrationDoc.paymentAttempt).toBe(1);
      expect(walletClient.hold).toHaveBeenCalledWith(
        'carrier-1',
        expect.objectContaining({ idempotencyKey: 'reg-retry-1:deposit:hold:1' }),
      );
      expect(walletClient.charge).toHaveBeenCalledWith(
        'carrier-1',
        expect.objectContaining({ idempotencyKey: 'reg-retry-1:fee:charge:1' }),
      );
      expect(serialized.paymentStatus).toBe(RegistrationPaymentStatus.COMPLETED);
      expect(serialized.depositStatus).toBe(DepositStatus.LOCKED);
      expect(serialized.participationFeeStatus).toBe(ParticipationFeeStatus.PAID);
      expect(serialized.depositHoldId).toBe('hold-dep-2');
    });
  });

  describe('ContractAwardConsumer (@EventPattern) + Redis distributed lock', () => {
    it('reconciles signed award from unwrapped NestJS RMQ event payload and acknowledges message', async () => {
      const auctionDoc = {
        _id: 'auc-award-1',
        title: 'Lô hàng TP.HCM - Đà Nẵng',
        shipperId: 'shipper-1',
        awardStatus: 'AWAITING_SHIPPER_SIGNATURE',
        awardError: null,
        awardCleanupCompleted: false,
        winningBidId: null,
        awardTripId: null,
        awardAttempts: [
          {
            attemptId: 'attempt-rmq-1',
            attemptNumber: 1,
            bidId: 'bid-1',
            carrierId: 'carrier-winner',
            bidAmount: '8500000',
            status: AuctionAwardAttemptStatus.AWAITING_SHIPPER_SIGNATURE,
            signingDeadlineAt: new Date(Date.now() + 3600_000),
            tripId: 'trip-1',
            contractId: 'contract-1',
            failureReason: null,
          },
        ],
        save: jest.fn().mockResolvedValue(undefined),
      };

      const auctionModel = {
        findOne: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue(auctionDoc),
        }),
      };
      const registrationModel = {
        find: jest.fn().mockReturnValue({
          exec: jest.fn().mockResolvedValue([]),
        }),
      };
      const contractAwardClient = {
        status: jest.fn().mockResolvedValue({
          status: 'SIGNED',
          carrierSigned: true,
          shipperSigned: true,
          signingDeadlineAt: null,
        }),
      };
      const notificationClient = {
        notify: jest.fn().mockResolvedValue(undefined),
      };
      const redis = {
        tryAcquireLock: jest.fn().mockResolvedValue(true),
        releaseLock: jest.fn().mockResolvedValue(undefined),
      };

      const awardService = new AuctionAwardService(
        auctionModel as any,
        {} as any,
        registrationModel as any,
        contractAwardClient as any,
        {} as any,
        notificationClient as any,
        redis as any,
      );

      const consumer = new ContractAwardConsumer(awardService);
      const ack = jest.fn();
      const rmqContext = {
        getChannelRef: () => ({ ack }),
        getMessage: () => ({ content: Buffer.from('{}') }),
      };

      // Matches the actual unwrapped payload shape NestJS ServerRMQ passes to @Payload() for @EventPattern.
      await consumer.handleContractAwardUpdated(
        {
          awardAttemptId: 'attempt-rmq-1',
          contractId: 'contract-1',
          tripId: 'trip-1',
          status: 'SIGNED',
        },
        rmqContext as any,
      );

      expect(redis.tryAcquireLock).toHaveBeenCalledTimes(1);
      expect(redis.releaseLock).toHaveBeenCalledTimes(1);
      expect(contractAwardClient.status).toHaveBeenCalledWith('attempt-rmq-1');
      expect(auctionDoc.awardStatus).toBe('SIGNED');
      expect(auctionDoc.awardCleanupCompleted).toBe(true);
      expect(ack).toHaveBeenCalledTimes(1);
    });

    it('skips duplicate award reconciliation when another replica holds the Redis distributed lock', async () => {
      const contractAwardClient = { status: jest.fn() };
      const redis = {
        tryAcquireLock: jest.fn().mockResolvedValue(false),
        releaseLock: jest.fn(),
      };
      const awardService = new AuctionAwardService(
        {} as any,
        {} as any,
        {} as any,
        contractAwardClient as any,
        {} as any,
        {} as any,
        redis as any,
      );

      await awardService.reconcileAuctionAward({
        _id: 'auc-locked-other-node',
        awardAttempts: [],
      } as any);

      expect(contractAwardClient.status).not.toHaveBeenCalled();
      expect(redis.releaseLock).not.toHaveBeenCalled();
    });
  });

  describe('WalletClient.releaseByHoldKey contract', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('sends JSON body with AbortSignal timeout and accepts NO_OP with null transactionId', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          status: 'NO_OP',
          transactionId: null,
          holdId: null,
          amount: '0',
          message: 'No active hold found',
        }),
      });
      global.fetch = fetchMock as any;

      const config = {
        getOrThrow: (key: string) =>
          key === 'WALLET_SERVICE_URL'
            ? 'http://wallet-service:8080'
            : 'internal-secret',
      } as unknown as ConfigService;

      const client = new WalletClient(config);
      const res = await client.releaseByHoldKey(
        'reg-1:deposit:hold',
        'reg-1:deposit:saga-compensate',
      );

      expect(res.status).toBe('NO_OP');
      expect(res.transactionId).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe(
        'http://wallet-service:8080/internal/wallet-holds/release-by-key',
      );
      expect(JSON.parse(init.body)).toEqual({
        holdIdempotencyKey: 'reg-1:deposit:hold',
        idempotencyKey: 'reg-1:deposit:saga-compensate',
      });
      expect(init.signal).toBeDefined();
    });
  });
});
