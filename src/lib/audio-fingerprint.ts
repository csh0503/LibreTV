/**
 * 声音比对找片头片尾（纯计算，浏览器和测试共用）。
 *
 * 做法：把音频切成约 0.09 秒一帧，每帧算 16 个频段的能量形状（对数能量去均值再归一化，
 * 音量大小、编码差异基本不影响）；同一首片头曲在两集里的形状几乎一样，对白和配乐则不一样。
 * 两集逐个偏移量比较，找「连续很久都很像」的那一段，就是两集共有的片头 / 片尾。
 */

export const FP_RATE = 11025;
const WIN = 2048;
const HOP = 1024;
/** 一帧多少秒 */
export const FP_HOP_SECONDS = HOP / FP_RATE;
export const FP_DIMS = 16;
const BAND_LOW = 250;
const BAND_HIGH = 4000;
/** 音量低于约 -40 dB 的帧当静音（不参与比较；两边都静音时精修边界算「还在同一段」） */
const SILENCE_RMS = 0.0085;

/** 原地复数 FFT（基 2） */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** 16 个对数间隔频段的 FFT 下标边界 */
const BAND_EDGES = (() => {
  const edges: number[] = [];
  for (let b = 0; b <= FP_DIMS; b++) {
    const hz = BAND_LOW * Math.pow(BAND_HIGH / BAND_LOW, b / FP_DIMS);
    edges.push(Math.max(1, Math.round((hz / FP_RATE) * WIN)));
  }
  return edges;
})();

const HANN = (() => {
  const w = new Float64Array(WIN);
  for (let i = 0; i < WIN; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1));
  return w;
})();

/**
 * 音频（单声道、FP_RATE 采样）→ 每帧 16 维特征（扁平数组，帧 i 在 [i*16, i*16+16)）。
 * 静音帧全为 0（比较时算不像）。
 */
export function fingerprint(pcm: Float32Array): Float32Array {
  const frames = pcm.length >= WIN ? Math.floor((pcm.length - WIN) / HOP) + 1 : 0;
  const out = new Float32Array(frames * FP_DIMS);
  const re = new Float64Array(WIN);
  const im = new Float64Array(WIN);
  const band = new Float64Array(FP_DIMS);
  for (let f = 0; f < frames; f++) {
    const off = f * HOP;
    let power = 0;
    for (let i = 0; i < WIN; i++) {
      re[i] = pcm[off + i] * HANN[i];
      im[i] = 0;
      power += pcm[off + i] * pcm[off + i];
    }
    if (Math.sqrt(power / WIN) < SILENCE_RMS) continue;
    fft(re, im);
    for (let b = 0; b < FP_DIMS; b++) {
      let e = 0;
      for (let k = BAND_EDGES[b]; k < Math.max(BAND_EDGES[b] + 1, BAND_EDGES[b + 1]); k++) e += re[k] * re[k] + im[k] * im[k];
      band[b] = e;
    }
    let mean = 0;
    for (let b = 0; b < FP_DIMS; b++) {
      band[b] = Math.log(band[b] + 1e-12);
      mean += band[b];
    }
    mean /= FP_DIMS;
    let norm = 0;
    for (let b = 0; b < FP_DIMS; b++) {
      band[b] -= mean;
      norm += band[b] * band[b];
    }
    norm = Math.sqrt(norm) || 1;
    for (let b = 0; b < FP_DIMS; b++) out[f * FP_DIMS + b] = band[b] / norm;
  }
  return out;
}

export function frameCount(fp: Float32Array): number {
  return Math.floor(fp.length / FP_DIMS);
}

function similarity(a: Float32Array, i: number, b: Float32Array, j: number): number {
  let s = 0;
  const ai = i * FP_DIMS;
  const bj = j * FP_DIMS;
  for (let d = 0; d < FP_DIMS; d++) s += a[ai + d] * b[bj + d];
  return s;
}

export interface CommonSegment {
  /** a、b 里各从第几秒开始 */
  aStart: number;
  bStart: number;
  /** 共有多长（秒） */
  seconds: number;
  /** 这段里平均有多像（0~1） */
  score: number;
}

export interface MatchOptions {
  /** 至少连续多少秒才算（片头片尾一般 60~100 秒；默认 20 秒） */
  minSeconds?: number;
  /** 平滑后相似度高于这个才算「像」 */
  threshold?: number;
  /** 中间允许多长「不像」（台词压在片头曲上、转场静音）还算同一段 */
  maxGapSeconds?: number;
}

type Best = { ai: number; bj: number; len: number; score: number } | null;

interface ScanParams {
  minFrames: number;
  threshold: number;
  maxGap: number;
  smooth: number;
}

function scanParams(opts: MatchOptions): ScanParams {
  return {
    minFrames: Math.round((opts.minSeconds ?? 20) / FP_HOP_SECONDS),
    threshold: opts.threshold ?? 0.8,
    maxGap: Math.round((opts.maxGapSeconds ?? 2) / FP_HOP_SECONDS),
    smooth: Math.max(1, Math.round(1 / FP_HOP_SECONDS)),
  };
}

/** 偏移量 d = j - i（b 里的位置减 a 里的位置），扫 [dFrom, dTo] 这些偏移量 */
function scanOffsets(a: Float32Array, b: Float32Array, dFrom: number, dTo: number, p: ScanParams, best: Best, sims: Float32Array): Best {
  const na = frameCount(a);
  const nb = frameCount(b);
  for (let d = dFrom; d <= dTo; d++) {
    const i0 = Math.max(0, -d);
    const i1 = Math.min(na, nb - d);
    const len = i1 - i0;
    if (len < p.minFrames) continue;
    for (let k = 0; k < len; k++) sims[k] = similarity(a, i0 + k, b, i0 + k + d);
    let runStart = -1;
    let lastGood = -1;
    let sum = 0;
    let acc = 0;
    let accN = 0;
    for (let k = 0; k < len; k++) {
      sum += sims[k];
      if (k >= p.smooth) sum -= sims[k - p.smooth];
      const avg = sum / Math.min(k + 1, p.smooth);
      if (avg < p.threshold) continue;
      if (runStart < 0 || k - lastGood > p.maxGap) {
        if (runStart >= 0) best = pickBetter(best, i0 + runStart, i0 + runStart + d, lastGood - runStart + 1, acc / accN, p.minFrames);
        runStart = k;
        acc = 0;
        accN = 0;
      }
      lastGood = k;
      acc += avg;
      accN += 1;
    }
    if (runStart >= 0) best = pickBetter(best, i0 + runStart, i0 + runStart + d, lastGood - runStart + 1, acc / accN, p.minFrames);
  }
  return best;
}

function isSilent(fp: Float32Array, i: number): boolean {
  let e = 0;
  for (let d = 0; d < FP_DIMS; d++) e += fp[i * FP_DIMS + d] * fp[i * FP_DIMS + d];
  return e < 1e-6;
}

/** 边界最多往外延伸多少秒 */
const REFINE_MAX_SECONDS = 10;
/** 连续这么久不像才算真的结束 */
const REFINE_MISS_SECONDS = 1.2;

/**
 * 这两段音频里「不相干的两帧」一般有多像：随机抽帧对算均值和标准差，
 * 精修门槛取均值 + 2.5 个标准差（夹在 0.7~0.92）。对白之间、配乐之间本来就有几分像，固定门槛会把边界拉过头。
 */
function unrelatedThreshold(a: Float32Array, b: Float32Array): number {
  const na = frameCount(a);
  const nb = frameCount(b);
  let seed = 12345;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let k = 0; k < 2000 && na > 0 && nb > 0; k++) {
    const i = rand(na);
    const j = rand(nb);
    if (isSilent(a, i) || isSilent(b, j)) continue;
    const v = similarity(a, i, b, j);
    sum += v;
    sq += v * v;
    n += 1;
  }
  if (n < 50) return 0.8;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sq / n - mean * mean));
  return Math.min(0.92, Math.max(0.7, mean + 2.5 * std));
}

/**
 * 粗找出来的段边界不够准：1 秒滑动平均让两端都拖后半秒，片头曲最后的渐弱尾音、
 * 收尾的短暂静音又会被当成「不像」，结果片头还没放完就判结束了。
 * 这里沿同一个偏移量逐帧往外延伸：0.3 秒小平滑后仍明显比「不相干」更像，或两边都静音，就继续；
 * 连续 1.2 秒不像才停，再把两端不像的帧收回来。
 */
function refine(a: Float32Array, b: Float32Array, best: NonNullable<Best>, p: ScanParams): { ai: number; bj: number; len: number } {
  const na = frameCount(a);
  const nb = frameCount(b);
  const d = best.bj - best.ai;
  const threshold = unrelatedThreshold(a, b);
  const inRange = (i: number) => i >= 0 && i < na && i + d >= 0 && i + d < nb;
  const frameScore = (i: number) => (isSilent(a, i) && isSilent(b, i + d) ? 1 : similarity(a, i, b, i + d));
  const match = (i: number) => {
    if (!inRange(i)) return false;
    let total = 0;
    let n = 0;
    for (let k = i - 1; k <= i + 1; k++) {
      if (!inRange(k)) continue;
      total += frameScore(k);
      n += 1;
    }
    return total / n >= threshold;
  };
  const shift = Math.floor(p.smooth / 2);
  let s = Math.max(0, best.ai - shift);
  let e = Math.min(na - 1, best.ai + best.len - 1 - shift);
  const maxExtend = Math.round(REFINE_MAX_SECONDS / FP_HOP_SECONDS);
  const maxMiss = Math.round(REFINE_MISS_SECONDS / FP_HOP_SECONDS);
  const extend = (from: number, dir: 1 | -1) => {
    let edge = from;
    let miss = 0;
    for (let step = 1; step <= maxExtend; step++) {
      const i = from + dir * step;
      if (i < 0 || i >= na || i + d < 0 || i + d >= nb) break;
      if (match(i)) {
        edge = i;
        miss = 0;
      } else if (++miss > maxMiss) break;
    }
    return edge;
  };
  s = extend(s, -1);
  e = extend(e, 1);
  while (s < e && !match(s)) s++;
  while (e > s && !match(e)) e--;
  return { ai: s, bj: s + d, len: e - s + 1 };
}

function toSegment(best: Best, p: ScanParams, a: Float32Array, b: Float32Array): CommonSegment | null {
  if (!best) return null;
  const r = refine(a, b, best, p);
  return {
    aStart: round1(r.ai * FP_HOP_SECONDS),
    bStart: round1(r.bj * FP_HOP_SECONDS),
    // 帧有长度：最后一帧覆盖到它开始后的一个窗口，按帧间隔算再补半帧
    seconds: round1((r.len + 0.5) * FP_HOP_SECONDS),
    score: Math.round(best.score * 100) / 100,
  };
}

/**
 * 两段音频里最长的共有片段：逐个偏移量沿对角线比较，相似度先按 1 秒滑动平均，
 * 再找高于阈值的最长连续段（允许短暂空隙）。6 分钟对 6 分钟约半秒。
 */
export function findCommonSegment(a: Float32Array, b: Float32Array, opts: MatchOptions = {}): CommonSegment | null {
  const p = scanParams(opts);
  const sims = new Float32Array(Math.min(frameCount(a), frameCount(b)));
  return toSegment(scanOffsets(a, b, -(frameCount(a) - 1), frameCount(b) - 1, p, null, sims), p, a, b);
}

/** 同上，但分批算、每批之间让出主线程（手机上算一两秒也不卡界面）；signal 中止时返回 null */
export async function findCommonSegmentAsync(
  a: Float32Array,
  b: Float32Array,
  opts: MatchOptions = {},
  signal?: AbortSignal,
): Promise<CommonSegment | null> {
  const p = scanParams(opts);
  const sims = new Float32Array(Math.min(frameCount(a), frameCount(b)));
  const from = -(frameCount(a) - 1);
  const to = frameCount(b) - 1;
  let best: Best = null;
  for (let d = from; d <= to; d += 150) {
    if (signal?.aborted) return null;
    best = scanOffsets(a, b, d, Math.min(to, d + 149), p, best, sims);
    await new Promise((r) => setTimeout(r, 0));
  }
  return toSegment(best, p, a, b);
}

function pickBetter(
  best: Best,
  ai: number,
  bj: number,
  len: number,
  score: number,
  minFrames: number,
) {
  if (len < minFrames) return best;
  if (!best || len > best.len) return { ai, bj, len, score };
  return best;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** 片头曲开头这么多秒存成模板（以后每集只拿它比对，不用再下载别的集） */
export const TEMPLATE_SECONDS = 30;

/** 特征量化成 1 字节一维，存起来小（30 秒约 5KB） */
export function encodeTemplate(fp: Float32Array, fromSec: number, seconds = TEMPLATE_SECONDS): string {
  const start = Math.max(0, Math.round(fromSec / FP_HOP_SECONDS));
  const frames = Math.min(frameCount(fp) - start, Math.round(seconds / FP_HOP_SECONDS));
  const bytes = new Uint8Array(Math.max(0, frames) * FP_DIMS);
  for (let k = 0; k < bytes.length; k++) {
    bytes[k] = Math.max(0, Math.min(255, Math.round(fp[start * FP_DIMS + k] * 127 + 128)));
  }
  let bin = '';
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin);
}

export function decodeTemplate(text: string): Float32Array {
  const bin = atob(text);
  const out = new Float32Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = (bin.charCodeAt(k) - 128) / 127;
  return out;
}
