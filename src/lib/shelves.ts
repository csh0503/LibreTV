import type { DoubanItem } from './types';
import { getCache, setCache } from './fetch-utils';
import { fetchHotList, tmdbTrendingToItem, type HotListId, type TmdbTrendingRaw } from './douban-weekly';
import { tmdbGet } from './tmdb';
import { dropUnreleased, fetchUnreleasedIndex } from './unreleased';
import { isShelfId } from './shelf-defs';

/**
 * 首页货架的取数：每一行由固定、可解释的来源组成，来源之间只做「补缺」，不做「各自成排」。
 * - 热榜类（豆瓣 / B站 / Bangumi / 百度的多源融合）直接复用 fetchHotList
 * - 题材类用 TMDB discover（已播出、近 3 年、有口碑），tv 与 movie 交错
 * 出口统一：剔除未播出条目、只留有封面的、每行最多 24 条。
 */

const SHELF_TTL = 15 * 60 * 1000;
const SHELF_LIMIT = 24;
const hasCJK = (s: string) => /[一-龥]/.test(s);
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
  genres: string;
  /** 额外的 discover 参数 */
  extra?: Record<string, string>;
}

async function discoverOne(kind: 'tv' | 'movie', spec: DiscoverSpec, now: number): Promise<DoubanItem[]> {
  const today = cnDate(now);
  const since = cnDate(now - 3 * 365 * 24 * 3600_000);
  const dateField = kind === 'tv' ? 'first_air_date' : 'primary_release_date';
  // 去重会吃掉一部分，多取一页留出余量
  const pages = await Promise.all(
    [1, 2].map((page) =>
      tmdbGet<{ results?: TmdbTrendingRaw[] }>(`/discover/${kind}`, {
        with_genres: spec.genres,
        sort_by: 'popularity.desc',
        'vote_count.gte': kind === 'tv' ? '150' : '400',
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
    .filter((item): item is DoubanItem => item !== undefined && hasCJK(item.title));
}

async function discoverMix(specs: { tv?: DiscoverSpec; movie?: DiscoverSpec }, now: number): Promise<DoubanItem[]> {
  const [tv, movie] = await Promise.all([
    specs.tv ? discoverOne('tv', specs.tv, now) : Promise.resolve([]),
    specs.movie ? discoverOne('movie', specs.movie, now) : Promise.resolve([]),
  ]);
  return interleave([tv, movie]);
}

const hot = (id: HotListId) => fetchHotList(id);

async function settled(tasks: Promise<DoubanItem[]>[]): Promise<DoubanItem[][]> {
  const res = await Promise.allSettled(tasks);
  return res.map((r) => (r.status === 'fulfilled' ? r.value : []));
}

const LOADERS: Record<string, (now: number) => Promise<DoubanItem[]>> = {
  'hot-movies': () => hot('douban_movie_realtime'),
  'cn-tv': () => hot('douban_tv_domestic'),
  'anime-airing': () => hot('bili_bangumi'),
  guoman: () => hot('bili_guochuang'),
  'kr-jp-tv': () => hot('douban_tv_korean'),
  'us-tv': () => hot('douban_tv_american'),
  variety: () => hot('douban_show_hot'),
  acclaimed: async () => interleave(await settled([hot('douban_movie_weekly'), hot('douban_tv_chinese')])),
  'g-crime': (now) =>
    discoverMix(
      { tv: { genres: '80|9648', extra: { without_genres: '16' } }, movie: { genres: '80|9648', extra: { without_genres: '16' } } },
      now,
    ),
  'g-scifi': (now) => discoverMix({ tv: { genres: '10765' }, movie: { genres: '878|14' } }, now),
  'g-romance': (now) => discoverMix({ movie: { genres: '10749', extra: { without_genres: '16' } } }, now),
  'g-comedy': (now) => discoverMix({ tv: { genres: '35' }, movie: { genres: '35' } }, now),
  'g-action': (now) => discoverMix({ tv: { genres: '10759' }, movie: { genres: '28|12' } }, now),
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

  const raw = (await loader(now)).filter((i) => i.title && i.cover);
  let items = raw;
  try {
    items = dropUnreleased(raw, await fetchUnreleasedIndex(now));
  } catch {
    // 索引取不到时不影响货架
  }
  items = items.slice(0, SHELF_LIMIT);
  if (items.length === 0) throw new Error('货架数据为空');
  setCache(key, items, SHELF_TTL);
  return items;
}
