import {
  toNotificationResponse,
  toNotificationResponses,
} from './notification.mapper.js';

describe('notification.mapper', () => {
  it('maps Mongoose document fields and strips internal persistence keys', () => {
    const createdAt = new Date('2026-11-20T09:00:00.000Z');
    const updatedAt = new Date('2026-11-20T09:05:00.000Z');
    const mockDoc = {
      toObject: () => ({
        _id: { toString: () => '67401234567890abcdef1234' },
        __v: 0,
        dedupeKey: 'empty-route-match:auc-1:carrier-1',
        userId: 'carrier-1',
        title: 'Lô hàng mới',
        message: 'Có lộ trình phù hợp',
        referenceId: 'auc-1',
        type: 'NEW_AUCTION',
        isRead: false,
        createdAt,
        updatedAt,
      }),
    };

    const result = toNotificationResponse(mockDoc);

    expect(result).toEqual({
      id: '67401234567890abcdef1234',
      userId: 'carrier-1',
      title: 'Lô hàng mới',
      message: 'Có lộ trình phù hợp',
      referenceId: 'auc-1',
      type: 'NEW_AUCTION',
      isRead: false,
      createdAt: '2026-11-20T09:00:00.000Z',
      updatedAt: '2026-11-20T09:05:00.000Z',
    });
    expect('dedupeKey' in result).toBe(false);
    expect('__v' in result).toBe(false);
    expect('_id' in result).toBe(false);
  });

  it('handles lists and defaults missing optional fields cleanly', () => {
    const list = toNotificationResponses([
      {
        id: 'n-1',
        userId: 'u-1',
        title: 'T',
        message: 'M',
      },
    ]);

    expect(list).toEqual([
      {
        id: 'n-1',
        userId: 'u-1',
        title: 'T',
        message: 'M',
        referenceId: null,
        type: 'NEW_AUCTION',
        isRead: false,
        createdAt: null,
        updatedAt: null,
      },
    ]);
  });
});
