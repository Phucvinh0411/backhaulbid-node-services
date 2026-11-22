import { resolveInternalHttpTimeoutMs } from './internal-http-timeout';

describe('resolveInternalHttpTimeoutMs', () => {
  it('defaults to 10000ms when INTERNAL_HTTP_TIMEOUT_MS is unset or invalid', () => {
    expect(resolveInternalHttpTimeoutMs()).toBe(10_000);
    expect(
      resolveInternalHttpTimeoutMs({ get: () => '' } as never),
    ).toBe(10_000);
    expect(
      resolveInternalHttpTimeoutMs({ get: () => '200' } as never),
    ).toBe(10_000);
  });

  it('uses configured positive timeout >= 1000ms', () => {
    expect(
      resolveInternalHttpTimeoutMs({ get: () => '12000' } as never),
    ).toBe(12_000);
  });
});
