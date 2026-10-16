import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { cmsRequestHeaders, parseDetail } from '@/lib/cms-parser';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { makeAbsolute } from '@/lib/m3u8';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import {
  analyzeMediaPlaylist,
  bestVariant,
  heightFromKbps,
  parseMasterPlaylist,
  type SourceQuality,
} from '@/lib/stream-quality';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** 一次最多测几个源（全部并发）；每个源大约 3~4 个请求（详情、播放列表、可能的子列表、一个分片的大小） */
const MAX_ITEMS = 30;
const PER_ITEM_TIMEOUT_MS = 14000;
const CACHE_TTL = 60 * 60 * 1000;

interface QualityRequestItem {
  key: string;
  sourceKey: string;
  sourceName?: string;
  sourceUrl: string;
  vodId: string;
}

async function fetchText(url: string): Promise<string> {
  const verdict = await checkUpstreamAllowed(url);
  if (!verdict.ok) throw new Error(verdict.reason);
  const res = await fetchUpstream(url, { timeoutMs: 6000, headers: cmsRequestHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 量一个分片多大：优先 Range 只要 1 个字节读 Content-Range 总长，不行再看 HEAD 的 Content-Length */
async function segmentBytes(url: string): Promise<number> {
  const verdict = await checkUpstreamAllowed(url);
  if (!verdict.ok) return 0;
  try {
    const res = await fetchUpstream(url, { timeoutMs: 5000, headers: { ...cmsRequestHeaders(), Range: 'bytes=0-0' } });
    const range = res.headers.get('content-range');
    const total = range ? parseInt(range.split('/')[1] ?? '', 10) : NaN;
    void res.body?.cancel();
    if (Number.isFinite(total) && total > 1) return total;
    const len = parseInt(res.headers.get('content-length') ?? '', 10);
    if (res.status === 200 && Number.isFinite(len) && len > 1) return len;
  } catch {
    // 换 HEAD 再试
  }
  try {
    const res = await fetchUpstream(url, { timeoutMs: 5000, method: 'HEAD', headers: cmsRequestHeaders() });
    const len = parseInt(res.headers.get('content-length') ?? '', 10);
    return Number.isFinite(len) && len > 1 ? len : 0;
  } catch {
    return 0;
  }
}

async function probe(item: QualityRequestItem): Promise<SourceQuality> {
  const cacheKey = `quality:v2:${item.sourceUrl}|${item.vodId}`;
  const cached = getCache<SourceQuality>(cacheKey);
  if (cached) return { ...cached, key: item.key };

  const listVerdict = await checkUpstreamAllowed(item.sourceUrl);
  if (!listVerdict.ok) return { key: item.key, ok: false, error: listVerdict.reason };
  const api = `${item.sourceUrl.replace(/\/+$/, '')}?ac=videolist&ids=${encodeURIComponent(item.vodId)}`;
  const res = await fetchUpstream(api, { timeoutMs: 6000, headers: cmsRequestHeaders() });
  if (!res.ok) return { key: item.key, ok: false, error: `详情 HTTP ${res.status}` };
  const detail = parseDetail(await res.json(), { key: item.sourceKey, name: item.sourceName ?? item.sourceKey, url: item.sourceUrl });
  const first = detail.episodes[0];
  if (!first) return { key: item.key, ok: false, error: '没有播放地址' };
  if (!/\.m3u8(\?|$)/i.test(first)) return { key: item.key, ok: true, error: '不是 m3u8，测不了' };

  let playlistUrl = first;
  let content = await fetchText(playlistUrl);
  let height = 0;
  const variants = parseMasterPlaylist(content);
  if (variants.length > 0) {
    const best = bestVariant(variants)!;
    height = best.height;
    playlistUrl = makeAbsolute(best.uri, playlistUrl);
    content = await fetchText(playlistUrl);
  }
  const info = analyzeMediaPlaylist(content, playlistUrl);
  let kbps = 0;
  if (info.sampleSegment) {
    const bytes = await segmentBytes(makeAbsolute(info.sampleSegment.uri, playlistUrl));
    if (bytes > 0) kbps = Math.round((bytes * 8) / info.sampleSegment.seconds / 1000);
  }
  const estimated = height === 0 && kbps > 0;
  const result: SourceQuality = {
    key: item.key,
    ok: true,
    height: height || heightFromKbps(kbps) || undefined,
    estimated: estimated || undefined,
    kbps: kbps || undefined,
    adSeconds: info.adSeconds,
    suspectSeconds: info.suspectSeconds || undefined,
    minutes: info.seconds > 0 ? Math.round(info.seconds / 60) : undefined,
  };
  setCache(cacheKey, result, CACHE_TTL);
  return result;
}

function withTimeout(item: QualityRequestItem): Promise<SourceQuality> {
  return Promise.race([
    probe(item).catch((err: unknown) => ({
      key: item.key,
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 80) : '质检失败',
    })),
    new Promise<SourceQuality>((resolve) =>
      setTimeout(() => resolve({ key: item.key, ok: false, error: '超时' }), PER_ITEM_TIMEOUT_MS),
    ),
  ]);
}

/**
 * 片源质检：给每个候选源取第 1 集的播放列表，看清晰度（分辨率或码率估算）、
 * 能识别的插入广告秒数（播放时会自动跳过）。结果缓存 1 小时。
 */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  let body: { items?: QualityRequestItem[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError('请求格式错误', 400);
  }
  const items = (body.items ?? [])
    .filter((i) => i && typeof i.key === 'string' && /^https?:\/\//.test(i.sourceUrl || '') && /^[\w-]+$/.test(i.vodId || ''))
    .slice(0, MAX_ITEMS);
  const results = await Promise.all(items.map(withTimeout));
  return NextResponse.json({ results });
}
