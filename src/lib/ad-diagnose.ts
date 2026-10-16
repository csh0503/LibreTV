import { makeAbsolute, stripAdGroups } from './m3u8';

/**
 * 广告诊断（给「这集有广告？」面板用）：把播放列表按 DISCONTINUITY 分段，再按「网站 + 路径 + 文件名样式」
 * 切成连续的片段组，标出哪些已被去广告规则剔除。插播广告往往在这两种切法里会露出来
 * （单独的一段、换了网站 / 目录 / 命名）。输出一段简短文字，方便复制给开发者看。
 */

export interface DiagRun {
  start: number;
  seconds: number;
  segments: number;
  /** 第几个 DISCONTINUITY 段（从 0 起） */
  group: number;
  host: string;
  dir: string;
  shape: string;
  /** 这一组分片被去广告规则剔除了 */
  stripped: boolean;
  /** EXTINF 最短 / 最长 */
  minDur: number;
  maxDur: number;
}

export interface AdDiagnosis {
  totalSeconds: number;
  strippedSeconds: number;
  groups: number;
  runs: DiagRun[];
  encrypted: boolean;
}

/**
 * 文件名的大类：「0001.ts」「s0001.ts」→ 前缀 + #；随机名「Xae1WLMH.ts」→ 只看长度（[8]）。
 * 随机命名的源如果按具体样子分，每个分片都不一样，看不出哪段是插进来的。
 */
export function nameClass(uri: string): string {
  const name = uri.split('?')[0].split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  if (/^\d+$/.test(base)) return `#${ext}`;
  const prefixed = base.match(/^([a-z_-]+?)[_-]?\d+$/i);
  if (prefixed) return `${prefixed[1]}#${ext}`;
  return `[${base.length}]${ext}`;
}

export function diagnosePlaylist(content: string, baseUrl: string): AdDiagnosis {
  const keptAfterStrip = new Set(
    stripAdGroups(content)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
  const lines = content.split('\n').map((l) => l.trim());
  const runs: DiagRun[] = [];
  let t = 0;
  let pending = 0;
  let group = 0;
  let encrypted = false;
  let strippedSeconds = 0;
  for (const line of lines) {
    if (line === '#EXT-X-DISCONTINUITY') {
      group += 1;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY') && !/METHOD=NONE/.test(line)) encrypted = true;
    const m = line.match(/^#EXTINF:([\d.]+)/);
    if (m) {
      pending = parseFloat(m[1]) || 0;
      continue;
    }
    if (!line || line.startsWith('#')) continue;
    let host = '';
    let dir = '';
    try {
      const u = new URL(makeAbsolute(line, baseUrl));
      host = u.host;
      dir = u.pathname.split('/').slice(0, -1).join('/');
    } catch {
      // 看不懂的地址按空算
    }
    const shape = nameClass(line);
    const stripped = !keptAfterStrip.has(line);
    if (stripped) strippedSeconds += pending;
    const last = runs[runs.length - 1];
    if (last && last.group === group && last.host === host && last.dir === dir && last.shape === shape && last.stripped === stripped) {
      last.seconds += pending;
      last.segments += 1;
      last.minDur = Math.min(last.minDur, pending);
      last.maxDur = Math.max(last.maxDur, pending);
    } else {
      runs.push({ start: t, seconds: pending, segments: 1, group, host, dir, shape, stripped, minDur: pending, maxDur: pending });
    }
    t += pending;
    pending = 0;
  }
  return { totalSeconds: t, strippedSeconds, groups: group + 1, runs, encrypted };
}

const clock = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};

/**
 * 简短文字：每个片段组一行。很长的正片段落合并成一行，短的（≤ 3 分钟）和换了网站 / 路径 / 命名的都列出来；
 * 路径只留最后两级，网站名保留（判断是不是另一家网站插进来的）。
 */
export function formatDiagnosis(d: AdDiagnosis, title: string): string {
  const head = `《${title}》 共 ${clock(d.totalSeconds)} · ${d.groups} 段 · ${d.runs.length} 组${d.encrypted ? ' · 加密' : ''} · 已剔除 ${Math.round(d.strippedSeconds)} 秒`;
  const lines = d.runs.slice(0, 80).map((r) => {
    const dir = r.dir.split('/').filter(Boolean).slice(-2).join('/');
    const dur = r.minDur === r.maxDur ? r.minDur.toFixed(1) : `${r.minDur.toFixed(1)}~${r.maxDur.toFixed(1)}`;
    return `${r.stripped ? '✂' : '·'} ${clock(r.start)}–${clock(r.start + r.seconds)} (${r.seconds.toFixed(1)}s, ${r.segments}片 ${dur}s) 段${r.group} ${r.host} …/${dir}/ ${r.shape}`;
  });
  if (d.runs.length > 80) lines.push(`…还有 ${d.runs.length - 80} 组`);
  return [head, ...lines].join('\n');
}
