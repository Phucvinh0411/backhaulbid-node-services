import {
  Controller,
  Get,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationService } from './notification.service.js';
import { CreateNotificationDto } from './dto/create-notification.dto.js';

@Controller()
export class NotificationController {
  constructor(
    private readonly notificationService: NotificationService,
    private readonly configService: ConfigService,
  ) {}

  @Get('health')
  health() {
    return { status: 'UP' };
  }

  /**
   * Lấy danh sách thông báo của user hiện tại
   * GET /api/v1/notifications/mine
   */
  @Get('mine')
  async getMyNotifications(@Headers('x-user-id') userId?: string) {
    return this.notificationService.findByUserId(requireUserId(userId));
  }

  /**
   * Đếm số thông báo chưa đọc
   * GET /api/v1/notifications/unread-count
   */
  @Get('unread-count')
  async getUnreadCount(@Headers('x-user-id') userId?: string) {
    const count = await this.notificationService.countUnread(
      requireUserId(userId),
    );
    return { count };
  }

  /**
   * Đánh dấu tất cả thông báo là đã đọc
   * POST /api/v1/notifications/mark-all-read
   */
  @Post('mark-all-read')
  @HttpCode(HttpStatus.OK)
  async markAllRead(@Headers('x-user-id') userId?: string) {
    const modified = await this.notificationService.markAllAsRead(
      requireUserId(userId),
    );
    return { modified };
  }

  /**
   * Tạo thông báo mới (Internal API – được gọi từ các service khác)
   * POST /api/v1/notifications/internal/create
   */
  @Post('internal/create')
  async createNotification(
    @Body() dto: CreateNotificationDto,
    @Headers('x-internal-token') token?: string,
  ) {
    const expectedToken = this.configService.get<string>('INTERNAL_SERVICE_TOKEN');
    if (!expectedToken || token !== expectedToken) {
      throw new ForbiddenException('Invalid internal service token');
    }
    return this.notificationService.create(dto);
  }
}

function requireUserId(userId: string | undefined): string {
  if (!userId?.trim()) {
    throw new UnauthorizedException('Authenticated user is required');
  }
  return userId.trim();
}
