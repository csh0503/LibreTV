import type { DoubanItem } from './types';
import { fetchUpstream, getCache, setCache } from './fetch-utils';
import { canonicalTitle } from './title-aliases';

/**
 * 全网实时影视热榜聚合（多源合一 + 自动降级）：
 * 1. 豆瓣官方直连 subject_collection 实时热门与口碑系列（免 Key，含年代/地区/题材/主演/热评）
 * 2. Bilibili PGC 实时三日热度榜（免 Key，含国创/日番/纪录片/影视、16:9 横版海报、更新集数与播放量）
 * 3. 60s API 聚合（百度实时热播剧榜 + 豆瓣周榜兜底）
 * 4. TMDB 全球实时趋势榜（配置 TMDB_API_KEY 时启用，含 16:9 高清剧照与中文简介；未配置时平滑回退全球热榜）
 * 5. realtime_all：全网实时风向标（多源头部交叉去重融合，供首页大图轮播与综合热榜使用）
 */

const REALTIME_CACHE_TTL = 15 * 60 * 1000;
const WEEKLY_CACHE_TTL = 60 * 60 * 1000;
const UA = 'LibreTV (+https://github.com/LibreSpark/LibreTV)';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const FALLBACK_BASE = 'https://60s.viki.moe';

function apiBase(): string {
  return (process.env['60S_API_BASE'] || 'https://60s.crystelf.top').replace(/\/+$/, '');
}

/** 支持的全部榜单标识（向后兼容旧版 6 个 ID，新增实时多源 ID） */
export const HOT_LIST_IDS = [
  'realtime_all',
  'douban_tv_realtime',
  'douban_movie_realtime',
  'bili_guochuang',
  'bili_bangumi',
  'douban_tv_domestic',
  'douban_tv_american',
  'douban_tv_korean',
  'douban_tv_japanese',
  'douban_anime_hot',
  'douban_show_hot',
  'bili_doc',
  'bili_tv',
  'bili_movie',
  'tmdb_trending',
  'douban_movie_weekly',
  'douban_tv_chinese',
  'douban_tv_global',
  'douban_show_chinese',
  'douban_show_global',
  'baidu_teleplay',
] as const;

export type HotListId = (typeof HOT_LIST_IDS)[number];

export function isHotListId(id: string): id is HotListId {
  return (HOT_LIST_IDS as readonly string[]).includes(id);
}

/** 豆瓣 subject_collection 集合映射（实时榜 + 周口碑榜） */
const DOUBAN_COLLECTION_MAP: Partial<
  Record<HotListId, { collection: string; isTv: boolean; label: string }>
> = {
  douban_tv_realtime: { collection: 'tv_real_time_hotest', isTv: true, label: '豆瓣实时剧集' },
  douban_movie_realtime: { collection: 'movie_real_time_hotest', isTv: false, label: '豆瓣实时电影' },
  douban_tv_domestic: { collection: 'tv_domestic', isTv: true, label: '热播国产剧' },
  douban_tv_american: { collection: 'tv_american', isTv: true, label: '热播欧美剧' },
  douban_tv_korean: { collection: 'tv_korean', isTv: true, label: '热播韩剧' },
  douban_tv_japanese: { collection: 'tv_japanese', isTv: true, label: '热播日剧' },
  douban_anime_hot: { collection: 'tv_animation', isTv: true, label: '热门动漫' },
  douban_show_hot: { collection: 'show_hot', isTv: true, label: '热门综艺' },
  douban_movie_weekly: { collection: 'movie_weekly_best', isTv: false, label: '一周口碑电影' },
  douban_tv_chinese: { collection: 'tv_chinese_best_weekly', isTv: true, label: '华语口碑剧集' },
  douban_tv_global: { collection: 'tv_global_best_weekly', isTv: true, label: '全球口碑剧集' },
  douban_show_chinese: { collection: 'show_chinese_best_weekly', isTv: true, label: '国内口碑综艺' },
  douban_show_global: { collection: 'show_global_best_weekly', isTv: true, label: '海外口碑综艺' },
};

/** 60s API 豆瓣周榜路径（作为直连失败时的自动降级兜底） */
const DOUBAN_WEEKLY_CATEGORY: Partial<Record<HotListId, string>> = {
  douban_movie_weekly: 'movie',
  douban_tv_chinese: 'tv_chinese',
  douban_tv_global: 'tv_global',
  douban_show_chinese: 'show_chinese',
  douban_show_global: 'show_global',
};

/** B站 PGC 排行榜 season_type 映射：1=番剧, 2=电影, 3=纪录片, 4=国创, 5=电视剧 */
const BILI_SEASON_TYPE_MAP: Partial<
  Record<HotListId, { seasonType: number; isTv: boolean; label: string; area?: string; genres?: string }>
> = {
  bili_bangumi: { seasonType: 1, isTv: true, label: 'B站番剧热播', area: '日本', genres: '动画 番剧' },
  bili_guochuang: { seasonType: 4, isTv: true, label: 'B站国创热播', area: '中国大陆', genres: '动画 国创' },
  bili_doc: { seasonType: 3, isTv: true, label: 'B站纪录片榜', genres: '纪录片' },
  bili_tv: { seasonType: 5, isTv: true, label: 'B站热播剧集', genres: '剧情' },
  bili_movie: { seasonType: 2, isTv: false, label: 'B站热播电影' },
};

// —— 原始接口结构 ——

export interface DoubanWeeklyRaw {
  id?: number | string;
  title?: string;
  rating?: number;
  cover_proxy?: string;
  cover?: string;
}

export interface BaiduTeleplayRaw {
  title?: string;
  cover?: string | null;
  desc?: string;
  score_desc?: string;
}

export interface DoubanCollectionItemRaw {
  id?: string | number;
  title?: string;
  year?: string | number;
  info?: string;
  card_subtitle?: string;
  episodes_info?: string;
  description?: string;
  recommended_reason?: string;
  pic?: { large?: string; normal?: string };
  cover?: { url?: string };
  rating?: { value?: number };
  comments?: { comment?: string }[];
}

export interface BiliRankItemRaw {
  season_id?: number | string;
  title?: string;
  cover?: string;
  ss_horizontal_cover?: string;
  rating?: string;
  new_ep?: { cover?: string; index_show?: string };
  icon_font?: { text?: string };
  stat?: { view?: number; follow?: number };
}

export interface TmdbTrendingRaw {
  id?: number | string;
  title?: string;
  name?: string;
  media_type?: 'movie' | 'tv' | string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
}

interface SixtyResponse<T> {
  code?: number;
  data?: T;
}

function ensureHttps(url: string | undefined | null): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^http:\/\//i, 'https://');
}

/** 豆瓣周榜条目（60s API） → DoubanItem；缺标题或封面的脏数据丢弃 */
export function doubanWeeklyToItem(raw: DoubanWeeklyRaw, isTv: boolean): DoubanItem | undefined {
  const cover = raw.cover || raw.cover_proxy;
  if (!raw.id || !raw.title || !cover) return undefined;
  return {
    id: String(raw.id),
    title: raw.title,
    cover,
    rating: raw.rating && raw.rating > 0 ? String(raw.rating) : undefined,
    isTv,
  };
}

/** 百度热播剧条目 → DoubanItem；保留热度值和剧情简介 */
export function baiduTeleplayToItem(raw: BaiduTeleplayRaw, index: number): DoubanItem | undefined {
  if (!raw.title || !raw.cover) return undefined;
  const item: DoubanItem = {
    id: `baidu_${index}`,
    title: raw.title,
    cover: raw.cover,
    isTv: true,
  };
  if (raw.score_desc) item.remarks = `🔥 ${raw.score_desc}热度`;
  if (raw.desc) item.subtitle = raw.desc.trim();
  if (raw.score_desc || raw.desc) item.sourceLabel = '百度热播';
  return item;
}

/** 豆瓣官方 subject_collection 条目 → DoubanItem（含年代、地区、题材、演员/热评看点） */
export function doubanCollectionToItem(
  raw: DoubanCollectionItemRaw,
  isTv: boolean,
  sourceLabel?: string
): DoubanItem | undefined {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const id = raw.id != null ? String(raw.id) : '';
  const cover = ensureHttps(raw.pic?.large || raw.pic?.normal || raw.cover?.url);
  if (!title || !id || !cover) return undefined;

  const sub = (typeof raw.card_subtitle === 'string' && raw.card_subtitle) || '';
  const info = (typeof raw.info === 'string' && raw.info) || '';
  const parts = (sub || info)
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);

  let year: string | undefined =
    typeof raw.year === 'string' && /^\d{4}$/.test(raw.year)
      ? raw.year
      : typeof raw.year === 'number'
        ? String(raw.year)
        : undefined;
  let offset = 0;
  if (parts[0] && /^\d{4}$/.test(parts[0])) {
    if (!year) year = parts[0];
    offset = 1;
  }
  const area = parts[offset] || undefined;
  const genres = parts[offset + 1] || undefined;
  const castOrStaff = parts.slice(offset + 2).join(' · ');

  const ratingVal = raw.rating?.value;
  const rating =
    typeof ratingVal === 'number' && ratingVal > 0 ? Number(ratingVal.toFixed(1)).toString() : undefined;

  const episodes = typeof raw.episodes_info === 'string' ? raw.episodes_info.trim() : '';
  let status: 'airing' | 'ended' | undefined;
  if (isTv && episodes) {
    if (/更新至|连载/.test(episodes)) status = 'airing';
    else if (/^全\s*\d+|完结/.test(episodes)) status = 'ended';
  }

  const commentText = raw.comments?.[0]?.comment?.replace(/\s*--.*$/, '').trim();
  const subtitle =
    (typeof raw.description === 'string' && raw.description.trim()) ||
    (typeof raw.recommended_reason === 'string' && raw.recommended_reason.trim()) ||
    commentText ||
    castOrStaff ||
    undefined;

  const item: DoubanItem = {
    id,
    title,
    cover,
    rating,
    isTv,
    year,
    area,
    genres,
    remarks: episodes || undefined,
    status,
    subtitle,
    sourceLabel,
  };
  return item;
}

/** B站 PGC 排行榜条目 → DoubanItem（含 16:9 横版海报、评分、更新集数、播放量） */
export function biliRankToItem(
  raw: BiliRankItemRaw,
  opts: { isTv: boolean; label: string; area?: string; genres?: string }
): DoubanItem | undefined {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const cover = ensureHttps(raw.cover);
  if (!title || !cover || !raw.season_id) return undefined;

  const backdrop = ensureHttps(raw.ss_horizontal_cover || raw.new_ep?.cover);
  const rawRating = typeof raw.rating === 'string' ? raw.rating.replace(/分$/, '').trim() : '';
  const ratingNum = parseFloat(rawRating);
  const rating = Number.isFinite(ratingNum) && ratingNum > 0 ? ratingNum.toFixed(1) : undefined;

  const indexShow = raw.new_ep?.index_show?.trim() || '';
  let status: 'airing' | 'ended' | undefined;
  if (opts.isTv && indexShow) {
    if (/更新至|连载/.test(indexShow)) status = 'airing';
    else if (/^全\s*\d+|完结/.test(indexShow)) status = 'ended';
  }

  const stats: string[] = [];
  if (raw.icon_font?.text) stats.push(`${raw.icon_font.text}播放`);
  if (typeof raw.stat?.follow === 'number' && raw.stat.follow >= 10_000) {
    stats.push(`${(raw.stat.follow / 10_000).toFixed(1).replace(/\.0$/, '')}万追番`);
  }

  return {
    id: `bili_${raw.season_id}`,
    title,
    cover,
    backdrop,
    rating,
    isTv: opts.isTv,
    area: opts.area,
    genres: opts.genres,
    remarks: indexShow || undefined,
    status,
    subtitle: stats.length > 0 ? stats.join(' · ') : undefined,
    sourceLabel: opts.label,
  };
}

/** TMDB 趋势条目 → DoubanItem */
export function tmdbTrendingToItem(raw: TmdbTrendingRaw): DoubanItem | undefined {
  const title = (raw.title || raw.name || '').trim();
  if (!raw.id || !title || !raw.poster_path) return undefined;
  const cover = `https://image.tmdb.org/t/p/w500${raw.poster_path}`;
  const backdrop = raw.backdrop_path ? `https://image.tmdb.org/t/p/w1280${raw.backdrop_path}` : undefined;
  const isTv = raw.media_type === 'tv' || (!raw.title && !!raw.name);
  const dateStr = raw.release_date || raw.first_air_date || '';
  const year = /^\d{4}/.test(dateStr) ? dateStr.slice(0, 4) : undefined;
  const rating =
    typeof raw.vote_average === 'number' && raw.vote_average > 0 ? raw.vote_average.toFixed(1) : undefined;

  return {
    id: `tmdb_${raw.id}`,
    title,
    cover,
    backdrop,
    rating,
    isTv,
    year,
    subtitle: raw.overview?.trim() || undefined,
    sourceLabel: 'TMDB 全球趋势',
  };
}

/** 将多个实时榜按名次交叉穿插并按归一化标题去重，让综合榜兼顾热剧、大片、国漫与日番 */
export function interleaveAndDedupeLists(lists: DoubanItem[][], limit = 24): DoubanItem[] {
  const result: DoubanItem[] = [];
  const seen = new Set<string>();
  const maxLen = Math.max(0, ...lists.map((l) => l.length));

  for (let i = 0; i < maxLen && result.length < limit; i++) {
    for (const list of lists) {
      const item = list[i];
      if (!item) continue;
      const key = canonicalTitle(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(item);
      if (result.length >= limit) break;
    }
  }
  return result;
}

function assertArray<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${what}数据异常`);
  return value as T[];
}

async function fetchSixtyJson(path: string): Promise<unknown> {
  const primary = apiBase();
  const bases = primary === FALLBACK_BASE ? [primary] : [primary, FALLBACK_BASE];

  let lastError: unknown;
  for (const base of bases) {
    try {
      const res = await fetchUpstream(`${base}${path}`, {
        timeoutMs: 8000,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`60s API 响应异常 (${res.status})`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('60s API 请求失败');
}

async function fetchDoubanCollection(
  collection: string,
  isTv: boolean,
  sourceLabel: string,
  count = 24
): Promise<DoubanItem[]> {
  const url = `https://m.douban.com/rexxar/api/v2/subject_collection/${collection}/items?start=0&count=${count}`;
  const res = await fetchUpstream(url, {
    timeoutMs: 8000,
    headers: {
      'User-Agent': MOBILE_UA,
      Referer: 'https://m.douban.com/movie/',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`豆瓣实时榜单响应异常 (${res.status})`);
  const json = (await res.json()) as { subject_collection_items?: DoubanCollectionItemRaw[] };
  const rows = assertArray<DoubanCollectionItemRaw>(json.subject_collection_items, '豆瓣实时榜单');
  const items = rows
    .map((row) => doubanCollectionToItem(row, isTv, sourceLabel))
    .filter((item): item is DoubanItem => item !== undefined);
  if (items.length === 0) throw new Error('豆瓣榜单数据为空');
  return items;
}

async function fetchBiliRank(opts: {
  seasonType: number;
  isTv: boolean;
  label: string;
  area?: string;
  genres?: string;
}): Promise<DoubanItem[]> {
  const url = `https://api.bilibili.com/pgc/web/rank/list?day=3&season_type=${opts.seasonType}`;
  const res = await fetchUpstream(url, {
    timeoutMs: 8000,
    headers: {
      'User-Agent': DESKTOP_UA,
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`B站热播榜响应异常 (${res.status})`);
  const json = (await res.json()) as {
    code?: number;
    result?: { list?: BiliRankItemRaw[] };
    data?: { list?: BiliRankItemRaw[] };
  };
  const rawList = json.result?.list || json.data?.list;
  const rows = assertArray<BiliRankItemRaw>(rawList, 'B站热播榜');
  const items = rows
    .slice(0, 30)
    .map((row) => biliRankToItem(row, opts))
    .filter((item): item is DoubanItem => item !== undefined);
  if (items.length === 0) throw new Error('B站热播榜为空');
  return items;
}

async function fetchTmdbTrending(): Promise<DoubanItem[]> {
  const apiKey = (process.env.TMDB_API_KEY || process.env.NEXT_PUBLIC_TMDB_API_KEY || '').trim();
  if (!apiKey) {
    // 未配置 TMDB_API_KEY 时平滑回退到全球口碑剧集 + 实时热门电影组合
    const [globalTv, realtimeMovie] = await Promise.allSettled([
      fetchHotList('douban_tv_global'),
      fetchHotList('douban_movie_realtime'),
    ]);
    const lists: DoubanItem[][] = [];
    if (globalTv.status === 'fulfilled') lists.push(globalTv.value);
    if (realtimeMovie.status === 'fulfilled') lists.push(realtimeMovie.value);
    const merged = interleaveAndDedupeLists(lists, 24);
    if (merged.length === 0) throw new Error('全球趋势榜获取失败');
    return merged;
  }

  const isBearer = apiKey.length > 40 && apiKey.includes('.');
  const url = isBearer
    ? 'https://api.themoviedb.org/3/trending/all/day?language=zh-CN'
    : `https://api.themoviedb.org/3/trending/all/day?language=zh-CN&api_key=${encodeURIComponent(apiKey)}`;
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' };
  if (isBearer) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchUpstream(url, { timeoutMs: 8000, headers });
  if (!res.ok) throw new Error(`TMDB 接口响应异常 (${res.status})`);
  const json = (await res.json()) as { results?: TmdbTrendingRaw[] };
  const rows = assertArray<TmdbTrendingRaw>(json.results, 'TMDB 趋势榜');
  const items = rows
    .map((row) => tmdbTrendingToItem(row))
    .filter((item): item is DoubanItem => item !== undefined);
  if (items.length === 0) throw new Error('TMDB 趋势榜为空');
  return items;
}

export async function fetchHotList(id: HotListId): Promise<DoubanItem[]> {
  const cacheKey = `hot-list:${id}`;
  const cached = getCache<DoubanItem[]>(cacheKey);
  if (cached) return cached;

  let items: DoubanItem[];
  let ttl = REALTIME_CACHE_TTL;

  if (id === 'realtime_all') {
    const settled = await Promise.allSettled([
      fetchHotList('douban_tv_realtime'),
      fetchHotList('bili_guochuang'),
      fetchHotList('douban_movie_realtime'),
      fetchHotList('bili_bangumi'),
      fetchHotList('baidu_teleplay'),
    ]);
    const lists = settled
      .filter((r): r is PromiseFulfilledResult<DoubanItem[]> => r.status === 'fulfilled')
      .map((r) => r.value);
    items = interleaveAndDedupeLists(lists, 24);
    if (items.length === 0) throw new Error('全网实时热榜聚合失败');
  } else if (BILI_SEASON_TYPE_MAP[id]) {
    items = await fetchBiliRank(BILI_SEASON_TYPE_MAP[id]!);
  } else if (id === 'tmdb_trending') {
    items = await fetchTmdbTrending();
  } else if (DOUBAN_COLLECTION_MAP[id]) {
    const cfg = DOUBAN_COLLECTION_MAP[id]!;
    const fallbackCategory = DOUBAN_WEEKLY_CATEGORY[id];
    if (fallbackCategory) ttl = WEEKLY_CACHE_TTL;
    try {
      items = await fetchDoubanCollection(cfg.collection, cfg.isTv, cfg.label);
    } catch (primaryErr) {
      if (!fallbackCategory) throw primaryErr;
      const raw = (await fetchSixtyJson(`/v2/douban/weekly/${fallbackCategory}`)) as SixtyResponse<DoubanWeeklyRaw[]>;
      const isTv = id !== 'douban_movie_weekly';
      items = assertArray<DoubanWeeklyRaw>(raw.data, '豆瓣周榜')
        .map((entry) => doubanWeeklyToItem(entry, isTv))
        .filter((item): item is DoubanItem => item !== undefined);
    }
  } else {
    const raw = (await fetchSixtyJson('/v2/baidu/teleplay')) as SixtyResponse<BaiduTeleplayRaw[]>;
    items = assertArray<BaiduTeleplayRaw>(raw.data, '百度热播剧榜')
      .map((entry, i) => baiduTeleplayToItem(entry, i))
      .filter((item): item is DoubanItem => item !== undefined);
  }

  if (items.length === 0) throw new Error('榜单数据为空');

  setCache(cacheKey, items, ttl);
  return items;
}
