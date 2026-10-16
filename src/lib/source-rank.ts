import type { SearchResultItem } from './types';
import type { SourceHealthEntry } from './store';

/**
 * 同一部作品有好几个源时谁排前面（「播放」默认用第一个）：
 * 1. 最近没出错的优先（上次搜索失败、连续失败的往后放）；
 * 2. 集数更新得多的优先（有的源落后好几集）；
 * 3. 上次搜索响应快的优先（没有测过的按 3 秒算）。
 */
const UNKNOWN_MS = 3000;

export function episodeCount(remarks?: string): number {
  if (!remarks) return 0;
  const m = remarks.match(/(?:更新至|全|共)?\s*第?\s*(\d+)\s*[集话期]/);
  return m ? parseInt(m[1], 10) : 0;
}

export function rankSources(
  items: SearchResultItem[],
  health: Record<string, SourceHealthEntry | undefined>,
): SearchResultItem[] {
  const scored = items.map((item, index) => {
    const h = health[item.sourceKey];
    const failing = h ? (h.ok === false ? 1 : 0) + Math.min(h.failStreak ?? 0, 5) : 0;
    return { item, index, failing, eps: episodeCount(item.remarks), ms: h?.ok && h.ms ? h.ms : UNKNOWN_MS };
  });
  return scored
    .sort((a, b) => {
      if (a.failing !== b.failing) return a.failing - b.failing;
      if (a.eps !== b.eps) return b.eps - a.eps;
      if (a.ms !== b.ms) return a.ms - b.ms;
      return a.index - b.index;
    })
    .map((s) => s.item);
}
