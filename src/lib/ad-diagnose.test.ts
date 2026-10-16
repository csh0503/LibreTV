import { describe, expect, it } from 'vitest';
import { diagnosePlaylist, formatDiagnosis, nameClass } from './ad-diagnose';

describe('广告诊断', () => {
  it('nameClass：序号名归一，随机名只看长度', () => {
    expect(nameClass('https://a/b/0001.ts')).toBe('#.ts');
    expect(nameClass('plist12.ts')).toBe('plist#.ts');
    expect(nameClass('Xae1WLMH.ts')).toBe('[8].ts');
    expect(nameClass('cMU0Wo5d.ts?x=1')).toBe('[8].ts');
  });

  it('按段和网站 / 路径切组，标出被剔除的', () => {
    const seg = (u: string, d = 4) => `#EXTINF:${d},\n${u}`;
    const main = (from: number, n: number) => Array.from({ length: n }, (_, i) => seg(`https://cdn.a/v/hls/${'abcdefgh'.slice(0, 0)}${String(from + i).padStart(4, '0')}.ts`)).join('\n');
    const pl = ['#EXTM3U', main(0, 40), '#EXT-X-DISCONTINUITY', seg('https://ads.b/x/ad1.ts', 5), seg('https://ads.b/x/ad2.ts', 5), '#EXT-X-DISCONTINUITY', main(40, 40)].join('\n');
    const d = diagnosePlaylist(pl, 'https://cdn.a/v/hls/index.m3u8');
    expect(d.runs.map((r) => [r.start, r.seconds, r.host, r.stripped])).toEqual([
      [0, 160, 'cdn.a', false],
      [160, 10, 'ads.b', true],
      [170, 160, 'cdn.a', false],
    ]);
    expect(formatDiagnosis(d, '测试')).toContain('✂ 2:40–2:50 (10.0s, 2片 5.0s) 段1 ads.b …/x/ ad#.ts');
    expect(d.removed).toHaveLength(1);
    expect(d.removed[0]).toMatchObject({ start: 160, seconds: 10 });
    expect(d.removed[0].playlist).toBe(
      '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:5\n#EXT-X-MEDIA-SEQUENCE:40\n#EXTINF:5,\nhttps://ads.b/x/ad1.ts\n#EXTINF:5,\nhttps://ads.b/x/ad2.ts\n#EXT-X-ENDLIST',
    );
  });

  it('加密的被去掉片段：预览播放列表带上绝对地址的密钥', () => {
    const ad = ['#EXTINF:2,', 'x0.ts', '#EXTINF:2,', 'x1.ts'];
    const content = (k: number) => Array.from({ length: 30 }, (_, i) => `#EXTINF:2,\nc${k}_${i}.ts`);
    const pl = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="key.key"', ...content(0), '#EXT-X-DISCONTINUITY', ...ad, '#EXT-X-DISCONTINUITY', ...content(1), '#EXT-X-DISCONTINUITY', ...ad].join('\n');
    // 同一段 x0/x1 出现两次 → 被「重复片段」规则去掉
    const d = diagnosePlaylist(pl, 'https://v.test/hls/index.m3u8');
    expect(d.removed.map((r) => r.start)).toEqual([60, 124]);
    const first = d.removed[0];
    expect(first.playlist).toContain('#EXT-X-KEY:METHOD=AES-128,URI="https://v.test/hls/key.key"');
    expect(first.playlist).toContain('#EXT-X-MEDIA-SEQUENCE:30');
    expect(first.playlist).toContain('https://v.test/hls/x0.ts');
  });
});
