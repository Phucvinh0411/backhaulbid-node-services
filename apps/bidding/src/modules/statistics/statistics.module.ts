import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Auction, AuctionSchema } from '../auction/schemas/auction.schema';
import { AuctionRegistration, AuctionRegistrationSchema } from '../auction-registration/schemas/auction-registration.schema';
import { StatisticsController } from './statistics.controller';
import { StatisticsService } from './statistics.service';

@Module({
  imports: [MongooseModule.forFeature([
    { name: Auction.name, schema: AuctionSchema },
    { name: AuctionRegistration.name, schema: AuctionRegistrationSchema },
  ])],
  controllers: [StatisticsController],
  providers: [StatisticsService],
})
export class StatisticsModule {}
