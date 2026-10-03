import { Module } from '@nestjs/common';
import { ContractAwardClient } from './contract-award.client';

@Module({
  providers: [ContractAwardClient],
  exports: [ContractAwardClient],
})
export class ContractsModule {}
