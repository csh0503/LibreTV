import { fetchBangumiCalendar } from './bangumi';
import { getCache, setCache } from './fetch-utils';
import { resolveTitleIdentity } from './title-identity';
import { canonicalTitle } from './title-aliases';
import { tmdbGet } from './tmdb';
import { seasonKey } from './work-identity';

/**
 * 追剧日历：你片单里 / 最近在看的连载，下一集哪天出。
 * - 动漫先看 Bangumi 本周放送表（按星期几固定更新）；
 * - 其他剧集查 TMDB 的 next_episode_to_air（下一集播出日期、第几集）。
 * 只回答「21 天内有新一集」的；完结、停更、查不到的不返回。日期都按北京时间。
 */

export interface ScheduleQuery {
  title: string;
  year?: string;
}

export interface ScheduleEntry {
  title: string;
  /** 下一集播出日期 YYYY-MM-DD（北京时间） */
  date: string;
  /** 1 = 周一 … 7 = 周日 */
  weekday: number;
  /** 第几集（TMDB 有） */
  episode?: number;
  source: 'bangumi' | 'tmdb';
}

const CN_OFFSET = 8 * 3600_000;
const DAY = 86_400_000;
const HORIZON_DAYS = 21;
const TV_TTL = 6 * 3600_000;
const MAX_TITLES = 20;

const cnDate = (ms: number) => new Date(ms + CN_OFFSET).toISOString().slice(0, 10);
/** 北京时间的星期几：1 = 周一 … 7 = 周日 */
export function cnWeekday(ms: number): number {
  const d = new Date(ms + CN_OFFSET).getUTCDay();
  return d === 0 ? 7 : d;
}

/** 从今天起下一个「星期 weekday」的日期（今天就是那天的话就是今天） */
export function nextDateOfWeekday(weekday: number, now = Date.now()): string {
  const ahead = (weekday - cnWeekday(now) + 7) % 7;
  return cnDate(now + ahead * DAY);
}

interface TvNext {
  status?: string;
  next_episode_to_air?: { air_date?: string; episode_number?: number } | null;
}

async function tmdbNext(tmdbId: number): Promise<TvNext | undefined> {
  const key = `schedule:tv:${tmdbId}`;
  const cached = getCache<TvNext | null>(key);
  if (cached !== undefined) return cached ?? undefined;
  const tv = await tmdbGet<TvNext>(`/tv/${tmdbId}`, {});
  setCache(key, tv ?? null, tv ? TV_TTL : 30 * 60_000);
  return tv;
}

/** 片名对不对得上放送表里的这一条：规范化片名、原名、系列名 + 季数任一相同 */
function calendarKeys(title: string, original?: string): string[] {
  return [canonicalTitle(title), original ? canonicalTitle(original) : '', seasonKey(title) ?? ''].filter(Boolean);
}

export async function lookupSchedule(queries: ScheduleQuery[], now = Date.now()): Promise<ScheduleEntry[]> {
  const list = queries.filter((q) => q.title.trim()).slice(0, MAX_TITLES);
  const calendar = await fetchBangumiCalendar().catch(() => ({}) as Awaited<ReturnType<typeof fetchBangumiCalendar>>);
  const byKey = new Map<string, number>();
  for (const [weekday, items] of Object.entries(calendar)) {
    for (const item of items) for (const key of calendarKeys(item.title, item.originalTitle)) byKey.set(key, Number(weekday));
  }

  const today = cnDate(now);
  const horizon = cnDate(now + HORIZON_DAYS * DAY);
  const out: (ScheduleEntry | undefined)[] = new Array(list.length);
  let next = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      const q = list[i];
      const weekday = calendarKeys(q.title).map((k) => byKey.get(k)).find((w) => w !== undefined);
      if (weekday) {
        out[i] = { title: q.title, weekday, date: nextDateOfWeekday(weekday, now), source: 'bangumi' };
        continue;
      }
      const identity = await resolveTitleIdentity({ title: q.title, year: q.year, kind: 'tv' }).catch(() => undefined);
      if (!identity || identity.kind !== 'tv') continue;
      const tv = await tmdbNext(identity.tmdbId);
      const ep = tv?.next_episode_to_air;
      if (!ep?.air_date || ep.air_date < today || ep.air_date > horizon) continue;
      out[i] = {
        title: q.title,
        date: ep.air_date,
        weekday: cnWeekday(Date.parse(`${ep.air_date}T12:00:00+08:00`)),
        episode: ep.episode_number,
        source: 'tmdb',
      };
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return out.filter((e): e is ScheduleEntry => Boolean(e)).sort((a, b) => a.date.localeCompare(b.date));
}
