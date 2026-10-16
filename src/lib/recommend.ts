import type { DoubanItem } from './types';
import { isAdultContent } from './cms-parser';
import { canonicalTitle } from './title-aliases';

/**
 * 首页推荐大厅的筛选如何变成豆瓣请求。
 * rexxar 的 selected_categories 在实测中会被忽略，tags 用逗号拼「题材,地区,年份」才会同时生效。
 * 年代区间（如 2015-2018）先用豆瓣的「2010年代」缩小结果，再在客户端按年份裁一刀。
 */

/** 推荐大厅每一页向豆瓣要的条数。翻页直到接口没有更多，不在这里截断总页数。 */
export const HALL_PAGE_SIZE = 20;

export type HallChannel = 'anime' | 'movie' | 'tv' | 'show' | 'doc' | 'adult';
export type HallSortKey = 'hot' | 'rate' | 'date' | 'title';
export type HallSortDir = 'asc' | 'desc';
export type HallScore = 'all' | '9' | '8' | '7';
export type HallStatus = 'all' | 'airing' | 'ended';

export interface HallSelection {
  channel: HallChannel;
  genre: string;
  area: string;
  year: string;
  sort: HallSortKey;
  score: HallScore;
  status: HallStatus;
}

export interface DoubanRequest {
  kind: 'movie' | 'tv';
  tags: string[];
  sort: 'U' | 'S' | 'R';
  score: string;
  yearRange: [number, number] | null;
  minScore: number | null;
}

const AREA_GROUPS: Record<string, string[]> = {
  华语: ['华语', '中国', '大陆', '香港', '台湾'],
  欧美: ['欧美', '美国', '英国', '法国', '德国', '意大利', '西班牙', '加拿大', '澳大利亚', '瑞典', '丹麦', '爱尔兰', '俄罗斯'],
  中国大陆: ['中国大陆', '大陆', '内地'],
  中国香港: ['中国香港', '香港'],
  中国台湾: ['中国台湾', '台湾'],
};

export function yearSelection(year: string): { tag: string | null; range: [number, number] | null } {
  if (year === '全部') return { tag: null, range: null };
  if (/^(19|20)\d{2}$/.test(year)) {
    const y = Number(year);
    return { tag: year, range: [y, y] };
  }
  if (year === '2015-2018') return { tag: '2010年代', range: [2015, 2018] };
  if (year === '2010-2014') return { tag: '2010年代', range: [2010, 2014] };
  if (year === '2000年代') return { tag: '2000年代', range: [2000, 2009] };
  if (year === '90年代') return { tag: '90年代', range: [1990, 1999] };
  if (year === '更早') return { tag: '80年代', range: [1900, 1989] };
  return { tag: null, range: null };
}

export function doubanSortCode(sort: HallSortKey): 'U' | 'S' | 'R' {
  if (sort === 'rate') return 'S';
  if (sort === 'date') return 'R';
  return 'U';
}

export function scoreRange(score: HallScore): { param: string; min: number | null } {
  if (score === '9') return { param: '9,10', min: 9 };
  if (score === '8') return { param: '8,10', min: 8 };
  if (score === '7') return { param: '7,10', min: 7 };
  return { param: '0,10', min: null };
}

/** 成人频道不走豆瓣。电影不强制加「电影」标签，路径本身就是 /movie。 */
export function buildDoubanRequest(sel: HallSelection): DoubanRequest | null {
  if (sel.channel === 'adult') return null;
  const kind = sel.channel === 'movie' || sel.channel === 'doc' ? 'movie' : 'tv';
  const base =
    sel.channel === 'anime' ? '动画' :
    sel.channel === 'tv' ? '电视剧' :
    sel.channel === 'show' ? '综艺' :
    sel.channel === 'doc' ? '纪录片' :
    null;
  const tags: string[] = [];
  if (base) tags.push(base);
  if (sel.genre !== '全部') tags.push(genreTag(sel.genre));
  if (sel.area !== '全部') tags.push(sel.area);
  const year = yearSelection(sel.year);
  if (year.tag) tags.push(year.tag);
  // 豆瓣不认「热门」这个标签，会返回 0 条。电影频道没有基础标签时用「电影」。
  if (tags.length === 0) tags.push('电影');
  const score = scoreRange(sel.score);
  return {
    kind,
    tags,
    sort: doubanSortCode(sel.sort),
    score: score.param,
    yearRange: year.range,
    minScore: score.min,
  };
}

/** 豆瓣不认的芯片词，换成它实际能搜到的标签。 */
const GENRE_TAGS: Record<string, string> = {
  机战: '机甲',
};

function genreTag(genre: string): string {
  return GENRE_TAGS[genre] ?? genre;
}

export function areaMatches(filter: string, itemArea: string): boolean {
  if (filter === '全部') return true;
  const keys = AREA_GROUPS[filter] ?? [filter];
  return keys.some((key) => itemArea.includes(key));
}

export function deriveStatus(
  input: { episodesInfo?: string; year?: string; fromCalendar?: boolean; hasRating?: boolean },
  nowYear: number
): 'airing' | 'ended' | undefined {
  if (input.fromCalendar) return 'airing';
  const text = input.episodesInfo ?? '';
  // 「47集全」是豆瓣常见的完结写法，不只「全47集」
  if (/完结|已完结|全集|全\d+\s*[集话期]|\d+\s*[集话期]全/.test(text)) return 'ended';
  const year = parseInt(input.year ?? '', 10);
  if (/更新|连载/.test(text)) {
    // 豆瓣很多旧番（如 2023《迷宫饭》）的 episodes_info 长期停留在「更新至14集」未改。
    // 若距今已 ≥3 年且集数 <60（非柯南/海贼王这类常青长篇），必已完结。
    if (Number.isFinite(year) && year <= nowYear - 3) {
      const epNum = parseInt(text.match(/(\d+)/)?.[1] ?? '0', 10);
      if (epNum > 0 && epNum < 60) return 'ended';
    }
    return 'airing';
  }
  if (!Number.isFinite(year) || year < 1900 || year > nowYear + 5) return undefined;
  // 今年及以后、没有集数信息、也还没有评分：多半是没开播的预告 / 年番，不能当成「已完结」
  if (year >= nowYear && input.hasRating === false) return undefined;
  // 没有「更新至」的年份条目算已完结，包括今年。
  // 若把今年一律当成连载，「2026 + 已完结」会整页被滤空，而「连载中」却全是这些片子。
  return 'ended';
}

/** 豆瓣 rexxar /movie|tv/recommend 的单条 items */
export function rexxarToItem(raw: unknown, isTv: boolean, nowYear: number): DoubanItem | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const row = raw as Record<string, unknown>;
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const id = row.id == null ? '' : String(row.id).trim();
  const pic = row.pic as { large?: string; normal?: string } | undefined;
  const cover = (typeof pic?.large === 'string' && pic.large) || (typeof pic?.normal === 'string' && pic.normal) || '';
  if (!title || !id || !cover) return undefined;

  const subtitle = typeof row.card_subtitle === 'string' ? row.card_subtitle : '';
  const parts = subtitle.split('/').map((part) => part.trim());
  const yearFromSub = parts[0] && /^\d{4}$/.test(parts[0]) ? parts[0] : undefined;
  const yearField = yearText(row.year);
  const year = yearField || yearFromSub;
  const area = parts[1] || undefined;
  const genres = parts[2] || undefined;
  const episodes = typeof row.episodes_info === 'string' ? row.episodes_info.trim() : '';
  const ratingValue = (row.rating as { value?: unknown } | undefined)?.value;
  const rating =
    typeof ratingValue === 'number' && ratingValue > 0 ? String(ratingValue) : undefined;

  return {
    id,
    title,
    cover,
    rating,
    isTv,
    year,
    area,
    genres,
    remarks: episodes || undefined,
    // 电影没有连载概念，不打完结角标
    status: isTv ? deriveStatus({ episodesInfo: episodes, year, hasRating: rating !== undefined }, nowYear) : undefined,
  };
}

export interface HallFilter {
  genre: string;
  area: string;
  yearRange: [number, number] | null;
  status: HallStatus;
  /** 电影、纪录片不按连载状态筛 */
  applyStatus: boolean;
  minScore: number | null;
  hideAdult: boolean;
}

function yearText(value: unknown): string | undefined {
  if (typeof value === 'number' && value >= 1900 && value <= 2100) return String(value);
  if (typeof value === 'string' && /^\d{4}$/.test(value)) return value;
  return undefined;
}

function inYearRange(year: string | undefined, range: [number, number]): boolean {
  const y = parseInt(year ?? '', 10);
  if (!Number.isFinite(y)) return false;
  return y >= range[0] && y <= range[1];
}

export function filterHallItems(items: DoubanItem[], filter: HallFilter): DoubanItem[] {
  return items.filter((item) => {
    if (filter.hideAdult && (isAdultContent(item.title) || isAdultContent(item.genres) || isAdultContent(item.remarks))) {
      return false;
    }
    // 没解析出年份就留着：请求里已经带了年份标签。解析出来且落在区间外才丢掉。
    if (filter.yearRange && item.year && !inYearRange(item.year, filter.yearRange)) return false;
    // 地区、题材都不再按副标题抠字。豆瓣「热血」的副标题常是「动作 奇幻」，
    // 「华语」的副标题常是「中国大陆」，再滤一遍会把整页清空。
    if (filter.minScore != null) {
      const score = parseFloat(item.rating ?? '');
      if (!Number.isFinite(score) || score < filter.minScore) return false;
    }
    if (filter.applyStatus && filter.status === 'airing' && item.status !== 'airing') return false;
    if (filter.applyStatus && filter.status === 'ended' && item.status !== 'ended') return false;
    return true;
  });
}

/**
 * 用 Bangumi 当周实际放送表交叉校准豆瓣条目的「连载 / 完结」状态：
 * - 在当周放送表中的番剧 → 必为 airing；
 * - 豆瓣标了 airing（残留「更新至N集」），但上映年份早于今年、集数 <60 且已不在当周放送表中 → 修正为 ended。
 */
export function reconcileStatusWithCalendar(
  items: DoubanItem[],
  calendar: DoubanItem[],
  nowYear: number
): DoubanItem[] {
  if (calendar.length === 0) return items;
  const airingKeys = new Set(calendar.map((c) => canonicalTitle(c.title)).filter(Boolean));
  return items.map((item) => {
    const key = canonicalTitle(item.title);
    if (key && airingKeys.has(key)) {
      return item.status === 'airing' ? item : { ...item, status: 'airing' };
    }
    if (item.status === 'airing') {
      const year = parseInt(item.year ?? '', 10);
      const epNum = parseInt(item.remarks?.match(/(\d+)/)?.[1] ?? '0', 10);
      if (Number.isFinite(year) && year < nowYear && epNum < 60) {
        return { ...item, status: 'ended' };
      }
    }
    return item;
  });
}

/** 本周放送去重后与豆瓣结果融合，并用放送表交叉校准连载状态。 */
export function mergeAiringCalendar(douban: DoubanItem[], calendar: DoubanItem[], nowYear: number): DoubanItem[] {
  if (calendar.length === 0) return douban;
  const reconciledDouban = reconcileStatusWithCalendar(douban, calendar, nowYear);
  const seen = new Set(reconciledDouban.map((item) => item.title.trim()));
  const extra = calendar
    .filter((item) => !seen.has(item.title.trim()))
    .map((item) => ({
      ...item,
      status: 'airing' as const,
      area: item.area || '日本',
      year: item.year || String(nowYear),
      isTv: true,
    }));
  return [...extra, ...reconciledDouban];
}

export function sortHallItems<T extends { title?: string; name?: string; rating?: string; year?: string }>(
  items: T[],
  key: HallSortKey,
  dir: HallSortDir
): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      // 热度没有独立分数，降序就是接口原来的顺序
      if (key === 'hot') return (a.index - b.index) * -sign;
      if (key === 'title') {
        const cmp = (a.item.title || a.item.name || '').localeCompare(b.item.title || b.item.name || '', 'zh');
        return cmp === 0 ? a.index - b.index : cmp * sign;
      }
      const av = key === 'rate' ? positiveNum(a.item.rating) : positiveNum(a.item.year);
      const bv = key === 'rate' ? positiveNum(b.item.rating) : positiveNum(b.item.year);
      if (av == null && bv == null) return a.index - b.index;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av === bv ? a.index - b.index : (av - bv) * sign;
    })
    .map((row) => row.item);
}

function positiveNum(value: string | undefined): number | null {
  if (!value) return null;
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}
