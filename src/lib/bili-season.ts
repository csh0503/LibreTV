import type { DoubanItem } from './types';
import { fetchUpstream, getCache, setCache } from './fetch-utils';

/**
 * B站的热播榜 / 片库只给片名、封面和「全12话 / 更新至第196话」，没有年份，也看不出是不是最近在播：
 * 近 3 天热播里一大半是几年前完结、还在被补的老番（《灵笼 第二季》《罗小黑战记》）。
 * 这里按 season_id 取一次单季详情（`pgc/view/web/season`），补上：
 * - 首播日期（年份）、最新一集的播出日期；
 * - 是否完结、B站给的题材（战斗 / 科幻 / 恋爱……）。
 * 每季缓存 12 小时；同时最多 6 个请求，整批最多等 6 秒，没取到的保持原样。
 */

export interface BiliSeasonInfo {
  /** 首播日期 YYYY-MM-DD */
  firstAired?: string;
  /** 最新一集播出日期 YYYY-MM-DD */
  lastAired?: string;
  finished?: boolean;
  styles: string[];
  /** 已经放出来的集数（预约页是 0） */
  episodeCount: number;
  /** B站自己写着「敬请期待」：开播日期还没定 */
  dateUnknown?: boolean;
}

const TTL = 12 * 3600_000;
const FAIL_TTL = 30 * 60_000;
const CONCURRENCY = 6;
const BATCH_DEADLINE_MS = 6000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const cnDay = (sec: number) => new Date(sec * 1000 + 8 * 3600_000).toISOString().slice(0, 10);

interface SeasonRaw {
  publish?: { is_finish?: number; pub_time?: string; unknow_pub_date?: number };
  styles?: unknown;
  episodes?: { pub_time?: number }[];
}

export function parseSeasonInfo(raw: SeasonRaw): BiliSeasonInfo {
  const pub = raw.publish?.pub_time;
  const firstAired = typeof pub === 'string' && /^\d{4}-\d{2}-\d{2}/.test(pub) ? pub.slice(0, 10) : undefined;
  const times = (raw.episodes ?? []).map((e) => e.pub_time).filter((t): t is number => typeof t === 'number' && t > 0);
  return {
    firstAired,
    lastAired: times.length > 0 ? cnDay(Math.max(...times)) : undefined,
    finished: raw.publish?.is_finish === undefined ? undefined : raw.publish.is_finish === 1,
    styles: Array.isArray(raw.styles) ? raw.styles.filter((s): s is string => typeof s === 'string').slice(0, 4) : [],
    episodeCount: raw.episodes?.length ?? 0,
    dateUnknown: raw.publish?.unknow_pub_date === 1 || undefined,
  };
}

/** 同一季同时被几个榜要（综合榜和国漫榜都有《凡人修仙传》）：只发一次请求 */
const inflight = new Map<string, Promise<BiliSeasonInfo | undefined>>();

export function fetchBiliSeasonInfo(seasonId: string): Promise<BiliSeasonInfo | undefined> {
  const key = `bili-season:v2:${seasonId}`;
  const cached = getCache<BiliSeasonInfo | null>(key);
  if (cached !== undefined) return Promise.resolve(cached ?? undefined);
  const running = inflight.get(key);
  if (running) return running;
  const job = loadSeason(seasonId, key).finally(() => inflight.delete(key));
  inflight.set(key, job);
  return job;
}

async function loadSeason(seasonId: string, key: string): Promise<BiliSeasonInfo | undefined> {
  try {
    const res = await fetchUpstream(`https://api.bilibili.com/pgc/view/web/season?season_id=${encodeURIComponent(seasonId)}`, {
      timeoutMs: 5000,
      headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(String(res.status));
    const json = (await res.json()) as { result?: SeasonRaw };
    if (!json.result) throw new Error('empty');
    const info = parseSeasonInfo(json.result);
    setCache(key, info, TTL);
    return info;
  } catch {
    setCache(key, null, FAIL_TTL);
    return undefined;
  }
}

/** 把单季详情并进条目：年份、最新一集日期、完结状态、题材 */
export function applySeasonInfo(item: DoubanItem, info: BiliSeasonInfo | undefined, now = Date.now()): DoubanItem {
  if (!info) return item;
  const next: DoubanItem = { ...item };
  if (info.firstAired && !info.dateUnknown && (!item.year || item.yearSoft)) {
    next.year = info.firstAired.slice(0, 4);
    next.yearSoft = undefined;
  }
  if (info.lastAired) next.lastAired = info.lastAired;
  if (item.isTv) {
    const quietDays = info.lastAired ? (now - Date.parse(info.lastAired)) / 86_400_000 : Infinity;
    if (info.finished === true) {
      next.status = 'ended';
      next.statusGuessed = undefined;
    } else if (info.finished === false && quietDays < 21) {
      next.status = 'airing';
      next.statusGuessed = undefined;
    } else if (info.finished === false && quietDays > 60 && item.status === 'airing') {
      // 没完结、但两个月没有新集：停更 / 分割放送的间歇，不标「连载」
      next.status = undefined;
      next.statusGuessed = undefined;
    }
  }
  if (info.styles.length > 0) {
    const have = new Set((item.genres ?? '').split(/\s+/).filter(Boolean));
    next.genres = [...have, ...info.styles.filter((s) => !have.has(s))].slice(0, 5).join(' ');
  }
  return next;
}

/** 一集都没放、开播日期没定或还没到：B站榜单里偶尔挂着「敬请期待」的预约页（《间谍过家家 第三季》） */
export function notAiredYet(info: BiliSeasonInfo | undefined, now = Date.now()): boolean {
  if (!info || info.episodeCount > 0) return false;
  return Boolean(info.dateUnknown || (info.firstAired && Date.parse(info.firstAired) > now));
}

/** B站条目（编号 bili_ / bili_idx_）补上单季详情；其他来源的原样返回 */
export async function enrichBiliItems(items: DoubanItem[], limit = 40): Promise<DoubanItem[]> {
  const targets = items
    .map((item, i) => ({ i, sid: item.id.match(/^bili(?:_idx)?_(\d+)$/)?.[1] }))
    .filter((t): t is { i: number; sid: string } => Boolean(t.sid))
    .slice(0, limit);
  if (targets.length === 0) return items;
  const out = [...items];
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const t = targets[next++];
      const info = await fetchBiliSeasonInfo(t.sid);
      out[t.i] = notAiredYet(info) ? { ...out[t.i], unreleased: true } : applySeasonInfo(out[t.i], info);
    }
  };
  await Promise.race([
    Promise.all(Array.from({ length: CONCURRENCY }, worker)),
    new Promise((resolve) => setTimeout(resolve, BATCH_DEADLINE_MS)),
  ]);
  // 超时后还在跑的请求会继续写 out（结果进缓存，下次用）：这次返回的是此刻的副本；还没开播的去掉
  return out.filter((item) => !item.unreleased);
}
