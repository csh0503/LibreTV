import { mergeWorkMeta } from './catalog-meta';
import type { DoubanItem } from './types';
import { canonicalTitle } from './title-aliases';

/**
 * 「是不是同一部」：各来源（豆瓣 / B站 / Bangumi / TMDB / 百度……）合并条目时共用的判断。
 *
 * 以前只看规范化片名，同名的不同作品会被拼成一张卡：TMDB 2026 年的乐高特别篇中文名也叫「航海王」，
 * 和 1999 年的《航海王》合并后，封面是老番的、年份简介是乐高的。现在片名一样还要再看：
 * 1. 同一个来源的编号不同 → 不同作品（同一个来源不会给同一部两个编号）；
 * 2. 剧集 / 电影不同 → 不同作品；
 * 3. 两边都有可靠年份、差两年以上 → 不同作品（差一年算同一部：跨年开播、各站登记不一）；
 * 4. 集数和开播年份对不上：今年才开播的剧不可能已经播到几百集；
 * 5. 一边是动画、一边明确不是（《时光代理人》动画 vs 真人剧）→ 不同作品。
 * acrossSeasons：排行榜按「系列」合并（第一季、第三季算一个坑位），不看编号和年份，只看 2、4、5。
 */

/** 编号的命名空间。纯数字的编号豆瓣和 Bangumi 都有，分不清，不参与判断；百度的编号是名次，也不算 */
export function idNamespace(id: string | undefined): string | undefined {
  if (!id) return undefined;
  if (/^tmdb_\d+$/.test(id)) return 'tmdb';
  if (/^bili(?:_idx)?_\d+$/.test(id)) return 'bili';
  if (/^bgm_\d+$/.test(id)) return 'bgm';
  return undefined;
}

function idValue(id: string): string {
  return id.replace(/^bili_idx_/, 'bili_');
}

/** 备注里写的集数（「更新至1150话」「全24集」）；「更新至20251016期」这种日期不算 */
export function episodeCountOf(remarks: string | undefined): number | undefined {
  const m = remarks?.match(/(?:^|[^\d])(\d{1,4})\s*[集话話]/);
  return m ? parseInt(m[1], 10) : undefined;
}

/** 可靠的年份：来源自己给的；按筛选条件填上去的（yearSoft）不算 */
function firmYear(item: DoubanItem): number | undefined {
  if (item.yearSoft) return undefined;
  const y = parseInt(item.year ?? '', 10);
  return Number.isFinite(y) && y > 1900 ? y : undefined;
}

/** 一年最多能播多少集：日播剧一个月四十集，按 150 集 / 年放宽 */
const MAX_EPISODES_PER_YEAR = 150;

function episodesFitYear(withYear: DoubanItem, withEpisodes: DoubanItem, nowYear: number): boolean {
  const year = firmYear(withYear);
  const eps = episodeCountOf(withEpisodes.remarks);
  if (!year || !eps) return true;
  return eps <= (Math.max(0, nowYear - year) + 1) * MAX_EPISODES_PER_YEAR;
}

const ANIMATION = /动画|动漫|番剧|国创/;

/** 动画 / 真人：题材没写就是不知道 */
function animated(item: DoubanItem): boolean | undefined {
  if (!item.genres?.trim()) return undefined;
  return ANIMATION.test(item.genres);
}

export function sameWork(
  a: DoubanItem,
  b: DoubanItem,
  opts: { acrossSeasons?: boolean; nowYear?: number } = {},
): boolean {
  const nowYear = opts.nowYear ?? new Date().getFullYear();
  if (a.isTv !== undefined && b.isTv !== undefined && a.isTv !== b.isTv) return false;
  if (!episodesFitYear(a, b, nowYear) || !episodesFitYear(b, a, nowYear)) return false;
  const aa = animated(a);
  const ab = animated(b);
  if (aa !== undefined && ab !== undefined && aa !== ab) return false;
  if (opts.acrossSeasons) return true;
  const ns = idNamespace(a.id);
  if (ns && ns === idNamespace(b.id) && idValue(a.id) !== idValue(b.id)) return false;
  const ya = firmYear(a);
  const yb = firmYear(b);
  if (ya && yb && Math.abs(ya - yb) > 1) return false;
  return true;
}

const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const ROMAN: Record<string, number> = { Ⅱ: 2, Ⅲ: 3, Ⅳ: 4, Ⅴ: 5, Ⅵ: 6, Ⅶ: 7, Ⅷ: 8, Ⅸ: 9, Ⅹ: 10 };

function seasonNumber(token: string): number | undefined {
  if (/^\d+$/.test(token)) return parseInt(token, 10);
  if (ROMAN[token]) return ROMAN[token];
  if (token === '十') return 10;
  const m = token.match(/^([一二两三四五六七八九])?(十)?([一二三四五六七八九])?$/);
  if (!m) return undefined;
  if (!m[2]) return m[1] ? CN_DIGITS[m[1]] : undefined;
  return (m[1] ? CN_DIGITS[m[1]] : 1) * 10 + (m[3] ? CN_DIGITS[m[3]] : 0);
}

/**
 * 「系列名 + 第几季」：季数写法和副标题各站不一样时靠它对上——
 * 「无职转生 第三季 ～到了异世界就拿出真本事～」和「无职转生Ⅲ 到了异世界就拿出真本事」都是「无职转生 · 第 3 季」。
 * 只认明写的第二季及以后（第N季 / 第N期 / Season N / 罗马数字 Ⅱ~Ⅹ），系列名取季数前面那段；
 * 第一季、没写季数的不出这个键（太容易撞名）。
 */
export function seasonKey(title: string): string | undefined {
  const t = title.normalize('NFKC');
  const m =
    t.match(/^(.+?)\s*第\s*([0-9一二两三四五六七八九十]+)\s*[季期部]/) ??
    t.match(/^(.+?)\s*(?:Season|S)\s*([0-9]+)\b/i) ??
    title.match(/^(.+?)\s*([ⅡⅢⅣⅤⅥⅦⅧⅨⅩ])(?=\s|$|[：:～~\-—])/);
  if (!m) return undefined;
  const season = seasonNumber(m[2]);
  const base = canonicalTitle(m[1]);
  if (!season || season < 2 || base.length < 2) return undefined;
  return `season:${base}#${season}`;
}

/**
 * 一个条目的比对键：中文片名 + 原名（TMDB / Bangumi 有）+ 系列名和季数。
 * 各站中文译名不同（「相反的你和我」/「正相反的你与我」）时靠原名，季数写法不同时靠系列名和季数。
 */
export function workKeys(primary: string, item: DoubanItem): string[] {
  const keys = primary ? [primary] : [];
  const orig = item.originalTitle ? canonicalTitle(item.originalTitle) : '';
  if (orig && orig !== primary) keys.push(`orig:${orig}`);
  const season = seasonKey(item.title);
  if (season) keys.push(season);
  // 「龙之家族第一季」和「龙之家族」：有的站写第一季、有的不写
  const s1 = item.title.normalize('NFKC').match(/^(.+?)\s*(?:第一[季部]|第1[季部]|season\s*1)\s*$/i);
  if (s1) {
    const base = canonicalTitle(s1[1]);
    if (base && !keys.includes(base)) keys.push(base);
  }
  return keys;
}

interface Work<T> {
  members: DoubanItem[];
  value: T;
}

/**
 * 同一部作品、各站译名不一样（「躲在超市后门抽烟的两人」/「在超市后门吸烟的二人」、「相反的你和我」/「正相反的你与我」），
 * 又没有原名可对：按字重合度认。条件很严，宁可漏不可错——
 * 两边都至少 5 个字、长度相差不到四分之一、短的那个至少四分之三的字在长的里面出现、
 * 数字（季数、续作编号）一样、两边都有来源自己给的年份且同一年、电影 / 剧集一致。
 */
export function similarTitles(a: DoubanItem, b: DoubanItem): boolean {
  const ta = canonicalTitle(a.title);
  const tb = canonicalTitle(b.title);
  if (!ta || !tb || ta === tb) return false;
  const [short, long] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (short.length < 5 || short.length / long.length < 0.75) return false;
  // 只看阿拉伯数字和罗马数字（「两人」「二人」的两 / 二不是编号；第N季交给 seasonKey）
  const digits = (t: string) => (t.match(/[0-9]+|[ⅡⅢⅣⅤⅥⅦⅧⅨⅩ]/g) ?? []).join(',');
  if (digits(ta) !== digits(tb)) return false;
  if (seasonKey(a.title) !== seasonKey(b.title)) return false;
  const ya = firmYear(a);
  const yb = firmYear(b);
  if (!ya || !yb || ya !== yb) return false;
  if (a.isTv === undefined || b.isTv === undefined || a.isTv !== b.isTv) return false;
  const pool = [...long];
  let hit = 0;
  for (const ch of short) {
    const at = pool.indexOf(ch);
    if (at >= 0) {
      hit++;
      pool.splice(at, 1);
    }
  }
  return hit / short.length >= 0.75;
}

/**
 * 按比对键分桶、桶里再按 sameWork 分成不同作品。
 * 一部作品记下所有并进来的条目，新条目要和每一条都对得上才并进去（不会 A≈B、B≈C 就把 A、C 拼一起）；
 * 并进来的条目带来的新键（另一种译名、原名）也记到这部作品上，后面用那个名字来的也能对上。
 */
export class WorkGroups<T> {
  private readonly index = new Map<string, Work<T>[]>();
  /** 按第一次出现的顺序 */
  readonly order: T[] = [];
  private readonly works: Work<T>[] = [];

  constructor(private readonly opts: { acrossSeasons?: boolean; nowYear?: number } = {}) {}

  private register(work: Work<T>, keys: string[]) {
    for (const key of keys) {
      const list = this.index.get(key) ?? [];
      if (!list.includes(work)) list.push(work);
      this.index.set(key, list);
    }
  }

  /** 找到同一部就返回它（并记下这一条），没有返回 undefined */
  find(keys: string | string[], item: DoubanItem): T | undefined {
    const list = typeof keys === 'string' ? [keys] : keys;
    for (const key of list) {
      const hit = this.index.get(key)?.find((w) => w.members.every((m) => sameWork(m, item, this.opts)));
      if (hit) {
        hit.members.push(item);
        this.register(hit, list);
        return hit.value;
      }
    }
    // 键都对不上：最后看是不是译名不同的同一部（见 similarTitles）
    if (!this.opts.acrossSeasons) {
      for (const work of this.works) {
        if (work.members.some((m) => similarTitles(m, item)) && work.members.every((m) => sameWork(m, item, this.opts))) {
          work.members.push(item);
          this.register(work, list);
          return work.value;
        }
      }
    }
    return undefined;
  }

  add(keys: string | string[], item: DoubanItem, value: T): void {
    const work: Work<T> = { members: [item], value };
    this.works.push(work);
    this.register(work, typeof keys === 'string' ? [keys] : keys);
    this.order.push(value);
  }
}

/**
 * 一串条目里同一部只留第一次出现的（后面的拿来补缺：封面、评分、年份、原名）。
 * 片库翻页（各来源分页不同，同一部会落在不同页）和首页每一行的出口都过一遍。
 */
export function mergeSameWorks(items: DoubanItem[]): DoubanItem[] {
  const works = new WorkGroups<{ item: DoubanItem; members: DoubanItem[] }>();
  for (const item of items) {
    const keys = workKeys(canonicalTitle(item.title), item);
    if (keys.length === 0) {
      works.add([`id:${item.id}`], item, { item, members: [item] });
      continue;
    }
    const slot = works.find(keys, item);
    if (!slot) {
      works.add(keys, item, { item, members: [item] });
      continue;
    }
    slot.members.push(item);
    const prev = slot.item;
    slot.item = {
      ...prev,
      cover: prev.cover || item.cover,
      backdrop: prev.backdrop || item.backdrop,
      originalTitle: prev.originalTitle || item.originalTitle,
      remarks: prev.remarks || item.remarks,
    };
  }
  // 评分 / 年份 / 题材 / 地区按全站统一的规则合（见 catalog-meta）
  return works.order.map((slot) => (slot.members.length > 1 ? mergeWorkMeta(slot.item, slot.members) : slot.item));
}
