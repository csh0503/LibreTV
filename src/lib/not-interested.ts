'use client';

import { useSyncExternalStore } from 'react';
import { markProfileDirty } from './profile-session';
import { workKeyOf } from './history-work';

/**
 * 「不再推荐这部」：误点进去的、看了不喜欢的。按设定档记在本机，并放进设定档包裹带走。
 * 标了以后：不再当作你的口味（「因为你看过《某某》」不会拿它当由头），推荐行和首页货架不再出现它。
 * 取消也留下一条（on: false），这样另一台较新的取消能盖过较早的标记。
 */

export interface NotInterestedMark {
  /** 规范化后的片名 */
  title: string;
  at: number;
  on: boolean;
}

const keyOf = (profileId: string) => `libretv:not-interested:v2:${profileId}`;
const legacyKeyOf = (profileId: string) => `libretv:not-interested:v1:${profileId}`;
const EMPTY: ReadonlySet<string> = new Set();
const cache = new Map<string, NotInterestedMark[]>();
const listeners = new Set<() => void>();
const MAX_MARKS = 500;

export function mergeNotInterestedMarks(
  local: NotInterestedMark[],
  remote: NotInterestedMark[] | undefined,
): NotInterestedMark[] {
  // 旧包裹没有这个字段：本机名单原样留下
  if (!remote) return local;
  const byTitle = new Map<string, NotInterestedMark>();
  for (const mark of [...local, ...remote]) {
    const title = workKeyOf(mark.title);
    if (!title || typeof mark.at !== 'number') continue;
    const next = { title, at: mark.at, on: Boolean(mark.on) };
    const prev = byTitle.get(title);
    if (!prev || next.at > prev.at || (next.at === prev.at && prev.on && !next.on)) byTitle.set(title, next);
  }
  return [...byTitle.values()];
}

function activeSet(marks: NotInterestedMark[]): ReadonlySet<string> {
  const on = marks.filter((mark) => mark.on).map((mark) => mark.title);
  return on.length > 0 ? new Set(on) : EMPTY;
}

function readStored(profileId: string): NotInterestedMark[] {
  if (!profileId || typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(keyOf(profileId));
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return mergeNotInterestedMarks([], parsed as NotInterestedMark[]);
    }
    const legacy = JSON.parse(localStorage.getItem(legacyKeyOf(profileId)) || 'null') as unknown;
    if (Array.isArray(legacy)) {
      return legacy
        .filter((item): item is string => typeof item === 'string')
        .map((title) => ({ title: workKeyOf(title), at: 0, on: true }))
        .filter((mark) => mark.title);
    }
  } catch {
    // 读不到当作空
  }
  return [];
}

export function loadNotInterestedMarks(profileId: string): NotInterestedMark[] {
  if (!profileId) return [];
  const hit = cache.get(profileId);
  if (hit) return hit;
  const marks = readStored(profileId);
  cache.set(profileId, marks);
  return marks;
}

export function loadNotInterested(profileId: string): ReadonlySet<string> {
  return activeSet(loadNotInterestedMarks(profileId));
}

function capMarks(marks: NotInterestedMark[]): NotInterestedMark[] {
  if (marks.length <= MAX_MARKS) return marks;
  const sorted = [...marks].sort((a, b) => a.at - b.at);
  const off = sorted.filter((mark) => !mark.on);
  const on = sorted.filter((mark) => mark.on);
  const drop = off.length >= sorted.length - MAX_MARKS ? off : [...off, ...on];
  const dropped = new Set(drop.slice(0, sorted.length - MAX_MARKS));
  return sorted.filter((mark) => !dropped.has(mark));
}

function writeMarks(profileId: string, marks: NotInterestedMark[], dirty: boolean) {
  const next = capMarks(marks);
  cache.set(profileId, next);
  try {
    localStorage.setItem(keyOf(profileId), JSON.stringify(next));
  } catch {
    // 存不了就只在这次有效
  }
  listeners.forEach((l) => l());
  if (dirty) markProfileDirty();
}

/** 换设备同步进来时用。不在这里标脏；调用方决定要不要再上传。 */
export function replaceNotInterestedMarks(profileId: string, marks: NotInterestedMark[]) {
  if (!profileId || typeof localStorage === 'undefined') return;
  writeMarks(profileId, marks, false);
}

function touch(profileId: string, titles: string[], on: boolean) {
  if (!profileId) return;
  const next = new Map(loadNotInterestedMarks(profileId).map((mark) => [mark.title, mark]));
  const at = Date.now();
  for (const title of titles) {
    const key = workKeyOf(title);
    if (key) next.set(key, { title: key, at, on });
  }
  writeMarks(profileId, [...next.values()], true);
}

export function markNotInterested(profileId: string, titles: string[]) {
  touch(profileId, titles, true);
}

export function unmarkNotInterested(profileId: string, titles: string[]) {
  touch(profileId, titles, false);
}

export function isNotInterested(set: ReadonlySet<string>, title: string): boolean {
  return set.size > 0 && set.has(workKeyOf(title));
}

export function useNotInterested(profileId: string): ReadonlySet<string> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => loadNotInterested(profileId),
    () => EMPTY,
  );
}
