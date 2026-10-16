import { describe, expect, it } from 'vitest';
import { FP_RATE, decodeTemplate, encodeTemplate, findCommonSegment, fingerprint } from './audio-fingerprint';
import { detectIntro, detectOutro } from './audio-skip';
import { loadSegments, parseMediaSegments, type HlsAudioDeps } from './hls-audio';
import { concat, music, scaleWithNoise, speech, wrapTs } from './test-utils/synth-audio';

describe('findCommonSegment：两集共有的那段音乐', () => {
  it('冷开场长短不一、音量不同、起点错开几十毫秒也找得到', () => {
    const op = music(90, 7);
    const a = concat(speech(30, 1), op, speech(60, 2));
    const b = scaleWithNoise(concat(new Float32Array(400), speech(75, 3), op, speech(40, 4)), 0.6, 5);
    const m = findCommonSegment(fingerprint(a), fingerprint(b))!;
    expect(Math.abs(m.aStart - 30)).toBeLessThan(0.6);
    expect(Math.abs(m.bStart - 75.04)).toBeLessThan(0.6);
    expect(Math.abs(m.seconds - 90)).toBeLessThan(1.5);
  });

  it('没有共同的音乐时不报', () => {
    expect(findCommonSegment(fingerprint(concat(speech(60, 11), music(40, 12))), fingerprint(concat(speech(50, 13), music(40, 14))))).toBeNull();
  });

  it('模板编码解码后还能比对', () => {
    const fp = fingerprint(music(40, 3));
    const back = decodeTemplate(encodeTemplate(fp, 0, 30));
    expect(back.length).toBe(Math.round(30 / (1024 / FP_RATE)) * 16);
    expect(findCommonSegment(back, fp, { minSeconds: 15 })?.aStart).toBe(0);
  });
});

/** 一集 = 一串 10 秒的分片；分片里装的是 PCM 字节（假解码器直接还原），可选 AES-128 加密 */
async function makeEpisode(name: string, pcm: Float32Array, key?: Uint8Array) {
  const files = new Map<string, Uint8Array>();
  const seg = 10 * FP_RATE;
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:10', '#EXT-X-MEDIA-SEQUENCE:0'];
  if (key) {
    files.set(`https://cdn.test/${name}/k.key`, key);
    lines.push('#EXT-X-KEY:METHOD=AES-128,URI="k.key"');
  }
  for (let i = 0; i * seg < pcm.length; i++) {
    const chunk = pcm.slice(i * seg, (i + 1) * seg);
    let bytes = wrapTs(new Uint8Array(chunk.buffer));
    if (key) {
      const iv = new Uint8Array(16);
      new DataView(iv.buffer).setUint32(12, i);
      const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'AES-CBC' }, false, ['encrypt']);
      bytes = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, k, bytes as BufferSource));
    }
    files.set(`https://cdn.test/${name}/s${i}.ts`, bytes);
    lines.push(`#EXTINF:${(chunk.length / FP_RATE).toFixed(3)},`, `s${i}.ts`);
  }
  lines.push('#EXT-X-ENDLIST');
  files.set(`https://cdn.test/${name}/index.m3u8`, new TextEncoder().encode(lines.join('\n')));
  return files;
}

describe('detectIntro / detectOutro：从 HLS 片源里取音频比对', () => {
  it('第一次两集比对找到片头片尾（片尾后的剧情保留），之后只用模板；加密分片也行', async () => {
    const op = music(90, 21);
    const ed = music(80, 22);
    const ep1 = concat(speech(30, 1), op, speech(500, 2), ed, speech(15, 3));
    const ep2 = scaleWithNoise(concat(speech(75, 4), op, speech(480, 5), ed), 0.7, 6);
    const files = new Map([...(await makeEpisode('e1', ep1)), ...(await makeEpisode('e2', ep2, crypto.getRandomValues(new Uint8Array(16))))]);
    let fetched = 0;
    const deps: HlsAudioDeps = {
      fetchText: async (url) => ({ text: new TextDecoder().decode(files.get(url)!), url }),
      fetchBytes: async (url) => {
        fetched += 1;
        return files.get(url)!;
      },
      decode: async (data) => new Float32Array(data.slice().buffer),
    };
    const e1 = (await loadSegments('https://cdn.test/e1/index.m3u8', false, deps))!;
    const e2 = (await loadSegments('https://cdn.test/e2/index.m3u8', false, deps))!;

    const intro = await detectIntro({ current: e1, other: e2, deps });
    expect(Math.abs(intro.seg!.start - 30)).toBeLessThan(1);
    expect(Math.abs(intro.seg!.end - 120)).toBeLessThan(1);
    expect(intro.template).toBeDefined();

    fetched = 0;
    const viaTemplate = await detectIntro({ current: e2, template: intro.template, deps });
    expect(Math.abs(viaTemplate.seg!.start - 75)).toBeLessThan(1);
    expect(fetched).toBeLessThanOrEqual(25); // 只取了本集开头，没碰另一集

    const outro = await detectOutro({ current: e1, other: e2, deps });
    expect(Math.abs(outro.seg!.start - 620)).toBeLessThan(1);
    expect(Math.abs(outro.seg!.end - 700)).toBeLessThan(1); // 后面 15 秒剧情不算片尾
    const outro2 = await detectOutro({ current: e2, template: outro.template, deps });
    expect(Math.abs(outro2.seg!.start - 645)).toBeLessThan(1);
    expect(Math.abs(outro2.seg!.end - 725)).toBeLessThan(1); // 一直到结尾
  }, 60_000);

  it('fMP4 和不认识的加密方式不处理', () => {
    expect(parseMediaSegments('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:5,\na.m4s', 'https://x/', false)).toBeNull();
    expect(parseMediaSegments('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"\n#EXTINF:5,\na.ts', 'https://x/', false)).toBeNull();
  });
});
