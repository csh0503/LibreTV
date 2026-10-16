import { describe, expect, it } from 'vitest';
import { pickAniListMedia, pickBangumiHit, pickSkipTimes } from './skip-times';
import { classifySkip, resolveEpisodeSkip } from './skip-marks';

describe('pickSkipTimes', () => {
  const r = (skipType: string, startTime: number, endTime: number, episodeLength: number) => ({
    skipType,
    interval: { startTime, endTime },
    episodeLength,
  });

  it('片头前有剧情时照样只跳片头那一段', () => {
    expect(pickSkipTimes([r('op', 95, 185, 1420), r('ed', 1290, 1380, 1420)], 1421)).toEqual({
      intro: { start: 95, end: 185 },
      outro: { start: 1290, end: 1380 },
    });
  });

  it('总时长差超过 15 秒的提交不用，多条取最接近的', () => {
    expect(pickSkipTimes([r('op', 0, 90, 1500)], 1420)).toEqual({});
    expect(pickSkipTimes([r('op', 10, 100, 1430), r('mixed-op', 12, 102, 1421)], 1420).intro).toEqual({ start: 12, end: 102 });
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

  it('AniList 日文原名对得上的优先', () => {
    const media = [
      { idMal: 1, title: { native: '別の作品' }, startDate: { year: 2026 } },
      { idMal: 2, title: { native: '杖と剣のウィストリア' }, startDate: { year: 2024 } },
    ];
    expect(pickAniListMedia(media, '杖と剣のウィストリア')?.idMal).toBe(2);
  });
});

describe('classifySkip：你自己跳的像不像片头片尾', () => {
  it('开头附近跳 90 秒 → 片头', () => {
    expect(classifySkip(95, 185, 1420)).toEqual({ kind: 'intro', seg: { start: 95, end: 185 } });
  });
  it('最后几分钟跳到结尾 → 片尾一直到结尾', () => {
    expect(classifySkip(1300, 1415, 1420)).toEqual({ kind: 'outro', fromEnd: 120, toEnd: 0 });
  });
  it('片尾后还有剧情：只记到跳到的位置', () => {
    expect(classifySkip(1290, 1380, 1420)).toEqual({ kind: 'outro', fromEnd: 130, toEnd: 40 });
  });
  it('中间快进、小步快进不算', () => {
    expect(classifySkip(700, 800, 1420)).toBeNull();
    expect(classifySkip(100, 105, 1420)).toBeNull();
  });
});

describe('resolveEpisodeSkip', () => {
  it('AniSkip 优先，没有用记下的；片尾按离结尾的距离换算', () => {
    const got = resolveEpisodeSkip({ intro: { start: 90, end: 180 } }, { intro: { start: 0, end: 85 }, outro: { fromEnd: 120, toEnd: 0 }, updatedAt: 0 }, 1440);
    expect(got.intro).toEqual({ start: 90, end: 180 });
    expect(got.outro).toEqual({ start: 1320, end: 1440 });
    expect(got.remote).toEqual({ intro: true, outro: false });
    expect(got.auto).toBe(false);
  });
  it('总长还不知道时不给', () => {
    expect(resolveEpisodeSkip({ intro: { start: 90, end: 180 } }, undefined, 0).intro).toBeUndefined();
  });
});
