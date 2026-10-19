import type { DoubanItem, RatingSource } from './types';

/**
 * 片库的统一作品资料：同一部作品在豆瓣 / Bangumi / TMDB / B站各有一份，
 * 这里把它们合成一份（评分、年份、题材、地区），而不是谁先到用谁的。
 */

/**
 * 各站评分的校正：同一批作品上，各站相对豆瓣平均偏多少、可信度多高。
 * - Bangumi 打分严（同一部番普遍比豆瓣低半分左右）；
 * - TMDB 投票人少、口径接近豆瓣，略高一点点，可信度打折；
 * - B站的分普遍偏高（老番动辄 9.8、9.9），可信度最低，只在没有别的分时兜底。
 */
export const RATING_CALIBRATION: Record<RatingSource, { offset: number; weight: number; label: string }> = {
  douban: { offset: 0, weight: 1, label: '豆瓣' },
  bangumi: { offset: 0.5, weight: 0.8, label: 'Bangumi' },
  tmdb: { offset: -0.1, weight: 0.6, label: 'TMDB' },
  bili: { offset: -0.7, weight: 0.35, label: 'B站' },
};

/** 把各站评分校正到豆瓣口径后加权平均，一位小数 */
export function unifiedRating(ratings: Partial<Record<RatingSource, number>> | undefined): string | undefined {
  if (!ratings) return undefined;
  let sum = 0;
  let weight = 0;
  for (const [source, value] of Object.entries(ratings) as [RatingSource, number][]) {
    if (!(value > 0)) continue;
    const cal = RATING_CALIBRATION[source];
    sum += Math.min(10, Math.max(0, value + cal.offset)) * cal.weight;
    weight += cal.weight;
  }
  return weight > 0 ? (sum / weight).toFixed(1) : undefined;
}

/** 「豆瓣 8.5 · Bangumi 7.9 · TMDB 8.2」 */
export function describeRatings(ratings: Partial<Record<RatingSource, number>> | undefined): string | undefined {
  if (!ratings) return undefined;
  const order: RatingSource[] = ['douban', 'bangumi', 'tmdb', 'bili'];
  const parts = order
    .filter((s) => (ratings[s] ?? 0) > 0)
    .map((s) => `${RATING_CALIBRATION[s].label} ${ratings[s]!.toFixed(1)}`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/** 各站的题材写法换成同一套词（TMDB 的「动作冒险」「科幻奇幻」拆开，B站 / Bangumi 的同义词合并） */
const GENRE_SYNONYMS: Record<string, string[]> = {
  动作冒险: ['动作', '冒险'],
  科幻奇幻: ['科幻', '奇幻'],
  战争政治: ['战争'],
  恋爱: ['爱情'],
  恋爱喜剧: ['爱情', '喜剧'],
  爱情喜剧: ['爱情', '喜剧'],
  搞笑: ['喜剧'],
  推理: ['悬疑'],
  侦探: ['悬疑'],
  机战: ['机甲'],
  机器人: ['机甲'],
  治愈系: ['治愈'],
  校园青春: ['校园'],
  少儿: ['儿童'],
  番剧: [],
  国创: [],
  TV: [],
  原创: [],
  漫画改: [],
  小说改: [],
  游戏改: [],
};

export function canonicalGenreTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const token of raw.split(/[\s/、,，|]+/).filter(Boolean)) {
    const mapped = GENRE_SYNONYMS[token] ?? [token];
    for (const g of mapped) if (!out.includes(g)) out.push(g);
  }
  return out;
}

/**
 * 题材投票：每个来源给的题材各算一票，几个来源都说的排前面（同票按先到的顺序），最多 5 个。
 * 「动画」总放第一个（片库按它分频道）；原来的同义词也留着，免得「恋爱」芯片筛不到。
 */
export function mergeGenres(sources: (string | undefined)[]): string | undefined {
  const votes = new Map<string, { n: number; first: number }>();
  let order = 0;
  for (const raw of sources) {
    const seen = new Set<string>();
    for (const g of canonicalGenreTokens(raw)) {
      if (seen.has(g)) continue;
      seen.add(g);
      const v = votes.get(g);
      if (v) v.n++;
      else votes.set(g, { n: 1, first: order++ });
    }
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first).map(([g]) => g);
  const animated = ranked.includes('动画');
  const top = [...(animated ? ['动画'] : []), ...ranked.filter((g) => g !== '动画')].slice(0, 5);
  // 原始写法里的「恋爱」「搞笑」也带上，题材芯片按原词筛
  const originals = sources.flatMap((raw) => (raw ?? '').split(/\s+/)).filter((t) => (t === '恋爱' || t === '搞笑') && !top.includes(t));
  const all = [...top, ...new Set(originals)];
  return all.length > 0 ? all.join(' ') : undefined;
}

const AREA_ALIASES: Record<string, string> = {
  大陆: '中国大陆',
  内地: '中国大陆',
  中国: '中国大陆',
  香港: '中国香港',
  台湾: '中国台湾',
  美: '美国',
  日: '日本',
  韩: '韩国',
};

/** 地区统一写法，最多两个 */
export function normalizeArea(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const out: string[] = [];
  for (const token of raw.split(/[\s/、,，]+/).filter(Boolean)) {
    const a = AREA_ALIASES[token] ?? token;
    if (!out.includes(a)) out.push(a);
  }
  return out.slice(0, 2).join(' ') || undefined;
}

/** 来源对年份的可信度：自己给的开播 / 上映年 > 按筛选条件填的 */
const YEAR_PRIORITY: Record<MetaSource, number> = { douban: 4, bangumi: 3, tmdb: 3, bili: 2, other: 1 };

/**
 * 年份交叉核对：各来源自己给的年份投票，多数说了算；同票按来源可信度。
 * 筛选条件填上去的年份（yearSoft）不参加，只在谁都没给时兜底。
 */
export function pickYear(candidates: { year?: string; soft?: boolean; source: MetaSource }[]): { year?: string; soft?: boolean } {
  const firm = candidates.filter((c) => c.year && /^\d{4}$/.test(c.year) && !c.soft);
  if (firm.length === 0) {
    const soft = candidates.find((c) => c.year);
    return soft ? { year: soft.year, soft: true } : {};
  }
  const tally = new Map<string, number>();
  for (const c of firm) tally.set(c.year!, (tally.get(c.year!) ?? 0) + 10 + YEAR_PRIORITY[c.source]);
  const [year] = [...tally.entries()].sort((a, b) => b[1] - a[1])[0];
  return { year };
}

export type MetaSource = RatingSource | 'other';

/** 认来源：来源自己标的 → 编号前缀（豆瓣纯数字、bgm_、tmdb_、bili_ / bili_idx_）→ 榜单标签 */
export function sourceOfItem(item: Pick<DoubanItem, 'id' | 'origin' | 'sourceLabel'>): MetaSource {
  if (item.origin) return item.origin;
  if (item.id.startsWith('bgm_')) return 'bangumi';
  if (item.id.startsWith('tmdb_')) return 'tmdb';
  if (item.id.startsWith('bili_')) return 'bili';
  if (item.id.startsWith('baidu_')) return 'other';
  const label = item.sourceLabel ?? '';
  if (/Bangumi/i.test(label)) return 'bangumi';
  if (/TMDB/i.test(label)) return 'tmdb';
  if (/B站/.test(label)) return 'bili';
  if (/百度/.test(label)) return 'other';
  return 'douban';
}

const SOURCE_ORDER: Record<MetaSource, number> = { douban: 0, bangumi: 1, tmdb: 2, bili: 3, other: 4 };

function ratingOf(item: DoubanItem): number {
  const r = parseFloat(item.rating ?? '');
  return Number.isFinite(r) && r > 0 ? r : 0;
}

/**
 * 全站统一的作品资料：同一部作品的各来源成员合成一份。
 * - 评分：各站原始分（已融合过的成员带着 ratings 明细）按各站偏差校正后加权平均；
 * - 年份：各来源自己给的年份投票（筛选条件填的不算）；
 * - 题材：各来源的题材换成同一套词后投票；
 * - 地区：统一写法，按来源可信度取。
 * base 决定其余字段（片名、封面、状态…），由调用方按各自规则先挑好。
 */
export function mergeWorkMeta(base: DoubanItem, members: DoubanItem[]): DoubanItem {
  const ratings: Partial<Record<RatingSource, number>> = {};
  const years: { year?: string; soft?: boolean; source: MetaSource }[] = [];
  for (const m of members) {
    if (m.ratings) {
      for (const [src, v] of Object.entries(m.ratings) as [RatingSource, number][]) {
        if (v > 0 && ratings[src] === undefined) ratings[src] = v;
      }
    } else {
      const src = sourceOfItem(m);
      const r = ratingOf(m);
      if (r > 0 && src !== 'other' && ratings[src] === undefined) ratings[src] = r;
    }
    years.push({ year: m.year, soft: m.yearSoft, source: sourceOfItem(m) });
  }
  const hasRatings = Object.keys(ratings).length > 0;
  const { year, soft } = pickYear(years);
  const bySource = [...members].sort((a, b) => SOURCE_ORDER[sourceOfItem(a)] - SOURCE_ORDER[sourceOfItem(b)]);
  const area = normalizeArea(bySource.find((m) => m.area)?.area);
  return {
    ...base,
    ...(hasRatings ? { rating: unifiedRating(ratings), ratings } : {}),
    year: year ?? base.year,
    yearSoft: year ? soft || undefined : base.yearSoft,
    genres: mergeGenres(bySource.map((m) => m.genres)) ?? base.genres,
    area: area ?? base.area,
  };
}

/**
 * 卡片角标，全站一个规则：连载显示「更至N集」，完结只在有依据时才标
 * （只按年份猜的完结不标——今年的剧没写集数，不代表已经播完）。
 */
export function statusBadgeOf(item: Pick<DoubanItem, 'status' | 'statusGuessed' | 'remarks'>): { text: string; tone: 'ok' | 'warn' } | undefined {
  if (item.status === 'airing') {
    return { text: item.remarks && /更新至/.test(item.remarks) ? item.remarks.replace('更新至', '更至') : '连载', tone: 'warn' };
  }
  if (item.status === 'ended' && !item.statusGuessed) return { text: '完结', tone: 'ok' };
  return undefined;
}
