import { Converter } from 'opencc-js';
import { getCache, setCache } from './fetch-utils';
import { normalizeTitle } from './cms-parser';
import { tmdbGet } from './tmdb';

/**
 * 统一条目层（第一步）：同一部作品在不同地方叫法不同——豆瓣 / 大陆叫《大师计划》，台湾叫《終極盜局》，
 * 采集站可能用其中任何一个（常见的是港台译名转简体）。这里用 TMDB 把一个片名解析成作品身份，
 * 收集它所有的中文名（大陆、港、台、新加坡的译名和别名，繁体统一转简体），给「找片源」当备用搜索词。
 */

export type IdentityKind = 'movie' | 'tv';

export interface TitleIdentity {
  tmdbId: number;
  kind: IdentityKind;
  /** 除了查询用的片名之外的其他中文名（已转简体、去重），按可信度排序 */
  names: string[];
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

/** null = TMDB 确认查不到这部；undefined = 暂时查不了（没有 key / 请求失败），不要缓存 */
export async function resolveTitleIdentity(input: {
  title: string;
  year?: string;
  kind?: IdentityKind;
  tmdbId?: number;
}): Promise<TitleIdentity | null | undefined> {
  const title = input.title.trim().slice(0, 100);
  if (!title) return null;
  const cacheKey = `identity:${input.tmdbId ?? ''}:${input.kind ?? ''}:${title}:${input.year ?? ''}`;
  const cached = getCache<TitleIdentity | null>(cacheKey);
  if (cached !== undefined) return cached;

  let target: { id: number; kind: IdentityKind } | undefined =
    input.tmdbId && input.kind ? { id: input.tmdbId, kind: input.kind } : undefined;
  if (!target) {
    const res = await tmdbGet<{ results?: TmdbSearchResult[] }>('/search/multi', { query: title, include_adult: 'false' });
    if (!res) return undefined; // 没有 TMDB key 或请求失败：不缓存，下次再试
    target = pickBestMatch(res.results ?? [], { title, year: input.year, kind: input.kind });
  }
  let identity: TitleIdentity | null = null;
  if (target) {
    const detail = await tmdbGet<TmdbDetailWithNames>(`/${target.kind}/${target.id}`, {
      append_to_response: 'alternative_titles,translations',
    });
    if (!detail) return undefined;
    identity = { tmdbId: target.id, kind: target.kind, names: collectChineseNames(detail, title) };
  }
  setCache(cacheKey, identity, IDENTITY_TTL);
  return identity;
}
