import { ConfigService } from '@nestjs/config';

const DEFAULT_INTERNAL_HTTP_TIMEOUT_MS = 10_000;

/** Resolves downstream core-service HTTP timeout with a 10s safe default. */
export function resolveInternalHttpTimeoutMs(config?: ConfigService): number {
  const raw = config?.get<string | number>('INTERNAL_HTTP_TIMEOUT_MS');
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1000
    ? parsed
    : DEFAULT_INTERNAL_HTTP_TIMEOUT_MS;
}
