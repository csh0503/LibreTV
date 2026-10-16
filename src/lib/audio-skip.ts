import {
  FP_HOP_SECONDS,
  FP_RATE,
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

/** 存起来的模板：曲子开头 30 秒的特征 + 整段多长；tail = 曲子最后 20 秒（用来逐集找准结束点） */
export interface AudioTemplate {
  tpl: string;
  length: number;
  tail?: string;
}

export interface AudioDetectResult {
  seg?: SkipSegment;
  /** 第一次找到时生成的模板（调用方存起来） */
  template?: AudioTemplate;
}

/** 片头先看前 3 分钟（多数片头在这），找不到完整的再放大到 6 分钟 */
const INTRO_WINDOWS = [180, 360];
/** 片尾看最后 5 分钟 */
const OUTRO_WINDOW = 300;
const INTRO_SECONDS = { min: 25, max: 200 };
const OUTRO_SECONDS = { min: 25, max: 240 };
const TAIL_SECONDS = 20;
/** 用尾段模板找结束点时，在「开头 + 长度」前后多远内找 */
const TAIL_SEARCH_SECONDS = 45;

const cat = (a: Float32Array, b: Float32Array) => {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

function makeTemplate(fp: Float32Array, start: number, seconds: number): AudioTemplate {
  return {
    tpl: encodeTemplate(fp, start, Math.min(TEMPLATE_SECONDS, seconds)),
    length: round1(seconds),
    ...(seconds >= TEMPLATE_SECONDS + 10 ? { tail: encodeTemplate(fp, start + seconds - TAIL_SECONDS, TAIL_SECONDS) } : {}),
  };
}

/** 两集比对：窗口从小到大，只补新的那一段（不重复下载），两集同时取；直到找到完整（不贴着窗口边）的共有段 */
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
    const [moreA, moreB] = await Promise.all([
      extractAudio(current, aTo, w.to, deps, signal),
      extractAudio(other, bTo, w.otherTo, deps, signal),
    ]);
    a = cat(a, moreA);
    b = cat(b, moreB);
    aTo = w.to;
    bTo = w.otherTo;
    if (signal?.aborted) return {};
    const fa = fingerprint(a);
    const fb = fingerprint(b);
    const m = await findCommonSegmentAsync(fa, fb, { minSeconds: limits.min }, signal);
    if (!m || m.seconds > limits.max) continue;
    // 贴着窗口末尾：可能还没完，放大窗口再找
    const touches = m.aStart + m.seconds >= w.to - w.from - 3 || m.bStart + m.seconds >= w.otherTo - w.otherFrom - 3;
    if (!endIsFine && touches) continue;
    const start = w.from + m.aStart;
    return {
      seg: { start: round1(start), end: round1(start + m.seconds), via: 'audio' },
      template: makeTemplate(fa, m.aStart, m.seconds),
    };
  }
  return {};
}

/**
 * 用模板在 [from, to) 里找：开头模板定起点；有尾段模板就在「起点 + 长度」前后找尾段定终点
 * （这集的片头比第一次那集长一点短一点也对得上），没有才按「起点 + 长度」。
 */
async function matchTemplate(
  current: HlsSegment[],
  template: AudioTemplate,
  from: number,
  to: number,
  deps: HlsAudioDeps,
  signal?: AbortSignal,
): Promise<AudioDetectResult> {
  const head = decodeTemplate(template.tpl);
  const headSeconds = (head.length / 16) * FP_HOP_SECONDS;
  let pcm = await extractAudio(current, from, to, deps, signal);
  if (signal?.aborted) return {};
  const m = await findCommonSegmentAsync(head, fingerprint(pcm), { minSeconds: Math.min(15, headSeconds * 0.6) }, signal);
  // 要从模板开头附近就对上（不然可能只是对上了曲子中间某段）
  if (!m || m.aStart > 5) return {};
  const start = from + m.bStart - m.aStart;
  let end = start + template.length;
  if (template.tail) {
    const total = playlistDuration(current);
    const winFrom = Math.max(start, end - TAIL_SEARCH_SECONDS);
    const winTo = Math.min(total, end + TAIL_SEARCH_SECONDS);
    if (winTo > to) {
      pcm = cat(pcm, await extractAudio(current, to, winTo, deps, signal));
      to = winTo;
    }
    if (signal?.aborted) return {};
    const lo = Math.max(0, Math.round((winFrom - from) * FP_RATE));
    const hi = Math.min(pcm.length, Math.round((winTo - from) * FP_RATE));
    const tail = decodeTemplate(template.tail);
    const t = await findCommonSegmentAsync(tail, fingerprint(pcm.subarray(lo, hi)), { minSeconds: 10 }, signal);
    if (t) end = winFrom + t.bStart - t.aStart + TAIL_SECONDS;
  }
  return { seg: { start: round1(start), end: round1(end), via: 'audio' } };
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
    // 先看前 3 分钟（片头多半在这），没有再往后找
    const first = await matchTemplate(opts.current, opts.template, 0, Math.min(INTRO_WINDOWS[0], limit), opts.deps, opts.signal);
    if (first.seg || limit <= INTRO_WINDOWS[0]) return first;
    return matchTemplate(opts.current, opts.template, INTRO_WINDOWS[0] - 40, limit, opts.deps, opts.signal);
  }
  if (!opts.other) return {};
  const otherTotal = playlistDuration(opts.other);
  const windows = INTRO_WINDOWS.filter((w, i) => i === 0 || w <= Math.max(limit, INTRO_WINDOWS[0])).map((w) => ({
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
  const snap = (r: AudioDetectResult) => {
    // 片尾一直到结尾附近：当作到结尾（「下一集」按钮）
    if (r.seg) r.seg.end = total - r.seg.end <= 3 ? round1(total) : Math.min(r.seg.end, round1(total));
    return r;
  };
  if (opts.template) {
    return snap(await matchTemplate(opts.current, opts.template, Math.max(0, total - OUTRO_WINDOW - 120), total, opts.deps, opts.signal));
  }
  if (!opts.other) return {};
  const otherTotal = playlistDuration(opts.other);
  return snap(
    await compareEpisodes(
      opts.current,
      opts.other,
      [{ from: Math.max(0, total - OUTRO_WINDOW), to: total, otherFrom: Math.max(0, otherTotal - OUTRO_WINDOW), otherTo: otherTotal }],
      OUTRO_SECONDS,
      opts.deps,
      opts.signal,
      true,
    ),
  );
}

const round1 = (n: number) => Math.round(n * 10) / 10;
