import { describe, expect, it } from 'vitest';
import { analyzeMediaPlaylist, bestVariant, heightFromKbps, parseMasterPlaylist, qualityLabel, qualityTier } from './stream-quality';

describe('片源质检', () => {
  it('主播放列表挑最高一档', () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480',
      '480/index.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080',
      '1080/index.m3u8',
    ].join('\n');
    const variants = parseMasterPlaylist(master);
    expect(variants).toHaveLength(2);
    expect(bestVariant(variants)?.uri).toBe('1080/index.m3u8');
    expect(parseMasterPlaylist('#EXTM3U\n#EXTINF:10,\na.ts')).toEqual([]);
  });

  it('数出 URL 带广告特征的插入段', () => {
    const lines = ['#EXTM3U'];
    for (let i = 0; i < 30; i++) lines.push('#EXTINF:10,', `main${i}.ts`);
    lines.push('#EXT-X-DISCONTINUITY', '#EXTINF:5,', '/video/adjump/a1.ts', '#EXTINF:5,', '/video/adjump/a2.ts');
    lines.push('#EXT-X-DISCONTINUITY');
    for (let i = 30; i < 60; i++) lines.push('#EXTINF:10,', `main${i}.ts`);
    const info = analyzeMediaPlaylist(lines.join('\n'));
    expect(info.adSeconds).toBe(10);
    expect(info.seconds).toBe(600);
    expect(info.sampleSegment?.uri).toMatch(/^main/);
  });

  it('码率估分辨率、标签与档位', () => {
    expect(heightFromKbps(3200)).toBe(1080);
    expect(heightFromKbps(1500)).toBe(720);
    expect(qualityLabel(1080)).toBe('1080P');
    expect(qualityTier({ key: 'a', ok: true, height: 1080 })).toBe(3);
    expect(qualityTier({ key: 'a', ok: false })).toBe(0);
    expect(qualityTier(undefined)).toBe(1);
  });
});
