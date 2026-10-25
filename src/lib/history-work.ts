import type { HistoryEntry } from './db';
import { stripSeasonTitle } from './shelf-defs';
import { canonicalTitle } from './title-aliases';

/**
 * 观看记录里「同一部」的钥匙。
 * 先去掉季数后缀（写不写「第一季」都一样），再把已知译名收成同一个名字（海贼王 = 航海王）。
 * 电影续集的结尾数字（「疯狂动物城2」）不去掉。
 */
export function workKeyOf(title: string): string {
  const base = stripSeasonTitle(title);
  return canonicalTitle(base);
}

type HistoryLike = Pick<HistoryEntry, 'title' | 'timestamp'> & { id?: string };

/** 同一部只留最近看的那条（按时间从新到旧）。库里的其他源不在这里删。 */
export function collapseHistoryByWork<T extends HistoryLike>(rows: T[]): T[] {
  const sorted = [...rows].sort((a, b) => b.timestamp - a.timestamp);
  const seen = new Set<string>();
  const out: T[] = [];
  for (const row of sorted) {
    const key = workKeyOf(row.title) || row.id || row.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
}

/** 和这部同一作品的全部源（含它自己）。 */
export function sameWorkHistory<T extends { title: string }>(rows: T[], title: string): T[] {
  const key = workKeyOf(title);
  if (!key) return rows.filter((row) => row.title === title);
  return rows.filter((row) => workKeyOf(row.title) === key);
}

/**
 * 超过上限时先丢掉同一部的旧源，再丢掉更老的剧。
 * 返回要留下的行（原对象）和要删的行。
 */
export function trimHistory<T extends HistoryLike>(rows: T[], limit: number): { keep: T[]; drop: T[] } {
  if (rows.length <= limit) return { keep: rows, drop: [] };
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = workKeyOf(row.title) || row.id || row.title;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }
  const newest: T[] = [];
  const dupes: T[] = [];
  for (const list of groups.values()) {
    list.sort((a, b) => b.timestamp - a.timestamp);
    newest.push(list[0]);
    dupes.push(...list.slice(1));
  }
  newest.sort((a, b) => b.timestamp - a.timestamp);
  dupes.sort((a, b) => b.timestamp - a.timestamp);
  const keep = newest.length >= limit ? newest.slice(0, limit) : [...newest, ...dupes.slice(0, limit - newest.length)];
  const keepSet = new Set(keep);
  return { keep, drop: rows.filter((row) => !keepSet.has(row)) };
}
