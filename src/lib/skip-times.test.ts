import { describe, expect, it } from 'vitest';
import { pickAniListMedia, pickBangumiHit, pickSkipTimes, splitSeason } from './skip-times';

describe('pickSkipTimes', () => {
  const r = (skipType: string, startTime: number, endTime: number, episodeLength: number) => ({
    skipType,
    interval: { startTime, endTime },
    episodeLength,
  });

  it('片头前有剧情时照样只跳片头那一段', () => {
    expect(pickSkipTimes([r('op', 95, 185, 1420), r('ed', 1290, 1380, 1420)], 1421)).toEqual({
      intro: { start: 95, end: 185, via: 'aniskip' },
      outro: { start: 1290, end: 1380, via: 'aniskip' },
    });
  });

  it('总时长差 15~90 秒的当大概位置，再多不用；多条取最接近的', () => {
    expect(pickSkipTimes([r('op', 0, 90, 1460)], 1420).intro).toEqual({ start: 0, end: 90, via: 'aniskip', approx: true });
    expect(pickSkipTimes([r('op', 0, 90, 1600)], 1420)).toEqual({ missing: { intro: 'other-version', outro: 'none' } });
    expect(pickSkipTimes([r('op', 10, 100, 1430), r('mixed-op', 12, 102, 1421)], 1420).intro).toEqual({ start: 12, end: 102, via: 'aniskip' });
  });

  it('只有片尾时说明片头为什么没有', () => {
    expect(pickSkipTimes([r('ed', 1335, 1425, 1440)], 1440)).toEqual({
      outro: { start: 1335, end: 1425, via: 'aniskip' },
      missing: { intro: 'none' },
    });
  });
});

describe('Bangumi / AniList 对应', () => {
  it('中文名对得上（繁简、空格、第2季写法不同也算），年份优先', () => {
    const hits = [
      { name: 'A', name_cn: '杖与剑的魔剑谭', date: '2025-01-05' },
      { name: 'B', name_cn: '杖与剑的魔剑谭 第二季', date: '2026-04-12' },
    ];
    expect(pickBangumiHit(hits, '杖与剑的魔剑谭第2季')?.name).toBe('B');
    expect(pickBangumiHit(hits, '某部别的')).toBeUndefined();
  });

  it('原名对不上时要季数一样，对不上就不给（不再退回第一条，免得第三季拿到第一季的时间）', () => {
    const media = [
      { idMal: 10, title: { native: '薬屋のひとりごと' }, startDate: { year: 2023 } },
      { idMal: 20, title: { native: '薬屋のひとりごと 第2期' }, startDate: { year: 2025 } },
      { idMal: 30, title: { native: '薬屋のひとりごと 3期' }, startDate: { year: 2026 } },
    ];
    expect(pickAniListMedia(media, '薬屋のひとりごと 第3期')?.idMal).toBeUndefined();
    expect(pickAniListMedia(media, '薬屋のひとりごと 第2期')?.idMal).toBe(20);
    expect(pickAniListMedia([{ idMal: 30, title: { native: '薬屋のひとりごと Season 3' } }, ...media], '薬屋のひとりごと 第3期')?.idMal).toBe(30);
    expect(pickAniListMedia(media.slice(0, 1), '別の作品')).toBeUndefined();
  });

  it('splitSeason 认各种季数写法', () => {
    expect(splitSeason('薬屋のひとりごと 第3期')).toEqual({ base: '薬屋のひとりごと', season: 3 });
    expect(splitSeason('進撃の巨人 Season 2').season).toBe(2);
    expect(splitSeason('Re:ゼロ 2nd season').season).toBe(2);
    expect(splitSeason('無職転生Ⅱ').season).toBe(2);
    expect(splitSeason('86').season).toBe(1);
    expect(splitSeason('ぼっち・ざ・ろっく！').season).toBe(1);
  });

  it('AniList 日文原名对得上的优先', () => {
    const media = [
      { idMal: 1, title: { native: '別の作品' }, startDate: { year: 2026 } },
      { idMal: 2, title: { native: '杖と剣のウィストリア' }, startDate: { year: 2024 } },
    ];
    expect(pickAniListMedia(media, '杖と剣のウィストリア')?.idMal).toBe(2);
  });
});
