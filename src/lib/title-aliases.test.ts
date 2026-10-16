import { describe, expect, it } from 'vitest';
import {
  canonicalTitle,
  expandSearchTerms,
  extractCoreSearchStem,
  replaceAliasInTitle,
  titleMatchesQuery,
} from './title-aliases';

describe('片名别名与搜索降级分词', () => {
  it('航海王会带上海贼王，黑色五叶草会带上黑色四叶草', () => {
    expect(expandSearchTerms('航海王')).toEqual(['航海王', '海贼王', 'ONE PIECE']);
    expect(expandSearchTerms('海贼王')[0]).toBe('海贼王');
    expect(expandSearchTerms('海贼王')).toContain('航海王');
    expect(expandSearchTerms('黑色五叶草')).toContain('黑色四叶草');
  });

  it('没有别名的词原样返回，剧场版不拆成整部别名', () => {
    expect(expandSearchTerms('测试剧')).toEqual(['测试剧']);
    expect(expandSearchTerms('海贼王剧场版')).toEqual(['海贼王剧场版']);
  });

  it('带冒号副标题或季数的长片名自动补充主片名检索词', () => {
    expect(extractCoreSearchStem('列女战纪：女娲石记')).toBe('列女战纪');
    expect(extractCoreSearchStem('无职转生Ⅲ 到了异世界就拿出真本事')).toBe('无职转生');
    expect(expandSearchTerms('列女战纪：女娲石记')).toEqual(['列女战纪：女娲石记', '列女战纪']);
  });

  it('海贼王和航海王、黑色四叶草和黑色五叶草是同一部', () => {
    expect(canonicalTitle('海贼王')).toBe(canonicalTitle('航海王'));
    expect(canonicalTitle('ONE PIECE')).toBe(canonicalTitle('航海王'));
    expect(canonicalTitle('黑色四叶草')).toBe(canonicalTitle('黑色五叶草'));
    expect(canonicalTitle('海贼王剧场版')).not.toBe(canonicalTitle('海贼王'));
  });

  it('replaceAliasInTitle 将异名带后缀标题替换为统一主名', () => {
    expect(replaceAliasInTitle('黑色四叶草 第二季', '黑色五叶草')).toBe('黑色五叶草 第二季');
    expect(replaceAliasInTitle('海贼王 剧场版', '航海王')).toBe('航海王 剧场版');
  });

  it('别名结果归到用户搜的那个名字下', () => {
    expect(titleMatchesQuery('海贼王', '航海王')).toBe(true);
    expect(titleMatchesQuery('海贼王剧场版：红发歌姬', '航海王')).toBe(true);
    expect(titleMatchesQuery('火影忍者', '航海王')).toBe(false);
  });
});
