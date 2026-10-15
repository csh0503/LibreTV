import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { cmsRequestHeaders, parseBrowseVideos, parseCmsClasses, parsePageCount } from '@/lib/cms-parser';
import { fetchUpstream, getCache, setCache } from '@/lib/fetch-utils';
import { checkUpstreamAllowed } from '@/lib/ssrf';
import type { BrowseResponse } from '@/lib/types';

export const runtime = 'nodejs';

const CACHE_TTL = 5 * 60 * 1000;

/**
 * 采集站分类浏览。只访问调用方给出的源根地址，查询参数由本路由拼，避免变成开放代理。
 * 成人片库用它拿分类名、年份、地区和 remarks（完结/更新至）。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const url = new URL(req.url);
  const base = (url.searchParams.get('url') || '').trim();
  const typeId = (url.searchParams.get('t') || '').trim();
  const year = (url.searchParams.get('year') || '').trim();
  const area = (url.searchParams.get('area') || '').trim();
  const page = Math.min(2000, Math.max(1, parseInt(url.searchParams.get('pg') || '1', 10) || 1));

  if (!/^https?:\/\//.test(base) || base.length > 500) {
    return NextResponse.json({ error: '无效的源地址' }, { status: 400 });
  }
  if (typeId && !/^\d{1,8}$/.test(typeId)) {
    return NextResponse.json({ error: '无效的分类' }, { status: 400 });
  }
  if (year && !/^(19|20)\d{2}$/.test(year)) {
    return NextResponse.json({ error: '无效的年份' }, { status: 400 });
  }
  if (area && !/^[\u4e00-\u9fa5A-Za-z0-9]{1,12}$/.test(area)) {
    return NextResponse.json({ error: '无效的地区' }, { status: 400 });
  }

  const verdict = await checkUpstreamAllowed(base);
  if (!verdict.ok) {
    return NextResponse.json({ error: verdict.reason }, { status: 400 });
  }

  const cacheKey = `browse:${base}\n${typeId}\n${year}\n${area}\n${page}`;
  const cached = getCache<BrowseResponse>(cacheKey);
  if (cached) return NextResponse.json(cached);

  try {
    const itemParams: Record<string, string> = { ac: 'videolist', pg: String(page) };
    if (typeId) itemParams.t = typeId;
    if (year) itemParams.year = year;
    if (area) itemParams.area = area;
    // 分类表只在第一页要。后面的页只补影片，避免每翻一页都再打一遍 ac=list。
    const [itemJson, classJson] = await Promise.all([
      fetchCms(base, itemParams),
      page === 1 ? fetchCms(base, { ac: 'list' }) : Promise.resolve(null),
    ]);

    const payload: BrowseResponse = {
      classes: classJson ? parseCmsClasses(classJson) : [],
      items: parseBrowseVideos(itemJson),
      page,
      pageCount: parsePageCount(itemJson),
    };
    setCache(cacheKey, payload, CACHE_TTL);
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '分类浏览失败' },
      { status: 502 }
    );
  }
}

async function fetchCms(base: string, params: Record<string, string>): Promise<unknown> {
  const target = new URL(base);
  for (const [key, value] of Object.entries(params)) target.searchParams.set(key, value);
  const verdict = await checkUpstreamAllowed(target.toString());
  if (!verdict.ok) throw new Error(verdict.reason);
  const res = await fetchUpstream(target.toString(), {
    timeoutMs: 8000,
    headers: cmsRequestHeaders(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
