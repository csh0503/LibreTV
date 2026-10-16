import { describe, expect, it, vi } from 'vitest';
import { parseM3u8Playlist } from './m3u8-parse';
import { isProxiedUri, rewriteM3u8, stripAdGroups, stripLeadAdGroup, unproxyM3u8 } from './m3u8';

const BASE = 'https://cdn.example.com/live/index.m3u8';

describe('rewriteM3u8', () => {
  it('把分片、嵌套播放列表、key、map 全部改写为代理地址（查询串形式）', () => {
    const input = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=1280000',
      'https://cdn.example.com/live/720p.m3u8',
      '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/key.bin",IV=0x1',
      '#EXT-X-MAP:URI="init.mp4"',
      '/relative/seg1.ts',
      'seg2.ts',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const out = rewriteM3u8(input, BASE);

    expect(out).toContain('/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/live/720p.m3u8'));
    expect(out).toContain('/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/key.bin'));
    expect(out).toContain('/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/live/init.mp4'));
    expect(out).toContain('/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/relative/seg1.ts'));
    expect(out).toContain('/api/proxy?url=' + encodeURIComponent('https://cdn.example.com/live/seg2.ts'));
    // 非地址行保持不变
    expect(out).toContain('#EXTM3U');
    expect(out).toContain('#EXT-X-ENDLIST');
  });

  it('直播前缀改写为 /api/live/stream?url= 形式', () => {
    const out = rewriteM3u8('https://cdn.example.com/live/seg1.ts', BASE, 0, '/api/live/stream?url=');
    expect(out).toBe('/api/live/stream?url=' + encodeURIComponent('https://cdn.example.com/live/seg1.ts'));
  });

  it('已是代理地址的行（新旧两种形式）不重复改写', () => {
    const legacy = '/api/proxy/' + encodeURIComponent('https://x.com/a.ts');
    expect(rewriteM3u8(legacy, BASE)).toBe(legacy);
    const modern = '/api/proxy?url=' + encodeURIComponent('https://x.com/a.ts');
    expect(rewriteM3u8(modern, BASE)).toBe(modern);
    const legacyLive = '/api/live/stream/' + encodeURIComponent('https://x.com/live.m3u8');
    expect(rewriteM3u8(legacyLive, BASE, 0, '/api/live/stream?url=')).toBe(legacyLive);
  });

  it('超过递归深度限制时原样返回', () => {
    const input = 'https://a.ts';
    expect(rewriteM3u8(input, BASE, 6)).toBe(input);
  });
});

describe('isProxiedUri', () => {
  it('新旧两种代理形式均识别', () => {
    expect(isProxiedUri('/api/proxy/' + encodeURIComponent('https://x.com/a.ts'))).toBe(true);
    expect(isProxiedUri('/api/proxy?url=' + encodeURIComponent('https://x.com/a.ts'))).toBe(true);
    expect(isProxiedUri('/api/live/stream?url=' + encodeURIComponent('https://x.com/live.m3u8'))).toBe(true);
    expect(isProxiedUri('https://cdn.example.com/seg1.ts')).toBe(false);
    expect(isProxiedUri('/relative/seg1.ts')).toBe(false);
  });
});

/** 按 dytt 实测结构造播放列表：片头广告段（首个 DISCONTINUITY 段）+ 若干正片段 */
function dyttLike(adCount: number, adDur = 4): string {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:8', '#EXT-X-DISCONTINUITY'];
  for (let i = 0; i < adCount; i++) lines.push(`#EXTINF:${adDur},`, `ad${i}.ts`);
  lines.push('#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'movie0.ts');
  lines.push('#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'movie1.ts', '#EXT-X-ENDLIST');
  return lines.join('\n');
}

describe('stripLeadAdGroup', () => {

  it('dytt 结构：整段剔除片头广告分片，正片与后续 DISCONTINUITY 保留', () => {
    const out = stripLeadAdGroup(dyttLike(3));
    expect(out).not.toContain('ad0.ts');
    expect(out).not.toContain('ad2.ts');
    expect(out).toContain('movie0.ts');
    expect(out).toContain('movie1.ts');
    // 正片段之间的 DISCONTINUITY 必须保留（删标记会破坏时间轴，见 dytt 实测）
    expect(out.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1);
    // 正片前导的 DISCONTINUITY（无前文，失去意义）被清掉
    const firstSeg = out.indexOf('movie0.ts');
    expect(out.slice(0, firstSeg)).not.toContain('#EXT-X-DISCONTINUITY');
  });

  it('段时长超过 90s / 分片数超过 20 时不动', () => {
    expect(stripLeadAdGroup(dyttLike(30))).toBe(dyttLike(30)); // 120s
    expect(stripLeadAdGroup(dyttLike(21, 1))).toBe(dyttLike(21, 1)); // 21 片
  });

  it('首个分片之前没有 DISCONTINUITY 时不动', () => {
    const input = ['#EXTM3U', '#EXTINF:4,', 'a.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'b.ts'].join('\n');
    expect(stripLeadAdGroup(input)).toBe(input);
  });

  it('片头段之后没有更多分段时不动（无法与正片区分）', () => {
    const input = ['#EXTM3U', '#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'a.ts', '#EXTINF:4,', 'b.ts', '#EXT-X-ENDLIST'].join('\n');
    expect(stripLeadAdGroup(input)).toBe(input);
  });

  it('段内 KEY/MAP 保留（正片可能复用解密配置）', () => {
    const lines = dyttLike(2).split('\n');
    lines.splice(2, 0, '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"', '#EXT-X-MAP:URI="init.mp4"');
    const out = stripLeadAdGroup(lines.join('\n'));
    expect(out).toContain('#EXT-X-KEY:METHOD=AES-128,URI="key.bin"');
    expect(out).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(out).not.toContain('ad0.ts');
  });

  it('空内容返回空串', () => {
    expect(stripLeadAdGroup('')).toBe('');
  });

  it('周期性 DISCONTINUITY 封装（每 N 片一个标记）：不误杀片头正常分组', () => {
    // 模拟 rycjapi 类源：多分组、每组 5 片、相邻 DISCONTINUITY 间隙均匀（非广告）
    const lines = ['#EXTM3U', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-VERSION:3'];
    const groups = 12;
    for (let g = 0; g < groups; g++) {
      lines.push('#EXT-X-DISCONTINUITY');
      for (let s = 0; s < 5; s++) lines.push('#EXTINF:6,', `g${g}_s${s}.ts`);
    }
    lines.push('#EXT-X-ENDLIST');
    const input = lines.join('\n');
    const out = stripLeadAdGroup(input);
    // 片头第一组（g0_s0.ts）必须保留，整体原样返回
    expect(out).toBe(input);
    expect(out).toContain('g0_s0.ts');
  });

  it('dytt 多分组封装（间隙不均但片头组与其余组同构）：不误杀片头', () => {
    // 按 dytt 第1249集实测结构：64 组，多为 5 片，偶有 10/15/20 片长组
    const sizes = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 10, 5, 4, 3, 2, 5, 5, 5, 5, 10, 5, 5, 5, 5, 5,
      15, 5, 15, 5, 5, 5, 5, 5, 10, 5, 5, 5, 5, 5, 5, 5, 5, 5, 20, 5, 15, 5, 5, 5, 5, 5, 5, 5, 5,
      5, 5, 10, 5, 5, 5, 10, 2, 2];
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:8'];
    sizes.forEach((n, g) => {
      lines.push('#EXT-X-DISCONTINUITY');
      for (let s = 0; s < n; s++) lines.push('#EXTINF:4.3,', `g${g}_s${s}.ts`);
    });
    lines.push('#EXT-X-ENDLIST');
    const input = lines.join('\n');
    const out = stripLeadAdGroup(input);
    expect(out).toBe(input);
    expect(out).toContain('g0_s0.ts');
  });

  it('多分组但片头组明显异于其余组（疑似真插入段）：照常剔除', () => {
    // 12 组其余均为 5 片，片头组 12 片（54s）——大小显著偏离，视为片头插入段
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:8', '#EXT-X-DISCONTINUITY'];
    for (let s = 0; s < 12; s++) lines.push('#EXTINF:4.5,', `ad${s}.ts`);
    for (let g = 0; g < 12; g++) {
      lines.push('#EXT-X-DISCONTINUITY');
      for (let s = 0; s < 5; s++) lines.push('#EXTINF:4.5,', `g${g}_s${s}.ts`);
    }
    lines.push('#EXT-X-ENDLIST');
    const out = stripLeadAdGroup(lines.join('\n'));
    expect(out).not.toContain('ad0.ts');
    expect(out).toContain('g0_s0.ts');
  });
});

describe('stripAdGroups', () => {
  /** 按暴风源实测结构造播放列表：正片(顺序 1s 分片) + adjump 中插广告段 + 正片 */
  function konanLike(): string {
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:3'];
    for (let i = 0; i < 312; i++) lines.push('#EXTINF:1,', `${String(i).padStart(7, '0')}.ts`);
    lines.push('#EXT-X-DISCONTINUITY');
    for (let i = 0; i < 3; i++) lines.push('#EXTINF:3,', `/video/adjump/time/1787320001790000000${i}.ts`);
    lines.push('#EXT-X-DISCONTINUITY', '#EXTINF:1,', '0000312.ts', '#EXT-X-ENDLIST');
    return lines.join('\n');
  }

  it('柯南实测结构：剔除 adjump 中插段，正片完整且只保留一个分段边界', () => {
    const out = stripAdGroups(konanLike());
    expect(out).not.toContain('adjump');
    expect(out).toContain('0000311.ts');
    expect(out).toContain('0000312.ts');
    // 段前的 DISCONTINUITY 随段删除、段后的保留为正片分段边界 → 不出现双标记
    expect(out.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(1);
  });

  it('段内混入正片分片时整段放过（全部分片命中特征才剔除）', () => {
    const lines = [
      '#EXTM3U',
      '#EXTINF:1,',
      'a.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:3,',
      '/video/adjump/time/x0.ts',
      '#EXTINF:1,',
      'real.ts',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:1,',
      'b.ts',
    ].join('\n');
    expect(stripAdGroups(lines)).toBe(lines);
  });

  it('组合：URL 无特征的片头插入段仍由片头启发式兜底剔除', () => {
    const out = stripAdGroups(dyttLike(3));
    expect(out).not.toContain('ad0.ts');
    expect(out).toContain('movie0.ts');
  });
});

describe('stripAdGroups · 长片间超短中插（phimgood 结构）', () => {
  /** 生成一组总时长 dur 的分片行 */
  function group(dur: number, name: string, parts = 4): string[] {
    const lines: string[] = [];
    const each = dur / parts;
    for (let i = 0; i < parts; i++) lines.push(`#EXTINF:${each.toFixed(3)},`, `${name}${i}.ts`);
    return lines;
  }

  /** 长正片段之间夹短广告段（按 phimgood 实测比例构造） */
  function phimgoodLike(): string {
    return [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:8',
      '#EXT-X-DISCONTINUITY',
      ...group(298, 'a'),
      '#EXT-X-DISCONTINUITY',
      ...group(19, 'ad1', 3),
      '#EXT-X-DISCONTINUITY',
      ...group(200, 'b'),
      '#EXT-X-DISCONTINUITY',
      ...group(16, 'ad2', 3),
      '#EXT-X-DISCONTINUITY',
      ...group(150, 'c'),
      '#EXT-X-ENDLIST',
    ].join('\n');
  }

  it('两长夹一短：超短中插段剔除，长正片段与分段边界保留', () => {
    const out = stripAdGroups(phimgoodLike());
    expect(out).not.toContain('ad10.ts');
    expect(out).not.toContain('ad20.ts');
    expect(out).toContain('a0.ts');
    expect(out).toContain('b0.ts');
    expect(out).toContain('c0.ts');
    // 4 个边界 DISCONTINUITY 删掉 2 个（各随广告段删除），剩 2 个
    expect(out.match(/#EXT-X-DISCONTINUITY/g)).toHaveLength(2);
  });

  it('dytt 式全短段结构不触发（邻段不满足长段条件）', () => {
    // 首组分片直接开始（无片头 DISCONTINUITY），避开片头启发式，纯测中插规则
    const short = [
      '#EXTM3U',
      ...group(40, 'a'),
      '#EXT-X-DISCONTINUITY',
      ...group(24, 'mid'),
      '#EXT-X-DISCONTINUITY',
      ...group(24, 'b'),
      '#EXT-X-ENDLIST',
    ].join('\n');
    expect(stripAdGroups(short)).toBe(short);
  });

  it('末组短段（无后邻）保守放过', () => {
    const lines = [
      '#EXTM3U',
      ...group(300, 'a'),
      '#EXT-X-DISCONTINUITY',
      ...group(20, 'tail'),
      '#EXT-X-ENDLIST',
    ].join('\n');
    expect(stripAdGroups(lines)).toBe(lines);
  });
});

describe('parseM3u8Playlist · 片头广告剔除', () => {
  it('默认剔除广告段：分片与 totalDuration 均不含广告', async () => {
    const lines = ['#EXTM3U', '#EXT-X-DISCONTINUITY'];
    for (let i = 0; i < 3; i++) lines.push('#EXTINF:5,', `ad${i}.ts`);
    lines.push('#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'movie0.ts', '#EXTINF:4,', 'movie1.ts', '#EXT-X-ENDLIST');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(lines.join('\n'), { status: 200 })));

    const parsed = await parseM3u8Playlist('https://cdn.example.com/a.m3u8');
    expect(parsed.segments.map((s) => s.url)).toEqual([
      'https://cdn.example.com/movie0.ts',
      'https://cdn.example.com/movie1.ts',
    ]);
    expect(parsed.totalDuration).toBe(8);
  });

  it('stripLeadAd=false 保留全部分片', async () => {
    const lines = ['#EXTM3U', '#EXT-X-DISCONTINUITY', '#EXTINF:5,', 'ad.ts', '#EXT-X-DISCONTINUITY', '#EXTINF:4,', 'movie.ts'];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(lines.join('\n'), { status: 200 })));

    const parsed = await parseM3u8Playlist('https://cdn.example.com/a.m3u8', 0, undefined, { stripLeadAd: false });
    expect(parsed.segments).toHaveLength(2);
  });
});

describe('stripAdGroups：同一段短片重复出现', () => {
  const seg = (name: string, sec = 2) => `#EXTINF:${sec},\n${name}`;
  const group = (prefix: string, n: number, sec = 2) => Array.from({ length: n }, (_, i) => seg(`${prefix}${i}.ts`, sec)).join('\n');
  const head = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXT-X-KEY:METHOD=AES-128,URI="key.key"';
  const ad = group('https://play.example.com/ad', 6, 2.93);

  it('魔都式：正片 98 秒后插一次、结尾再插一次 → 两次都去掉', () => {
    const src = [head, group('https://bf.example.com/a', 49), '#EXT-X-DISCONTINUITY', ad, '#EXT-X-DISCONTINUITY', group('https://bf.example.com/b', 600), '#EXT-X-DISCONTINUITY', ad, '#EXT-X-ENDLIST'].join('\n');
    const out = stripAdGroups(src);
    expect(out).not.toContain('/ad0.ts');
    expect(out).toContain('#EXT-X-KEY');
    expect(out).toContain('/a0.ts');
    expect(out).toContain('/b599.ts');
    expect(out.match(/#EXT-X-DISCONTINUITY/g)?.length).toBe(1);
  });

  it('不重复的短段、重复但很长的段都不动', () => {
    const once = [head, group('a', 300), '#EXT-X-DISCONTINUITY', group('x', 3, 2), '#EXT-X-DISCONTINUITY', group('b', 20)].join('\n');
    expect(stripAdGroups(once)).toContain('x0.ts');
    const longRepeat = [head, group('r', 40), '#EXT-X-DISCONTINUITY', group('r', 40)].join('\n');
    expect(stripAdGroups(longRepeat)).toContain('r0.ts');
  });
});

describe('stripAdGroups：切片整齐的源里时长对不上的插播段（最大资源）', () => {
  const head = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2';
  let n = 0;
  const group = (durs: number[]) => durs.map((d) => `#EXTINF:${d.toFixed(6)},\nhttps://v.test/2000k_1080/hls/${String(n++).padStart(10, 'a')}.ts`).join('\n');
  const twos = (k: number) => Array.from({ length: k }, () => 2);
  const join = (...gs: string[]) => [head, ...gs.flatMap((g, i) => (i === 0 ? [g] : ['#EXT-X-DISCONTINUITY', g])), '#EXT-X-ENDLIST'].join('\n');

  it('正片每片 2.0 秒、切成很多小段；38.1 秒（19×2.0 + 0.1）的插播段去掉，结尾短一截的最后一片保留', () => {
    n = 0;
    const content = Array.from({ length: 40 }, (_, i) => group(twos(3 + (i % 15))));
    const ad = group([...twos(19), 0.1]);
    const src = join(...content.slice(0, 20), ad, ...content.slice(20), group([2, 2, 1.3]));
    const out = stripAdGroups(src);
    expect(out).not.toMatch(/EXTINF:0\.1/);
    expect(out.match(/#EXTINF/g)!.length).toBe(src.match(/#EXTINF/g)!.length - 20);
    expect(out).toMatch(/EXTINF:1\.3/);
  });

  it('片头曲接缝留下的零头分片（段长 90 秒）不动；分片时长本来就参差的源不动', () => {
    n = 0;
    const content = Array.from({ length: 20 }, () => group(twos(8)));
    const op = group([...twos(44), 1.9]);
    expect(stripAdGroups(join(...content.slice(0, 2), op, ...content.slice(2)))).toMatch(/EXTINF:1\.9/);
    n = 0;
    const ragged = Array.from({ length: 20 }, (_, i) => group([3.12, 1.96, 2.4, 4.0 + (i % 3) * 0.2]));
    const mixed = join(...ragged.slice(0, 10), group([2, 2, 0.1]), ...ragged.slice(10));
    expect(stripAdGroups(mixed)).toMatch(/EXTINF:0\.1/);
  });
});

describe('stripAdGroups：零头规则的保险', () => {
  it('一集里要删的零头段太多（> 4 段）就当成源的正常切法，一段都不删', () => {
    let n = 0;
    const g = (durs: number[]) => durs.map((d) => `#EXTINF:${d},\nhttps://v.test/hls/${String(n++).padStart(8, 'b')}.ts`).join('\n');
    const parts: string[] = [];
    for (let i = 0; i < 12; i++) parts.push(g(Array.from({ length: 20 }, () => 2)), g([2, 2, 2, 1.4]));
    const src = ['#EXTM3U', ...parts.flatMap((p, i) => (i === 0 ? [p] : ['#EXT-X-DISCONTINUITY', p])), '#EXT-X-ENDLIST'].join('\n');
    expect(stripAdGroups(src)).toBe(src);
  });
});

describe('unproxyM3u8', () => {
  it('把代理改写过的地址还原（分片和密钥）', () => {
    const raw = ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="key.key"', '#EXTINF:5,', 'a/1.ts', '#EXTINF:5,', 'https://ad.example.com/x.ts'].join('\n');
    expect(unproxyM3u8(rewriteM3u8(raw, BASE))).toBe(
      ['#EXTM3U', '#EXT-X-KEY:METHOD=AES-128,URI="https://cdn.example.com/live/key.key"', '#EXTINF:5,', 'https://cdn.example.com/live/a/1.ts', '#EXTINF:5,', 'https://ad.example.com/x.ts'].join('\n'),
    );
  });
});
