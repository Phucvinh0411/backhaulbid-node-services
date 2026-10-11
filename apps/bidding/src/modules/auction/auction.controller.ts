import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Param,
  Patch,
  Post,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { Response } from 'express';
import { BEARER_AUTH } from '../../openapi';
import { AuctionService } from './auction.service';
import { CreateAuctionDto } from './dto/create-auction.dto';
import { ListAuctionsQueryDto } from './dto/list-auctions-query.dto';
import { UpdateAuctionDto } from './dto/update-auction.dto';
import { FlagAuctionDto } from './dto/flag-auction.dto';
import { SelectWinnerDto } from './dto/select-winner.dto';
import { CancelAuctionDto } from './dto/cancel-auction.dto';
import { Query } from '@nestjs/common';

@Controller('auctions')
@ApiBearerAuth(BEARER_AUTH)
export class AuctionController {
  constructor(private readonly auctionService: AuctionService) {}

  @Post()
  create(
    @Headers('x-user-id') shipperId: string | undefined,
    @Headers('x-user-role') role: string | undefined,
    @Headers('x-idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateAuctionDto,
  ) {
    if (!shipperId)
      throw new UnauthorizedException('Authenticated shipper is required');
    requireRole(role, 'SHIPPER');
    return this.auctionService.create(shipperId, dto, idempotencyKey);
  }

  @Get()
  list(
    @Headers('x-user-id') actorId: string | undefined,
    @Headers('x-user-role') role: string | undefined,
    @Query() query: ListAuctionsQueryDto,
  ) {
    const normalizedRole = normalizeRole(role);
    if (normalizedRole === 'SHIPPER') {
      requireAuthenticated(actorId);
      return this.auctionService.list({ ...query, shipperId: actorId });
    }
    if (normalizedRole === 'ADMIN' || normalizedRole === 'CARRIER') {
      return this.auctionService.list(query);
    }
    throw new ForbiddenException('Unsupported auction listing role');
  }

  @Get(':auctionId')
  findById(@Param('auctionId') auctionId: string) {
    return this.auctionService.findById(auctionId);
  }

  @Patch(':auctionId')
  update(
    @Param('auctionId') auctionId: string,
    @Headers('x-user-id') actorId: string | undefined,
    @Headers('x-user-role') role: string | undefined,
    @Body() dto: UpdateAuctionDto,
  ) {
    requireAuthenticated(actorId);
    requireRole(role, 'ADMIN', 'SHIPPER');
    return this.auctionService.update(
      auctionId,
      actorId,
      normalizeRole(role),
      dto,
    );
  }

  /** The owner's value-document list and checklist. Other shippers, bidders and drivers get a refusal. */
  @Get(':auctionId/value-documents')
  listValueDocuments(
    @Param('auctionId') auctionId: string,
    @Headers('x-user-id') actorId: string | undefined,
    @Headers('x-user-role') role: string | undefined,
  ) {
    requireAuthenticated(actorId);
    requireRole(role, 'ADMIN', 'SHIPPER');
    return this.auctionService.listValueDocuments(
      auctionId,
      actorId,
      normalizeRole(role),
    );
  }

  /**
   * One value document's bytes, served by the API rather than a storage URL. Bypasses the JSON envelope, so the
   * headers and the body are written directly.
   */
  @Get(':auctionId/value-documents/:documentId/file')
  async valueDocumentFile(
    @Param('auctionId') auctionId: string,
    @Param('documentId') documentId: string,
    @Headers('x-user-id') actorId: string | undefined,
    @Headers('x-user-role') role: string | undefined,
    @Res() response: Response,
  ) {
    requireAuthenticated(actorId);
    requireRole(role, 'ADMIN', 'SHIPPER');
    const file = await this.auctionService.valueDocumentFile(
      auctionId,
      documentId,
      actorId,
      normalizeRole(role),
    );
    response
      .status(200)
      .set({
        'Content-Type': file.contentType,
        'Content-Length': String(file.bytes.length),
        'Content-Disposition': 'inline',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(file.bytes);
  }

  @Post(':auctionId/open')
  open(
    @Param('auctionId') auctionId: string,
    @Headers('x-user-id') actorId: string | undefined,
    @Headers('x-user-role') role: string | undefined,
  ) {
    requireAuthenticated(actorId);
    requireRole(role, 'ADMIN', 'SHIPPER');
    return this.auctionService.open(auctionId, actorId, normalizeRole(role));
  }

  @Post(':auctionId/cancel')
  cancel(
    @Param('auctionId') auctionId: string,
    @Headers('x-user-id') actorId: string | undefined,
    @Headers('x-user-role') role: string | undefined,
    @Body() dto: CancelAuctionDto,
  ) {
    requireAuthenticated(actorId);
    requireRole(role, 'ADMIN', 'SHIPPER');
    return this.auctionService.cancel(
      auctionId,
      actorId,
      normalizeRole(role),
      dto.reason,
    );
  }

  @Post(':auctionId/fraud-flag')
  flag(
    @Param('auctionId') auctionId: string,
    @Headers('x-user-role') role: string | undefined,
    @Body() dto: FlagAuctionDto,
  ) {
    requireRole(role, 'ADMIN');
    return this.auctionService.flag(auctionId, dto);
  }

  @Post(':auctionId/complete')
  complete(
    @Param('auctionId') auctionId: string,
    @Headers('x-user-id') actorId: string | undefined,
    @Headers('x-user-role') role: string | undefined,
  ) {
    requireAuthenticated(actorId);
    requireRole(role, 'ADMIN', 'SHIPPER');
    return this.auctionService.complete(
      auctionId,
      actorId,
      normalizeRole(role),
    );
  }

  @Post(':auctionId/winner')
  selectWinner(
    @Param('auctionId') auctionId: string,
    @Headers('x-user-id') actorId: string | undefined,
    @Headers('x-user-role') role: string | undefined,
    @Body() dto: SelectWinnerDto,
  ) {
    requireAuthenticated(actorId);
    requireRole(role, 'ADMIN', 'SHIPPER');
    return this.auctionService.selectWinner(
      auctionId,
      dto.bidId,
      actorId,
      normalizeRole(role),
    );
  }
}

function normalizeRole(role: string | undefined) {
  return (role || '').toUpperCase();
}

function requireAuthenticated(
  userId: string | undefined,
): asserts userId is string {
  if (!userId)
    throw new UnauthorizedException('Authenticated user is required');
}

function requireRole(role: string | undefined, ...allowed: string[]) {
  if (!allowed.includes(normalizeRole(role))) {
    throw new ForbiddenException(`Required role: ${allowed.join(' or ')}`);
  }
}
