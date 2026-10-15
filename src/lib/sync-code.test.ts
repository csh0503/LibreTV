import { describe, expect, it } from 'vitest';
import { createSyncSecret, formatSyncCode, normalizeSyncCode } from './sync-code';

describe('同步码', () => {
  it('生成 20 位，粘贴时忽略横线和空格', () => {
    const secret = createSyncSecret();
    expect(secret).toHaveLength(20);
    expect(normalizeSyncCode(formatSyncCode(secret))).toBe(secret);
    expect(normalizeSyncCode(' ab-cd ')).toBe('ABCD');
  });
});
