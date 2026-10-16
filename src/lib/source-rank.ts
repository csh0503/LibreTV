import type { SearchResultItem } from './types';
import type { SourceHealthEntry } from './store';
import { qualityTier, type SourceQuality } from './stream-quality';

/**
 * 同一部作品有好几个源时谁排前面（「播放」默认用第一个）：
 * 1. 最近没出错、质检也没失败的优先；
 * 2. 清晰度高的优先（1080P > 720P > 更低 / 还没测出）；
 * 3. 集数更新得多的优先（有的源落后好几集）；
 * 4. 插入广告少的优先（能识别的广告播放时会跳过，但少总比多好）；
 * 5. 上次搜索响应快的优先（没有测过的按 3 秒算）。
 */
const UNKNOWN_MS = 3000;

export function episodeCount(remarks?: string): number {
  if (!remarks) return 0;
  const m = remarks.match(/(?:更新至|全|共)?\s*第?\s*(\d+)\s*[集话期]/);
  return m ? parseInt(m[1], 10) : 0;
}

/** 质检结果按源和影片对应的键 */
export const qualityKey = (item: Pick<SearchResultItem, 'sourceKey' | 'vodId'>) => `${item.sourceKey}_${item.vodId}`;

export function rankSources(
  items: SearchResultItem[],
  health: Record<string, SourceHealthEntry | undefined>,
  quality: Record<string, SourceQuality | undefined> = {},
): SearchResultItem[] {
  const scored = items.map((item, index) => {
    const h = health[item.sourceKey];
    const q = quality[qualityKey(item)];
    const tier = qualityTier(q);
    const failing = (h ? (h.ok === false ? 1 : 0) + Math.min(h.failStreak ?? 0, 5) : 0) + (tier === 0 ? 1 : 0);
    return {
      item,
      index,
      failing,
      tier,
      eps: episodeCount(item.remarks),
      // 新规则疑似的广告播放时还不跳过，比已跳过的更影响观看，加倍算
      ads: (q?.adSeconds ?? 0) + 2 * (q?.suspectSeconds ?? 0),
      ms: h?.ok && h.ms ? h.ms : UNKNOWN_MS,
    };
  });
  return scored
    .sort((a, b) => {
      if (a.failing !== b.failing) return a.failing - b.failing;
      if (a.tier !== b.tier) return b.tier - a.tier;
      if (a.eps !== b.eps) return b.eps - a.eps;
      if (a.ads !== b.ads) return a.ads - b.ads;
      if (a.ms !== b.ms) return a.ms - b.ms;
      return a.index - b.index;
    })
    .map((s) => s.item);
}
