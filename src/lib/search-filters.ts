import type { AggregatedGroup } from './title-aliases';
import { normalizeTitle } from './cms-parser';

/**
 * 搜索结果页的筛选和排序（纯函数，页面和测试共用）。
 * 类型、地区从采集站的分类名（「国产剧」「日韩动漫」「动作片」「综艺」）和地区字段推断——各站写法不一，
 * 按一部里多数条目的说法算。
 */

export type SearchKind = 'all' | 'movie' | 'tv' | 'anime' | 'show' | 'doc' | 'other';
export type SearchRegion = 'all' | 'cn' | 'jpkr' | 'west' | 'other';
export type SearchYear = 'all' | 'this' | 'recent' | '2020s' | '2010s' | 'older';
export type SearchStatus = 'all' | 'airing' | 'ended';
export type SearchSort = 'year-desc' | 'year-asc' | 'relevance' | 'sources';

export interface SearchFilters {
  kind: SearchKind;
  region: SearchRegion;
  year: SearchYear;
  status: SearchStatus;
  sort: SearchSort;
}

export const DEFAULT_SEARCH_FILTERS: SearchFilters = { kind: 'all', region: 'all', year: 'all', status: 'all', sort: 'relevance' };

export const KIND_LABELS: Record<SearchKind, string> = {
  all: '全部',
  movie: '电影',
  tv: '剧集',
  anime: '动漫',
  show: '综艺',
  doc: '纪录片',
  other: '其他',
};
export const REGION_LABELS: Record<SearchRegion, string> = { all: '全部', cn: '华语', jpkr: '日韩', west: '欧美', other: '其他' };
export const YEAR_LABELS: Record<SearchYear, string> = {
  all: '全部',
  this: '今年',
  recent: '近三年',
  '2020s': '2020 年代',
  '2010s': '2010 年代',
  older: '更早',
};
export const STATUS_LABELS: Record<SearchStatus, string> = { all: '全部', airing: '连载中', ended: '已完结' };
export const SORT_LABELS: Record<SearchSort, string> = {
  'year-desc': '年份 · 新→旧',
  'year-asc': '年份 · 旧→新',
  relevance: '相关度',
  sources: '片源最多',
};

/** 一条的分类名 → 类型 */
export function kindOfType(typeName: string | undefined): SearchKind {
  const t = typeName ?? '';
  if (!t) return 'other';
  if (/动漫|动画|番剧|国创|卡通/.test(t)) return 'anime';
  if (/纪录|记录片/.test(t)) return 'doc';
  if (/综艺|真人秀|脱口秀|晚会/.test(t)) return 'show';
  if (/片$|电影|影片|剧场版|微电影/.test(t) && !/短剧/.test(t)) return 'movie';
  if (/剧|连续剧|电视/.test(t)) return 'tv';
  return 'other';
}

/** 分类名 / 地区字段 → 地区 */
export function regionOf(typeName: string | undefined, area: string | undefined): SearchRegion {
  const t = `${typeName ?? ''} ${area ?? ''}`;
  if (!t.trim()) return 'other';
  if (/国产|大陆|内地|中国|华语|港|台|国语|粤语/.test(t)) return 'cn';
  if (/日|韩|日韩/.test(t)) return 'jpkr';
  if (/欧美|美国|英国|法国|德国|美剧|英剧|西班牙|意大利|加拿大|澳大利亚/.test(t)) return 'west';
  return 'other';
}

/** 一部里多数条目的说法 */
function majority<T>(values: T[], fallback: T): T {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = fallback;
  let max = 0;
  for (const [v, n] of counts) {
    if (n > max) {
      best = v;
      max = n;
    }
  }
  return best;
}

export function groupKind(g: AggregatedGroup): SearchKind {
  const kinds = g.items.map((i) => kindOfType(i.typeName)).filter((k) => k !== 'other');
  return kinds.length > 0 ? majority(kinds, 'other') : 'other';
}

export function groupRegion(g: AggregatedGroup): SearchRegion {
  const regions = g.items.map((i) => regionOf(i.typeName, i.area)).filter((r) => r !== 'other');
  return regions.length > 0 ? majority(regions, 'other') : 'other';
}

/** 连载 / 完结：看更新说明（「更新至12集」「全24集」「完结」） */
export function groupStatus(g: AggregatedGroup): 'airing' | 'ended' | undefined {
  const texts = g.items.map((i) => i.remarks ?? '').filter(Boolean);
  if (texts.some((t) => /完结|全\s*\d+\s*[集话期]|大结局/.test(t))) return 'ended';
  if (texts.some((t) => /更新至|更新到|连载|第\s*\d+\s*[集话期]/.test(t))) return 'airing';
  return undefined;
}

function yearMatches(year: number | undefined, filter: SearchYear, nowYear: number): boolean {
  if (filter === 'all') return true;
  if (!year) return false;
  switch (filter) {
    case 'this':
      return year >= nowYear;
    case 'recent':
      return year >= nowYear - 2;
    case '2020s':
      return year >= 2020 && year < 2030;
    case '2010s':
      return year >= 2010 && year < 2020;
    case 'older':
      return year < 2010;
  }
}

const CN_NUM: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const DUBBED = /粤语|国语|中配|普通话|配音|台配|港配/;
const COMMENTARY = /解说|预告|花絮|片段|reaction/i;

/** 「第二季」「第2季」「season2」「2」「第十二季」→ 季数；不是季数返回 undefined */
function seasonOf(rest: string): number | undefined {
  if (!rest) return 1;
  const m = rest.match(/^(?:第([0-9]+|[一二两三四五六七八九十]+)[季部期]|season([0-9]+)|s([0-9]+)|([0-9]{1,2}))$/i);
  if (!m) return undefined;
  const token = m[1] ?? m[2] ?? m[3] ?? m[4];
  // 「咒术回战0」是剧场版，不是第 0 季
  if (/^\d+$/.test(token)) return parseInt(token, 10) || undefined;
  if (token === '十') return 10;
  const tens = token.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/);
  if (tens) return (tens[1] ? CN_NUM[tens[1]] : 1) * 10 + (tens[2] ? CN_NUM[tens[2]] : 0);
  return CN_NUM[token];
}

/**
 * 和搜索词有多像（越小越靠前），第二个数是季数：
 * 0 这部剧本身的各季（片名就是搜索词 = 第一季，搜索词 + 第N季），按季数排；
 * 1 以搜索词开头的其他作品（剧场版、总集篇、「死灭回游」这种副标题）；
 * 2 配音版（粤语 / 国语）、只是包含搜索词的；3 电影解说、预告和其他（别名搜到的等）。
 * 没给搜索词时都算 0。
 */
export function relevanceRank(name: string, typeName: string | undefined, query?: string): [number, number] {
  const q = query ? normalizeTitle(query) : '';
  if (!q) return [0, 0];
  if (COMMENTARY.test(`${name} ${typeName ?? ''}`)) return [3, 0];
  const n = normalizeTitle(name);
  if (DUBBED.test(name)) return [n.includes(q) ? 2 : 3, 0];
  if (n.startsWith(q)) {
    const season = seasonOf(n.slice(q.length));
    return season !== undefined ? [0, season] : [1, 0];
  }
  return [n.includes(q) ? 2 : 3, 0];
}

/**
 * 按筛选条件过滤、排序。
 * relevance（默认）= 先按和搜索词有多像分档（这部剧本身的各季按季数排），同一档里年份新的在前；
 * 年份排序不看相关度；片源最多看源数。
 */
export function applySearchFilters(
  groups: AggregatedGroup[],
  f: SearchFilters,
  nowYear = new Date().getFullYear(),
  query?: string,
): AggregatedGroup[] {
  const filtered = groups.filter(
    (g) =>
      (f.kind === 'all' || groupKind(g) === f.kind) &&
      (f.region === 'all' || groupRegion(g) === f.region) &&
      (f.status === 'all' || groupStatus(g) === f.status) &&
      yearMatches(parseInt(g.year ?? '', 10) || undefined, f.year, nowYear),
  );
  const indexed = filtered.map((g, i) => ({
    g,
    i,
    y: parseInt(g.year ?? '', 10) || 0,
    n: new Set(g.items.map((x) => x.sourceKey)).size,
    rank: f.sort === 'relevance' ? relevanceRank(g.name, g.typeName, query) : ([0, 0] as [number, number]),
  }));
  indexed.sort((a, b) => {
    if (f.sort === 'sources') return b.n - a.n || a.i - b.i;
    // 相关度：先分档，这部剧本身的各季按第一季、第二季……排
    if (a.rank[0] !== b.rank[0]) return a.rank[0] - b.rank[0];
    if (a.rank[1] !== b.rank[1]) return a.rank[1] - b.rank[1];
    // 没有年份的放最后
    if (!a.y !== !b.y) return a.y ? -1 : 1;
    const d = f.sort === 'year-asc' ? a.y - b.y : b.y - a.y;
    return d || a.i - b.i;
  });
  return indexed.map((x) => x.g);
}

/** 每个选项下有几部（按其他条件都不变算），没有的选项不显示 */
export function countBy<K extends string>(groups: AggregatedGroup[], of: (g: AggregatedGroup) => K | undefined): Map<K, number> {
  const m = new Map<K, number>();
  for (const g of groups) {
    const k = of(g);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}
