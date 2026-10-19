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

/** 一个条目的比对键：中文片名 + 原名（TMDB / Bangumi 有）。各站中文译名不同（「相反的你和我」/「正相反的你与我」）时靠原名对上 */
export function workKeys(primary: string, item: DoubanItem): string[] {
  const keys = primary ? [primary] : [];
  const orig = item.originalTitle ? canonicalTitle(item.originalTitle) : '';
  if (orig && orig !== primary) keys.push(`orig:${orig}`);
  return keys;
}

interface Work<T> {
  members: DoubanItem[];
  value: T;
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
    return undefined;
  }

  add(keys: string | string[], item: DoubanItem, value: T): void {
    const work: Work<T> = { members: [item], value };
    this.register(work, typeof keys === 'string' ? [keys] : keys);
    this.order.push(value);
  }
}
