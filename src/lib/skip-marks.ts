import { failoverQueryTitle } from './failover';
import type { SkipSegment, SkipTimes } from './skip-times';
import { canonicalTitle } from './title-aliases';

/**
 * 跳过片头片尾：每部剧记一份（这台设备的 localStorage）。
 * - 片头按「从开头算」记，片尾按「离结尾多远」记（每集总长差几秒也对得上）；
 * - 来源：AniSkip（动漫，最准）> 你自己跳过时记下的；
 * - 默认只显示「跳过片头 / 跳过片尾」按钮，要这部剧打开「自动跳过」才会自己跳。
 */

const STORAGE_KEY = 'libretv:skip-marks:v1';
const MAX_SERIES = 300;

export interface LearnedSkip {
  intro?: SkipSegment;
  /** 片尾离结尾多远：开始于 duration - fromEnd，结束于 duration - toEnd（0 = 一直到结尾） */
  outro?: { fromEnd: number; toEnd: number };
  /** 这部剧自动跳过 */
  auto?: boolean;
  updatedAt: number;
}

export function seriesKeyOf(title: string, year?: string): string {
  const base = failoverQueryTitle(title, year);
  return canonicalTitle(base) || base;
}

function readAll(): Record<string, LearnedSkip> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, LearnedSkip>) : {};
  } catch {
    return {};
  }
}

export function loadSkipMarks(key: string): LearnedSkip | undefined {
  return readAll()[key];
}

export function saveSkipMarks(key: string, patch: Partial<LearnedSkip> | null): LearnedSkip | undefined {
  const all = readAll();
  if (patch === null) delete all[key];
  else all[key] = { ...all[key], ...patch, updatedAt: Date.now() };
  // 只留最近的几百部
  const keys = Object.keys(all);
  if (keys.length > MAX_SERIES) {
    for (const k of keys.sort((a, b) => all[a].updatedAt - all[b].updatedAt).slice(0, keys.length - MAX_SERIES)) delete all[k];
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    // 存不了（隐私模式）就只在这次有效
  }
  return all[key];
}

/**
 * 你手动往前跳了一大段：像不像在跳片头 / 片尾？
 * - 片头：开头附近（前 10 分钟且在前 35% 内）往后跳 40~200 秒；
 * - 片尾：最后 6 分钟内往后跳 30 秒以上（跳到结尾附近就算「片尾一直到结尾」）。
 */
export function classifySkip(
  from: number,
  to: number,
  duration: number,
): { kind: 'intro'; seg: SkipSegment } | { kind: 'outro'; fromEnd: number; toEnd: number } | null {
  if (!(duration > 0) || to <= from) return null;
  const jump = to - from;
  if (jump >= 40 && jump <= 200 && from < Math.min(600, duration * 0.35) && to < duration * 0.5) {
    return { kind: 'intro', seg: { start: Math.round(from), end: Math.round(to) } };
  }
  const left = duration - from;
  if (from > duration * 0.6 && left >= 30 && left <= 360 && jump >= 30) {
    const toEnd = duration - to <= 15 ? 0 : Math.round(duration - to);
    return { kind: 'outro', fromEnd: Math.round(left), toEnd };
  }
  return null;
}

export interface EpisodeSkip {
  intro?: SkipSegment;
  outro?: SkipSegment;
  auto: boolean;
  /** 哪个是 AniSkip 给的（显示来源用） */
  remote: { intro: boolean; outro: boolean };
}

/** 这一集实际用的片头片尾（绝对秒数）：AniSkip 有就用，没有用记下的 */
export function resolveEpisodeSkip(remote: SkipTimes | undefined, learned: LearnedSkip | undefined, duration: number): EpisodeSkip {
  const valid = (s?: SkipSegment) => (s && s.end > s.start && s.start < duration ? { start: s.start, end: Math.min(s.end, duration) } : undefined);
  const learnedOutro =
    learned?.outro && duration > 0
      ? valid({ start: duration - learned.outro.fromEnd, end: duration - learned.outro.toEnd })
      : undefined;
  const intro = valid(remote?.intro) ?? valid(learned?.intro);
  const outro = valid(remote?.outro) ?? learnedOutro;
  return {
    intro,
    outro,
    auto: Boolean(learned?.auto),
    remote: { intro: Boolean(valid(remote?.intro)), outro: Boolean(valid(remote?.outro)) },
  };
}
