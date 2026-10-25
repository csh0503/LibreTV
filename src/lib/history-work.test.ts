import { describe, expect, it } from 'vitest';
import { collapseHistoryByWork, sameWorkHistory, trimHistory, workKeyOf } from './history-work';

const row = (title: string, timestamp: number, sourceKey = 'a', vodId = title) => ({
  id: `${sourceKey}_${vodId}`,
  title,
  timestamp,
  sourceKey,
  vodId,
});

describe('workKeyOf', () => {
  it('海贼王和航海王、写不写第一季，都是同一部', () => {
    const key = workKeyOf('航海王');
    expect(workKeyOf('海贼王')).toBe(key);
    expect(workKeyOf('海贼王 第一季')).toBe(key);
    expect(workKeyOf('航海王第一季')).toBe(key);
    expect(workKeyOf('ONE PIECE')).toBe(key);
    expect(workKeyOf('海贼王 第三季')).toBe(key);
  });

  it('电影续集的结尾数字不是季数', () => {
    expect(workKeyOf('疯狂动物城2')).not.toBe(workKeyOf('疯狂动物城'));
  });
});

describe('观看记录按作品合并', () => {
  it('列表只留最近看的那个源', () => {
    const shown = collapseHistoryByWork([
      row('海贼王', 10, 'src-a', '1'),
      row('别的剧', 20, 'src-a', '2'),
      row('航海王 第一季', 30, 'src-b', '9'),
    ]);
    expect(shown.map((item) => item.vodId)).toEqual(['9', '2']);
  });

  it('删掉一部时，换过的源都在里面', () => {
    const rows = [row('海贼王', 10, 'src-a', '1'), row('航海王', 30, 'src-b', '9'), row('别的剧', 20, 'src-a', '2')];
    expect(sameWorkHistory(rows, '航海王 第一季').map((item) => item.vodId).sort()).toEqual(['1', '9']);
  });

  it('超过上限时先丢掉重复的源，再丢掉更老的剧', () => {
    const rows = [
      row('老剧', 1, 'src-a', 'old'),
      row('海贼王', 10, 'src-a', '1'),
      row('航海王', 40, 'src-b', '9'),
      row('新剧', 50, 'src-a', 'new'),
    ];
    const { keep, drop } = trimHistory(rows, 3);
    expect(drop.map((item) => item.vodId)).toEqual(['1']);
    expect(keep.map((item) => item.vodId).sort()).toEqual(['9', 'new', 'old']);

    const many = [row('甲', 1), row('乙', 2), row('丙', 3), row('甲', 4, 'src-b', '甲2')];
    const trimmed = trimHistory(many, 2);
    expect(trimmed.keep.map((item) => item.vodId).sort()).toEqual(['丙', '甲2']);
    expect(trimmed.drop.map((item) => item.vodId).sort()).toEqual(['乙', '甲']);
  });
});
