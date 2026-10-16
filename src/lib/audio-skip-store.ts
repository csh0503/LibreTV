import type { AudioTemplate } from './audio-skip';

/**
 * 每部剧的片头 / 片尾曲模板（声音特征，约 5KB 一段）存在这台设备的 localStorage；
 * 以后每集只拿模板比，不用再下载别的集。
 */

const KEY = 'libretv:audio-skip:v1';
const ENABLED_KEY = 'libretv:audio-skip:enabled';
const MAX_SERIES = 80;

export interface AudioSkipEntry {
  intro?: AudioTemplate;
  outro?: AudioTemplate;
  /** 确认过没有片头 / 片尾的集（片源地址），下次不再下载别的集去比 */
  misses?: { intro?: string[]; outro?: string[] };
  updatedAt: number;
}

function readAll(): Record<string, AudioSkipEntry> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, AudioSkipEntry>;
  } catch {
    return {};
  }
}

export function loadAudioTemplates(series: string): AudioSkipEntry | undefined {
  return readAll()[series];
}

export function saveAudioTemplates(series: string, patch: Partial<AudioSkipEntry> | null): void {
  const all = readAll();
  if (patch === null) delete all[series];
  else all[series] = { ...all[series], ...patch, updatedAt: Date.now() };
  const keys = Object.keys(all);
  if (keys.length > MAX_SERIES) {
    for (const k of keys.sort((a, b) => all[a].updatedAt - all[b].updatedAt).slice(0, keys.length - MAX_SERIES)) delete all[k];
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // 存满了：这次照样用，只是不记
  }
}

const MAX_MISSES = 60;

export function hasAudioMiss(series: string, kind: 'intro' | 'outro', episodeUrl: string): boolean {
  return Boolean(readAll()[series]?.misses?.[kind]?.includes(episodeUrl));
}

export function recordAudioMiss(series: string, kind: 'intro' | 'outro', episodeUrl: string): void {
  const entry = readAll()[series];
  const list = [...(entry?.misses?.[kind] ?? []).filter((u) => u !== episodeUrl), episodeUrl].slice(-MAX_MISSES);
  saveAudioTemplates(series, { misses: { ...entry?.misses, [kind]: list } });
}

/** 后台声音比对开关：默认开；浏览器开了「省流量」时默认关 */
export function audioSkipEnabled(): boolean {
  try {
    const v = localStorage.getItem(ENABLED_KEY);
    if (v !== null) return v === '1';
  } catch {
    // 读不到按默认
  }
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return !conn?.saveData;
}

export function setAudioSkipEnabled(on: boolean): void {
  try {
    localStorage.setItem(ENABLED_KEY, on ? '1' : '0');
  } catch {
    // 忽略
  }
}
