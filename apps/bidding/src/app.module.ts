import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuctionModule } from './modules/auction/auction.module';
import { AuctionRegistrationModule } from './modules/auction-registration/auction-registration.module';
import { BidModule } from './modules/bid/bid.module';
import { BiddingModule } from './modules/bidding/bidding.module';
import { StatisticsModule } from './modules/statistics/statistics.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        uri: config.getOrThrow<string>('MONGO_URI'),
      }),
    }),
    AuctionModule,
    AuctionRegistrationModule,
    BidModule,
    BiddingModule,
    StatisticsModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
