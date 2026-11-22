import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveInternalHttpTimeoutMs } from '../internal-http-timeout';

export const SHIPPER_EKYC_REQUIRED_MESSAGE =
  'Chủ hàng phải hoàn tất xác thực eKYC người đại diện trước khi tạo phiên đấu giá';

export const CARRIER_EKYC_REQUIRED_MESSAGE =
  'Chủ xe phải hoàn tất xác thực eKYC người đại diện trước khi tham gia đấu giá';

export interface EkycEligibilityStatus {
  eligible?: boolean;
  verified?: boolean;
}

/**
 * Queries identity-service to verify whether a shipper or carrier account has completed eKYC.
 * Fails closed when identity-service is unreachable or returns an invalid payload.
 */
@Injectable()
export class EkycVerificationClient {
  private readonly baseUrl: string;
  private readonly internalToken: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .getOrThrow<string>('IDENTITY_SERVICE_URL')
      .replace(/\/$/, '');
    this.internalToken = config.getOrThrow<string>('INTERNAL_SERVICE_TOKEN');
    this.timeoutMs = resolveInternalHttpTimeoutMs(config);
  }

  async isVerified(accountId: string): Promise<boolean> {
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/internal/ekyc-verifications/accounts/${encodeURIComponent(accountId)}/eligibility`,
        {
          headers: { 'x-internal-token': this.internalToken },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      throw new ServiceUnavailableException(
        `Identity service is unavailable: ${error instanceof Error ? error.message : 'network error'}`,
      );
    }

    const payload = (await response.json().catch(() => ({}))) as Partial<EkycEligibilityStatus> & {
      message?: string;
    };
    const verified = payload.verified ?? payload.eligible;
    if (!response.ok || typeof verified !== 'boolean') {
      throw new ServiceUnavailableException(
        payload.message ?? 'Identity service returned an invalid eKYC status',
      );
    }
    return verified;
  }

  async assertShipperVerified(shipperId: string): Promise<void> {
    if (!(await this.isVerified(shipperId))) {
      throw new ForbiddenException({
        code: 'EKYC_REQUIRED',
        message: SHIPPER_EKYC_REQUIRED_MESSAGE,
      });
    }
  }

  async assertCarrierVerified(carrierId: string): Promise<void> {
    if (!(await this.isVerified(carrierId))) {
      throw new ForbiddenException({
        code: 'EKYC_REQUIRED',
        message: CARRIER_EKYC_REQUIRED_MESSAGE,
      });
    }
  }
}

