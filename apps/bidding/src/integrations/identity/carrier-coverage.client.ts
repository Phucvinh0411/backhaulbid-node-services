import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export const CARGO_COVERAGE_REQUIRED_MESSAGE =
  'Đấu giá này yêu cầu nhà xe có chứng từ bảo hiểm trách nhiệm hàng hóa còn hiệu lực đã được xác minh';

export interface CarrierCoverageStatus {
  eligible: boolean;
}

/**
 * Asks identity-service whether a carrier holds an admin-verified, unexpired cargo-liability certificate.
 * Any failure to get a clear answer fails closed: the bid is refused, never accepted.
 */
@Injectable()
export class CarrierCoverageClient {
  private readonly baseUrl: string;
  private readonly internalToken: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.getOrThrow<string>('IDENTITY_SERVICE_URL').replace(/\/$/, '');
    this.internalToken = config.getOrThrow<string>('INTERNAL_SERVICE_TOKEN');
  }

  async isEligible(carrierId: string): Promise<boolean> {
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/internal/cargo-liability/accounts/${encodeURIComponent(carrierId)}/eligibility`,
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

    const payload = (await response.json().catch(() => ({}))) as Partial<CarrierCoverageStatus> & {
      message?: string;
    };
    if (!response.ok || typeof payload.eligible !== 'boolean') {
      throw new ServiceUnavailableException(
        payload.message ?? 'Identity service returned an invalid coverage status',
      );
    }
    return payload.eligible;
  }

  async assertEligible(carrierId: string): Promise<void> {
    if (!(await this.isEligible(carrierId))) {
      throw new ForbiddenException({
        code: 'CARRIER_COVERAGE_REQUIRED',
        message: CARGO_COVERAGE_REQUIRED_MESSAGE,
      });
    }
  }
}
