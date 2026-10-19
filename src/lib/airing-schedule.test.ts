import { describe, expect, it } from 'vitest';
import { cnWeekday, nextDateOfWeekday } from './airing-schedule';

describe('追剧日历的日期', () => {
  // 2026-10-19 是周一（北京时间）
  const MON_NOON = Date.parse('2026-10-19T12:00:00+08:00');
  it('北京时间的星期几', () => {
    expect(cnWeekday(MON_NOON)).toBe(1);
    // UTC 还是周日晚上，北京已经周一了
    expect(cnWeekday(Date.parse('2026-10-18T17:00:00Z'))).toBe(1);
    expect(cnWeekday(Date.parse('2026-10-25T12:00:00+08:00'))).toBe(7);
  });
  it('下一个周 N：今天就是的话是今天', () => {
    expect(nextDateOfWeekday(1, MON_NOON)).toBe('2026-10-19');
    expect(nextDateOfWeekday(6, MON_NOON)).toBe('2026-10-24');
    expect(nextDateOfWeekday(7, MON_NOON)).toBe('2026-10-25');
  });
});
