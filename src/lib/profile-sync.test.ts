import { describe, expect, it } from 'vitest';
import { mergeSyncedRows, shouldDropLocalProfile } from './profile-sync';

describe('别的设备删掉的设定档', () => {
  const catalog = new Set(['csh']);

  it('曾经同步过、现在不在云端名单里的，本机要丢掉', () => {
    expect(shouldDropLocalProfile({ id: 'default', cloudUpdatedAt: 10, pendingPush: true }, catalog)).toBe(true);
  });

  it('从没上传过的旧档也丢掉，避免这台电脑再把它传上去', () => {
    expect(shouldDropLocalProfile({ id: 'default' }, catalog)).toBe(true);
  });

  it('本机刚建、还没上传成功的留下', () => {
    expect(shouldDropLocalProfile({ id: 'new', pendingPush: true }, catalog)).toBe(false);
  });

  it('还在云端名单里的留下', () => {
    expect(shouldDropLocalProfile({ id: 'csh', cloudUpdatedAt: 10 }, catalog)).toBe(false);
  });
});

describe('收藏和观看记录合并', () => {
  const key = (row: { id: string }) => row.id;
  const time = (row: { at: number }) => row.at;

  it('另一台新增的收藏会进来', () => {
    const merged = mergeSyncedRows(100, [{ id: 'old', at: 50 }], [{ id: 'old', at: 50 }, { id: 'new', at: 150 }], key, time);
    expect(merged.map((row) => row.id).sort()).toEqual(['new', 'old']);
  });

  it('这台新增的收藏会留下', () => {
    const merged = mergeSyncedRows(100, [{ id: 'mine', at: 180 }], [], key, time);
    expect(merged.map((row) => row.id)).toEqual(['mine']);
  });

  it('同步之后才删掉的，不会被旧的云端副本加回来', () => {
    const merged = mergeSyncedRows(100, [], [{ id: 'gone', at: 40 }], key, time);
    expect(merged).toEqual([]);
  });

  it('两边都有时用较新的那条', () => {
    const merged = mergeSyncedRows(100, [{ id: 'a', at: 120, pos: 1 }], [{ id: 'a', at: 140, pos: 9 }], key, time);
    expect(merged).toEqual([{ id: 'a', at: 140, pos: 9 }]);
  });
});
