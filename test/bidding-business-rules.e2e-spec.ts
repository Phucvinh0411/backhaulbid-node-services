import {
  INestApplication,
  ServiceUnavailableException,
  ValidationPipe,
} from '@nestjs/common';
import { getModelToken } from '@nestjs/mongoose';
import { Test } from '@nestjs/testing';
import { Types } from 'mongoose';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuctionStatus } from '../apps/bidding/src/common/enums/auction-status.enum';
import { CreationFeeStatus } from '../apps/bidding/src/common/enums/creation-fee-status.enum';
import { ParticipationFeeStatus } from '../apps/bidding/src/common/enums/participation-fee-status.enum';
import { RegistrationPaymentStatus } from '../apps/bidding/src/common/enums/registration-payment-status.enum';
import { TransformInterceptor } from '../apps/bidding/src/core/interceptors/transform.interceptor';
import { AccountVerificationClient } from '../apps/bidding/src/integrations/identity/account-verification.client';
import { CarrierCoverageClient } from '../apps/bidding/src/integrations/identity/carrier-coverage.client';
import { CarrierReputationClient } from '../apps/bidding/src/integrations/fleet/carrier-reputation.client';
import { CarrierVehicleClient } from '../apps/bidding/src/integrations/fleet/carrier-vehicle.client';
import { ContractAwardClient } from '../apps/bidding/src/integrations/contracts/contract-award.client';
import { MediaFileClient } from '../apps/bidding/src/integrations/media/media-file.client';
import { AuctionNotificationClient } from '../apps/bidding/src/integrations/notifications/auction-notification.client';
import { WalletClient } from '../apps/bidding/src/integrations/wallet/wallet.client';
import { AuctionRegistrationController } from '../apps/bidding/src/modules/auction-registration/auction-registration.controller';
import { AuctionRegistrationService } from '../apps/bidding/src/modules/auction-registration/auction-registration.service';
import { AuctionRegistration } from '../apps/bidding/src/modules/auction-registration/schemas/auction-registration.schema';
import { AuctionAwardService } from '../apps/bidding/src/modules/auction/auction-award.service';
import { AuctionController } from '../apps/bidding/src/modules/auction/auction.controller';
import { AuctionRepository } from '../apps/bidding/src/modules/auction/auction.repository';
import { AuctionService } from '../apps/bidding/src/modules/auction/auction.service';
import { BiddingSagaService } from '../apps/bidding/src/modules/auction/bidding-saga.service';
import { Auction } from '../apps/bidding/src/modules/auction/schemas/auction.schema';
import { WalletHoldSaga } from '../apps/bidding/src/modules/auction/schemas/wallet-hold-saga.schema';
import { Bid } from '../apps/bidding/src/modules/bid/schemas/bid.schema';
import { BiddingEventsService } from '../apps/bidding/src/modules/bidding/bidding-events.service';

class InMemoryWallet {
  readonly balances = new Map<string, number>();
  readonly holds = new Map<
    string,
    { accountId: string; amount: number; active: boolean }
  >();
  readonly operations = new Map<string, Record<string, unknown>>();
  failNextRefund = false;
  private seq = 0;

  seed(accountId: string, balance: number) {
    this.balances.set(accountId, balance);
  }

  balanceOf(accountId: string): number {
    return this.balances.get(accountId) ?? 0;
  }

  hold(accountId: string, input: { amount: string; idempotencyKey: string }) {
    const existing = this.operations.get(input.idempotencyKey);
    if (existing) return Promise.resolve(existing);

    const amount = Number(input.amount);
    const balance = this.balanceOf(accountId);
    if (balance < amount) {
      return Promise.reject(
        new ServiceUnavailableException('Insufficient balance'),
      );
    }
    this.balances.set(accountId, balance - amount);
    const id = `hold-${++this.seq}`;
    this.holds.set(id, { accountId, amount, active: true });
    const res = {
      status: 'SUCCESS',
      transactionId: id,
      holdId: id,
      amount: amount.toFixed(2),
    };
    this.operations.set(input.idempotencyKey, res);
    return Promise.resolve(res);
  }

  forfeit(holdId: string, idempotencyKey: string) {
    const existing = this.operations.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);

    const hold = this.holds.get(holdId);
    if (!hold || !hold.active) {
      return Promise.reject(new ServiceUnavailableException('Hold not active'));
    }
    hold.active = false;
    const res = {
      status: 'SUCCESS',
      transactionId: `tx-forfeit-${++this.seq}`,
      amount: hold.amount.toFixed(2),
    };
    this.operations.set(idempotencyKey, res);
    return Promise.resolve(res);
  }

  charge(accountId: string, input: { amount: string; idempotencyKey: string }) {
    const existing = this.operations.get(input.idempotencyKey);
    if (existing) return Promise.resolve(existing);

    const amount = Number(input.amount);
    const balance = this.balanceOf(accountId);
    if (balance < amount) {
      return Promise.reject(
        new ServiceUnavailableException('Insufficient balance'),
      );
    }
    this.balances.set(accountId, balance - amount);
    const res = {
      status: 'SUCCESS',
      transactionId: `tx-charge-${++this.seq}`,
      amount: amount.toFixed(2),
    };
    this.operations.set(input.idempotencyKey, res);
    return Promise.resolve(res);
  }

  refund(accountId: string, input: { amount: string; idempotencyKey: string }) {
    if (this.failNextRefund) {
      this.failNextRefund = false;
      return Promise.reject(
        new ServiceUnavailableException('Wallet temporary failure'),
      );
    }
    const existing = this.operations.get(input.idempotencyKey);
    if (existing) return Promise.resolve(existing);

    const amount = Number(input.amount);
    this.balances.set(accountId, this.balanceOf(accountId) + amount);
    const res = {
      status: 'SUCCESS',
      transactionId: `tx-refund-${++this.seq}`,
      amount: amount.toFixed(2),
    };
    this.operations.set(input.idempotencyKey, res);
    return Promise.resolve(res);
  }

  release(holdId: string, idempotencyKey: string) {
    const existing = this.operations.get(idempotencyKey);
    if (existing) return Promise.resolve(existing);

    const hold = this.holds.get(holdId);
    if (hold && hold.active) {
      hold.active = false;
      this.balances.set(
        hold.accountId,
        this.balanceOf(hold.accountId) + hold.amount,
      );
    }
    const res = {
      status: 'SUCCESS',
      transactionId: `tx-release-${++this.seq}`,
      amount: (hold?.amount ?? 0).toFixed(2),
    };
    this.operations.set(idempotencyKey, res);
    return Promise.resolve(res);
  }

  releaseByHoldKey() {
    return Promise.resolve({
      status: 'NO_OP',
      transactionId: null,
      amount: '0',
    });
  }
}

describe('Bidding HTTP business rules (e2e)', () => {
  let app: INestApplication<App>;
  let wallet: InMemoryWallet;
  let awardService: AuctionAwardService;
  let sagaService: BiddingSagaService;

  const auctions = new Map<string, any>();
  const registrations = new Map<string, any>();
  const holdSagas = new Map<string, any>();
  let failNextRegistrationSaveCalls = 0;

  function wrapAuction(raw: Record<string, any>) {
    const doc: any = {
      awardAttempts: [],
      images: [],
      notes: '',
      createdAt: raw.createdAt ?? new Date(),
      updatedAt: new Date(),
      ...raw,
    };
    doc.save = () => {
      doc.updatedAt = new Date();
      auctions.set(doc._id, doc);
      return Promise.resolve(doc);
    };
    auctions.set(doc._id, doc);
    return doc;
  }

  function wrapRegistration(raw: Record<string, any>) {
    const doc: any = {
      _id: raw._id ?? `reg-${registrations.size + 1}`,
      createdAt: raw.createdAt ?? new Date(),
      updatedAt: new Date(),
      ...raw,
    };
    doc.save = () => {
      if (failNextRegistrationSaveCalls > 0) {
        failNextRegistrationSaveCalls -= 1;
        return Promise.reject(new Error('Simulated DB save failure'));
      }
      doc.updatedAt = new Date();
      registrations.set(doc._id, doc);
      return Promise.resolve(doc);
    };
    registrations.set(doc._id, doc);
    return doc;
  }

  function validAuctionPayload(overrides: Record<string, unknown> = {}) {
    const now = Date.now();
    return {
      title: 'Tuyen HCM - Ha Noi',
      goodsType: 'GENERAL',
      weight: 5000,
      vehicleTypeRequired: 'TRUCK_MEDIUM',
      pickupLocation: {
        locationName: 'Kho HCM',
        province: 'TP.HCM',
        address: '1 Le Loi',
      },
      deliveryLocation: {
        locationName: 'Kho Ha Noi',
        province: 'Ha Noi',
        address: '2 Giai Phong',
      },
      auctionType: 'PUBLIC',
      maxPrice: '5000000',
      priceStep: '100000',
      participationFeeTier: 'LEVEL_2',
      isDepositRequired: false,
      registrationStartTime: new Date(now + 30 * 60_000).toISOString(),
      registrationEndTime: new Date(now + 90 * 60_000).toISOString(),
      startTime: new Date(now + 120 * 60_000).toISOString(),
      endTime: new Date(now + 240 * 60_000).toISOString(),
      ...overrides,
    };
  }

  beforeAll(async () => {
    wallet = new InMemoryWallet();

    const auctionRepoFake = {
      create: (data: Record<string, any>) => Promise.resolve(wrapAuction(data)),
      findByIdempotencyKey: (shipperId: string, key: string) =>
        Promise.resolve(
          Array.from(auctions.values()).find(
            (a) =>
              a.shipperId === shipperId && a.creationIdempotencyKey === key,
          ) ?? null,
        ),
      findById: (id: string) => Promise.resolve(auctions.get(id) ?? null),
      findByIds: (ids: string[]) =>
        Promise.resolve(ids.map((id) => auctions.get(id)).filter(Boolean)),
      find: () => Promise.resolve(Array.from(auctions.values())),
      count: () => Promise.resolve(auctions.size),
      updateById: (id: string, update: Record<string, any>) => {
        const existing = auctions.get(id);
        if (!existing) return Promise.resolve(null);
        Object.assign(existing, update);
        if (typeof update.maxPrice === 'string') {
          existing.maxPrice = Types.Decimal128.fromString(update.maxPrice);
        }
        if (typeof update.priceStep === 'string') {
          existing.priceStep = Types.Decimal128.fromString(update.priceStep);
        }
        if (typeof update.participationFeeAmount === 'string') {
          existing.participationFeeAmount = Types.Decimal128.fromString(
            update.participationFeeAmount,
          );
        }
        existing.updatedAt = new Date();
        auctions.set(id, existing);
        return Promise.resolve(existing);
      },
    };

    const auctionModelFake = {
      findById: (id: string) => ({
        exec: () => Promise.resolve(auctions.get(id) ?? null),
      }),
      find: (filter: Record<string, any>) => ({
        sort: () => ({
          limit: () => ({
            exec: () => {
              const items = Array.from(auctions.values()).filter((a) => {
                if (filter?.status === AuctionStatus.CANCELLED) {
                  return a.status === AuctionStatus.CANCELLED;
                }
                if (filter?.awardStatus?.$in) {
                  return (
                    filter.awardStatus.$in.includes(a.awardStatus) &&
                    a.awardCleanupCompleted !== true
                  );
                }
                return false;
              });
              return Promise.resolve(items);
            },
          }),
        }),
        limit: () => ({ exec: () => Promise.resolve([]) }),
      }),
    };

    const holdSagaModelFake = {
      create: (data: Record<string, any>) => {
        const doc = {
          ...data,
          save: () => Promise.resolve(doc),
        };
        holdSagas.set(String(data._id), doc);
        return Promise.resolve(doc);
      },
      findOneAndUpdate: (
        filter: Record<string, any>,
        update: Record<string, any>,
      ) => ({
        exec: () => {
          const doc = holdSagas.get(String(filter._id));
          if (!doc || (filter.status && doc.status !== filter.status)) {
            return Promise.resolve(null);
          }
          Object.assign(doc, update.$set ?? {});
          return Promise.resolve(doc);
        },
      }),
      updateOne: (
        filter: Record<string, any>,
        update: Record<string, any>,
      ) => ({
        exec: () => {
          const doc = holdSagas.get(String(filter._id));
          if (doc) Object.assign(doc, update.$set ?? {});
          return Promise.resolve({ modifiedCount: doc ? 1 : 0 });
        },
      }),
    };

    const registrationModelFake = {
      create: (data: Record<string, any>) =>
        Promise.resolve(wrapRegistration(data)),
      findOne: (filter: Record<string, any>) => ({
        exec: () => {
          const match = Array.from(registrations.values()).find((r) =>
            Object.entries(filter).every(([k, v]) => r[k] === v),
          );
          return Promise.resolve(match ?? null);
        },
      }),
      find: (filter: Record<string, any>) => {
        const matches = Array.from(registrations.values()).filter((r) => {
          if (
            filter.paymentStatus?.$in &&
            !filter.paymentStatus.$in.includes(r.paymentStatus)
          ) {
            return false;
          }
          if (
            filter.participationFeeStatus &&
            r.participationFeeStatus !== filter.participationFeeStatus
          ) {
            return false;
          }
          if (
            filter.depositStatus &&
            r.depositStatus !== filter.depositStatus
          ) {
            return false;
          }
          if (filter.auctionId && r.auctionId !== filter.auctionId) {
            return false;
          }
          return true;
        });
        return {
          exec: () => Promise.resolve(matches),
          sort: () => ({
            limit: () => ({ exec: () => Promise.resolve(matches) }),
          }),
        };
      },
    };

    const emptyQueryFake = {
      findOne: () => ({
        sort: () => ({ exec: () => Promise.resolve(null) }),
        exec: () => Promise.resolve(null),
      }),
    };

    const moduleRef = await Test.createTestingModule({
      controllers: [AuctionController, AuctionRegistrationController],
      providers: [
        AuctionService,
        AuctionRegistrationService,
        BiddingSagaService,
        AuctionAwardService,
        BiddingEventsService,
        { provide: AuctionRepository, useValue: auctionRepoFake },
        { provide: getModelToken(Auction.name), useValue: auctionModelFake },
        {
          provide: getModelToken(WalletHoldSaga.name),
          useValue: holdSagaModelFake,
        },
        {
          provide: getModelToken(AuctionRegistration.name),
          useValue: registrationModelFake,
        },
        { provide: getModelToken(Bid.name), useValue: emptyQueryFake },
        { provide: WalletClient, useValue: wallet },
        { provide: MediaFileClient, useValue: {} },
        {
          provide: AccountVerificationClient,
          useValue: {
            assertVerified: jest.fn().mockResolvedValue(undefined),
            getStatus: jest.fn().mockResolvedValue({
              ekycVerified: true,
              businessVerified: true,
              fullyVerified: true,
            }),
          },
        },
        {
          provide: CarrierReputationClient,
          useValue: { getScore: jest.fn().mockResolvedValue(95) },
        },
        {
          provide: CarrierVehicleClient,
          useValue: {
            assertVerifiedVehicle: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CarrierCoverageClient,
          useValue: {
            assertEligible: jest.fn().mockResolvedValue(undefined),
            isEligible: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: ContractAwardClient, useValue: {} },
        {
          provide: AuctionNotificationClient,
          useValue: { notify: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    app.useGlobalInterceptors(new TransformInterceptor());
    app.setGlobalPrefix('api/v1/bidding');
    await app.init();

    awardService = moduleRef.get(AuctionAwardService);
    sagaService = moduleRef.get(BiddingSagaService);
  });

  beforeEach(() => {
    auctions.clear();
    registrations.clear();
    holdSagas.clear();
    wallet.balances.clear();
    wallet.holds.clear();
    wallet.operations.clear();
    wallet.failNextRefund = false;
    failNextRegistrationSaveCalls = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  it('enforces registrationStartTime, schedule validation, and creationFeeAmount immutability over HTTP', async () => {
    wallet.seed('shipper-1', 1_000_000);
    wallet.seed('carrier-1', 500_000);

    // 1. Shipper creates an auction whose registration starts 30 minutes in the future
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/bidding/auctions')
      .set('x-user-id', 'shipper-1')
      .set('x-user-role', 'SHIPPER')
      .send(validAuctionPayload())
      .expect(201);

    const auctionId = createRes.body.data.id as string;
    expect(createRes.body.data.registrationOpen).toBe(false);
    expect(createRes.body.data.creationFeeAmount).toBe('50000');
    expect(wallet.balanceOf('shipper-1')).toBe(950_000);

    // 2. Carrier cannot register before registrationStartTime
    await request(app.getHttpServer())
      .post(`/api/v1/bidding/auctions/${auctionId}/registrations`)
      .set('x-user-id', 'carrier-1')
      .set('x-user-role', 'CARRIER')
      .send({ vehicleId: 'veh-1', idempotencyKey: 'reg-key-0001' })
      .expect(409);
    expect(wallet.balanceOf('carrier-1')).toBe(500_000);

    // 3. Updating registrationStartTime past registrationEndTime is rejected by ValidationPipe -> update()
    await request(app.getHttpServer())
      .patch(`/api/v1/bidding/auctions/${auctionId}`)
      .set('x-user-id', 'shipper-1')
      .set('x-user-role', 'SHIPPER')
      .send({
        registrationStartTime: new Date(
          Date.now() + 100 * 60_000,
        ).toISOString(),
      })
      .expect(400);

    // 4. Updating maxPrice across creation fee tier is rejected; within same tier preserves creationFeeAmount
    await request(app.getHttpServer())
      .patch(`/api/v1/bidding/auctions/${auctionId}`)
      .set('x-user-id', 'shipper-1')
      .set('x-user-role', 'SHIPPER')
      .send({ maxPrice: '60000000' })
      .expect(409);

    const updateOk = await request(app.getHttpServer())
      .patch(`/api/v1/bidding/auctions/${auctionId}`)
      .set('x-user-id', 'shipper-1')
      .set('x-user-role', 'SHIPPER')
      .send({ maxPrice: '8000000' })
      .expect(200);
    expect(updateOk.body.data.creationFeeAmount).toBe('50000');

    // 5. Updating registrationStartTime to an open window lets carrier register normally
    const openWindow = await request(app.getHttpServer())
      .patch(`/api/v1/bidding/auctions/${auctionId}`)
      .set('x-user-id', 'shipper-1')
      .set('x-user-role', 'SHIPPER')
      .send({
        registrationStartTime: new Date(Date.now() - 60_000).toISOString(),
      })
      .expect(200);
    expect(openWindow.body.data.registrationOpen).toBe(true);
    expect(openWindow.body.data.participationFeeAmount).toBe('50000');

    await request(app.getHttpServer())
      .post(`/api/v1/bidding/auctions/${auctionId}/registrations`)
      .set('x-user-id', 'carrier-1')
      .set('x-user-role', 'CARRIER')
      .send({ vehicleId: 'veh-1', idempotencyKey: 'reg-key-0002' })
      .expect(201);
    expect(wallet.balanceOf('carrier-1')).toBe(450_000);

    // 6. When no carrier signs, refund returns exact 50,000 originally charged
    const auctionDoc = auctions.get(auctionId);
    await (awardService as any).finishWithoutCarrier(auctionDoc);
    expect(wallet.balanceOf('shipper-1')).toBe(1_000_000);
    expect(auctionDoc.creationFeeStatus).toBe(CreationFeeStatus.REFUNDED);
  });

  it('refunds charged participation fee on DB save failure and prevents double-charge on retry or recovers via saga', async () => {
    wallet.seed('shipper-1', 1_000_000);
    wallet.seed('carrier-1', 500_000);
    wallet.seed('carrier-2', 500_000);

    const now = Date.now();
    const createRes = await request(app.getHttpServer())
      .post('/api/v1/bidding/auctions')
      .set('x-user-id', 'shipper-1')
      .set('x-user-role', 'SHIPPER')
      .send(
        validAuctionPayload({
          registrationStartTime: new Date(now - 5 * 60_000).toISOString(),
        }),
      )
      .expect(201);

    const auctionId = createRes.body.data.id as string;
    expect(createRes.body.data.registrationOpen).toBe(true);

    // Carrier 1: save fails after wallet.charge -> immediate refund returns balance to 500,000
    failNextRegistrationSaveCalls = 1;
    await request(app.getHttpServer())
      .post(`/api/v1/bidding/auctions/${auctionId}/registrations`)
      .set('x-user-id', 'carrier-1')
      .set('x-user-role', 'CARRIER')
      .send({ vehicleId: 'veh-1', idempotencyKey: 'reg-c1-0001' })
      .expect(500);

    expect(wallet.balanceOf('carrier-1')).toBe(500_000);
    const c1Reg = Array.from(registrations.values()).find(
      (r) => r.carrierId === 'carrier-1',
    );
    expect(c1Reg.paymentStatus).toBe(RegistrationPaymentStatus.FAILED);
    expect(c1Reg.participationFeeStatus).toBe(
      ParticipationFeeStatus.COMPENSATED,
    );

    // Carrier 2: save fails AND immediate refund fails -> stays PAID, retry does not double-charge
    failNextRegistrationSaveCalls = 1;
    wallet.failNextRefund = true;
    await request(app.getHttpServer())
      .post(`/api/v1/bidding/auctions/${auctionId}/registrations`)
      .set('x-user-id', 'carrier-2')
      .set('x-user-role', 'CARRIER')
      .send({ vehicleId: 'veh-2', idempotencyKey: 'reg-c2-0001' })
      .expect(500);

    expect(wallet.balanceOf('carrier-2')).toBe(480_000);
    const c2Reg = Array.from(registrations.values()).find(
      (r) => r.carrierId === 'carrier-2',
    );
    expect(c2Reg.participationFeeStatus).toBe(ParticipationFeeStatus.PAID);
    expect(c2Reg.paymentErrorCode).toBe(
      'PARTICIPATION_FEE_COMPENSATION_PENDING',
    );

    const retryRes = await request(app.getHttpServer())
      .post(
        `/api/v1/bidding/auctions/${auctionId}/registrations/${c2Reg._id}/retry-payment`,
      )
      .set('x-user-id', 'carrier-2')
      .set('x-user-role', 'CARRIER')
      .send({ idempotencyKey: 'retry-c2-0001' })
      .expect(201);

    expect(retryRes.body.data.paymentStatus).toBe(
      RegistrationPaymentStatus.COMPLETED,
    );
    expect(wallet.balanceOf('carrier-2')).toBe(480_000);

    // If a FAILED+PAID registration is not retried, BiddingSagaService.runSweep() refunds it cleanly
    wallet.seed('carrier-3', 500_000);
    await wallet.charge('carrier-3', {
      amount: '20000',
      idempotencyKey: 'reg-c3:fee:charge',
    });
    wrapRegistration({
      _id: 'reg-c3',
      auctionId,
      carrierId: 'carrier-3',
      vehicleId: 'veh-3',
      paymentStatus: RegistrationPaymentStatus.FAILED,
      participationFeeStatus: ParticipationFeeStatus.PAID,
      participationFeeAmount: Types.Decimal128.fromString('20000'),
      participationFeeTransactionId: 'tx-c3-charge',
      paymentErrorCode: 'PARTICIPATION_FEE_COMPENSATION_PENDING',
      paymentAttempt: 0,
    });

    await sagaService.runSweep();

    expect(wallet.balanceOf('carrier-3')).toBe(500_000);
    expect(registrations.get('reg-c3').participationFeeStatus).toBe(
      ParticipationFeeStatus.COMPENSATED,
    );
  });
});
