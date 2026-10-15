import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET } from './route';
import { SESSION_COOKIE, signSession } from '@/lib/auth';

/**
 * 分类浏览：解析分类与影片，内网地址在请求前拒绝。
 */

beforeAll(() => {
  process.env.PASSWORD = 'test-password-123';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeRequest(params: Record<string, string>): Request {
  const { token } = signSession();
  const sp = new URLSearchParams(params);
  return new Request(`https://local.test/api/browse?${sp.toString()}`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  });
}

describe('GET /api/browse', () => {
  it('返回分类，并按分类拉取影片', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('ac=list')) {
          return new Response(
            JSON.stringify({
              class: [
                { type_id: 3, type_name: '伦理片' },
                { type_id: 'nope', type_name: '丢掉' },
              ],
              list: [],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        if (url.includes('ac=videolist') && url.includes('t=3')) {
          return new Response(
            JSON.stringify({
              list: [{ vod_id: 9, vod_name: '示例', vod_year: 2020, vod_remarks: '全12集', vod_score: 7.5 }],
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
          );
        }
        return new Response('not found', { status: 404 });
      })
    );

    const res = await GET(makeRequest({ url: 'https://cms-a.example.com/api.php/provide/vod', t: '3' }));
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      classes: { id: string; name: string }[];
      items: { vodId: string; year?: string; remarks?: string; rating?: string }[];
    };
    expect(data.classes).toEqual([{ id: '3', name: '伦理片' }]);
    expect(data.items[0]).toMatchObject({ vodId: '9', year: '2020', remarks: '全12集', rating: '7.5' });
  });

  it('内网地址不发起上游请求', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const res = await GET(makeRequest({ url: 'http://192.168.1.100/api.php' }));
    expect(res.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
