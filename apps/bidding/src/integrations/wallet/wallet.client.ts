import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface WalletOperationInput {
  auctionId: string;
  registrationId?: string;
  amount: string;
  purpose: string;
  idempotencyKey: string;
}

export interface WalletOperationResult {
  status: string;
  transactionId: string;
  holdId?: string;
  amount: string;
  message?: string;
}

export class WalletClientError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'WalletClientError';
  }
}

@Injectable()
export class WalletClient {
  private readonly baseUrl: string;
  private readonly internalToken: string;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .getOrThrow<string>('WALLET_SERVICE_URL')
      .replace(/\/$/, '');
    this.internalToken = config.getOrThrow<string>('INTERNAL_WALLET_TOKEN');
  }

  hold(accountId: string, input: WalletOperationInput) {
    return this.request(`/internal/wallets/${accountId}/holds`, input).then(
      (operation) => ({
        ...operation,
        // Wallet Service uses the successful freeze transaction as the hold
        // record. Keep older wallet deployments compatible with that contract.
        holdId: operation.holdId ?? operation.transactionId,
      }),
    );
  }

  charge(accountId: string, input: WalletOperationInput) {
    return this.request(`/internal/wallets/${accountId}/charges`, input);
  }

  refund(accountId: string, input: WalletOperationInput) {
    return this.request(`/internal/wallets/${accountId}/refunds`, input);
  }

  release(holdId: string, idempotencyKey: string) {
    return this.request(`/internal/wallet-holds/${holdId}/release`, {
      idempotencyKey,
    });
  }

  forfeit(holdId: string, idempotencyKey: string) {
    return this.request(`/internal/wallet-holds/${holdId}/forfeit`, {
      idempotencyKey,
    });
  }

  private async request(
    path: string,
    body: unknown,
  ): Promise<WalletOperationResult> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.internalToken
            ? { 'x-internal-token': this.internalToken }
            : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        `Wallet service is unavailable: ${error instanceof Error ? error.message : 'network error'}`,
      );
    }

    const payload = (await response
      .json()
      .catch(() => ({}))) as Partial<WalletOperationResult> & {
      message?: string;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new WalletClientError(
        payload.error?.message ??
          payload.message ??
          `Wallet operation failed with status ${response.status}`,
        response.status,
      );
    }
    if (!payload.transactionId || !payload.status) {
      throw new ServiceUnavailableException(
        'Wallet service returned an invalid response',
      );
    }
    return payload as WalletOperationResult;
  }
}
