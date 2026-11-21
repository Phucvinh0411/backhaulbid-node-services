import { NestFactory } from '@nestjs/core';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';
import { configureOpenApi } from './openapi';
import { TransformInterceptor } from './core/interceptors/transform.interceptor';
import { RedisIoAdapter } from './common/redis/redis-io.adapter';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const configService = app.get(ConfigService);
  const redisIoAdapter = new RedisIoAdapter(
    app,
    configService.get<string>('REDIS_URL'),
  );
  await redisIoAdapter.connectToRedis();
  app.useWebSocketAdapter(redisIoAdapter);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalInterceptors(new TransformInterceptor());
  if (configService.getOrThrow<string>('SWAGGER_ENABLED') === 'true') {
    configureOpenApi(app, configService);
  }
  const rabbitUrl = configService.get<string>('RABBITMQ_URL');
  if (rabbitUrl) {
    app.connectMicroservice({
      transport: Transport.RMQ,
      options: {
        urls: [rabbitUrl],
        queue: 'contract.award.updated.queue',
        queueOptions: { durable: true },
        noAck: false,
        prefetchCount: 10,
      },
    });
  }
  app.setGlobalPrefix('api/v1/bidding');
  const port = configService.getOrThrow<string>('PORT');
  await app.listen(port);
  logger.log(`bidding service is running on port ${port}`);
  if (rabbitUrl) {
    try {
      await app.startAllMicroservices();
      logger.log(
        `RabbitMQ consumer connected — listening 'contract.award.updated.queue'`,
      );
    } catch (error) {
      logger.warn(
        `RabbitMQ consumer unavailable at startup, 30s award fallback active: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  console.log('bidding service is running');
}
void bootstrap();
