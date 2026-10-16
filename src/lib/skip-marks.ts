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
  /**
   * 只知道片头多长（片头前的剧情每集长度不同、位置不固定时用）：
   * 开头附近显示「跳过 1:30」，从按下的位置往后跳这么多秒。
   */
  introLength?: number;
  /** 片头片尾是你手动设的：比 AniSkip 优先 */
  manual?: boolean;
  /** 这部剧自动跳过 */
  auto?: boolean;
  /** 你说 AniSkip 的时间点不准：这部剧不再用它，只用你自己跳过时记下的 */
  ignoreRemote?: boolean;
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

export type SkipSource = 'manual' | 'aniskip' | 'aniskip-approx' | 'learned';

export interface EpisodeSkip {
  intro?: SkipSegment;
  outro?: SkipSegment;
  /** 没有片头位置、只知道片头长度时：开头附近按一下往后跳这么多秒 */
  introJump?: number;
  auto: boolean;
  /** 哪段用的是 AniSkip 的准确时间（这段不再问你要不要记） */
  remote: { intro: boolean; outro: boolean };
  /** 每段的来源 */
  source: { intro?: SkipSource; outro?: SkipSource };
  /** 没有某段时的原因（AniSkip 那边） */
  missing: NonNullable<SkipTimes['missing']>;
}

/**
 * 这一集实际用的片头片尾（绝对秒数），优先顺序：
 * 你手动设的 > AniSkip 的准确时间 > 你跳过后确认记下的 > AniSkip 只有别的版本时的大概位置。
 */
export function resolveEpisodeSkip(remote: SkipTimes | undefined, learned: LearnedSkip | undefined, duration: number): EpisodeSkip {
  const valid = (s?: SkipSegment) =>
    s && s.end > s.start && s.start < duration ? { ...s, start: s.start, end: Math.min(s.end, duration) } : undefined;
  const learnedOutro =
    learned?.outro && duration > 0
      ? valid({ start: duration - learned.outro.fromEnd, end: duration - learned.outro.toEnd })
      : undefined;
  const r = learned?.ignoreRemote ? undefined : remote;
  const exact = (s?: SkipSegment) => (s && !s.approx ? valid(s) : undefined);
  const approx = (s?: SkipSegment) => (s?.approx ? valid(s) : undefined);
  const mine = learned?.manual ? 'manual' : 'learned';
  const pick = (
    own: SkipSegment | undefined,
    fromRemote: SkipSegment | undefined,
  ): { seg?: SkipSegment; source?: SkipSource } => {
    const candidates: [SkipSegment | undefined, SkipSource][] = learned?.manual
      ? [[own, 'manual'], [exact(fromRemote), 'aniskip'], [approx(fromRemote), 'aniskip-approx']]
      : [[exact(fromRemote), 'aniskip'], [own, mine], [approx(fromRemote), 'aniskip-approx']];
    const hit = candidates.find(([seg]) => seg);
    return hit ? { seg: hit[0], source: hit[1] } : {};
  };
  const intro = pick(valid(learned?.intro), r?.intro);
  const outro = pick(learnedOutro, r?.outro);
  const introJump = !intro.seg && learned?.introLength && learned.introLength > 0 ? learned.introLength : undefined;
  return {
    intro: intro.seg,
    outro: outro.seg,
    introJump,
    auto: Boolean(learned?.auto),
    remote: { intro: intro.source === 'aniskip', outro: outro.source === 'aniskip' },
    source: { intro: intro.seg ? intro.source : introJump ? mine : undefined, outro: outro.source },
    missing: r?.missing ?? {},
  };
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
