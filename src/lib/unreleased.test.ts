import { describe, expect, it } from 'vitest';
import { canonicalTitle } from './title-aliases';
import { dropUnreleased, type UnreleasedIndex } from './unreleased';
import type { DoubanItem } from './types';

const item = (title: string, extra: Partial<DoubanItem> = {}): DoubanItem => ({
  id: title,
  title,
  cover: 'c',
  isTv: true,
  ...extra,
});

describe('dropUnreleased', () => {
  const index: UnreleasedIndex = new Map([
    [canonicalTitle('赛博朋克：边缘行者 2'), '2026-10-20'],
    [canonicalTitle('哪吒'), '2026-12-01'],
  ]);

  it('剔除开播日期还没到的条目', () => {
    const kept = dropUnreleased([item('赛博朋克：边缘行者 2', { year: '2026' }), item('咒术回战', { year: '2026' })], index);
    expect(kept.map((i) => i.title)).toEqual(['咒术回战']);
  });

  it('同名老作品（年份对不上）不误伤', () => {
    const kept = dropUnreleased([item('哪吒', { year: '2019', isTv: false })], index);
    expect(kept).toHaveLength(1);
  });

  it('备注里已有集数说明已经播出，保留', () => {
    const kept = dropUnreleased([item('赛博朋克：边缘行者 2', { year: '2026', remarks: '更新至1集' })], index);
    expect(kept).toHaveLength(1);
  });

  it('索引为空（上游失败）时原样返回', () => {
    const items = [item('赛博朋克：边缘行者 2', { year: '2026' })];
    expect(dropUnreleased(items, new Map())).toBe(items);
  });
});
