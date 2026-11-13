import type { DoubanItem } from './types';
import {
  CATALOG_CHANNELS,
  countWorks,
  kvGet,
  kvSet,
  loadRawItems,
  openCatalogDb,
  pruneRawItems,
  pruneSourceIndex,
  replaceChannelWorks,
  upsertRawItems,
  upsertSourceIndex,
  type CatalogChannel,
} from './catalog-db';
import { buildChannelWorks } from './catalog-build';
import { parseBiliUpdate, parseChineseCount, type CatalogRawItem, type RawSignals } from './catalog-rank';
import { fetchUpstream } from './fetch-utils';
import { tmdbGet } from './tmdb';
import { TMDB_CODE_TO_AREA, TMDB_ID_TO_GENRE, fetchHotList, type HotListId } from './douban-weekly';
import { rexxarToItem } from './recommend';
import { judgeStatus, looksUnreleased } from './title-status';
import { canonicalTitle } from './title-aliases';
import { fetchBangumiCalendar } from './bangumi';
import { getEnvSources } from './env-sources';
import { parseBrowseVideos } from './cms-parser';
import { checkUpstreamAllowed } from './ssrf';

/**
 * 本地片库的背景同步（伺服器常驻进程里跑，不阻塞任何请求）：
 *
 * - 全量（片库空的时候 / 每 7 天一次，可中断续跑）：
 *   TMDB 按年份（1970 至今）抓电影、剧集、动画、综艺、纪录片（只收有中文译名的）；
 *   Bangumi 按年份抓番剧；B站 PGC 片库整份（按总播放量）；豆瓣各频道 / 地区 / 年代的
 *   「标记最多」「高分」「近期热门」；26 个点播源近 3 天更新的片子。
 * - 增量（每小时）：豆瓣近期热门、B站最近更新、TMDB 当下热门和在播剧的最新一集、Bangumi 本周放送、
 *   综合热榜、点播源近几小时更新。
 * 每次抓完重新融合（work-identity 认同一部），算好四种排序的分数，整个频道一次换掉。
 *
 * 伺服器只有 2 核 + 2.4G Wi-Fi：请求排队、每个来源同时最多 2~3 个、每个请求之间停一下；
 * 抓的都是 JSON 小接口，不碰视频。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DAY = 86_400_000;
const FULL_EVERY = 7 * DAY;
const INCREMENTAL_EVERY = 60 * 60_000;
/** 片库为空时，第一次同步等伺服器起来一会儿再开始 */
const FIRST_DELAY = 20_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const todayStr = (now = Date.now()) => new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
const log = (...args: unknown[]) => console.log('[catalog]', ...args);

/** 简单的并发池：同时最多 n 个，每个任务之后停 gap 毫秒 */
async function pool<T>(items: T[], n: number, gap: number, run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await run(item);
      } catch {
        // 单个失败不影响别的
      }
      if (gap > 0) await sleep(gap);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

async function getJson<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T | undefined> {
  try {
    const res = await fetchUpstream(url, {
      timeoutMs: init.timeoutMs ?? 9000,
      ...init,
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers as Record<string, string> | undefined) },
    });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}

// ———————————————————————————— 各来源 → 原始条目 ————————————————————————————

type Sink = (source: string, items: CatalogRawItem[]) => void;

function channelFor(opts: { isTv: boolean; animated: boolean; doc: boolean; show: boolean }): CatalogChannel {
  if (opts.doc) return 'doc';
  if (opts.show) return 'show';
  if (!opts.isTv) return 'movie';
  return opts.animated ? 'anime' : 'tv';
}

// ——— TMDB ———

interface TmdbRow {
  id?: number;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  release_date?: string;
  first_air_date?: string;
  genre_ids?: number[];
  origin_country?: string[];
}

export function tmdbRowToRaw(row: TmdbRow, kind: 'tv' | 'movie', now: number): CatalogRawItem | undefined {
  const title = (row.title || row.name || '').trim();
  // 只收有中文译名的（采集站按中文名搜）
  if (!row.id || !title || !row.poster_path || !/[一-龥]/.test(title)) return undefined;
  const date = row.release_date || row.first_air_date || '';
  const genreIds = row.genre_ids ?? [];
  const isTv = kind === 'tv';
  const animated = genreIds.includes(16);
  const doc = genreIds.includes(99);
  const show = isTv && (genreIds.includes(10764) || genreIds.includes(10767));
  // 新闻、肥皂剧（美国日播）不要
  if (isTv && genreIds.includes(10763)) return undefined;
  const area = TMDB_CODE_TO_AREA[row.origin_country?.[0] ?? ''] || undefined;
  return {
    id: `tmdb_${row.id}`,
    origin: 'tmdb',
    title,
    cover: `https://image.tmdb.org/t/p/w500${row.poster_path}`,
    backdrop: row.backdrop_path ? `https://image.tmdb.org/t/p/w1280${row.backdrop_path}` : undefined,
    rating: row.vote_average && row.vote_average > 0 && (row.vote_count ?? 0) >= 5 ? row.vote_average.toFixed(1) : undefined,
    isTv,
    year: /^\d{4}/.test(date) ? date.slice(0, 4) : undefined,
    area,
    genres: genreIds.map((g) => TMDB_ID_TO_GENRE[g]).filter(Boolean).slice(0, 4).join(' ') || undefined,
    originalTitle: (row.original_title || row.original_name || '').trim() || undefined,
    channel: channelFor({ isTv, animated, doc, show }),
    sig: {
      tmdbVotes: row.vote_count || undefined,
      tmdbPopularity: row.popularity || undefined,
      firstDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
      recentAt: now,
    },
  };
}

/** 取不到返回 undefined（不记成做完，下次再抓） */
async function tmdbDiscover(kind: 'tv' | 'movie', params: Record<string, string>): Promise<TmdbRow[] | undefined> {
  const today = todayStr();
  const json = await tmdbGet<{ results?: TmdbRow[] }>(`/discover/${kind}`, {
    include_adult: 'false',
    [kind === 'tv' ? 'first_air_date.lte' : 'primary_release_date.lte']: today,
    ...params,
  });
  return json ? json.results ?? [] : undefined;
}

function tmdbFullTasks(nowYear: number): { kind: 'tv' | 'movie'; params: Record<string, string> }[] {
  const tasks: { kind: 'tv' | 'movie'; params: Record<string, string> }[] = [];
  for (let y = nowYear; y >= 1970; y--) {
    const movieYear = { primary_release_year: String(y), sort_by: 'vote_count.desc' };
    const tvYear = { first_air_date_year: String(y), sort_by: 'vote_count.desc' };
    const deep = y >= 1990 ? 3 : 1;
    for (let p = 1; p <= deep; p++) tasks.push({ kind: 'movie', params: { ...movieYear, page: String(p) } });
    for (let p = 1; p <= deep; p++) tasks.push({ kind: 'tv', params: { ...tvYear, page: String(p) } });
    // 华语、日韩单独再抓（TMDB 投票数按英语圈算，中文圈作品在总榜里排不上来）
    for (const countries of ['CN|HK|TW', 'JP|KR']) {
      const pages = y >= 1995 ? 2 : 1;
      for (let p = 1; p <= pages; p++) {
        tasks.push({ kind: 'movie', params: { ...movieYear, with_origin_country: countries, page: String(p) } });
        tasks.push({ kind: 'tv', params: { ...tvYear, with_origin_country: countries, page: String(p) } });
      }
    }
    // 动画（日本 / 中国）
    for (let p = 1; p <= (y >= 1995 ? 2 : 1); p++) {
      tasks.push({ kind: 'tv', params: { ...tvYear, with_genres: '16', with_origin_country: 'JP|CN', page: String(p) } });
    }
    if (y >= 2000) {
      tasks.push({ kind: 'tv', params: { ...tvYear, with_genres: '10764|10767', with_origin_country: 'CN|KR|JP|TW|US', page: '1' } });
      tasks.push({ kind: 'tv', params: { ...tvYear, with_genres: '99', page: '1' } });
      tasks.push({ kind: 'movie', params: { ...movieYear, with_genres: '99', page: '1' } });
    }
  }
  return tasks;
}

async function syncTmdbFull(sink: Sink, now: number, isDone: (k: string) => boolean, markDone: (k: string) => void) {
  const nowYear = Number(todayStr(now).slice(0, 4));
  const tasks = tmdbFullTasks(nowYear);
  await pool(tasks, 3, 120, async (t) => {
    const key = `tmdb:${t.kind}:${JSON.stringify(t.params)}`;
    if (isDone(key)) return;
    const rows = await tmdbDiscover(t.kind, t.params);
    if (!rows) return;
    sink('tmdb', rows.map((r) => tmdbRowToRaw(r, t.kind, now)).filter((x): x is CatalogRawItem => Boolean(x)));
    markDone(key);
  });
}

interface TmdbTvDetail {
  id?: number;
  last_air_date?: string;
  status?: string;
  number_of_episodes?: number;
  last_episode_to_air?: { air_date?: string; episode_number?: number; season_number?: number };
  in_production?: boolean;
}

/** 当下热门 + 在播剧的最新一集日期、集数、连载状态 */
async function syncTmdbRecent(sink: Sink, now: number) {
  const today = todayStr(now);
  const recentRows: { row: TmdbRow; kind: 'tv' | 'movie' }[] = [];
  const lists: { path: string; kind: 'tv' | 'movie'; params: Record<string, string> }[] = [];
  for (const kind of ['tv', 'movie'] as const) {
    for (let p = 1; p <= 3; p++) lists.push({ path: `/trending/${kind}/week`, kind, params: { page: String(p) } });
  }
  for (let p = 1; p <= 4; p++) lists.push({ path: '/tv/on_the_air', kind: 'tv', params: { page: String(p) } });
  for (const countries of ['CN|HK|TW', 'JP|KR']) {
    for (let p = 1; p <= 2; p++) {
      lists.push({
        path: '/discover/tv',
        kind: 'tv',
        params: {
          with_origin_country: countries,
          'air_date.gte': new Date(now - 30 * DAY).toISOString().slice(0, 10),
          'air_date.lte': today,
          sort_by: 'popularity.desc',
          page: String(p),
        },
      });
    }
  }
  await pool(lists, 2, 150, async (l) => {
    const json = await tmdbGet<{ results?: TmdbRow[] }>(l.path, l.params);
    for (const row of json?.results ?? []) recentRows.push({ row, kind: l.kind });
  });
  const items = recentRows.map(({ row, kind }) => tmdbRowToRaw(row, kind, now)).filter((x): x is CatalogRawItem => Boolean(x));
  // 在播剧：查详情拿最新一集日期（最多 120 部）
  const tvIds = [...new Set(items.filter((i) => i.isTv).map((i) => i.id))].slice(0, 120);
  const byId = new Map(items.map((i) => [i.id, i]));
  await pool(tvIds, 3, 120, async (id) => {
    const d = await tmdbGet<TmdbTvDetail>(`/tv/${id.replace('tmdb_', '')}`, {});
    const item = byId.get(id);
    if (!d || !item) return;
    const last = d.last_episode_to_air?.air_date || d.last_air_date;
    if (last && last <= today) item.sig.lastDate = last;
    const ended = d.status === 'Ended' || d.status === 'Canceled';
    item.status = ended ? 'ended' : d.in_production || d.status === 'Returning Series' ? 'airing' : undefined;
    if (d.number_of_episodes) item.remarks = ended ? `全${d.number_of_episodes}集` : undefined;
    if (item.status === 'airing' && d.last_episode_to_air?.episode_number) {
      item.remarks = `更新至${d.last_episode_to_air.episode_number}集`;
    }
  });
  sink('tmdb-recent', items);
}

// ——— Bangumi ———

interface BgmSubject {
  id?: number;
  name?: string;
  name_cn?: string;
  date?: string;
  platform?: string;
  eps?: number;
  total_episodes?: number;
  images?: { large?: string; common?: string };
  rating?: { score?: number; total?: number };
  collection?: { collect?: number; doing?: number };
  tags?: { name?: string }[];
}

export function bgmToRaw(row: BgmSubject, now: number): CatalogRawItem | undefined {
  const title = (row.name_cn || '').trim();
  const cover = row.images?.large || row.images?.common;
  const votes = row.rating?.total ?? 0;
  if (!row.id || !title || !cover || votes < 20) return undefined;
  if (!row.date || row.date > todayStr(now)) return undefined;
  const isTv = row.platform !== '剧场版';
  const tagNames = (row.tags ?? []).map((t) => t.name?.trim() ?? '');
  const area = tagNames.includes('国产') || tagNames.includes('中国') ? '中国大陆' : tagNames.includes('欧美') ? '美国' : '日本';
  const eps = row.total_episodes || row.eps || 0;
  const status = judgeStatus({ airDate: row.date, year: row.date.slice(0, 4), hasRating: (row.rating?.score ?? 0) > 0, inferFromYear: true }, now);
  const topGenres = tagNames.filter((n) => n && n.length <= 4 && !/^\d/.test(n) && !['TV', '日本', '国产', '欧美', '剧场版', 'TV动画'].includes(n)).slice(0, 3);
  return {
    id: `bgm_${row.id}`,
    origin: 'bangumi',
    title,
    cover,
    rating: row.rating?.score && row.rating.score > 0 ? row.rating.score.toFixed(1) : undefined,
    isTv,
    year: row.date.slice(0, 4),
    area,
    genres: ['动画', ...topGenres].join(' '),
    originalTitle: row.name?.trim() || undefined,
    remarks: eps > 0 && isTv ? (status === 'ended' ? `全${eps}话` : `共${eps}话`) : undefined,
    status: isTv ? status : undefined,
    channel: isTv ? 'anime' : 'movie',
    sig: {
      bgmCollect: (row.collection?.collect ?? 0) + (row.collection?.doing ?? 0) || undefined,
      bgmVotes: votes || undefined,
      firstDate: /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date : undefined,
    },
  };
}

async function bgmSearch(filter: Record<string, unknown>, offset: number): Promise<BgmSubject[] | undefined> {
  const json = await getJson<{ data?: BgmSubject[] }>(`https://api.bgm.tv/v0/search/subjects?limit=50&offset=${offset}`, {
    method: 'POST',
    timeoutMs: 15_000,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: '', sort: 'heat', filter: { type: [2], ...filter } }),
  });
  return json ? json.data ?? [] : undefined;
}

async function syncBangumiFull(sink: Sink, now: number, isDone: (k: string) => boolean, markDone: (k: string) => void) {
  const nowYear = Number(todayStr(now).slice(0, 4));
  const tasks: { year: number; offset: number }[] = [];
  for (let y = nowYear; y >= 1970; y--) {
    const pages = y >= 2000 ? 5 : y >= 1985 ? 2 : 1;
    for (let p = 0; p < pages; p++) tasks.push({ year: y, offset: p * 50 });
  }
  await pool(tasks, 2, 250, async (t) => {
    const key = `bgm:${t.year}:${t.offset}`;
    if (isDone(key)) return;
    const rows = await bgmSearch({ air_date: [`>=${t.year}-01-01`, `<${t.year + 1}-01-01`] }, t.offset);
    if (!rows) return;
    sink('bgm', rows.map((r) => bgmToRaw(r, now)).filter((x): x is CatalogRawItem => Boolean(x)));
    markDone(key);
  });
}

/** 本周放送表：在播番的最新一集日期（按放送星期推最近一次） */
async function syncBangumiCalendar(sink: Sink, now: number) {
  const days = await fetchBangumiCalendar().catch(() => ({}) as Record<number, DoubanItem[]>);
  const local = new Date(now + 8 * 3600_000);
  const todayWeekday = local.getUTCDay() === 0 ? 7 : local.getUTCDay();
  const items: CatalogRawItem[] = [];
  for (const [weekday, list] of Object.entries(days)) {
    const back = (todayWeekday - Number(weekday) + 7) % 7;
    const last = new Date(now + 8 * 3600_000 - back * DAY).toISOString().slice(0, 10);
    list.forEach((item, rank) => {
      if (!item.cover || !item.title) return;
      items.push({
        ...item,
        id: /^\d+$/.test(item.id) ? `bgm_${item.id}` : item.id,
        origin: 'bangumi',
        isTv: true,
        genres: item.genres?.includes('动画') ? item.genres : `动画 ${item.genres ?? ''}`.trim(),
        status: 'airing',
        channel: 'anime',
        // 当周在播：最新一集按放送星期推；同一天里人气前几的给一点「近期」分
        sig: { lastDate: last, recentAt: now, ...(rank < 20 ? { hotRank: 30 + rank } : {}) },
      });
    });
  }
  sink('bgm-calendar', items);
}

// ——— B站 PGC 片库 ———

interface BiliRow {
  season_id?: number | string;
  title?: string;
  cover?: string;
  score?: string;
  index_show?: string;
  is_finish?: number | string;
  order?: string;
}

/** season_type：1 番剧 4 国创 2 电影 3 纪录片 5 电视剧 7 综艺 */
const BILI_TYPES: { st: number; channel: CatalogChannel; isTv: boolean; area?: string; genres?: string }[] = [
  { st: 1, channel: 'anime', isTv: true, area: '日本', genres: '动画' },
  { st: 4, channel: 'anime', isTv: true, area: '中国大陆', genres: '动画' },
  { st: 2, channel: 'movie', isTv: false },
  { st: 3, channel: 'doc', isTv: true, genres: '纪录片' },
  { st: 5, channel: 'tv', isTv: true },
  { st: 7, channel: 'show', isTv: true, genres: '综艺' },
];

export function biliToRaw(
  row: BiliRow,
  type: (typeof BILI_TYPES)[number],
  mode: 'plays' | 'recent',
  rank: number,
  now: number,
): CatalogRawItem | undefined {
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const cover = typeof row.cover === 'string' ? row.cover.trim().replace(/^http:\/\//i, 'https://') : '';
  if (!row.season_id || !title || !cover) return undefined;
  if (/[（(][^）)]*(?:中配|中文|配音)[^）)]*[）)]|中文配音|中配版/.test(title)) return undefined;
  if (looksUnreleased(row.index_show)) return undefined;
  const score = parseFloat((row.score || '').replace(/分$/, ''));
  const finish = row.is_finish === undefined || row.is_finish === '' ? NaN : Number(row.is_finish);
  const status = type.isTv
    ? judgeStatus({
        isTv: true,
        finished: finish === 1 ? true : finish === 0 && !/全\s*\d+|完结/.test(row.index_show ?? '') ? false : undefined,
        text: row.index_show,
      })
    : undefined;
  const sig: RawSignals =
    mode === 'plays'
      ? { biliPlays: /播放/.test(row.order ?? '') ? parseChineseCount(row.order) : undefined }
      : { biliRecentRank: rank, lastDate: parseBiliUpdate(row.order, now), recentAt: now };
  return {
    id: `bili_idx_${row.season_id}`,
    origin: 'bili',
    title,
    cover,
    rating: Number.isFinite(score) && score > 0 ? score.toFixed(1) : undefined,
    isTv: type.isTv,
    area: type.area,
    genres: type.genres,
    remarks: row.index_show?.trim() || undefined,
    status,
    channel: type.channel,
    sig,
  };
}

async function biliIndex(st: number, order: number, page: number): Promise<{ list: BiliRow[]; hasNext: boolean; ok: boolean }> {
  const json = await getJson<{ data?: { list?: BiliRow[]; has_next?: number } }>(
    `https://api.bilibili.com/pgc/season/index/result?st=${st}&season_type=${st}&page=${page}&pagesize=50&order=${order}&type=1`,
    { timeoutMs: 15_000, headers: { Referer: 'https://www.bilibili.com/' } },
  );
  return { list: json?.data?.list ?? [], hasNext: Boolean(json?.data?.has_next), ok: Boolean(json?.data) };
}

async function syncBiliFull(sink: Sink, now: number, isDone: (k: string) => boolean, markDone: (k: string) => void) {
  for (const type of BILI_TYPES) {
    for (let page = 1; page <= 60; page++) {
      const key = `bili:${type.st}:${page}`;
      if (isDone(key)) continue;
      const { list, hasNext, ok } = await biliIndex(type.st, 2, page);
      // 取不到：这一类先跳过，不记成做完（下次续跑再抓）
      if (!ok) break;
      sink('bili', list.map((r) => biliToRaw(r, type, 'plays', 0, now)).filter((x): x is CatalogRawItem => Boolean(x)));
      markDone(key);
      await sleep(400);
      if (!hasNext || list.length === 0) break;
    }
  }
}

async function syncBiliRecent(sink: Sink, now: number) {
  for (const type of BILI_TYPES) {
    const items: CatalogRawItem[] = [];
    for (let page = 1; page <= 4; page++) {
      const { list, hasNext } = await biliIndex(type.st, 0, page);
      list.forEach((r, i) => {
        const raw = biliToRaw(r, type, 'recent', (page - 1) * 50 + i, now);
        if (raw) items.push(raw);
      });
      await sleep(400);
      if (!hasNext) break;
    }
    sink('bili-recent', items);
  }
}

// ——— 豆瓣 ———

interface DoubanQuery {
  kind: 'tv' | 'movie';
  tags: string;
  sort: 'T' | 'S' | 'U';
  pages: number;
}

function doubanChannel(kind: 'tv' | 'movie', tags: string, item: DoubanItem): CatalogChannel {
  const g = `${tags} ${item.genres ?? ''}`;
  if (/纪录片/.test(g)) return 'doc';
  if (/综艺|真人秀|脱口秀/.test(tags)) return 'show';
  if (kind === 'movie') return 'movie';
  if (/动画/.test(g)) return 'anime';
  return 'tv';
}

function doubanFullQueries(): DoubanQuery[] {
  const q: DoubanQuery[] = [];
  const add = (kind: 'tv' | 'movie', tags: string, sorts: ('T' | 'S' | 'U')[], pages = 10) => {
    for (const sort of sorts) q.push({ kind, tags, sort, pages });
  };
  add('tv', '动画', ['T', 'S', 'U']);
  add('tv', '动画,日本', ['T', 'S']);
  add('tv', '动画,中国大陆', ['T', 'S']);
  add('tv', '电视剧', ['T', 'S', 'U']);
  for (const area of ['中国大陆', '中国香港', '中国台湾', '美国', '英国', '韩国', '日本']) add('tv', `电视剧,${area}`, ['T', 'S'], 6);
  add('tv', '综艺', ['T', 'U'], 6);
  add('tv', '综艺,中国大陆', ['T'], 6);
  add('tv', '综艺,韩国', ['T'], 4);
  add('movie', '电影', ['T', 'S', 'U']);
  for (const area of ['中国大陆', '中国香港', '中国台湾', '美国', '日本', '韩国', '英国', '法国']) add('movie', `电影,${area}`, ['T'], 6);
  add('movie', '动画', ['T'], 6);
  add('movie', '纪录片', ['T', 'S'], 6);
  add('tv', '纪录片', ['T'], 6);
  for (const decade of ['2020年代', '2010年代', '2000年代', '90年代', '80年代']) {
    add('tv', `动画,${decade}`, ['T'], 4);
    add('tv', `电视剧,${decade}`, ['T'], 4);
    add('movie', `电影,${decade}`, ['T'], 4);
  }
  return q;
}

/** 一页豆瓣；取不到（超时 / 被拒）返回 undefined —— 和「列表到底了」（空数组）分开 */
async function doubanPage(query: DoubanQuery, start: number): Promise<unknown[] | undefined> {
  const url = `https://m.douban.com/rexxar/api/v2/${query.kind}/recommend?start=${start}&count=50&tags=${encodeURIComponent(query.tags)}&sort=${query.sort}&score_range=0,10&uncollect=false`;
  // 豆瓣一页 50 部常要 4~6 秒：超时放宽到 20 秒，失败再试一次
  for (let attempt = 0; attempt < 2; attempt++) {
    const json = await getJson<{ items?: unknown[] }>(url, { timeoutMs: 20_000, headers: { Referer: 'https://movie.douban.com/explore' } });
    if (json && Array.isArray(json.items)) return json.items;
    await sleep(3000);
  }
  return undefined;
}

function doubanToRaw(row: unknown, query: DoubanQuery, rank: number, now: number): CatalogRawItem | undefined {
  const nowYear = Number(todayStr(now).slice(0, 4));
  const item = rexxarToItem(row, query.kind === 'tv', nowYear);
  if (!item || !item.year) return undefined;
  const votes = (row as { rating?: { count?: number } }).rating?.count;
  const channel = doubanChannel(query.kind, query.tags, item);
  return {
    ...item,
    origin: 'douban',
    genres: channel === 'anime' && !/动画/.test(item.genres ?? '') ? `动画 ${item.genres ?? ''}`.trim() : item.genres,
    channel,
    sig: {
      doubanVotes: votes && votes > 0 ? votes : undefined,
      ...(query.sort === 'U' ? { doubanHotRank: rank, recentAt: now } : {}),
    },
  };
}

async function syncDoubanQueries(
  sink: Sink,
  queries: DoubanQuery[],
  now: number,
  isDone: (k: string) => boolean,
  markDone: (k: string) => void,
) {
  // 豆瓣会封频繁的 IP：一个一个来，每页之间停 1.2 秒
  for (const query of queries) {
    const source = query.sort === 'U' ? 'douban-hot' : 'douban';
    for (let p = 0; p < query.pages; p++) {
      const key = `douban:${query.kind}:${query.tags}:${query.sort}:${p}`;
      if (isDone(key)) continue;
      const rows = await doubanPage(query, p * 50);
      // 取不到：这一项不记成做完（下次续跑再抓），先跳到下一个查询
      if (!rows) break;
      sink(
        source,
        rows.map((r, i) => doubanToRaw(r, query, p * 50 + i, now)).filter((x): x is CatalogRawItem => Boolean(x)),
      );
      markDone(key);
      await sleep(1200);
      if (rows.length < 50) break;
    }
  }
}

// ——— 综合热榜（首页 TOP 10 那几份） ———

const HOT_LISTS: { id: HotListId; channel: CatalogChannel }[] = [
  { id: 'douban_anime_hot', channel: 'anime' },
  { id: 'bili_bangumi', channel: 'anime' },
  { id: 'douban_tv_domestic', channel: 'tv' },
  { id: 'douban_tv_american', channel: 'tv' },
  { id: 'douban_tv_korean', channel: 'tv' },
  { id: 'douban_tv_japanese', channel: 'tv' },
  { id: 'douban_movie_realtime', channel: 'movie' },
  { id: 'douban_show_hot', channel: 'show' },
  { id: 'bili_doc', channel: 'doc' },
];

async function syncHotLists(sink: Sink, now: number) {
  const items: CatalogRawItem[] = [];
  for (const list of HOT_LISTS) {
    const rows = await fetchHotList(list.id).catch(() => [] as DoubanItem[]);
    rows.slice(0, 60).forEach((item, rank) => {
      if (!item.cover || !item.title) return;
      items.push({
        ...item,
        id: `hot_${list.id}_${canonicalTitle(item.title)}`,
        origin: 'other',
        genres: list.channel === 'anime' && !/动画/.test(item.genres ?? '') ? `动画 ${item.genres ?? ''}`.trim() : item.genres,
        channel: list.channel,
        sig: { hotRank: rank, recentAt: now, lastDate: item.lastAired },
      });
    });
    await sleep(300);
  }
  sink('hot', items);
}

// ——— 26 个点播源：最近更新的片子（标「已有片源」和最新集数） ———

async function syncSourceUpdates(hours: number, maxPages: number) {
  const sources = getEnvSources().filter((s) => !s.isAdult);
  await pool(sources, 4, 200, async (src) => {
    if (!(await checkUpstreamAllowed(src.url)).ok) return;
    for (let pg = 1; pg <= maxPages; pg++) {
      const url = `${src.url}?ac=videolist&h=${hours}&pg=${pg}`;
      const json = await getJson<{ pagecount?: number | string }>(url, { timeoutMs: 8000 });
      if (!json) return;
      const rows = parseBrowseVideos(json)
        .filter((v) => v.vodId && v.name)
        .map((v) => ({
          sourceKey: src.key,
          vodId: v.vodId,
          titleKey: canonicalTitle(v.name),
          name: v.name,
          year: /^\d{4}$/.test(v.year ?? '') ? Number(v.year) : undefined,
          remarks: v.remarks || undefined,
        }));
      upsertSourceIndex(rows);
      const pageCount = Number(json.pagecount ?? 1);
      if (!Number.isFinite(pageCount) || pg >= pageCount) return;
      await sleep(300);
    }
  });
}

// ———————————————————————————— 调度 ————————————————————————————

interface SyncState {
  fullRun?: string;
  fullStartedAt?: number;
  fullAt?: number;
  incAt?: number;
  lastError?: string;
  phase?: string;
}

/** 原始条目的主键：剧集 / 电影分开（TMDB 两边编号会撞） */
export function rawKeyOf(item: Pick<CatalogRawItem, 'id' | 'isTv'>): string {
  return `${item.isTv ? 'tv' : 'mv'}:${item.id}`;
}

function makeSink(): { sink: Sink; flush: () => void; touched: Set<CatalogChannel> } {
  const touched = new Set<CatalogChannel>();
  const pending = new Map<string, CatalogRawItem[]>();
  const flush = () => {
    for (const [source, items] of pending) {
      upsertRawItems(
        source,
        // TMDB 的电影和剧集编号各自独立（tmdb_1429 既是《进击的巨人》剧集也是《第25小时》电影），存的时候分开
        items.map((i) => ({ id: rawKeyOf(i), channel: i.channel, data: i })),
      );
    }
    pending.clear();
  };
  const sink: Sink = (source, items) => {
    if (items.length === 0) return;
    for (const i of items) touched.add(i.channel);
    pending.set(source, [...(pending.get(source) ?? []), ...items]);
    if ((pending.get(source)?.length ?? 0) >= 500) flush();
  };
  return { sink, flush, touched };
}

/** 重新融合几个频道并整批换掉 */
export async function rebuildChannels(channels: Iterable<CatalogChannel>, now = Date.now()) {
  for (const channel of channels) {
    const raws = loadRawItems<CatalogRawItem>(channel);
    if (raws.length === 0) continue;
    const t = Date.now();
    const rows = await buildChannelWorks(channel, raws, now);
    replaceChannelWorks(channel, rows);
    log(`频道 ${channel}：${raws.length} 条原始资料 → ${rows.length} 部作品（${Date.now() - t} 毫秒）`);
  }
}

let running = false;

/** 全量同步（可中断续跑：做完的任务记在 kv 里，重启后跳过） */
export async function runFullSync(now = Date.now()): Promise<void> {
  if (running || !openCatalogDb()) return;
  running = true;
  const state = kvGet<SyncState>('sync:state')?.value ?? {};
  const run = state.fullRun && state.fullStartedAt && now - state.fullStartedAt < 2 * DAY ? state.fullRun : String(now);
  const doneKey = `sync:full:${run}`;
  const done = new Set(kvGet<string[]>(doneKey)?.value ?? []);
  let dirty = 0;
  const isDone = (k: string) => done.has(k);
  const markDone = (k: string) => {
    done.add(k);
    if (++dirty % 20 === 0) kvSet(doneKey, [...done]);
  };
  kvSet('sync:state', { ...state, fullRun: run, fullStartedAt: state.fullRun === run ? state.fullStartedAt : now, phase: 'full' });
  const { sink, flush, touched } = makeSink();
  try {
    log('全量同步开始', done.size > 0 ? `（续跑，已完成 ${done.size} 项）` : '');
    // 先抓快的、能让片库马上有内容的（每抓完一批就融合一次，第一次打开就有东西）：
    // B站片库整份（约 2 分钟）→ TMDB + Bangumi 按年份（约 10 分钟）→ 最慢的豆瓣（每页 4~6 秒，约半小时）
    await syncBiliFull(sink, now, isDone, markDone);
    await syncHotLists(sink, now);
    flush();
    await rebuildChannels(CATALOG_CHANNELS, now);
    await Promise.all([syncTmdbFull(sink, now, isDone, markDone), syncBangumiFull(sink, now, isDone, markDone)]);
    await syncTmdbRecent(sink, now);
    await syncBangumiCalendar(sink, now);
    await syncBiliRecent(sink, now);
    flush();
    kvSet(doneKey, [...done]);
    await rebuildChannels(CATALOG_CHANNELS, now);
    const doubanQueries = doubanFullQueries();
    await syncDoubanQueries(sink, doubanQueries, now, isDone, markDone);
    flush();
    // 第一轮取不到的页（超时 / 被拒，没记成做完）再试一轮
    await syncBiliFull(sink, now, isDone, markDone);
    await Promise.all([syncTmdbFull(sink, now, isDone, markDone), syncBangumiFull(sink, now, isDone, markDone)]);
    await syncDoubanQueries(sink, doubanQueries, now, isDone, markDone);
    flush();
    kvSet(doneKey, [...done]);
    await rebuildChannels(CATALOG_CHANNELS, now);
    await syncSourceUpdates(72, 15);
    pruneRawItems(30 * DAY);
    pruneSourceIndex(30 * DAY);
    kvSet('sync:state', { fullAt: Date.now(), incAt: Date.now(), phase: 'idle' } satisfies SyncState);
    kvSet(doneKey, []);
    log('全量同步完成', [...touched].join(','));
  } catch (err) {
    flush();
    kvSet('sync:state', { ...state, fullRun: run, lastError: err instanceof Error ? err.message : String(err), phase: 'error' });
    log('全量同步出错：', err);
  } finally {
    running = false;
  }
}

/** 增量：近期热门、最近更新、在播剧最新一集、放送表、综合热榜、点播源近几小时 */
export async function runIncrementalSync(now = Date.now()): Promise<void> {
  if (running || !openCatalogDb()) return;
  running = true;
  const state = kvGet<SyncState>('sync:state')?.value ?? {};
  const { sink, flush } = makeSink();
  try {
    const hotQueries: DoubanQuery[] = [
      { kind: 'tv', tags: '动画', sort: 'U', pages: 4 },
      { kind: 'tv', tags: '电视剧', sort: 'U', pages: 4 },
      { kind: 'tv', tags: '综艺', sort: 'U', pages: 2 },
      { kind: 'movie', tags: '电影', sort: 'U', pages: 4 },
      { kind: 'movie', tags: '纪录片', sort: 'U', pages: 1 },
    ];
    await syncDoubanQueries(sink, hotQueries, now, () => false, () => undefined);
    await syncBiliRecent(sink, now);
    await syncTmdbRecent(sink, now);
    await syncBangumiCalendar(sink, now);
    await syncHotLists(sink, now);
    flush();
    await rebuildChannels(CATALOG_CHANNELS, now);
    const hours = state.incAt ? Math.min(72, Math.max(2, Math.ceil((now - state.incAt) / 3600_000) + 1)) : 24;
    await syncSourceUpdates(hours, 8);
    kvSet('sync:state', { ...state, incAt: Date.now(), phase: 'idle', lastError: undefined } satisfies SyncState);
  } catch (err) {
    flush();
    kvSet('sync:state', { ...state, lastError: err instanceof Error ? err.message : String(err), phase: 'error' });
    log('增量同步出错：', err);
  } finally {
    running = false;
  }
}

export function catalogSyncStatus() {
  const state = kvGet<SyncState>('sync:state');
  return {
    running,
    state: state?.value ?? null,
    counts: Object.fromEntries(CATALOG_CHANNELS.map((c) => [c, countWorks(c)])),
  };
}

let started = false;

/** 伺服器启动时调用（instrumentation.ts）：片库空 / 7 天没全量就全量，之后每小时增量 */
export function startCatalogSync(): void {
  if (started || process.env.CATALOG_SYNC === '0') return;
  if (!openCatalogDb()) return;
  started = true;
  const tick = async () => {
    const state = kvGet<SyncState>('sync:state')?.value;
    const now = Date.now();
    const fullDue = countWorks() === 0 || !state?.fullAt || now - state.fullAt > FULL_EVERY || state.phase === 'full';
    if (fullDue) await runFullSync(now);
    else if (!state?.incAt || now - state.incAt >= INCREMENTAL_EVERY - 60_000) await runIncrementalSync(now);
  };
  const loop = () => {
    void tick().finally(() => setTimeout(loop, INCREMENTAL_EVERY).unref?.());
  };
  setTimeout(loop, FIRST_DELAY).unref?.();
}
