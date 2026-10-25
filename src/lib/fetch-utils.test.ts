import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchUpstream, getCache, peekStale, setCache, singleflight } from './fetch-utils';

/**
 * 安全跳转测试：mock 全局 fetch，验证 302 跳转到内网地址会被拒绝，
 * 跳转到公网地址则正常跟随。使用字面量公网 IP 避免 DNS 依赖。
 */

const PUBLIC_URL = 'https://93.184.216.34/a';

function mockFetch(handlers: Array<(url: string) => Response>) {
  const fn = vi.fn((url: string | URL) => {
    const handler = handlers.shift();
    if (!handler) throw new Error('意外的额外请求: ' + url);
    return Promise.resolve(handler(String(url)));
  });
  vi.stubGlobal('fetch', fn);
  return fn as unknown as ReturnType<typeof vi.fn> & { mock: { calls: unknown[][] } };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('缓存过期后先返回旧值', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('TTL 内 getCache 能读到，刚过期由 peekStale 读到，宽限过后两边都没有', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-25T00:00:00Z'));
    setCache('shelf:test', ['甲'], 1_000);
    expect(getCache('shelf:test')).toEqual(['甲']);
    expect(peekStale('shelf:test')).toBeUndefined();
    vi.setSystemTime(new Date('2026-10-25T00:00:02Z'));
    expect(getCache('shelf:test')).toBeUndefined();
    expect(peekStale('shelf:test')).toEqual(['甲']);
    vi.setSystemTime(new Date('2026-10-25T03:00:00Z'));
    expect(peekStale('shelf:test')).toBeUndefined();
  });
});

describe('singleflight', () => {
  it('同一把钥匙同时进来只算一次，算完之后可以再算', async () => {
    let n = 0;
    const run = () =>
      singleflight('hot-list:test', async () => {
        n += 1;
        await Promise.resolve();
        return n;
      });
    const [a, b] = await Promise.all([run(), run()]);
    expect(a).toBe(1);
    expect(b).toBe(1);
    expect(await run()).toBe(2);
  });
});

describe('fetchUpstream 安全跳转', () => {
  it('302 跳转到内网地址时拒绝，且不发起第二跳请求', async () => {
    const spy = mockFetch([
      () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8080/secret' } }),
    ]);
    await expect(fetchUpstream(PUBLIC_URL)).rejects.toThrow(/跳转目标被拒绝/);
    expect(spy.mock.calls.length).toBe(1); // 预检在请求前拦截，内网地址未实际请求
  });

  it('302 跳转到公网地址时正常跟随并返回最终响应', async () => {
    mockFetch([
      () => new Response(null, { status: 302, headers: { location: 'https://93.184.216.34/b' } }),
      () => new Response('ok', { status: 200 }),
    ]);
    const res = await fetchUpstream(PUBLIC_URL);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('无跳转时直接返回响应', async () => {
    const spy = mockFetch([() => new Response('direct', { status: 200 })]);
    const res = await fetchUpstream(PUBLIC_URL);
    expect(await res.text()).toBe('direct');
    expect(spy.mock.calls.length).toBe(1);
  });

  it('重定向超过上限时抛错', async () => {
    mockFetch(Array.from({ length: 10 }, () => (url: string) =>
      new Response(null, { status: 302, headers: { location: url } })
    ));
    await expect(fetchUpstream(PUBLIC_URL)).rejects.toThrow(/重定向次数过多/);
  });
});
