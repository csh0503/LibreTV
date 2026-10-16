import { describe, expect, it } from 'vitest';
import { analyzeMediaPlaylist, bestVariant, filenameShape, suspectAdSeconds, heightFromKbps, parseMasterPlaylist, qualityLabel, qualityTier } from './stream-quality';

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

describe('新规则：网站 / 文件名和正片不同的短分组', () => {
  const main = (from: number, to: number) => {
    const out: string[] = [];
    for (let i = from; i < to; i++) out.push('#EXTINF:10,', `https://cdn.main.com/v/${String(i).padStart(4, '0')}.ts`);
    return out;
  };

  it('换了网站的短分组算疑似广告', () => {
    const m3u8 = ['#EXTM3U', ...main(0, 20), '#EXT-X-DISCONTINUITY', '#EXTINF:8,', 'https://ad.other.net/x/9f8e7d6c.ts', '#EXTINF:7,', 'https://ad.other.net/x/1a2b3c4d.ts', '#EXT-X-DISCONTINUITY', ...main(20, 40)].join('\n');
    expect(suspectAdSeconds(m3u8)).toBe(15);
  });

  it('同网站但文件名样式完全不同也算', () => {
    const m3u8 = ['#EXTM3U', ...main(0, 20), '#EXT-X-DISCONTINUITY', '#EXTINF:10,', 'https://cdn.main.com/v/ad-promo.ts', '#EXT-X-DISCONTINUITY', ...main(20, 40)].join('\n');
    expect(filenameShape('https://cdn.main.com/v/0001.ts')).toBe('0.a');
    expect(suspectAdSeconds(m3u8)).toBe(10);
  });

  it('正片本身混着多个网站时不判断；长分组不算', () => {
    const mixed: string[] = ['#EXTM3U'];
    for (let i = 0; i < 20; i++) mixed.push('#EXTINF:10,', `https://cdn${i % 3}.x.com/${i}.ts`, '#EXT-X-DISCONTINUITY');
    expect(suspectAdSeconds(mixed.join('\n'))).toBe(0);
    const long = ['#EXTM3U', ...main(0, 20), '#EXT-X-DISCONTINUITY'];
    for (let i = 0; i < 15; i++) long.push('#EXTINF:10,', `https://other.net/${i}.ts`);
    expect(suspectAdSeconds(long.join('\n'))).toBe(0);
  });
});
