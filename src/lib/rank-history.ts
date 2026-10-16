import { readStoredJson, writeStoredJson } from './profile-sync-store';

/**
 * 榜单快照：每小时最多记一次综合总榜的名次，用来算「上升势头」。
 * 存在设定档同步用的同一个存储里（Vercel KV / Blob，本地开发写 .data）；没接存储时整个功能静默跳过。
 */

export interface RankSnapshot {
  at: number;
  /** 作品键（系列主名）→ 名次（0 起） */
  ranks: Record<string, number>;
}

const HOUR = 3600_000;
const SNAPSHOT_EVERY = HOUR;
const KEEP = 36;
const TOP_N = 30;

const storageKey = (listId: string) => `rank-history/${listId}.json`;

export async function loadRankHistory(listId: string): Promise<RankSnapshot[]> {
  try {
    const raw = await readStoredJson(storageKey(listId));
    const parsed = raw ? (JSON.parse(raw) as { snapshots?: RankSnapshot[] }) : null;
    return Array.isArray(parsed?.snapshots) ? parsed.snapshots.filter((s) => s && typeof s.at === 'number') : [];
  } catch {
    return [];
  }
}

/**
 * 对比基准：取 3~24 小时前最早的一次快照（看半天到一天的变化）；
 * 还没有那么久的记录时，退而用至少 1 小时前的；都没有就不算势头。
 */
export function pickBaseline(history: RankSnapshot[], now = Date.now()): RankSnapshot | undefined {
  const sorted = [...history].sort((a, b) => a.at - b.at);
  return (
    sorted.find((s) => now - s.at <= 24 * HOUR && now - s.at >= 3 * HOUR) ??
    [...sorted].reverse().find((s) => now - s.at >= HOUR)
  );
}

export async function recordSnapshot(
  listId: string,
  keys: string[],
  history: RankSnapshot[],
  now = Date.now(),
): Promise<void> {
  const last = history.reduce((max, s) => Math.max(max, s.at), 0);
  if (now - last < SNAPSHOT_EVERY) return;
  const ranks: Record<string, number> = {};
  keys.slice(0, TOP_N).forEach((key, i) => {
    if (key && ranks[key] === undefined) ranks[key] = i;
  });
  const snapshots = [...history, { at: now, ranks }].sort((a, b) => a.at - b.at).slice(-KEEP);
  try {
    await writeStoredJson(storageKey(listId), JSON.stringify({ snapshots }));
  } catch {
    // 没接存储 / 写失败：下次再记
  }
}
