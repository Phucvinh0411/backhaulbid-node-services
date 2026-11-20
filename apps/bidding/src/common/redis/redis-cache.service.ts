import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as net from 'node:net';

export type RespValue = string | number | null | RespValue[];

export type RespFrame =
  | { isError: true; message: string; nextOffset: number }
  | { isError: false; value: RespValue; nextOffset: number };

const CRLF = Buffer.from('\r\n', 'ascii');
const COMMAND_TIMEOUT_MS = 500;
const CONNECT_TIMEOUT_MS = 1_000;
const MAX_BACKOFF_MS = 10_000;
const MAX_STALE_INFLIGHT = 256;

export function encodeRespCommand(args: string[]): Buffer {
  const chunks: Buffer[] = [Buffer.from(`*${args.length}\r\n`, 'ascii')];
  for (const arg of args) {
    const body = Buffer.from(arg, 'utf8');
    chunks.push(Buffer.from(`$${body.length}\r\n`, 'ascii'), body, CRLF);
  }
  return Buffer.concat(chunks);
}

export function parseRespFrame(buf: Buffer, offset = 0): RespFrame | null {
  if (offset >= buf.length) return null;
  const lineEnd = buf.indexOf('\r\n', offset);
  if (lineEnd === -1) return null;

  const prefix = buf[offset];
  // '+' Simple String
  if (prefix === 0x2b) {
    return {
      isError: false,
      value: buf.toString('utf8', offset + 1, lineEnd),
      nextOffset: lineEnd + 2,
    };
  }
  // '-' Error
  if (prefix === 0x2d) {
    return {
      isError: true,
      message: buf.toString('utf8', offset + 1, lineEnd),
      nextOffset: lineEnd + 2,
    };
  }
  // ':' Integer
  if (prefix === 0x3a) {
    const parsed = Number(buf.toString('ascii', offset + 1, lineEnd));
    if (!Number.isFinite(parsed)) {
      throw new Error('Invalid RESP2 integer frame');
    }
    return {
      isError: false,
      value: parsed,
      nextOffset: lineEnd + 2,
    };
  }
  // '$' Bulk String (byte-accurate framing for multi-byte UTF-8)
  if (prefix === 0x24) {
    const byteLen = Number(buf.toString('ascii', offset + 1, lineEnd));
    if (!Number.isInteger(byteLen) || byteLen < -1) {
      throw new Error('Invalid RESP2 bulk string length');
    }
    if (byteLen === -1) {
      return { isError: false, value: null, nextOffset: lineEnd + 2 };
    }
    const bodyStart = lineEnd + 2;
    const bodyEnd = bodyStart + byteLen;
    const frameEnd = bodyEnd + 2;
    if (buf.length < frameEnd) return null;
    if (buf[bodyEnd] !== 0x0d || buf[bodyEnd + 1] !== 0x0a) {
      throw new Error('Invalid RESP2 bulk string terminator');
    }
    return {
      isError: false,
      value: buf.toString('utf8', bodyStart, bodyEnd),
      nextOffset: frameEnd,
    };
  }
  // '*' Array
  if (prefix === 0x2a) {
    const count = Number(buf.toString('ascii', offset + 1, lineEnd));
    if (!Number.isInteger(count) || count < -1) {
      throw new Error('Invalid RESP2 array length');
    }
    if (count === -1) {
      return { isError: false, value: null, nextOffset: lineEnd + 2 };
    }
    const items: RespValue[] = [];
    let cursor = lineEnd + 2;
    for (let i = 0; i < count; i++) {
      const elem = parseRespFrame(buf, cursor);
      if (!elem) return null;
      if (elem.isError) return { isError: true, message: elem.message, nextOffset: elem.nextOffset };
      items.push(elem.value);
      cursor = elem.nextOffset;
    }
    return { isError: false, value: items, nextOffset: cursor };
  }

  throw new Error(`Unexpected RESP2 prefix byte: 0x${prefix.toString(16)}`);
}

interface QueuedCommand {
  args: string[];
  settled: boolean;
  resolve: (value: RespValue) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface InflightCommand {
  settled: boolean;
  resolve: (value: RespValue) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout | null;
}

interface RedisEndpoint {
  host: string;
  port: number;
  username?: string;
  password?: string;
  db?: number;
}

@Injectable()
export class RedisCacheService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisCacheService.name);
  private readonly endpoint: RedisEndpoint | null;
  private readonly singleflight = new Map<string, Promise<unknown>>();

  private socket: net.Socket | null = null;
  private connecting = false;
  private ready = false;
  private destroyed = false;
  private rxBuffer: Buffer = Buffer.alloc(0);
  private waitQueue: QueuedCommand[] = [];
  private inflightQueue: InflightCommand[] = [];
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;

  constructor(@Optional() config?: ConfigService) {
    const rawUrl = config?.get<string>('REDIS_URL')?.trim();
    this.endpoint = rawUrl ? this.parseRedisUrl(rawUrl) : null;
  }

  onModuleInit(): void {
    if (this.endpoint && !this.destroyed) {
      this.ensureConnected();
    }
  }

  onModuleDestroy(): void {
    this.destroyed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket(new Error('Redis client destroyed'));
  }

  async getOrSet<T>(
    key: string,
    ttlMs: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    const existing = this.singleflight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const work = (async (): Promise<T> => {
      const cached = await this.get(key);
      if (cached !== null) {
        try {
          return JSON.parse(cached) as T;
        } catch {
          // Invalid JSON in cache falls open to live fetcher.
        }
      }

      const fresh = await fetcher();
      if (fresh !== undefined && ttlMs > 0) {
        try {
          await this.set(key, JSON.stringify(fresh), ttlMs);
        } catch {
          // Fail-open on serialization/write failure.
        }
      }
      return fresh;
    })();

    this.singleflight.set(key, work);
    try {
      return await work;
    } finally {
      if (this.singleflight.get(key) === work) {
        this.singleflight.delete(key);
      }
    }
  }

  async get(key: string): Promise<string | null> {
    try {
      const reply = await this.sendCommand(['GET', key]);
      return typeof reply === 'string' ? reply : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: string, ttlMs: number): Promise<boolean> {
    const px = Math.max(1, Math.floor(ttlMs));
    try {
      const reply = await this.sendCommand([
        'SET',
        key,
        value,
        'PX',
        String(px),
      ]);
      return reply === 'OK';
    } catch {
      return false;
    }
  }

  async del(key: string): Promise<number> {
    try {
      const reply = await this.sendCommand(['DEL', key]);
      return typeof reply === 'number' ? reply : 0;
    } catch {
      return 0;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const reply = await this.sendCommand(['PING']);
      return reply === 'PONG';
    } catch {
      return false;
    }
  }

  /**
   * Acquires a short-lived distributed lock via SET NX PX.
   * Fails open (returns true) if Redis is unconfigured or unavailable so single-node
   * reconciliation continues uninterrupted, and returns false only when another worker holds the lock.
   */
  async tryAcquireLock(
    key: string,
    token: string,
    ttlMs: number,
  ): Promise<boolean> {
    if (!this.endpoint) return true;
    const px = Math.max(1, Math.floor(ttlMs));
    try {
      const reply = await this.sendCommand([
        'SET',
        key,
        token,
        'NX',
        'PX',
        String(px),
      ]);
      return reply === 'OK';
    } catch {
      return true;
    }
  }

  /** Releases a distributed lock only if the stored value still matches the caller token. */
  async releaseLock(key: string, token: string): Promise<void> {
    if (!this.endpoint) return;
    try {
      await this.sendCommand([
        'EVAL',
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        '1',
        key,
        token,
      ]);
    } catch {
      // Lock expires automatically via PX TTL.
    }
  }

  private parseRedisUrl(rawUrl: string): RedisEndpoint | null {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
        this.logger.warn(`Unsupported REDIS_URL protocol "${parsed.protocol}", running in pass-through mode`);
        return null;
      }
      const host = parsed.hostname || '127.0.0.1';
      const port = parsed.port ? Number(parsed.port) : 6379;
      const username = parsed.username
        ? decodeURIComponent(parsed.username)
        : undefined;
      const password = parsed.password
        ? decodeURIComponent(parsed.password)
        : undefined;
      const dbSegment = parsed.pathname?.replace(/^\//, '').trim();
      const db = dbSegment ? Number(dbSegment) : undefined;
      return {
        host,
        port: Number.isFinite(port) && port > 0 ? port : 6379,
        username,
        password,
        db: db !== undefined && Number.isInteger(db) && db > 0 ? db : undefined,
      };
    } catch (error) {
      this.logger.warn(
        `Invalid REDIS_URL (${error instanceof Error ? error.message : 'parse error'}), running in pass-through mode`,
      );
      return null;
    }
  }

  private sendCommand(args: string[]): Promise<RespValue> {
    if (!this.endpoint || this.destroyed) {
      return Promise.reject(new Error('Redis disabled'));
    }
    // Fail fast (0ms) while backing off after a failed connection attempt.
    if (!this.ready && this.reconnectTimer !== null) {
      return Promise.reject(new Error('Redis reconnecting'));
    }

    return new Promise<RespValue>((resolve, reject) => {
      if (this.socket && this.ready) {
        const entry: InflightCommand = {
          settled: false,
          resolve,
          reject,
          timer: null,
        };
        entry.timer = setTimeout(() => {
          if (entry.settled) return;
          entry.settled = true;
          entry.timer = null;
          reject(new Error('Redis command timeout'));
          if (this.inflightQueue.length > MAX_STALE_INFLIGHT) {
            this.handleDisconnect(new Error('Too many timed-out Redis commands'));
          }
        }, COMMAND_TIMEOUT_MS);
        entry.timer.unref?.();

        this.inflightQueue.push(entry);
        this.socket.write(encodeRespCommand(args));
        return;
      }

      const queued: QueuedCommand = {
        args,
        settled: false,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (queued.settled) return;
          queued.settled = true;
          const idx = this.waitQueue.indexOf(queued);
          if (idx !== -1) this.waitQueue.splice(idx, 1);
          reject(new Error('Redis connect/command timeout'));
        }, COMMAND_TIMEOUT_MS),
      };
      queued.timer.unref?.();
      this.waitQueue.push(queued);
      this.ensureConnected();
    });
  }

  private ensureConnected(): void {
    if (
      !this.endpoint ||
      this.destroyed ||
      this.socket ||
      this.connecting ||
      this.reconnectTimer !== null
    ) {
      return;
    }

    this.connecting = true;
    this.ready = false;
    this.rxBuffer = Buffer.alloc(0);

    const { host, port, username, password, db } = this.endpoint;
    const sock = net.createConnection({ host, port });
    this.socket = sock;
    sock.setNoDelay(true);

    const connectTimer = setTimeout(() => {
      if (!this.ready && this.socket === sock) {
        this.handleDisconnect(new Error('Redis TCP connect timeout'));
      }
    }, CONNECT_TIMEOUT_MS);
    connectTimer.unref?.();

    sock.on('connect', () => {
      if (this.socket !== sock) return;
      this.connecting = false;

      const finishHandshake = () => {
        clearTimeout(connectTimer);
        if (this.socket !== sock || this.destroyed) return;
        this.ready = true;
        this.reconnectAttempts = 0;
        this.flushWaitQueue();
      };

      const handshakeFail = (err: Error) => {
        clearTimeout(connectTimer);
        if (this.socket !== sock) return;
        this.logger.warn(`Redis handshake failed: ${err.message}`);
        this.handleDisconnect(err);
      };

      const selectDbIfNeeded = () => {
        if (db !== undefined) {
          this.writeRawOnSocket(sock, ['SELECT', String(db)]).then(
            () => finishHandshake(),
            handshakeFail,
          );
        } else {
          finishHandshake();
        }
      };

      if (password !== undefined) {
        const authArgs = username
          ? ['AUTH', username, password]
          : ['AUTH', password];
        this.writeRawOnSocket(sock, authArgs).then(
          () => selectDbIfNeeded(),
          handshakeFail,
        );
      } else {
        selectDbIfNeeded();
      }
    });

    sock.on('data', (chunk: Buffer) => {
      if (this.socket !== sock) return;
      this.onData(chunk);
    });

    sock.on('error', (err: Error) => {
      clearTimeout(connectTimer);
      if (this.socket !== sock) return;
      if (this.reconnectAttempts === 0) {
        this.logger.warn(`Redis connection error (${err.message}), failing open`);
      }
      this.handleDisconnect(err);
    });

    sock.on('close', () => {
      clearTimeout(connectTimer);
      if (this.socket !== sock) return;
      this.handleDisconnect(new Error('Redis socket closed'));
    });
  }

  private writeRawOnSocket(sock: net.Socket, args: string[]): Promise<RespValue> {
    return new Promise<RespValue>((resolve, reject) => {
      const entry: InflightCommand = {
        settled: false,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (entry.settled) return;
          entry.settled = true;
          entry.timer = null;
          reject(new Error('Redis handshake timeout'));
        }, COMMAND_TIMEOUT_MS),
      };
      entry.timer?.unref?.();
      this.inflightQueue.push(entry);
      sock.write(encodeRespCommand(args));
    });
  }

  private flushWaitQueue(): void {
    if (!this.socket || !this.ready) return;
    const pending = this.waitQueue.splice(0, this.waitQueue.length);
    for (const item of pending) {
      if (item.settled) continue;
      clearTimeout(item.timer);
      const entry: InflightCommand = {
        settled: false,
        resolve: item.resolve,
        reject: item.reject,
        timer: null,
      };
      entry.timer = setTimeout(() => {
        if (entry.settled) return;
        entry.settled = true;
        entry.timer = null;
        item.reject(new Error('Redis command timeout'));
      }, COMMAND_TIMEOUT_MS);
      entry.timer.unref?.();
      this.inflightQueue.push(entry);
      this.socket.write(encodeRespCommand(item.args));
    }
  }

  private onData(chunk: Buffer): void {
    this.rxBuffer =
      this.rxBuffer.length === 0 ? chunk : Buffer.concat([this.rxBuffer, chunk]);

    let offset = 0;
    try {
      while (offset < this.rxBuffer.length) {
        const frame = parseRespFrame(this.rxBuffer, offset);
        if (!frame) break;
        offset = frame.nextOffset;

        const inflight = this.inflightQueue.shift();
        if (!inflight) continue;
        if (inflight.timer) {
          clearTimeout(inflight.timer);
          inflight.timer = null;
        }
        if (inflight.settled) continue;
        inflight.settled = true;

        if (frame.isError) {
          inflight.reject(new Error(frame.message));
        } else {
          inflight.resolve(frame.value);
        }
      }
    } catch (protocolError) {
      this.handleDisconnect(
        protocolError instanceof Error
          ? protocolError
          : new Error('RESP2 protocol error'),
      );
      return;
    }

    if (offset > 0) {
      this.rxBuffer =
        offset >= this.rxBuffer.length
          ? Buffer.alloc(0)
          : this.rxBuffer.subarray(offset);
    }
  }

  private handleDisconnect(reason: Error): void {
    this.teardownSocket(reason);
    if (this.destroyed || !this.endpoint || this.reconnectTimer !== null) {
      return;
    }
    const delay = Math.min(500 * 2 ** this.reconnectAttempts, MAX_BACKOFF_MS);
    this.reconnectAttempts = Math.min(this.reconnectAttempts + 1, 10);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.ensureConnected();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private teardownSocket(reason: Error): void {
    this.connecting = false;
    this.ready = false;
    this.rxBuffer = Buffer.alloc(0);

    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      sock.removeAllListeners();
      sock.on('error', () => undefined);
      sock.destroy();
    }

    const inflight = this.inflightQueue.splice(0, this.inflightQueue.length);
    for (const item of inflight) {
      if (item.timer) clearTimeout(item.timer);
      if (!item.settled) {
        item.settled = true;
        item.reject(reason);
      }
    }

    const waiting = this.waitQueue.splice(0, this.waitQueue.length);
    for (const item of waiting) {
      clearTimeout(item.timer);
      if (!item.settled) {
        item.settled = true;
        item.reject(reason);
      }
    }
  }
}
