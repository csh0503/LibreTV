/**
 * 每个点播源在这台设备上的实际播放表现：起播要多久、画面多清楚、卡了几次、播不了几次。
 * 片源质检只看第 1 集的播放列表，这里记的是你真的看的时候的情况（网络、时段都算进去）。
 * 排序（rankSources）和自动换源都参考它：播放过的、又快又清楚的源排前面。
 * 存 localStorage（换设备 / 换网络本来就不一样），最多 200 个源。
 */

export interface PlaybackStat {
  /** 播放过几次 */
  plays: number;
  /** 起播耗时（毫秒，指数平滑） */
  startMs?: number;
  /** 看到的最高画面高度 */
  height?: number;
  /** 卡顿次数（指数平滑，单位：次 / 次播放） */
  stalls: number;
  /** 播不了（触发自动换源）的次数，成功播一次减一 */
  fails: number;
  at: number;
}

export type PlaybackStats = Record<string, PlaybackStat>;

const KEY = 'libretv:playback-stats:v1';
const MAX = 200;
const ALPHA = 0.3;

let cache: PlaybackStats | null = null;

export function loadPlaybackStats(): PlaybackStats {
  if (cache) return cache;
  if (typeof localStorage === 'undefined') return {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as unknown;
    cache = raw && typeof raw === 'object' ? (raw as PlaybackStats) : {};
  } catch {
    cache = {};
  }
  return cache;
}

function update(sourceKey: string, fn: (prev: PlaybackStat) => PlaybackStat) {
  if (!sourceKey || typeof localStorage === 'undefined') return;
  const all = { ...loadPlaybackStats() };
  all[sourceKey] = { ...fn(all[sourceKey] ?? { plays: 0, stalls: 0, fails: 0, at: 0 }), at: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > MAX) {
    keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - MAX).forEach((k) => delete all[k]);
  }
  cache = all;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 存不了就只在这次有效
  }
}

const smooth = (prev: number | undefined, value: number) => (prev === undefined ? value : prev * (1 - ALPHA) + value * ALPHA);

/** 开播了：记起播耗时和画面高度 */
export function recordPlaybackStart(sourceKey: string, startMs: number, height: number) {
  update(sourceKey, (p) => ({
    ...p,
    plays: p.plays + 1,
    startMs: startMs > 0 && startMs < 120_000 ? Math.round(smooth(p.startMs, startMs)) : p.startMs,
    height: height > 0 ? Math.max(p.height ?? 0, height) : p.height,
    stalls: smooth(p.stalls, 0),
    fails: Math.max(0, p.fails - 1),
  }));
}

/** 播放中卡住（缓冲） */
export function recordStall(sourceKey: string) {
  update(sourceKey, (p) => ({ ...p, stalls: p.stalls + ALPHA }));
}

/** 这个源这次播不了 */
export function recordPlaybackFail(sourceKey: string) {
  update(sourceKey, (p) => ({ ...p, fails: p.fails + 1 }));
}

/** 最近老是播不了：播不了的次数比播成功的还多 */
export function playbackFailing(stat: PlaybackStat | undefined): boolean {
  return Boolean(stat && stat.fails >= 2 && stat.fails > stat.plays);
}

/** 测试用 */
export function resetPlaybackStatsCache() {
  cache = null;
}
