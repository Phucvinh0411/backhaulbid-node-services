import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transport } from '@nestjs/microservices';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const logger = new Logger('NotificationBootstrap');

  // HTTP + WebSocket (Socket.io) server
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // ⭐ Kết nối thêm RabbitMQ microservice consumer
  // Hybrid app: HTTP/WS + RabbitMQ consumer chạy song song
  app.connectMicroservice({
    transport: Transport.RMQ,
    options: {
      urls: [
        configService.get('RABBITMQ_URL') ??
          'amqp://guest:guest@localhost:5672',
      ],
      queue: 'trip.milestone.reached.queue',
      queueOptions: { durable: true },
      noAck: false,
    },
  });

  app.setGlobalPrefix('api/v1/notifications');

  await app.startAllMicroservices();
  const port = configService.get('NOTIFICATION_PORT') ?? '3002';
  await app.listen(port, '0.0.0.0');
  logger.log(`🔔 Notification service running on port ${port}`);
  logger.log(
    `🐇 RabbitMQ consumer connected — listening 'trip.milestone.reached.queue'`,
  );
}
void bootstrap();
