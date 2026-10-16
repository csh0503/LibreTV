import { stripAdGroups } from './m3u8';

/**
 * 片源质检的纯计算部分：读 m3u8 判断清晰度、数广告。
 * - 清晰度：主播放列表写了 RESOLUTION 就用它；没写就由服务端量一个分片的大小，按码率估算；
 * - 广告：用播放时同一套去广告规则（stripAdGroups）跑一遍，被剔掉的秒数就是能识别的插入广告。
 *   压在画面里的水印 / 口播广告不在播放列表里，这里测不出来。
 */

export interface StreamVariant {
  uri: string;
  bandwidth: number;
  height: number;
}

/** 主播放列表（#EXT-X-STREAM-INF）里的各档清晰度；不是主播放列表返回空数组 */
export function parseMasterPlaylist(content: string): StreamVariant[] {
  const lines = content.split('\n').map((l) => l.trim());
  const out: StreamVariant[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const attrs = lines[i];
    const bandwidth = parseInt(attrs.match(/BANDWIDTH=(\d+)/)?.[1] ?? '0', 10);
    const height = parseInt(attrs.match(/RESOLUTION=\d+x(\d+)/)?.[1] ?? '0', 10);
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (uri) out.push({ uri, bandwidth, height });
  }
  return out;
}

/** 挑最高的一档：先比分辨率，再比码率 */
export function bestVariant(variants: StreamVariant[]): StreamVariant | undefined {
  return [...variants].sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth)[0];
}

export interface MediaPlaylistInfo {
  /** 正片总时长（秒，已扣除识别出的广告） */
  seconds: number;
  segments: number;
  /** 识别出、播放时会自动跳过的广告秒数 */
  adSeconds: number;
  /** 拿来量码率的分片（取中间的，避开片头片尾） */
  sampleSegment?: { uri: string; seconds: number };
}

function sumDuration(content: string): { seconds: number; segments: { uri: string; seconds: number }[] } {
  const lines = content.split('\n').map((l) => l.trim());
  const segments: { uri: string; seconds: number }[] = [];
  let pending = 0;
  for (const line of lines) {
    const m = line.match(/^#EXTINF:([\d.]+)/);
    if (m) {
      pending = parseFloat(m[1]) || 0;
      continue;
    }
    if (line && !line.startsWith('#')) {
      segments.push({ uri: line, seconds: pending });
      pending = 0;
    }
  }
  return { seconds: segments.reduce((s, x) => s + x.seconds, 0), segments };
}

export function analyzeMediaPlaylist(content: string): MediaPlaylistInfo {
  const original = sumDuration(content);
  const cleaned = sumDuration(stripAdGroups(content));
  const segs = cleaned.segments;
  const mid = segs[Math.floor(segs.length / 2)];
  return {
    seconds: Math.round(cleaned.seconds),
    segments: segs.length,
    adSeconds: Math.max(0, Math.round(original.seconds - cleaned.seconds)),
    sampleSegment: mid && mid.seconds > 0 ? mid : undefined,
  };
}

/**
 * 没写分辨率时按码率估（H.264 采集站常见码率）：≥2.5 Mbps 多是 1080P，≥1.2 Mbps 多是 720P。
 * 只是估计，界面上显示为「约」。
 */
export function heightFromKbps(kbps: number): number {
  if (kbps >= 2500) return 1080;
  if (kbps >= 1200) return 720;
  if (kbps >= 600) return 480;
  return kbps > 0 ? 360 : 0;
}

export function qualityLabel(height: number): string {
  if (height >= 2000) return '4K';
  if (height >= 1000) return '1080P';
  if (height >= 700) return '720P';
  if (height >= 450) return '480P';
  return height > 0 ? '标清' : '';
}

/** 质检结果（服务端 → 前端） */
export interface SourceQuality {
  key: string;
  ok: boolean;
  /** 分辨率高度；estimated = 由码率估算 */
  height?: number;
  estimated?: boolean;
  kbps?: number;
  adSeconds?: number;
  /** 第 1 集正片时长（分钟） */
  minutes?: number;
  error?: string;
}

/** 排序用的清晰度档位：3=1080P 及以上，2=720P，1=更低或测不出，0=质检失败 */
export function qualityTier(q?: SourceQuality): number {
  if (!q) return 1;
  if (!q.ok) return 0;
  const h = q.height ?? 0;
  if (h >= 1000) return 3;
  if (h >= 700) return 2;
  return 1;
}
