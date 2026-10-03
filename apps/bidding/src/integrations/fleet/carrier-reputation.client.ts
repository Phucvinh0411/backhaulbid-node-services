import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const MINIMUM_AUCTION_REPUTATION_SCORE = 70;

export interface CarrierReputation {
  carrierId: string;
  score: number;
}

@Injectable()
export class CarrierReputationClient {
  private readonly baseUrl: string;
  private readonly internalToken: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('FLEET_SERVICE_URL').replace(/\/$/, '');
    this.internalToken = config.getOrThrow<string>('INTERNAL_SERVICE_TOKEN');
  }

  async getScore(carrierId: string): Promise<number> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/internal/carrier-reputations/${carrierId}`, {
        headers: { 'x-internal-token': this.internalToken },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `Fleet service is unavailable: ${error instanceof Error ? error.message : 'network error'}`,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as Partial<CarrierReputation> & { message?: string };
    if (!response.ok || typeof payload.score !== 'number') {
      throw new ServiceUnavailableException(payload.message ?? 'Fleet service returned an invalid reputation score');
    }
    return payload.score;
  }

  async assertEligible(carrierId: string): Promise<number> {
    const score = await this.getScore(carrierId);
    if (score < MINIMUM_AUCTION_REPUTATION_SCORE) {
      throw new ForbiddenException({
        code: 'REPUTATION_TOO_LOW',
        message: `Cần tối thiểu ${MINIMUM_AUCTION_REPUTATION_SCORE} điểm uy tín để tham gia đấu giá`,
        reputationScore: score,
        minimumReputationScore: MINIMUM_AUCTION_REPUTATION_SCORE,
      });
    }
    return score;
  }
}
