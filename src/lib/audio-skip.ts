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
import type { SkipSegment } from './skip-segment';

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
/**
 * 用尾段模板找结束点：尾段（曲子最后 20 秒）应该从「起点 + 长度 − 20 秒」开始，
 * 只在它前 20 秒到后 30 秒里找（这集片头长一点短一点也对得上），取最后一个对上的位置——
 * 窗口开太大、取最长的话，会对上片头前半段旋律一样的第一遍副歌，结束点被拉到片头中间。
 */
const TAIL_EARLY_SECONDS = 20;
const TAIL_LATE_SECONDS = 30;
/** 尾段至少要对上这么多秒才算（20 秒的尾段模板） */
const TAIL_MIN_SECONDS = 14;
/**
 * 两集比对时的「跨空隙合并」和「主片头曲优先」：片头曲中间插了 3~8 秒独白 / 标题音效，
 * 前后两半偏移量一样、空隙 ≤18 秒、合起来 55~150 秒的，算同一首曲子。
 */
const COMPARE_OPTIONS = {
  bridge: { gapSeconds: 18, min: 55, max: 150 },
  prefer: { min: 55, max: 150 },
} as const;
/**
 * 两集比出来短于这个长度（秒）的片头 / 片尾可能只是半截：先不存成模板，
 * 再跟第三集比一次，两次长度和位置都对得上才存（真的就是短片头的剧也能存上）。
 */
export const TRUSTED_SEGMENT_SECONDS = 50;

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
    const m = await findCommonSegmentAsync(fa, fb, { minSeconds: limits.min, ...COMPARE_OPTIONS }, signal);
    if (!m || m.seconds > limits.max) continue;
    // 贴着窗口末尾：可能还没完，放大窗口再找
    const touches = m.aStart + m.seconds >= w.to - w.from - 3 || m.bStart + m.seconds >= w.otherTo - w.otherFrom - 3;
    if (!endIsFine && touches) continue;
    const start = w.from + m.aStart;
    return {
      seg: { start: round1(start), end: round1(start + m.seconds) },
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
    const expectedTail = end - TAIL_SECONDS;
    const winFrom = Math.max(start, expectedTail - TAIL_EARLY_SECONDS);
    const winTo = Math.min(total, expectedTail + TAIL_LATE_SECONDS + TAIL_SECONDS);
    if (winTo > to) {
      pcm = cat(pcm, await extractAudio(current, to, winTo, deps, signal));
      to = winTo;
    }
    if (signal?.aborted) return {};
    const lo = Math.max(0, Math.round((winFrom - from) * FP_RATE));
    const hi = Math.min(pcm.length, Math.round((winTo - from) * FP_RATE));
    const tail = decodeTemplate(template.tail);
    const t = await findCommonSegmentAsync(tail, fingerprint(pcm.subarray(lo, hi)), { minSeconds: TAIL_MIN_SECONDS, pick: 'latest' }, signal);
    if (t) {
      const tailEnd = winFrom + t.bStart - t.aStart + TAIL_SECONDS;
      // 结束点不许比模板长度短太多（对上的多半是前面一遍副歌），这种就按模板长度
      if (tailEnd >= start + template.length - TAIL_EARLY_SECONDS) end = tailEnd;
    }
  }
  return { seg: { start: round1(start), end: round1(end) } };
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

export interface AcrossEpisodesResult extends AudioDetectResult {
  /** 找到的结果可以存成这部剧的模板（够长，或短但两集比出来一致） */
  save: boolean;
  /** 跟几集都比不出来：多半是这集本身没有这一段 */
  missed: boolean;
}

const segLength = (s: SkipSegment) => s.end - s.start;

/**
 * 没有模板（或模板这集对不上）时：依次跟别的集比，
 * - 比出 ≥50 秒的片头 / 片尾：直接用、存模板；
 * - 比出来较短（可能是被台词切断的半截、或前情提要 / 厂牌片头）：先记着，继续跟下一集比——
 *   下一集比出够长的就用够长的；比出来长度和起点都对得上（±5 秒 / ±3 秒）才当真的短片头存模板；
 *   都没有就这集先用短的，但不存（不让半截结果污染之后每一集）。
 */
export async function detectAcrossEpisodes(opts: {
  kind: 'intro' | 'outro';
  current: HlsSegment[];
  /** 依次取别的集（取不到返回 null） */
  others: (() => Promise<HlsSegment[] | null>)[];
  deps: HlsAudioDeps;
  signal?: AbortSignal;
}): Promise<AcrossEpisodesResult> {
  const detect = opts.kind === 'intro' ? detectIntro : detectOutro;
  let short: AudioDetectResult | undefined;
  let tried = 0;
  for (const load of opts.others) {
    const other = await load();
    if (opts.signal?.aborted) return { save: false, missed: false };
    if (!other) continue;
    tried += 1;
    const found = await detect({ current: opts.current, other, deps: opts.deps, signal: opts.signal });
    if (opts.signal?.aborted) return { save: false, missed: false };
    if (!found.seg) continue;
    if (segLength(found.seg) >= TRUSTED_SEGMENT_SECONDS) return { ...found, save: true, missed: false };
    if (!short?.seg) {
      short = found;
      continue;
    }
    const agree =
      Math.abs(segLength(found.seg) - segLength(short.seg)) <= 5 && Math.abs(found.seg.start - short.seg.start) <= 3;
    if (agree) return { ...short, save: true, missed: false };
  }
  if (short?.seg) return { seg: short.seg, save: false, missed: false };
  return { save: false, missed: tried > 0 };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
