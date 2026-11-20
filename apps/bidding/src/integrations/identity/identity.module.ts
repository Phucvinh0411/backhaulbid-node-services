import { Module } from '@nestjs/common';
import { AccountVerificationClient } from './account-verification.client';
import { CarrierCoverageClient } from './carrier-coverage.client';
import { EkycVerificationClient } from './ekyc-verification.client';

@Module({
  providers: [AccountVerificationClient, CarrierCoverageClient, EkycVerificationClient],
  exports: [AccountVerificationClient, CarrierCoverageClient, EkycVerificationClient],
})
export class IdentityModule {}
