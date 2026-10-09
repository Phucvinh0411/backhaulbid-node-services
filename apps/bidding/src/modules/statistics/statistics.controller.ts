import { Controller, ForbiddenException, Get, Headers, Query, UnauthorizedException } from '@nestjs/common';
import { StatisticsService } from './statistics.service';

@Controller('statistics')
export class StatisticsController {
  constructor(private readonly statistics: StatisticsService) {}

  @Get('me')
  mine(
    @Headers('x-user-id') actorId: string | undefined,
    @Headers('x-user-role') role: string | undefined,
    @Query() query: { dateFrom?: string; dateTo?: string; bucket?: string },
  ) {
    if (!actorId) throw new UnauthorizedException('Authenticated account is required');
    if (!['SHIPPER', 'CARRIER'].includes((role || '').toUpperCase())) throw new ForbiddenException('Statistics are available to shippers and carriers');
    return this.statistics.mine(actorId, role, query);
  }

  @Get('admin')
  admin(
    @Headers('x-user-role') role: string | undefined,
    @Query() query: { dateFrom?: string; dateTo?: string; bucket?: string },
  ) {
    if ((role || '').toUpperCase() !== 'ADMIN') throw new ForbiddenException('Administrator role is required');
    return this.statistics.admin(role, query);
  }
}
