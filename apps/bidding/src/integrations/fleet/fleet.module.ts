import { Module } from '@nestjs/common';
import { CarrierReputationClient } from './carrier-reputation.client';
import { CarrierVehicleClient } from './carrier-vehicle.client';

@Module({
  providers: [CarrierReputationClient, CarrierVehicleClient],
  exports: [CarrierReputationClient, CarrierVehicleClient],
})
export class FleetModule {}
