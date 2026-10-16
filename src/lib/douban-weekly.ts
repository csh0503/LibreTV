import type { DoubanItem } from './types';
import { judgeStatus, looksUnreleased } from './title-status';
import { fetchUpstream, getCache, setCache } from './fetch-utils';
import { canonicalTitle } from './title-aliases';
import { fetchBangumiHotAiring } from './bangumi';
import { dropUnreleased, fetchUnreleasedIndex } from './unreleased';

/**
 * 全网实时影视热榜聚合（多源合一 + 自动降级）：
 * 1. 豆瓣官方直连 subject_collection 实时热门与口碑系列（免 Key，含年代/地区/题材/主演/热评）
 * 2. Bilibili PGC 实时三日热度榜（免 Key，含国创/日番/纪录片/影视、16:9 横版海报、更新集数与播放量）
 * 3. 60s API 聚合（百度实时热播剧榜 + 豆瓣周榜兜底）
 * 4. TMDB 全球实时趋势榜（配置 TMDB_API_KEY 时启用，含 16:9 高清剧照与中文简介；未配置时平滑回退全球热榜）
 * 5. realtime_all：全网实时风向标（多源头部交叉去重融合，供首页大图轮播与综合热榜使用）
 */

const REALTIME_CACHE_TTL = 15 * 60 * 1000;
const WEEKLY_CACHE_TTL = 60 * 60 * 1000;
const UA = 'LibreTV (+https://github.com/LibreSpark/LibreTV)';
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const FALLBACK_BASE = 'https://60s.viki.moe';

function apiBase(): string {
  return (process.env['60S_API_BASE'] || 'https://60s.crystelf.top').replace(/\/+$/, '');
}

/** 支持的全部榜单标识（向后兼容旧版 6 个 ID，新增实时多源 ID） */
export const HOT_LIST_IDS = [
  'realtime_all',
  'douban_tv_realtime',
  'douban_movie_realtime',
  'bili_guochuang',
  'bili_bangumi',
  'douban_tv_domestic',
  'douban_tv_american',
  'douban_tv_korean',
  'douban_tv_japanese',
  'douban_anime_hot',
  'douban_show_hot',
  'bili_doc',
  'bili_tv',
  'bili_movie',
  'bili_show',
  'tmdb_trending',
  'douban_movie_weekly',
  'douban_tv_chinese',
  'douban_tv_global',
  'douban_show_chinese',
  'douban_show_global',
  'baidu_teleplay',
] as const;

export type HotListId = (typeof HOT_LIST_IDS)[number];

export function isHotListId(id: string): id is HotListId {
  return (HOT_LIST_IDS as readonly string[]).includes(id);
}

/** 豆瓣 subject_collection 集合映射（实时榜 + 周口碑榜） */
const DOUBAN_COLLECTION_MAP: Partial<
  Record<HotListId, { collection: string; isTv: boolean; label: string }>
> = {
  douban_tv_realtime: { collection: 'tv_real_time_hotest', isTv: true, label: '豆瓣实时剧集' },
  douban_movie_realtime: { collection: 'movie_real_time_hotest', isTv: false, label: '豆瓣实时电影' },
  douban_tv_domestic: { collection: 'tv_domestic', isTv: true, label: '热播国产剧' },
  douban_tv_american: { collection: 'tv_american', isTv: true, label: '热播欧美剧' },
  douban_tv_korean: { collection: 'tv_korean', isTv: true, label: '热播韩剧' },
  douban_tv_japanese: { collection: 'tv_japanese', isTv: true, label: '热播日剧' },
  douban_anime_hot: { collection: 'tv_animation', isTv: true, label: '热门动漫' },
  douban_show_hot: { collection: 'show_hot', isTv: true, label: '热门综艺' },
  douban_movie_weekly: { collection: 'movie_weekly_best', isTv: false, label: '一周口碑电影' },
  douban_tv_chinese: { collection: 'tv_chinese_best_weekly', isTv: true, label: '华语口碑剧集' },
  douban_tv_global: { collection: 'tv_global_best_weekly', isTv: true, label: '全球口碑剧集' },
  douban_show_chinese: { collection: 'show_chinese_best_weekly', isTv: true, label: '国内口碑综艺' },
  douban_show_global: { collection: 'show_global_best_weekly', isTv: true, label: '海外口碑综艺' },
};

/** 60s API 豆瓣周榜路径（作为直连失败时的自动降级兜底） */
const DOUBAN_WEEKLY_CATEGORY: Partial<Record<HotListId, string>> = {
  douban_movie_weekly: 'movie',
  douban_tv_chinese: 'tv_chinese',
  douban_tv_global: 'tv_global',
  douban_show_chinese: 'show_chinese',
  douban_show_global: 'show_global',
};

/** B站 PGC 排行榜 season_type 映射：1=番剧, 2=电影, 3=纪录片, 4=国创, 5=电视剧, 7=综艺 */
const BILI_SEASON_TYPE_MAP: Partial<
  Record<HotListId, { seasonType: number; isTv: boolean; label: string; area?: string; genres?: string }>
> = {
  bili_bangumi: { seasonType: 1, isTv: true, label: 'B站番剧热播', area: '日本', genres: '动画 番剧' },
  bili_guochuang: { seasonType: 4, isTv: true, label: 'B站国创热播', area: '中国大陆', genres: '动画 国创' },
  bili_doc: { seasonType: 3, isTv: true, label: 'B站纪录片榜', genres: '纪录片' },
  bili_tv: { seasonType: 5, isTv: true, label: 'B站热播剧集', genres: '剧情' },
  bili_movie: { seasonType: 2, isTv: false, label: 'B站热播电影' },
  bili_show: { seasonType: 7, isTv: true, label: 'B站综艺热播', genres: '综艺' },
};

// —— 原始接口结构 ——

export interface DoubanWeeklyRaw {
  id?: number | string;
  title?: string;
  rating?: number;
  cover_proxy?: string;
  cover?: string;
}

export interface BaiduTeleplayRaw {
  title?: string;
  cover?: string | null;
  desc?: string;
  score_desc?: string;
}

export interface DoubanCollectionItemRaw {
  id?: string | number;
  title?: string;
  year?: string | number;
  info?: string;
  card_subtitle?: string;
  episodes_info?: string;
  description?: string;
  recommended_reason?: string;
  pic?: { large?: string; normal?: string };
  cover?: { url?: string };
  rating?: { value?: number };
  comments?: { comment?: string }[];
}

export interface BiliRankItemRaw {
  season_id?: number | string;
  title?: string;
  cover?: string;
  ss_horizontal_cover?: string;
  rating?: string;
  new_ep?: { cover?: string; index_show?: string };
  icon_font?: { text?: string };
  stat?: { view?: number; follow?: number };
}

export const DEFAULT_TMDB_API_KEY = 'fd39301e13dd749a3d953f180444b3f3';

export function getTmdbApiKey(): string {
  return (process.env.TMDB_API_KEY || process.env.NEXT_PUBLIC_TMDB_API_KEY || DEFAULT_TMDB_API_KEY).trim();
}

export const TMDB_ID_TO_GENRE: Record<number, string> = {
  28: '动作', 12: '冒险', 16: '动画', 35: '喜剧', 80: '犯罪', 99: '纪录片',
  18: '剧情', 10751: '家庭', 14: '奇幻', 36: '历史', 27: '恐怖', 10402: '音乐',
  9648: '悬疑', 10749: '爱情', 878: '科幻', 53: '惊悚', 10752: '战争',
  10759: '动作冒险', 10762: '少儿', 10764: '真人秀', 10765: '科幻奇幻',
  10767: '脱口秀', 10768: '战争政治',
};

export const TMDB_CODE_TO_AREA: Record<string, string> = {
  CN: '中国大陆', HK: '中国香港', TW: '中国台湾', JP: '日本', KR: '韩国',
  US: '美国', GB: '英国', FR: '法国', DE: '德国', TH: '泰国', IN: '印度',
  CA: '加拿大', AU: '澳大利亚', ES: '西班牙', IT: '意大利',
};

export interface TmdbTrendingRaw {
  id?: number | string;
  title?: string;
  name?: string;
  media_type?: 'movie' | 'tv' | string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  release_date?: string;
  first_air_date?: string;
  overview?: string;
  genre_ids?: number[];
  origin_country?: string[];
}

interface SixtyResponse<T> {
  code?: number;
  data?: T;
}

function ensureHttps(url: string | undefined | null): string | undefined {
  if (!url || typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^http:\/\//i, 'https://');
}

/** 豆瓣周榜条目（60s API） → DoubanItem；缺标题或封面的脏数据丢弃 */
export function doubanWeeklyToItem(raw: DoubanWeeklyRaw, isTv: boolean): DoubanItem | undefined {
  const cover = raw.cover || raw.cover_proxy;
  if (!raw.id || !raw.title || !cover) return undefined;
  return {
    id: String(raw.id),
    title: raw.title,
    cover,
    rating: raw.rating && raw.rating > 0 ? String(raw.rating) : undefined,
    isTv,
  };
}

/** 百度热播剧条目 → DoubanItem；保留热度值和剧情简介 */
export function baiduTeleplayToItem(raw: BaiduTeleplayRaw, index: number): DoubanItem | undefined {
  if (!raw.title || !raw.cover) return undefined;
  const item: DoubanItem = {
    id: `baidu_${index}`,
    title: raw.title,
    cover: raw.cover,
    isTv: true,
  };
  if (raw.score_desc) item.remarks = `🔥 ${raw.score_desc}热度`;
  if (raw.desc) item.subtitle = raw.desc.trim();
  if (raw.score_desc || raw.desc) item.sourceLabel = '百度热播';
  return item;
}

/** 豆瓣官方 subject_collection 条目 → DoubanItem（含年代、地区、题材、演员/热评看点） */
export function doubanCollectionToItem(
  raw: DoubanCollectionItemRaw,
  isTv: boolean,
  sourceLabel?: string
): DoubanItem | undefined {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const id = raw.id != null ? String(raw.id) : '';
  const cover = ensureHttps(raw.pic?.large || raw.pic?.normal || raw.cover?.url);
  if (!title || !id || !cover) return undefined;

  const sub = (typeof raw.card_subtitle === 'string' && raw.card_subtitle) || '';
  const info = (typeof raw.info === 'string' && raw.info) || '';
  const parts = (sub || info)
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);

  let year: string | undefined =
    typeof raw.year === 'string' && /^\d{4}$/.test(raw.year)
      ? raw.year
      : typeof raw.year === 'number'
        ? String(raw.year)
        : undefined;
  let offset = 0;
  if (parts[0] && /^\d{4}$/.test(parts[0])) {
    if (!year) year = parts[0];
    offset = 1;
  }
  const area = parts[offset] || undefined;
  const genres = parts[offset + 1] || undefined;
  const castOrStaff = parts.slice(offset + 2).join(' · ');

  const ratingVal = raw.rating?.value;
  const rating =
    typeof ratingVal === 'number' && ratingVal > 0 ? Number(ratingVal.toFixed(1)).toString() : undefined;

  const episodes = typeof raw.episodes_info === 'string' ? raw.episodes_info.trim() : '';
  if (looksUnreleased(episodes)) return undefined;
  const status = judgeStatus({ text: episodes, isTv, year });

  const subtitle =
    (typeof raw.description === 'string' && raw.description.trim()) ||
    (typeof raw.recommended_reason === 'string' && raw.recommended_reason.trim()) ||
    castOrStaff ||
    undefined;

  const item: DoubanItem = {
    id,
    title,
    cover,
    rating,
    isTv,
    year,
    area,
    genres,
    remarks: episodes || undefined,
    status,
    subtitle,
    sourceLabel,
  };
  return item;
}

/** B站 PGC 排行榜条目 → DoubanItem（含 16:9 横版海报、评分、更新集数、播放量） */
export function biliRankToItem(
  raw: BiliRankItemRaw,
  opts: { isTv: boolean; label: string; area?: string; genres?: string }
): DoubanItem | undefined {
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const cover = ensureHttps(raw.cover);
  if (!title || !cover || !raw.season_id) return undefined;

  const backdrop = ensureHttps(raw.ss_horizontal_cover || raw.new_ep?.cover);
  const rawRating = typeof raw.rating === 'string' ? raw.rating.replace(/分$/, '').trim() : '';
  const ratingNum = parseFloat(rawRating);
  const rating = Number.isFinite(ratingNum) && ratingNum > 0 ? ratingNum.toFixed(1) : undefined;

  const indexShow = raw.new_ep?.index_show?.trim() || '';
  if (looksUnreleased(indexShow)) return undefined;
  const status = judgeStatus({ text: indexShow, isTv: opts.isTv });

  const stats: string[] = [];
  if (raw.icon_font?.text) stats.push(`${raw.icon_font.text}播放`);
  if (typeof raw.stat?.follow === 'number' && raw.stat.follow >= 10_000) {
    stats.push(`${(raw.stat.follow / 10_000).toFixed(1).replace(/\.0$/, '')}万追番`);
  }

  return {
    id: `bili_${raw.season_id}`,
    title,
    cover,
    backdrop,
    rating,
    isTv: opts.isTv,
    area: opts.area,
    genres: opts.genres,
    remarks: indexShow || undefined,
    status,
    subtitle: stats.length > 0 ? stats.join(' · ') : undefined,
    sourceLabel: opts.label,
  };
}

/** TMDB 趋势条目 → DoubanItem */
export function tmdbTrendingToItem(raw: TmdbTrendingRaw): DoubanItem | undefined {
  const title = (raw.title || raw.name || '').trim();
  if (!raw.id || !title || !raw.poster_path) return undefined;
  const cover = `https://image.tmdb.org/t/p/w500${raw.poster_path}`;
  const backdrop = raw.backdrop_path ? `https://image.tmdb.org/t/p/w1280${raw.backdrop_path}` : undefined;
  const isTv = raw.media_type === 'tv' || (!raw.title && !!raw.name);
  const dateStr = raw.release_date || raw.first_air_date || '';
  const year = /^\d{4}/.test(dateStr) ? dateStr.slice(0, 4) : undefined;
  const rating =
    typeof raw.vote_average === 'number' && raw.vote_average > 0 ? raw.vote_average.toFixed(1) : undefined;

  const genres = Array.isArray(raw.genre_ids)
    ? raw.genre_ids
        .map((id) => TMDB_ID_TO_GENRE[id])
        .filter(Boolean)
        .slice(0, 3)
        .join(' ') || undefined
    : undefined;
  const areaCode = Array.isArray(raw.origin_country) ? raw.origin_country[0] : undefined;
  const area = areaCode ? TMDB_CODE_TO_AREA[areaCode] || undefined : undefined;

  return {
    id: `tmdb_${raw.id}`,
    title,
    cover,
    backdrop,
    rating,
    isTv,
    year,
    area,
    genres,
    subtitle: raw.overview?.trim() || undefined,
    sourceLabel: 'TMDB 全球趋势',
  };
}

const CN_NUM_MAP: Record<string, number> = {
  一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10,
  'Ⅰ': 1, 'Ⅱ': 2, 'Ⅲ': 3, 'Ⅳ': 4, 'Ⅴ': 5, 'Ⅵ': 6,
};

/**
 * 提取剧集/番剧的系列主名（剥离「第一季 / 第二季 / Season 2 / Part 2 / 中配版」等后缀），
 * 用于将《咒术回战》《咒术回战 第二季》《咒术回战 第三季》折叠为同一系列。
 */
export function extractSeriesStem(title: string): string {
  const cleaned = title
    .replace(/[（(][^）)]*(?:中配|中文|日语|粤语|配音|版)[^）)]*[）)]/g, '')
    .replace(/\s+(?:中配版|中文配音|普通话版|日语版)$/g, '')
    .replace(/\s*第[一二三四五六七八九十百\d]+[季部篇期]/g, '')
    .replace(/\s*(?:Season|Part)\s*\d+/gi, '')
    .replace(/[ⅠⅡⅢⅣⅤⅥ]+$/g, '')
    .trim();
  return canonicalTitle(cleaned) || canonicalTitle(title);
}

/** 提取标题中的季数序号（默认第 1 季为 1），用于同系列多季同榜时优先推举最新一季 */
export function extractSeasonNumber(title: string): number {
  const cnMatch = title.match(/第([一二三四五六七八九十\d]+)[季部篇期]/);
  if (cnMatch) {
    const token = cnMatch[1];
    if (/^\d+$/.test(token)) return parseInt(token, 10);
    if (CN_NUM_MAP[token]) return CN_NUM_MAP[token];
  }
  const enMatch = title.match(/(?:Season|Part)\s*(\d+)/i);
  if (enMatch) return parseInt(enMatch[1], 10);
  const romanMatch = title.match(/([ⅠⅡⅢⅣⅤⅥ])/);
  if (romanMatch && CN_NUM_MAP[romanMatch[1]]) return CN_NUM_MAP[romanMatch[1]];
  return 1;
}

/** 常年霸榜的经典长青老番黑名单（在「实时风向」中剔除，避免常年霸占新番热榜） */
const EVERGREEN_SERIES_STEMS = new Set(
  [
    '名侦探柯南',
    '蜡笔小新',
    '航海王',
    '海贼王',
    '火影忍者',
    '博人传',
    '银魂',
    '犬夜叉',
    '家庭教师',
    '黑色五叶草',
    '黑色四叶草',
    '死神',
    '龙珠',
    '七龙珠',
    '哆啦A梦',
    '宝可梦',
    '数码宝贝',
    '全职猎人',
    '妖精的尾巴',
    '网球王子',
    '乌龙派出所',
    '海绵宝宝',
    '猫和老鼠',
    '熊出没',
    '喜羊羊与灰太狼',
    'JOJO的奇妙冒险',
    '新世纪福音战士',
  ].map((name) => canonicalTitle(name))
);

/**
 * Netflix 风格「实时风向」精选与系列折叠算法：
 * 1. 剔除配音重复版（如「名侦探柯南（中配）」「明日方舟 中配版」）；
 * 2. 可选剔除常年连载/经典老番（如柯南、蜡笔小新、银魂、黑色五叶草）及超长集数作品（>maxEpisodes）；
 * 3. 可选剔除已完结老旧库存番（如 B站番剧榜里混入的《全24话》旧番）；
 * 4. 同系列多季折叠（如《咒术回战》第一、二、三季同在榜时，在最高名次坑位仅保留最新一季）。
 */
export function curateRealtimeList(
  items: DoubanItem[],
  opts: {
    filterEvergreen?: boolean;
    dropEndedCatalog?: boolean;
    maxEpisodes?: number;
  } = {}
): DoubanItem[] {
  const maxEp = opts.maxEpisodes ?? 100;
  const filtered = items.filter((item) => {
    // 1. 剔除中配/配音重复版
    if (/[（(][^）)]*(?:中配|中文|配音)[^）)]*[）)]|\s(?:中配版|中文配音)/.test(item.title)) {
      return false;
    }
    const stem = extractSeriesStem(item.title);
    // 2. 剔除常青老番
    if (opts.filterEvergreen && EVERGREEN_SERIES_STEMS.has(stem)) {
      return false;
    }
    // 3. 集数上限门禁（过滤 1276 话柯南、873 话小新等超长篇）
    if (item.remarks) {
      const epMatch = item.remarks.match(/(\d+)\s*[集话期]/);
      if (epMatch) {
        const epNum = parseInt(epMatch[1], 10);
        if (epNum > maxEp) return false;
      }
    }
    // 4. 剔除旧完结库存番（保留连载中或无完结标记的新作）
    if (opts.dropEndedCatalog && item.status === 'ended') {
      return false;
    }
    return true;
  });

  // 5. 系列级合并：同一 IP 只保留一个坑位（取最高排名位置），但展示最新一季/连载中的那一季
  const groups = new Map<string, { firstIndex: number; bestItem: DoubanItem; bestScore: number }>();
  filtered.forEach((item, idx) => {
    const stem = extractSeriesStem(item.title) || canonicalTitle(item.title);
    if (!stem) return;
    const seasonNum = extractSeasonNumber(item.title);
    const airingBonus = item.status === 'airing' ? 100 : 0;
    const yearBonus = parseInt(item.year ?? '0', 10) || 0;
    const candidateScore = airingBonus + seasonNum * 10 + (yearBonus >= 2025 ? 5 : 0);

    const existing = groups.get(stem);
    if (!existing) {
      groups.set(stem, { firstIndex: idx, bestItem: item, bestScore: candidateScore });
    } else if (candidateScore > existing.bestScore) {
      existing.bestItem = item;
      existing.bestScore = candidateScore;
    }
  });

  return [...groups.values()]
    .sort((a, b) => a.firstIndex - b.firstIndex)
    .map((g) => g.bestItem);
}

/** 将多个实时榜按名次交叉穿插并按系列主名去重，让综合榜兼顾热剧、大片、国漫与日番 */
export function interleaveAndDedupeLists(lists: DoubanItem[][], limit = 24): DoubanItem[] {
  const result: DoubanItem[] = [];
  const seen = new Set<string>();
  const maxLen = Math.max(0, ...lists.map((l) => l.length));

  for (let i = 0; i < maxLen && result.length < limit; i++) {
    for (const list of lists) {
      const item = list[i];
      if (!item) continue;
      const key = extractSeriesStem(item.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(item);
      if (result.length >= limit) break;
    }
  }
  return result;
}

export type RankPlatform = 'douban' | 'bilibili' | 'baidu' | 'bangumi' | 'tmdb' | 'other';

const PLATFORM_LABEL: Record<RankPlatform, string> = {
  douban: '豆瓣',
  bilibili: 'B站',
  baidu: '百度',
  bangumi: 'Bangumi',
  tmdb: 'TMDB',
  other: '其他',
};

/** 榜单名 → 所属平台（同一平台的多个榜只算一票） */
export function platformOf(name: string): RankPlatform {
  if (/^B站/.test(name)) return 'bilibili';
  if (/百度/.test(name)) return 'baidu';
  if (/Bangumi/i.test(name)) return 'bangumi';
  if (/TMDB/i.test(name)) return 'tmdb';
  if (/豆瓣|口碑|热门综艺/.test(name)) return 'douban';
  return 'other';
}

export interface RankedSourceInput {
  name: string;
  items: DoubanItem[];
  weight?: number;
  /** 不填时按 name 推断 */
  platform?: RankPlatform;
}

/** 用于多样性配额的大类 */
export function rankCategory(item: DoubanItem): 'anime' | 'guoman' | 'doc' | 'show' | 'tv' | 'movie' {
  const genres = item.genres ?? '';
  if (/动画|番剧|国创|动漫/.test(genres)) return item.area && /中国/.test(item.area) ? 'guoman' : 'anime';
  if (/纪录/.test(genres)) return 'doc';
  if (/综艺|真人秀|脱口秀/.test(genres)) return 'show';
  return item.isTv ? 'tv' : 'movie';
}

/** 前 window 名里同一大类最多 cap 部，超出的顺延到后面（相对顺序不变） */
export function diversifyRanking(items: DoubanItem[], window = 10, cap = 4): DoubanItem[] {
  const head: DoubanItem[] = [];
  const rest: DoubanItem[] = [];
  const counts = new Map<string, number>();
  for (const item of items) {
    if (head.length < window) {
      const cat = rankCategory(item);
      const n = counts.get(cat) ?? 0;
      if (n < cap) {
        head.push(item);
        counts.set(cat, n + 1);
        continue;
      }
    }
    rest.push(item);
  }
  return [...head, ...rest];
}

/** 评分系数：7 分为中性，±2 分封顶，最多影响 ±12%；没评分不加不减 */
function ratingFactor(rating?: string): number {
  const r = parseFloat(rating ?? '');
  if (!Number.isFinite(r) || r <= 0) return 1;
  return 1 + 0.12 * Math.max(-1, Math.min(1, (r - 7) / 2));
}

/**
 * 多源综合排名（按平台分组的 Reciprocal Rank Fusion）：
 * 1. 各榜第 r 名（0-based）贡献 weight / (K + r + 1)，K = 60（RRF 常用值），名次差距被压平，靠多平台共现取胜；
 * 2. 同一平台的多个榜只取该作品在本平台的最好成绩，避免「豆瓣热剧 + 豆瓣口碑 + 豆瓣全球」被当成三源共识；
 * 3. 评分作为乘法系数（±12% 以内），连载中只做极小的平分决胜；
 * 4. 可选多样性配额：前 10 名同一大类（电影 / 剧集 / 日漫 / 国漫……）最多 4 部；
 * 5. 元数据择优合并：最新季度标题、16:9 横图、权威评分与连载状态，并生成「多源共推」标签（按平台数）。
 */
export function fuseMultiSourceRankings(
  sources: RankedSourceInput[],
  opts: {
    limit?: number;
    maxEpisodes?: number;
    filterEvergreen?: boolean;
    dropEndedCatalog?: boolean;
    diversify?: boolean;
    /** 3~24 小时前的名次（作品键 → 名次），用来算上升势头；没有就不算 */
    baseline?: Record<string, number>;
  } = {}
): DoubanItem[] {
  const limit = opts.limit ?? 24;
  const K = 60;

  interface CandidateEntry {
    item: DoubanItem;
    /** 平台 → 该作品在此平台的最好贡献分 */
    platformScores: Map<RankPlatform, number>;
    bestTitleScore: number;
    firstSeenRank: number;
  }

  const map = new Map<string, CandidateEntry>();

  for (const src of sources) {
    const weight = src.weight ?? 1;
    const platform = src.platform ?? platformOf(src.name);
    const curated = curateRealtimeList(src.items, {
      filterEvergreen: opts.filterEvergreen ?? true,
      dropEndedCatalog: opts.dropEndedCatalog,
      maxEpisodes: opts.maxEpisodes ?? 120,
    });

    curated.forEach((item, rank) => {
      const stem = rankKeyOf(item.title);
      if (!stem) return;

      const contribution = weight / (K + rank + 1);
      const seasonNum = extractSeasonNumber(item.title);
      const airingBonus = item.status === 'airing' ? 100 : 0;
      const yearNum = parseInt(item.year ?? '0', 10) || 0;
      const titleScore = airingBonus + seasonNum * 10 + (yearNum >= 2025 ? 5 : 0);

      const existing = map.get(stem);
      if (!existing) {
        map.set(stem, {
          item: { ...item },
          platformScores: new Map([[platform, contribution]]),
          bestTitleScore: titleScore,
          firstSeenRank: rank,
        });
        return;
      }
      existing.platformScores.set(platform, Math.max(existing.platformScores.get(platform) ?? 0, contribution));
      if (rank < existing.firstSeenRank) existing.firstSeenRank = rank;
      const prev = existing.item;
      const preferNewTitle = titleScore > existing.bestTitleScore;
      if (preferNewTitle) existing.bestTitleScore = titleScore;
      existing.item = {
        ...prev,
        title: preferNewTitle ? item.title : prev.title,
        cover: prev.cover || item.cover,
        backdrop: prev.backdrop || item.backdrop,
        rating: prev.rating || item.rating,
        year: (preferNewTitle ? item.year : prev.year) || prev.year || item.year,
        area: prev.area || item.area,
        genres: prev.genres || item.genres,
        isTv: prev.isTv ?? item.isTv,
        remarks:
          prev.status === 'airing' && prev.remarks
            ? prev.remarks
            : item.status === 'airing' && item.remarks
              ? item.remarks
              : prev.remarks || item.remarks,
        status:
          prev.status === 'airing' || item.status === 'airing'
            ? 'airing'
            : prev.status || item.status,
        subtitle: prev.subtitle || item.subtitle,
      };
    });
  }

  const ranked = [...map.entries()].map(([key, entry]) => {
    const base = [...entry.platformScores.values()].reduce((sum, v) => sum + v, 0);
    const airingTieBreaker = entry.item.status === 'airing' ? 1e-4 : 0;
    const finalScore = base * ratingFactor(entry.item.rating) + airingTieBreaker;
    const platforms = [...entry.platformScores.keys()].map((p) => PLATFORM_LABEL[p]);

    const sourceLabel =
      platforms.length >= 2
        ? `${platforms.slice(0, 2).join(' · ')} ${platforms.length}源共推`
        : entry.item.sourceLabel || platforms[0];

    return {
      key,
      item: { ...entry.item, sourceLabel },
      finalScore,
      firstSeenRank: entry.firstSeenRank,
    };
  });

  const byScore = (a: { finalScore: number; firstSeenRank: number }, b: { finalScore: number; firstSeenRank: number }) => {
    if (Math.abs(b.finalScore - a.finalScore) > 1e-9) return b.finalScore - a.finalScore;
    return a.firstSeenRank - b.firstSeenRank;
  };
  ranked.sort(byScore);

  // 上升势头：和基准快照比，名次往前走的轻微加分（最多 +6%，约等于往前挪 3~4 名），往后掉的轻微减分，新上榜 +3%
  const baseline = opts.baseline;
  if (baseline && Object.keys(baseline).length > 0) {
    ranked.forEach((r, i) => {
      const before = baseline[r.key];
      r.finalScore *= before === undefined ? 1.03 : momentumFactor(before - i);
    });
    ranked.sort(byScore);
  }

  const sorted = ranked.map((r) => r.item);
  const out = (opts.diversify ? diversifyRanking(sorted) : sorted).slice(0, limit);
  if (baseline && Object.keys(baseline).length > 0) {
    out.forEach((item, i) => {
      const before = baseline[rankKeyOf(item.title)];
      if (before === undefined) item.rankNew = true;
      else if (before !== i) item.rankDelta = before - i;
    });
  }
  return out;
}

/** 名次变化 → 分数系数：每升 1 名 +0.6%，±6% 封顶 */
export function momentumFactor(delta: number): number {
  return 1 + 0.06 * Math.max(-1, Math.min(1, delta / 10));
}

/** 排名里认「同一部」用的键：系列主名（去季数）→ 标准片名 */
export function rankKeyOf(title: string): string {
  return extractSeriesStem(title) || canonicalTitle(title);
}

function assertArray<T>(value: unknown, what: string): T[] {
  if (!Array.isArray(value)) throw new Error(`${what}数据异常`);
  return value as T[];
}

async function fetchSixtyJson(path: string): Promise<unknown> {
  const primary = apiBase();
  const bases = primary === FALLBACK_BASE ? [primary] : [primary, FALLBACK_BASE];

  let lastError: unknown;
  for (const base of bases) {
    try {
      const res = await fetchUpstream(`${base}${path}`, {
        timeoutMs: 8000,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`60s API 响应异常 (${res.status})`);
      return await res.json();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('60s API 请求失败');
}

async function fetchDoubanCollection(
  collection: string,
  isTv: boolean,
  sourceLabel: string,
  count = 24
): Promise<DoubanItem[]> {
  const url = `https://m.douban.com/rexxar/api/v2/subject_collection/${collection}/items?start=0&count=${count}`;
  const res = await fetchUpstream(url, {
    timeoutMs: 8000,
    headers: {
      'User-Agent': MOBILE_UA,
      Referer: 'https://m.douban.com/movie/',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`豆瓣实时榜单响应异常 (${res.status})`);
  const json = (await res.json()) as { subject_collection_items?: DoubanCollectionItemRaw[] };
  const rows = assertArray<DoubanCollectionItemRaw>(json.subject_collection_items, '豆瓣实时榜单');
  const rawItems = rows
    .map((row) => doubanCollectionToItem(row, isTv, sourceLabel))
    .filter((item): item is DoubanItem => item !== undefined);
  const items = curateRealtimeList(rawItems, { filterEvergreen: true, maxEpisodes: 120 });
  if (items.length === 0) throw new Error('豆瓣榜单数据为空');
  return items;
}

async function fetchBiliRankRaw(opts: {
  seasonType: number;
  isTv: boolean;
  label: string;
  area?: string;
  genres?: string;
}): Promise<DoubanItem[]> {
  const url = `https://api.bilibili.com/pgc/web/rank/list?day=3&season_type=${opts.seasonType}`;
  const res = await fetchUpstream(url, {
    timeoutMs: 8000,
    headers: {
      'User-Agent': DESKTOP_UA,
      Referer: 'https://www.bilibili.com/',
      Accept: 'application/json',
    },
  });
  if (!res.ok) throw new Error(`B站热播榜响应异常 (${res.status})`);
  const json = (await res.json()) as {
    code?: number;
    result?: { list?: BiliRankItemRaw[] };
    data?: { list?: BiliRankItemRaw[] };
  };
  const rawList = json.result?.list || json.data?.list;
  const rows = assertArray<BiliRankItemRaw>(rawList, 'B站热播榜');
  const rawItems = rows
    .slice(0, 50)
    .map((row) => biliRankToItem(row, opts))
    .filter((item): item is DoubanItem => item !== undefined);

  const curated = curateRealtimeList(rawItems, {
    filterEvergreen: true,
    dropEndedCatalog: opts.seasonType === 1,
    maxEpisodes: opts.seasonType === 4 ? 260 : 95,
  });
  // 番剧榜剔除已完结的旧番后常常只剩两三部（B站近 3 天热播多是补番），太少会让日漫在综合榜里几乎没有票：
  // 不够 8 部时改为「在播的排前面，热度高的完结番接在后面」
  if (curated.length >= 8) return curated;

  const fallback = curateRealtimeList(rawItems, {
    filterEvergreen: true,
    maxEpisodes: opts.seasonType === 4 ? 260 : 120,
  });
  if (fallback.length === 0) {
    if (curated.length > 0) return curated;
    throw new Error('B站热播榜为空');
  }
  return [...fallback.filter((i) => i.status !== 'ended'), ...fallback.filter((i) => i.status === 'ended')];
}

async function fetchBaiduTeleplayList(): Promise<DoubanItem[]> {
  const raw = (await fetchSixtyJson('/v2/baidu/teleplay')) as SixtyResponse<BaiduTeleplayRaw[]>;
  const items = assertArray<BaiduTeleplayRaw>(raw.data, '百度热播剧榜')
    .map((entry, i) => baiduTeleplayToItem(entry, i))
    .filter((item): item is DoubanItem => item !== undefined);
  return curateRealtimeList(items, { filterEvergreen: true });
}

async function fetchDoubanWithFallback(id: HotListId): Promise<DoubanItem[]> {
  const cfg = DOUBAN_COLLECTION_MAP[id];
  if (!cfg) throw new Error('未知豆瓣集合');
  const fallbackCategory = DOUBAN_WEEKLY_CATEGORY[id];
  try {
    return await fetchDoubanCollection(cfg.collection, cfg.isTv, cfg.label);
  } catch (primaryErr) {
    if (!fallbackCategory) throw primaryErr;
    const raw = (await fetchSixtyJson(`/v2/douban/weekly/${fallbackCategory}`)) as SixtyResponse<DoubanWeeklyRaw[]>;
    const isTv = id !== 'douban_movie_weekly';
    return assertArray<DoubanWeeklyRaw>(raw.data, '豆瓣周榜')
      .map((entry) => doubanWeeklyToItem(entry, isTv))
      .filter((item): item is DoubanItem => item !== undefined);
  }
}

async function fetchTmdbTrending(mediaType: 'all' | 'tv' | 'movie' = 'all'): Promise<DoubanItem[]> {
  const apiKey = getTmdbApiKey();
  if (!apiKey) {
    const [globalTv, realtimeMovie] = await Promise.allSettled([
      fetchDoubanWithFallback('douban_tv_global'),
      fetchDoubanWithFallback('douban_movie_realtime'),
    ]);
    const sources: RankedSourceInput[] = [];
    if (globalTv.status === 'fulfilled') sources.push({ name: '豆瓣全球口碑', items: globalTv.value, weight: 1.0 });
    if (realtimeMovie.status === 'fulfilled') sources.push({ name: '豆瓣实时电影', items: realtimeMovie.value, weight: 1.0 });
    const merged = fuseMultiSourceRankings(sources, { limit: 24 });
    if (merged.length === 0) throw new Error('全球趋势榜获取失败');
    return merged;
  }

  const isBearer = apiKey.length > 40 && apiKey.includes('.');
  const url = isBearer
    ? `https://api.themoviedb.org/3/trending/${mediaType}/day?language=zh-CN`
    : `https://api.themoviedb.org/3/trending/${mediaType}/day?language=zh-CN&api_key=${encodeURIComponent(apiKey)}`;
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' };
  if (isBearer) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetchUpstream(url, { timeoutMs: 8000, headers });
  if (!res.ok) throw new Error(`TMDB 接口响应异常 (${res.status})`);
  const json = (await res.json()) as { results?: TmdbTrendingRaw[] };
  const rows = assertArray<TmdbTrendingRaw>(json.results, 'TMDB 趋势榜');
  const items = rows
    .map((row) => tmdbTrendingToItem(row))
    .filter((item): item is DoubanItem => item !== undefined && /[\u4e00-\u9fa5]/.test(item.title));
  if (items.length === 0) throw new Error('TMDB 趋势榜为空');
  return curateRealtimeList(items, { filterEvergreen: true });
}

/** 并发拉取多源榜单并用 RRF + 跨源共现算法融合排名 */
async function collectAndFuse(
  report: HotListSourceReport[],
  tasks: { name: string; weight: number; run: () => Promise<DoubanItem[]> }[],
  opts: { maxEpisodes?: number; dropEndedCatalog?: boolean; diversify?: boolean; baseline?: Record<string, number> } = {}
): Promise<DoubanItem[]> {
  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  const sources: RankedSourceInput[] = [];
  settled.forEach((res, idx) => {
    report.push({
      name: tasks[idx].name,
      ok: res.status === 'fulfilled' && res.value.length > 0,
      count: res.status === 'fulfilled' ? res.value.length : 0,
    });
    if (res.status === 'fulfilled' && res.value.length > 0) {
      sources.push({
        name: tasks[idx].name,
        weight: tasks[idx].weight,
        items: res.value,
      });
    }
  });
  const fused = fuseMultiSourceRankings(sources, {
    limit: 24,
    filterEvergreen: true,
    maxEpisodes: opts.maxEpisodes ?? 120,
    dropEndedCatalog: opts.dropEndedCatalog,
    diversify: opts.diversify,
    baseline: opts.baseline,
  });
  if (fused.length === 0) throw new Error('多源榜单聚合失败');
  return fused;
}

/** 一个榜这次参与计算的来源：哪些取到了、各多少条 */
export interface HotListSourceReport {
  name: string;
  ok: boolean;
  count: number;
}

export interface HotListMeta {
  /** 这份榜单在服务端算出来的时间（毫秒时间戳） */
  updatedAt: number;
  /** 服务端缓存多久后重算（毫秒） */
  ttl: number;
  sources: HotListSourceReport[];
}

export async function fetchHotList(id: HotListId): Promise<DoubanItem[]> {
  return (await fetchHotListWithMeta(id)).items;
}

export async function fetchHotListWithMeta(id: HotListId): Promise<{ items: DoubanItem[]; meta: HotListMeta }> {
  const cacheKey = `hot-list:v2:${id}`;
  const cached = getCache<{ items: DoubanItem[]; meta: HotListMeta }>(cacheKey);
  if (cached) return cached;
  const report: HotListSourceReport[] = [];
  let rankHistory: import('./rank-history').RankSnapshot[] | undefined;

  let items: DoubanItem[];
  let ttl = REALTIME_CACHE_TTL;
  const hasTmdbKey = Boolean(getTmdbApiKey());

  switch (id) {
    // 1. 全网综合总榜：剧集 + 电影 + 日番 + 国漫 + 百度热播 + Bangumi + TMDB
    case 'realtime_all': {
      // 读上一批快照算势头（没接存储就是空的，不影响排名）
      const { loadRankHistory, pickBaseline } = await import('./rank-history');
      rankHistory = await loadRankHistory(id);
      const baseline = pickBaseline(rankHistory)?.ranks;
      items = await collectAndFuse(report, 
        [
          { name: '豆瓣实时剧', weight: 1.1, run: () => fetchDoubanWithFallback('douban_tv_realtime') },
          { name: 'B站番剧', weight: 1.0, run: () => fetchBiliRankRaw(BILI_SEASON_TYPE_MAP.bili_bangumi!) },
          { name: '豆瓣实时影', weight: 1.0, run: () => fetchDoubanWithFallback('douban_movie_realtime') },
          { name: 'B站国创', weight: 1.0, run: () => fetchBiliRankRaw(BILI_SEASON_TYPE_MAP.bili_guochuang!) },
          { name: '百度热播', weight: 0.95, run: () => fetchBaiduTeleplayList() },
          { name: 'Bangumi', weight: 0.9, run: () => fetchBangumiHotAiring(16) },
          ...(hasTmdbKey ? [{ name: 'TMDB趋势', weight: 1.05, run: () => fetchTmdbTrending('all') }] : []),
        ],
        // 综合总榜也是首页大图的来源：前 10 名同一大类最多 4 部，避免一屏全是电影或全是番
        { maxEpisodes: 260, diversify: true, baseline }
      );
      break;
    }

    // 2. 剧集分类综合榜：豆瓣实时热剧 + 百度/猫眼热播剧 + B站剧集 + 华语口碑剧 + 全球口碑剧 (+ TMDB)
    case 'douban_tv_realtime': {
      items = await collectAndFuse(report, [
        { name: '豆瓣热剧', weight: 1.2, run: () => fetchDoubanWithFallback('douban_tv_realtime') },
        { name: '百度热播', weight: 1.05, run: () => fetchBaiduTeleplayList() },
        { name: '华语口碑', weight: 0.95, run: () => fetchDoubanWithFallback('douban_tv_chinese') },
        { name: '全球口碑', weight: 0.9, run: () => fetchDoubanWithFallback('douban_tv_global') },
        { name: 'B站剧集', weight: 0.85, run: () => fetchBiliRankRaw(BILI_SEASON_TYPE_MAP.bili_tv!) },
        ...(hasTmdbKey ? [{ name: 'TMDB剧集', weight: 0.95, run: () => fetchTmdbTrending('tv') }] : []),
      ]);
      break;
    }

    // 3. 电影分类综合榜：豆瓣实时热门电影 + B站热播电影 + 豆瓣一周口碑电影 (+ TMDB)
    case 'douban_movie_realtime': {
      items = await collectAndFuse(report, [
        { name: '豆瓣实时影', weight: 1.2, run: () => fetchDoubanWithFallback('douban_movie_realtime') },
        { name: '一周口碑影', weight: 1.05, run: () => fetchDoubanWithFallback('douban_movie_weekly') },
        { name: 'B站电影', weight: 0.95, run: () => fetchBiliRankRaw(BILI_SEASON_TYPE_MAP.bili_movie!) },
        ...(hasTmdbKey ? [{ name: 'TMDB电影', weight: 1.0, run: () => fetchTmdbTrending('movie') }] : []),
      ]);
      break;
    }

    // 4. 日漫新番分类综合榜：Bangumi 当季实时放送榜 + B站番剧榜 + 豆瓣当季新番榜
    case 'bili_bangumi':
    case 'douban_anime_hot': {
      items = await collectAndFuse(report, 
        [
          { name: 'Bangumi', weight: 1.15, run: () => fetchBangumiHotAiring(24) },
          { name: 'B站番剧', weight: 1.1, run: () => fetchBiliRankRaw(BILI_SEASON_TYPE_MAP.bili_bangumi!) },
          { name: '豆瓣新番', weight: 1.0, run: () => fetchDoubanWithFallback('douban_anime_hot') },
        ],
        { maxEpisodes: 95 }
      );
      break;
    }

    // 5. 国漫分类综合榜：B站国创热播榜 + 豆瓣热门动画（筛华语）
    case 'bili_guochuang': {
      items = await collectAndFuse(report, 
        [
          { name: 'B站国创', weight: 1.25, run: () => fetchBiliRankRaw(BILI_SEASON_TYPE_MAP.bili_guochuang!) },
          {
            name: '豆瓣国漫',
            weight: 0.95,
            run: async () => {
              const all = await fetchDoubanWithFallback('douban_anime_hot');
              return all.filter((i) => !i.area || /中国|大陆|华语/.test(i.area));
            },
          },
        ],
        { maxEpisodes: 260 }
      );
      break;
    }

    // 6. 国产剧分类综合榜：豆瓣国产剧 + 百度实时热播剧 + 华语口碑剧集
    case 'douban_tv_domestic': {
      items = await collectAndFuse(report, [
        { name: '豆瓣陆剧', weight: 1.2, run: () => fetchDoubanWithFallback('douban_tv_domestic') },
        { name: '百度热播', weight: 1.05, run: () => fetchBaiduTeleplayList() },
        { name: '华语口碑', weight: 1.0, run: () => fetchDoubanWithFallback('douban_tv_chinese') },
        { name: 'B站剧集', weight: 0.85, run: () => fetchBiliRankRaw(BILI_SEASON_TYPE_MAP.bili_tv!) },
      ]);
      break;
    }

    // 7. 日韩剧分类综合榜：豆瓣韩剧 + 豆瓣日剧 + 全球口碑剧集
    case 'douban_tv_korean': {
      items = await collectAndFuse(report, [
        { name: '豆瓣韩剧', weight: 1.15, run: () => fetchDoubanWithFallback('douban_tv_korean') },
        { name: '豆瓣日剧', weight: 1.05, run: () => fetchDoubanWithFallback('douban_tv_japanese') },
        {
          name: '全球口碑',
          weight: 0.95,
          run: async () => {
            const list = await fetchDoubanWithFallback('douban_tv_global');
            return list.filter((i) => !i.area || /韩国|日本/.test(i.area));
          },
        },
      ]);
      break;
    }

    // 8. 欧美剧分类综合榜：豆瓣欧美剧 + 全球口碑剧集 (+ TMDB)
    case 'douban_tv_american': {
      items = await collectAndFuse(report, [
        { name: '豆瓣美剧', weight: 1.2, run: () => fetchDoubanWithFallback('douban_tv_american') },
        {
          name: '全球口碑',
          weight: 1.05,
          run: async () => {
            const list = await fetchDoubanWithFallback('douban_tv_global');
            return list.filter((i) => !i.area || !/韩国|日本|中国/.test(i.area));
          },
        },
        ...(hasTmdbKey ? [{ name: 'TMDB欧美', weight: 1.0, run: () => fetchTmdbTrending('tv') }] : []),
      ]);
      break;
    }

    // 9. 综艺分类综合榜：豆瓣热门综艺 + 国内口碑综艺 + 海外口碑综艺
    case 'douban_show_hot': {
      items = await collectAndFuse(report, [
        { name: '热门综艺', weight: 1.2, run: () => fetchDoubanWithFallback('douban_show_hot') },
        { name: 'B站综艺', weight: 1.05, run: () => fetchBiliRankRaw(BILI_SEASON_TYPE_MAP.bili_show!) },
        { name: '国内口碑', weight: 1.05, run: () => fetchDoubanWithFallback('douban_show_chinese') },
        { name: '海外口碑', weight: 0.9, run: () => fetchDoubanWithFallback('douban_show_global') },
      ]);
      break;
    }

    // 10. 纪录片分类综合榜：B站纪录片热播榜 + 豆瓣高分纪录片
    case 'bili_doc': {
      items = await collectAndFuse(report, [
        { name: 'B站纪录片', weight: 1.2, run: () => fetchBiliRankRaw(BILI_SEASON_TYPE_MAP.bili_doc!) },
      ]);
      break;
    }

    // 11. 全球趋势榜：TMDB + 豆瓣全球剧集 + 豆瓣实时电影
    case 'tmdb_trending': {
      items = await fetchTmdbTrending('all');
      report.push({ name: 'TMDB趋势', ok: true, count: items.length });
      break;
    }

    default: {
      if (BILI_SEASON_TYPE_MAP[id]) {
        items = await fetchBiliRankRaw(BILI_SEASON_TYPE_MAP[id]!);
        report.push({ name: BILI_SEASON_TYPE_MAP[id]!.label, ok: true, count: items.length });
      } else if (DOUBAN_COLLECTION_MAP[id]) {
        if (DOUBAN_WEEKLY_CATEGORY[id]) ttl = WEEKLY_CACHE_TTL;
        items = await fetchDoubanWithFallback(id);
        report.push({ name: DOUBAN_COLLECTION_MAP[id]!.label, ok: true, count: items.length });
      } else {
        items = await fetchBaiduTeleplayList();
        report.push({ name: '百度热播', ok: true, count: items.length });
      }
      break;
    }
  }

  if (items.length === 0) throw new Error('榜单数据为空');

  // 热榜里偶尔混入定档 / 预告作品，剔除后若整榜被清空则保留原样
  try {
    const kept = dropUnreleased(items, await fetchUnreleasedIndex());
    if (kept.length > 0) items = kept;
  } catch {
    // 索引取不到时不影响榜单
  }

  if (rankHistory) {
    // 每小时最多写一次；Serverless 函数返回后可能被冻结，所以等它写完（写失败不影响榜单）
    const { recordSnapshot } = await import('./rank-history');
    await recordSnapshot(id, items.map((i) => rankKeyOf(i.title)), rankHistory);
  }

  const result = { items, meta: { updatedAt: Date.now(), ttl, sources: report } };
  setCache(cacheKey, result, ttl);
  return result;
}

