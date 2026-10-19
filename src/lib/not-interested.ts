'use client';

import { useSyncExternalStore } from 'react';
import { canonicalTitle } from './title-aliases';

/**
 * 「不再推荐这部」：误点进去的、看了不喜欢的。按设定档存在这台设备（片名规范化后）。
 * 标了以后：不再当作你的口味（「因为你看过《某某》」不会拿它当由头），推荐行和首页货架不再出现它。
 */

const keyOf = (profileId: string) => `libretv:not-interested:v1:${profileId}`;
const EMPTY: ReadonlySet<string> = new Set();
const cache = new Map<string, ReadonlySet<string>>();
const listeners = new Set<() => void>();

export function loadNotInterested(profileId: string): ReadonlySet<string> {
  if (!profileId || typeof localStorage === 'undefined') return EMPTY;
  const hit = cache.get(profileId);
  if (hit) return hit;
  let set: ReadonlySet<string> = EMPTY;
  try {
    const raw = JSON.parse(localStorage.getItem(keyOf(profileId)) || '[]') as unknown;
    if (Array.isArray(raw)) set = new Set(raw.filter((x): x is string => typeof x === 'string'));
  } catch {
    // 读不到当作空
  }
  cache.set(profileId, set);
  return set;
}

function save(profileId: string, next: Set<string>) {
  cache.set(profileId, next);
  try {
    // 最多记 500 部，太早的丢掉
    localStorage.setItem(keyOf(profileId), JSON.stringify([...next].slice(-500)));
  } catch {
    // 存不了就只在这次有效
  }
  listeners.forEach((l) => l());
}

export function markNotInterested(profileId: string, titles: string[]) {
  if (!profileId) return;
  const next = new Set(loadNotInterested(profileId));
  for (const t of titles) {
    const key = canonicalTitle(t);
    if (key) next.add(key);
  }
  save(profileId, next);
}

export function unmarkNotInterested(profileId: string, titles: string[]) {
  if (!profileId) return;
  const next = new Set(loadNotInterested(profileId));
  for (const t of titles) next.delete(canonicalTitle(t));
  save(profileId, next);
}

export function isNotInterested(set: ReadonlySet<string>, title: string): boolean {
  return set.size > 0 && set.has(canonicalTitle(title));
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
