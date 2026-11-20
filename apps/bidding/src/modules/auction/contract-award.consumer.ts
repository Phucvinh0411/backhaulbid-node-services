import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  EventPattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { AuctionAwardService } from './auction-award.service';

export interface ContractAwardUpdatedEvent {
  awardAttemptId?: string;
  contractId?: string;
  tripId?: string;
  status?: string;
  occurredAt?: string;
  data?: {
    awardAttemptId?: string;
    contractId?: string;
    tripId?: string;
    status?: string;
  };
}

@Controller()
export class ContractAwardConsumer {
  private readonly logger = new Logger(ContractAwardConsumer.name);

  constructor(private readonly awardService: AuctionAwardService) {}

  @EventPattern('contract.award.updated')
  async handleContractAwardUpdated(
    @Payload() rawEvent: ContractAwardUpdatedEvent,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      const event = rawEvent?.data ?? rawEvent;
      const attemptId = event?.awardAttemptId?.trim();
      if (attemptId) {
        await this.awardService.handleAwardAttemptEvent(attemptId);
      }
    } catch (error) {
      // ponytail: ack and let the 30s Saga reconciliation loop retry transient downstream errors
      // instead of requeuing in a tight AMQP redelivery storm.
      this.logger.warn(
        `[AwardSaga] Deferred RabbitMQ award event to fallback sweep: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      channel.ack(originalMsg);
    }
  }
}
