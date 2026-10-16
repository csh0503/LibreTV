/**
 * 首页「货架」目录（Netflix 式的行）。
 * 只放元数据，客户端和服务端共用；每一行的取数逻辑在 shelves.ts。
 * 顺序就是页面顺序，同一部作品只出现在最靠前的那一行。
 */
export type ShelfChannel = 'anime' | 'movie' | 'tv' | 'show' | 'doc';

export interface ShelfDef {
  id: string;
  title: string;
  /** 点击后记入口味画像用的频道 */
  channel: ShelfChannel;
}

export const SHELF_DEFS: ShelfDef[] = [
  { id: 'hot-movies', title: '热门电影', channel: 'movie' },
  { id: 'cn-tv', title: '华语热剧', channel: 'tv' },
  { id: 'anime-airing', title: '日漫新番', channel: 'anime' },
  { id: 'guoman', title: '国漫热播', channel: 'anime' },
  { id: 'kr-jp-tv', title: '日韩剧集', channel: 'tv' },
  { id: 'us-tv', title: '欧美剧集', channel: 'tv' },
  { id: 'variety', title: '综艺热播', channel: 'show' },
  { id: 'acclaimed', title: '口碑佳作', channel: 'movie' },
  { id: 'g-crime', title: '悬疑 · 犯罪', channel: 'tv' },
  { id: 'g-scifi', title: '科幻 · 奇幻', channel: 'tv' },
  { id: 'g-romance', title: '爱情 · 治愈', channel: 'movie' },
  { id: 'g-comedy', title: '轻松喜剧', channel: 'tv' },
  { id: 'g-action', title: '动作 · 冒险', channel: 'movie' },
  { id: 'doc', title: '纪录片精选', channel: 'doc' },
];

export function isShelfId(id: string): boolean {
  return SHELF_DEFS.some((d) => d.id === id);
}

/** 季数 / 副标题归一，让「某某 第二季」和「某某」在整页里只占一个位置 */
const SEASON_SUFFIX = /\s*(?:第[一二三四五六七八九十百\d]+[季部篇期]|(?:Season|Part|Part\.)\s*\d+|[ⅠⅡⅢⅣⅤⅥ]+)\s*$/i;
/** 剧集常把季数直接写成结尾数字（「守护解放西5」）；电影续集（「疯狂动物城2」）是另一部作品，不归并 */
const TV_TRAILING_NUMBER = /(?<=[一-龥])\s*[2-9]\d?$/;

export function shelfDedupeKey(title: string, isTv = false): string {
  let t = title.trim();
  // 「第三季 Part 2」这类叠在一起的后缀逐层剥掉
  for (let prev = ''; prev !== t; ) {
    prev = t;
    t = t.replace(SEASON_SUFFIX, '');
    if (isTv) t = t.replace(TV_TRAILING_NUMBER, '');
  }
  return t.replace(/[\s·:：!！?？,，.。\-—~～]+/g, '').toLowerCase();
}

/** 整页去重用的作品键 */
export function shelfItemKey(item: { title: string; isTv?: boolean }): string {
  return shelfDedupeKey(item.title, item.isTv);
}

/** 「浏览全部」等网格里同一系列只留第一张（按当前排序靠前的那季） */
export function dedupeSeasons<T extends { title: string; isTv?: boolean }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = shelfItemKey(item);
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
