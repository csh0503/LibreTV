import { describe, expect, it } from 'vitest';
import { applySeasonInfo, notAiredYet, parseSeasonInfo } from './bili-season';
import { freshnessFactor } from './douban-weekly';
import { collapseSeries } from './shelves';
import type { DoubanItem } from './types';

const NOW = Date.parse('2026-10-19T12:00:00+08:00');
const day = (s: string) => Math.floor(Date.parse(`${s}T20:00:00+08:00`) / 1000);
const item = (p: Partial<DoubanItem> & { id: string; title: string }): DoubanItem => ({ cover: 'c', isTv: true, ...p });

describe('B站单季详情', () => {
  it('凡人修仙传：2020 年开播、昨天还有新集 → 年份 2020、连载', () => {
    const info = parseSeasonInfo({
      publish: { is_finish: 0, pub_time: '2020-07-25 20:00:00' },
      styles: ['小说改', '玄幻'],
      episodes: [{ pub_time: day('2020-07-25') }, { pub_time: day('2026-10-17') }],
    });
    expect(info).toMatchObject({ firstAired: '2020-07-25', lastAired: '2026-10-17', finished: false, episodeCount: 2 });
    const out = applySeasonInfo(item({ id: 'bili_28747', title: '凡人修仙传', genres: '动画 国创', status: 'airing' }), info, NOW);
    expect(out).toMatchObject({ year: '2020', status: 'airing', lastAired: '2026-10-17', genres: '动画 国创 小说改 玄幻' });
    expect(freshnessFactor(out, NOW)).toBe(1);
  });

  it('罗小黑战记：标着「更新至第40话」但 2021 年后没有新集 → 不标连载，时效系数低', () => {
    const info = parseSeasonInfo({ publish: { is_finish: 0, pub_time: '2011-03-01 00:00:00' }, episodes: [{ pub_time: day('2021-07-17') }] });
    const out = applySeasonInfo(item({ id: 'bili_1733', title: '罗小黑战记', status: 'airing', remarks: '更新至第40话' }), info, NOW);
    expect(out.status).toBeUndefined();
    expect(freshnessFactor(out, NOW)).toBeLessThan(0.5);
  });

  it('间谍过家家 第三季：敬请期待、一集没放 → 还没开播', () => {
    const info = parseSeasonInfo({ publish: { is_finish: 0, pub_time: '2026-01-31 23:59:00', unknow_pub_date: 1 }, episodes: [] });
    expect(notAiredYet(info, NOW)).toBe(true);
    expect(notAiredYet(parseSeasonInfo({ publish: { pub_time: '2025-01-01 00:00:00' }, episodes: [{ pub_time: day('2025-01-01') }] }), NOW)).toBe(false);
  });

  it('时效系数：今年的新片 1、去年 0.8、更早 0.5', () => {
    expect(freshnessFactor(item({ id: '1', title: 'a', isTv: false, year: '2026' }), NOW)).toBe(1);
    expect(freshnessFactor(item({ id: '1', title: 'a', isTv: false, year: '2025' }), NOW)).toBe(0.8);
    expect(freshnessFactor(item({ id: '1', title: 'a', isTv: false, year: '2019' }), NOW)).toBe(0.5);
  });
});

describe('题材行', () => {
  it('同一系列只留一个坑位，展示最新那季', () => {
    const out = collapseSeries([
      item({ id: '1', title: '怪奇物语 第一季', year: '2016' }),
      item({ id: '2', title: '三体', year: '2023' }),
      item({ id: '3', title: '怪奇物语 第五季', year: '2025' }),
    ]);
    expect(out.map((i) => i.title)).toEqual(['怪奇物语 第五季', '三体']);
  });
});
