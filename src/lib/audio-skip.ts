import {
  FP_HOP_SECONDS,
  TEMPLATE_SECONDS,
  decodeTemplate,
  encodeTemplate,
  findCommonSegmentAsync,
  fingerprint,
} from './audio-fingerprint';
import { extractAudio, playlistDuration, type HlsAudioDeps, type HlsSegment } from './hls-audio';
import type { SkipSegment } from './skip-times';

/**
 * 声音比对找片头 / 片尾：
 * - 这部剧第一次：当前这集和另一集（下一集，没有就上一集）各取开头几分钟，找两集共有的那段音乐 = 片头；
 *   结尾同理 = 片尾。找到后把片头 / 片尾曲开头 30 秒的特征存成模板。
 * - 有模板之后：每集只取自己的开头 / 结尾跟模板比，不用再下载别的集。
 */

/** 存起来的模板：曲子开头 30 秒的特征 + 整段多长 */
export interface AudioTemplate {
  tpl: string;
  length: number;
}

export interface AudioDetectResult {
  seg?: SkipSegment;
  /** 第一次找到时生成的模板（调用方存起来） */
  template?: AudioTemplate;
}

const INTRO_WINDOWS = [240, 420];
const OUTRO_WINDOWS = [360];
const INTRO_SECONDS = { min: 25, max: 200 };
const OUTRO_SECONDS = { min: 25, max: 240 };

const cat = (a: Float32Array, b: Float32Array) => {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** 两集比对：在 [from, to) 窗口里逐步放大，直到找到完整（不贴着窗口边）的共有段 */
async function compareEpisodes(
  current: HlsSegment[],
  other: HlsSegment[],
  windows: { from: number; to: number; otherFrom: number; otherTo: number }[],
  limits: { min: number; max: number },
  deps: HlsAudioDeps,
  signal?: AbortSignal,
  /** 片尾：贴着结尾是正常的，不用放大窗口 */
  endIsFine = false,
): Promise<AudioDetectResult> {
  let a = new Float32Array(0);
  let b = new Float32Array(0);
  let aTo = windows[0]?.from ?? 0;
  let bTo = windows[0]?.otherFrom ?? 0;
  for (const w of windows) {
    // 只补新的那一段，不重复下载
    a = cat(a, await extractAudio(current, aTo, w.to, deps, signal));
    b = cat(b, await extractAudio(other, bTo, w.otherTo, deps, signal));
    aTo = w.to;
    bTo = w.otherTo;
    if (signal?.aborted) return {};
    const fa = fingerprint(a);
    const fb = fingerprint(b);
    const m = await findCommonSegmentAsync(fa, fb, { minSeconds: limits.min }, signal);
    if (!m || m.seconds > limits.max) continue;
    // 贴着窗口末尾：可能还没完，放大窗口再找
    const span = (w.to - w.from) - 3;
    if (!endIsFine && (m.aStart + m.seconds >= span || m.bStart + m.seconds >= w.otherTo - w.otherFrom - 3)) continue;
    const start = w.from + m.aStart;
    return {
      seg: { start: round1(start), end: round1(start + m.seconds), via: 'audio' },
      template: { tpl: encodeTemplate(fa, m.aStart, Math.min(TEMPLATE_SECONDS, m.seconds)), length: m.seconds },
    };
  }
  return {};
}

/** 用模板在 [from, to) 里找曲子从哪开始 */
async function matchTemplate(
  current: HlsSegment[],
  template: AudioTemplate,
  from: number,
  to: number,
  deps: HlsAudioDeps,
  signal?: AbortSignal,
): Promise<AudioDetectResult> {
  const tpl = decodeTemplate(template.tpl);
  const tplSeconds = (tpl.length / 16) * FP_HOP_SECONDS;
  const pcm = await extractAudio(current, from, to, deps, signal);
  if (signal?.aborted) return {};
  const m = await findCommonSegmentAsync(tpl, fingerprint(pcm), { minSeconds: Math.min(15, tplSeconds * 0.6) }, signal);
  // 要从模板开头附近就对上（不然可能只是对上了曲子中间某段）
  if (!m || m.aStart > 5) return {};
  const start = from + m.bStart - m.aStart;
  return { seg: { start: round1(start), end: round1(start + template.length), via: 'audio' } };
}

export async function detectIntro(opts: {
  current: HlsSegment[];
  other?: HlsSegment[];
  template?: AudioTemplate;
  deps: HlsAudioDeps;
  signal?: AbortSignal;
}): Promise<AudioDetectResult> {
  const total = playlistDuration(opts.current);
  const limit = Math.min(600, total * 0.4);
  if (opts.template) {
    // 先看前 4 分钟（片头多半在这），没有再往后找
    const first = await matchTemplate(opts.current, opts.template, 0, Math.min(240, limit), opts.deps, opts.signal);
    if (first.seg || limit <= 240) return first;
    return matchTemplate(opts.current, opts.template, 200, limit, opts.deps, opts.signal);
  }
  if (!opts.other) return {};
  const otherTotal = playlistDuration(opts.other);
  const windows = INTRO_WINDOWS.filter((w) => w <= Math.max(limit, INTRO_WINDOWS[0])).map((w) => ({
    from: 0,
    to: Math.min(w, total),
    otherFrom: 0,
    otherTo: Math.min(w, otherTotal),
  }));
  return compareEpisodes(opts.current, opts.other, windows, INTRO_SECONDS, opts.deps, opts.signal);
}

export async function detectOutro(opts: {
  current: HlsSegment[];
  other?: HlsSegment[];
  template?: AudioTemplate;
  deps: HlsAudioDeps;
  signal?: AbortSignal;
}): Promise<AudioDetectResult> {
  const total = playlistDuration(opts.current);
  const window = OUTRO_WINDOWS[0];
  if (opts.template) {
    const r = await matchTemplate(opts.current, opts.template, Math.max(0, total - window - 120), total, opts.deps, opts.signal);
    if (r.seg) r.seg.end = total - r.seg.end <= 3 ? round1(total) : Math.min(r.seg.end, round1(total));
    return r;
  }
  if (!opts.other) return {};
  const otherTotal = playlistDuration(opts.other);
  const r = await compareEpisodes(
    opts.current,
    opts.other,
    [{ from: Math.max(0, total - window), to: total, otherFrom: Math.max(0, otherTotal - window), otherTo: otherTotal }],
    OUTRO_SECONDS,
    opts.deps,
    opts.signal,
    true,
  );
  // 片尾一直到结尾附近：当作到结尾（「下一集」按钮）
  if (r.seg && total - r.seg.end <= 3) r.seg.end = round1(total);
  return r;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
