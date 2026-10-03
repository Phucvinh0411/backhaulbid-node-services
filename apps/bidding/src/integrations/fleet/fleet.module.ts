import { Module } from '@nestjs/common';
import { CarrierReputationClient } from './carrier-reputation.client';

@Module({
  providers: [CarrierReputationClient],
  exports: [CarrierReputationClient],
})
export class FleetModule {}
