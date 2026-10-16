/**
 * 「连载中 / 已完结 / 不确定」的唯一判定处。豆瓣、B站、Bangumi、TMDB 各来源的映射函数都只负责
 * 把手里的线索（更新说明、完结标记、年份、首播日期）交给这里，规则只写一遍，所有行看到同一个结果。
 * 「未播出」不在这里判断——那要查开播日期索引，见 unreleased.ts。
 */
export type TitleStatus = 'airing' | 'ended';

export interface StatusClues {
  /** 更新说明：「更新至12集」「全24话」「47集全」「已完结」…… */
  text?: string;
  /** 来源给的明确完结标记（如 B站片库 is_finish）；最可信 */
  finished?: boolean;
  /** false = 电影，没有连载 / 完结之分 */
  isTv?: boolean;
  /** 上映 / 首播年份 */
  year?: string;
  /** 首播日期 YYYY-MM-DD（有就用它判断是不是当季新番） */
  airDate?: string;
  /** 出现在本周放送表里 */
  fromCalendar?: boolean;
  /**
   * 有放送表可对照、但它不在表上（只有动漫频道有完整放送表）。
   * 这时「更新至N集」又是去年以前的作品，多半是豆瓣没改的旧状态。
   */
  absentFromCalendar?: boolean;
  /** 有没有评分；今年的条目既没评分也没集数，多半还没播 */
  hasRating?: boolean;
  /**
   * 线索里没有更新说明时，要不要按年份推断（片库要，热榜不要：热榜条目大多正在热播，
   * 没写「更新至」不代表完结）。
   */
  inferFromYear?: boolean;
}

/** 一季动画 / 剧集大约播三个月，首播后这么多天内又没有完结线索就当还在播 */
const CURRENT_SEASON_DAYS = 120;
const FINISHED_TEXT = /完结|已完结|全集|全\s*\d+\s*[集话期]|\d+\s*[集话期]\s*全/;
const ONGOING_TEXT = /更新|连载/;

export function judgeStatus(clues: StatusClues, now = Date.now()): TitleStatus | undefined {
  if (clues.isTv === false) return undefined;
  if (clues.fromCalendar) return 'airing';
  if (clues.finished === true) return 'ended';
  if (clues.finished === false) return 'airing';

  const nowYear = new Date(now).getFullYear();
  const text = clues.text ?? '';
  const year = parseInt(clues.year ?? clues.airDate?.slice(0, 4) ?? '', 10);

  if (FINISHED_TEXT.test(text)) return 'ended';
  if (ONGOING_TEXT.test(text)) {
    // 豆瓣很多旧番（如 2023《迷宫饭》）的「更新至14集」长期没改：已过 3 年且不到 60 集（非柯南这类长篇），必已完结
    const ep = parseInt(text.match(/(\d+)/)?.[1] ?? '0', 10);
    if (Number.isFinite(year) && year <= nowYear - 3 && ep > 0 && ep < 60) return 'ended';
    // 放送表上没有、又是去年以前开播的：已经播完了
    if (clues.absentFromCalendar && Number.isFinite(year) && year < nowYear && ep < 60) return 'ended';
    return 'airing';
  }

  if (clues.airDate && /^\d{4}-\d{2}-\d{2}$/.test(clues.airDate)) {
    const days = (now - Date.parse(`${clues.airDate}T00:00:00+08:00`)) / 86_400_000;
    if (days >= 0 && days <= CURRENT_SEASON_DAYS) return 'airing';
  }

  if (!clues.inferFromYear) return undefined;
  if (!Number.isFinite(year) || year < 1900 || year > nowYear + 5) return undefined;
  // 今年及以后、没有集数信息、也还没有评分：多半是没开播的预告 / 年番，不能当成「已完结」
  if (year >= nowYear && clues.hasRating === false) return undefined;
  // 没有「更新至」的年份条目算已完结，包括今年；否则「2026 + 已完结」会整页被滤空
  return 'ended';
}

const UNRELEASED_TEXT = /即将(?:开播|上线|播出|上映|开分)|敬请期待|未开播|定档/;

/**
 * 来源自己的更新说明就写着还没播（B站「即将开播」、豆瓣「敬请期待」）。
 * 用来补开播日期索引（unreleased.ts）查不到的条目，比如没登记日期的国创年番。
 */
export function looksUnreleased(text?: string): boolean {
  return Boolean(text && UNRELEASED_TEXT.test(text));
}
