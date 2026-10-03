import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class AuctionNotificationClient {
  private readonly logger = new Logger(AuctionNotificationClient.name);
  private readonly baseUrl: string;
  private readonly internalToken: string;

  constructor(config: ConfigService) {
    this.baseUrl = (config.get<string>('NOTIFICATION_SERVICE_URL') ?? 'http://backhaulbid-notification-service:3002').replace(/\/$/, '');
    this.internalToken = config.getOrThrow<string>('INTERNAL_SERVICE_TOKEN');
  }

  async notify(input: {
    userId: string;
    title: string;
    message: string;
    auctionId: string;
    dedupeKey: string;
    type: string;
  }) {
    try {
      const response = await fetch(`${this.baseUrl}/api/v1/notifications/internal/create`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': this.internalToken,
        },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({
          userId: input.userId,
          title: input.title,
          message: input.message,
          referenceId: input.auctionId,
          dedupeKey: input.dedupeKey,
          type: input.type,
        }),
      });
      if (!response.ok) {
        this.logger.warn(`Notification request failed (${response.status}) for ${input.dedupeKey}`);
      }
    } catch (error) {
      this.logger.warn(`Notification request failed for ${input.dedupeKey}: ${error instanceof Error ? error.message : 'network error'}`);
    }
  }
}
