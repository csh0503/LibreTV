import { makeAbsolute } from './m3u8';
import { analyzeMediaPlaylist, bestVariant, heightFromKbps, parseMasterPlaylist, type SourceQuality } from './stream-quality';

/**
 * 拿到第 1 集的播放地址之后的质检步骤（在浏览器里跑，取数据的方式由调用方给）：
 * 读播放列表 → 主播放列表就挑最高一档 → 数广告 → 量一个分片估码率。
 */
export interface ProbeFetchers {
  text: (url: string) => Promise<string>;
  /** 分片字节数；量不到返回 0 */
  segmentBytes: (url: string) => Promise<number>;
}

export async function probeEpisode(firstUrl: string, f: ProbeFetchers): Promise<Omit<SourceQuality, 'key'>> {
  if (!/\.m3u8(\?|$)/i.test(firstUrl)) return { ok: true, error: '不是 m3u8，测不了' };
  let playlistUrl = firstUrl;
  let content = await f.text(playlistUrl);
  // 读到的不是播放列表（被挡时常常返回网页 / JSON）：算测不了，别当成「没有广告」
  if (!content.trimStart().startsWith('#EXTM3U')) throw new Error('不是播放列表');
  let height = 0;
  const variants = parseMasterPlaylist(content);
  if (variants.length > 0) {
    const best = bestVariant(variants)!;
    height = best.height;
    playlistUrl = makeAbsolute(best.uri, playlistUrl);
    content = await f.text(playlistUrl);
    if (!content.trimStart().startsWith('#EXTM3U')) throw new Error('不是播放列表');
  }
  const info = analyzeMediaPlaylist(content, playlistUrl);
  let kbps = 0;
  if (info.sampleSegment) {
    const bytes = await f.segmentBytes(makeAbsolute(info.sampleSegment.uri, playlistUrl));
    if (bytes > 0) kbps = Math.round((bytes * 8) / info.sampleSegment.seconds / 1000);
  }
  return {
    ok: true,
    height: height || heightFromKbps(kbps) || undefined,
    estimated: (height === 0 && kbps > 0) || undefined,
    kbps: kbps || undefined,
    adSeconds: info.adSeconds,
    suspectSeconds: info.suspectSeconds || undefined,
    minutes: info.seconds > 0 ? Math.round(info.seconds / 60) : undefined,
  };
}
