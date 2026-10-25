import { afterEach, describe, expect, it, vi } from 'vitest';
import { readHotList, readShelfBatch, rememberHotList, rememberShelf } from './view-cache';
import type { DoubanItem } from './types';

const store = new Map<string, string>();

afterEach(() => {
  store.clear();
  vi.unstubAllGlobals();
});

function installStorage() {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  });
}

const item = (id: string): DoubanItem => ({ id, title: id, cover: `${id}.jpg`, rating: '8' });

describe('首页上次的内容', () => {
  it('热榜和货架记下以后，下一次能原样读出来', () => {
    installStorage();
    rememberHotList('realtime_all', [item('航海王')]);
    rememberShelf('hot-movies', [item('电影')]);
    expect(readHotList('realtime_all')?.map((row) => row.title)).toEqual(['航海王']);
    expect(readShelfBatch(['hot-movies', 'missing'])?.shelves).toEqual([
      { id: 'hot-movies', items: [expect.objectContaining({ title: '电影' })] },
    ]);
  });
});
