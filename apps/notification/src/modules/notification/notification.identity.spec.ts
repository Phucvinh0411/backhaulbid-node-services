import { NotificationController } from './notification.controller';
import { NotificationGateway } from './notification.gateway';

describe('Notification identity boundary', () => {
  it('rejects notification history requests without a gateway identity', async () => {
    const service = {
      findByUserId: jest.fn(),
      countUnread: jest.fn(),
      markAllAsRead: jest.fn(),
    } as any;
    const controller = new NotificationController(service, { get: jest.fn() } as any);

    await expect(controller.getMyNotifications(undefined)).rejects.toThrow(
      'Authenticated user is required',
    );
    expect(service.findByUserId).not.toHaveBeenCalled();
  });

  it('uses the trusted gateway identity instead of a client supplied socket user id', () => {
    const gateway = new NotificationGateway();
    const client = {
      id: 'socket-1',
      handshake: { headers: { 'x-user-id': 'trusted-user' } },
      join: jest.fn(),
    } as any;

    const result = gateway.handleIdentify({ userId: 'attacker-user' }, client);

    expect(result).toEqual({
      status: 'success',
      message: 'Identified successfully',
    });
    expect(client.join).toHaveBeenCalledWith('trusted-user');
    expect(client.join).not.toHaveBeenCalledWith('attacker-user');
  });
});
