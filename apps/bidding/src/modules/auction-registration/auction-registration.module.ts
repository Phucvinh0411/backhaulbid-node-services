import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuctionModule } from '../auction/auction.module';
import { WalletModule } from '../../integrations/wallet/wallet.module';
import { FleetModule } from '../../integrations/fleet/fleet.module';
import { AuctionRegistrationController } from './auction-registration.controller';
import { MyRegistrationsController } from './my-registrations.controller';
import { AuctionRegistrationService } from './auction-registration.service';
import {
  AuctionRegistration,
  AuctionRegistrationSchema,
} from './schemas/auction-registration.schema';

@Module({
  imports: [
    AuctionModule,
    WalletModule,
    FleetModule,
    MongooseModule.forFeature([
      { name: AuctionRegistration.name, schema: AuctionRegistrationSchema },
    ]),
  ],
  controllers: [AuctionRegistrationController, MyRegistrationsController],
  providers: [AuctionRegistrationService],
  exports: [AuctionRegistrationService],
})
export class AuctionRegistrationModule {}
