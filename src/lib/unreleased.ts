import type { DoubanItem } from './types';
import { fetchUpstream, getCache, setCache } from './fetch-utils';
import { getTmdbApiKey } from './douban-weekly';
import { canonicalTitle } from './title-aliases';

/**
 * 「还没播出」权威索引。
 * 豆瓣 / B站的片库把年番、预告、定档作品也排进热度榜，状态还会被误判成已完结。
 * 这里用两个带开播日期的源建一张「标题 → 开播日期」表，片库和榜单据此剔除未播出的条目，
 * 它们只应该出现在「即将播出」：
 * - Bangumi v0 搜索：开播日期晚于今天的动画（含 Netflix / 剧场版，带中文名与封面）
 * - TMDB discover：首播 / 上映日期晚于今天的剧集与电影（zh-CN 标题）
 */

const UA = 'LibreTV (+https://github.com/LibreSpark/LibreTV)';
const DAY = 24 * 60 * 60 * 1000;
const CN_OFFSET = 8 * 60 * 60 * 1000;
const OK_TTL = 3 * 60 * 60 * 1000;
const FAIL_TTL = 5 * 60 * 1000;

function cnDate(ms: number): string {
  return new Date(ms + CN_OFFSET).toISOString().slice(0, 10);
}

export interface BangumiSoonSubject {
  name: string;
  nameCn?: string;
  /** YYYY-MM-DD，一定晚于查询当天（北京时间） */
  date: string;
  cover?: string;
  rating?: string;
}

interface BgmSearchRow {
  name?: string;
  name_cn?: string;
  date?: string;
  images?: { large?: string; common?: string; medium?: string };
  rating?: { score?: number };
}

/** Bangumi 上开播日期晚于今天（北京时间）的动画，按热度取前 100 */
export async function fetchBangumiSoon(now = Date.now()): Promise<BangumiSoonSubject[]> {
  const today = cnDate(now);
  const key = `unreleased:bgm:${today}`;
  const cached = getCache<BangumiSoonSubject[]>(key);
  if (cached) return cached;

  const out: BangumiSoonSubject[] = [];
  let ok = true;
  for (const offset of [0, 50]) {
    try {
      const res = await fetchUpstream(`https://api.bgm.tv/v0/search/subjects?limit=50&offset=${offset}`, {
        method: 'POST',
        timeoutMs: 7000,
        headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          keyword: '',
          sort: 'heat',
          filter: { type: [2], air_date: [`>${today}`] },
        }),
      });
      if (!res.ok) {
        ok = false;
        break;
      }
      const json = (await res.json()) as { data?: BgmSearchRow[] };
      const rows = Array.isArray(json.data) ? json.data : [];
      for (const r of rows) {
        if (!r.name || !r.date || r.date <= today) continue;
        out.push({
          name: r.name,
          nameCn: r.name_cn?.trim() || undefined,
          date: r.date,
          cover: r.images?.large || r.images?.common || r.images?.medium,
          rating: r.rating?.score && r.rating.score > 0 ? r.rating.score.toFixed(1) : undefined,
        });
      }
      if (rows.length < 50) break;
    } catch {
      ok = false;
      break;
    }
  }
  setCache(key, out, ok ? OK_TTL : FAIL_TTL);
  return out;
}

interface TmdbFutureRow {
  title?: string;
  name?: string;
  release_date?: string;
  first_air_date?: string;
}

async function fetchTmdbFuture(kind: 'tv' | 'movie', now: number): Promise<{ title: string; date: string }[]> {
  const apiKey = getTmdbApiKey();
  if (!apiKey) return [];
  const isBearer = apiKey.length > 40 && apiKey.includes('.');
  const from = cnDate(now + DAY);
  const to = cnDate(now + 400 * DAY);
  const dateField = kind === 'tv' ? 'first_air_date' : 'primary_release_date';
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' };
  if (isBearer) headers.Authorization = `Bearer ${apiKey}`;

  const out: { title: string; date: string }[] = [];
  for (const page of [1, 2]) {
    const sp = new URLSearchParams({
      language: 'zh-CN',
      sort_by: 'popularity.desc',
      page: String(page),
      [`${dateField}.gte`]: from,
      [`${dateField}.lte`]: to,
    });
    if (!isBearer) sp.set('api_key', apiKey);
    try {
      const res = await fetchUpstream(`https://api.themoviedb.org/3/discover/${kind}?${sp.toString()}`, {
        timeoutMs: 7000,
        headers,
      });
      if (!res.ok) break;
      const json = (await res.json()) as { results?: TmdbFutureRow[] };
      for (const r of json.results ?? []) {
        const title = (r.title || r.name || '').trim();
        const date = r.release_date || r.first_air_date || '';
        if (title && /^\d{4}-\d{2}-\d{2}$/.test(date)) out.push({ title, date });
      }
    } catch {
      break;
    }
  }
  return out;
}

/** 规范化标题 → 开播日期（最早的一个） */
export type UnreleasedIndex = Map<string, string>;

function addEntry(index: UnreleasedIndex, title: string | undefined, date: string) {
  if (!title) return;
  const key = canonicalTitle(title);
  if (!key) return;
  const prev = index.get(key);
  if (!prev || date < prev) index.set(key, date);
}

export async function fetchUnreleasedIndex(now = Date.now()): Promise<UnreleasedIndex> {
  const key = `unreleased:index:${cnDate(now)}`;
  const cached = getCache<[string, string][]>(key);
  if (cached) return new Map(cached);

  const [bgm, tv, movie] = await Promise.allSettled([
    fetchBangumiSoon(now),
    fetchTmdbFuture('tv', now),
    fetchTmdbFuture('movie', now),
  ]);
  const index: UnreleasedIndex = new Map();
  if (bgm.status === 'fulfilled') {
    for (const s of bgm.value) {
      addEntry(index, s.nameCn, s.date);
      addEntry(index, s.name, s.date);
    }
  }
  for (const res of [tv, movie]) {
    if (res.status !== 'fulfilled') continue;
    for (const r of res.value) addEntry(index, r.title, r.date);
  }
  const allFailed = [bgm, tv, movie].every((r) => r.status === 'rejected' || (Array.isArray(r.value) && r.value.length === 0));
  setCache(key, [...index.entries()], allFailed ? FAIL_TTL : OK_TTL);
  return index;
}

/** 条目的备注里已经有集数 / 更新信息，说明肯定播出过了 */
const HAS_EPISODES = /更新至|\d+\s*[集话期]/;

/**
 * 剔除还没播出的条目。
 * 同名老作品不误伤：条目年份和开播年份对不上就保留；备注里已有集数的也保留。
 */
export function dropUnreleased(items: DoubanItem[], index: UnreleasedIndex): DoubanItem[] {
  if (index.size === 0) return items;
  return items.filter((item) => {
    if (item.remarks && HAS_EPISODES.test(item.remarks)) return true;
    const date = index.get(canonicalTitle(item.title));
    if (!date) return true;
    if (item.year && item.year !== date.slice(0, 4)) return true;
    return false;
  });
}
