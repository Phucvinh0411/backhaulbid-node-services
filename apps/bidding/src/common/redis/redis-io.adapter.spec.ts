import { createAdapter } from '@socket.io/redis-adapter';
import Redis from 'ioredis';
import { RedisIoAdapter } from './redis-io.adapter';

jest.mock('@socket.io/redis-adapter', () => ({
  createAdapter: jest.fn(() => 'mock-adapter-factory'),
}));

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    duplicate: jest.fn().mockReturnValue({
      connect: jest.fn().mockResolvedValue(undefined),
      on: jest.fn(),
      quit: jest.fn().mockResolvedValue('OK'),
    }),
    on: jest.fn(),
    quit: jest.fn().mockResolvedValue('OK'),
  }));
});

describe('RedisIoAdapter', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('stays in local in-memory mode when REDIS_URL is not configured', async () => {
    const adapter = new RedisIoAdapter({} as any, undefined);
    await adapter.connectToRedis();

    expect(Redis).not.toHaveBeenCalled();
    expect(createAdapter).not.toHaveBeenCalled();
    await adapter.close();
  });

  it('connects pub/sub ioredis clients and wires Socket.IO adapter when REDIS_URL is set', async () => {
    const adapter = new RedisIoAdapter(
      {} as any,
      'rediss://default:pass@valkey.aivencloud.com:25061',
    );
    await adapter.connectToRedis();

    expect(Redis).toHaveBeenCalledWith(
      'rediss://default:pass@valkey.aivencloud.com:25061',
      expect.objectContaining({ lazyConnect: true }),
    );
    expect(createAdapter).toHaveBeenCalledTimes(1);

    const mockServer = { adapter: jest.fn() };
    jest
      .spyOn(Object.getPrototypeOf(RedisIoAdapter.prototype), 'createIOServer')
      .mockReturnValue(mockServer);

    adapter.createIOServer(3001);
    expect(mockServer.adapter).toHaveBeenCalledWith('mock-adapter-factory');

    await adapter.close();
  });
});
