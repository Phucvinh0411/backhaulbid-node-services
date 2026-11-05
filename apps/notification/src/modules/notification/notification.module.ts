import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import {
  Notification,
  NotificationSchema,
} from './schemas/notification.schema.js';
import { NotificationService } from './notification.service.js';
import { NotificationController } from './notification.controller.js';
import { NotificationGateway } from './notification.gateway.js';
import { TripLocationConsumer } from './trip-location.consumer.js';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Notification.name, schema: NotificationSchema },
    ]),
  ],
  controllers: [NotificationController, TripLocationConsumer],
  providers: [NotificationService, NotificationGateway],
  exports: [NotificationService],
})
export class NotificationModule {}

