import { describe, expect, it } from 'vitest';
import { measureSegment, totalFromContentRange } from './segment-size';

describe('伺服器量分片大小', () => {
  it('Content-Range 总长', () => {
    expect(totalFromContentRange('bytes 0-0/2345678')).toBe(2345678);
    expect(totalFromContentRange('bytes 0-0/*')).toBe(0);
    expect(totalFromContentRange(null)).toBe(0);
  });

  it('HEAD 有 Content-Length 就用；没有就 Range 读总长', async () => {
    const withLength = (async () => new Response(null, { status: 200, headers: { 'content-length': '1500000' } })) as never;
    expect((await measureSegment('https://93.184.216.34/a.ts', withLength)).bytes).toBe(1500000);
    const calls: string[] = [];
    const rangeOnly = (async (_u: string, init: RequestInit) => {
      calls.push(String(init.method));
      if (init.method === 'HEAD') return new Response(null, { status: 405 });
      return new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/987654' } });
    }) as never;
    expect((await measureSegment('https://93.184.216.34/b.ts', rangeOnly)).bytes).toBe(987654);
    expect(calls).toEqual(['HEAD', 'GET']);
  });

  it('内网地址不量', async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response(null, { status: 200, headers: { 'content-length': '10' } });
    }) as never;
    expect((await measureSegment('http://192.168.1.1/a.ts', spy)).bytes).toBe(0);
    expect(called).toBe(false);
  });
});
