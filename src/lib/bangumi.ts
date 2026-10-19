import type { DoubanItem } from './types';
import { judgeStatus } from './title-status';
import { fetchUpstream, getCache, setCache } from './fetch-utils';

/**
 * Bangumi 每日放送（新番时间表）数据获取。
 * api.bgm.tv 完全公开免 key，服务端直连 + 内存缓存；
 * 数据复用 DoubanItem 结构，前端推荐区可无差别渲染。
 */

const BANGUMI_API = 'https://api.bgm.tv/calendar';
const CACHE_TTL = 30 * 60 * 1000;
// Bangumi 要求自带可识别的 UA，默认 UA（如 axios/undici）会被拒绝
const UA = 'LibreTV (+https://github.com/LibreSpark/LibreTV)';

/** 星期 id：1=周一 … 7=周日；calendar 偶发返回 8 等非法值，直接丢弃 */
export function normalizeWeekday(id: number): number | undefined {
  return id >= 1 && id <= 7 ? id : undefined;
}

interface BangumiSubject {
  id?: number;
  /** 本季首播日期 YYYY-MM-DD；放送表会把还没开播的定档作品也排在对应星期里 */
  air_date?: string;
  name?: string;
  name_cn?: string;
  images?: { large?: string; common?: string; medium?: string; small?: string; grid?: string };
  rating?: { score?: number; total?: number };
  collection?: { doing?: number };
}

interface BangumiCalendarDay {
  weekday?: { id?: number; en?: string; cn?: string };
  items?: BangumiSubject[];
}

/** 北京时间的 YYYY-MM-DD */
function cnToday(now = Date.now()): string {
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 首播日期晚于今天（北京时间）＝还没开播；没有日期的不判断，按已播出处理 */
export function isNotYetAired(airDate: string | undefined, today = cnToday()): boolean {
  return Boolean(airDate && /^\d{4}-\d{2}-\d{2}$/.test(airDate) && airDate > today);
}

/** 单条 subject → DoubanItem；缺标题或封面的条目视为脏数据丢弃 */
export function subjectToItem(subject: BangumiSubject): DoubanItem | undefined {
  const title = subject.name_cn || subject.name;
  const cover = subject.images?.large || subject.images?.common || subject.images?.medium;
  if (!subject.id || !title || !cover) return undefined;
  const score = subject.rating?.score ?? 0;
  const popularity = (subject.collection?.doing ?? 0) + (subject.rating?.total ?? 0) * 2;
  return {
    id: String(subject.id),
    title,
    cover,
    rating: score > 0 ? score.toFixed(1) : undefined,
    isTv: true,
    ...(subject.name && subject.name !== title ? { originalTitle: subject.name } : {}),
    ...(popularity > 0 ? { popularity } : {}),
  };
}

export function groupCalendarByWeekday(raw: BangumiCalendarDay[]): Record<number, DoubanItem[]> {
  const days: Record<number, DoubanItem[]> = {};
  for (const day of raw) {
    const weekday = normalizeWeekday(day.weekday?.id ?? -1);
    if (!weekday) continue;
    const items = (day.items ?? [])
      .map(subjectToItem)
      .filter((item): item is DoubanItem => item !== undefined);
    days[weekday] = items;
  }
  return days;
}

export async function fetchBangumiCalendar(): Promise<Record<number, DoubanItem[]>> {
  const cached = getCache<Record<number, DoubanItem[]>>(BANGUMI_API);
  if (cached) return cached;

  const res = await fetchUpstream(BANGUMI_API, {
    timeoutMs: 8000,
    headers: { 'User-Agent': UA, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Bangumi 接口响应异常 (${res.status})`);

  const raw = (await res.json()) as BangumiCalendarDay[];
  // 过滤掉无人问津/尚未正式开播的极冷门词条（如仅几人打分的实验短片），并按在看+评分热度降序排列
  const cleanedRaw = (Array.isArray(raw) ? raw : []).map((day) => ({
    ...day,
    items: (day.items ?? [])
      .filter((item) => {
        const votes = item.rating?.total ?? 0;
        const doing = item.collection?.doing ?? 0;
        // 放送表里「周二 · 2026-10-20 开播」这类还没开播的条目（想看人数不少）不是在播番，交给「即将播出」
        if (isNotYetAired(item.air_date)) return false;
        return Boolean(item.name_cn) && (votes >= 40 || doing >= 80);
      })
      .sort((a, b) => {
        const popA = (a.collection?.doing ?? 0) + (a.rating?.total ?? 0) * 2;
        const popB = (b.collection?.doing ?? 0) + (b.rating?.total ?? 0) * 2;
        return popB - popA;
      }),
  }));

  const days = groupCalendarByWeekday(cleanedRaw);
  if (Object.keys(days).length === 0) throw new Error('Bangumi 放送表数据为空');

  setCache(BANGUMI_API, days, CACHE_TTL);
  return days;
}

/**
 * 获取 Bangumi 当季全周最热门在播新番列表（用于「实时风向 · TOP 10」多源综合排名）
 */
export async function fetchBangumiHotAiring(limit = 24): Promise<DoubanItem[]> {
  const days = await fetchBangumiCalendar();
  const nowYear = String(new Date().getFullYear());
  // 全周放在一起按热度排：以前按星期交替抽取，名次只是「周几的第几名」，不是真实热度
  return Object.values(days)
    .flat()
    .sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0))
    .slice(0, limit)
    .map((item) => ({
      ...item,
      year: item.year || nowYear,
      area: '日本',
      genres: '动画 番剧',
      status: 'airing' as const,
      sourceLabel: 'Bangumi 在播',
    }));
}

interface BangumiV0SubjectRaw {
  id?: number;
  name?: string;
  name_cn?: string;
  date?: string;
  eps?: number;
  total_episodes?: number;
  images?: { large?: string; common?: string; medium?: string };
  rating?: { score?: number; total?: number };
  tags?: { name?: string; count?: number }[];
}

const BANGUMI_GENRE_MAP: Record<string, string> = {
  热血: '战斗',
  机战: '机甲',
  催泪: '治愈',
};

/**
 * Bangumi v0 官方权威番剧检索库（免 Key，支持按题材、地区、年份、评分、热度/排名筛选）
 */
export async function fetchBangumiCatalog(opts: {
  tags: string[];
  sort: 'U' | 'S' | 'R';
  score: string;
  pageStart: number;
  pageSize: number;
  status?: 'airing' | 'ended';
}): Promise<DoubanItem[]> {
  const cacheKey = `bgm-catalog:${opts.tags.join(',')}:${opts.sort}:${opts.score}:${opts.status ?? 'all'}:${opts.pageStart}:${opts.pageSize}`;
  const cached = getCache<DoubanItem[]>(cacheKey);
  if (cached) return cached;

  const bgmTags: string[] = ['TV'];
  let yearFilter: string[] | undefined;

  for (const tag of opts.tags) {
    if (tag === '动画' || tag === '日本') continue;
    if (tag === '中国大陆' || tag === '华语') {
      bgmTags.push('国产');
      continue;
    }
    if (tag === '美国' || tag === '欧美') {
      bgmTags.push('欧美');
      continue;
    }
    if (/^\d{4}$/.test(tag)) {
      yearFilter = [`>=${tag}-01-01`, `<=${tag}-12-31`];
      continue;
    }
    bgmTags.push(BANGUMI_GENRE_MAP[tag] || tag);
  }

  // 连载中 = 首播在 120 天内（与 title-status 的「当季」一致）；已完结 = 首播早于那之前
  const seasonCutoff = new Date(Date.now() + 8 * 3600_000 - 120 * 86_400_000).toISOString().slice(0, 10);
  if (opts.status === 'airing') yearFilter = [...(yearFilter ?? []), `>=${seasonCutoff}`];
  if (opts.status === 'ended') yearFilter = [...(yearFilter ?? []), `<${seasonCutoff}`];

  const [minScoreStr] = opts.score.split(',');
  const minScore = parseFloat(minScoreStr || '0');
  const ratingFilter = minScore > 0 ? [`>=${minScore}`] : ['>=5.5'];
  const sortMode = opts.sort === 'S' ? 'score' : opts.sort === 'R' ? 'date' : 'heat';

  const res = await fetchUpstream(
    `https://api.bgm.tv/v0/search/subjects?limit=${opts.pageSize}&offset=${opts.pageStart}`,
    {
      method: 'POST',
      timeoutMs: 7000,
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        keyword: '',
        sort: sortMode,
        filter: {
          type: [2],
          tag: bgmTags,
          ...(yearFilter ? { air_date: yearFilter } : {}),
          rating: ratingFilter,
        },
      }),
    }
  );
  if (!res.ok) throw new Error(`Bangumi v0 片库响应异常 (${res.status})`);
  const json = (await res.json()) as { data?: BangumiV0SubjectRaw[] };
  const rows = Array.isArray(json.data) ? json.data : [];

  const todayStr = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  const items: DoubanItem[] = [];
  for (const row of rows) {
    const title = (row.name_cn || '').trim();
    const cover = row.images?.large || row.images?.common || row.images?.medium;
    const votes = row.rating?.total ?? 0;
    if (!row.id || !title || !cover || votes < 50) continue;
    // 还没开播（或没有开播日期）的条目片源站不可能有，直接不进片库，交给「即将播出」
    if (!row.date || row.date > todayStr) continue;

    const year = row.date && /^\d{4}/.test(row.date) ? row.date.slice(0, 4) : undefined;
    const epCount = row.total_episodes || row.eps || 0;
    // 首播 120 天内算当季在播，更早的按年份推断（规则见 title-status.ts）
    const status = judgeStatus({
      airDate: row.date,
      year,
      hasRating: (row.rating?.score ?? 0) > 0,
      inferFromYear: true,
    });
    const remarks = epCount > 0 ? (status === 'ended' ? `全${epCount}话` : `共${epCount}话`) : undefined;
    const topGenres = (row.tags ?? [])
      .map((t) => t.name?.trim())
      .filter((n): n is string => Boolean(n && n.length <= 4 && !/^\d/.test(n) && n !== 'TV'))
      .slice(0, 3)
      .join(' ');

    items.push({
      id: `bgm_${row.id}`,
      title,
      cover,
      rating: row.rating?.score && row.rating.score > 0 ? row.rating.score.toFixed(1) : undefined,
      isTv: true,
      year,
      area: bgmTags.includes('国产') ? '中国大陆' : '日本',
      // 都是动画：标上「动画」，合并时才不会被当成同名的真人剧
      genres: topGenres ? `动画 ${topGenres}` : '动画',
      originalTitle: row.name?.trim() || undefined,
      remarks,
      status,
      sourceLabel: 'Bangumi 番组计划',
    });
  }

  setCache(cacheKey, items, CACHE_TTL);
  return items;
}

