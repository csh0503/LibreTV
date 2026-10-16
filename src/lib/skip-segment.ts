import { failoverQueryTitle } from './failover';
import { canonicalTitle } from './title-aliases';

import type { SkipSegment, SkipTimes } from './skip-times';

export type { SkipSegment, SkipTimes } from './skip-times';

/**
 * 这一集实际用的片头片尾（绝对秒数）：每段各自挑——
 * 声音比对找到的（就是这个片源、这一集的位置，最准）> 官方数据（B站 / AniSkip / TheIntroDB）的准确值 > 官方的大概位置。
 * 大概位置（版本对不上）只显示按钮、不自动跳。
 */
export function pickEpisodeSkip(remote: SkipTimes | undefined, audio: SkipTimes | undefined, duration: number): SkipTimes {
  const valid = (s?: SkipSegment) =>
    s && duration > 0 && s.end > s.start && s.start < duration ? { ...s, end: Math.min(s.end, duration) } : undefined;
  const pick = (kind: 'intro' | 'outro') => valid(audio?.[kind]) ?? valid(remote?.[kind]);
  return { intro: pick('intro'), outro: pick('outro') };
}

/** 同一部剧（不分片源、不分「第二季 / 2」写法）共用一份片头片尾模板 */
export function seriesKeyOf(title: string, year?: string): string {
  const base = failoverQueryTitle(title, year);
  return canonicalTitle(base) || base;
}

/** 「1:30」「01:02:03」「90」→ 秒；看不懂返回 undefined */
export function parseClock(text: string): number | undefined {
  const t = text.trim();
  if (!t) return undefined;
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(parseFloat(t));
  const m = t.match(/^(?:(\d+)[:：])?(\d{1,2})[:：](\d{1,2})$/);
  if (!m) return undefined;
  const [h, mm, ss] = [parseInt(m[1] ?? '0', 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  if (ss >= 60 || (m[1] && mm >= 60)) return undefined;
  return h * 3600 + mm * 60 + ss;
}
