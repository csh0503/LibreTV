import type { SkipSegment } from './skip-times';

/**
 * 你手动标的广告位置（按「源 + 影片 + 第几集」记，这台设备的 localStorage）：播放到这里自动跳过。
 * 去广告规则漏掉的插播广告，在规则修好之前先靠这个。
 */

const KEY = 'libretv:ad-marks:v1';
const MAX_EPISODES = 500;

type Store = Record<string, { ranges: SkipSegment[]; updatedAt: number }>;

function readAll(): Store {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Store;
  } catch {
    return {};
  }
}

export function loadAdMarks(episodeKey: string): SkipSegment[] {
  return readAll()[episodeKey]?.ranges ?? [];
}

export function saveAdMarks(episodeKey: string, ranges: SkipSegment[]): void {
  const all = readAll();
  if (ranges.length === 0) delete all[episodeKey];
  else all[episodeKey] = { ranges: [...ranges].sort((a, b) => a.start - b.start), updatedAt: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > MAX_EPISODES) {
    for (const k of keys.sort((a, b) => all[a].updatedAt - all[b].updatedAt).slice(0, keys.length - MAX_EPISODES)) delete all[k];
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 存满了：这次照样跳
  }
}
