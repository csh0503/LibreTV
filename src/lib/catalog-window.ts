import type { DoubanItem } from './types';

/**
 * 默认片库（热度、没选年份）要达到的程度：
 * 这一页只回答「现在看什么」，不回答「史上有什么」。
 * - 动漫：近两年开播，或 60 天内还有新集（海贼王这种长篇留着，EVA 这种停更的不留）
 * - 电影：近三年上映
 * - 剧集、综艺、纪录片：近三年开播，或 150 天内还有新集
 * 没有年份也没有最新一集日期的先留着，避免一整页被误删空。
 * 高分、最新、指定年份、已完结：那是档案，旧作可以出现。
 */
export type CatalogLane = 'anime' | 'movie' | 'series';

export function catalogLane(tags: string[], kind: 'tv' | 'movie'): CatalogLane {
  if (tags.includes('动画')) return 'anime';
  if (kind === 'movie' && !tags.includes('纪录片')) return 'movie';
  return 'series';
}

export function isCurrentCatalogItem(item: DoubanItem, lane: CatalogLane, now = Date.now()): boolean {
  const year = item.yearSoft ? NaN : parseInt(item.year ?? '', 10);
  const nowYear = new Date(now + 8 * 3600_000).getUTCFullYear();
  const aired = item.lastAired ? Date.parse(item.lastAired) : NaN;
  const days = Number.isFinite(aired) ? (now - aired) / 86_400_000 : NaN;
  const recent = (within: number) => Number.isFinite(days) && days >= -1 && days <= within;
  const premiered = (span: number) => Number.isFinite(year) && year >= nowYear - span && year <= nowYear + 1;

  if (lane === 'anime') {
    if (recent(60)) return true;
    if (premiered(1)) return true;
    return !Number.isFinite(year) && !Number.isFinite(days);
  }
  if (lane === 'movie') {
    if (premiered(2)) return true;
    return !Number.isFinite(year);
  }
  if (recent(150)) return true;
  if (premiered(2)) return true;
  return !Number.isFinite(year) && !Number.isFinite(days);
}
