import { FP_RATE } from './audio-fingerprint';
import type { HlsAudioDeps } from './hls-audio';
import { buildSegmentCacheKey, readCachedSegment } from './video-cache';

/**
 * 浏览器里取数据和解码：
 * - 分片先看本地缓存（预加载下过的就不再下载），没有再直连，直连失败（跨域 / 防盗链）走本站代理；
 * - 解码用 OfflineAudioContext（Chrome / Edge / Safari / Firefox 都能解 AAC 和 MP3），22050Hz 解出来再对半降采样。
 */

const proxied = (url: string) => `${location.origin}/api/proxy?url=${encodeURIComponent(url)}`;

async function get(url: string, signal?: AbortSignal): Promise<{ res: Response; url: string }> {
  try {
    const res = await fetch(url, { signal });
    if (res.ok) return { res, url };
  } catch (err) {
    if (signal?.aborted) throw err;
  }
  if (url.startsWith(location.origin)) throw new Error('请求失败');
  const viaProxy = proxied(url);
  const res = await fetch(viaProxy, { signal, credentials: 'same-origin' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { res, url: viaProxy };
}

const DECODE_RATE = 22050;

async function decode(data: Uint8Array): Promise<Float32Array> {
  const ctx = new OfflineAudioContext(1, 1, DECODE_RATE);
  const buf = await ctx.decodeAudioData(data.slice().buffer);
  const n = buf.length;
  const mono = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) mono[i] += ch[i] / buf.numberOfChannels;
  }
  // 降到 FP_RATE（线性取样；个别浏览器不按要求的采样率解码时也对得上）
  const ratio = buf.sampleRate / FP_RATE;
  const out = new Float32Array(Math.floor(n / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const k = Math.floor(x);
    const f = x - k;
    out[i] = mono[k] * (1 - f) + (mono[k + 1] ?? mono[k]) * f;
  }
  return out;
}

export function browserAudioDeps(): HlsAudioDeps {
  return {
    fetchText: async (url, signal) => {
      const { res, url: finalUrl } = await get(url, signal);
      return { text: await res.text(), url: finalUrl };
    },
    fetchBytes: async (url, signal) => {
      const cached = await readCachedSegment(buildSegmentCacheKey(url));
      if (cached) return new Uint8Array(cached.data);
      const { res } = await get(url, signal);
      return new Uint8Array(await res.arrayBuffer());
    },
    decode: (data) => decode(data),
  };
}
