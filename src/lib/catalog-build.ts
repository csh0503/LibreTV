import type { DoubanItem } from './types';
import type { CatalogChannel, WorkRow } from './catalog-db';
import {
  bayesRating,
  popAllScore,
  popRecentScore,
  sortDateOf,
  totalVotes,
  type CatalogRawItem,
  type RawSignals,
} from './catalog-rank';
import { mergeWorkMeta, sourceOfItem } from './catalog-meta';
import { canonicalTitle } from './title-aliases';
import { WorkGroups, episodeCountOf, workKeys } from './work-identity';
import { shelfItemKey } from './shelf-defs';

/**
 * 把各来源的原始条目融合成本地片库的作品（每部一行）：
 * 同一部的判断完全沿用 work-identity（中文名 / 原名 / 季数键 + 编号、年份、集数、动画与否的冲突检查，
 * 别名表和繁简统一走 title-aliases），资料合并沿用 catalog-meta（评分校正、年份投票、题材、地区）。
 * 然后算好四种排序的分数。纯计算，可以在测试里直接跑。
 */

/** 谁的资料当底（片名、封面、更新说明）：豆瓣和 B站的片名最贴近采集站，其次 Bangumi 中文名、TMDB 中文译名 */
const PRIMARY_ORDER: Record<string, number> = { douban: 0, bili: 1, bangumi: 2, tmdb: 3, other: 4 };

const SIGNAL_KEYS: (keyof RawSignals)[] = [
  'doubanVotes', 'bgmCollect', 'bgmVotes', 'biliPlays', 'biliFollow', 'tmdbVotes', 'tmdbPopularity', 'recentAt',
];
/** 名次类：越小越好 */
const RANK_KEYS: (keyof RawSignals)[] = ['doubanHotRank', 'biliRecentRank', 'hotRank'];

/** 名次类线索多久内算「近期」（和 catalog-rank 的 RECENT_TTL 一致） */
const RANK_TTL = 3 * 86_400_000;

/**
 * 合并一部作品各成员的线索：数值类取最大、名次类取最好、首播取最早、最新一集取最晚。
 * 名次类（近期热门 / 最近更新 / 热榜）只认 3 天内抓到的那个成员——旧的名次不能借别的成员新的抓取时间冒充「近期」。
 */
export function mergeSignals(list: RawSignals[], now = Date.now()): RawSignals {
  const out: RawSignals = {};
  for (const s of list) {
    const freshRanks = s.recentAt !== undefined && now - s.recentAt <= RANK_TTL;
    for (const k of SIGNAL_KEYS) {
      const v = s[k] as number | undefined;
      if (v !== undefined && (out[k] === undefined || v > (out[k] as number))) (out as Record<string, unknown>)[k] = v;
    }
    for (const k of RANK_KEYS) {
      if (!freshRanks) continue;
      const v = s[k] as number | undefined;
      if (v !== undefined && (out[k] === undefined || v < (out[k] as number))) (out as Record<string, unknown>)[k] = v;
    }
    // 首播取最早、最新一集取最晚
    if (s.firstDate && (!out.firstDate || s.firstDate < out.firstDate)) out.firstDate = s.firstDate;
    if (s.lastDate && (!out.lastDate || s.lastDate > out.lastDate)) out.lastDate = s.lastDate;
  }
  return out;
}

/** 状态：有依据的优先于按年份猜的；都有依据时「完结」优先（B站 / Bangumi 的完结盖过豆瓣滞后的「更新至N集」） */
function mergeStatus(members: DoubanItem[]): { status?: 'airing' | 'ended'; guessed: boolean; remarks?: string } {
  const firm = members.filter((m) => m.status && !m.statusGuessed);
  const pool = firm.length > 0 ? firm : members.filter((m) => m.status);
  const status = pool.some((m) => m.status === 'ended') ? 'ended' : pool.find((m) => m.status)?.status;
  const remarks =
    (status === 'ended' ? members.find((m) => m.status === 'ended' && m.remarks)?.remarks : undefined) ??
    // 集数最多的更新说明（各站进度不一样）
    [...members].filter((m) => m.remarks).sort((a, b) => (episodeCountOf(b.remarks) ?? 0) - (episodeCountOf(a.remarks) ?? 0))[0]?.remarks;
  return { status, guessed: firm.length === 0 && Boolean(status), remarks };
}

function workIdOf(item: DoubanItem): string {
  return /^\d+$/.test(item.id) ? `db_${item.id}` : item.id;
}

function idsOf(members: DoubanItem[]): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const m of members) {
    const src = sourceOfItem(m);
    if (src !== 'other' && !ids[src]) ids[src] = m.id;
  }
  return ids;
}

const yieldLoop = () => new Promise<void>((r) => setImmediate(r));

/**
 * 一个频道的原始条目 → 作品行。分批让出事件循环（伺服器只有 2 核，融合时网站照样要能响应）。
 */
export async function buildChannelWorks(
  channel: CatalogChannel,
  raws: CatalogRawItem[],
  now = Date.now(),
): Promise<WorkRow[]> {
  const today = new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
  const nowYear = Number(today.slice(0, 4));
  const sorted = [...raws].sort(
    (a, b) => (PRIMARY_ORDER[sourceOfItem(a)] ?? 9) - (PRIMARY_ORDER[sourceOfItem(b)] ?? 9),
  );
  const works = new WorkGroups<{ members: CatalogRawItem[] }>({ nowYear });
  for (let i = 0; i < sorted.length; i++) {
    const raw = sorted[i];
    const key = canonicalTitle(raw.title);
    if (!key || !raw.cover) continue;
    const keys = workKeys(key, raw);
    const slot = works.find(keys, raw);
    if (slot) slot.members.push(raw);
    else works.add(keys, raw, { members: [raw] });
    if (i % 400 === 399) await yieldLoop();
  }

  const rows: WorkRow[] = [];
  const usedIds = new Set<string>();
  let n = 0;
  for (const { members } of works.order) {
    if (++n % 400 === 0) await yieldLoop();
    const primary = members[0];
    const meta = mergeWorkMeta({ ...primary, cover: primary.cover || members.find((m) => m.cover)?.cover || '' }, members);
    const sig = mergeSignals(members.map((m) => m.sig ?? {}), now);
    const year = meta.year && /^\d{4}$/.test(meta.year) ? Number(meta.year) : undefined;
    // 还没播出的不进片库（「即将播出」那一行管它们）
    if (sig.firstDate && sig.firstDate > today) continue;
    if (!sig.firstDate && year && year > nowYear) continue;
    const { status, guessed, remarks } = mergeStatus(members);
    const rating = meta.rating ? parseFloat(meta.rating) : undefined;
    const votes = totalVotes(sig);
    const dates = { firstDate: sig.firstDate, lastDate: sig.lastDate, year };
    const popAll = popAllScore(sig);
    // 主键带上频道（TMDB 电影 / 剧集编号会撞，同一个编号也可能分在两个频道）
    let id = `${channel}:${workIdOf(primary)}`;
    // 同一个来源编号被拆成两部（极少见）：后面那部加后缀，主键不撞
    while (usedIds.has(id)) id = `${id}~`;
    usedIds.add(id);
    rows.push({
      id,
      channel,
      title: meta.title,
      title_key: canonicalTitle(meta.title),
      series_key: shelfItemKey(meta) || canonicalTitle(meta.title),
      original_title: members.find((m) => m.originalTitle)?.originalTitle ?? null,
      is_tv: meta.isTv ? 1 : 0,
      year: year ?? null,
      first_date: sig.firstDate ?? null,
      last_date: sig.lastDate ?? null,
      area: meta.area ?? null,
      genres: meta.genres ?? null,
      cover: meta.cover,
      backdrop: members.find((m) => m.backdrop)?.backdrop ?? null,
      status: status ?? null,
      status_guessed: guessed ? 1 : 0,
      remarks: remarks ?? null,
      rating: rating !== undefined && Number.isFinite(rating) ? rating : null,
      ratings_json: meta.ratings ? JSON.stringify(meta.ratings) : null,
      votes,
      pop_all: round4(popAll),
      pop_recent: round4(popRecentScore(sig, dates, popAll, now)),
      sort_rate: round4(bayesRating(rating, votes)),
      sort_date: sortDateOf(dates, today),
      ids_json: JSON.stringify(idsOf(members)),
      signals_json: JSON.stringify(sig),
      updated_at: now,
    });
  }
  poolSeriesPopularity(rows);
  return rows;
}

/**
 * 长篇系列的人气按整个系列算：《银魂》在豆瓣分成第一 / 二 / 三季三个条目（14.6 万 + 6 万 + 3 万人评），
 * 单看哪一季都比不过一季完结的新番。同一系列（series_key，季数写法已统一）的累计线索相加
 * （豆瓣人数、Bangumi 收藏、B站播放相加，TMDB 一部剧本来就只有一个条目，取最大），
 * 每一季的总热门 = 系列分 × 0.8 + 自己 × 0.2：系列整体排得上去，系列里仍按各季自己的人气排，
 * 片库前端同一系列只留排在最前的那一季。
 */
export function poolSeriesPopularity(rows: WorkRow[]): void {
  const groups = new Map<string, WorkRow[]>();
  for (const row of rows) {
    if (row.series_key.length < 2) continue;
    const list = groups.get(row.series_key);
    if (list) list.push(row);
    else groups.set(row.series_key, [row]);
  }
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const agg: RawSignals = {};
    for (const row of list) {
      const sig = JSON.parse(row.signals_json) as RawSignals;
      agg.doubanVotes = (agg.doubanVotes ?? 0) + (sig.doubanVotes ?? 0) || undefined;
      agg.bgmCollect = (agg.bgmCollect ?? 0) + (sig.bgmCollect ?? 0) || undefined;
      agg.biliPlays = (agg.biliPlays ?? 0) + (sig.biliPlays ?? 0) || undefined;
      if (sig.tmdbVotes && sig.tmdbVotes > (agg.tmdbVotes ?? 0)) agg.tmdbVotes = sig.tmdbVotes;
    }
    const series = popAllScore(agg);
    for (const row of list) row.pop_all = round4(Math.max(row.pop_all, series * 0.8 + row.pop_all * 0.2));
  }
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** 作品行 → 前端卡片用的条目（和以前 /api/douban 返回的一样，卡片、详情弹窗都不用改） */
export function workRowToItem(row: WorkRow, availability?: { sources: number; remarks?: string }): DoubanItem & {
  available?: number;
  workId: string;
} {
  let ratings: DoubanItem['ratings'];
  try {
    ratings = row.ratings_json ? (JSON.parse(row.ratings_json) as DoubanItem['ratings']) : undefined;
  } catch {
    ratings = undefined;
  }
  const ids = safeJson<Record<string, string>>(row.ids_json) ?? {};
  // 详情弹窗认作品时用 tmdb_ / bgm_ 编号更准：有就给它
  const id = ids.tmdb ?? ids.bangumi ?? (ids.douban ? ids.douban : row.id);
  return {
    id,
    workId: row.id,
    title: row.title,
    cover: row.cover,
    backdrop: row.backdrop ?? undefined,
    rating: row.rating ? row.rating.toFixed(1) : undefined,
    ratings,
    isTv: row.is_tv === 1,
    year: row.year ? String(row.year) : undefined,
    lastAired: row.last_date ?? undefined,
    originalTitle: row.original_title ?? undefined,
    area: row.area ?? undefined,
    genres: row.genres ?? undefined,
    status: (row.status as DoubanItem['status']) ?? undefined,
    statusGuessed: row.status_guessed ? true : undefined,
    remarks: row.remarks ?? availability?.remarks ?? undefined,
    ...(availability ? { available: availability.sources } : {}),
  };
}

function safeJson<T>(text: string | null | undefined): T | undefined {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
