import type { DoubanItem } from './types';
import { isAdultContent } from './cms-parser';
import { canonicalTitle, sameSeasonKey } from './title-aliases';
import { workKeyOf } from './history-work';
import { type HallChannel, type HallSelection } from './recommend';

/**
 * 每个设定档自己的推荐。不把家里其他人的记录混进来，也不跑 Python 模型。
 * 置信度来自 Hu, Koren, Volinsky 2008（benfred/implicit 用的隐式反馈）：
 * 看完、收藏权重大，刚打开的很轻，隔天仍停在开头算弃剧。
 * 题材、地区、年代做成 TF-IDF 再算余弦，这是 CineMatch 的内容部分。
 * 用户向量是这些特征的加权和，对应 LightFM 在没有别人评分时的冷启动。
 * 同一行用 MMR（Carbonell & Goldstein, SIGIR 1998）岔开题材。
 * 召回仍用豆瓣原来的标签请求。副标题里的「动作」不会被当成「热血」。
 */

export type TasteChannel = Exclude<HallChannel, 'adult'>;

const CHANNELS: TasteChannel[] = ['anime', 'movie', 'tv', 'show', 'doc'];
const DECAY_DAYS = 45;
const MIN_FEATURED = 2;
const FEATURED_WEIGHT = 0.5;
const MMR_LAMBDA = 0.72;
const FOR_YOU_LIMIT = 18;
const BECAUSE_LIMIT = 12;
export const MAX_TASTES = 300;
const SAFE_TAG = /^[\u4e00-\u9fa5A-Za-z0-9]{1,20}$/;

/** 和大厅芯片一致，只用来在没记下频道时判断该去电影还是剧集里召回。 */
const GENRE_HOME: Record<TasteChannel, string[]> = {
  anime: ['热血', '奇幻', '恋爱', '日常', '搞笑', '科幻', '治愈', '机战', '悬疑', '冒险', '战斗', '校园', '催泪'],
  movie: ['喜剧', '爱情', '动作', '科幻', '动画', '悬疑', '犯罪', '惊悚', '冒险', '奇幻', '恐怖', '战争', '武侠', '历史', '灾难', '音乐'],
  tv: ['剧情', '悬疑', '犯罪', '古装', '都市', '爱情', '喜剧', '奇幻', '科幻', '武侠', '战争', '历史', '惊悚', '短剧'],
  show: ['真人秀', '音乐', '脱口秀', '搞笑', '恋爱', '游戏', '访谈', '选秀'],
  doc: ['自然', '历史', '人物', '科技', '社会', '战争', '灾难', '传记'],
};

const AREA_TAG: Record<string, string> = {
  日本: '日本',
  韩国: '韩国',
  美国: '美国',
  英国: '英国',
  法国: '法国',
  德国: '德国',
  泰国: '泰国',
  印度: '印度',
  中国大陆: '中国大陆',
  大陆: '中国大陆',
  内地: '中国大陆',
  中国: '中国大陆',
  香港: '中国香港',
  中国香港: '中国香港',
  台湾: '中国台湾',
  中国台湾: '中国台湾',
  欧美: '欧美',
  华语: '华语',
};

export interface TasteSnapshot {
  title: string;
  updatedAt: number;
  doubanId?: string;
  channel?: TasteChannel;
  genres?: string;
  area?: string;
  year?: string;
  rating?: string;
}

export interface TasteWatch {
  title: string;
  playbackPosition: number;
  duration: number;
  episodeIndex: number;
  totalEpisodes: number;
  timestamp: number;
  genres?: string;
  area?: string;
  year?: string;
  channel?: TasteChannel;
}

export interface TasteSave {
  title: string;
  addedAt: number;
  genres?: string;
  area?: string;
  year?: string;
  channel?: TasteChannel;
}

export interface TasteMeta {
  title: string;
  channel?: TasteChannel;
  genres?: string;
  area?: string;
  year?: string;
}

export interface TasteEvent {
  title: string;
  channel?: TasteChannel;
  genres: string[];
  area?: string;
  year?: string;
  depth: number;
  finished: boolean;
  abandoned: boolean;
  favorite: boolean;
  at: number;
}

export interface TasteJob {
  selection: HallSelection;
  pageStart: number;
  forUser: boolean;
  forAnchor: boolean;
}

export interface AssembledTaste {
  events: TasteEvent[];
  blocked: string[];
  anchorTitle: string | null;
  anchorReason: '看过' | '收藏';
  jobs: TasteJob[];
}

export function asChannel(value: unknown): TasteChannel | undefined {
  return typeof value === 'string' && CHANNELS.includes(value as TasteChannel) ? (value as TasteChannel) : undefined;
}

export function mapArea(area?: string): string | undefined {
  if (!area) return undefined;
  const token = area.split(/[\s/]+/).find(Boolean);
  if (!token) return undefined;
  return AREA_TAG[token] ?? AREA_TAG[area.trim()];
}

export function unionGenres(a?: string, b?: string): string | undefined {
  const out: string[] = [];
  for (const part of `${a ?? ''} ${b ?? ''}`.split(/[\s/]+/)) {
    if (!SAFE_TAG.test(part) || out.includes(part)) continue;
    out.push(part);
    if (out.length >= 8) break;
  }
  return out.length ? out.join(' ') : undefined;
}

export function genresFromCard(picked?: string, subtitle?: string): string | undefined {
  const chip = picked && picked !== '全部' ? picked : undefined;
  return unionGenres(chip, subtitle);
}

function splitGenres(genres?: string): string[] {
  return unionGenres(genres)?.split(' ') ?? [];
}

export function describeWatch(input: {
  playbackPosition: number;
  duration: number;
  episodeIndex: number;
  totalEpisodes: number;
}): { depth: number; finished: boolean; abandoned: boolean } {
  const ratio = input.duration > 0 ? clamp(input.playbackPosition / input.duration, 0, 1) : 0;
  const series = input.totalEpisodes > 1;
  const known = input.duration > 0 || input.episodeIndex > 0;
  const finished = series ? input.episodeIndex >= input.totalEpisodes - 1 && ratio >= 0.85 : ratio >= 0.85;
  const abandoned = known && !finished && (series ? input.episodeIndex === 0 && ratio < 0.25 : ratio < 0.15);
  const depth = series ? clamp((input.episodeIndex + ratio) / Math.min(input.totalEpisodes, 6), 0, 1) : ratio;
  return { depth, finished, abandoned };
}

/** 还没乘时间衰减。看完和收藏是强正反馈，开头就离开是负反馈。 */
export function signalWeight(event: Pick<TasteEvent, 'depth' | 'finished' | 'abandoned' | 'favorite'>): number {
  if (event.favorite && (event.finished || event.depth >= 0.5)) return 5;
  if (event.favorite) return 4;
  if (event.abandoned) return -1.5;
  if (event.finished || event.depth >= 0.85) return 3.5;
  if (event.depth >= 0.3) return 1 + event.depth * 2;
  return 0.35;
}

export function confidenceOf(event: TasteEvent, now: number): number {
  const ageDays = Math.max(0, (now - event.at) / 86_400_000);
  return signalWeight(event) * Math.exp(-ageDays / DECAY_DAYS);
}

export function featureTokens(input: {
  channel?: TasteChannel;
  genres: string[];
  area?: string;
  year?: string;
}): string[] {
  const tokens: string[] = [];
  if (input.channel) tokens.push(`ch:${input.channel}`);
  for (const genre of input.genres) {
    const token = `g:${genre}`;
    if (SAFE_TAG.test(genre) && !tokens.includes(token)) tokens.push(token);
  }
  const area = mapArea(input.area);
  if (area) tokens.push(`a:${area}`);
  const year = parseInt(input.year ?? '', 10);
  if (year >= 1900 && year <= 2100) tokens.push(`d:${year - (year % 10)}`);
  return tokens;
}

export function idfTable(docs: string[][]): Map<string, number> {
  const total = docs.length;
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const token of new Set(doc)) df.set(token, (df.get(token) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const [token, count] of df) out.set(token, Math.log((1 + total) / (1 + count)) + 1);
  return out;
}

export function planKey(selection: HallSelection): string {
  return [selection.channel, selection.genre, selection.area, selection.year, selection.sort, selection.score, selection.status].join('|');
}

/**
 * 召回用的片库条件：按「近期热门」排（以前按「评分最高」，召回来的全是《隐秘的角落》这种历年经典，
 * 多半看过或太旧）；高分的另外再要一页，见 tasteJobs。
 */
function selectionOf(channel: TasteChannel, genre: string, area: string, sort: HallSelection['sort'] = 'hot'): HallSelection {
  return { channel, genre, area, year: '全部', sort, score: 'all', status: 'all' };
}

function inferChannel(genres: string[]): TasteChannel | undefined {
  let best: TasteChannel | undefined;
  let bestN = 0;
  let ties = 0;
  for (const channel of CHANNELS) {
    const count = genres.filter((genre) => GENRE_HOME[channel].includes(genre)).length;
    if (count > bestN) {
      best = channel;
      bestN = count;
      ties = 1;
    } else if (count === bestN && count > 0) {
      ties += 1;
    }
  }
  return ties === 1 ? best : undefined;
}

function addWeight(map: Map<string, number>, key: string, weight: number) {
  map.set(key, (map.get(key) ?? 0) + weight);
}

function rankedKeys(map: Map<string, number>): string[] {
  return [...map.entries()]
    .filter(([, weight]) => weight > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
    .map(([key]) => key);
}

function recallPlans(events: TasteEvent[]): HallSelection[] {
  const channelW = new Map<string, number>();
  const areaW = new Map<string, number>();
  const genreByChannel = new Map<string, Map<string, number>>();
  for (const event of events) {
    const weight = signalWeight(event);
    if (Math.abs(weight) < 0.2) continue;
    const channel = event.channel ?? inferChannel(event.genres);
    if (channel) {
      addWeight(channelW, channel, weight);
      const genres = genreByChannel.get(channel) ?? new Map<string, number>();
      for (const genre of event.genres) {
        if (SAFE_TAG.test(genre)) addWeight(genres, genre, weight);
      }
      genreByChannel.set(channel, genres);
    }
    const area = mapArea(event.area);
    if (area) addWeight(areaW, area, weight);
  }
  const channels = rankedKeys(channelW);
  if (channels.length === 0) return [];
  const primary = channels[0] as TasteChannel;
  const genres = rankedKeys(genreByChannel.get(primary) ?? new Map());
  const areas = rankedKeys(areaW);
  const genreWeight = genreByChannel.get(primary)?.get(genres[0] ?? '') ?? 0;
  const areaWeight = areas[0] ? areaW.get(areas[0]) ?? 0 : 0;
  const area = areas[0] && (genres.length === 0 || areaWeight >= genreWeight * 0.5) ? areas[0] : '全部';
  const plans: HallSelection[] = [];
  const push = (channel: TasteChannel, genre: string, areaName: string) => {
    const selection = selectionOf(channel, genre, areaName);
    if (plans.some((plan) => planKey(plan) === planKey(selection))) return;
    plans.push(selection);
  };
  push(primary, genres[0] ?? '全部', area);
  if (genres[1]) push(primary, genres[1], '全部');
  const second = channels[1];
  if (second && (channelW.get(second) ?? 0) >= (channelW.get(primary) ?? 0) * 0.45) {
    const secondGenres = rankedKeys(genreByChannel.get(second) ?? new Map());
    push(second as TasteChannel, secondGenres[0] ?? '全部', '全部');
  }
  return plans.slice(0, 3);
}

function pickAnchor(events: TasteEvent[], now: number): TasteEvent | null {
  let best: TasteEvent | null = null;
  let bestScore = -Infinity;
  for (const event of events) {
    if (signalWeight(event) <= FEATURED_WEIGHT || event.genres.length === 0) continue;
    const score = confidenceOf(event, now);
    if (score > bestScore) {
      best = event;
      bestScore = score;
    }
  }
  return best;
}

export function tasteJobs(plans: HallSelection[], anchor: HallSelection | null): TasteJob[] {
  const jobs: TasteJob[] = [];
  const find = (selection: HallSelection, pageStart: number) =>
    jobs.find((job) => job.pageStart === pageStart && planKey(job.selection) === planKey(selection));
  plans.forEach((selection, index) => {
    // 主口味：近期热门一页 + 高分一页（新作和口碑都有）；其他口味只要近期热门一页
    const variants = index === 0 ? [selection, { ...selection, sort: 'rate' as const }] : [selection];
    for (const variant of variants) {
      const existing = find(variant, 0);
      if (existing) existing.forUser = true;
      else jobs.push({ selection: variant, pageStart: 0, forUser: true, forAnchor: false });
    }
  });
  if (anchor) {
    const existing = find(anchor, 0);
    if (existing) existing.forAnchor = true;
    else jobs.push({ selection: anchor, pageStart: 0, forUser: false, forAnchor: true });
  }
  return jobs;
}

function blankMeta(): TasteMeta {
  return { title: '' };
}

function metaByTitle(metas: TasteMeta[]): Map<string, TasteMeta> {
  const map = new Map<string, TasteMeta>();
  for (const meta of metas) {
    const key = sameSeasonKey(meta.title);
    if (!key) continue;
    const prev = map.get(key) ?? blankMeta();
    map.set(key, {
      title: prev.title || meta.title,
      channel: prev.channel ?? meta.channel,
      genres: unionGenres(prev.genres, meta.genres),
      area: prev.area ?? meta.area,
      year: prev.year ?? meta.year,
    });
  }
  return map;
}

export function assembleTaste(input: {
  watches: TasteWatch[];
  saves: TasteSave[];
  metas: TasteMeta[];
  now: number;
}): AssembledTaste | null {
  const metas = metaByTitle(input.metas);
  const blocked = new Set<string>();
  const byKey = new Map<string, TasteEvent>();
  const block = (title: string) => {
    const key = sameSeasonKey(title);
    if (key) blocked.add(key);
  };
  for (const watch of input.watches) {
    block(watch.title);
    const key = sameSeasonKey(watch.title);
    if (!key) continue;
    const meta = metas.get(key);
    const described = describeWatch(watch);
    const event: TasteEvent = {
      title: watch.title,
      channel: watch.channel ?? meta?.channel,
      genres: splitGenres(unionGenres(watch.genres, meta?.genres)),
      area: watch.area ?? meta?.area,
      year: watch.year ?? meta?.year,
      ...described,
      favorite: false,
      at: watch.timestamp,
    };
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, event);
      continue;
    }
    byKey.set(key, {
      ...prev,
      ...event,
      title: event.at >= prev.at ? event.title : prev.title,
      at: Math.max(event.at, prev.at),
      channel: event.channel ?? prev.channel,
      genres: splitGenres(unionGenres(prev.genres.join(' '), event.genres.join(' '))),
      area: event.area ?? prev.area,
      year: event.year ?? prev.year,
      depth: Math.max(prev.depth, event.depth),
      finished: prev.finished || event.finished,
      abandoned: prev.abandoned && event.abandoned && Math.max(prev.depth, event.depth) < 0.3,
      favorite: prev.favorite,
    });
  }
  for (const save of input.saves) {
    block(save.title);
    const key = sameSeasonKey(save.title);
    if (!key) continue;
    const prev = byKey.get(key);
    if (prev) {
      prev.favorite = true;
      continue;
    }
    const meta = metas.get(key);
    const genres = splitGenres(unionGenres(save.genres, meta?.genres));
    const channel = save.channel ?? meta?.channel;
    if (genres.length === 0 && !channel) continue;
    byKey.set(key, {
      title: save.title,
      channel,
      genres,
      area: save.area ?? meta?.area,
      year: save.year ?? meta?.year,
      depth: 0,
      finished: false,
      abandoned: false,
      favorite: true,
      at: save.addedAt,
    });
  }
  const events = [...byKey.values()];
  const featured = events.filter((event) => signalWeight(event) > FEATURED_WEIGHT && (event.genres.length > 0 || event.channel)).length;
  if (featured < MIN_FEATURED) return null;
  const plans = recallPlans(events);
  if (plans.length === 0) return null;
  const anchor = pickAnchor(events, input.now);
  const anchorChannel = anchor ? anchor.channel ?? inferChannel(anchor.genres) : undefined;
  const anchorPlan = anchor && anchorChannel
    ? selectionOf(anchorChannel, anchor.genres.find((genre) => SAFE_TAG.test(genre)) ?? '全部', mapArea(anchor.area) ?? '全部')
    : null;
  const savedOnly = !!anchor && anchor.favorite && !anchor.finished && anchor.depth < 0.3;
  return {
    events,
    blocked: [...blocked],
    anchorTitle: anchor?.title ?? null,
    anchorReason: savedOnly ? '收藏' : '看过',
    jobs: tasteJobs(plans, anchorPlan),
  };
}

function l2(vec: Map<string, number>): Map<string, number> {
  let sum = 0;
  for (const value of vec.values()) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) return new Map();
  const out = new Map<string, number>();
  for (const [key, value] of vec) out.set(key, value / norm);
  return out;
}

function dot(left: Map<string, number>, right: Map<string, number>): number {
  let sum = 0;
  const [small, big] = left.size <= right.size ? [left, right] : [right, left];
  for (const [key, value] of small) {
    const other = big.get(key);
    if (other) sum += value * other;
  }
  return sum;
}

function tfidf(tokens: string[], idf: Map<string, number>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
  const raw = new Map<string, number>();
  for (const [token, count] of counts) raw.set(token, count * (idf.get(token) ?? 0));
  return l2(raw);
}

function userVector(events: TasteEvent[], now: number, idf: Map<string, number>): Map<string, number> {
  const sum = new Map<string, number>();
  for (const event of events) {
    const weight = confidenceOf(event, now);
    if (weight === 0) continue;
    for (const [token, value] of tfidf(featureTokens(event), idf)) {
      sum.set(token, (sum.get(token) ?? 0) + weight * value);
    }
  }
  return l2(sum);
}

function ratingNum(rating?: string): number {
  const value = parseFloat(rating ?? '');
  return Number.isFinite(value) ? value : 0;
}

function ratingPrior(rating?: string): number {
  const value = ratingNum(rating);
  return Math.log1p(value > 0 ? Math.min(10, value) : 5) / Math.log1p(10);
}

function dedupeItems(items: DoubanItem[]): DoubanItem[] {
  const map = new Map<string, DoubanItem>();
  for (const item of items) {
    const key = sameSeasonKey(item.title) || item.id;
    if (!key) continue;
    const prev = map.get(key);
    if (!prev || ratingNum(item.rating) > ratingNum(prev.rating)) map.set(key, item);
  }
  return [...map.values()];
}

/** 只碰到负反馈题材、没有正反馈题材的候选去掉。召回池里的新题材仍保留。 */
function genreOk(user: Map<string, number>, tokens: string[]): boolean {
  let negative = false;
  let positive = false;
  for (const token of tokens) {
    if (!token.startsWith('g:')) continue;
    const weight = user.get(token) ?? 0;
    if (weight < -0.02) negative = true;
    if (weight > 0.02) positive = true;
  }
  return !(negative && !positive);
}

interface ScoredItem {
  item: DoubanItem;
  score: number;
  vec: Map<string, number>;
}

function scorePool(
  items: DoubanItem[],
  toward: Map<string, number>,
  user: Map<string, number>,
  idf: Map<string, number>,
  blocked: Set<string>,
  hideAdult: boolean,
  channelOf?: (item: DoubanItem) => TasteChannel | undefined,
): ScoredItem[] {
  const scored: ScoredItem[] = [];
  for (const item of dedupeItems(items)) {
    if (hideAdult && (isAdultContent(item.title) || isAdultContent(item.genres) || isAdultContent(item.remarks))) continue;
    const key = sameSeasonKey(item.title);
    if (!key || blocked.has(key) || blocked.has(workKeyOf(item.title))) continue;
    const tokens = featureTokens({
      channel: channelOf?.(item),
      genres: splitGenres(item.genres),
      area: item.area,
      year: item.year,
    });
    if (!genreOk(user, tokens)) continue;
    const vec = tfidf(tokens, idf);
    const cosine = dot(toward, vec);
    scored.push({ item, vec, score: Math.max(cosine, 0.05) * ratingPrior(item.rating) });
  }
  return scored;
}

export function mmrPick<T>(rows: { score: number; vec: Map<string, number>; value: T }[], limit: number): T[] {
  const pool = [...rows];
  const selected: { score: number; vec: Map<string, number>; value: T }[] = [];
  while (selected.length < limit && pool.length > 0) {
    let bestAt = 0;
    let best = -Infinity;
    for (let index = 0; index < pool.length; index += 1) {
      const similarity = selected.length === 0
        ? 0
        : Math.max(...selected.map((row) => dot(pool[index].vec, row.vec)));
      const value = MMR_LAMBDA * pool[index].score - (1 - MMR_LAMBDA) * Math.max(0, similarity);
      if (value > best) {
        best = value;
        bestAt = index;
      }
    }
    selected.push(pool.splice(bestAt, 1)[0]);
  }
  return selected.map((row) => row.value);
}

export function rankTaste(input: {
  events: TasteEvent[];
  userPool: DoubanItem[];
  anchorPool: DoubanItem[];
  anchorTitle: string | null;
  blocked: string[];
  now: number;
  hideAdult: boolean;
  channelOf?: (item: DoubanItem) => TasteChannel | undefined;
}): { forYou: DoubanItem[]; because: DoubanItem[] } {
  const blocked = new Set(input.blocked.map((title) => sameSeasonKey(title)).filter(Boolean));
  const userItems = dedupeItems(input.userPool);
  const anchorItems = dedupeItems(input.anchorPool);
  const docs = [
    ...input.events.map((event) => featureTokens(event)),
    ...userItems.map((item) => featureTokens({ genres: splitGenres(item.genres), area: item.area, year: item.year, channel: input.channelOf?.(item) })),
    ...anchorItems.map((item) => featureTokens({ genres: splitGenres(item.genres), area: item.area, year: item.year, channel: input.channelOf?.(item) })),
  ];
  const idf = idfTable(docs);
  const user = userVector(input.events, input.now, idf);
  const forYou = mmrPick(
    scorePool(userItems, user, user, idf, blocked, input.hideAdult, input.channelOf).map((row) => ({ ...row, value: row.item })),
    FOR_YOU_LIMIT,
  );
  const anchor = input.events.find((event) => input.anchorTitle && sameSeasonKey(event.title) === sameSeasonKey(input.anchorTitle));
  const taken = new Set(forYou.map((item) => sameSeasonKey(item.title)));
  const becauseBlocked = new Set([...blocked, ...taken]);
  const because = anchor
    ? mmrPick(
      scorePool(anchorItems, tfidf(featureTokens(anchor), idf), user, idf, becauseBlocked, input.hideAdult, input.channelOf)
        .map((row) => ({ ...row, value: row.item })),
      BECAUSE_LIMIT,
    )
    : [];
  return { forYou, because };
}

export function mergeTastePair(newer: TasteSnapshot, older: TasteSnapshot): TasteSnapshot {
  return {
    title: newer.title || older.title,
    updatedAt: Math.max(newer.updatedAt, older.updatedAt),
    doubanId: newer.doubanId || older.doubanId,
    channel: newer.channel ?? older.channel,
    genres: unionGenres(newer.genres, older.genres),
    area: newer.area || older.area,
    year: newer.year || older.year,
    rating: newer.rating || older.rating,
  };
}

export function snapshotFromStored(row: {
  title?: string;
  timestamp?: number;
  addedAt?: number;
  tasteGenres?: string;
  tasteArea?: string;
  tasteYear?: string;
  tasteChannel?: string;
  tasteRating?: string;
  tasteDoubanId?: string;
}): TasteSnapshot | null {
  const title = row.title?.trim();
  if (!title) return null;
  const channel = asChannel(row.tasteChannel);
  const genres = unionGenres(row.tasteGenres);
  if (!genres && !channel && !row.tasteArea && !row.tasteYear) return null;
  return {
    title,
    updatedAt: row.timestamp || row.addedAt || 0,
    doubanId: row.tasteDoubanId,
    channel,
    genres,
    area: row.tasteArea?.trim() || undefined,
    year: row.tasteYear,
    rating: row.tasteRating,
  };
}

export function readTasteSnapshot(raw: unknown): TasteSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.title !== 'string' || typeof row.updatedAt !== 'number') return null;
  const [snapshot] = unionTasteSnapshots([{
    title: row.title,
    updatedAt: row.updatedAt,
    doubanId: typeof row.doubanId === 'string' ? row.doubanId : undefined,
    channel: asChannel(row.channel),
    genres: typeof row.genres === 'string' ? row.genres : undefined,
    area: typeof row.area === 'string' ? row.area : undefined,
    year: typeof row.year === 'string' ? row.year : undefined,
    rating: typeof row.rating === 'string' ? row.rating : undefined,
  }]);
  return snapshot ?? null;
}

export function unionTasteSnapshots(...groups: TasteSnapshot[][]): TasteSnapshot[] {
  const map = new Map<string, TasteSnapshot>();
  for (const group of groups) {
    for (const row of group) {
      const title = row.title?.trim();
      if (!title || !Number.isFinite(row.updatedAt)) continue;
      const key = canonicalTitle(title);
      if (!key) continue;
      const clean: TasteSnapshot = {
        title,
        updatedAt: row.updatedAt,
        doubanId: row.doubanId?.trim() || undefined,
        channel: asChannel(row.channel),
        genres: unionGenres(row.genres),
        area: row.area?.trim() || undefined,
        year: /^\d{4}$/.test(row.year ?? '') ? row.year : undefined,
        rating: row.rating?.trim() || undefined,
      };
      const prev = map.get(key);
      if (!prev) {
        map.set(key, clean);
        continue;
      }
      const newer = clean.updatedAt >= prev.updatedAt ? clean : prev;
      const older = newer === clean ? prev : clean;
      map.set(key, mergeTastePair(newer, older));
    }
  }
  return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_TASTES);
}

export function tasteColumns(row?: {
  genres?: string;
  area?: string;
  year?: string;
  channel?: TasteChannel;
  rating?: string;
  doubanId?: string;
}): {
  tasteGenres?: string;
  tasteArea?: string;
  tasteYear?: string;
  tasteChannel?: TasteChannel;
  tasteRating?: string;
  tasteDoubanId?: string;
} {
  if (!row) return {};
  const genres = unionGenres(row.genres);
  return {
    ...(genres ? { tasteGenres: genres } : {}),
    ...(row.area ? { tasteArea: row.area } : {}),
    ...(row.year ? { tasteYear: row.year } : {}),
    ...(row.channel ? { tasteChannel: row.channel } : {}),
    ...(row.rating ? { tasteRating: row.rating } : {}),
    ...(row.doubanId ? { tasteDoubanId: row.doubanId } : {}),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 几部你喜欢的作品的「看过的人也喜欢」合成一份：每份第 r 名（0 起）贡献 权重 / (r + 3)，
 * 被几部同时推荐、名次靠前的排前面（协同过滤的投票）。
 * blocked：看过、收藏过、不再推荐的。没看过的续作照推（看了第 2 季推第 3 季很合理），但同一系列只留 perSeries 部。
 */
export function mergeSimilar(
  lists: { weight: number; items: DoubanItem[] }[],
  opts: { blocked: Set<string>; seriesKeyOf: (item: DoubanItem) => string; perSeries?: number; hideAdult: boolean; limit: number },
): DoubanItem[] {
  const score = new Map<string, { item: DoubanItem; score: number }>();
  for (const { weight, items } of lists) {
    if (!(weight > 0)) continue;
    items.forEach((item, rank) => {
      const key = sameSeasonKey(item.title);
      // 看过的那几季不再推荐；没看过的续作（看了第 2 季推第 3 季）照常推荐。
      // 不再推荐是整部系列（workKeyOf），看过只挡住这一季。
      if (!key || opts.blocked.has(key) || opts.blocked.has(workKeyOf(item.title))) return;
      if (opts.hideAdult && (isAdultContent(item.title) || isAdultContent(item.genres))) return;
      const prev = score.get(key);
      const add = weight / (rank + 3);
      if (prev) prev.score += add;
      else score.set(key, { item, score: add });
    });
  }
  // 同一系列最多留 perSeries 部，免得一排都是同一部的各季
  const perSeries = opts.perSeries ?? 1;
  const seen = new Map<string, number>();
  const out: DoubanItem[] = [];
  for (const { item } of [...score.values()].sort(
    (a, b) => b.score - a.score || ratingNum(b.item.rating) - ratingNum(a.item.rating),
  )) {
    const series = opts.seriesKeyOf(item);
    const count = seen.get(series) ?? 0;
    if (count >= perSeries) continue;
    seen.set(series, count + 1);
    out.push(item);
    if (out.length >= opts.limit) break;
  }
  return out;
}
