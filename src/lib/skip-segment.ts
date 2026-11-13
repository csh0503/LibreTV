import { failoverQueryTitle } from './failover';
import { canonicalTitle } from './title-aliases';

import type { SkipSegment, SkipTimes } from './skip-times';

export type { SkipSegment, SkipTimes } from './skip-times';

/** 声音比对的结果比官方短这么多（秒）就当成半截（被片头曲中间的台词切断了） */
export const HALF_SEGMENT_SECONDS = 20;
/** 半截结果的起点 / 终点和官方差这么多以内，才拿它校准官方的位置（官方约略的放宽） */
const ALIGN_SECONDS = 10;
const ALIGN_APPROX_SECONDS = 15;

/**
 * 声音比对 + 官方数据合起来：声音比对是这个片源、这一集的真实位置，通常最准；
 * 但它比官方给的长度短了 20 秒以上时，多半只对上了半首片头曲（中间有独白 / 音效），
 * 直接用会跳到片头正中间。这时：
 * - 起点对得上官方 → 起点用声音比对的、长度用官方的（片源前面多几秒少几秒照样准）；
 * - 终点对得上官方 → 终点用声音比对的、往前推官方长度；
 * - 都对不上 → 用官方的。
 */
function reconcile(audio: SkipSegment, remote: SkipSegment): SkipSegment {
  const audioLen = audio.end - audio.start;
  const remoteLen = remote.end - remote.start;
  if (remoteLen - audioLen <= HALF_SEGMENT_SECONDS) return audio;
  const tol = remote.approx ? ALIGN_APPROX_SECONDS : ALIGN_SECONDS;
  if (Math.abs(audio.start - remote.start) <= tol) return { start: audio.start, end: audio.start + remoteLen, via: 'audio' };
  if (Math.abs(audio.end - remote.end) <= tol) {
    return { start: Math.max(0, audio.end - remoteLen), end: audio.end, via: 'audio' };
  }
  return remote;
}

/**
 * 这一集实际用的片头片尾（绝对秒数）：每段各自挑——
 * 声音比对找到的（就是这个片源、这一集的位置，最准）> 官方数据（B站 / AniSkip / TheIntroDB）的准确值 > 官方的大概位置；
 * 声音比对明显只有半截时用官方长度校正（见 `reconcile`）。
 * 大概位置（版本对不上）只显示按钮、不自动跳。
 */
export function pickEpisodeSkip(remote: SkipTimes | undefined, audio: SkipTimes | undefined, duration: number): SkipTimes {
  const valid = (s?: SkipSegment) =>
    s && duration > 0 && s.end > s.start && s.start < duration ? { ...s, end: Math.min(s.end, duration) } : undefined;
  const pick = (kind: 'intro' | 'outro') => {
    const a = valid(audio?.[kind]);
    const r = valid(remote?.[kind]);
    if (a && r) return valid(reconcile(a, r));
    return a ?? r;
  };
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
