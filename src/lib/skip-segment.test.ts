import { describe, expect, it } from 'vitest';
import { parseClock, pickEpisodeSkip } from './skip-segment';

describe('parseClock', () => {
  it('认 1:30 / 01:02:03 / 90 / 全角冒号', () => {
    expect(parseClock('1:30')).toBe(90);
    expect(parseClock('01:02:03')).toBe(3723);
    expect(parseClock('90')).toBe(90);
    expect(parseClock('22：15')).toBe(1335);
    expect(parseClock('1:75')).toBeUndefined();
    expect(parseClock('abc')).toBeUndefined();
    expect(parseClock('')).toBeUndefined();
  });
});

describe('pickEpisodeSkip', () => {
  it('声音比对找到的盖过官方的；没找到的那段用官方的', () => {
    const got = pickEpisodeSkip(
      { intro: { start: 80, end: 170, via: 'aniskip' }, outro: { start: 1300, end: 1420, via: 'aniskip' } },
      { intro: { start: 82, end: 171 } },
      1420,
    );
    expect(got.intro).toEqual({ start: 82, end: 171 });
    expect(got.outro?.via).toBe('aniskip');
  });
  it('没有官方的就只用声音比对的；都没有就空', () => {
    expect(pickEpisodeSkip(undefined, { outro: { start: 1300, end: 1500 } }, 1420).outro).toEqual({ start: 1300, end: 1420 });
    expect(pickEpisodeSkip({}, {}, 1420)).toEqual({ intro: undefined, outro: undefined });
  });
  it('总长还不知道 / 越界的不给', () => {
    expect(pickEpisodeSkip({ intro: { start: 10, end: 90 } }, undefined, 0).intro).toBeUndefined();
    expect(pickEpisodeSkip({ intro: { start: 2000, end: 2090 } }, undefined, 1420).intro).toBeUndefined();
  });
  it('声音比对只有半截（比官方短 20 秒以上）：起点对得上就用官方长度，不跳到片头中间', () => {
    const got = pickEpisodeSkip(
      { intro: { start: 60, end: 150, via: 'bilibili' } },
      { intro: { start: 62, end: 100, via: 'audio' } },
      1420,
    );
    expect(got.intro).toEqual({ start: 62, end: 152, via: 'audio' });
  });
  it('声音比对只对上后半截：终点对得上就往前推官方长度', () => {
    const got = pickEpisodeSkip({ intro: { start: 60, end: 150 } }, { intro: { start: 110, end: 151 } }, 1420);
    expect(got.intro).toEqual({ start: 61, end: 151, via: 'audio' });
  });
  it('半截且起终点都对不上：用官方的', () => {
    const remote = { start: 60, end: 150, via: 'aniskip' as const };
    expect(pickEpisodeSkip({ intro: remote }, { intro: { start: 300, end: 330 } }, 1420).intro).toEqual(remote);
  });
  it('长度差不多（差 20 秒以内）：照样用声音比对的', () => {
    expect(pickEpisodeSkip({ intro: { start: 60, end: 150 } }, { intro: { start: 64, end: 140 } }, 1420).intro).toEqual({ start: 64, end: 140 });
  });
});
