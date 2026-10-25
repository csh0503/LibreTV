import { describe, expect, it } from 'vitest';
import { mergeNotInterestedMarks, type NotInterestedMark } from './not-interested';

const mark = (title: string, at: number, on: boolean): NotInterestedMark => ({ title, at, on });

describe('不再推荐跟着设定档走', () => {
  it('另一台较新的取消盖过较早的标记', () => {
    const merged = mergeNotInterestedMarks(
      [mark('航海王', 10, true)],
      [mark('海贼王', 20, false)],
    );
    expect(merged).toEqual([mark('航海王', 20, false)]);
  });

  it('较新的标记盖过较早的取消', () => {
    const merged = mergeNotInterestedMarks(
      [mark('航海王', 30, true)],
      [mark('航海王', 10, false)],
    );
    expect(merged).toEqual([mark('航海王', 30, true)]);
  });

  it('旧包裹没有这个字段时，本机名单不动', () => {
    const local = [mark('航海王', 10, true)];
    expect(mergeNotInterestedMarks(local, undefined)).toBe(local);
  });

  it('对方一份空名单不会清掉本机还标着的', () => {
    const merged = mergeNotInterestedMarks([mark('航海王', 10, true)], []);
    expect(merged).toEqual([mark('航海王', 10, true)]);
  });
});
