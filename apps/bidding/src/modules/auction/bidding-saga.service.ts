import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { randomUUID } from 'node:crypto';
import { AuctionStatus } from '../../common/enums/auction-status.enum';
import { CreationFeeStatus } from '../../common/enums/creation-fee-status.enum';
import { DepositStatus } from '../../common/enums/deposit-status.enum';
import { RegistrationPaymentStatus } from '../../common/enums/registration-payment-status.enum';
import { RedisCacheService } from '../../common/redis/redis-cache.service';
import {
  WalletClient,
  WalletClientError,
} from '../../integrations/wallet/wallet.client';
import {
  AuctionRegistration,
  AuctionRegistrationDocument,
} from '../auction-registration/schemas/auction-registration.schema';
import { Auction, AuctionDocument } from './schemas/auction.schema';
import {
  WalletHoldSaga,
  WalletHoldSagaDocument,
} from './schemas/wallet-hold-saga.schema';

export const ORPHAN_HOLD_CUTOFF_MS = 120_000;
export const SAGA_SWEEP_INTERVAL_MS = 15_000;
export const MAX_SETTLEMENT_RETRIES = 10;
const SAGA_SWEEP_LOCK_KEY = 'bidding:saga:sweep:lock';
const SAGA_SWEEP_LOCK_TTL_MS = 25_000;

@Injectable()
export class BiddingSagaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BiddingSagaService.name);
  private sweepInterval: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @InjectModel(Auction.name)
    private readonly auctionModel: Model<AuctionDocument>,
    @InjectModel(WalletHoldSaga.name)
    private readonly holdSagaModel: Model<WalletHoldSagaDocument>,
    @InjectModel(AuctionRegistration.name)
    private readonly registrationModel: Model<AuctionRegistrationDocument>,
    private readonly walletClient: WalletClient,
    @Optional() private readonly redis?: RedisCacheService,
  ) {}

  onModuleInit(): void {
    this.sweepInterval = setInterval(() => {
      void this.runSweep().catch((error: unknown) => {
        this.logger.warn(
          `[BiddingSaga] Background sweep failed: ${this.errorMessage(error)}`,
        );
      });
    }, SAGA_SWEEP_INTERVAL_MS);
    this.sweepInterval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepInterval) clearInterval(this.sweepInterval);
  }

  async beginCreationFeeHold(
    holdKey: string,
    auctionId: string,
    shipperId: string,
  ): Promise<void> {
    await this.holdSagaModel.create({
      _id: holdKey,
      auctionId,
      shipperId,
      holdId: null,
      status: 'HOLDING',
      completedAt: null,
    });
  }

  /**
   * Atomically verifies the write-ahead saga has not already been claimed by background
   * compensation before persisting the Auction document, preventing free-auction races.
   */
  async claimCreationFeeHoldForCommit(
    holdKey: string,
    holdId: string,
  ): Promise<void> {
    const claimed = await this.holdSagaModel
      .findOneAndUpdate(
        { _id: holdKey, status: 'HOLDING' },
        { $set: { holdId } },
        { returnDocument: 'after' },
      )
      .exec();
    if (!claimed) {
      throw new ServiceUnavailableException(
        'Auction creation timed out during wallet hold verification. Please retry.',
      );
    }
  }

  async markCreationFeeCommitted(
    holdKey: string,
    holdId: string,
  ): Promise<void> {
    await this.holdSagaModel
      .updateOne(
        { _id: holdKey },
        { $set: { status: 'COMMITTED', holdId, completedAt: new Date() } },
      )
      .exec()
      .catch(() => undefined);
  }

  async markCreationFeeCompensated(
    holdKey: string,
    holdId: string | null = null,
  ): Promise<void> {
    const update: Record<string, unknown> = {
      status: 'COMPENSATED',
      completedAt: new Date(),
    };
    if (holdId !== null) update.holdId = holdId;
    await this.holdSagaModel
      .updateOne({ _id: holdKey }, { $set: update })
      .exec()
      .catch(() => undefined);
  }

  async recordCreationFeeHoldId(
    holdKey: string,
    holdId: string,
  ): Promise<void> {
    await this.holdSagaModel
      .updateOne({ _id: holdKey }, { $set: { holdId } })
      .exec()
      .catch(() => undefined);
  }

  async settleCreationFee(auction: AuctionDocument): Promise<void> {
    if (auction.creationFeeStatus === CreationFeeStatus.SETTLED) return;
    if (!auction.creationFeeHoldId) {
      throw new Error('Auction creation fee hold is missing');
    }

    try {
      const settled = await this.walletClient.forfeit(
        auction.creationFeeHoldId,
        `auction_creation_fee_${auction._id}:forfeit`,
      );
      auction.creationFeeStatus = CreationFeeStatus.SETTLED;
      auction.creationFeeTransactionId = settled.transactionId;
      auction.creationFeeLastAttemptAt = new Date();
      await auction.save();
    } catch (error) {
      const isPermanentClientError =
        error instanceof WalletClientError &&
        error.statusCode !== undefined &&
        error.statusCode >= 400 &&
        error.statusCode < 500;
      auction.creationFeeStatus = CreationFeeStatus.RECONCILIATION_REQUIRED;
      auction.creationFeeLastAttemptAt = new Date();
      auction.creationFeeRetryCount = isPermanentClientError
        ? MAX_SETTLEMENT_RETRIES
        : (auction.creationFeeRetryCount ?? 0) + 1;
      if (isPermanentClientError) {
        this.logger.error(
          `[CreationFeeSaga] Permanent wallet error (${error.statusCode}) settling auction ${auction._id}; halted automatic retries: ${error.message}`,
        );
      }
      try {
        await auction.save();
      } catch {
        // Keep the original wallet/database error; the persisted hold remains retryable.
      }
      throw error;
    }
  }

  async releaseCancelledAuctionDeposits(auctionId: string): Promise<number> {
    const registrations = await this.registrationModel
      .find({ auctionId, depositStatus: DepositStatus.LOCKED })
      .exec();
    let released = 0;
    for (const registration of registrations) {
      if (!registration.depositHoldId) continue;
      try {
        await this.walletClient.release(
          registration.depositHoldId,
          `${registration._id}:deposit:auction-cancelled`,
        );
        registration.depositStatus = DepositStatus.REFUNDED;
        await registration.save();
        released++;
      } catch (error) {
        this.logger.warn(
          `[CancelAuctionSaga] Deferred deposit release for registration ${registration._id}: ${this.errorMessage(error)}`,
        );
      }
    }
    return released;
  }

  async runSweep(): Promise<void> {
    if (this.sweeping) return;
    const lockToken = randomUUID();
    const acquired =
      (await this.redis?.tryAcquireLock(
        SAGA_SWEEP_LOCK_KEY,
        lockToken,
        SAGA_SWEEP_LOCK_TTL_MS,
      )) ?? true;
    if (!acquired) return;

    this.sweeping = true;
    try {
      await this.reconcileOrphanedCreationHolds();
      await this.reconcileUnsettledCreationFees();
      await this.reconcileStuckRegistrationDeposits();
      await this.reconcileCancelledAuctionDeposits();
    } finally {
      this.sweeping = false;
      await this.redis?.releaseLock(SAGA_SWEEP_LOCK_KEY, lockToken);
    }
  }

  async reconcileOrphanedCreationHolds(): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_HOLD_CUTOFF_MS);

    for (let i = 0; i < 50; i++) {
      const saga = await this.holdSagaModel
        .findOneAndUpdate(
          {
            $or: [
              { status: 'HOLDING', createdAt: { $lte: cutoff } },
              { status: 'COMPENSATING', updatedAt: { $lte: cutoff } },
            ],
          },
          { $set: { status: 'COMPENSATING' } },
          { returnDocument: 'after', sort: { createdAt: 1 } },
        )
        .exec();
      if (!saga) break;

      try {
        const existingAuction = await this.auctionModel
          .findById(saga.auctionId)
          .exec();
        if (existingAuction) {
          saga.status = 'COMMITTED';
          saga.holdId = existingAuction.creationFeeHoldId ?? saga.holdId;
          saga.completedAt = new Date();
          await saga.save();
          continue;
        }

        const releaseKey = `${saga._id}:saga-compensate`;
        if (saga.holdId) {
          await this.walletClient.release(saga.holdId, releaseKey);
        } else {
          await this.walletClient.releaseByHoldKey(saga._id, releaseKey);
        }
        saga.status = 'COMPENSATED';
        saga.completedAt = new Date();
        await saga.save();
      } catch (error) {
        this.logger.warn(
          `[CreationFeeSaga] Will retry compensation for ${saga._id}: ${this.errorMessage(error)}`,
        );
      }
    }
  }

  async reconcileUnsettledCreationFees(): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_HOLD_CUTOFF_MS);
    const unsettledAuctions = await this.auctionModel
      .find({
        creationFeeStatus: {
          $in: [
            CreationFeeStatus.HELD,
            CreationFeeStatus.RECONCILIATION_REQUIRED,
          ],
        },
        createdAt: { $lte: cutoff },
        $or: [
          { creationFeeRetryCount: { $lt: MAX_SETTLEMENT_RETRIES } },
          { creationFeeRetryCount: { $exists: false } },
        ],
      })
      .sort({ creationFeeLastAttemptAt: 1, createdAt: 1 })
      .limit(50)
      .exec();

    for (const auction of unsettledAuctions) {
      try {
        await this.settleCreationFee(auction);
      } catch (error) {
        this.logger.warn(
          `[CreationFeeSaga] Will retry fee settlement for auction ${auction._id}: ${this.errorMessage(error)}`,
        );
      }
    }
  }

  async reconcileStuckRegistrationDeposits(): Promise<void> {
    const cutoff = new Date(Date.now() - ORPHAN_HOLD_CUTOFF_MS);

    // Case A: Failed/compensating registration whose deposit remained LOCKED because immediate release failed.
    const lockedFailed = await this.registrationModel
      .find({
        paymentStatus: {
          $in: [
            RegistrationPaymentStatus.FAILED,
            RegistrationPaymentStatus.COMPENSATING,
          ],
        },
        depositStatus: DepositStatus.LOCKED,
      })
      .sort({ updatedAt: 1 })
      .limit(50)
      .exec();

    for (const reg of lockedFailed) {
      try {
        const attempt = reg.paymentAttempt ?? 0;
        const suffix = attempt > 0 ? `:${attempt}` : '';
        const releaseKey = `${reg._id}:deposit:release${suffix}`;
        if (reg.depositHoldId) {
          await this.walletClient.release(reg.depositHoldId, releaseKey);
        } else {
          await this.walletClient.releaseByHoldKey(
            `${reg._id}:deposit:hold${suffix}`,
            releaseKey,
          );
        }
        reg.depositStatus = DepositStatus.REFUNDED;
        reg.paymentStatus = RegistrationPaymentStatus.FAILED;
        if (reg.paymentErrorCode === 'DEPOSIT_COMPENSATION_PENDING') {
          reg.paymentErrorCode = 'DEPOSIT_COMPENSATED';
        }
        await reg.save();
      } catch (error) {
        this.logger.warn(
          `[RegistrationSaga] Will retry deposit compensation for ${reg._id}: ${this.errorMessage(error)}`,
        );
      }
    }

    // Case B: Registration crashed mid-flight while PENDING before saving depositHoldId.
    const stalePending = await this.registrationModel
      .find({
        paymentStatus: RegistrationPaymentStatus.PENDING,
        depositStatus: DepositStatus.PENDING,
        updatedAt: { $lte: cutoff },
      })
      .sort({ updatedAt: 1 })
      .limit(50)
      .exec();

    for (const reg of stalePending) {
      try {
        const attempt = reg.paymentAttempt ?? 0;
        const suffix = attempt > 0 ? `:${attempt}` : '';
        const res = await this.walletClient.releaseByHoldKey(
          `${reg._id}:deposit:hold${suffix}`,
          `${reg._id}:deposit:saga-compensate${suffix}`,
        );
        reg.paymentStatus = RegistrationPaymentStatus.FAILED;
        if (res.status !== 'NO_OP') {
          reg.depositStatus = DepositStatus.REFUNDED;
        }
        reg.paymentErrorCode = 'REGISTRATION_CRASH_RECOVERED';
        await reg.save();
      } catch (error) {
        this.logger.warn(
          `[RegistrationSaga] Will retry stale pending deposit recovery for ${reg._id}: ${this.errorMessage(error)}`,
        );
      }
    }
  }

  async reconcileCancelledAuctionDeposits(): Promise<void> {
    const lockedRegs = await this.registrationModel
      .find({ depositStatus: DepositStatus.LOCKED })
      .sort({ updatedAt: 1 })
      .limit(100)
      .exec();
    if (lockedRegs.length === 0) return;

    const auctionIds = Array.from(
      new Set(lockedRegs.map((reg) => reg.auctionId)),
    );
    const cancelledAuctions = await this.auctionModel
      .find({
        _id: { $in: auctionIds },
        status: AuctionStatus.CANCELLED,
      })
      .select({ _id: 1 })
      .exec();
    const cancelledIds = new Set(
      cancelledAuctions.map((auction) => String(auction._id)),
    );

    for (const reg of lockedRegs) {
      if (!cancelledIds.has(reg.auctionId) || !reg.depositHoldId) continue;
      try {
        await this.walletClient.release(
          reg.depositHoldId,
          `${reg._id}:deposit:auction-cancelled`,
        );
        reg.depositStatus = DepositStatus.REFUNDED;
        await reg.save();
      } catch (error) {
        this.logger.warn(
          `[CancelAuctionSaga] Will retry cancelled-auction deposit release for ${reg._id}: ${this.errorMessage(error)}`,
        );
      }
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
