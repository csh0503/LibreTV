'use client';

import { useSyncExternalStore } from 'react';

/**
 * 播放器偏好（这台设备的 localStorage）：在播放器「设置」里改，所有剧共用。
 * - autoSkip：进入片头 / 片尾后倒数 5 秒自动跳；关掉只显示「跳过片头 / 跳过片尾」按钮；
 * - audioSkip：后台比对声音找片头片尾（要下载别的集的开头结尾，省流量时可以关）；
 * - seekStep：快进 / 快退一次几秒（控制栏按钮和 ← → 键）；
 * - rate：播放速度，换集后保持。
 */

export interface PlayerPrefs {
  autoSkip: boolean;
  audioSkip: boolean;
  seekStep: number;
  rate: number;
}

export const SEEK_STEPS = [5, 10, 15, 30] as const;
export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2, 3] as const;

const KEY = 'libretv:player-prefs:v1';
/** 旧版单独存的声音比对开关 */
const LEGACY_AUDIO_KEY = 'libretv:audio-skip:enabled';

function defaults(): PlayerPrefs {
  let audioSkip = true;
  try {
    const legacy = localStorage.getItem(LEGACY_AUDIO_KEY);
    if (legacy !== null) audioSkip = legacy === '1';
    else audioSkip = !(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData;
  } catch {
    // 读不到按默认
  }
  return { autoSkip: false, audioSkip, seekStep: 10, rate: 1 };
}

let cache: PlayerPrefs | null = null;
const listeners = new Set<() => void>();

export function loadPlayerPrefs(): PlayerPrefs {
  if (cache) return cache;
  const base = defaults();
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<PlayerPrefs>;
    cache = {
      autoSkip: typeof raw.autoSkip === 'boolean' ? raw.autoSkip : base.autoSkip,
      audioSkip: typeof raw.audioSkip === 'boolean' ? raw.audioSkip : base.audioSkip,
      seekStep: (SEEK_STEPS as readonly number[]).includes(raw.seekStep as number) ? (raw.seekStep as number) : base.seekStep,
      rate: (PLAYBACK_RATES as readonly number[]).includes(raw.rate as number) ? (raw.rate as number) : base.rate,
    };
  } catch {
    cache = base;
  }
  return cache;
}

export function savePlayerPrefs(patch: Partial<PlayerPrefs>): PlayerPrefs {
  cache = { ...loadPlayerPrefs(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // 存不了（隐私模式）就只在这次有效
  }
  listeners.forEach((l) => l());
  return cache;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const SERVER_PREFS: PlayerPrefs = { autoSkip: false, audioSkip: false, seekStep: 10, rate: 1 };

export function usePlayerPrefs(): PlayerPrefs {
  return useSyncExternalStore(subscribe, loadPlayerPrefs, () => SERVER_PREFS);
}

/** 测试用：清掉内存里的缓存 */
export function resetPlayerPrefsCache(): void {
  cache = null;
}
