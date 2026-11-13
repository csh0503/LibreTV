import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { measureSegment } from '@/lib/segment-size';

export const runtime = 'nodejs';

/** 一次最多量几个分片（质检每个源抽 2~3 片） */
const MAX_URLS = 3;

/**
 * POST /api/segment-size  { urls: string[] } → { sizes: [{ bytes, ms }] }
 * 片源质检算真实码率用：浏览器直连读不到分片大小（跨域）时由伺服器量，只读响应头。
 */
export async function POST(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;
  let urls: unknown;
  try {
    urls = ((await req.json()) as { urls?: unknown }).urls;
  } catch {
    return jsonError('请求格式不对', 400);
  }
  if (!Array.isArray(urls) || urls.length === 0 || urls.length > MAX_URLS || !urls.every((u) => typeof u === 'string' && /^https?:\/\//i.test(u))) {
    return jsonError('urls 要是 1~3 个 http(s) 地址', 400);
  }
  const sizes = await Promise.all((urls as string[]).map((u) => measureSegment(u)));
  return NextResponse.json({ sizes }, { headers: { 'Cache-Control': 'no-store' } });
}
