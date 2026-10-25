import type { DoubanItem } from './types';
import { getCache, peekStale, setCache, singleflight } from './fetch-utils';
import { fetchHotList, tmdbTrendingToItem, type HotListId, type TmdbTrendingRaw } from './douban-weekly';
import { tmdbGet } from './tmdb';
import { dropUnreleased, fetchUnreleasedIndex } from './unreleased';
import { isShelfId, shelfDedupeKey } from './shelf-defs';
import { fetchDoubanTagged } from './douban';
import { mergeSameWorks } from './work-identity';
import { disambiguateTitles } from './title-disambiguate';

/**
 * 首页货架的取数：每一行由固定、可解释的来源组成，来源之间只做「补缺」，不做「各自成排」。
 * - 热榜类（豆瓣 / B站 / Bangumi / 百度的多源融合）直接复用 fetchHotList
 * - 题材类用 TMDB discover（已播出、近 3 年、有口碑），tv 与 movie 交错
 * - 热榜通常只有二十来部，后面用同一频道的 TMDB discover 接上，让一行能往右多翻几页
 * 出口统一：剔除未播出条目、只留有封面的、每行最多 40 条。
 */

const SHELF_TTL = 15 * 60 * 1000;
const SHELF_LIMIT = 40;
const hasCJK = (s: string) => /[一-龥]/.test(s);
/** TMDB 没有中文译名时会回落到日文原名（含假名），这种标题在片源站搜不到 */
const hasKana = (s: string) => /[\u3040-\u30ff]/.test(s);
const CN_AREA = /中国|大陆|香港|台湾|华语/;
const CN_OFFSET = 8 * 3600_000;

const cnDate = (ms: number) => new Date(ms + CN_OFFSET).toISOString().slice(0, 10);

/** 多个列表按名次交错合并（第 1 名们、第 2 名们……），同标题只留第一次出现 */
export function interleave(lists: DoubanItem[][]): DoubanItem[] {
  const out: DoubanItem[] = [];
  const seen = new Set<string>();
  const max = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < max; i++) {
    for (const list of lists) {
      const item = list[i];
      if (!item) continue;
      const key = item.title.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

interface DiscoverSpec {
  /** 逗号 = 且，竖线 = 或（TMDB 语法） */
  genres?: string;
  /** 额外的 discover 参数 */
  extra?: Record<string, string>;
}

async function discoverOne(kind: 'tv' | 'movie', spec: DiscoverSpec, now: number): Promise<DoubanItem[]> {
  const today = cnDate(now);
  const since = cnDate(now - 3 * 365 * 24 * 3600_000);
  const dateField = kind === 'tv' ? 'first_air_date' : 'primary_release_date';
  // 整页去重会吃掉不少，多取几页留出余量
  const pages = await Promise.all(
    [1, 2, 3].map((page) =>
      tmdbGet<{ results?: TmdbTrendingRaw[] }>(`/discover/${kind}`, {
        ...(spec.genres ? { with_genres: spec.genres } : {}),
        sort_by: 'popularity.desc',
        'vote_count.gte': kind === 'tv' ? '80' : '200',
        'vote_average.gte': '6.5',
        [`${dateField}.gte`]: since,
        [`${dateField}.lte`]: today,
        page: String(page),
        ...spec.extra,
      }),
    ),
  );
  return pages
    .flatMap((res) => res?.results ?? [])
    .map((row) => tmdbTrendingToItem({ ...row, media_type: kind }))
    .filter((item): item is DoubanItem => item !== undefined && hasCJK(item.title) && !hasKana(item.title));
}

async function discoverMix(specs: { tv?: DiscoverSpec; movie?: DiscoverSpec }, now: number): Promise<DoubanItem[]> {
  const [tv, movie] = await Promise.all([
    specs.tv ? discoverOne('tv', specs.tv, now) : Promise.resolve([]),
    specs.movie ? discoverOne('movie', specs.movie, now) : Promise.resolve([]),
  ]);
  return interleave([tv, movie]);
}

const hot = (id: HotListId) => fetchHotList(id);

/** 热榜在前，TMDB 接在后面补深度；同名只留热榜那条。补充源失败不影响热榜本身 */
async function withBackfill(primary: Promise<DoubanItem[]>, backfill: Promise<DoubanItem[]>): Promise<DoubanItem[]> {
  const [main, more] = await settled([primary, backfill]);
  if (main.length === 0 && more.length === 0) throw new Error('货架数据为空');
  return interleave([[...main, ...more]]);
}

/** 题材行只放真人剧集电影：动画、综艺、纪录片各有自己的行 */
const NOT_LIVE_ACTION = /动画|动漫|真人秀|脱口秀|纪录/;
const liveAction = (items: DoubanItem[]) => items.filter((i) => !NOT_LIVE_ACTION.test(i.genres ?? ''));

/** 一行里同一系列只留一个：位置取最先出现的那季，展示最新的那季（豆瓣会把《怪奇物语》第一到五季全列出来） */
export function collapseSeries(items: DoubanItem[]): DoubanItem[] {
  const slots = new Map<string, { at: number; item: DoubanItem }>();
  const order: string[] = [];
  items.forEach((item, at) => {
    const key = shelfDedupeKey(item.title, item.isTv) || item.title;
    const prev = slots.get(key);
    if (!prev) {
      slots.set(key, { at, item });
      order.push(key);
    } else if ((parseInt(item.year ?? '0', 10) || 0) > (parseInt(prev.item.year ?? '0', 10) || 0)) {
      prev.item = item;
    }
  });
  return order.map((k) => slots.get(k)!.item);
}

/**
 * 题材行：豆瓣同题材的剧集 + 近几年电影交错（贴近华语观众），TMDB discover 接在后面补深度。
 * 剧集在前（首页题材行以剧为主），电影只要 2020 年代的，避免全是《泰坦尼克号》这种老经典。
 */
async function genreRow(
  doubanTv: string[] | null,
  doubanMovie: string[] | null,
  tmdb: { tv?: DiscoverSpec; movie?: DiscoverSpec },
  now: number,
): Promise<DoubanItem[]> {
  const [tv, movie, backfill] = await settled([
    doubanTv ? fetchDoubanTagged('tv', doubanTv) : Promise.resolve([]),
    doubanMovie ? fetchDoubanTagged('movie', [...doubanMovie, '2020年代']) : Promise.resolve([]),
    discoverMix(tmdb, now),
  ]);
  const main = interleave([liveAction(tv), liveAction(movie)]);
  if (main.length === 0 && backfill.length === 0) throw new Error('货架数据为空');
  // 近三年的在前，《西游记》（1986）这种经典接在后面
  const all = collapseSeries(interleave([[...main, ...liveAction(backfill)]]));
  const nowYear = new Date(now + CN_OFFSET).getUTCFullYear();
  const recent = (i: DoubanItem) => (parseInt(i.year ?? '', 10) || nowYear) >= nowYear - 3;
  return [...all.filter(recent), ...all.filter((i) => !recent(i))];
}

/** 「新番」行：最近 45 天没有新集的（分割放送间歇、几年前的老番）不放 */
function stillAiring(items: DoubanItem[], now: number): DoubanItem[] {
  return items.filter((i) => i.status === 'airing' || !i.lastAired || now - Date.parse(i.lastAired) < 45 * 86_400_000);
}

/** 一年以上没有新集的老作品挪到后面（热播行要的是现在的） */
function staleLast(items: DoubanItem[], now: number): DoubanItem[] {
  const stale = (i: DoubanItem) => Boolean(i.lastAired && now - Date.parse(i.lastAired) > 365 * 86_400_000);
  return [...items.filter((i) => !stale(i)), ...items.filter(stale)];
}

const notCn = (items: DoubanItem[]) => items.filter((i) => !i.area || !CN_AREA.test(i.area));
const onlyCn = (items: DoubanItem[]) => items.filter((i) => !i.area || CN_AREA.test(i.area));
/** 剧集补充源里不要动画、综艺、纪录片，它们各有自己的行 */
const LIVE_ACTION_TV = { without_genres: '16,99,10764,10767' };
const NO_ANIME = { without_genres: '16' };

async function settled(tasks: Promise<DoubanItem[]>[]): Promise<DoubanItem[][]> {
  const res = await Promise.allSettled(tasks);
  return res.map((r) => (r.status === 'fulfilled' ? r.value : []));
}

const LOADERS: Record<string, (now: number) => Promise<DoubanItem[]>> = {
  'hot-movies': (now) =>
    withBackfill(
      hot('douban_movie_realtime'),
      discoverOne('movie', { extra: { 'vote_count.gte': '100', 'primary_release_date.gte': cnDate(now - 365 * 24 * 3600_000) } }, now),
    ),
  'cn-tv': (now) =>
    withBackfill(hot('douban_tv_domestic'), discoverOne('tv', { extra: { with_origin_country: 'CN', 'vote_count.gte': '5', ...LIVE_ACTION_TV } }, now)),
  // 日漫行只放日本（及没标地区的）作品，国创归「国漫热播」
  'anime-airing': async (now) =>
    stillAiring(notCn(
      await withBackfill(
        hot('bili_bangumi'),
        // 「新番」= 最近一个月内有新集播出的，而不是近几年热门的老番
        discoverOne(
          'tv',
          {
            genres: '16',
            extra: {
              with_origin_country: 'JP',
              'vote_count.gte': '5',
              'vote_average.gte': '6',
              'first_air_date.gte': cnDate(now - 5 * 365 * 24 * 3600_000),
              'air_date.gte': cnDate(now - 30 * 24 * 3600_000),
              'air_date.lte': cnDate(now),
            },
          },
          now,
        ),
      ),
    ), now),
  guoman: async (now) =>
    staleLast(onlyCn(
      await withBackfill(
        hot('bili_guochuang'),
        discoverOne('tv', { genres: '16', extra: { with_origin_country: 'CN', 'vote_count.gte': '3', 'vote_average.gte': '0' } }, now),
      ),
    ), now),
  'kr-jp-tv': (now) =>
    withBackfill(
      hot('douban_tv_korean'),
      settled([
        discoverOne('tv', { extra: { with_origin_country: 'KR', 'vote_count.gte': '30', ...LIVE_ACTION_TV } }, now),
        discoverOne('tv', { extra: { with_origin_country: 'JP', 'vote_count.gte': '20', ...LIVE_ACTION_TV } }, now),
      ]).then(interleave),
    ),
  'us-tv': (now) =>
    withBackfill(
      hot('douban_tv_american'),
      settled([
        discoverOne('tv', { extra: { with_origin_country: 'US', ...LIVE_ACTION_TV } }, now),
        discoverOne('tv', { extra: { with_origin_country: 'GB', 'vote_count.gte': '50', ...LIVE_ACTION_TV } }, now),
      ]).then(interleave),
    ),
  variety: async (now) =>
    staleLast(
      await withBackfill(
        hot('douban_show_hot'),
        discoverOne('tv', { genres: '10764|10767', extra: { with_origin_country: 'CN', 'vote_count.gte': '1', 'vote_average.gte': '0' } }, now),
      ),
      now,
    ),
  // 口碑：豆瓣周口碑榜 + TMDB 高分，评分没到 7.5 的不算「口碑」
  acclaimed: async (now) =>
    interleave(
      await settled([
        hot('douban_movie_weekly'),
        hot('douban_tv_chinese'),
        discoverOne('movie', { extra: { 'vote_count.gte': '1500', 'vote_average.gte': '7.5' } }, now),
      ]),
    ).filter((i) => parseFloat(i.rating ?? '0') >= 7.5),
  // 犯罪 / 悬疑里不要恐怖片（TMDB 的「悬疑」常带恐怖片）
  'g-crime': (now) =>
    genreRow(['悬疑'], ['犯罪'], {
      tv: { genres: '80|9648', extra: { without_genres: '16,27' } },
      movie: { genres: '80|9648', extra: { without_genres: '16,27' } },
    }, now),
  'g-scifi': (now) =>
    genreRow(['科幻'], ['科幻'], { tv: { genres: '10765', extra: NO_ANIME }, movie: { genres: '878|14', extra: NO_ANIME } }, now),
  'g-romance': (now) => genreRow(['爱情'], ['爱情'], { movie: { genres: '10749', extra: { without_genres: '16' } } }, now),
  'g-comedy': (now) =>
    genreRow(['喜剧'], ['喜剧'], {
      tv: { genres: '35', extra: { without_genres: '16,10764,10767' } },
      movie: { genres: '35', extra: NO_ANIME },
    }, now),
  'g-action': (now) =>
    genreRow(['动作'], ['动作'], { tv: { genres: '10759', extra: NO_ANIME }, movie: { genres: '28|12', extra: NO_ANIME } }, now),
  doc: async (now) =>
    interleave(
      await settled([hot('bili_doc'), discoverMix({ tv: { genres: '99' }, movie: { genres: '99' } }, now)]),
    ),
};

export async function loadShelf(id: string, now = Date.now()): Promise<DoubanItem[]> {
  const loader = LOADERS[id];
  if (!loader || !isShelfId(id)) throw new Error(`未知货架: ${id.slice(0, 30)}`);
  const key = `shelf:${id}`;
  const cached = getCache<DoubanItem[]>(key);
  if (cached) return cached;
  // 同一行已经在算时等这一次。刚过期的先返回，重算放背后。
  const pending = singleflight(key, () => loadShelfUncached(id, now));
  const stale = peekStale<DoubanItem[]>(key);
  if (stale) {
    void pending.catch(() => {});
    return stale;
  }
  return pending;
}

async function loadShelfUncached(id: string, now: number): Promise<DoubanItem[]> {
  const loader = LOADERS[id];
  if (!loader) throw new Error(`未知货架: ${id.slice(0, 30)}`);
  const key = `shelf:${id}`;
  const cached = getCache<DoubanItem[]>(key);
  if (cached) return cached;

  const raw = (await loader(now)).filter((i) => i.title && i.cover);
  let items = raw;
  try {
    items = dropUnreleased(raw, await fetchUnreleasedIndex(now));
  } catch {
    // 索引取不到时不影响货架
  }
  // 和老作品撞名的 TMDB 新作换成更具体的名字（乐高特别篇「航海王」→「乐高航海王」）
  items = await disambiguateTitles(items, now);
  // 不同来源同一部换了译名 / 季数写法（「黄泉的使者」/「黄泉使者」靠原名）：一行里只留一张
  items = mergeSameWorks(items).slice(0, SHELF_LIMIT);
  if (items.length === 0) throw new Error('货架数据为空');
  setCache(key, items, SHELF_TTL);
  return items;
}
