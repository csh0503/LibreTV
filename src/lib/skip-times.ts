import { fetchUpstream, getCache, setCache } from './fetch-utils';
import { toSimplified } from './title-identity';
import { normalizeNative } from './upcoming';

/**
 * 动漫片头片尾时间点：中文片名 → Bangumi 找日文原名 → AniList 拿 MyAnimeList 编号 → AniSkip 查每一集的片头 / 片尾区间。
 * AniSkip 是社区数据库（https://aniskip.com），按日本原版计时，片头前有剧情（冷开场）、片尾后有剧情的情况本来就分开记。
 */

const UA = 'LibreTV (+https://github.com/LibreSpark/LibreTV)';
const ID_TTL = 7 * 24 * 3600_000;
const MISS_TTL = 24 * 3600_000;
const TIMES_TTL = 24 * 3600_000;
/** 片子总时长和 AniSkip 提交时的总时长差太多，说明不是同一个版本（剪过 / 加了东西），时间点对不上 */
export const LENGTH_TOLERANCE_SECONDS = 15;

export interface SkipSegment {
  start: number;
  end: number;
  /** 版本对不上（总时长差 15~90 秒）或来源不给总时长：位置大概对，只显示按钮，不自动跳 */
  approx?: boolean;
  /** 时间点来自哪 */
  via?: SkipVia;
}

export type SkipVia = 'bilibili' | 'aniskip' | 'theintrodb';

/** 这一集为什么没有片头 / 片尾：AniSkip 上没人提交，或只有总时长差太多的版本 */
export type SkipMissing = 'none' | 'other-version';

export interface SkipTimes {
  intro?: SkipSegment;
  outro?: SkipSegment;
  missing?: { intro?: SkipMissing; outro?: SkipMissing };
}

export interface BgmHit {
  id?: number;
  name?: string;
  name_cn?: string;
  date?: string;
}

const CN_NUM: Record<string, string> = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7', 八: '8', 九: '9', 十: '10' };
/** 比较用：繁转简、去标点空格、「第二季 / 第2季」统一成「2」 */
const norm = (s: string) =>
  normalizeNative(toSimplified(s)).replace(/第([一二三四五六七八九十\d]+)季$/, (_, n: string) => CN_NUM[n] ?? n);

/** Bangumi 搜索结果里挑中文名对得上的；年份对得上的优先 */
export function pickBangumiHit(hits: BgmHit[], title: string, year?: string): BgmHit | undefined {
  const target = norm(title);
  const named = hits.filter((h) => h.name && h.name_cn && norm(h.name_cn) === target);
  if (named.length === 0) return undefined;
  return named.find((h) => year && h.date?.startsWith(year)) ?? named[0];
}

export interface AniListMedia {
  idMal?: number | null;
  title?: { native?: string | null; romaji?: string | null };
  startDate?: { year?: number | null };
}

const JP_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const SEASON_RE =
  /\s*(?:第\s*([0-9一二三四五六七八九十]+)\s*[期季部]|season\s*(\d+)|(\d+)(?:st|nd|rd|th)\s*season|part\s*(\d+)|\s([2-9])|([ⅡⅢⅣⅤ]))\s*$/i;
const ROMAN: Record<string, number> = { Ⅱ: 2, Ⅲ: 3, Ⅳ: 4, Ⅴ: 5 };

/** 片名里的第几季（没写就是第 1 季），和去掉季数后的主名 */
export function splitSeason(name: string): { base: string; season: number } {
  const m = name.trim().match(SEASON_RE);
  if (!m) return { base: normalizeNative(name), season: 1 };
  const raw = m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5];
  const season = m[6] ? ROMAN[m[6]] : raw ? (JP_NUM[raw] ?? parseInt(raw, 10)) : 1;
  return { base: normalizeNative(name.slice(0, m.index)), season: season || 1 };
}

/**
 * AniList 搜索结果里挑这一季：日文原名完全一样最好；否则要「主名一样 + 第几季一样」。
 * 都对不上就不给（以前会退回第一条结果，结果第三季拿到了第一季的片头时间）。
 */
export function pickAniListMedia(media: AniListMedia[], native: string, year?: string): AniListMedia | undefined {
  const withMal = media.filter((m) => m.idMal);
  const target = normalizeNative(native);
  const preferYear = (pool: AniListMedia[]) => pool.find((m) => year && String(m.startDate?.year) === year) ?? pool[0];
  const exact = withMal.filter((m) => m.title?.native && normalizeNative(m.title.native) === target);
  if (exact.length > 0) return preferYear(exact);
  const want = splitSeason(native);
  if (want.base.length < 2) return undefined;
  const sameSeason = withMal.filter((m) => {
    const got = splitSeason(m.title?.native ?? '');
    return got.base === want.base && got.season === want.season;
  });
  return sameSeason.length > 0 ? preferYear(sameSeason) : undefined;
}

interface AniSkipResult {
  interval?: { startTime?: number; endTime?: number };
  skipType?: string;
  episodeLength?: number;
}

/** 总时长差这么多以内，位置大概还能用（只显示按钮） */
export const APPROX_TOLERANCE_SECONDS = 90;

/**
 * 从 AniSkip 的多条提交里挑：总时长和我们这一版差不超过 15 秒的直接用；
 * 只有差 15~90 秒的，当作大概位置（approx，只显示按钮、不自动跳）；再多就不用。
 * 同类型多条取总时长最接近的。mixed-op / mixed-ed（片头片尾和剧情叠在一起）也算片头片尾。
 */
export function pickSkipTimes(results: AniSkipResult[], length?: number): SkipTimes {
  const out: SkipTimes = {};
  const best: Record<'intro' | 'outro', { seg: SkipSegment; diff: number } | undefined> = { intro: undefined, outro: undefined };
  const seen = { intro: 0, outro: 0 };
  for (const r of results) {
    const kind = r.skipType === 'op' || r.skipType === 'mixed-op' ? 'intro' : r.skipType === 'ed' || r.skipType === 'mixed-ed' ? 'outro' : undefined;
    const start = r.interval?.startTime;
    const end = r.interval?.endTime;
    if (!kind || typeof start !== 'number' || typeof end !== 'number' || end - start < 10) continue;
    seen[kind] += 1;
    const diff = length && r.episodeLength ? Math.abs(r.episodeLength - length) : 0;
    if (diff > APPROX_TOLERANCE_SECONDS) continue;
    if (!best[kind] || diff < best[kind]!.diff) {
      best[kind] = {
        seg: { start: Math.max(0, start), end, via: 'aniskip', ...(diff > LENGTH_TOLERANCE_SECONDS ? { approx: true } : {}) },
        diff,
      };
    }
  }
  const missing: NonNullable<SkipTimes['missing']> = {};
  for (const kind of ['intro', 'outro'] as const) {
    if (best[kind]) out[kind] = best[kind]!.seg;
    else missing[kind] = seen[kind] > 0 ? 'other-version' : 'none';
  }
  if (missing.intro || missing.outro) out.missing = missing;
  return out;
}

/** 一部动漫在各处的编号 */
export interface AnimeIds {
  bangumi: number;
  mal?: number;
  /** B站番剧的 media_id（md 号） */
  biliMedia?: string;
  /** TMDB：tv/123、tv/123/season/2、movie/456 */
  tmdb?: string;
}

/**
 * 中文片名 → 这部动漫的各处编号：Bangumi 按中文名搜到条目，再查 bangumi-data 对照表拿 MyAnimeList / B站 / TMDB 编号；
 * 对照表里没有 MAL 编号时，才用 AniList 按日文原名搜（要季数对得上）。
 * 查不到返回 null（缓存一天），暂时查不了返回 undefined。
 */
export async function resolveAnimeIds(title: string, year?: string): Promise<AnimeIds | null | undefined> {
  const key = `skip:ids:v1:${title}|${year ?? ''}`;
  const cached = getCache<AnimeIds | null>(key);
  if (cached !== undefined) return cached;
  try {
    const bgm = await fetchUpstream('https://api.bgm.tv/v0/search/subjects?limit=8', {
      method: 'POST',
      timeoutMs: 6000,
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ keyword: title, filter: { type: [2] } }),
    });
    if (!bgm.ok) return undefined;
    const hit = pickBangumiHit(((await bgm.json()) as { data?: BgmHit[] }).data ?? [], title, year);
    if (!hit?.name || !hit.id) {
      setCache(key, null, MISS_TTL);
      return null;
    }
    const table = await loadBangumiData();
    const mapped = table.get(String(hit.id));
    const ids: AnimeIds = { bangumi: hit.id, ...mapped };
    if (!ids.mal) {
      const ani = await fetchUpstream('https://graphql.anilist.co', {
        method: 'POST',
        timeoutMs: 6000,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          query: `query ($s: String) { Page(perPage: 6) { media(search: $s, type: ANIME) { idMal title { native romaji } startDate { year } } } }`,
          variables: { s: hit.name },
        }),
      });
      if (ani.ok) {
        const media = ((await ani.json()) as { data?: { Page?: { media?: AniListMedia[] } } }).data?.Page?.media ?? [];
        ids.mal = pickAniListMedia(media, hit.name, hit.date?.slice(0, 4) ?? year)?.idMal ?? undefined;
      }
    }
    // 对照表这次没下载成功：结果只缓存一小时，免得一周都缺 B站 / TMDB 编号
    setCache(key, ids, table.size > 0 ? ID_TTL : 3600_000);
    return ids;
  } catch {
    return undefined;
  }
}

/** bangumi-data（开源对照表，约 9 千部动画）：Bangumi 编号 → MAL / B站 / TMDB 编号 */
const BANGUMI_DATA_URLS = [
  'https://cdn.jsdelivr.net/npm/bangumi-data@0.3/dist/data.json',
  'https://unpkg.com/bangumi-data@0.3/dist/data.json',
];
let bangumiDataLoading: Promise<Map<string, Omit<AnimeIds, 'bangumi'>>> | null = null;

export function buildBangumiDataMap(items: { sites?: { site: string; id?: string }[] }[]): Map<string, Omit<AnimeIds, 'bangumi'>> {
  const map = new Map<string, Omit<AnimeIds, 'bangumi'>>();
  for (const it of items) {
    const sites = new Map((it.sites ?? []).map((s) => [s.site, s.id]));
    const bgm = sites.get('bangumi');
    if (!bgm) continue;
    const mal = parseInt(sites.get('mal') ?? '', 10);
    map.set(bgm, {
      mal: Number.isFinite(mal) && mal > 0 ? mal : undefined,
      biliMedia: sites.get('bilibili') || undefined,
      tmdb: sites.get('tmdb') || undefined,
    });
  }
  return map;
}

async function loadBangumiData(): Promise<Map<string, Omit<AnimeIds, 'bangumi'>>> {
  const key = 'skip:bangumi-data';
  const cached = getCache<Map<string, Omit<AnimeIds, 'bangumi'>>>(key);
  if (cached) return cached;
  bangumiDataLoading ??= (async () => {
    for (const url of BANGUMI_DATA_URLS) {
      try {
        const res = await fetchUpstream(url, { timeoutMs: 12000 });
        if (!res.ok) continue;
        const map = buildBangumiDataMap(((await res.json()) as { items?: [] }).items ?? []);
        if (map.size > 0) {
          setCache(key, map, 24 * 3600_000);
          return map;
        }
      } catch {
        // 换下一个镜像
      }
    }
    return new Map();
  })().finally(() => {
    bangumiDataLoading = null;
  });
  return bangumiDataLoading;
}

/** 某一集的片头片尾；查不到返回 {}，暂时查不了返回 undefined */
export async function fetchSkipTimes(malId: number, episode: number, length?: number): Promise<SkipTimes | undefined> {
  const key = `skip:times:${malId}:${episode}`;
  let results = getCache<AniSkipResult[]>(key);
  if (!results) {
    const sp = new URLSearchParams();
    for (const t of ['op', 'ed', 'mixed-op', 'mixed-ed']) sp.append('types[]', t);
    sp.set('episodeLength', '0');
    try {
      const res = await fetchUpstream(`https://api.aniskip.com/v2/skip-times/${malId}/${episode}?${sp.toString()}`, {
        timeoutMs: 6000,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      // 没有数据时 AniSkip 回 404
      if (res.status === 404) results = [];
      else if (!res.ok) return undefined;
      else results = ((await res.json()) as { results?: AniSkipResult[] }).results ?? [];
    } catch {
      return undefined;
    }
    setCache(key, results, TIMES_TTL);
  }
  return pickSkipTimes(results, length);
}
