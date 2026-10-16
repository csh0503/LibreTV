import { describe, expect, it } from 'vitest';
import { probeEpisode } from './quality-probe';

const media = Array.from({ length: 12 }, (_, i) => `#EXTINF:10,\nseg${i}.ts`).join('\n');

describe('probeEpisode', () => {
  it('主播放列表挑最高一档，按分片大小估码率', async () => {
    const files: Record<string, string> = {
      'https://v.test/a/index.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nlow/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000\nhigh/index.m3u8',
      'https://v.test/a/high/index.m3u8': `#EXTM3U\n${media}`,
    };
    const asked: string[] = [];
    const q = await probeEpisode('https://v.test/a/index.m3u8', {
      text: async (u) => {
        asked.push(u);
        return files[u];
      },
      segmentBytes: async () => 4_000_000,
    });
    expect(asked).toEqual(['https://v.test/a/index.m3u8', 'https://v.test/a/high/index.m3u8']);
    expect(q).toMatchObject({ ok: true, height: 1080, estimated: true, kbps: 3200, adSeconds: 0, minutes: 2 });
  });

  it('量不到分片大小也照样给出广告结果', async () => {
    const q = await probeEpisode('https://v.test/b.m3u8', { text: async () => `#EXTM3U\n${media}`, segmentBytes: async () => 0 });
    expect(q).toMatchObject({ ok: true, adSeconds: 0 });
    expect(q.height).toBeUndefined();
  });

  it('不是 m3u8 时不读', async () => {
    const q = await probeEpisode('https://v.test/c.mp4', {
      text: async () => {
        throw new Error('不该读');
      },
      segmentBytes: async () => 0,
    });
    expect(q.ok).toBe(true);
  });

  it('读到的不是播放列表（被挡返回网页）算测不了', async () => {
    await expect(
      probeEpisode('https://cdn.test/a/index.m3u8', { text: async () => '<html>blocked</html>', segmentBytes: async () => 0 }),
    ).rejects.toThrow('不是播放列表');
  });
});
