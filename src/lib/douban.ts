import type { DoubanItem } from './types';
import { fetchUpstream, getCache, setCache } from './fetch-utils';
import { rexxarToItem, type DoubanRequest } from './recommend';

/**
 * 豆瓣推荐数据获取（服务端直连，带内存缓存与降级链）。
 * 主路径是 m.douban.com rexxar：tags 可以同时带题材、地区、年份。
 * 直连失败时退回 search_subjects（只吃一个标签，没有年份/地区字段）。
 */

const REXXAR_API = 'https://m.douban.com/rexxar/api/v2';
const SEARCH_SUBJECTS = 'https://movie.douban.com/j/search_subjects';
const CACHE_TTL = 10 * 60 * 1000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

interface DoubanRawSubject {
  id: string;
  title: string;
  cover: string;
  rate: string;
  url?: string;
}

export interface DoubanFetchQuery extends DoubanRequest {
  pageStart: number;
  pageSize: number;
}

function fallbackProxies(): string[] {
  const proxies: string[] = [];
  if (process.env.FALLBACK_CORS_PROXY) proxies.push(process.env.FALLBACK_CORS_PROXY);
  return proxies;
}

const LEGACY_SORT: Record<DoubanRequest['sort'], string> = {
  U: 'recommend',
  S: 'rank',
  R: 'time',
};

async function readJson(target: string, referer: string): Promise<unknown | undefined> {
  try {
    const res = await fetchUpstream(target, {
      timeoutMs: 8000,
      headers: { 'User-Agent': UA, Referer: referer, Accept: 'application/json' },
    });
    if (res.ok) return await res.json();
  } catch {
    // 走降级
  }
  for (const proxy of fallbackProxies()) {
    try {
      const res = await fetchUpstream(proxy + encodeURIComponent(target), {
        timeoutMs: 8000,
        headers: { Accept: 'application/json' },
      });
      if (res.ok) return await res.json();
    } catch {
      // 继续尝试下一个
    }
  }
  return undefined;
}

export async function fetchDoubanRecommend(query: DoubanFetchQuery): Promise<{ items: DoubanItem[]; total?: number }> {
  const cacheKey = `douban:${query.kind}:${query.tags.join(',')}:${query.sort}:${query.score}:${query.pageStart}:${query.pageSize}`;
  const cached = getCache<{ items: DoubanItem[]; total?: number }>(cacheKey);
  if (cached) return cached;

  const nowYear = new Date().getFullYear();
  const isTv = query.kind === 'tv';
  const tags = query.tags.join(',');
  const rexxar = `${REXXAR_API}/${query.kind}/recommend?start=${query.pageStart}&count=${query.pageSize}&tags=${encodeURIComponent(tags)}&sort=${query.sort}&score_range=${query.score}&uncollect=false`;
  const rexxarJson = (await readJson(rexxar, 'https://movie.douban.com/explore')) as { items?: unknown[]; total?: unknown } | undefined;
  const rexxarItems = rexxarJson?.items;
  let items: DoubanItem[] | undefined;
  let total: number | undefined;
  if (Array.isArray(rexxarItems)) {
    items = rexxarItems
      .map((row) => rexxarToItem(row, isTv, nowYear))
      .filter((item): item is DoubanItem => item !== undefined);
    if (typeof rexxarJson?.total === 'number' && rexxarJson.total >= 0) total = rexxarJson.total;
  }

  // rexxar 被拒绝时才退回单标签接口。空数组是合法筛选结果，不触发降级。
  if (!items) {
    const legacySort = LEGACY_SORT[query.sort];
    const legacy = `${SEARCH_SUBJECTS}?type=${query.kind}&tag=${encodeURIComponent(query.tags[0] || '热门')}&sort=${legacySort}&page_limit=${query.pageSize}&page_start=${query.pageStart}`;
    const legacyJson = await readJson(legacy, 'https://movie.douban.com/');
    const subjects = (legacyJson as { subjects?: DoubanRawSubject[] } | undefined)?.subjects;
    if (!subjects) throw new Error('豆瓣推荐获取失败');
    items = subjects.map((s) => ({
      id: String(s.id),
      title: s.title,
      cover: s.cover,
      rating: s.rate && s.rate !== '0' ? s.rate : undefined,
      isTv,
    }));
  }

  const payload = { items, total };
  setCache(cacheKey, payload, CACHE_TTL);
  return payload;
}
