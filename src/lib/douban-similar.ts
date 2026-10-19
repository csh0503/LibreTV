import type { DoubanItem } from './types';
import { fetchUpstream, getCache, setCache } from './fetch-utils';
import { rexxarToItem } from './recommend';
import { canonicalTitle } from './title-aliases';
import { dropUnreleased, fetchUnreleasedIndex } from './unreleased';

/**
 * 「看过这部的人也喜欢」：豆瓣每部作品的推荐（协同过滤，`/rexxar/api/v2/{tv|movie}/{id}/recommendations`）。
 * 用在首页「因为你看过《某某》」和「为你推荐」——比按题材去片库要「同题材高分」准得多（真的和这部像）。
 * 没有豆瓣编号的（从搜索直接点片源看的）先按片名 + 年份在豆瓣搜出编号。
 * 编号缓存 7 天，推荐缓存 12 小时；还没播出的剔除。
 */

const REXXAR = 'https://m.douban.com/rexxar/api/v2';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const ID_TTL = 7 * 86_400_000;
const SIMILAR_TTL = 12 * 3600_000;
const FAIL_TTL = 30 * 60_000;

async function rexxar<T>(path: string): Promise<T | undefined> {
  try {
    const res = await fetchUpstream(`${REXXAR}${path}`, {
      timeoutMs: 7000,
      headers: { 'User-Agent': MOBILE_UA, Referer: 'https://m.douban.com/movie/', Accept: 'application/json' },
    });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

interface SearchTarget {
  id?: string;
  title?: string;
  year?: string;
}

/** 片名（+ 年份 / 类型）→ 豆瓣编号：片名规范化后一样才认，多个同名的按年份最接近 */
export function pickDoubanMatch(
  items: { target_type?: string; target?: SearchTarget }[],
  query: { title: string; year?: string; kind?: 'tv' | 'movie' },
): { id: string; kind: 'tv' | 'movie' } | undefined {
  const want = canonicalTitle(query.title);
  const wantYear = parseInt(query.year ?? '', 10);
  let best: { id: string; kind: 'tv' | 'movie'; score: number } | undefined;
  for (const it of items) {
    const kind = it.target_type === 'tv' ? 'tv' : it.target_type === 'movie' ? 'movie' : undefined;
    const t = it.target;
    if (!kind || !t?.id || !t.title || canonicalTitle(t.title) !== want) continue;
    const year = parseInt(t.year ?? '', 10);
    const yearGap = Number.isFinite(wantYear) && Number.isFinite(year) ? Math.abs(year - wantYear) : 0;
    const score = (query.kind === kind ? 10 : 0) - yearGap;
    if (!best || score > best.score) best = { id: t.id, kind, score };
  }
  return best && { id: best.id, kind: best.kind };
}

async function resolveDoubanId(title: string, year?: string, kind?: 'tv' | 'movie'): Promise<{ id: string; kind: 'tv' | 'movie' } | undefined> {
  const key = `douban-id:${canonicalTitle(title)}:${year ?? ''}:${kind ?? ''}`;
  const cached = getCache<{ id: string; kind: 'tv' | 'movie' } | null>(key);
  if (cached !== undefined) return cached ?? undefined;
  const res = await rexxar<{ items?: { target_type?: string; target?: SearchTarget }[] }>(
    `/search/movie?q=${encodeURIComponent(title)}&start=0&count=10`,
  );
  if (!res) return undefined;
  const hit = pickDoubanMatch(res.items ?? [], { title, year, kind });
  setCache(key, hit ?? null, hit ? ID_TTL : FAIL_TTL);
  return hit;
}

export async function fetchSimilar(input: {
  title: string;
  year?: string;
  kind?: 'tv' | 'movie';
  /** 已知的豆瓣编号（从豆瓣卡片点进来看的有） */
  doubanId?: string;
}): Promise<DoubanItem[]> {
  const target =
    input.doubanId && /^\d+$/.test(input.doubanId)
      ? { id: input.doubanId, kind: input.kind ?? 'tv' }
      : await resolveDoubanId(input.title, input.year, input.kind);
  if (!target) return [];
  const key = `douban-similar:${target.kind}:${target.id}`;
  const cached = getCache<DoubanItem[]>(key);
  if (cached) return cached;
  let raw = await rexxar<unknown[]>(`/${target.kind}/${target.id}/recommendations?start=0&count=20`);
  // 只知道编号不知道类型时猜错了：换另一种再试
  if (!Array.isArray(raw) && input.doubanId && !input.kind) {
    raw = await rexxar<unknown[]>(`/movie/${target.id}/recommendations?start=0&count=20`);
  }
  if (!Array.isArray(raw)) {
    setCache(key, [], FAIL_TTL);
    return [];
  }
  const nowYear = new Date(Date.now() + 8 * 3600_000).getUTCFullYear();
  let items: DoubanItem[] = raw
    .map((row) => {
      const type = (row as { type?: string }).type;
      return rexxarToItem(row, type === 'tv', nowYear);
    })
    .filter((item): item is DoubanItem => Boolean(item))
    // 豆瓣会推还没播的定档作品（2027、2028 年）：片源站不会有
    .filter((item) => !item.year || parseInt(item.year, 10) <= nowYear)
    .map((item) => ({ ...item, sourceLabel: '豆瓣相似推荐' }));
  try {
    items = dropUnreleased(items, await fetchUnreleasedIndex());
  } catch {
    // 索引取不到就不剔
  }
  setCache(key, items, SIMILAR_TTL);
  return items;
}
