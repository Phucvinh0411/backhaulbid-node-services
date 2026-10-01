import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { NotificationGateway } from './notification.gateway.js';
import type { MilestoneReachedEvent } from './dto/milestone-reached.event.js';

@Controller()
export class MilestoneConsumer {
  private readonly logger = new Logger(MilestoneConsumer.name);

  constructor(private readonly gateway: NotificationGateway) {}

  /**
   * Lắng nghe RabbitMQ routing key: 'trip.milestone.reached'
   *
   * Spring Boot publish → RabbitMQ → NestJS consumer → Socket.io emit
   * đến room của Shipper và Carrier.
   */
  @MessagePattern('trip.milestone.reached')
  async handleMilestoneReached(
    @Payload() event: MilestoneReachedEvent,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      this.logger.log(
        `[RabbitMQ] trip.milestone.reached | trip=${event.tripId} | milestone="${event.milestoneName}"`,
      );

      const socketPayload = {
        milestoneId:   event.milestoneId,
        tripId:        event.tripId,
        milestoneName: event.milestoneName,
        status:        'REACHED',
        location: {
          lat: event.actualLat,
          lng: event.actualLng,
        },
        reachedAt: event.reachedAt,
      };

      // Emit tới Chủ hàng (Shipper) — room đã được join khi kết nối WS
      this.gateway.emitMilestoneUpdated(event.shipperId, socketPayload);
      // Emit tới Chủ xe (Carrier)
      this.gateway.emitMilestoneUpdated(event.carrierId, socketPayload);

      // ACK sau khi xử lý thành công
      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error(
        `[RabbitMQ] Failed to handle milestone event: ${(error as Error).message}`,
      );
      // NACK — đưa message về queue để retry
      channel.nack(originalMsg, false, true);
    }
  }
}
