import type { HistoryEntry } from './db';
import type { HallSelection } from './recommend';
import {
  asChannel,
  confidenceOf,
  describeWatch,
  mapArea,
  signalWeight,
  unionGenres,
  type TasteChannel,
  type TasteEvent,
  type TasteMeta,
  type TasteSave,
  type TasteWatch,
} from './taste';
import { canonicalTitle } from './title-aliases';
import type { VideoInfo } from './types';

/** 连续自动播放多少集后询问「还在看吗？」 */
export const STILL_WATCHING_THRESHOLD = 3;

/** 播完时下一集大卡的倒计时秒数 */
export const NEXT_EPISODE_COUNTDOWN_SECONDS = 5;

export interface ContinueWatchingView {
  /** 海报底部进度条百分比（0~100） */
  percent: number;
  /** 是否显示进度条 */
  showProgress: boolean;
  /** 海报底部左角胶囊文案，如「第 3 集 · 14:20」 */
  posterLabel: string;
  /** 卡片下方副标题，如「看到第 3/12 集」或「更至 14 集 · 看到第 12 集」 */
  subLabel: string;
  /** 连载片集数变多时为 true，显示「更新了」角标 */
  hasUpdate: boolean;
  /** 更新角标文案 */
  updateBadge?: string;
  /** 点击卡片时应跳转的集数下标（0 基） */
  targetEpisodeIndex: number;
  /** 点击卡片时应恢复的秒数（0 表示从头） */
  targetPosition: number;
}

/** 判断远程最新总集数是否比历史记录中的集数更多（追更提醒） */
export function hasNewEpisodes(savedTotalEpisodes: number, remoteTotalEpisodes?: number): boolean {
  if (!Number.isFinite(savedTotalEpisodes) || savedTotalEpisodes <= 0) return false;
  if (typeof remoteTotalEpisodes !== 'number' || !Number.isFinite(remoteTotalEpisodes)) return false;
  return remoteTotalEpisodes > savedTotalEpisodes;
}

/** 计算「继续观看」单张卡片的进度条、角标文案与点击跳转目标 */
export function describeContinueWatching(
  item: Pick<
    HistoryEntry,
    'episodeIndex' | 'totalEpisodes' | 'playbackPosition' | 'duration'
  >,
  remoteTotalEpisodes?: number,
  formatSec: (sec: number) => string = defaultFormatSec,
): ContinueWatchingView {
  const savedTotal = Math.max(0, item.totalEpisodes || 0);
  const effectiveTotal =
    typeof remoteTotalEpisodes === 'number' && remoteTotalEpisodes > savedTotal
      ? remoteTotalEpisodes
      : savedTotal;
  const hasUpdate = hasNewEpisodes(savedTotal, remoteTotalEpisodes);
  const pos = Math.max(0, item.playbackPosition || 0);
  const dur = Math.max(0, item.duration || 0);
  const epNum = Math.max(0, item.episodeIndex || 0) + 1;

  // 单集内是否视为已看完（>= 92%）
  const episodeFinished = dur > 0 && pos >= dur * 0.92;
  // 这一集已经看完、后面还有：点击直接进下一集（Netflix 也是这样）；
  // 此前已追平最后一集、现在更新了新集的，进的就是新出的那一集
  const jumpToNext = episodeFinished && item.episodeIndex + 1 < effectiveTotal;
  const targetEpisodeIndex = jumpToNext ? item.episodeIndex + 1 : Math.max(0, item.episodeIndex || 0);
  const targetPosition =
    jumpToNext || episodeFinished || pos <= 5 ? 0 : Math.floor(pos);

  let percent = 0;
  if (dur > 0 && pos > 5) {
    percent = Math.min(100, Math.max(4, Math.round((pos / dur) * 100)));
  } else if (effectiveTotal > 1 && item.episodeIndex > 0) {
    percent = Math.min(95, Math.max(6, Math.round(((item.episodeIndex + 0.2) / effectiveTotal) * 100)));
  }

  const showProgress = percent > 0;
  const timePart = pos > 5 && !episodeFinished ? formatSec(pos) : episodeFinished ? '已看完本集' : '';

  let posterLabel = '';
  if (jumpToNext) {
    posterLabel = `第 ${targetEpisodeIndex + 1} 集`;
  } else if (effectiveTotal > 1) {
    posterLabel = timePart ? `第 ${epNum} 集 · ${timePart}` : `第 ${epNum} 集`;
  } else {
    posterLabel = timePart || '继续播放';
  }

  let subLabel = '';
  if (hasUpdate && effectiveTotal > 1) {
    subLabel = jumpToNext
      ? `更至 ${effectiveTotal} 集 · 接着看第 ${targetEpisodeIndex + 1} 集`
      : `更至 ${effectiveTotal} 集 · 看到第 ${epNum} 集`;
  } else if (jumpToNext) {
    subLabel = `接着看第 ${targetEpisodeIndex + 1}/${effectiveTotal} 集`;
  } else if (effectiveTotal > 1) {
    subLabel = `看到第 ${epNum}/${effectiveTotal} 集`;
  } else if (dur > 0 && pos > 5 && !episodeFinished) {
    subLabel = `剩余 ${formatSec(Math.max(0, dur - pos))}`;
  } else {
    subLabel = '上次观看';
  }

  return {
    percent,
    showProgress,
    posterLabel,
    subLabel,
    hasUpdate,
    updateBadge: hasUpdate ? '更新了' : undefined,
    targetEpisodeIndex,
    targetPosition,
  };
}

function defaultFormatSec(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

export type EpisodeEndDecision =
  | { mode: 'none' }
  | { mode: 'manual-next'; nextIndex: number }
  | { mode: 'countdown'; nextIndex: number; seconds: number }
  | { mode: 'still-watching'; nextIndex: number; streak: number };

/**
 * 决策单集播放结束后的界面行为：
 * - 没有下一集：'none'
 * - 未开启自动连播：展示下一集大卡但不倒计时（'manual-next'）
 * - 开启自动连播且连续自动连播达到阈值：暂停并弹出「还在看吗？」（'still-watching'）
 * - 开启自动连播且未达阈值：弹出 Netflix 风格倒计时大卡（'countdown'）
 */
export function decideEpisodeEndAction(input: {
  currentIndex: number;
  totalEpisodes: number;
  autoplayNext: boolean;
  consecutiveAutoPlays: number;
}): EpisodeEndDecision {
  const { currentIndex, totalEpisodes, autoplayNext, consecutiveAutoPlays } = input;
  if (totalEpisodes <= 1 || currentIndex < 0 || currentIndex >= totalEpisodes - 1) {
    return { mode: 'none' };
  }
  const nextIndex = currentIndex + 1;
  if (!autoplayNext) {
    return { mode: 'manual-next', nextIndex };
  }
  if (consecutiveAutoPlays >= STILL_WATCHING_THRESHOLD) {
    return { mode: 'still-watching', nextIndex, streak: consecutiveAutoPlays };
  }
  return {
    mode: 'countdown',
    nextIndex,
    seconds: NEXT_EPISODE_COUNTDOWN_SECONDS,
  };
}

/**
 * 从采集站详情（typeName / area / year）推断豆瓣可识别的频道与题材：
 * 让直接搜索点播的影片也能写入口味档案，触发「因为你看过《某某》」和「为你推荐」。
 */
export function extractTasteFromVideoInfo(info?: Pick<VideoInfo, 'typeName' | 'area' | 'year'>): {
  channel?: TasteChannel;
  genres?: string;
  area?: string;
  year?: string;
} {
  if (!info) return {};
  const rawType = (info.typeName || '').trim();
  let channel: TasteChannel | undefined;
  const detectedGenres: string[] = [];

  if (/动漫|动画|番剧|新番/.test(rawType)) {
    channel = 'anime';
    if (/热血/.test(rawType)) detectedGenres.push('热血');
    if (/奇幻/.test(rawType)) detectedGenres.push('奇幻');
    if (/科幻|机战|机甲/.test(rawType)) detectedGenres.push('科幻');
  } else if (/综艺|真人秀|脱口秀|选秀/.test(rawType)) {
    channel = 'show';
    if (/真人秀/.test(rawType)) detectedGenres.push('真人秀');
    if (/脱口秀/.test(rawType)) detectedGenres.push('脱口秀');
    if (/音乐/.test(rawType)) detectedGenres.push('音乐');
  } else if (/纪录|记录/.test(rawType)) {
    channel = 'doc';
    if (/自然/.test(rawType)) detectedGenres.push('自然');
    if (/历史/.test(rawType)) detectedGenres.push('历史');
    if (/人物|传记/.test(rawType)) detectedGenres.push('人物');
  } else if (/剧|连续剧|短剧/.test(rawType)) {
    channel = 'tv';
    if (/古装|武侠|仙侠/.test(rawType)) detectedGenres.push('古装');
    if (/悬疑|犯罪|刑侦/.test(rawType)) detectedGenres.push('悬疑');
    if (/都市|现代/.test(rawType)) detectedGenres.push('都市');
    if (/爱情|言情/.test(rawType)) detectedGenres.push('爱情');
    if (/喜剧/.test(rawType)) detectedGenres.push('喜剧');
    if (/奇幻/.test(rawType)) detectedGenres.push('奇幻');
    if (/科幻/.test(rawType)) detectedGenres.push('科幻');
    if (/短剧/.test(rawType)) detectedGenres.push('短剧');
  } else if (/片|电影/.test(rawType)) {
    channel = 'movie';
    if (/动作/.test(rawType)) detectedGenres.push('动作');
    if (/喜剧/.test(rawType)) detectedGenres.push('喜剧');
    if (/爱情/.test(rawType)) detectedGenres.push('爱情');
    if (/科幻/.test(rawType)) detectedGenres.push('科幻');
    if (/悬疑/.test(rawType)) detectedGenres.push('悬疑');
    if (/犯罪/.test(rawType)) detectedGenres.push('犯罪');
    if (/惊悚/.test(rawType)) detectedGenres.push('惊悚');
    if (/恐怖/.test(rawType)) detectedGenres.push('恐怖');
    if (/战争/.test(rawType)) detectedGenres.push('战争');
    if (/冒险/.test(rawType)) detectedGenres.push('冒险');
    if (/奇幻/.test(rawType)) detectedGenres.push('奇幻');
    if (/动画/.test(rawType)) detectedGenres.push('动画');
  }

  let area = mapArea(info.area);
  if (!area && rawType) {
    if (/国产|大陆|内地|国漫/.test(rawType)) area = '中国大陆';
    else if (/港|香港/.test(rawType)) area = '中国香港';
    else if (/台|台湾/.test(rawType)) area = '中国台湾';
    else if (/日漫|日本|日剧/.test(rawType)) area = '日本';
    else if (/韩剧|韩国/.test(rawType)) area = '韩国';
    else if (/美剧|欧美|美国/.test(rawType)) area = '美国';
    else if (/泰剧|泰国/.test(rawType)) area = '泰国';
  }

  const year = info.year && /^\d{4}$/.test(info.year.trim()) ? info.year.trim() : undefined;
  return {
    channel,
    genres: unionGenres(detectedGenres.join(' ')),
    area,
    year,
  };
}

/**
 * 当用户只看过/收藏了 1 部有题材的片子（尚未达到 assembleTaste 的 2 部阈值）时，
 * 单独构造「因为你看过/收藏《某某》」的召回条件，让首页第一部片子后就能出推荐排。
 */
export function buildSingleAnchorFallback(input: {
  watches: TasteWatch[];
  saves: TasteSave[];
  metas: TasteMeta[];
  now: number;
}): {
  anchorTitle: string;
  anchorReason: '看过' | '收藏';
  selection: HallSelection;
  blocked: string[];
  event: TasteEvent;
} | null {
  const metaMap = new Map<string, TasteMeta>();
  for (const m of input.metas) {
    const k = canonicalTitle(m.title);
    if (!k) continue;
    const prev = metaMap.get(k);
    metaMap.set(k, {
      title: prev?.title || m.title,
      channel: prev?.channel ?? m.channel,
      genres: unionGenres(prev?.genres, m.genres),
      area: prev?.area ?? m.area,
      year: prev?.year ?? m.year,
    });
  }

  const blocked = new Set<string>();
  const candidates: { event: TasteEvent; reason: '看过' | '收藏' }[] = [];

  for (const w of input.watches) {
    const k = canonicalTitle(w.title);
    if (!k) continue;
    blocked.add(k);
    const m = metaMap.get(k);
    const channel = asChannel(w.channel ?? m?.channel);
    const genreStr = unionGenres(w.genres, m?.genres);
    const genres = genreStr ? genreStr.split(' ') : [];
    if (!channel && genres.length === 0) continue;
    const desc = describeWatch(w);
    if (desc.abandoned) continue;
    const event: TasteEvent = {
      title: w.title,
      channel: channel ?? 'tv',
      genres,
      area: w.area ?? m?.area,
      year: w.year ?? m?.year,
      ...desc,
      favorite: false,
      at: w.timestamp,
    };
    candidates.push({ event, reason: '看过' });
  }

  for (const s of input.saves) {
    const k = canonicalTitle(s.title);
    if (!k) continue;
    blocked.add(k);
    const m = metaMap.get(k);
    const channel = asChannel(s.channel ?? m?.channel);
    const genreStr = unionGenres(s.genres, m?.genres);
    const genres = genreStr ? genreStr.split(' ') : [];
    if (!channel && genres.length === 0) continue;
    const event: TasteEvent = {
      title: s.title,
      channel: channel ?? 'tv',
      genres,
      area: s.area ?? m?.area,
      year: s.year ?? m?.year,
      depth: 0,
      finished: false,
      abandoned: false,
      favorite: true,
      at: s.addedAt,
    };
    candidates.push({ event, reason: '收藏' });
  }

  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) =>
      confidenceOf(b.event, input.now) - confidenceOf(a.event, input.now) ||
      signalWeight(b.event) - signalWeight(a.event),
  );
  const best = candidates[0];
  const ch = best.event.channel ?? 'tv';
  const primaryGenre = best.event.genres[0] ?? '全部';
  const area = mapArea(best.event.area) ?? '全部';

  return {
    anchorTitle: best.event.title,
    anchorReason: best.reason,
    selection: {
      channel: ch,
      genre: primaryGenre,
      area,
      year: '全部',
      sort: 'rate',
      score: 'all',
      status: 'all',
    },
    blocked: [...blocked],
    event: best.event,
  };
}
