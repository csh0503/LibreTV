import { Converter } from 'opencc-js';
import { getCache, setCache } from './fetch-utils';
import { normalizeTitle } from './cms-parser';
import { tmdbGet } from './tmdb';
import { extractSeasonNumber } from './douban-weekly';

/**
 * 统一条目层（第一步）：同一部作品在不同地方叫法不同——豆瓣 / 大陆叫《大师计划》，台湾叫《終極盜局》，
 * 采集站可能用其中任何一个（常见的是港台译名转简体）。这里用 TMDB 把一个片名解析成作品身份，
 * 收集它所有的中文名（大陆、港、台、新加坡的译名和别名，繁体统一转简体），给「找片源」当备用搜索词。
 */

export type IdentityKind = 'movie' | 'tv';

export interface TitleInfo {
  /** 中文剧情简介 */
  overview?: string;
  tagline?: string;
  genres: string[];
  /** 首播 / 上映日期 YYYY-MM-DD */
  date?: string;
  /** 电影片长（分钟） */
  runtime?: number;
  /** 剧集：总集数（片名带季数时是这一季的集数）/ 总季数 */
  episodes?: number;
  seasons?: number;
  /** 片名带季数时：这是第几季（资讯、日期、集数都是这一季的） */
  season?: number;
  /** 剧集：在播 / 完结（中文） */
  status?: string;
  /** TMDB 评分（0~10）与评分人数 */
  rating?: number;
  votes?: number;
  directors: string[];
  cast: string[];
  networks: string[];
}

export interface TitleIdentity {
  tmdbId: number;
  kind: IdentityKind;
  /** 除了查询用的片名之外的其他中文名（已转简体、去重），按可信度排序 */
  names: string[];
  /** 作品资讯（来自 TMDB 中文资料）；查别名时顺带取回 */
  info?: TitleInfo;
}

const IDENTITY_TTL = 24 * 3600 * 1000;
const MAX_NAMES = 4;
/** 大陆名最常被采集站用到，其次港台；新加坡多与大陆相同 */
const REGION_ORDER = ['CN', 'HK', 'TW', 'SG'];

const twToCn = Converter({ from: 'tw', to: 'cn' });
const hkToCn = Converter({ from: 'hk', to: 'cn' });
const hasCJK = (s: string) => /[一-龥]/.test(s);
const hasKana = (s: string) => /[぀-ヿ]/.test(s);

export function toSimplified(text: string, region?: string): string {
  return region === 'HK' ? hkToCn(text) : twToCn(text);
}

export interface TmdbSearchResult {
  id?: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  release_date?: string;
  first_air_date?: string;
  popularity?: number;
}

/** 搜索结果里挑出这部作品：类型一致、片名一致优先，年份差 1 年以内，其次看热度 */
export function pickBestMatch(
  results: TmdbSearchResult[],
  query: { title: string; year?: string; kind?: IdentityKind },
): { id: number; kind: IdentityKind } | undefined {
  const want = normalizeTitle(query.title);
  const wantYear = parseInt(query.year ?? '', 10);
  let best: { id: number; kind: IdentityKind; score: number } | undefined;
  for (const r of results) {
    if (!r.id || (r.media_type !== 'movie' && r.media_type !== 'tv')) continue;
    const kind = r.media_type;
    const names = [r.title, r.name, r.original_title, r.original_name].filter((n): n is string => Boolean(n));
    const exact = names.some((n) => normalizeTitle(toSimplified(n)) === want);
    const year = parseInt((r.release_date || r.first_air_date || '').slice(0, 4), 10);
    if (Number.isFinite(wantYear) && Number.isFinite(year) && Math.abs(year - wantYear) > 1) continue;
    if (!exact && !Number.isFinite(wantYear)) continue; // 片名对不上又没有年份佐证，宁可不认
    const score =
      (exact ? 100 : 0) + (query.kind && query.kind === kind ? 20 : 0) + Math.min(10, (r.popularity ?? 0) / 10);
    if (!best || score > best.score) best = { id: r.id, kind, score };
  }
  return best && { id: best.id, kind: best.kind };
}

export interface TmdbDetailWithNames {
  title?: string;
  name?: string;
  overview?: string;
  tagline?: string;
  genres?: { name?: string }[];
  release_date?: string;
  first_air_date?: string;
  runtime?: number;
  number_of_episodes?: number;
  number_of_seasons?: number;
  status?: string;
  in_production?: boolean;
  vote_average?: number;
  vote_count?: number;
  networks?: { name?: string }[];
  created_by?: { name?: string }[];
  credits?: { cast?: { name?: string }[]; crew?: { name?: string; job?: string }[] };
  original_title?: string;
  original_name?: string;
  original_language?: string;
  alternative_titles?: { titles?: AltTitle[]; results?: AltTitle[] };
  translations?: { translations?: { iso_3166_1?: string; iso_639_1?: string; data?: { title?: string; name?: string } }[] };
}
interface AltTitle {
  iso_3166_1?: string;
  title?: string;
}

/** 从 TMDB 详情（带 alternative_titles 与 translations）里收集中文名，排除查询本身 */
export function collectChineseNames(detail: TmdbDetailWithNames, exclude: string): string[] {
  const seen = new Set([normalizeTitle(exclude)]);
  const out: string[] = [];
  const add = (raw: string | undefined, region?: string) => {
    const text = raw?.trim();
    if (!text || !hasCJK(text) || hasKana(text)) return;
    const simplified = toSimplified(text, region);
    const key = normalizeTitle(simplified);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(simplified);
  };
  const regionRank = (r?: string) => {
    const i = REGION_ORDER.indexOf(r ?? '');
    return i === -1 ? REGION_ORDER.length : i;
  };

  const translations = (detail.translations?.translations ?? [])
    .filter((t) => t.iso_639_1 === 'zh')
    .sort((a, b) => regionRank(a.iso_3166_1) - regionRank(b.iso_3166_1));
  for (const t of translations) add(t.data?.title || t.data?.name, t.iso_3166_1);
  add(detail.title || detail.name, 'CN');

  const alts = [...(detail.alternative_titles?.titles ?? []), ...(detail.alternative_titles?.results ?? [])]
    .filter((a) => REGION_ORDER.includes(a.iso_3166_1 ?? ''))
    .sort((a, b) => regionRank(a.iso_3166_1) - regionRank(b.iso_3166_1));
  for (const a of alts) add(a.title, a.iso_3166_1);

  // 原名是中文的（华语片 / 部分日漫汉字名）也可能是采集站用的名字
  if (detail.original_language === 'zh' || detail.original_language === 'cn') {
    add(detail.original_title || detail.original_name);
  }
  return out.slice(0, MAX_NAMES);
}

const TMDB_STATUS_CN: Record<string, string> = {
  'Returning Series': '连载中',
  Ended: '已完结',
  Canceled: '已停播',
  'In Production': '制作中',
  Planned: '筹备中',
  Released: '已上映',
};

/** TMDB 详情 → 作品资讯（简介、类型、日期、集数、主创） */
export function extractTitleInfo(detail: TmdbDetailWithNames, kind: IdentityKind): TitleInfo {
  const names = (list?: { name?: string }[], n = 6) =>
    (list ?? []).map((x) => x.name?.trim() ?? '').filter(Boolean).slice(0, n);
  const directors =
    kind === 'movie'
      ? names((detail.credits?.crew ?? []).filter((c) => c.job === 'Director'), 3)
      : names(detail.created_by, 3);
  return {
    overview: detail.overview?.trim() || undefined,
    tagline: detail.tagline?.trim() || undefined,
    genres: names(detail.genres, 4),
    date: (kind === 'movie' ? detail.release_date : detail.first_air_date) || undefined,
    runtime: kind === 'movie' && detail.runtime ? detail.runtime : undefined,
    episodes: kind === 'tv' ? detail.number_of_episodes || undefined : undefined,
    seasons: kind === 'tv' ? detail.number_of_seasons || undefined : undefined,
    status: detail.status ? TMDB_STATUS_CN[detail.status] : undefined,
    rating: detail.vote_average && detail.vote_count && detail.vote_count >= 10 ? Math.round(detail.vote_average * 10) / 10 : undefined,
    votes: detail.vote_count || undefined,
    directors,
    cast: names(detail.credits?.cast, 6),
    networks: names(detail.networks, 3),
  };
}

/** null = TMDB 确认查不到这部；undefined = 暂时查不了（没有 key / 请求失败），不要缓存 */
export async function resolveTitleIdentity(input: {
  title: string;
  year?: string;
  kind?: IdentityKind;
  tmdbId?: number;
}): Promise<TitleIdentity | null | undefined> {
  const title = input.title.trim().slice(0, 100);
  if (!title) return null;
  const cacheKey = `identity:v3:${input.tmdbId ?? ''}:${input.kind ?? ''}:${title}:${input.year ?? ''}`;
  const cached = getCache<TitleIdentity | null>(cacheKey);
  if (cached !== undefined) return cached;

  // 「药屋少女的呢喃 第三季」：TMDB 上整部剧只有一个条目，首播年份是第一季的（2023），
  // 带着季数和 2026 去搜永远对不上。先用去掉季数的名字认出整部剧，不卡年份，再取这一季的资料。
  const seasonMarker = /\s*(?:第[一二三四五六七八九十百\d]+[季部]|Season\s*\d+|Part\s*\d+)\s*$/i;
  const hasSeason = seasonMarker.test(title);
  const season = hasSeason ? extractSeasonNumber(title) : undefined;
  const baseTitle = hasSeason ? title.replace(seasonMarker, '').trim() || title : title;

  let target: { id: number; kind: IdentityKind } | undefined =
    input.tmdbId && input.kind ? { id: input.tmdbId, kind: input.kind } : undefined;
  if (!target) {
    const res = await tmdbGet<{ results?: TmdbSearchResult[] }>('/search/multi', { query: baseTitle, include_adult: 'false' });
    if (!res) return undefined; // 没有 TMDB key 或请求失败：不缓存，下次再试
    target = pickBestMatch(res.results ?? [], {
      title: baseTitle,
      year: hasSeason ? undefined : input.year,
      kind: hasSeason ? 'tv' : input.kind,
    });
  }
  let identity: TitleIdentity | null = null;
  if (target) {
    const detail = await tmdbGet<TmdbDetailWithNames>(`/${target.kind}/${target.id}`, {
      append_to_response: 'alternative_titles,translations,credits',
    });
    if (!detail) return undefined;
    const info = extractTitleInfo(detail, target.kind);
    if (target.kind === 'tv' && season) {
      const s = await tmdbGet<{ air_date?: string; overview?: string; episodes?: unknown[] }>(
        `/tv/${target.id}/season/${season}`,
        {},
      );
      if (s) {
        info.season = season;
        if (s.air_date) info.date = s.air_date;
        if (Array.isArray(s.episodes) && s.episodes.length > 0) info.episodes = s.episodes.length;
        if (s.overview?.trim()) info.overview = s.overview.trim();
      }
    }
    identity = {
      tmdbId: target.id,
      kind: target.kind,
      names: collectChineseNames(detail, baseTitle),
      info,
    };
  }
  setCache(cacheKey, identity, IDENTITY_TTL);
  return identity;
}
