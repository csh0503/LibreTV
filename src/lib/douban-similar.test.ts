import { describe, expect, it } from 'vitest';
import { pickDoubanMatch } from './douban-similar';

describe('豆瓣条目对应', () => {
  it('同名的剧和电影按类型、年份挑', () => {
    const items = [
      { target_type: 'movie', target: { id: 'm1', title: '咒术回战 0', year: '2021' } },
      { target_type: 'tv', target: { id: 't2', title: '咒术回战 第二季', year: '2023' } },
      { target_type: 'tv', target: { id: 't1', title: '咒术回战', year: '2020' } },
    ];
    expect(pickDoubanMatch(items, { title: '咒術迴戰 第二季', year: '2023', kind: 'tv' })).toEqual({ id: 't2', kind: 'tv' });
    expect(pickDoubanMatch(items, { title: '咒术回战0', kind: 'movie' })).toEqual({ id: 'm1', kind: 'movie' });
  });

  it('名字对不上就不认（不拿相似片名凑数）', () => {
    const items = [{ target_type: 'tv', target: { id: 'x', title: '海贼王女英雄们的故事', year: '2024' } }];
    expect(pickDoubanMatch(items, { title: '海贼王' })).toBeUndefined();
  });
});
