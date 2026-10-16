import { fetchUpstream, getCache, setCache } from './fetch-utils';
import { APPROX_TOLERANCE_SECONDS, LENGTH_TOLERANCE_SECONDS, type SkipMissing, type SkipSegment, type SkipTimes } from './skip-times';

/**
 * AniSkip 之外的片头片尾来源：
 * - B站官方：番剧详情接口里每一集都带 skip.op / skip.ed（B站播放器「跳过片头片尾」用的就是它），
 *   官方标注、每集单独记，冷开场长短不一也对；同时给每集总时长，能判断和我们的片子是不是同一版。
 *   B站搜索对海外 IP 返回空，所以用 bangumi-data 对照表拿 B站 media_id，再换成 season_id。
 * - TheIntroDB：社区数据库，按 TMDB 编号查，美剧日剧和一部分动漫有；不给总时长，当约略位置（只显示按钮）。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DAY = 24 * 3600_000;

interface BiliEpisode {
  title?: string;
  duration?: number;
  skip?: { op?: { start?: number; end?: number }; ed?: { start?: number; end?: number } } | null;
}

/** 片子总长和来源那一版差多少：≤15 秒准确，≤90 秒约略，再多不用 */
function lengthFit(theirs: number | undefined, ours: number | undefined): 'exact' | 'approx' | 'off' {
  if (!theirs || !ours) return 'approx';
  const diff = Math.abs(theirs - ours);
  if (diff <= LENGTH_TOLERANCE_SECONDS) return 'exact';
  if (diff <= APPROX_TOLERANCE_SECONDS) return 'approx';
  return 'off';
}

/** B站一集的 skip 换成我们的区间；0–0 表示没标 */
export function biliEpisodeTimes(ep: BiliEpisode | undefined, length?: number): SkipTimes {
  if (!ep) return { missing: { intro: 'none', outro: 'none' } };
  const fit = lengthFit(ep.duration ? ep.duration / 1000 : undefined, length);
  const seg = (s?: { start?: number; end?: number }): SkipSegment | undefined => {
    const start = s?.start ?? 0;
    const end = s?.end ?? 0;
    if (!(end - start >= 10) || fit === 'off') return undefined;
    return { start, end, via: 'bilibili', ...(fit === 'approx' ? { approx: true } : {}) };
  };
  const intro = seg(ep.skip?.op);
  const outro = seg(ep.skip?.ed);
  const why: SkipMissing = fit === 'off' ? 'other-version' : 'none';
  const missing = { ...(intro ? {} : { intro: why }), ...(outro ? {} : { outro: why }) };
  return { ...(intro ? { intro } : {}), ...(outro ? { outro } : {}), ...(intro && outro ? {} : { missing }) };
}

/** 第几集对应 B站的哪一集：标题就是集数（「1」「2」）的优先，否则按顺序 */
export function pickBiliEpisode(episodes: BiliEpisode[], episode: number): BiliEpisode | undefined {
  return episodes.find((e) => String(e.title ?? '').trim() === String(episode)) ?? episodes[episode - 1];
}

async function biliEpisodes(mediaId: string): Promise<BiliEpisode[] | undefined> {
  const key = `skip:bili:eps:${mediaId}`;
  const cached = getCache<BiliEpisode[]>(key);
  if (cached) return cached;
  try {
    const headers = { 'User-Agent': UA, Referer: 'https://www.bilibili.com/' };
    const media = await fetchUpstream(`https://api.bilibili.com/pgc/review/user?media_id=${encodeURIComponent(mediaId)}`, {
      timeoutMs: 6000,
      headers,
    });
    if (!media.ok) return undefined;
    const seasonId = ((await media.json()) as { result?: { media?: { season_id?: number } } }).result?.media?.season_id;
    if (!seasonId) {
      setCache(key, [], DAY);
      return [];
    }
    const res = await fetchUpstream(`https://api.bilibili.com/pgc/view/web/season?season_id=${seasonId}`, { timeoutMs: 6000, headers });
    if (!res.ok) return undefined;
    const eps = ((await res.json()) as { result?: { episodes?: BiliEpisode[] } }).result?.episodes ?? [];
    // 连载中的番每周更新，缓存短一点
    setCache(key, eps, 6 * 3600_000);
    return eps;
  } catch {
    return undefined;
  }
}

export async function fetchBilibiliTimes(mediaId: string, episode: number, length?: number): Promise<SkipTimes | undefined> {
  const eps = await biliEpisodes(mediaId);
  if (!eps) return undefined;
  return biliEpisodeTimes(pickBiliEpisode(eps, episode), length);
}

/** 「tv/85937」「tv/85937/season/2」「movie/820232」 */
export function parseTmdbRef(ref?: string): { kind: 'tv' | 'movie'; id: number; season?: number } | undefined {
  const m = ref?.match(/^(tv|movie)\/(\d+)(?:\/season\/(\d+))?$/);
  if (!m) return undefined;
  return { kind: m[1] as 'tv' | 'movie', id: parseInt(m[2], 10), season: m[3] ? parseInt(m[3], 10) : undefined };
}

interface TidbSegment {
  start_ms?: number | null;
  end_ms?: number | null;
}

export function theIntroDbTimes(
  data: { intro?: TidbSegment[]; credits?: TidbSegment[] } | undefined,
  length?: number,
): SkipTimes {
  // start 为 null = 从开头起（电影片头常这样），end 为 null = 一直到结尾
  const seg = (list?: TidbSegment[], toEnd = false): SkipSegment | undefined => {
    const s = list?.[0];
    if (!s || (typeof s.start_ms !== 'number' && toEnd)) return undefined;
    const start = typeof s.start_ms === 'number' ? s.start_ms / 1000 : 0;
    const end = typeof s.end_ms === 'number' ? s.end_ms / 1000 : toEnd && length ? length : undefined;
    if (end === undefined || end - start < 10) return undefined;
    // 不给总时长，判断不了是不是同一版：一律当约略位置
    return { start, end, via: 'theintrodb', approx: true };
  };
  const intro = seg(data?.intro);
  const outro = seg(data?.credits, true);
  return { ...(intro ? { intro } : {}), ...(outro ? { outro } : {}) };
}

export async function fetchTheIntroDbTimes(
  tmdb: { kind: 'tv' | 'movie'; id: number; season?: number },
  episode: number,
  length?: number,
): Promise<SkipTimes | undefined> {
  const sp = new URLSearchParams({ tmdb_id: String(tmdb.id) });
  if (tmdb.kind === 'tv') {
    sp.set('season', String(tmdb.season ?? 1));
    sp.set('episode', String(episode));
  }
  const key = `skip:tidb:${sp.toString()}`;
  let data = getCache<{ intro?: TidbSegment[]; credits?: TidbSegment[] } | null>(key);
  if (data === undefined) {
    try {
      const res = await fetchUpstream(`https://api.theintrodb.org/v2/media?${sp.toString()}`, {
        timeoutMs: 6000,
        headers: { Accept: 'application/json' },
      });
      if (res.status === 404) data = null;
      else if (!res.ok) return undefined;
      else data = (await res.json()) as { intro?: TidbSegment[]; credits?: TidbSegment[] };
    } catch {
      return undefined;
    }
    setCache(key, data, DAY);
  }
  return theIntroDbTimes(data ?? undefined, length);
}

/**
 * 几个来源合在一起，每段按可靠度挑：准确的 B站官方 > 准确的 AniSkip > 约略的（B站 / AniSkip / TheIntroDB 依次）。
 * 都没有时，原因取「有提交但版本对不上」优先于「没人提交」。
 */
export function mergeSkipTimes(sources: (SkipTimes | undefined)[]): SkipTimes {
  const out: SkipTimes = {};
  const missing: NonNullable<SkipTimes['missing']> = {};
  for (const kind of ['intro', 'outro'] as const) {
    const segs = sources.map((s) => s?.[kind]).filter((s): s is SkipSegment => Boolean(s));
    const best = segs.find((s) => !s.approx) ?? segs[0];
    if (best) {
      out[kind] = best;
      continue;
    }
    const reasons = sources.map((s) => s?.missing?.[kind]).filter(Boolean);
    missing[kind] = reasons.includes('other-version') ? 'other-version' : 'none';
  }
  if (missing.intro || missing.outro) out.missing = missing;
  return out;
}
