import { Module } from '@nestjs/common';
import { AuctionController } from './auction.controller';
import { AuctionService } from './auction.service';
import { MongooseModule } from '@nestjs/mongoose';
import { Auction, AuctionSchema } from './schemas/auction.schema';
import { AuctionRepository } from './auction.repository';

import { Bid, BidSchema } from '../bid/schemas/bid.schema';
import { BiddingEventsModule } from '../bidding/bidding-events.module';

import { WalletModule } from '../../integrations/wallet/wallet.module';
import { ContractsModule } from '../../integrations/contracts/contracts.module';
import { AuctionAwardService } from './auction-award.service';
import { AuctionRegistration, AuctionRegistrationSchema } from '../auction-registration/schemas/auction-registration.schema';
import { AuctionNotificationClient } from '../../integrations/notifications/auction-notification.client';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Auction.name, schema: AuctionSchema },
      { name: Bid.name, schema: BidSchema },
      { name: AuctionRegistration.name, schema: AuctionRegistrationSchema },
    ]),
    WalletModule,
    ContractsModule,
    BiddingEventsModule,
  ],
  controllers: [AuctionController],
  providers: [AuctionRepository, AuctionService, AuctionAwardService, AuctionNotificationClient],
  exports: [AuctionService],
})
export class AuctionModule {}


