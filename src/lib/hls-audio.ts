import { FP_RATE } from './audio-fingerprint';
import { makeAbsolute, stripAdGroups } from './m3u8';
import { bestVariant, parseMasterPlaylist } from './stream-quality';
import { demuxTsAudio, type AudioCodec } from './ts-demux';

/**
 * 从 HLS 片源里取一段时间的音频（单声道、FP_RATE 采样），给声音比对用。不播放、不出声。
 * 时间轴和播放器一致：开了去广告就先按同一套规则剔除广告分片，再从 0 开始累加 EXTINF。
 * 取数据、解密、解码都可替换，方便测试。
 */

export interface HlsSegment {
  uri: string;
  start: number;
  duration: number;
  key?: { uri: string; iv: Uint8Array };
}

export interface HlsAudioDeps {
  /** 返回内容和实际取到的地址（走了代理时是代理地址，相对路径要以它为基准） */
  fetchText: (url: string, signal?: AbortSignal) => Promise<{ text: string; url: string }>;
  fetchBytes: (url: string, signal?: AbortSignal) => Promise<Uint8Array>;
  /** 音频帧（ADTS / MP3）→ 单声道 PCM（FP_RATE） */
  decode: (data: Uint8Array, codec: AudioCodec) => Promise<Float32Array>;
}

function ivFromSequence(seq: number): Uint8Array {
  const iv = new Uint8Array(16);
  new DataView(iv.buffer).setUint32(12, seq);
  return iv;
}

function parseIv(hex: string): Uint8Array | undefined {
  const h = hex.replace(/^0x/i, '');
  if (!/^[0-9a-f]{1,32}$/i.test(h)) return undefined;
  const padded = h.padStart(32, '0');
  return Uint8Array.from(padded.match(/../g)!.map((b) => parseInt(b, 16)));
}

/**
 * 解析媒体播放列表的分片（含 AES-128 密钥和起止时间）。fMP4（EXT-X-MAP）暂不支持，返回 null；
 * 其他加密方式（SAMPLE-AES 等）也返回 null。
 */
export function parseMediaSegments(content: string, baseUrl: string, adFilter: boolean): HlsSegment[] | null {
  const text = adFilter ? stripAdGroups(content) : content;
  const lines = text.split('\n').map((l) => l.trim());
  if (lines.some((l) => l.startsWith('#EXT-X-MAP'))) return null;
  let seq = 0;
  let key: { uri: string; iv?: Uint8Array } | undefined;
  let pending = 0;
  let t = 0;
  const out: HlsSegment[] = [];
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = parseInt(line.split(':')[1], 10) || 0;
    else if (line.startsWith('#EXT-X-KEY')) {
      const method = line.match(/METHOD=([A-Z0-9-]+)/)?.[1];
      if (method === 'NONE') key = undefined;
      else if (method === 'AES-128') {
        const uri = line.match(/URI="([^"]+)"/)?.[1];
        if (!uri) return null;
        const ivRaw = line.match(/IV=(0x[0-9a-fA-F]+)/)?.[1];
        key = { uri: makeAbsolute(uri, baseUrl), iv: ivRaw ? parseIv(ivRaw) : undefined };
      } else return null;
    } else if (line.startsWith('#EXTINF:')) pending = parseFloat(line.slice(8)) || 0;
    else if (line && !line.startsWith('#')) {
      out.push({
        uri: makeAbsolute(line, baseUrl),
        start: t,
        duration: pending,
        ...(key ? { key: { uri: key.uri, iv: key.iv ?? ivFromSequence(seq) } } : {}),
      });
      t += pending;
      pending = 0;
      seq += 1;
    }
  }
  return out;
}

/** 片源地址 → 媒体播放列表的分片（主播放列表挑码率最低的一档：音频都一样，下载最少） */
export async function loadSegments(url: string, adFilter: boolean, deps: HlsAudioDeps, signal?: AbortSignal): Promise<HlsSegment[] | null> {
  let res = await deps.fetchText(url, signal);
  const variants = parseMasterPlaylist(res.text);
  if (variants.length > 0) {
    const lowest = [...variants].sort((a, b) => (a.bandwidth || a.height) - (b.bandwidth || b.height))[0] ?? bestVariant(variants)!;
    res = await deps.fetchText(makeAbsolute(lowest.uri, res.url), signal);
  }
  return parseMediaSegments(res.text, res.url, adFilter);
}

async function decrypt(data: Uint8Array, keyBytes: Uint8Array, iv: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', keyBytes as BufferSource, { name: 'AES-CBC' }, false, ['decrypt']);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, key, data as BufferSource));
}

/**
 * 取 [from, to) 秒的音频，按分片在时间轴上的位置摆好（分片解码出来长一点短一点都按 EXTINF 裁齐）。
 * 返回的 PCM 第 0 个采样对应 from 秒。拿不到的分片留静音。
 */
export async function extractAudio(
  segments: HlsSegment[],
  from: number,
  to: number,
  deps: HlsAudioDeps,
  signal?: AbortSignal,
): Promise<Float32Array> {
  const total = Math.max(0, Math.round((to - from) * FP_RATE));
  const out = new Float32Array(total);
  const keys = new Map<string, Promise<Uint8Array>>();
  const wanted = segments.filter((seg) => seg.start + seg.duration > from && seg.start < to);
  const one = async (seg: HlsSegment) => {
    try {
      let data = await deps.fetchBytes(seg.uri, signal);
      if (seg.key) {
        if (!keys.has(seg.key.uri)) keys.set(seg.key.uri, deps.fetchBytes(seg.key.uri, signal));
        data = await decrypt(data, await keys.get(seg.key.uri)!, seg.key.iv);
      }
      const audio = demuxTsAudio(data);
      if (!audio) return;
      const pcm = await deps.decode(audio.data, audio.codec);
      const segLen = Math.round(seg.duration * FP_RATE);
      // 分片在输出里的位置；分片开头早于 from 时跳过前面那部分
      const dst = Math.round((seg.start - from) * FP_RATE);
      const skip = Math.max(0, -dst);
      const count = Math.min(pcm.length, segLen) - skip;
      if (count > 0) out.set(pcm.subarray(skip, skip + Math.min(count, total - Math.max(0, dst))), Math.max(0, dst));
    } catch {
      // 这个分片拿不到：留静音，比对时自然不算
    }
  };
  // 同时取几个分片（串行一个个等太慢）
  let next = 0;
  const worker = async () => {
    while (next < wanted.length && !signal?.aborted) await one(wanted[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(EXTRACT_CONCURRENCY, wanted.length) }, worker));
  return out;
}

/** 同时下载 / 解码几个分片 */
const EXTRACT_CONCURRENCY = 6;

export function playlistDuration(segments: HlsSegment[]): number {
  const last = segments[segments.length - 1];
  return last ? last.start + last.duration : 0;
}
