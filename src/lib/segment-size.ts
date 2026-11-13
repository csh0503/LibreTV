import { checkUpstreamAllowed } from './ssrf';

/**
 * 服务端量分片大小（给片源质检算真实码率用）：浏览器直连 HEAD 时，多数 CDN 不给跨域头，
 * 读不到 Content-Length；这里由伺服器量。只读响应头，不下载分片内容：
 * 先 HEAD 读 Content-Length；没有就 GET + `Range: bytes=0-0`，读 Content-Range 的总长（只收 1 字节）。
 * 每一跳（含重定向）都过 SSRF 检查。
 */

export interface SegmentSize {
  bytes: number;
  /** 拿到响应头用了多少毫秒（顺便当作源站反应速度） */
  ms: number;
}

const TIMEOUT_MS = 5000;
const MAX_REDIRECTS = 3;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 「bytes 0-0/123456」→ 123456；没有总长（*）或看不懂返回 0 */
export function totalFromContentRange(value: string | null): number {
  const m = value?.match(/\/\s*(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

async function request(url: string, init: RequestInit, fetchImpl: FetchLike, signal: AbortSignal): Promise<Response | null> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const verdict = await checkUpstreamAllowed(current);
    if (!verdict.ok) return null;
    const res = await fetchImpl(current, { ...init, redirect: 'manual', signal });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      void res.body?.cancel().catch(() => undefined);
      if (!loc) return null;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  return null;
}

export async function measureSegment(url: string, fetchImpl: FetchLike = fetch): Promise<SegmentSize> {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const headers = { 'User-Agent': UA, Accept: '*/*' };
  try {
    const head = await request(url, { method: 'HEAD', headers }, fetchImpl, ctrl.signal).catch(() => null);
    const len = head?.ok ? parseInt(head.headers.get('content-length') ?? '', 10) : NaN;
    if (Number.isFinite(len) && len > 1) return { bytes: len, ms: Date.now() - started };
    const ranged = await request(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' } }, fetchImpl, ctrl.signal).catch(() => null);
    if (!ranged) return { bytes: 0, ms: Date.now() - started };
    let bytes = 0;
    if (ranged.status === 206) bytes = totalFromContentRange(ranged.headers.get('content-range'));
    else if (ranged.ok) {
      // 不支持 Range、整片返回：Content-Length 就是总长（不读内容，马上断开）
      const full = parseInt(ranged.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(full) && full > 1) bytes = full;
    }
    void ranged.body?.cancel().catch(() => undefined);
    return { bytes, ms: Date.now() - started };
  } catch {
    return { bytes: 0, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
    ctrl.abort();
  }
}
