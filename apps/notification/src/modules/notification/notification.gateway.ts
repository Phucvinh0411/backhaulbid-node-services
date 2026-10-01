import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { NotificationDocument } from './schemas/notification.schema.js';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
  path: '/notification-socket',
})
export class NotificationGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  @WebSocketServer()
  server: Server;

  private readonly logger = new Logger(NotificationGateway.name);

  // Map to store connected clients: userId -> Set<SocketId>
  private userSockets = new Map<string, Set<string>>();

  handleConnection(client: Socket) {
    this.logger.log(`Client connected: ${client.id}`);
    const userId = this.trustedUserId(client);
    if (userId) {
      this.joinUser(client, userId);
      return;
    }
    this.logger.warn(`Disconnecting unidentified socket ${client.id}`);
    client.disconnect(true);
  }

  handleDisconnect(client: Socket) {
    this.logger.log(`Client disconnected: ${client.id}`);
    // Remove socket from tracking
    this.userSockets.forEach((sockets, userId) => {
      if (sockets.has(client.id)) {
        sockets.delete(client.id);
        if (sockets.size === 0) {
          this.userSockets.delete(userId);
        }
      }
    });
  }

  @SubscribeMessage('identify')
  handleIdentify(
    @MessageBody() _data: { userId?: string },
    @ConnectedSocket() client: Socket,
  ) {
    const userId = this.trustedUserId(client);
    if (userId) {
      this.joinUser(client, userId);
      return { status: 'success', message: 'Identified successfully' };
    }
    return { status: 'error', message: 'Authenticated user is required' };
  }

  private trustedUserId(client: Socket): string | undefined {
    const header = client.handshake.headers['x-user-id'];
    return Array.isArray(header) ? header[0] : header;
  }

  private joinUser(client: Socket, userId: string) {
    this.logger.log(`Socket ${client.id} identified as user ${userId}`);
    if (!this.userSockets.has(userId)) {
      this.userSockets.set(userId, new Set());
    }
    this.userSockets.get(userId)?.add(client.id);
    client.join(userId);
  }

  public notifyUser(userId: string, notification: NotificationDocument) {
    this.logger.log(`Sending real-time notification to user ${userId}`);
    this.server.to(userId).emit('new_notification', notification);
  }

  public notifyAll(notification: NotificationDocument) {
    this.logger.log(`Broadcasting real-time notification to all users`);
    this.server.emit('new_notification', notification);
  }

  /**
   * Emit event 'milestone_updated' tới room của một user cụ thể.
   * Room name = userId (UUID string), được join tự động khi WS kết nối.
   *
   * @param userId  UUID của Shipper hoặc Carrier cần được notify
   * @param payload Dữ liệu cột mốc đã đạt
   */
  public emitMilestoneUpdated(userId: string, payload: object): void {
    this.logger.log(`[Socket.io] Emitting 'milestone_updated' to room: ${userId}`);
    this.server.to(userId).emit('milestone_updated', payload);
  }
}

