import {
  ForbiddenException,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisCacheService } from '../../common/redis/redis-cache.service';

export const EKYC_REQUIRED_MESSAGE =
  'Tài khoản cần hoàn tất xác thực định danh người đại diện (eKYC) trước khi thực hiện thao tác này';

export const ACCOUNT_VERIFICATION_REQUIRED_MESSAGE =
  'Tài khoản cần hoàn tất xác thực eKYC và xác thực doanh nghiệp trước khi thực hiện thao tác này';

export interface AccountVerificationStatus {
  ekycVerified: boolean;
  businessVerified: boolean;
  fullyVerified: boolean;
}

/**
 * Asks identity-service whether an account has completed both eKYC and business verification.
 * Any failure to get a clear answer fails closed: the action is refused, never accepted.
 */
@Injectable()
export class AccountVerificationClient {
  private readonly baseUrl: string;
  private readonly internalToken: string;

  constructor(
    config: ConfigService,
    @Optional() private readonly cache?: RedisCacheService,
  ) {
    this.baseUrl = config
      .getOrThrow<string>('IDENTITY_SERVICE_URL')
      .replace(/\/$/, '');
    this.internalToken = config.getOrThrow<string>('INTERNAL_SERVICE_TOKEN');
  }

  async getStatus(accountId: string): Promise<AccountVerificationStatus> {
    const fetchStatus = async (): Promise<AccountVerificationStatus> => {
      let response: Response;
      try {
        response = await fetch(
          `${this.baseUrl}/internal/accounts/${encodeURIComponent(accountId)}/verification-status`,
          {
            headers: { 'x-internal-token': this.internalToken },
            signal: AbortSignal.timeout(5000),
          },
        );
      } catch (error) {
        throw new ServiceUnavailableException(
          `Identity service is unavailable: ${error instanceof Error ? error.message : 'network error'}`,
        );
      }

      const payload = (await response
        .json()
        .catch(() => ({}))) as Partial<AccountVerificationStatus> & {
        message?: string;
      };
      if (!response.ok || typeof payload.fullyVerified !== 'boolean') {
        throw new ServiceUnavailableException(
          payload.message ??
            'Identity service returned an invalid verification status',
        );
      }
      return {
        ekycVerified: Boolean(payload.ekycVerified),
        businessVerified: Boolean(payload.businessVerified),
        fullyVerified: payload.fullyVerified,
      };
    };

    if (!this.cache) return fetchStatus();
    return this.cache.getOrSet(
      `bidding:verify:${accountId}`,
      15_000,
      fetchStatus,
    );
  }

  async isVerified(accountId: string): Promise<boolean> {
    const status = await this.getStatus(accountId);
    return status.fullyVerified;
  }

  async assertVerified(accountId: string): Promise<void> {
    const status = await this.getStatus(accountId);
    if (!status.ekycVerified) {
      throw new ForbiddenException({
        code: 'EKYC_REQUIRED',
        message: EKYC_REQUIRED_MESSAGE,
        ekycVerified: false,
        businessVerified: status.businessVerified,
      });
    }
    if (!status.fullyVerified) {
      throw new ForbiddenException({
        code: 'ACCOUNT_VERIFICATION_REQUIRED',
        message: ACCOUNT_VERIFICATION_REQUIRED_MESSAGE,
        ekycVerified: status.ekycVerified,
        businessVerified: status.businessVerified,
      });
    }
  }
}
