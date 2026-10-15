import { describe, expect, it } from 'vitest';
import { shouldDropLocalProfile } from './profile-sync';

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
