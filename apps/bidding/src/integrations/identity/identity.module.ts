import { Module } from '@nestjs/common';
import { CarrierCoverageClient } from './carrier-coverage.client';

@Module({
  providers: [CarrierCoverageClient],
  exports: [CarrierCoverageClient],
})
export class IdentityModule {}
