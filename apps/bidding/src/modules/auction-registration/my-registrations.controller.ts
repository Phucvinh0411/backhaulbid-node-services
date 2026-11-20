import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import { BEARER_AUTH } from '../../openapi';
import { AuctionRegistrationService } from './auction-registration.service';
import { ListMyRegistrationsQueryDto } from './dto/list-my-registrations-query.dto';

@Controller('my-registrations')
@ApiBearerAuth(BEARER_AUTH)
export class MyRegistrationsController {
  constructor(
    private readonly auctionRegistrationService: AuctionRegistrationService,
  ) {}

  @Get('access')
  batchAccess(
    @Headers('x-user-id') carrierId: string | undefined,
    @Headers('x-user-role') role: string | undefined,
    @Query('auctionIds') auctionIds?: string | string[],
  ) {
    if (!carrierId)
      throw new UnauthorizedException('Authenticated carrier is required');
    if ((role || '').toUpperCase() !== 'CARRIER') {
      throw new ForbiddenException('Required role: CARRIER');
    }
    const raw = Array.isArray(auctionIds)
      ? auctionIds.join(',')
      : (auctionIds ?? '');
    const ids = Array.from(
      new Set(
        raw
          .split(',')
          .map((id) => id.trim())
          .filter((id) => id.length > 0),
      ),
    ).slice(0, 200);
    if (ids.length === 0) return {};
    return this.auctionRegistrationService.getBatchAccess(ids, carrierId);
  }

  @Get()
  list(
    @Headers('x-user-id') carrierId: string | undefined,
    @Query() query: ListMyRegistrationsQueryDto,
  ) {
    if (!carrierId)
      throw new UnauthorizedException('Authenticated carrier is required');
    return this.auctionRegistrationService.listMine(carrierId, query);
  }
}
