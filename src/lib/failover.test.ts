import { describe, expect, it } from 'vitest';
import { failoverQueryTitle, parseTried, pickFailoverCandidates } from './failover';

const row = (name: string, year: string, typeName: string, sourceKey: string, vodId = '1', remarks?: string) => ({
  vodId,
  name,
  year,
  typeName,
  remarks,
  sourceKey,
  sourceName: sourceKey,
});

describe('failoverQueryTitle', () => {
  it('去掉和年份一样的结尾数字', () => {
    expect(failoverQueryTitle('九门2026', '2026')).toBe('九门');
    expect(failoverQueryTitle('九门 (2026)', '2026')).toBe('九门');
    expect(failoverQueryTitle('九门2026')).toBe('九门');
    expect(failoverQueryTitle('1917', '2019')).toBe('1917');
    expect(failoverQueryTitle('守护解放西5', '2026')).toBe('守护解放西5');
  });
});

describe('parseTried', () => {
  it('逗号分隔，忽略空项', () => {
    expect(parseTried('a_1,,b_2 ')).toEqual(['a_1', 'b_2']);
    expect(parseTried(null)).toEqual([]);
  });
});

describe('pickFailoverCandidates', () => {
  const list = [
    row('九门', '2026', '国产剧', 'a', '1', '全30集'),
    row('九门', '2026', '国产剧', 'b', '2', '全30集'),
    row('九门2026', '2026', '大陆剧', 'c', '3', '全30集'),
    row('九门', '2021', '剧情片', 'd', '4'),
    row('九门八甲', '2020', '剧情片', 'e', '5'),
  ];
  const base = { list, title: '九门', year: '2026', isTv: true, health: {}, quality: {} };

  it('只在同一部（同一年）里换，排除当前和试过的', () => {
    const got = pickFailoverCandidates({ ...base, current: { sourceKey: 'a', vodId: '1' }, tried: ['b_2'] });
    expect(got.map((i) => i.sourceKey)).toEqual(['c']);
  });

  it('清晰度高的先试', () => {
    const got = pickFailoverCandidates({
      ...base,
      current: { sourceKey: 'a', vodId: '1' },
      tried: [],
      quality: { b_2: { key: 'b_2', ok: true, height: 720 }, c_3: { key: 'c_3', ok: true, height: 1080 } },
    });
    expect(got.map((i) => i.sourceKey)).toEqual(['c', 'b']);
  });

  it('找不到同一部时返回空', () => {
    expect(pickFailoverCandidates({ ...base, list: [], current: { sourceKey: 'a', vodId: '1' }, tried: [] })).toEqual([]);
  });
});
