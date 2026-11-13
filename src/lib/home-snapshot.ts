import type { DoubanItem } from './types';
import { fetchHotListWithMeta, type HotListId, type HotListMeta } from './douban-weekly';
import { fetchUpcoming, type UpcomingItem } from './upcoming';
import { loadShelf } from './shelves';
import { SHELF_DEFS } from './shelf-defs';
import { kvGet, kvSet, openCatalogDb } from './catalog-db';
import { fetchBangumiCalendar } from './bangumi';

/**
 * 首页公共内容的快照：大图 / TOP 10 各榜、即将播出、所有货架，一次算好存起来。
 * - 伺服器背景每 10 分钟重算一次（instrumentation 启动），算好写进本地片库的 kv（容器重启后马上能读到上一份）；
 * - GET /api/home 直接返回内存里序列化好的那份（毫秒级），过期了照样先返回、背后再算；
 * - 某一块算失败就不放进快照，前端那一行自己再去请求原来的接口。
 * 「继续观看」「为你推荐」「追剧日历」是每个人自己的，不在这里。
 */

/** 首页用到的榜单（大图 = realtime_all，TOP 10 的各个分页；排行页也用同一份） */
export const HOME_HOT_LISTS: HotListId[] = [
  'realtime_all',
  'douban_tv_realtime',
  'douban_movie_realtime',
  'bili_bangumi',
  'bili_guochuang',
  'douban_tv_domestic',
  'douban_tv_korean',
  'douban_tv_american',
  'douban_show_hot',
  'bili_doc',
  'tmdb_trending',
];

export interface HomeSnapshot {
  at: number;
  hotLists: Partial<Record<HotListId, { items: DoubanItem[]; meta?: HotListMeta }>>;
  upcoming?: UpcomingItem[];
  shelves: Record<string, DoubanItem[]>;
  /** Bangumi 本周放送（「为你推荐」的新番、片库「放送」用） */
  calendar?: { weekday: number; items: DoubanItem[] }[];
}

const KV_KEY = 'home:snapshot:v1';
const REFRESH_MS = 10 * 60_000;

let memory: { snap: HomeSnapshot; json: string } | undefined;
let computing: Promise<HomeSnapshot> | null = null;

async function limited<T>(tasks: (() => Promise<T>)[], n: number): Promise<T[]> {
  const out: T[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]();
      }
    }),
  );
  return out;
}

/** 重算一份（伺服器 2 核：一次最多 3 个榜 / 货架同时算） */
export function computeHomeSnapshot(): Promise<HomeSnapshot> {
  if (computing) return computing;
  computing = (async () => {
    const snap: HomeSnapshot = { at: Date.now(), hotLists: {}, shelves: {} };
    await limited(
      HOME_HOT_LISTS.map((id) => async () => {
        try {
          const { items, meta } = await fetchHotListWithMeta(id);
          if (items.length > 0) snap.hotLists[id] = { items, meta };
        } catch {
          // 这个榜这次没算出来：前端自己请求
        }
      }),
      3,
    );
    await limited(
      SHELF_DEFS.map((def) => async () => {
        try {
          const items = await loadShelf(def.id);
          if (items.length > 0) snap.shelves[def.id] = items;
        } catch {
          // 同上
        }
      }),
      3,
    );
    try {
      snap.upcoming = await fetchUpcoming();
    } catch {
      // 同上
    }
    try {
      const days = await fetchBangumiCalendar();
      snap.calendar = Object.entries(days).map(([weekday, items]) => ({ weekday: Number(weekday), items }));
    } catch {
      // 同上
    }
    snap.at = Date.now();
    // 和上一份比几乎是空的（上游全挂了）：不覆盖，留着旧的
    const filled = Object.keys(snap.hotLists).length + Object.keys(snap.shelves).length;
    const prevFilled = memory ? Object.keys(memory.snap.hotLists).length + Object.keys(memory.snap.shelves).length : 0;
    if (filled > 0 && filled >= prevFilled / 3) {
      memory = { snap, json: JSON.stringify({ ready: true, ...snap }) };
      kvSet(KV_KEY, snap);
    }
    return memory?.snap ?? snap;
  })().finally(() => {
    computing = null;
  });
  return computing;
}

/**
 * 拿快照（序列化好的 JSON）：内存 → 本地片库 kv → 都没有返回 undefined（并在背后开始算）。
 * 过期了也先返回旧的、背后再算。
 */
export function readHomeSnapshot(): { json: string; at: number } | undefined {
  if (!memory) {
    const saved = kvGet<HomeSnapshot>(KV_KEY)?.value;
    if (saved && saved.at) memory = { snap: saved, json: JSON.stringify({ ready: true, ...saved }) };
  }
  if (!memory || Date.now() - memory.snap.at > REFRESH_MS) void computeHomeSnapshot().catch(() => undefined);
  return memory ? { json: memory.json, at: memory.snap.at } : undefined;
}

let started = false;

/** 伺服器启动后：马上算一份，之后每 10 分钟一次 */
export function startHomeSnapshotLoop(): void {
  if (started || process.env.HOME_SNAPSHOT === '0') return;
  started = true;
  openCatalogDb();
  const loop = () => {
    void computeHomeSnapshot()
      .catch(() => undefined)
      .finally(() => setTimeout(loop, REFRESH_MS).unref?.());
  };
  setTimeout(loop, 5_000).unref?.();
}
