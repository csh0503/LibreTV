/**
 * 首页上次看到的热榜和货架。存在这台浏览器里。
 * 再打开时先把这份画出来，新数据回来再换上，不用盯着骨架屏等上游。
 * 只留能画卡片的字段，一行最多 16 张，避免把 localStorage 撑满。
 */

import type { DoubanItem } from './types';

const PREFIX = 'libretv:view:v1:';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 16;

export function emptySubscribe(): () => void {
  return () => {};
}

const memory = new Map<string, unknown>();
const missing = new Set<string>();
const shelfBatches = new Map<string, { shelves: { id: string; items: DoubanItem[] }[] } | undefined>();

function trimItem(item: DoubanItem): DoubanItem {
  return {
    id: item.id,
    title: item.title,
    cover: item.cover,
    backdrop: item.backdrop,
    rating: item.rating,
    isTv: item.isTv,
    year: item.year,
    area: item.area,
    genres: item.genres,
    status: item.status,
    statusGuessed: item.statusGuessed,
    remarks: item.remarks,
    originalTitle: item.originalTitle,
  };
}

export function readView<T>(key: string): T | undefined {
  if (memory.has(key)) return memory.get(key) as T;
  if (missing.has(key) || typeof localStorage === 'undefined') return undefined;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) {
      missing.add(key);
      return undefined;
    }
    const parsed = JSON.parse(raw) as { at?: number; value?: T };
    if (!parsed || typeof parsed.at !== 'number' || Date.now() - parsed.at > MAX_AGE_MS) {
      localStorage.removeItem(PREFIX + key);
      missing.add(key);
      return undefined;
    }
    memory.set(key, parsed.value);
    return parsed.value;
  } catch {
    missing.add(key);
    return undefined;
  }
}

export function writeView(key: string, value: unknown): void {
  memory.set(key, value);
  missing.delete(key);
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ at: Date.now(), value }));
  } catch {
    // 配额满了就只留在这次内存里
  }
}

export function rememberHotList(id: string, items: DoubanItem[]): void {
  if (items.length === 0) return;
  writeView(`hot:${id}`, items.slice(0, MAX_ITEMS).map(trimItem));
}

export function readHotList(id: string): DoubanItem[] | undefined {
  const items = readView<DoubanItem[]>(`hot:${id}`);
  return items && items.length > 0 ? items : undefined;
}

export function rememberShelf(id: string, items: DoubanItem[]): void {
  if (items.length === 0) return;
  shelfBatches.clear();
  writeView(`shelf:${id}`, items.slice(0, MAX_ITEMS).map(trimItem));
}

export function readShelfBatch(ids: string[]): { shelves: { id: string; items: DoubanItem[] }[] } | undefined {
  const key = ids.join(',');
  if (shelfBatches.has(key)) return shelfBatches.get(key);
  const shelves = ids.flatMap((id) => {
    const items = readView<DoubanItem[]>(`shelf:${id}`);
    return items && items.length > 0 ? [{ id, items }] : [];
  });
  const value = shelves.length > 0 ? { shelves } : undefined;
  shelfBatches.set(key, value);
  return value;
}
