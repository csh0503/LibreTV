import { describe, expect, it } from 'vitest';
import { demuxTsAudio, findTsStart } from './ts-demux';
import { wrapTs } from './test-utils/synth-audio';

describe('demuxTsAudio', () => {
  const payload = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff);

  it('取出 AAC 轨的全部负载，跨包拼接', () => {
    const out = demuxTsAudio(wrapTs(payload));
    expect(out?.codec).toBe('aac');
    expect(Array.from(out!.data)).toEqual(Array.from(payload));
  });

  it('跳过分片前伪装的 PNG 头', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x47, 1, 2, 3]);
    const ts = wrapTs(payload, png);
    expect(findTsStart(ts)).toBe(png.length);
    expect(Array.from(demuxTsAudio(ts)!.data)).toEqual(Array.from(payload));
  });

  it('不是 TS 返回 null', () => {
    expect(demuxTsAudio(new Uint8Array(1000))).toBeNull();
  });
});
