import type { DoubanItem } from './types';
import type { CatalogChannel } from './catalog-db';

/**
 * 本地片库的四种排序（纯计算，伺服器同步和测试共用）：
 *
 * - 总热门（pop_all）：全网累计人气——豆瓣评分人数、Bangumi 收藏数、B站总播放、TMDB 投票数，
 *   各自取对数映射到 0~1 再加权平均，几个站都有的再加一点。**不看年份、不扣老剧的分**：
 *   《海贼王》《银魂》《名侦探柯南》这种国民作品自然在最前面。
 * - 近期热播（pop_recent）：现在正在火——综合热榜名次、豆瓣「近期热门」名次、B站最近更新、
 *   TMDB 当下热度，乘上「最近有没有新内容」。
 * - 最新上线（sort_date）：首播日 / 最新一集日期（YYYY-MM-DD）由新到旧；只有年份的记成 YYYY-00-00，
 *   排在同一年有确切日期的后面。还没播出的不进片库。
 * - 最高评分（sort_rate）：各站评分按 catalog-meta 的校正合成一个分，再按评价人数做贝叶斯收缩
 *   （人少的往平均分拉），冷门刷分剧上不来。
 */

/** 各来源带来的人气 / 时间线索（合并时同一项取最大值） */
export interface RawSignals {
  /** 豆瓣评分人数 */
  doubanVotes?: number;
  /** 在豆瓣「近期热门」列表里的名次（0 起） */
  doubanHotRank?: number;
  /** Bangumi 看过 + 在看 */
  bgmCollect?: number;
  /** Bangumi 评分人数 */
  bgmVotes?: number;
  /** B站总播放 */
  biliPlays?: number;
  /** B站追番 / 追剧人数 */
  biliFollow?: number;
  /** 在 B站「最近更新」列表里的名次（0 起） */
  biliRecentRank?: number;
  /** TMDB 投票人数（累计） */
  tmdbVotes?: number;
  /** TMDB 当下热度（popularity，随时间变） */
  tmdbPopularity?: number;
  /** 在综合热榜（首页 TOP 10 那份）里的名次（0 起） */
  hotRank?: number;
  /** 首播 / 上映日（YYYY-MM-DD） */
  firstDate?: string;
  /** 最新一集的日期（YYYY-MM-DD；只知道月份的记成当月 1 日） */
  lastDate?: string;
  /** 「近期」类线索（名次、热度）是什么时候抓的：超过 3 天就不算「近期」了 */
  recentAt?: number;
}

/** 同步时存下来的一条原始条目：来源给的资料 + 线索 + 它该进哪个频道 */
export interface CatalogRawItem extends DoubanItem {
  channel: CatalogChannel;
  sig: RawSignals;
}

/**
 * 各线索的「冷门 → 顶流」参考值（取对数后线性映射到 0~1）和可信度（权重）。
 * B站总播放水分大（儿童动画、B站独播国创动辄几十亿），只当弱信号。
 */
const POP_REF: Record<'doubanVotes' | 'bgmCollect' | 'biliPlays' | 'tmdbVotes', { lo: number; hi: number; w: number }> = {
  // 豆瓣：几百人评 = 冷门，30 万人评 = 国民级（灌篮高手 25 万、猫和老鼠 21 万）
  doubanVotes: { lo: 200, hi: 300_000, w: 1 },
  // Bangumi：几十人看过 = 冷门，7 万 = 顶流（孤独摇滚 6.8 万、命运石之门 6.4 万）
  bgmCollect: { lo: 100, hi: 70_000, w: 0.85 },
  // B站：十万播放 = 冷门，百亿 = 顶流（凡人修仙传 76 亿、全职猎人 1.6 亿）
  biliPlays: { lo: 300_000, hi: 5_000_000_000, w: 0.45 },
  // TMDB：几十票 = 冷门，两万票 = 顶流（中文圈作品票数普遍偏少，权重低一点）
  tmdbVotes: { lo: 20, hi: 20_000, w: 0.6 },
};
/**
 * 「资料不足」的收缩量：分母多加这么多权重（相当于一个 0 分的虚拟来源）。
 * 只有一个站有记录的作品被往下拉，几个站都公认的才排得上去——
 * 不会出现只在 B站有几十亿播放的儿童动画压过《名侦探柯南》。
 */
const POP_SHRINK = 0.6;

export function normLog(value: number | undefined, lo: number, hi: number): number | undefined {
  if (!(value !== undefined && value > 0)) return undefined;
  const x = (Math.log10(value) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo));
  return Math.max(0, Math.min(1, x));
}

/** 总热门分（0~1）：累计人气的加权平均，资料越少往 0 收缩得越多；不看年份 */
export function popAllScore(sig: RawSignals): number {
  let sum = 0;
  let weight = 0;
  for (const [key, ref] of Object.entries(POP_REF) as [keyof typeof POP_REF, (typeof POP_REF)[keyof typeof POP_REF]][]) {
    const v = normLog(sig[key], ref.lo, ref.hi);
    if (v === undefined) continue;
    sum += v * ref.w;
    weight += ref.w;
  }
  if (weight === 0) return 0;
  return sum / (weight + POP_SHRINK);
}

const DAY = 86_400_000;
/** 「近期」线索多久内有效 */
const RECENT_TTL = 3 * DAY;

/** 最近有没有新内容：最新一集 / 首播离现在多久 */
export function recencyFactor(dates: { firstDate?: string; lastDate?: string; year?: number }, now: number): number {
  const latest = [dates.lastDate, dates.firstDate].filter(Boolean).sort().pop();
  const t = latest ? Date.parse(latest) : NaN;
  if (Number.isFinite(t)) {
    const days = (now - t) / DAY;
    if (days <= 45) return 1;
    if (days <= 120) return 0.85;
    if (days <= 365) return 0.6;
    return 0.35;
  }
  const nowYear = new Date(now + 8 * 3600_000).getUTCFullYear();
  if (dates.year && dates.year >= nowYear) return 0.9;
  if (dates.year && dates.year === nowYear - 1) return 0.6;
  return 0.35;
}

/** 近期热播分（0~1.x）：现在热不热 × 最近有没有新内容 */
export function popRecentScore(
  sig: RawSignals,
  dates: { firstDate?: string; lastDate?: string; year?: number },
  popAll: number,
  now: number,
): number {
  const fresh = sig.recentAt !== undefined && now - sig.recentAt <= RECENT_TTL;
  let r = 0;
  if (fresh && sig.hotRank !== undefined) r = Math.max(r, 1 - sig.hotRank / 80);
  if (fresh && sig.doubanHotRank !== undefined) r = Math.max(r, 0.9 * (1 - sig.doubanHotRank / 500));
  if (fresh && sig.biliRecentRank !== undefined) r = Math.max(r, 0.55 * (1 - sig.biliRecentRank / 400));
  const trend = normLog(sig.tmdbPopularity, 2, 800);
  if (trend !== undefined) r = Math.max(r, 0.75 * trend);
  // 同样热的，累计人气高的在前（小权重，只当平手时的次序）
  return r * recencyFactor(dates, now) + 0.04 * popAll;
}

/** 评价人数：各站人数换算到「豆瓣口径」（Bangumi / TMDB 人少，按比例放大） */
export function totalVotes(sig: RawSignals): number {
  return Math.round((sig.doubanVotes ?? 0) + 3 * (sig.bgmVotes ?? 0) + 4 * (sig.tmdbVotes ?? 0));
}

/** 贝叶斯评分：人少的往平均分拉；没有评分返回 0（排最后） */
export function bayesRating(rating: number | undefined, votes: number, prior = 6.8, m = 1500): number {
  if (!(rating !== undefined && rating > 0)) return 0;
  // 只有 B站分（人数未知）当很少人评
  const v = Math.max(votes, 50);
  return (v / (v + m)) * rating + (m / (v + m)) * prior;
}

/** 「最新上线」的排序键：YYYY-MM-DD；只有年份的 YYYY-00-00（排在同年有日期的后面）；什么都没有给空串 */
export function sortDateOf(dates: { firstDate?: string; lastDate?: string; year?: number }, today: string): string {
  const exact = [dates.lastDate, dates.firstDate]
    .filter((d): d is string => Boolean(d && /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today))
    .sort()
    .pop();
  if (exact) return exact;
  if (dates.year && String(dates.year) <= today.slice(0, 4)) return `${dates.year}-00-00`;
  return '';
}

export type CatalogSort = 'hot' | 'recent' | 'date' | 'rate';

export const SORT_COLUMN: Record<CatalogSort, 'pop_all' | 'pop_recent' | 'sort_date' | 'sort_rate'> = {
  hot: 'pop_all',
  recent: 'pop_recent',
  date: 'sort_date',
  rate: 'sort_rate',
};

/** 游标 = 上一页最后一张卡的（排序值, 作品编号）：按固定顺序往后接，往下翻几千部都不重不漏 */
export interface CatalogCursor {
  v: number | string;
  id: string;
}

export function encodeCursor(c: CatalogCursor): string {
  return Buffer.from(JSON.stringify([c.v, c.id]), 'utf8').toString('base64url');
}

export function decodeCursor(text: string | null | undefined): CatalogCursor | undefined {
  if (!text) return undefined;
  try {
    const [v, id] = JSON.parse(Buffer.from(text, 'base64url').toString('utf8')) as [unknown, unknown];
    if ((typeof v === 'number' || typeof v === 'string') && typeof id === 'string') return { v, id };
  } catch {
    // 坏游标当作从头
  }
  return undefined;
}

/** 「8月14日更新」「25年5月更新」「2025-05-01」→ YYYY-MM-DD（只到月份的取 1 日）；看不懂返回 undefined */
export function parseBiliUpdate(text: string | undefined, now: number): string | undefined {
  if (!text) return undefined;
  const pad = (n: number) => String(n).padStart(2, '0');
  const today = new Date(now + 8 * 3600_000);
  let m = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = text.match(/(\d{2})年(\d{1,2})月(?:(\d{1,2})日)?/);
  if (m) return `20${m[1]}-${pad(+m[2])}-${pad(m[3] ? +m[3] : 1)}`;
  m = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) {
    let year = today.getUTCFullYear();
    const candidate = `${year}-${pad(+m[1])}-${pad(+m[2])}`;
    // 「12月30日更新」在 1 月看到：是去年
    if (candidate > today.toISOString().slice(0, 10)) year -= 1;
    return `${year}-${pad(+m[1])}-${pad(+m[2])}`;
  }
  if (/今天|小时前|分钟前/.test(text)) return today.toISOString().slice(0, 10);
  if (/昨天/.test(text)) return new Date(today.getTime() - DAY).toISOString().slice(0, 10);
  return undefined;
}

/** 「1.6亿次播放」「9800.7万次播放」「553.4万追番」→ 数字 */
export function parseChineseCount(text: string | undefined): number | undefined {
  const m = text?.match(/([\d.]+)\s*(亿|万)?/);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return Math.round(n * (m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1));
}
