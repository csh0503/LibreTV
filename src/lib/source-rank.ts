import type { SearchResultItem } from './types';
import type { SourceHealthEntry } from './store';
import { qualityTier, type SourceQuality } from './stream-quality';
import { loadPlaybackStats, playbackFailing, type PlaybackStats } from './playback-stats';

/**
 * 同一部作品有好几个源时谁排前面（「播放」默认用第一个）：
 * 1. 最近没出错、质检也没失败的优先；
 * 2. 清晰度高的优先（1080P > 720P > 更低 / 还没测出）；
 * 3. 集数更新得多的优先（有的源落后好几集）；
 * 4. 插入广告少的优先（能识别的广告播放时会跳过，但少总比多好）；
 * 5. 起播快的优先：你在这台设备上真的播过的用实际起播耗时，没播过的用上次搜索的响应时间（没有测过的按 3 秒算）；
 * 6. 你播的时候常卡的排后面。
 * 「真的播过」的数据见 playback-stats：最近老播不了的算出错，质检还没测出清晰度的用播放时看到的。
 */
const UNKNOWN_MS = 3000;

export function episodeCount(remarks?: string): number {
  if (!remarks) return 0;
  // 只要「集 / 话」。综艺日期「更新至20251016期」不是集数，否则这种源会永远排到最前。
  const m = remarks.match(/(?:^|[^\d])(\d{1,4})\s*[集话話]/);
  return m ? parseInt(m[1], 10) : 0;
}

/** 质检结果按源和影片对应的键 */
export const qualityKey = (item: Pick<SearchResultItem, 'sourceKey' | 'vodId'>) => `${item.sourceKey}_${item.vodId}`;

export function rankSources(
  items: SearchResultItem[],
  health: Record<string, SourceHealthEntry | undefined>,
  quality: Record<string, SourceQuality | undefined> = {},
  playback: PlaybackStats = loadPlaybackStats(),
): SearchResultItem[] {
  const scored = items.map((item, index) => {
    const h = health[item.sourceKey];
    const q = quality[qualityKey(item)];
    const p = playback[item.sourceKey];
    // 质检没测出清晰度（没测 / 测不了），就用你播放时看到的
    const tier = q?.ok && q.height ? qualityTier(q) : p?.height && (!q || q.ok) ? qualityTier({ key: '', ok: true, height: p.height }) : qualityTier(q);
    const failing =
      (h ? (h.ok === false ? 1 : 0) + Math.min(h.failStreak ?? 0, 5) : 0) + (tier === 0 ? 1 : 0) + (playbackFailing(p) ? 1 : 0);
    return {
      item,
      index,
      failing,
      tier,
      eps: episodeCount(item.remarks),
      // 新规则疑似的广告播放时还不跳过，比已跳过的更影响观看，加倍算
      ads: (q?.adSeconds ?? 0) + 2 * (q?.suspectSeconds ?? 0),
      ms: p?.startMs ?? (h?.ok && h.ms ? h.ms : UNKNOWN_MS),
      // 每次播放平均卡顿超过 1 次才算「常卡」，按整数档比，免得一点点差别就打乱顺序
      stalls: Math.floor(p?.stalls ?? 0),
    };
  });
  return scored
    .sort((a, b) => {
      if (a.failing !== b.failing) return a.failing - b.failing;
      if (a.tier !== b.tier) return b.tier - a.tier;
      if (a.eps !== b.eps) return b.eps - a.eps;
      if (a.ads !== b.ads) return a.ads - b.ads;
      if (a.stalls !== b.stalls) return a.stalls - b.stalls;
      if (a.ms !== b.ms) return a.ms - b.ms;
      return a.index - b.index;
    })
    .map((s) => s.item);
}
