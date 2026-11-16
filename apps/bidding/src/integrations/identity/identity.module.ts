import { Module } from '@nestjs/common';
import { CarrierCoverageClient } from './carrier-coverage.client';
import { EkycVerificationClient } from './ekyc-verification.client';

@Module({
  providers: [CarrierCoverageClient, EkycVerificationClient],
  exports: [CarrierCoverageClient, EkycVerificationClient],
})
export class IdentityModule {}
