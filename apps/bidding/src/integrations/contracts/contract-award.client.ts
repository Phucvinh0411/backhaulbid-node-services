import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ContractAwardInput {
  auctionId: string;
  awardAttemptId: string;
  winningBidId: string;
  shipperId: string;
  carrierId: string;
  vehicleId: string;
  pickupLocation: string;
  deliveryLocation: string;
  agreedPrice: string;
  expectedDeliveryAt: string | null;
  depositHoldId: string | null;
  depositAmount: string | null;
  signingDeadlineAt: string;
}

export interface ContractAwardResult {
  auctionId: string;
  tripId: string;
  contractId: string;
  latePolicyEnabled: boolean;
}

export interface ContractAwardAttemptStatus {
  auctionId: string;
  awardAttemptId: string;
  tripId: string;
  contractId: string;
  status: 'DRAFT' | 'WAITING_SIGNATURE' | 'SIGNED' | 'CANCELLED' | 'EXPIRED';
  carrierSigned: boolean;
  shipperSigned: boolean;
  signingDeadlineAt: string | null;
}

@Injectable()
export class ContractAwardClient {
  private readonly baseUrl: string;
  private readonly internalToken: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('CONTRACT_SERVICE_URL').replace(/\/$/, '');
    this.internalToken = config.getOrThrow<string>('INTERNAL_SERVICE_TOKEN');
  }

  async create(input: ContractAwardInput): Promise<ContractAwardResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/internal/auction-awards`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-internal-token': this.internalToken,
        },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify(input),
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `Contract service is unavailable: ${error instanceof Error ? error.message : 'network error'}`,
      );
    }
    const payload = (await response.json().catch(() => ({}))) as Partial<ContractAwardResult> & { message?: string };
    if (!response.ok || !payload.tripId || !payload.contractId) {
      throw new ServiceUnavailableException(payload.message ?? `Contract award failed with status ${response.status}`);
    }
    return payload as ContractAwardResult;
  }

  status(awardAttemptId: string) {
    return this.request<ContractAwardAttemptStatus>(`/${encodeURIComponent(awardAttemptId)}`, 'GET');
  }

  expire(awardAttemptId: string) {
    return this.request<ContractAwardAttemptStatus>(`/${encodeURIComponent(awardAttemptId)}/expire`, 'POST');
  }

  private async request<T>(path: string, method: 'GET' | 'POST'): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/internal/auction-awards${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          'x-internal-token': this.internalToken,
        },
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `Contract service is unavailable: ${error instanceof Error ? error.message : 'network error'}`,
      );
    }
    const payload = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new ServiceUnavailableException(payload.message ?? `Contract service returned status ${response.status}`);
    }
    return payload;
  }
}
