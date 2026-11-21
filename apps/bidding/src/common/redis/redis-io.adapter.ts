import { INestApplicationContext, Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import type { Server } from 'socket.io';

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor: ReturnType<typeof createAdapter> | null = null;
  private pubClient: Redis | null = null;
  private subClient: Redis | null = null;

  constructor(
    appOrHttpServer: INestApplicationContext,
    private readonly redisUrl?: string,
  ) {
    super(appOrHttpServer);
  }

  async connectToRedis(): Promise<void> {
    const rawUrl = this.redisUrl?.trim();
    if (!rawUrl) {
      this.logger.log(
        'REDIS_URL not set; Socket.IO running in single-node mode',
      );
      return;
    }

    const pub = new Redis(rawUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    const sub = pub.duplicate();
    pub.on('error', (err) =>
      this.logger.warn(`Socket.IO Redis pub error: ${err.message}`),
    );
    sub.on('error', (err) =>
      this.logger.warn(`Socket.IO Redis sub error: ${err.message}`),
    );

    try {
      await Promise.all([pub.connect(), sub.connect()]);
      this.pubClient = pub;
      this.subClient = sub;
      this.adapterConstructor = createAdapter(pub, sub);
      this.logger.log('Socket.IO Redis adapter connected for multi-pod fanout');
    } catch (err) {
      this.logger.warn(
        `Failed to connect Socket.IO Redis adapter (${err instanceof Error ? err.message : String(err)}), falling back to single-node mode`,
      );
      await Promise.allSettled([pub.quit(), sub.quit()]);
    }
  }

  override createIOServer(port: number, options?: any): any {
    const server = super.createIOServer(port, options);
    if (this.adapterConstructor) {
      server.adapter(this.adapterConstructor);
    }
    return server;
  }

  override async close(server?: Server): Promise<void> {
    try {
      if (server) {
        await super.close(server);
      }
    } finally {
      await Promise.allSettled([
        this.pubClient ? this.pubClient.quit() : Promise.resolve(),
        this.subClient ? this.subClient.quit() : Promise.resolve(),
      ]);
      this.pubClient = null;
      this.subClient = null;
    }
  }
}
