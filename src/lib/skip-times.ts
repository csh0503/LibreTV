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
}

export interface SkipTimes {
  intro?: SkipSegment;
  outro?: SkipSegment;
}

interface BgmHit {
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

interface AniListMedia {
  idMal?: number | null;
  title?: { native?: string | null; romaji?: string | null };
  startDate?: { year?: number | null };
}

export function pickAniListMedia(media: AniListMedia[], native: string, year?: string): AniListMedia | undefined {
  const withMal = media.filter((m) => m.idMal);
  const target = normalizeNative(native);
  const exact = withMal.filter((m) => m.title?.native && normalizeNative(m.title.native) === target);
  const pool = exact.length > 0 ? exact : withMal.slice(0, 1);
  return pool.find((m) => year && String(m.startDate?.year) === year) ?? pool[0];
}

interface AniSkipResult {
  interval?: { startTime?: number; endTime?: number };
  skipType?: string;
  episodeLength?: number;
}

/**
 * 从 AniSkip 的多条提交里挑：总时长和我们这一版差不超过 15 秒的才用（差多了说明版本不同，时间点会偏），
 * 同类型多条取总时长最接近的。mixed-op / mixed-ed（片头片尾和剧情叠在一起）也算片头片尾。
 */
export function pickSkipTimes(results: AniSkipResult[], length?: number): SkipTimes {
  const out: SkipTimes = {};
  const best: Record<'intro' | 'outro', { seg: SkipSegment; diff: number } | undefined> = { intro: undefined, outro: undefined };
  for (const r of results) {
    const kind = r.skipType === 'op' || r.skipType === 'mixed-op' ? 'intro' : r.skipType === 'ed' || r.skipType === 'mixed-ed' ? 'outro' : undefined;
    const start = r.interval?.startTime;
    const end = r.interval?.endTime;
    if (!kind || typeof start !== 'number' || typeof end !== 'number' || end - start < 10) continue;
    const diff = length && r.episodeLength ? Math.abs(r.episodeLength - length) : 0;
    if (length && r.episodeLength && diff > LENGTH_TOLERANCE_SECONDS) continue;
    if (!best[kind] || diff < best[kind]!.diff) best[kind] = { seg: { start: Math.max(0, start), end }, diff };
  }
  if (best.intro) out.intro = best.intro.seg;
  if (best.outro) out.outro = best.outro.seg;
  return out;
}

/** 中文片名 → MyAnimeList 编号；查不到返回 null（缓存一天），暂时查不了返回 undefined */
export async function resolveMalId(title: string, year?: string): Promise<number | null | undefined> {
  const key = `skip:mal:${title}|${year ?? ''}`;
  const cached = getCache<number | null>(key);
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
    if (!hit?.name) {
      setCache(key, null, MISS_TTL);
      return null;
    }
    const ani = await fetchUpstream('https://graphql.anilist.co', {
      method: 'POST',
      timeoutMs: 6000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        query: `query ($s: String) { Page(perPage: 6) { media(search: $s, type: ANIME) { idMal title { native romaji } startDate { year } } } }`,
        variables: { s: hit.name },
      }),
    });
    if (!ani.ok) return undefined;
    const media = ((await ani.json()) as { data?: { Page?: { media?: AniListMedia[] } } }).data?.Page?.media ?? [];
    const picked = pickAniListMedia(media, hit.name, hit.date?.slice(0, 4) ?? year);
    const id = picked?.idMal ?? null;
    setCache(key, id, id ? ID_TTL : MISS_TTL);
    return id;
  } catch {
    return undefined;
  }
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
