import { Controller, Logger } from '@nestjs/common';
import {
  Ctx,
  MessagePattern,
  Payload,
  RmqContext,
} from '@nestjs/microservices';
import { NotificationGateway } from './notification.gateway.js';
import type { TripLocationUpdatedEvent } from './dto/trip-location-updated.event.js';

@Controller()
export class TripLocationConsumer {
  private readonly logger = new Logger(TripLocationConsumer.name);

  constructor(private readonly gateway: NotificationGateway) {}

  /**
   * Lắng nghe RabbitMQ routing key: 'trip.location.updated'
   *
   * Spring Boot publish -> RabbitMQ -> NestJS consumer -> Socket.io emit
   * đến room của Shipper và Carrier để cập nhật vị trí xe theo thời gian thực.
   */
  @MessagePattern('trip.location.updated')
  handleTripLocationUpdated(
    @Payload() rawEvent: TripLocationUpdatedEvent,
    @Ctx() context: RmqContext,
  ): void {
    const channel = context.getChannelRef();
    const originalMsg = context.getMessage();

    try {
      const event = rawEvent?.data ?? rawEvent;
      if (!event?.tripId || !event?.point) {
        channel.ack(originalMsg);
        return;
      }

      const socketPayload = {
        tripId: event.tripId,
        status: event.status ?? null,
        point: event.point,
        heading: event.heading ?? null,
        speedKmh: event.speedKmh ?? null,
      };

      if (event.shipperId) {
        this.gateway.emitTripLocation(event.shipperId, socketPayload);
      }
      if (event.carrierId) {
        this.gateway.emitTripLocation(event.carrierId, socketPayload);
      }

      channel.ack(originalMsg);
    } catch (error) {
      this.logger.error(
        `[RabbitMQ] Failed to handle trip location event: ${(error as Error).message}`,
      );
      channel.nack(originalMsg, false, true);
    }
  }
}

