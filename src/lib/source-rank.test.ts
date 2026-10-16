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
