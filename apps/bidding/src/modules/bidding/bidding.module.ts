import { Module } from '@nestjs/common';
import { AuctionRegistrationModule } from '../auction-registration/auction-registration.module';
import { AuctionModule } from '../auction/auction.module';
import { BidModule } from '../bid/bid.module';
import { IdentityModule } from '../../integrations/identity/identity.module';
import { BiddingEventsModule } from './bidding-events.module';
import { BiddingGateway } from './bidding.gateway';

@Module({
  imports: [
    AuctionRegistrationModule,
    AuctionModule,
    BidModule,
    IdentityModule,
    BiddingEventsModule,
  ],
  providers: [BiddingGateway],
  exports: [BiddingGateway],
})
export class BiddingModule {}
