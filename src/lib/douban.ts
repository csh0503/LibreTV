import type { DoubanItem } from './types';
import { judgeStatus, looksUnreleased } from './title-status';
import { fetchUpstream, getCache, setCache } from './fetch-utils';
import { rexxarToItem, type DoubanRequest } from './recommend';
import { fetchBangumiCatalog } from './bangumi';
import { canonicalTitle } from './title-aliases';
import { getTmdbApiKey, TMDB_CODE_TO_AREA, TMDB_ID_TO_GENRE } from './douban-weekly';
import { dropUnreleased, fetchUnreleasedIndex } from './unreleased';

/**
 * 多源权威片库引擎（服务端直连 + 内存缓存 + 多源元数据融合）：
 * 1. 豆瓣 m.douban.com rexxar 推荐筛选库（全品类基础底座，失败时降级 search_subjects）
 * 2. Bangumi 番组计划 v0 官方番剧检索库（免 Key，动漫频道权威补充）
 * 3. Bilibili PGC 官方片库索引（免 Key，含番剧/国创/纪录片/电影/剧集的精准 is_finish 连载/完结状态）
 * 4. TMDB 官方中文 Discover 片库（当配置 TMDB_API_KEY 时自动启用，提供全球权威评分与高清海报）
 * 融合后再用 unreleased 开播日期索引剔除还没播出的条目。
 */

const REXXAR_API = 'https://m.douban.com/rexxar/api/v2';
const SEARCH_SUBJECTS = 'https://movie.douban.com/j/search_subjects';
const CACHE_TTL = 10 * 60 * 1000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

interface DoubanRawSubject {
  id: string;
  title: string;
  cover: string;
  rate: string;
  url?: string;
}

export interface DoubanFetchQuery extends DoubanRequest {
  pageStart: number;
  pageSize: number;
}

function fallbackProxies(): string[] {
  const proxies: string[] = [];
  if (process.env.FALLBACK_CORS_PROXY) proxies.push(process.env.FALLBACK_CORS_PROXY);
  return proxies;
}

const LEGACY_SORT: Record<DoubanRequest['sort'], string> = {
  U: 'recommend',
  S: 'rank',
  R: 'time',
};

async function readJson(target: string, referer: string): Promise<unknown | undefined> {
  try {
    const res = await fetchUpstream(target, {
      timeoutMs: 8000,
      headers: { 'User-Agent': UA, Referer: referer, Accept: 'application/json' },
    });
    if (res.ok) return await res.json();
  } catch {
    // 走降级
  }
  for (const proxy of fallbackProxies()) {
    try {
      const res = await fetchUpstream(proxy + encodeURIComponent(target), {
        timeoutMs: 8000,
        headers: { Accept: 'application/json' },
      });
      if (res.ok) return await res.json();
    } catch {
      // 继续尝试下一个
    }
  }
  return undefined;
}

interface BiliIndexItemRaw {
  season_id?: number | string;
  title?: string;
  cover?: string;
  score?: string;
  index_show?: string;
  is_finish?: number;
  order?: string;
}

/**
 * Bilibili PGC 官方片库索引（免 Key，自带 100% 准确的 is_finish 连载/完结标志）
 */
async function fetchBiliSeasonIndex(query: DoubanFetchQuery): Promise<DoubanItem[]> {
  const tags = query.tags;
  const isAnime = tags.includes('动画');
  const isDoc = tags.includes('纪录片');
  const isChinese = tags.some((t) => t === '中国大陆' || t === '华语');
  const isOtherForeignAnime = isAnime && tags.some((t) => ['美国', '韩国', '英国', '法国', '欧美'].includes(t));
  if (isOtherForeignAnime) return [];

  let seasonType = 0;
  if (isAnime) {
    seasonType = isChinese ? 4 : 1; // 4=国创, 1=日本番剧
  } else if (isDoc) {
    seasonType = 3; // 3=纪录片
  } else if (query.kind === 'movie') {
    seasonType = 2; // 2=电影
  } else if (tags.includes('电视剧')) {
    seasonType = 5; // 5=电视剧
  }
  if (!seasonType) return [];

  const page = Math.floor(query.pageStart / Math.max(1, query.pageSize)) + 1;
  // order: 2=播放量/热度, 4=最高评分, 0=更新时间
  const order = query.sort === 'S' ? 4 : query.sort === 'R' ? 0 : 2;
  const yearTag = tags.find((t) => /^\d{4}$/.test(t));
  const yearParam = yearTag ? `&year=${encodeURIComponent(`[${yearTag},${Number(yearTag) + 1})`)}` : '';

  // 连载中 / 已完结直接让 B站筛（is_finish：0 连载、1 完结），不在前端从热门里挑
  const finishParam = query.status === 'airing' ? '&is_finish=0' : query.status === 'ended' ? '&is_finish=1' : '';
  const url = `https://api.bilibili.com/pgc/season/index/result?st=${seasonType}&season_type=${seasonType}&page=${page}&pagesize=${query.pageSize}&order=${order}&type=1${yearParam}${finishParam}`;
  const res = await fetchUpstream(url, {
    timeoutMs: 6500,
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Accept: 'application/json' },
  });
  if (!res.ok) return [];
  const json = (await res.json()) as { data?: { list?: BiliIndexItemRaw[] }; result?: { list?: BiliIndexItemRaw[] } };
  const list = json.data?.list || json.result?.list;
  if (!Array.isArray(list)) return [];

  const isTv = query.kind === 'tv';
  const items: DoubanItem[] = [];
  for (const row of list) {
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const cover = typeof row.cover === 'string' ? row.cover.trim().replace(/^http:\/\//i, 'https://') : '';
    if (!row.season_id || !title || !cover) continue;
    if (/[（(][^）)]*(?:中配|中文|配音)[^）)]*[）)]/.test(title)) continue;
    // B站自己标着「即将开播」的（多是没登记开播日期的国创年番）还没有片源，交给「即将播出」
    if (looksUnreleased(row.index_show)) continue;

    const scoreNum = parseFloat((row.score || '').replace(/分$/, ''));
    const rating = Number.isFinite(scoreNum) && scoreNum > 0 ? scoreNum.toFixed(1) : undefined;
    const status = judgeStatus({
      isTv,
      finished: row.is_finish === 1 ? true : row.is_finish === 0 ? false : undefined,
      text: row.index_show,
    });

    items.push({
      id: `bili_idx_${row.season_id}`,
      title,
      cover,
      rating,
      isTv,
      year: yearTag,
      area: seasonType === 1 ? '日本' : seasonType === 4 ? '中国大陆' : undefined,
      genres: isAnime ? '动画' : isDoc ? '纪录片' : undefined,
      remarks: row.index_show?.trim() || undefined,
      status,
      sourceLabel: 'B站片库',
    });
  }
  return items;
}

const TMDB_GENRE_MAP_MOVIE: Record<string, number> = {
  动作: 28, 冒险: 12, 动画: 16, 喜剧: 35, 犯罪: 80, 纪录片: 99,
  剧情: 18, 奇幻: 14, 历史: 36, 恐怖: 27, 音乐: 10402, 悬疑: 9648,
  爱情: 10749, 科幻: 878, 惊悚: 53, 战争: 10752,
};

const TMDB_GENRE_MAP_TV: Record<string, number> = {
  动作: 10759, 冒险: 10759, 动画: 16, 喜剧: 35, 犯罪: 80, 纪录片: 99,
  剧情: 18, 奇幻: 10765, 科幻: 10765, 悬疑: 9648, 爱情: 18,
  真人秀: 10764, 脱口秀: 10767, 战争: 10768,
};

const TMDB_COUNTRY_MAP: Record<string, string> = {
  中国大陆: 'CN', 华语: 'CN', 中国香港: 'HK', 中国台湾: 'TW',
  日本: 'JP', 韩国: 'KR', 美国: 'US', 英国: 'GB', 法国: 'FR',
  德国: 'DE', 泰国: 'TH', 印度: 'IN',
};

interface TmdbDiscoverRaw {
  id?: number;
  title?: string;
  name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  origin_country?: string[];
}

/**
 * TMDB 官方中文 Discover 片库（内置你的 TMDB Key，同时支持环境变量覆盖）
 */
async function fetchTmdbDiscoverCatalog(query: DoubanFetchQuery): Promise<DoubanItem[]> {
  const apiKey = getTmdbApiKey();
  if (!apiKey) return [];

  const isTv = query.kind === 'tv';
  const page = Math.floor(query.pageStart / 20) + 1;
  const genreMap = isTv ? TMDB_GENRE_MAP_TV : TMDB_GENRE_MAP_MOVIE;
  const genreIds = new Set<number>();
  let originCountry: string | undefined;
  let yearFilter: string | undefined;

  for (const tag of query.tags) {
    if (genreMap[tag]) genreIds.add(genreMap[tag]);
    if (tag === '综艺') genreIds.add(10764);
    if (TMDB_COUNTRY_MAP[tag]) originCountry = TMDB_COUNTRY_MAP[tag];
    if (/^\d{4}$/.test(tag)) yearFilter = tag;
  }

  const sortBy =
    query.sort === 'S'
      ? 'vote_average.desc'
      : query.sort === 'R'
        ? isTv
          ? 'first_air_date.desc'
          : 'primary_release_date.desc'
        : 'popularity.desc';

  const [minScoreStr] = query.score.split(',');
  const minScore = parseFloat(minScoreStr || '0');

  const params = new URLSearchParams({
    language: 'zh-CN',
    page: String(page),
    sort_by: sortBy,
    'vote_count.gte': query.sort === 'S' ? '80' : '15',
  });
  if (genreIds.size > 0) params.set('with_genres', [...genreIds].join(','));
  if (originCountry) params.set('with_origin_country', originCountry);
  if (yearFilter) {
    params.set(isTv ? 'first_air_date_year' : 'primary_release_year', yearFilter);
  }
  if (minScore > 0) params.set('vote_average.gte', String(minScore));
  // 只要已经播出 / 上映的，未播出的交给「即将播出」
  const todayStr = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  params.set(isTv ? 'first_air_date.lte' : 'primary_release_date.lte', todayStr);
  // 连载中：仍在更新（Returning Series）且近两个月有新集；已完结：完结或停播
  if (isTv && query.status === 'airing') {
    params.set('with_status', '0');
    params.set('air_date.gte', new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10));
    params.set('air_date.lte', todayStr);
  } else if (isTv && query.status === 'ended') {
    params.set('with_status', '3|4');
  }

  const isBearer = apiKey.length > 40 && apiKey.includes('.');
  if (!isBearer) params.set('api_key', apiKey);
  const headers: Record<string, string> = { 'User-Agent': UA, Accept: 'application/json' };
  if (isBearer) headers.Authorization = `Bearer ${apiKey}`;

  const url = `https://api.themoviedb.org/3/discover/${query.kind}?${params.toString()}`;
  const res = await fetchUpstream(url, { timeoutMs: 7000, headers });
  if (!res.ok) return [];
  const json = (await res.json()) as { results?: TmdbDiscoverRaw[] };
  const rows = Array.isArray(json.results) ? json.results : [];

  const items: DoubanItem[] = [];
  for (const row of rows) {
    const title = (row.title || row.name || '').trim();
    // 仅收录已有官方中文译名的条目，确保点击后在中文采集站能搜到片源
    if (!row.id || !title || !row.poster_path || !/[\u4e00-\u9fa5]/.test(title)) continue;
    const dateStr = row.release_date || row.first_air_date || '';
    const year = /^\d{4}/.test(dateStr) ? dateStr.slice(0, 4) : undefined;
    const genres = Array.isArray(row.genre_ids)
      ? row.genre_ids
          .map((id) => TMDB_ID_TO_GENRE[id])
          .filter(Boolean)
          .slice(0, 3)
          .join(' ') || undefined
      : undefined;
    const areaCode = Array.isArray(row.origin_country) ? row.origin_country[0] : originCountry;
    const area = areaCode ? TMDB_CODE_TO_AREA[areaCode] || undefined : undefined;

    items.push({
      id: `tmdb_${row.id}`,
      title,
      cover: `https://image.tmdb.org/t/p/w500${row.poster_path}`,
      backdrop: row.backdrop_path ? `https://image.tmdb.org/t/p/w1280${row.backdrop_path}` : undefined,
      rating: row.vote_average && row.vote_average > 0 ? row.vote_average.toFixed(1) : undefined,
      isTv,
      year,
      area,
      genres,
      // 按状态筛过的就知道状态，否则前端的「连载中 / 已完结」会把 TMDB 的条目全滤掉
      ...(isTv && query.status ? { status: query.status } : {}),
      sourceLabel: 'TMDB',
    });
  }
  return items;
}

/**
 * 多源片库融合与元数据互补：
 * - 以豆瓣 + Bangumi v0 + B站官方索引 + TMDB 交叉合并；
 * - 同名条目自动互补：优先采信 B站/Bangumi 的准确完结/连载状态（解决豆瓣滞后标为「更新至N集」的问题），并合并横版剧照、评分、年代地区。
 */
export function fuseCatalogItems(lists: DoubanItem[][], limit: number): DoubanItem[] {
  const byKey = new Map<string, DoubanItem>();
  const orderKeys: string[] = [];
  const maxLen = Math.max(0, ...lists.map((l) => l.length));

  for (let i = 0; i < maxLen; i++) {
    for (const list of lists) {
      const item = list[i];
      if (!item) continue;
      const key = canonicalTitle(item.title);
      if (!key) continue;

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { ...item });
        orderKeys.push(key);
      } else {
        // 有依据的状态（完结标记、更新说明、首播日期）优先于只按年份猜的；
        // 都有依据时 ended 优先——B站 / Bangumi 的完结会覆盖豆瓣滞后的「更新至N集」
        const firm = [existing, item].filter((x) => x.status && !x.statusGuessed);
        const pool = firm.length > 0 ? firm : [existing, item].filter((x) => x.status);
        const authoritativeEnded = pool.some((x) => x.status === 'ended')
          ? 'ended'
          : pool.find((x) => x.status)?.status;
        const guessed = firm.length === 0 && Boolean(authoritativeEnded);
        const authoritativeRemarks =
          item.status === 'ended' && item.remarks
            ? item.remarks
            : existing.status === 'ended' && existing.remarks
              ? existing.remarks
              : existing.remarks || item.remarks;

        byKey.set(key, {
          ...existing,
          cover: existing.cover || item.cover,
          backdrop: existing.backdrop || item.backdrop,
          rating: existing.rating || item.rating,
          year: existing.year || item.year,
          area: existing.area || item.area,
          genres: existing.genres || item.genres,
          status: authoritativeEnded,
          statusGuessed: guessed || undefined,
          remarks: authoritativeRemarks,
        });
      }
    }
  }

  return orderKeys.slice(0, limit).map((k) => byKey.get(k)!);
}

export async function fetchDoubanRecommend(query: DoubanFetchQuery): Promise<{ items: DoubanItem[]; total?: number }> {
  const hasTmdb = Boolean(getTmdbApiKey());
  const cacheKey = `douban:v4:${hasTmdb ? 'tmdb:' : ''}${query.kind}:${query.tags.join(',')}:${query.sort}:${query.score}:${query.status ?? 'all'}:${query.pageStart}:${query.pageSize}`;
  const cached = getCache<{ items: DoubanItem[]; total?: number }>(cacheKey);
  if (cached) return cached;

  const nowYear = new Date().getFullYear();
  const isTv = query.kind === 'tv';
  const isAnime = query.tags.includes('动画');
  const tags = query.tags.join(',');
  const rexxar = `${REXXAR_API}/${query.kind}/recommend?start=${query.pageStart}&count=${query.pageSize}&tags=${encodeURIComponent(tags)}&sort=${query.sort}&score_range=${query.score}&uncollect=false`;

  // 并发请求：豆瓣 rexxar + Bangumi v0（动漫频道）+ B站 PGC 官方片库 + TMDB Discover（若配置 Key）
  const [rexxarRes, bgmRes, biliRes, tmdbRes, unreleasedRes] = await Promise.allSettled([
    readJson(rexxar, 'https://movie.douban.com/explore'),
    isAnime
      ? fetchBangumiCatalog({
          tags: query.tags,
          sort: query.sort,
          score: query.score,
          pageStart: query.pageStart,
          pageSize: query.pageSize,
          status: query.status,
        })
      : Promise.resolve([]),
    fetchBiliSeasonIndex(query),
    fetchTmdbDiscoverCatalog(query),
    fetchUnreleasedIndex(),
  ]);

  const rexxarJson =
    rexxarRes.status === 'fulfilled'
      ? (rexxarRes.value as { items?: unknown[]; total?: unknown } | undefined)
      : undefined;
  const rexxarItems = rexxarJson?.items;
  let doubanItems: DoubanItem[] | undefined;
  let total: number | undefined;
  if (Array.isArray(rexxarItems)) {
    doubanItems = rexxarItems
      .map((row) => rexxarToItem(row, isTv, nowYear))
      .filter((item): item is DoubanItem => item !== undefined);
    if (typeof rexxarJson?.total === 'number' && rexxarJson.total >= 0) total = rexxarJson.total;
  }

  // rexxar 被拒绝时退回单标签接口
  if (!doubanItems) {
    try {
      const legacySort = LEGACY_SORT[query.sort];
      const legacy = `${SEARCH_SUBJECTS}?type=${query.kind}&tag=${encodeURIComponent(query.tags[0] || '热门')}&sort=${legacySort}&page_limit=${query.pageSize}&page_start=${query.pageStart}`;
      const legacyJson = await readJson(legacy, 'https://movie.douban.com/');
      const subjects = (legacyJson as { subjects?: DoubanRawSubject[] } | undefined)?.subjects;
      if (subjects) {
        doubanItems = subjects.map((s) => ({
          id: String(s.id),
          title: s.title,
          cover: s.cover,
          rating: s.rate && s.rate !== '0' ? s.rate : undefined,
          isTv,
        }));
      }
    } catch {
      // 若其他源有数据仍可继续返回
    }
  }

  const candidateLists: DoubanItem[][] = [];
  if (doubanItems && doubanItems.length > 0) candidateLists.push(doubanItems);
  if (bgmRes.status === 'fulfilled' && bgmRes.value.length > 0) candidateLists.push(bgmRes.value);
  if (biliRes.status === 'fulfilled' && biliRes.value.length > 0) candidateLists.push(biliRes.value);
  if (tmdbRes.status === 'fulfilled' && tmdbRes.value.length > 0) candidateLists.push(tmdbRes.value);

  if (candidateLists.length === 0 && !doubanItems) {
    throw new Error('片库推荐获取失败');
  }

  // 豆瓣 / B站不过滤未播出的年番和定档作品，用开播日期索引统一剔除，它们只在「即将播出」里出现
  const fused = fuseCatalogItems(candidateLists, query.pageSize * 2);
  const items = unreleasedRes.status === 'fulfilled' ? dropUnreleased(fused, unreleasedRes.value) : fused;
  const payload = { items, total };
  setCache(cacheKey, payload, CACHE_TTL);
  return payload;
}

