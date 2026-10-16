/**
 * 从 MPEG-TS 分片里取出音频（不处理视频）：找 PAT → PMT → 音频轨的 PID，
 * 把它的 PES 负载按顺序拼起来。AAC 轨拼出来就是 ADTS 流、MP3 轨就是 MP3 帧，浏览器都能直接解码。
 * 不少采集站在分片前面塞一个假的 PNG / JPG 头，所以先找真正的 TS 同步字节。
 */

const PACKET = 188;
const SYNC = 0x47;

export type AudioCodec = 'aac' | 'mp3';

/** 找到连续三个包都以 0x47 开头的位置（跳过伪装头） */
export function findTsStart(bytes: Uint8Array): number {
  const limit = Math.min(bytes.length - PACKET * 2, 64 * 1024);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === SYNC && bytes[i + PACKET] === SYNC && bytes[i + PACKET * 2] === SYNC) return i;
  }
  return -1;
}

function payloadOffset(bytes: Uint8Array, pkt: number): number {
  const afc = (bytes[pkt + 3] >> 4) & 0x3;
  if (afc === 0 || afc === 2) return -1; // 没有负载
  return afc === 3 ? pkt + 5 + bytes[pkt + 4] : pkt + 4;
}

export function demuxTsAudio(bytes: Uint8Array): { codec: AudioCodec; data: Uint8Array } | null {
  const start = findTsStart(bytes);
  if (start < 0) return null;
  let pmtPid = -1;
  let audioPid = -1;
  let codec: AudioCodec | null = null;
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (let pkt = start; pkt + PACKET <= bytes.length; pkt += PACKET) {
    if (bytes[pkt] !== SYNC) continue;
    const pusi = (bytes[pkt + 1] & 0x40) !== 0;
    const pid = ((bytes[pkt + 1] & 0x1f) << 8) | bytes[pkt + 2];
    let off = payloadOffset(bytes, pkt);
    if (off < 0 || off >= pkt + PACKET) continue;

    if (pid === 0 && pmtPid < 0) {
      // PAT：第一个节目的 PMT PID
      if (pusi) off += 1 + bytes[off];
      const sectionLen = ((bytes[off + 1] & 0x0f) << 8) | bytes[off + 2];
      for (let p = off + 8; p + 4 <= off + 3 + sectionLen - 4; p += 4) {
        const program = (bytes[p] << 8) | bytes[p + 1];
        if (program !== 0) {
          pmtPid = ((bytes[p + 2] & 0x1f) << 8) | bytes[p + 3];
          break;
        }
      }
      continue;
    }
    if (pid === pmtPid && audioPid < 0) {
      if (pusi) off += 1 + bytes[off];
      const sectionLen = ((bytes[off + 1] & 0x0f) << 8) | bytes[off + 2];
      const infoLen = ((bytes[off + 10] & 0x0f) << 8) | bytes[off + 11];
      const end = off + 3 + sectionLen - 4;
      for (let p = off + 12 + infoLen; p + 5 <= end; ) {
        const type = bytes[p];
        const esPid = ((bytes[p + 1] & 0x1f) << 8) | bytes[p + 2];
        const esInfo = ((bytes[p + 3] & 0x0f) << 8) | bytes[p + 4];
        if (type === 0x0f) {
          audioPid = esPid;
          codec = 'aac';
          break;
        }
        if (type === 0x03 || type === 0x04) {
          audioPid = esPid;
          codec = 'mp3';
          break;
        }
        p += 5 + esInfo;
      }
      continue;
    }
    if (pid !== audioPid || audioPid < 0) continue;
    if (pusi) {
      // PES 头：00 00 01 + stream_id + 长度(2) + 标志(2) + 头长(1)
      if (bytes[off] !== 0 || bytes[off + 1] !== 0 || bytes[off + 2] !== 1) continue;
      off += 9 + bytes[off + 8];
    }
    if (off < pkt + PACKET) {
      const chunk = bytes.subarray(off, pkt + PACKET);
      chunks.push(chunk);
      total += chunk.length;
    }
  }
  if (!codec || total === 0) return null;
  const data = new Uint8Array(total);
  let k = 0;
  for (const c of chunks) {
    data.set(c, k);
    k += c.length;
  }
  return { codec, data };
}
