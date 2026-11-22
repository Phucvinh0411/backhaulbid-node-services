import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveInternalHttpTimeoutMs } from '../internal-http-timeout';

export interface CarrierVehicle {
  id: string;
  licensePlate: string;
  vehicleType: string;
  bodyType?: string | null;
  payloadCapacity?: number | string | null;
  status: string;
}

@Injectable()
export class CarrierVehicleClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    this.baseUrl = config
      .getOrThrow<string>('FLEET_SERVICE_URL')
      .replace(/\/$/, '');
    this.timeoutMs = resolveInternalHttpTimeoutMs(config);
  }

  async listByCarrier(carrierId: string): Promise<CarrierVehicle[]> {
    let response: Response;
    try {
      response = await fetch(
        `${this.baseUrl}/api/v1/vehicles/carrier/${encodeURIComponent(carrierId)}`,
        {
          headers: {
            'X-User-Id': carrierId,
            'X-User-Role': 'CARRIER',
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch (error) {
      throw new ServiceUnavailableException(
        `Fleet service is unavailable: ${error instanceof Error ? error.message : 'network error'}`,
      );
    }

    const payload = (await response.json().catch(() => null)) as unknown;
    if (response.status === 400) {
      throw new BadRequestException({
        code: 'INVALID_CARRIER_ID',
        message: 'Định danh nhà xe không hợp lệ',
      });
    }
    if (!response.ok || !Array.isArray(payload)) {
      const message =
        typeof payload === 'object' &&
        payload !== null &&
        'message' in payload &&
        typeof (payload as { message?: unknown }).message === 'string'
          ? (payload as { message: string }).message
          : 'Fleet service returned an invalid vehicle list';
      throw new ServiceUnavailableException(message);
    }
    return payload as CarrierVehicle[];
  }

  async assertVerifiedVehicle(
    carrierId: string,
    vehicleId: string,
  ): Promise<CarrierVehicle> {
    const normalizedId = vehicleId.trim().toLowerCase();
    const vehicles = await this.listByCarrier(carrierId);
    // ponytail: web AuctionRegistrationDialog and mobile CarrierAuctionRoom allow any VERIFIED vehicle owned by the carrier without filtering vehicleType or payloadCapacity (fleet records also mix kg and tons).
    const vehicle = vehicles.find(
      (item) =>
        typeof item?.id === 'string' && item.id.toLowerCase() === normalizedId,
    );
    if (!vehicle) {
      throw new BadRequestException({
        code: 'VEHICLE_NOT_OWNED',
        message: 'Phương tiện đã chọn không thuộc đội xe của nhà xe hiện tại',
      });
    }
    if (vehicle.status !== 'VERIFIED') {
      throw new BadRequestException({
        code: 'VEHICLE_NOT_VERIFIED',
        message:
          'Chỉ phương tiện đã được xác minh mới được đăng ký tham gia đấu giá',
      });
    }
    return vehicle;
  }
}
