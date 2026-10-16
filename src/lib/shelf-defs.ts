/**
 * 首页「货架」目录（Netflix 式的行）。
 * 只放元数据，客户端和服务端共用；每一行的取数逻辑在 shelves.ts。
 * 顺序就是页面顺序，同一部作品只出现在最靠前的那一行。
 */
export type ShelfChannel = 'anime' | 'movie' | 'tv' | 'show' | 'doc';

export interface ShelfDef {
  id: string;
  title: string;
  hint?: string;
  /** 点击后记入口味画像用的频道 */
  channel: ShelfChannel;
}

export const SHELF_DEFS: ShelfDef[] = [
  { id: 'hot-movies', title: '热门电影', hint: '豆瓣 · B站 · TMDB 综合', channel: 'movie' },
  { id: 'cn-tv', title: '华语热剧', hint: '豆瓣 · 百度 · B站综合', channel: 'tv' },
  { id: 'anime-airing', title: '日漫新番', hint: 'Bangumi · B站 · 豆瓣综合', channel: 'anime' },
  { id: 'guoman', title: '国漫热播', hint: 'B站 · 豆瓣综合', channel: 'anime' },
  { id: 'kr-jp-tv', title: '日韩剧集', channel: 'tv' },
  { id: 'us-tv', title: '欧美剧集', channel: 'tv' },
  { id: 'variety', title: '综艺热播', hint: '豆瓣热门 · 口碑综艺', channel: 'show' },
  { id: 'acclaimed', title: '口碑佳作', hint: '本周豆瓣口碑榜', channel: 'movie' },
  { id: 'g-crime', title: '悬疑 · 犯罪', hint: 'TMDB 按题材', channel: 'tv' },
  { id: 'g-scifi', title: '科幻 · 奇幻', hint: 'TMDB 按题材', channel: 'tv' },
  { id: 'g-romance', title: '爱情 · 治愈', hint: 'TMDB 按题材', channel: 'movie' },
  { id: 'g-comedy', title: '轻松喜剧', hint: 'TMDB 按题材', channel: 'tv' },
  { id: 'g-action', title: '动作 · 冒险', hint: 'TMDB 按题材', channel: 'movie' },
  { id: 'doc', title: '纪录片精选', hint: 'B站 · TMDB', channel: 'doc' },
];

export function isShelfId(id: string): boolean {
  return SHELF_DEFS.some((d) => d.id === id);
}

/** 季数 / 副标题归一，让「某某 第二季」和「某某」在整页里只占一个位置 */
const SEASON_SUFFIX = /\s*(?:第[一二三四五六七八九十百\d]+[季部篇期]|(?:Season|Part)\s*\d+|[ⅠⅡⅢⅣⅤⅥ]+)\s*$/gi;
export function shelfDedupeKey(title: string): string {
  return title.replace(SEASON_SUFFIX, '').replace(/[\s·:：!！?？,，.。\-—~～]+/g, '').toLowerCase();
}
