import { fetchUpstream, getCache, setCache } from './fetch-utils';
import { tmdbGet } from './tmdb';
import { fetchBangumiSoon } from './unreleased';

/**
 * 「即将播出」：接下来 7 天还没播出的内容。
 * - 动漫：AniList 官方放送时刻表（精确到每一集的播出时间戳与集数，免 Key），
 *   再用 Bangumi 的日文原名 → 中文名映射拿到中文标题与海报（片源站都用中文名）。
 * - 剧集：TMDB 本周有新集的热门剧（next_episode_to_air 给出集数与日期）+ 本周首播的新剧。
 * - 电影：TMDB 本周在中国大陆（不足时补美国）上映的电影。
 * 只保留有中文名的条目，避免点开后搜不到。
 */

export type UpcomingKind = 'anime' | 'tv' | 'movie';

export interface UpcomingItem {
  id: string;
  title: string;
  cover: string;
  kind: UpcomingKind;
  /** 播出时间（毫秒）。timeKnown=false 时只精确到日期（按北京时间当天 20:00 估算排序） */
  airingAt: number;
  timeKnown: boolean;
  /** 第几集；电影为空 */
  episode?: number;
  /** 首播 / 首映：之前没有可看的集数 */
  premiere: boolean;
  rating?: string;
  area?: string;
  sourceLabel: string;
}

const CACHE_TTL = 60 * 60 * 1000;
const UA = 'LibreTV (+https://github.com/LibreSpark/LibreTV)';
const DAY = 24 * 60 * 60 * 1000;
const CN_OFFSET = 8 * 60 * 60 * 1000;

/** 北京时间的 YYYY-MM-DD */
export function cnDateString(ms: number): string {
  return new Date(ms + CN_OFFSET).toISOString().slice(0, 10);
}

/** 北京时间某天 20:00 对应的毫秒（只知道日期时用于排序） */
function cnEveningOf(date: string): number {
  return Date.parse(`${date}T20:00:00+08:00`);
}

const hasCJK = (s: string) => /[\u4e00-\u9fa5]/.test(s);
/** 日文原名归一：去空格与常见标点，便于和 Bangumi name 对齐 */
export function normalizeNative(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s　・·:：!！?？、。,，.\-—~～「」『』【】()（）\[\]]+/g, '')
    .trim();
}

// —— Bangumi 中文名映射 ——

interface BgmSubjectLite {
  id?: number;
  name?: string;
  name_cn?: string;
  images?: { large?: string; common?: string };
  rating?: { score?: number };
}

interface ChineseMeta {
  title: string;
  cover?: string;
  rating?: string;
}

async function fetchBangumiNativeMap(): Promise<Map<string, ChineseMeta>> {
  const key = 'upcoming:bgm-native-map';
  const cached = getCache<[string, ChineseMeta][]>(key);
  if (cached) return new Map(cached);
  const map = new Map<string, ChineseMeta>();
  try {
    const res = await fetchUpstream('https://api.bgm.tv/calendar', {
      timeoutMs: 8000,
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (res.ok) {
      const days = (await res.json()) as { items?: BgmSubjectLite[] }[];
      for (const day of Array.isArray(days) ? days : []) {
        for (const s of day.items ?? []) {
          if (!s.name || !s.name_cn) continue;
          map.set(normalizeNative(s.name), {
            title: s.name_cn.trim(),
            cover: s.images?.large || s.images?.common,
            rating: s.rating?.score ? s.rating.score.toFixed(1) : undefined,
          });
        }
      }
    }
  } catch {
    // 映射失败时退回 AniList 自带的中文别名
  }
  // 还没开播的（首播在未来几天）不在 calendar 里，用开播日期索引补上；
  // 它的 name 可能是英文 / 罗马音（Netflix 等），照样按 name 建键，AniList 的 romaji / english 也能对上
  try {
    for (const s of await fetchBangumiSoon()) {
      if (!s.nameCn) continue;
      const k = normalizeNative(s.name);
      if (k && !map.has(k)) map.set(k, { title: s.nameCn, cover: s.cover, rating: s.rating });
    }
  } catch {
    // 补充失败不影响 calendar 映射
  }
  setCache(key, [...map.entries()], CACHE_TTL);
  return map;
}

/** 新番首播前往往不在 calendar 里，用 Bangumi 搜索按日文原名补中文名 */
async function searchBangumiChinese(native: string): Promise<ChineseMeta | undefined> {
  const key = `upcoming:bgm-search:${native}`;
  const cached = getCache<ChineseMeta | null>(key);
  if (cached !== undefined) return cached ?? undefined;
  let found: ChineseMeta | undefined;
  try {
    const res = await fetchUpstream('https://api.bgm.tv/v0/search/subjects?limit=3', {
      method: 'POST',
      timeoutMs: 6000,
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ keyword: native, filter: { type: [2] } }),
    });
    if (res.ok) {
      const json = (await res.json()) as { data?: BgmSubjectLite[] };
      const target = normalizeNative(native);
      const hit =
        (json.data ?? []).find((s) => s.name && normalizeNative(s.name) === target && s.name_cn) ||
        (json.data ?? []).find((s) => s.name && s.name_cn && normalizeNative(s.name).startsWith(target));
      if (hit?.name_cn) {
        found = { title: hit.name_cn.trim(), cover: hit.images?.large || hit.images?.common };
      }
    }
  } catch {
    // 忽略
  }
  setCache(key, found ?? null, 6 * CACHE_TTL);
  return found;
}

/** 前缀命中时，多出来的部分若是季数 / 序号（「2」「第二季」「Season 2」），说明是另一季，不能当成同一部 */
const SEASON_SUFFIX = /^(\d|第|season|part|s\d|[ⅰⅱⅲⅳⅴⅵ])/i;

export function lookupChinese(map: Map<string, ChineseMeta>, native: string): ChineseMeta | undefined {
  const n = normalizeNative(native);
  if (!n) return undefined;
  const exact = map.get(n);
  if (exact) return exact;
  for (const [k, v] of map) {
    if (k.length < 4) continue;
    const longer = n.length >= k.length ? n : k;
    const shorter = n.length >= k.length ? k : n;
    if (longer.startsWith(shorter) && !SEASON_SUFFIX.test(longer.slice(shorter.length))) return v;
  }
  return undefined;
}

/** AniList 同一部作品有日文原名、罗马音、英文名三种写法，依次精确匹配，最后才回退到前缀匹配 */
export function lookupChineseByNames(map: Map<string, ChineseMeta>, names: (string | undefined)[]): ChineseMeta | undefined {
  const list = names.filter((n): n is string => Boolean(n && n.trim()));
  for (const name of list) {
    const exact = map.get(normalizeNative(name));
    if (exact) return exact;
  }
  for (const name of list) {
    const hit = lookupChinese(map, name);
    if (hit) return hit;
  }
  return undefined;
}

// —— AniList 放送时刻表 ——

interface AniListSchedule {
  airingAt: number;
  episode: number;
  media?: {
    id: number;
    title?: { native?: string; romaji?: string; english?: string };
    synonyms?: string[];
    coverImage?: { extraLarge?: string; large?: string };
    popularity?: number;
    averageScore?: number;
    format?: string;
    isAdult?: boolean;
    countryOfOrigin?: string;
  };
}

const ANILIST_QUERY = `query ($start: Int, $end: Int, $page: Int) {
  Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    airingSchedules(airingAt_greater: $start, airingAt_lesser: $end, sort: TIME) {
      airingAt
      episode
      media {
        id
        title { native romaji english }
        synonyms
        coverImage { extraLarge large }
        popularity
        averageScore
        format
        isAdult
        countryOfOrigin
      }
    }
  }
}`;

async function fetchAniListSchedules(startSec: number, endSec: number): Promise<AniListSchedule[]> {
  const all: AniListSchedule[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await fetchUpstream('https://graphql.anilist.co', {
      method: 'POST',
      timeoutMs: 8000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ query: ANILIST_QUERY, variables: { start: startSec, end: endSec, page } }),
    });
    if (!res.ok) break;
    const json = (await res.json()) as {
      data?: { Page?: { pageInfo?: { hasNextPage?: boolean }; airingSchedules?: AniListSchedule[] } };
    };
    const pageData = json.data?.Page;
    all.push(...(pageData?.airingSchedules ?? []));
    if (!pageData?.pageInfo?.hasNextPage) break;
  }
  return all;
}

async function fetchAnimeUpcoming(now: number): Promise<UpcomingItem[]> {
  const [schedules, bgmMap] = await Promise.all([
    fetchAniListSchedules(Math.floor(now / 1000), Math.floor((now + 7 * DAY) / 1000)),
    fetchBangumiNativeMap(),
  ]);

  // 过滤：成人、冷门（AniList 人气 < 2500）、中国大陆动画（国创另有片源命名，AniList 原名为中文时直接可用）
  const candidates = schedules.filter((s) => {
    const m = s.media;
    if (!m || m.isAdult) return false;
    if (!['TV', 'TV_SHORT', 'ONA', 'MOVIE', 'OVA', 'SPECIAL'].includes(m.format || '')) return false;
    return (m.popularity ?? 0) >= 2500;
  });

  // 同一部一周内可能出现两次（周播 + 下周同一天边界），只保留最近的一集
  const firstByMedia = new Map<number, AniListSchedule>();
  for (const s of candidates) {
    const id = s.media!.id;
    if (!firstByMedia.has(id)) firstByMedia.set(id, s);
  }

  const unresolved: AniListSchedule[] = [];
  const items: UpcomingItem[] = [];

  const toItem = (s: AniListSchedule, meta: ChineseMeta): UpcomingItem => {
    const m = s.media!;
    return {
      id: `anilist_${m.id}_${s.episode}`,
      title: meta.title,
      cover: meta.cover || m.coverImage?.extraLarge || m.coverImage?.large || '',
      kind: 'anime',
      airingAt: s.airingAt * 1000,
      timeKnown: true,
      episode: m.format === 'MOVIE' ? undefined : s.episode,
      premiere: s.episode <= 1,
      rating: meta.rating || (m.averageScore ? (m.averageScore / 10).toFixed(1) : undefined),
      area: m.countryOfOrigin === 'CN' ? '中国大陆' : m.countryOfOrigin === 'KR' ? '韩国' : '日本',
      sourceLabel: 'AniList 放送表',
    };
  };

  for (const s of firstByMedia.values()) {
    const m = s.media!;
    const native = m.title?.native || '';
    // 国创原名本身就是中文
    if (m.countryOfOrigin === 'CN' && hasCJK(native) && !/[\u3040-\u30ff]/.test(native)) {
      items.push(toItem(s, { title: native }));
      continue;
    }
    const meta = lookupChineseByNames(bgmMap, [native, m.title?.romaji, m.title?.english]);
    if (meta) {
      items.push(toItem(s, meta));
      continue;
    }
    unresolved.push(s);
  }

  // 未命中的按人气取前 16 个去 Bangumi 搜中文名；再不行用 AniList 里纯中文的别名
  unresolved.sort((a, b) => (b.media!.popularity ?? 0) - (a.media!.popularity ?? 0));
  const searched = await Promise.all(
    unresolved.slice(0, 16).map(async (s) => {
      const t = s.media!.title;
      let meta: ChineseMeta | undefined;
      for (const name of [t?.native, t?.romaji, t?.english]) {
        if (!name) continue;
        meta = await searchBangumiChinese(name);
        if (meta) break;
      }
      if (meta) return toItem(s, meta);
      const zhSyn = (s.media!.synonyms ?? []).find((x) => hasCJK(x) && !/[\u3040-\u30ff]/.test(x));
      return zhSyn ? toItem(s, { title: zhSyn }) : undefined;
    })
  );
  for (const it of searched) if (it && it.cover) items.push(it);

  return items.filter((i) => i.cover);
}

// —— TMDB 剧集 / 电影 ——

interface TmdbListRow {
  id?: number;
  name?: string;
  title?: string;
  poster_path?: string | null;
  vote_average?: number;
  first_air_date?: string;
  release_date?: string;
  origin_country?: string[];
  genre_ids?: number[];
}

const AREA: Record<string, string> = {
  CN: '中国大陆', HK: '中国香港', TW: '中国台湾', JP: '日本', KR: '韩国', US: '美国', GB: '英国', TH: '泰国',
};

async function fetchTvUpcoming(now: number): Promise<UpcomingItem[]> {
  const today = cnDateString(now);
  const tomorrow = cnDateString(now + DAY);
  const end = cnDateString(now + 7 * DAY);
  const countries = 'CN|HK|TW|KR|JP|US|GB';

  const [ongoing, premieres] = await Promise.all([
    // 本周有新集播出的热门剧（排除动画，动画由 AniList 负责）
    tmdbGet<{ results?: TmdbListRow[] }>('/discover/tv', {
      'air_date.gte': tomorrow,
      'air_date.lte': end,
      sort_by: 'popularity.desc',
      'vote_count.gte': '10',
      without_genres: '16,10767,10763',
      with_origin_country: countries,
    }),
    // 本周首播的新剧
    tmdbGet<{ results?: TmdbListRow[] }>('/discover/tv', {
      'first_air_date.gte': tomorrow,
      'first_air_date.lte': end,
      sort_by: 'popularity.desc',
      without_genres: '16,10767,10763',
      with_origin_country: countries,
    }),
  ]);

  const rows = new Map<number, { row: TmdbListRow; premiere: boolean }>();
  for (const r of premieres?.results ?? []) if (r.id) rows.set(r.id, { row: r, premiere: true });
  for (const r of ongoing?.results ?? []) if (r.id && !rows.has(r.id)) rows.set(r.id, { row: r, premiere: false });

  const picked = [...rows.values()]
    .filter(({ row }) => row.poster_path && row.name && hasCJK(row.name))
    .slice(0, 24);

  const details = await Promise.all(
    picked.map(({ row }) =>
      tmdbGet<{ next_episode_to_air?: { air_date?: string; episode_number?: number; season_number?: number } | null }>(
        `/tv/${row.id}`,
        {}
      )
    )
  );

  const items: UpcomingItem[] = [];
  picked.forEach(({ row, premiere }, idx) => {
    const next = details[idx]?.next_episode_to_air;
    const date = next?.air_date || (premiere ? row.first_air_date : undefined);
    // 只要明天及以后、7 天内（今天的集数播出时间未知，可能已经播了，不放进来）
    if (!date || date <= today || date > end) return;
    const ep = next?.episode_number;
    const season = next?.season_number ?? 1;
    items.push({
      id: `tmdb_tv_${row.id}_${date}`,
      title: row.name!.trim(),
      cover: `https://image.tmdb.org/t/p/w500${row.poster_path}`,
      kind: 'tv',
      airingAt: cnEveningOf(date),
      timeKnown: false,
      episode: ep,
      premiere: premiere || (ep === 1 && season <= 1),
      rating: row.vote_average && row.vote_average > 0 ? row.vote_average.toFixed(1) : undefined,
      area: AREA[row.origin_country?.[0] ?? ''],
      sourceLabel: 'TMDB',
    });
  });
  return items;
}

async function fetchMovieUpcoming(now: number): Promise<UpcomingItem[]> {
  const today = cnDateString(now);
  const tomorrow = cnDateString(now + DAY);
  const end = cnDateString(now + 7 * DAY);
  const query = (region: string) =>
    tmdbGet<{ results?: TmdbListRow[] }>('/discover/movie', {
      region,
      'primary_release_date.gte': tomorrow,
      'primary_release_date.lte': end,
      with_release_type: '2|3|4',
      sort_by: 'popularity.desc',
    });

  const [cn, us] = await Promise.all([query('CN'), query('US')]);
  const seen = new Set<number>();
  const items: UpcomingItem[] = [];
  for (const [list, area] of [[cn?.results ?? [], '中国大陆'], [us?.results ?? [], '美国']] as const) {
    for (const r of list) {
      if (!r.id || seen.has(r.id) || !r.poster_path || !r.title || !hasCJK(r.title)) continue;
      const date = r.release_date;
      if (!date || date <= today || date > end) continue;
      seen.add(r.id);
      items.push({
        id: `tmdb_movie_${r.id}`,
        title: r.title.trim(),
        cover: `https://image.tmdb.org/t/p/w500${r.poster_path}`,
        kind: 'movie',
        airingAt: cnEveningOf(date),
        timeKnown: false,
        premiere: true,
        rating: r.vote_average && r.vote_average > 0 ? r.vote_average.toFixed(1) : undefined,
        area,
        sourceLabel: area === '中国大陆' ? '内地上映' : '北美上映',
      });
    }
  }
  return items.slice(0, 16);
}

export async function fetchUpcoming(now = Date.now()): Promise<UpcomingItem[]> {
  const key = `upcoming:all:${cnDateString(now)}:${Math.floor(now / CACHE_TTL)}`;
  const cached = getCache<UpcomingItem[]>(key);
  if (cached) return cached.filter((i) => i.airingAt > Date.now() || !i.timeKnown);

  const [anime, tv, movie] = await Promise.allSettled([
    fetchAnimeUpcoming(now),
    fetchTvUpcoming(now),
    fetchMovieUpcoming(now),
  ]);
  const items = [
    ...(anime.status === 'fulfilled' ? anime.value : []),
    ...(tv.status === 'fulfilled' ? tv.value : []),
    ...(movie.status === 'fulfilled' ? movie.value : []),
  ].sort((a, b) => a.airingAt - b.airingAt);

  if (items.length === 0) throw new Error('即将播出数据获取失败');
  setCache(key, items, CACHE_TTL);
  return items;
}
