import { EventEmitter } from 'node:events';
import { ConfigService } from '@nestjs/config';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { RedisCacheService } from './redis-cache.service';

class MockSocket extends EventEmitter {
  writes: string[] = [];
  destroyed = false;

  setNoDelay = jest.fn(() => this);

  write = jest.fn((chunk: Buffer | string) => {
    this.writes.push(
      typeof chunk === 'string' ? chunk : chunk.toString('utf8'),
    );
    return true;
  });

  destroy = jest.fn(() => {
    this.destroyed = true;
    return this;
  });

  emitResp(payload: string): void {
    this.emit('data', Buffer.from(payload, 'utf8'));
  }
}

jest.mock('node:net', () => ({
  createConnection: jest.fn(),
}));

jest.mock('node:tls', () => ({
  connect: jest.fn(),
}));

function mockConfig(redisUrl: string): ConfigService {
  return {
    get: jest.fn((key: string) => (key === 'REDIS_URL' ? redisUrl : undefined)),
  } as unknown as ConfigService;
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('RedisCacheService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('uses tls.connect and waits for secureConnect on rediss:// (Aiven Valkey)', async () => {
    const sock = new MockSocket();
    (tls.connect as jest.Mock).mockReturnValue(sock);

    const service = new RedisCacheService(
      mockConfig('rediss://default:s3cr3t@valkey.aivencloud.com:25061/2'),
    );

    service.onModuleInit();

    expect(tls.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'valkey.aivencloud.com',
        port: 25061,
        servername: 'valkey.aivencloud.com',
      }),
    );
    expect(net.createConnection).not.toHaveBeenCalled();

    // Must not send AUTH before TLS secureConnect finishes
    sock.emit('connect');
    expect(sock.writes).toHaveLength(0);

    sock.emit('secureConnect');
    expect(sock.writes[0]).toContain(
      'AUTH\r\n$7\r\ndefault\r\n$6\r\ns3cr3t\r\n',
    );
    sock.emitResp('+OK\r\n');
    await flushMicrotasks();

    expect(sock.writes[1]).toContain('SELECT\r\n$1\r\n2\r\n');
    sock.emitResp('+OK\r\n');
    await flushMicrotasks();

    const pendingGet = service.get('auction:1');
    expect(sock.writes[2]).toContain('GET\r\n$9\r\nauction:1\r\n');
    sock.emitResp('$4\r\nopen\r\n');

    await expect(pendingGet).resolves.toBe('open');
    service.onModuleDestroy();
  });

  it('keeps plain net.createConnection on redis:// for local docker-compose', async () => {
    const sock = new MockSocket();
    (net.createConnection as jest.Mock).mockReturnValue(sock);

    const service = new RedisCacheService(
      mockConfig('redis://:localpass@redis:6379'),
    );

    service.onModuleInit();

    expect(net.createConnection).toHaveBeenCalledWith({
      host: 'redis',
      port: 6379,
    });
    expect(tls.connect).not.toHaveBeenCalled();

    sock.emit('connect');
    expect(sock.writes[0]).toContain('AUTH\r\n$9\r\nlocalpass\r\n');
    sock.emitResp('+OK\r\n');
    await flushMicrotasks();

    const pendingGet = service.get('health');
    expect(sock.writes[1]).toContain('GET\r\n$6\r\nhealth\r\n');
    sock.emitResp('$2\r\nok\r\n');

    await expect(pendingGet).resolves.toBe('ok');
    service.onModuleDestroy();
  });
});
