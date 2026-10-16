import { FP_RATE } from '../audio-fingerprint';

/** 测试用的合成音频与 TS 封装（不依赖 ffmpeg） */

function rng(seed: number) {
  return () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

/** 「音乐」：每 0.4 秒换一组三和弦 + 一点噪声 */
export function music(seconds: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * FP_RATE));
  let notes: number[] = [];
  const step = Math.round(0.4 * FP_RATE);
  for (let i = 0; i < out.length; i++) {
    if (i % step === 0) notes = [0, 1, 2].map(() => 220 * Math.pow(2, Math.floor(r() * 24) / 12));
    const t = i / FP_RATE;
    out[i] = notes.reduce((s, f) => s + Math.sin(2 * Math.PI * f * t), 0) * 0.2 + (r() - 0.5) * 0.02;
  }
  return out;
}

/** 「对白」：音高乱跳、时有时无 */
export function speech(seconds: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * FP_RATE));
  let f = 500;
  let p = 0;
  for (let i = 0; i < out.length; i++) {
    if (i % 2205 === 0) f = 300 + r() * 1500;
    p += (2 * Math.PI * f) / FP_RATE;
    out[i] = Math.sin(p) * r() * 0.4 * (Math.floor(i / 8000) % 3 ? 1 : 0.1);
  }
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
}

export function scaleWithNoise(x: Float32Array, gain: number, seed: number): Float32Array {
  const r = rng(seed);
  return x.map((v) => v * gain + (r() - 0.5) * 0.02);
}

/** 把一段负载包成最简单的 TS：PAT + PMT（一条 AAC 轨，PID 0x101）+ 一个 PES */
export function wrapTs(payload: Uint8Array, prefix?: Uint8Array): Uint8Array {
  const packets: Uint8Array[] = [];
  const packet = (pid: number, pusi: boolean, body: Uint8Array, cc: number) => {
    const p = new Uint8Array(188).fill(0xff);
    p[0] = 0x47;
    p[1] = (pusi ? 0x40 : 0) | ((pid >> 8) & 0x1f);
    p[2] = pid & 0xff;
    if (body.length >= 184) {
      p[3] = 0x10 | (cc & 0xf);
      p.set(body.subarray(0, 184), 4);
    } else {
      // 用适配域把负载顶到包尾
      p[3] = 0x30 | (cc & 0xf);
      const stuffing = 184 - body.length - 1;
      p[4] = stuffing;
      if (stuffing > 0) p[5] = 0;
      p.set(body, 5 + stuffing);
    }
    return p;
  };
  const pat = Uint8Array.from([0, 0x00, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xe1, 0x00, 0, 0, 0, 0]);
  const pmt = Uint8Array.from([0, 0x02, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe1, 0x01, 0xf0, 0, 0x0f, 0xe1, 0x01, 0xf0, 0, 0, 0, 0, 0]);
  packets.push(packet(0, true, pat, 0), packet(0x100, true, pmt, 0));
  const pes = new Uint8Array(9 + payload.length);
  pes.set([0, 0, 1, 0xc0, 0, 0, 0x80, 0, 0]);
  pes.set(payload, 9);
  let cc = 0;
  for (let off = 0; off < pes.length; off += 184) {
    packets.push(packet(0x101, off === 0, pes.subarray(off, off + 184), cc++));
  }
  return concat8(prefix ?? new Uint8Array(0), ...packets);
}

function concat8(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
}
