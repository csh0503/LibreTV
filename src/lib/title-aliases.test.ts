import { describe, expect, it } from 'vitest';
import {
  canonicalTitle,
  expandSearchTerms,
  aggregateResults,
  extractCoreSearchStem,
  hasTitleMatch,
  kindOfTypeName,
  matchingGroups,
  rankGroupsForPick,
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

describe('hasTitleMatch：搜索结果里有没有这部作品本身', () => {
  const row = (name: string, typeName = '剧集') => ({ vodId: name, name, typeName, sourceKey: 's1', sourceName: '源一' });
  const groupsOf = (names: string[], query: string) =>
    aggregateResults(names.map((n) => row(n)), query);

  it('同名或带季数的都算有', () => {
    expect(hasTitleMatch(groupsOf(['庆余年'], '庆余年'), '庆余年')).toBe(true);
    expect(hasTitleMatch(groupsOf(['庆余年第二季'], '庆余年'), '庆余年')).toBe(true);
    expect(hasTitleMatch(groupsOf(['庆余年 第1季'], '庆余年 第二季'), '庆余年 第二季')).toBe(true);
  });

  it('只有名字沾边的别的片、或只有解说时算没有', () => {
    expect(hasTitleMatch(groupsOf(['余年有你'], '庆余年'), '庆余年')).toBe(false);
    expect(hasTitleMatch(aggregateResults([row('庆余年', '影视解说')], '庆余年'), '庆余年')).toBe(false);
    expect(hasTitleMatch([], '庆余年')).toBe(false);
  });
});

describe('matchingGroups', () => {
  it('只留这部作品的各季，去掉名字沾边的别的片', () => {
    const row = (name: string) => ({ vodId: name, name, typeName: '剧集', sourceKey: 's1', sourceName: '源一' });
    const groups = aggregateResults(['庆余年', '庆余年第二季', '余年有你'].map(row), '庆余年');
    expect(matchingGroups(groups, '庆余年').map((g) => g.name).sort()).toEqual(['庆余年', '庆余年第二季']);
  });
});

describe('作品详情弹窗：九门', () => {
  const row = (name: string, year: string, typeName: string, sourceKey: string) => ({
    vodId: `${name}-${sourceKey}`,
    name,
    year,
    typeName,
    sourceKey,
    sourceName: sourceKey,
  });
  const list = [
    ...['s1', 's2', 's3', 's4'].map((k) => row('九门', '2021', '剧情片', k)),
    ...['s1', 's2'].map((k) => row('九门', '2026', '国产剧', k)),
    ...['s3', 's5'].map((k) => row('九门2026', '2026', '大陆剧', k)),
    row('九门八甲', '2020', '剧情片', 's1'),
    row('九门提督', '2018', '动作片', 's1'),
    row('九门 第二季', '2027', '国产剧', 's1'),
  ];

  it('名字只是开头一样的别的片不算同一部，季数后缀算', () => {
    const names = matchingGroups(aggregateResults(list, '九门'), '九门').map((g) => g.name);
    expect(names).not.toContain('九门八甲');
    expect(names).not.toContain('九门提督');
    expect(names).toContain('九门 第二季');
  });

  it('同一部的不同写法并成一组，年份和类型对得上的排第一', () => {
    const ranked = rankGroupsForPick(matchingGroups(aggregateResults(list, '九门'), '九门'), {
      title: '九门',
      year: '2026',
      isTv: true,
    });
    expect(ranked[0].year).toBe('2026');
    expect(ranked[0].name).toBe('九门');
    expect(new Set(ranked[0].items.map((i) => i.sourceKey))).toEqual(new Set(['s1', 's2', 's3', 's5']));
    expect(ranked.map((g) => g.year)).toEqual(['2026', '2027', '2021']);
  });

  it('严格规则一个都没有时退回宽松规则', () => {
    expect(matchingGroups(aggregateResults([row('九门八甲', '2020', '剧情片', 's1')], '九门'), '九门')).toHaveLength(1);
  });

  it('分类名看电影还是剧集', () => {
    expect(kindOfTypeName('剧情片')).toBe('movie');
    expect(kindOfTypeName('国产剧')).toBe('tv');
    expect(kindOfTypeName('日韩动漫')).toBe('tv');
    expect(kindOfTypeName('动画片')).toBeUndefined();
    expect(kindOfTypeName(undefined)).toBeUndefined();
  });
});
