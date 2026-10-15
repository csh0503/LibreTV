import { describe, expect, it } from 'vitest';
import { expandSearchTerms, titleMatchesQuery } from './title-aliases';

describe('片名别名', () => {
  it('航海王会带上海贼王', () => {
    expect(expandSearchTerms('航海王')).toEqual(['航海王', '海贼王', 'ONE PIECE']);
    expect(expandSearchTerms('海贼王')[0]).toBe('海贼王');
    expect(expandSearchTerms('海贼王')).toContain('航海王');
  });

  it('没有别名的词原样返回，剧场版不拆成整部别名', () => {
    expect(expandSearchTerms('测试剧')).toEqual(['测试剧']);
    expect(expandSearchTerms('海贼王剧场版')).toEqual(['海贼王剧场版']);
  });

  it('别名结果归到用户搜的那个名字下', () => {
    expect(titleMatchesQuery('海贼王', '航海王')).toBe(true);
    expect(titleMatchesQuery('海贼王剧场版：红发歌姬', '航海王')).toBe(true);
    expect(titleMatchesQuery('火影忍者', '航海王')).toBe(false);
  });
});
