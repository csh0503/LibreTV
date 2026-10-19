import { describe, expect, it } from 'vitest';
import { episodeCount, rankSources } from './source-rank';

const item = (sourceKey: string, remarks?: string) => ({ vodId: sourceKey, name: '某剧', sourceKey, sourceName: sourceKey, remarks });

describe('rankSources：「播放」默认用哪个源', () => {
  it('出错的往后放，集数多的优先，再按速度', () => {
    const health = {
      slow: { ok: true, ms: 2500, failStreak: 0, timestamp: 0 },
      fast: { ok: true, ms: 300, failStreak: 0, timestamp: 0 },
      broken: { ok: false, ms: 100, failStreak: 2, timestamp: 0 },
      behind: { ok: true, ms: 100, failStreak: 0, timestamp: 0 },
    };
    const ranked = rankSources(
      [item('broken', '更新至12集'), item('behind', '更新至10集'), item('slow', '更新至12集'), item('fast', '更新至12集')],
      health,
    );
    expect(ranked.map((r) => r.sourceKey)).toEqual(['fast', 'slow', 'behind', 'broken']);
  });

  it('集数写法', () => {
    expect(episodeCount('更新至第12集')).toBe(12);
    expect(episodeCount('全24话')).toBe(24);
    expect(episodeCount('HD')).toBe(0);
  });
});

describe('rankSources：加上质检', () => {
  it('清晰度先于集数和速度，广告少的优先，质检失败的往后', () => {
    const health = {};
    const quality = {
      a_a: { key: 'a_a', ok: true, height: 720, adSeconds: 0 },
      b_b: { key: 'b_b', ok: true, height: 1080, adSeconds: 30 },
      c_c: { key: 'c_c', ok: true, height: 1080, adSeconds: 0 },
      d_d: { key: 'd_d', ok: false, error: '超时' },
    };
    const ranked = rankSources([item('d'), item('a'), item('b'), item('c')], health, quality);
    expect(ranked.map((r) => r.sourceKey)).toEqual(['c', 'b', 'a', 'd']);
  });
});

describe('rankSources：你真的播过的表现', () => {
  it('起播快的优先、常卡的往后、老播不了的算出错、没测出清晰度时用播放时看到的', () => {
    const health = {
      a: { ok: true, ms: 200, failStreak: 0, timestamp: 0 },
      b: { ok: true, ms: 200, failStreak: 0, timestamp: 0 },
      c: { ok: true, ms: 200, failStreak: 0, timestamp: 0 },
      d: { ok: true, ms: 200, failStreak: 0, timestamp: 0 },
      e: { ok: true, ms: 200, failStreak: 0, timestamp: 0 },
    };
    const playback = {
      a: { plays: 3, startMs: 4000, stalls: 0, fails: 0, at: 0 },
      b: { plays: 3, startMs: 900, stalls: 0, fails: 0, at: 0 },
      c: { plays: 3, startMs: 500, stalls: 2.4, fails: 0, at: 0 },
      d: { plays: 0, stalls: 0, fails: 3, at: 0 },
      e: { plays: 2, startMs: 3000, height: 1080, stalls: 0, fails: 0, at: 0 },
    };
    const ranked = rankSources([item('a'), item('b'), item('c'), item('d'), item('e')], health, {}, playback);
    expect(ranked.map((r) => r.sourceKey)).toEqual(['e', 'b', 'a', 'c', 'd']);
  });
});
