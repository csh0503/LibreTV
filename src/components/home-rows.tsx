'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api } from '@/lib/client-api';
import { isAdultContent } from '@/lib/cms-parser';
import {
  db,
  favoriteIdOf,
  removeHistory,
  toggleFavorite,
  upsertHistory,
  type FavoriteEntry,
  type HistoryEntry,
} from '@/lib/db';
import { describeContinueWatching } from '@/lib/home-features';
import type { HotListId } from '@/lib/douban-weekly';
import type { UpcomingItem, UpcomingKind } from '@/lib/upcoming';
import { resolveSource, useAppStore } from '@/lib/store';
import { rememberDoubanItem } from '@/lib/taste-store';
import { canonicalTitle } from '@/lib/title-aliases';
import type { DoubanItem, SearchResultItem, TitlePick } from '@/lib/types';
import { useProfile } from '@/lib/use-profile';
import { buildWatchUrl, cn, formatTime } from '@/lib/utils';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { useToast } from './toast';
import { DoubanCard } from './video-card';

/**
 * 通用横向滚动货架（Netflix 风格）：
 * 隐藏原生滚动条，桌面端提供左右翻页按钮，移动端支持顺滑触控横滑。
 */
export function ShelfRow({
  title,
  hint,
  badge,
  headerExtra,
  children,
  className,
}: {
  title: string;
  hint?: string;
  badge?: string;
  headerExtra?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const updateScrollState = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateScrollState();
    el.addEventListener('scroll', updateScrollState, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateScrollState) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', updateScrollState);
      ro?.disconnect();
    };
  }, [updateScrollState, children]);

  const scrollByPage = (dir: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    const step = Math.max(240, Math.round(el.clientWidth * 0.78));
    el.scrollBy({ left: dir * step, behavior: 'smooth' });
  };

  return (
    <section aria-label={title} className={cn('space-y-2.5', className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0 flex items-center gap-2 flex-wrap shrink-0">
          <h2 className="text-base sm:text-lg font-bold text-content tracking-tight">{title}</h2>
          {badge && (
            <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-accent/15 text-accent">
              {badge}
            </span>
          )}
          {hint && <span className="text-xs text-faint hidden sm:inline">{hint}</span>}
        </div>
        <div className="flex items-center gap-2 min-w-0 flex-1 sm:flex-initial justify-end ml-auto">
          {headerExtra}
          {!headerExtra && (canLeft || canRight) && (
            <div className="hidden sm:flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => scrollByPage(-1)}
                disabled={!canLeft}
                aria-label={`向左滚动${title}`}
                className="w-7 h-7 rounded-full border border-line bg-surface/80 text-muted hover:text-content hover:bg-hover disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center transition-colors cursor-pointer"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                </svg>
              </button>
              <button
                type="button"
                onClick={() => scrollByPage(1)}
                disabled={!canRight}
                aria-label={`向右滚动${title}`}
                className="w-7 h-7 rounded-full border border-line bg-surface/80 text-muted hover:text-content hover:bg-hover disabled:opacity-30 disabled:pointer-events-none flex items-center justify-center transition-colors cursor-pointer"
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          )}
        </div>
      </div>
      {hint && <p className="text-xs text-faint sm:hidden -mt-1">{hint}</p>}
      <div className="relative group/shelf">
        {canLeft && (
          <button
            type="button"
            onClick={() => scrollByPage(-1)}
            aria-label={`向左翻页${title}`}
            className="hidden sm:flex absolute left-1 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-black/70 text-white border border-white/15 shadow-lg items-center justify-center opacity-0 group-hover/shelf:opacity-100 hover:bg-black/90 hover:scale-105 transition-all cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
        )}
        {canRight && (
          <button
            type="button"
            onClick={() => scrollByPage(1)}
            aria-label={`向右翻页${title}`}
            className="hidden sm:flex absolute right-1 top-1/2 -translate-y-1/2 z-20 w-9 h-9 rounded-full bg-black/70 text-white border border-white/15 shadow-lg items-center justify-center opacity-0 group-hover/shelf:opacity-100 hover:bg-black/90 hover:scale-105 transition-all cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        )}
        <div
          ref={scrollerRef}
          className="flex gap-3 overflow-x-auto scrollbar-none pb-1 pt-0.5 scroll-smooth"
        >
          {children}
        </div>
      </div>
    </section>
  );
}

/**
 * 热榜 / 主推数据源：支持全网实时聚合榜、豆瓣直连实时榜、B站 PGC 热播榜、TMDB 趋势与百度热播，
 * 若某上游在特殊网络环境下不可用则自动降级到豆瓣热门接口，保证「首页大图」与「实时榜单」始终有数据。
 */
function useTopRankItems(listId: HotListId, enabled: boolean) {
  const yellowFilter = useAppStore((s) => s.yellowFilter);

  const hotQuery = useQuery({
    queryKey: ['hot-list', listId],
    queryFn: ({ signal }) => api.hotList(listId, signal),
    enabled,
    staleTime: 15 * 60_000,
    // 页面一直开着也跟着服务端每 15 分钟的重算走
    refetchInterval: 15 * 60_000,
    retry: 1,
  });

  const fallbackKind =
    listId === 'douban_movie_weekly' || listId === 'douban_movie_realtime' || listId === 'bili_movie'
      ? 'movie'
      : 'tv';
  const fallbackTags =
    fallbackKind === 'movie'
      ? ['电影']
      : listId === 'bili_guochuang' || listId === 'bili_bangumi' || listId === 'douban_anime_hot'
        ? ['日本动画']
        : listId === 'douban_tv_chinese' || listId === 'douban_tv_domestic'
          ? ['电视剧', '华语']
          : ['电视剧'];

  const fallbackQuery = useQuery({
    queryKey: ['hot-list-fallback', listId],
    queryFn: ({ signal }) =>
      api.douban(
        {
          kind: fallbackKind,
          tags: fallbackTags,
          sort: 'U',
          score: '0,10',
          pageStart: 0,
          pageSize: 12,
        },
        signal,
      ),
    enabled: enabled && hotQuery.isError,
    staleTime: 15 * 60_000,
    retry: 1,
  });

  const items = useMemo(() => {
    const raw = hotQuery.data?.items?.length
      ? hotQuery.data.items
      : (fallbackQuery.data?.items ?? []);
    return raw
      .filter((item) => !yellowFilter || (!isAdultContent(item.title) && !isAdultContent(item.genres)))
      .slice(0, 10);
  }, [hotQuery.data, fallbackQuery.data, yellowFilter]);

  return {
    items,
    isLoading: hotQuery.isLoading || (hotQuery.isError && fallbackQuery.isLoading),
    /** 热榜取不到、退回豆瓣热门时为 undefined */
    meta: hotQuery.data?.items?.length ? hotQuery.data.meta : undefined,
  };
}

/**
 * 首页大图（Netflix 风格顶部主推）：
 * 默认采用全网实时聚合榜（realtime_all）交叉展示热剧、院线大片、B站国创与日番榜首，
 * 优先渲染 16:9 横版海报（backdrop），支持切换前 6 部主推，直接「播放」或「加入片单」。
 */
export function HeroBillboard({ onPick }: { onPick: (title: string, pick?: TitlePick) => void }) {
  const router = useRouter();
  const { toast } = useToast();
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const profileId = useProfile().id;

  const { items, isLoading } = useTopRankItems('realtime_all', doubanEnabled);
  const featuredList = useMemo(() => items.slice(0, 6), [items]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [imgFailed, setImgFailed] = useState(false);
  const [backdropFailed, setBackdropFailed] = useState(false);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (activeIndex >= featuredList.length) setActiveIndex(0);
  }, [activeIndex, featuredList.length]);

  const current: DoubanItem | undefined = featuredList[activeIndex] ?? featuredList[0];
  useEffect(() => {
    setImgFailed(false);
    setBackdropFailed(false);
  }, [current?.cover, current?.backdrop]);

  const goPrev = useCallback(() => {
    if (featuredList.length <= 1) return;
    setActiveIndex((i) => (i - 1 + featuredList.length) % featuredList.length);
  }, [featuredList.length]);

  const goNext = useCallback(() => {
    if (featuredList.length <= 1) return;
    setActiveIndex((i) => (i + 1) % featuredList.length);
  }, [featuredList.length]);

  // 自动轮播：每 8 秒温和切换主推影片
  useEffect(() => {
    if (featuredList.length <= 1) return;
    const timer = window.setInterval(() => {
      setActiveIndex((i) => (i + 1) % featuredList.length);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [featuredList.length]);

  const favLocalId = current ? favoriteIdOf({ title: current.title }) : '';
  const isSaved = useLiveQuery(
    () => (profileId && favLocalId ? db.favorites.get(`${profileId}::${favLocalId}`) : undefined),
    [profileId, favLocalId],
  );

  // 检查用户是否已在观看历史中有这部片子：若有则「立即播放」可直接续播
  const matchedHistory = useLiveQuery(
    async () => {
      if (!profileId || !current) return undefined;
      const key = canonicalTitle(current.title);
      if (!key) return undefined;
      const rows = await db.history.where('profileId').equals(profileId).toArray();
      return rows
        .filter((r) => canonicalTitle(r.title) === key)
        .sort((a, b) => b.timestamp - a.timestamp)[0];
    },
    [profileId, current?.title],
  );

  if (!doubanEnabled) return null;

  if (isLoading && !current) {
    return (
      <div className="mb-7 rounded-2xl border border-line bg-surface/60 h-52 sm:h-64 animate-pulse p-6 flex flex-col justify-end">
        <div className="h-4 w-28 rounded bg-chip mb-3" />
        <div className="h-8 w-56 rounded bg-chip mb-4" />
        <div className="flex gap-3">
          <div className="h-10 w-28 rounded-xl bg-chip" />
          <div className="h-10 w-28 rounded-xl bg-chip" />
        </div>
      </div>
    );
  }

  if (!current) return null;

  const metaTags = [
    current.year,
    current.area,
    current.genres,
    current.remarks,
  ].filter(Boolean);

  const hasWidescreenBackdrop = Boolean(current.backdrop && !backdropFailed);
  const bgUrl = hasWidescreenBackdrop ? current.backdrop : current.cover;

  const handlePlay = () => {
    void rememberDoubanItem(current, current.isTv === false ? 'movie' : 'tv');
    if (matchedHistory) {
      const src = resolveSource({ customAPIs, envSources }, matchedHistory.sourceKey, {
        url: matchedHistory.sourceUrl,
      });
      const view = describeContinueWatching(matchedHistory, undefined, formatTime);
      router.push(
        buildWatchUrl({
          sourceKey: matchedHistory.sourceKey,
          vodId: matchedHistory.vodId,
          index: view.targetEpisodeIndex,
          position: view.targetPosition,
          title: matchedHistory.title,
          sourceUrl: src?.url || matchedHistory.sourceUrl,
          detail: src?.detail,
        }),
      );
      return;
    }
    onPick(current.title, current);
  };

  const handleToggleMyList = () => {
    void rememberDoubanItem(current, current.isTv === false ? 'movie' : 'tv');
    void toggleFavorite({
      localId: favLocalId,
      title: current.title,
      pic: current.cover,
      year: current.year,
    }).then((on) => {
      toast(on ? `已将「${current.title}」加入我的片单` : `已从我的片单移除「${current.title}」`, 'success');
    });
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    const touch = e.changedTouches[0];
    if (!start || !touch) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) > 42 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      if (dx < 0) goNext();
      else goPrev();
    }
  };

  return (
    <section
      aria-label="今日主推影片"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      className="group/hero relative mb-7 rounded-2xl overflow-hidden border border-line bg-[#0b111e] text-white shadow-xl select-none"
    >
      {/* 背景大图氛围层：有 16:9 横版海报时高清展示，仅竖版海报时作高斯模糊氛围背景 */}
      {bgUrl && (!imgFailed || hasWidescreenBackdrop) && (
        <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden>
          <SmartImage
            url={bgUrl}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt=""
            className={cn(
              'w-full h-full object-cover transition-all duration-700',
              hasWidescreenBackdrop ? 'scale-105 blur-[1px] opacity-60' : 'scale-110 blur-2xl opacity-45',
            )}
            onExhausted={() => {
              if (hasWidescreenBackdrop) setBackdropFailed(true);
              else setImgFailed(true);
            }}
          />
        </div>
      )}
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none bg-gradient-to-r from-[#070b14]/95 via-[#0b111e]/80 to-[#0b111e]/35"
      />
      <div
        aria-hidden
        className="absolute inset-0 pointer-events-none bg-gradient-to-t from-[#070b14] via-transparent to-black/25"
      />

      {/* 左右切换箭头（桌面端悬停浮现，移动端亦可点击或直接左右滑动） */}
      {featuredList.length > 1 && (
        <>
          <button
            type="button"
            onClick={goPrev}
            aria-label="上一部主推影片"
            className="absolute left-2 sm:left-3 top-1/2 -translate-y-1/2 z-20 w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-black/50 hover:bg-black/80 text-white/90 hover:text-white border border-white/15 backdrop-blur-sm flex items-center justify-center opacity-70 sm:opacity-0 sm:group-hover/hero:opacity-100 transition-all cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <button
            type="button"
            onClick={goNext}
            aria-label="下一部主推影片"
            className="absolute right-2 sm:right-3 top-1/2 -translate-y-1/2 z-20 w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-black/50 hover:bg-black/80 text-white/90 hover:text-white border border-white/15 backdrop-blur-sm flex items-center justify-center opacity-70 sm:opacity-0 sm:group-hover/hero:opacity-100 transition-all cursor-pointer"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M9 5l7 7-7 7" />
            </svg>
          </button>
        </>
      )}

      <div className="relative z-10 px-6 py-5 sm:px-12 sm:py-7 md:px-14 md:py-8 flex items-center justify-between gap-6">
        <div className="min-w-0 flex-1 max-w-2xl space-y-3">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full bg-red-600/90 text-white font-semibold tracking-wide shadow-sm">
              TOP {activeIndex + 1} · {current.sourceLabel || '实时热推'}
            </span>
            {current.rating && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/15 text-amber-300 font-semibold backdrop-blur-sm">
                ★ {current.rating}
              </span>
            )}
            {metaTags.map((tag, idx) => (
              <span
                key={idx}
                className="px-2 py-0.5 rounded-full bg-white/10 text-slate-200 backdrop-blur-sm"
              >
                {tag}
              </span>
            ))}
          </div>

          <h2 className="text-2xl sm:text-3xl md:text-4xl font-extrabold tracking-tight text-white line-clamp-2 drop-shadow">
            {current.title}
          </h2>

          <p className="text-xs sm:text-sm text-slate-300/90 max-w-xl line-clamp-2">
            {matchedHistory
              ? `上次看到第 ${matchedHistory.episodeIndex + 1} 集${matchedHistory.playbackPosition > 10 ? `（${formatTime(matchedHistory.playbackPosition)}）` : ''}，点击可接着上次进度继续观看。`
              : current.subtitle ||
                '全网实时热度与口碑前列佳作，点击「播放」跨源检索最佳画质，或加入「我的片单」随时回看。'}
          </p>

          <div className="pt-1 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handlePlay}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white text-slate-950 hover:bg-slate-100 active:scale-[0.99] font-semibold text-sm shadow-lg transition-all cursor-pointer"
            >
              <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24" aria-hidden>
                <path d="M8 5v14l11-7z" />
              </svg>
              <span>{matchedHistory ? `继续播放 第${matchedHistory.episodeIndex + 1}集` : '播放'}</span>
            </button>

            <button
              type="button"
              onClick={handleToggleMyList}
              className={cn(
                'inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-medium border backdrop-blur-md transition-all cursor-pointer',
                isSaved
                  ? 'bg-amber-500/20 border-amber-400/50 text-amber-200 hover:bg-amber-500/30'
                  : 'bg-white/10 border-white/20 text-white hover:bg-white/20',
              )}
            >
              <Icon name={isSaved ? 'check' : 'plus'} className="w-4 h-4" />
              <span>{isSaved ? '已在片单' : '加入片单'}</span>
            </button>
          </div>
        </div>

        {/* 右侧高清立面海报（桌面与平板显示） */}
        {current.cover && !imgFailed && (
          <div
            onClick={handlePlay}
            role="button"
            tabIndex={-1}
            className="hidden sm:block relative w-32 md:w-40 aspect-[2/3] rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/20 shrink-0 cursor-pointer group"
          >
            <SmartImage
              url={current.cover}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt={current.title}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
              onExhausted={() => setImgFailed(true)}
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
              <div className="w-11 h-11 rounded-full bg-white/90 text-slate-950 flex items-center justify-center opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100 transition-all shadow-lg">
                <svg className="w-5 h-5 fill-current ml-0.5" viewBox="0 0 24 24">
                  <path d="M8 5v14l11-7z" />
                </svg>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 主推切换指示器 */}
      {featuredList.length > 1 && (
        <div className="relative z-10 px-6 sm:px-12 pb-3.5 flex items-center justify-between sm:justify-end gap-1.5">
          <span className="text-[11px] text-white/45 sm:hidden">左右滑动切换主推</span>
          <div className="flex items-center gap-1.5 ml-auto">
            {featuredList.map((item, idx) => (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveIndex(idx)}
                aria-label={`切换到主推：${item.title}`}
                title={item.title}
                className={cn(
                  'h-1.5 rounded-full transition-all cursor-pointer',
                  idx === activeIndex ? 'w-6 bg-white' : 'w-2 bg-white/35 hover:bg-white/60',
                )}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * 首页「继续观看」+ 追更提醒（连载片集数变多时标「更新了」）：
 * 海报底部绘制播放进度条，点击从上次的集数和秒数接着播。
 */
export function ContinueWatchingRow() {
  const profileId = useProfile().id;
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);

  const history = useLiveQuery(
    () =>
      profileId
        ? db.history
            .where('profileId')
            .equals(profileId)
            .sortBy('timestamp')
            .then((rows) => rows.reverse())
        : [],
    [profileId],
  );

  const visible = useMemo(() => {
    const all = history ?? [];
    return all
      .filter((item) => {
        if (!yellowFilter) return true;
        const src = resolveSource({ customAPIs, envSources }, item.sourceKey, {
          url: item.sourceUrl,
        });
        if (src?.isAdult) return false;
        return !isAdultContent(item.title);
      })
      .slice(0, 16);
  }, [history, yellowFilter, customAPIs, envSources]);

  // 对前 8 部多集剧集静默拉取最新详情，用于判断连载剧是否「更新了」
  const checkTargets = useMemo(
    () =>
      visible.slice(0, 8).map((item) => {
        const source = resolveSource({ customAPIs, envSources }, item.sourceKey, {
          url: item.sourceUrl,
        });
        return { item, source };
      }),
    [visible, customAPIs, envSources],
  );

  const detailQueries = useQueries({
    queries: checkTargets.map(({ item, source }) => ({
      queryKey: ['continue-watching-detail', item.sourceKey, item.vodId, source?.url],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.detail(item.vodId, source!, signal),
      enabled: Boolean(source && item.vodId && item.totalEpisodes > 0),
      staleTime: 15 * 60_000,
      retry: 0,
    })),
  });

  const remoteTotals = useMemo(() => {
    const map = new Map<string, number>();
    checkTargets.forEach(({ item }, idx) => {
      const count = detailQueries[idx]?.data?.episodes?.length;
      if (typeof count === 'number' && count > 0) {
        map.set(`${item.sourceKey}_${item.vodId}`, count);
      }
    });
    return map;
  }, [checkTargets, detailQueries]);

  if (!profileId || visible.length === 0) return null;

  return (
    <ShelfRow title="继续观看" hint="接着上次的集数与秒数播放">
      {visible.map((item) => (
        <ContinueWatchingCard
          key={`${item.sourceKey}_${item.vodId}`}
          item={item}
          remoteTotalEpisodes={remoteTotals.get(`${item.sourceKey}_${item.vodId}`)}
        />
      ))}
    </ShelfRow>
  );
}

function ContinueWatchingCard({
  item,
  remoteTotalEpisodes,
}: {
  item: HistoryEntry;
  remoteTotalEpisodes?: number;
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const { toast } = useToast();
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => setImgFailed(false), [item.pic]);

  const source = resolveSource({ customAPIs, envSources }, item.sourceKey, {
    url: item.sourceUrl,
  });

  const view = useMemo(
    () => describeContinueWatching(item, remoteTotalEpisodes, formatTime),
    [item, remoteTotalEpisodes],
  );

  const href = buildWatchUrl({
    sourceKey: item.sourceKey,
    vodId: item.vodId,
    index: view.targetEpisodeIndex,
    position: view.targetPosition,
    title: item.title,
    sourceUrl: source?.url || item.sourceUrl,
    detail: source?.detail,
  });

  const handleRemove = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    void removeHistory(item.sourceKey, item.vodId).then(() => {
      toast(`已从继续观看移除「${item.title}」`, 'info', {
        action: {
          label: '撤销',
          onClick: () => {
            void upsertHistory({
              sourceKey: item.sourceKey,
              sourceUrl: item.sourceUrl,
              vodId: item.vodId,
              title: item.title,
              pic: item.pic,
              episodeIndex: item.episodeIndex,
              totalEpisodes: item.totalEpisodes,
              playbackPosition: item.playbackPosition,
              duration: item.duration,
              timestamp: item.timestamp,
            });
          },
        },
      });
    });
  };

  return (
    <div className="w-[8.25rem] sm:w-36 shrink-0 group relative">
      <Link
        href={href}
        className="card block hover:scale-[1.03] hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <div className="relative aspect-[2/3] bg-chip overflow-hidden">
          {item.pic && !imgFailed ? (
            <SmartImage
              url={item.pic}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt={item.title}
              className="w-full h-full object-cover"
              onExhausted={() => setImgFailed(true)}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-chip">
              <svg className="w-8 h-8 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z"
                />
              </svg>
            </div>
          )}

          {/* 追更提醒角标：「更新了」 */}
          {view.hasUpdate && view.updateBadge && (
            <span className="absolute top-1.5 left-1.5 z-10 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500 text-white shadow-md">
              {view.updateBadge}
            </span>
          )}

          {/* 悬停播放图标 */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/35 transition-colors flex items-center justify-center">
            <div className="w-10 h-10 rounded-full bg-accent text-on-accent flex items-center justify-center opacity-0 group-hover:opacity-100 scale-90 group-hover:scale-100 transition-all shadow-lg">
              <svg className="w-5 h-5 fill-current ml-0.5" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>

          {/* 海报底部渐变 + 集数与秒数提示 + 进度条 */}
          <div className="absolute inset-x-0 bottom-0 pt-6 pb-2 px-2 bg-gradient-to-t from-black/90 via-black/55 to-transparent">
            <span className="block text-[11px] font-medium text-white truncate drop-shadow-sm">
              {view.posterLabel}
            </span>
          </div>

          {view.showProgress && (
            <div className="absolute inset-x-0 bottom-0 h-1 bg-white/25 overflow-hidden">
              <div
                className="h-full bg-accent transition-[width] duration-300"
                style={{ width: `${view.percent}%` }}
              />
            </div>
          )}
        </div>

        <div className="p-2">
          <div className="text-xs font-medium text-content truncate" title={item.title}>
            {item.title}
          </div>
          <div
            className={cn(
              'text-[10px] truncate mt-0.5',
              view.hasUpdate ? 'text-emerald-500 font-medium' : 'text-faint',
            )}
          >
            {view.subLabel}
          </div>
        </div>
      </Link>

      {/* 移除按钮 */}
      <button
        type="button"
        onClick={handleRemove}
        aria-label={`从继续观看移除 ${item.title}`}
        title="从继续观看移除"
        className="absolute top-1.5 right-1.5 z-10 w-6 h-6 rounded-full bg-black/65 text-white/80 hover:text-white hover:bg-black/85 flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
      >
        <Icon name="close" className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

/**
 * 首页「我的片单」：
 * 把收藏直接展示在首页一排，与「继续观看」放在一起，不必点右上角星标抽屉才看得到。
 */
export function MyListRow({
  onPick,
  onOpen,
}: {
  onPick: (title: string, pick?: TitlePick) => void;
  onOpen: (item: SearchResultItem) => void;
}) {
  const router = useRouter();
  const profileId = useProfile().id;
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);

  const favorites = useLiveQuery(
    () =>
      profileId
        ? db.favorites
            .where('profileId')
            .equals(profileId)
            .sortBy('addedAt')
            .then((rows) => rows.reverse())
        : [],
    [profileId],
  );

  const history = useLiveQuery(
    () => (profileId ? db.history.where('profileId').equals(profileId).toArray() : []),
    [profileId],
  );

  const visible = useMemo(() => {
    return (favorites ?? []).filter(
      (row) => !(yellowFilter && (row.isAdult || isAdultContent(row.title))),
    );
  }, [favorites, yellowFilter]);

  if (!profileId || visible.length === 0) return null;

  const handleOpenFavorite = (row: FavoriteEntry) => {
    // 1. 若有同片观看记录，优先直接续播
    const key = canonicalTitle(row.title);
    const hist = (history ?? [])
      .filter(
        (h) =>
          (row.sourceKey && row.vodId && h.sourceKey === row.sourceKey && h.vodId === row.vodId) ||
          (key && canonicalTitle(h.title) === key),
      )
      .sort((a, b) => b.timestamp - a.timestamp)[0];

    if (hist) {
      const src = resolveSource({ customAPIs, envSources }, hist.sourceKey, {
        url: hist.sourceUrl,
      });
      if (src) {
        const view = describeContinueWatching(hist, undefined, formatTime);
        router.push(
          buildWatchUrl({
            sourceKey: hist.sourceKey,
            vodId: hist.vodId,
            index: view.targetEpisodeIndex,
            position: view.targetPosition,
            title: hist.title,
            sourceUrl: src.url || hist.sourceUrl,
            detail: src.detail,
          }),
        );
        return;
      }
    }

    // 2. 若收藏自具体点播源且该源可用，直接打开详情弹窗选集
    if (row.sourceKey && row.vodId) {
      const src = resolveSource({ customAPIs, envSources }, row.sourceKey, {
        url: row.sourceUrl,
      });
      if (src) {
        onOpen({
          vodId: row.vodId,
          name: row.title,
          pic: row.pic,
          year: row.year,
          sourceKey: row.sourceKey,
          sourceName: src.name,
          sourceUrl: src.url,
          isAdult: row.isAdult,
        });
        return;
      }
    }

    // 3. 豆瓣卡片收藏（无绑定特定源）：触发首页搜索
    onPick(row.title, { title: row.title, cover: row.pic, year: row.year, rating: row.tasteRating, area: row.tasteArea });
  };

  return (
    <ShelfRow title="我的片单" badge={`${visible.length} 部`} hint="已收藏的剧集与电影">
      {visible.map((row) => (
        <div key={row.id} className="w-[7.25rem] sm:w-32 shrink-0">
          <DoubanCard
            item={{
              title: row.title,
              cover: row.pic || '',
              rating: row.tasteRating,
              meta: [row.year, row.tasteArea].filter(Boolean).join(' · ') || '已收藏',
              favorite: {
                localId: row.localId,
                title: row.title,
                pic: row.pic,
                sourceKey: row.sourceKey,
                sourceUrl: row.sourceUrl,
                vodId: row.vodId,
                year: row.year,
                isAdult: row.isAdult,
              },
            }}
            onClick={() => handleOpenFavorite(row)}
          />
        </div>
      ))}
    </ShelfRow>
  );
}

const TOP_TEN_TABS: { id: HotListId; label: string; channel: 'tv' | 'movie' | 'show' | 'anime' | 'doc' }[] = [
  { id: 'realtime_all', label: '🔥 综合总榜', channel: 'tv' },
  { id: 'douban_tv_realtime', label: '📺 热门剧集', channel: 'tv' },
  { id: 'douban_movie_realtime', label: '🍿 热门电影', channel: 'movie' },
  { id: 'bili_bangumi', label: '🌸 日漫新番', channel: 'anime' },
  { id: 'bili_guochuang', label: '🐉 国漫热播', channel: 'anime' },
  { id: 'douban_tv_domestic', label: '🇨🇳 国产热剧', channel: 'tv' },
  { id: 'douban_tv_korean', label: '🇰🇷 日韩热剧', channel: 'tv' },
  { id: 'douban_tv_american', label: '🇺🇸 欧美热剧', channel: 'tv' },
  { id: 'douban_show_hot', label: '🎪 热门综艺', channel: 'show' },
  { id: 'bili_doc', label: '🌍 纪录片榜', channel: 'doc' },
  { id: 'tmdb_trending', label: '🌐 全球趋势', channel: 'tv' },
];

/**
 * 首页「实时风向 · TOP 10」（Netflix 风格带大数字 1~10 的多源实时热榜排）：
 * 按影视大类划分，每个分类内部由 RRF 倒数排名融合 + 跨平台共现加权算法综合选出。
 */
export function TopTenRow({ onPick }: { onPick: (title: string, pick?: TitlePick) => void }) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const [tab, setTab] = useState<HotListId>('realtime_all');
  const { items, isLoading, meta } = useTopRankItems(tab, doubanEnabled);
  const [explainOpen, setExplainOpen] = useState(false);
  const tabScrollerRef = useRef<HTMLDivElement>(null);
  const [canTabLeft, setCanTabLeft] = useState(false);
  const [canTabRight, setCanTabRight] = useState(false);

  const updateTabScroll = useCallback(() => {
    const el = tabScrollerRef.current;
    if (!el) return;
    setCanTabLeft(el.scrollLeft > 4);
    setCanTabRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  }, []);

  useEffect(() => {
    const el = tabScrollerRef.current;
    if (!el) return;
    updateTabScroll();
    el.addEventListener('scroll', updateTabScroll, { passive: true });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateTabScroll) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', updateTabScroll);
      ro?.disconnect();
    };
  }, [updateTabScroll, doubanEnabled]);

  const scrollTabs = (dir: -1 | 1) => {
    const el = tabScrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(180, Math.round(el.clientWidth * 0.65)), behavior: 'smooth' });
  };

  if (!doubanEnabled) return null;

  const activeChannel = TOP_TEN_TABS.find((t) => t.id === tab)?.channel ?? 'tv';

  return (
    <div className="space-y-2">
    <ShelfRow
      title="实时风向 · TOP 10"
      badge="多源综合排名"
      hint={meta ? `${formatClock(meta.updatedAt)} 更新 · ${meta.sources.filter((s) => s.ok).length} 个来源` : undefined}
      headerExtra={
        <div className="flex items-center gap-1.5 min-w-0 max-w-full">
          <button
            type="button"
            onClick={() => setExplainOpen((v) => !v)}
            aria-expanded={explainOpen}
            className="px-2 py-1 rounded-full text-[11px] text-muted hover:text-content hover:bg-hover shrink-0 cursor-pointer"
          >
            怎么排的？
          </button>
          {(canTabLeft || canTabRight) && (
            <button
              type="button"
              onClick={() => scrollTabs(-1)}
              disabled={!canTabLeft}
              aria-label="向左滚动分类标签"
              title="向左滚动分类标签"
              className="w-6 h-6 rounded-full border border-line bg-surface/90 text-muted hover:text-content hover:bg-hover disabled:opacity-25 disabled:pointer-events-none flex items-center justify-center shrink-0 transition-colors cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
          )}
          <div
            ref={tabScrollerRef}
            className="flex items-center gap-1 overflow-x-auto scrollbar-none min-w-0 flex-1 pb-0.5 scroll-smooth"
          >
            {TOP_TEN_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={cn(
                  'px-2.5 py-1 rounded-full text-xs transition-colors cursor-pointer shrink-0',
                  tab === t.id
                    ? 'bg-accent text-on-accent font-medium shadow-sm'
                    : 'bg-chip text-muted hover:text-content hover:bg-hover',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          {(canTabLeft || canTabRight) && (
            <button
              type="button"
              onClick={() => scrollTabs(1)}
              disabled={!canTabRight}
              aria-label="向右滚动分类标签"
              title="向右滚动分类标签"
              className="w-6 h-6 rounded-full border border-line bg-surface/90 text-muted hover:text-content hover:bg-hover disabled:opacity-25 disabled:pointer-events-none flex items-center justify-center shrink-0 transition-colors cursor-pointer"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          )}
        </div>
      }
    >
      {isLoading && items.length === 0
        ? Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="w-40 sm:w-44 shrink-0 flex items-end">
              <div className="w-10 h-24 rounded bg-chip animate-pulse mr-1" />
              <div className="flex-1 aspect-[2/3] rounded-xl bg-chip animate-pulse" />
            </div>
          ))
        : items.map((item, idx) => (
            <TopTenCard
              key={`${item.id}_${item.title}`}
              rank={idx + 1}
              item={item}
              onClick={() => {
                void rememberDoubanItem(item, activeChannel);
                onPick(item.title, item);
              }}
              onFavorite={() => {
                void rememberDoubanItem(item, activeChannel);
              }}
            />
          ))}
    </ShelfRow>
    {explainOpen && <RankingExplainer meta={meta} />}
    </div>
  );
}

const formatClock = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 「怎么排的？」：说明排名规则，并列出这一次实际取到了哪些来源 */
function RankingExplainer({ meta }: { meta?: { updatedAt: number; ttl: number; sources: { name: string; ok: boolean; count: number }[] } }) {
  return (
    <div className="rounded-xl border border-line bg-surface/70 px-4 py-3.5 text-xs text-muted leading-relaxed space-y-2.5">
      <ol className="list-decimal pl-4 space-y-1">
        <li>同时拉取多个平台的实时榜单：豆瓣实时热门、B站热播、百度热播、Bangumi 在看人数、TMDB 当日趋势（各标签用的来源不同）。</li>
        <li>先清洗：剔除还没播出的、常年霸榜的长青老番（柯南、海贼王等）、中配重复版、超长集数作品；同一系列只保留最新一季。</li>
        <li>每部作品在每个平台按名次得分，第 r 名得 1 ÷ (60 + r)，名次越前分越高；同一平台的几个榜只算最好的那一次，避免一个平台重复投票。</li>
        <li>各平台得分相加——上榜的平台越多越靠前；再乘评分系数：7 分为中性，高分最多 +12%，低分最多 −12%。</li>
        <li>综合总榜的前 10 名里，同一类（电影 / 剧集 / 日漫 / 国漫 / 综艺 / 纪录片）最多 4 部。</li>
        <li>综合总榜每小时记一次名次快照，和 3~24 小时前比：往前冲的最多加 6%（约等于往前挪三四名），往后掉的最多减 6%，新上榜加 3%；卡片上的「↑N」「新上榜」就是这个。</li>
        <li>服务器每 15 分钟重算一次，所有人看到同一份；页面开着也会自动刷新。</li>
      </ol>
      {meta && (
        <div className="pt-2 border-t border-line">
          <p className="mb-1.5 text-faint">
            这一次（{formatClock(meta.updatedAt)}）用到的来源：
          </p>
          <div className="flex flex-wrap gap-1.5">
            {meta.sources.map((s) => (
              <span
                key={s.name}
                className={cn(
                  'px-2 py-0.5 rounded-full border',
                  s.ok ? 'border-line text-content' : 'border-dashed border-line text-faint line-through',
                )}
                title={s.ok ? `取到 ${s.count} 条` : '这次没取到，不参与排名'}
              >
                {s.name}
                {s.ok && <span className="ml-1 text-faint">{s.count}</span>}
              </span>
            ))}
          </div>
          <a href="/diagnostics" className="inline-block mt-2 text-accent hover:underline">
            打开数据源体检 →
          </a>
        </div>
      )}
    </div>
  );
}

function TopTenCard({
  rank,
  item,
  onClick,
  onFavorite,
}: {
  rank: number;
  item: DoubanItem;
  onClick: () => void;
  onFavorite: () => void;
}) {
  const isMultiSource = Boolean(item.sourceLabel && item.sourceLabel.includes('源共推'));
  const metaText = isMultiSource
    ? item.sourceLabel!
    : [item.year, item.area, item.genres?.split(/\s+/)[0]].filter(Boolean).join(' · ') ||
      item.subtitle ||
      item.sourceLabel ||
      `实时第 ${rank} 名`;

  const badge = item.remarks
    ? {
        text: item.remarks.length > 10 ? item.remarks.slice(0, 10) : item.remarks,
        tone: (item.status === 'ended' ? 'ok' : 'warn') as 'ok' | 'warn',
      }
    : item.status === 'ended'
      ? { text: '完结', tone: 'ok' as const }
      : item.status === 'airing'
        ? { text: '连载', tone: 'warn' as const }
        : undefined;

  return (
    <div className="shrink-0 flex items-end group pl-1">
      {/* Netflix 风格大号空心描边渐变数字 */}
      <div
        aria-hidden
        className="select-none pointer-events-none -mr-3.5 sm:-mr-4 z-0 pb-6 transition-transform duration-200 group-hover:scale-105"
      >
        <svg
          viewBox={rank === 10 ? '0 0 92 110' : '0 0 64 110'}
          className={cn('h-24 sm:h-28 w-auto overflow-visible drop-shadow')}
        >
          <defs>
            <linearGradient id={`rank-grad-${rank}`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor="rgb(var(--c-accent))" stopOpacity="0.95" />
              <stop offset="100%" stopColor="rgb(var(--c-card))" stopOpacity="0.9" />
            </linearGradient>
          </defs>
          <text
            x={rank === 10 ? '46' : '32'}
            y="98"
            textAnchor="middle"
            fill={`url(#rank-grad-${rank})`}
            stroke="rgb(var(--c-content))"
            strokeOpacity="0.45"
            strokeWidth="3"
            fontWeight="900"
            fontSize={rank === 10 ? '86' : '98'}
            fontFamily="system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
            style={{ letterSpacing: rank === 10 ? '-6px' : '0' }}
          >
            {rank}
          </text>
        </svg>
      </div>

      <div className="relative z-10 w-[7.25rem] sm:w-32">
        {(item.rankNew || (item.rankDelta ?? 0) >= 2) && (
          <span
            className="absolute top-9 right-1.5 z-20 px-1.5 py-0.5 rounded-md text-[10px] font-bold text-white bg-emerald-600/95 shadow pointer-events-none"
            title={item.rankNew ? '最近一天新上榜' : `比半天到一天前上升 ${item.rankDelta} 名`}
          >
            {item.rankNew ? '新上榜' : `↑${item.rankDelta}`}
          </span>
        )}
        <DoubanCard
          item={{
            title: item.title,
            cover: item.cover,
            rating: item.rating,
            meta: metaText,
            favorite: {
              localId: favoriteIdOf({ title: item.title }),
              title: item.title,
              pic: item.cover,
              year: item.year,
            },
            badge,
          }}
          onClick={onClick}
          onFavorite={onFavorite}
        />
      </div>
    </div>
  );
}

const UPCOMING_TABS: { id: 'all' | UpcomingKind; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'anime', label: '🌸 动漫' },
  { id: 'tv', label: '📺 剧集' },
  { id: 'movie', label: '🍿 电影' },
];

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 「今天 23:00」「明天」「周五 01:30」 */
export function formatAiringLabel(airingAt: number, timeKnown: boolean, now = Date.now()): string {
  const d = new Date(airingAt);
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const dayDiff = Math.floor((d.getTime() - startOfToday.getTime()) / 86_400_000);
  const day =
    dayDiff <= 0 ? '今天' : dayDiff === 1 ? '明天' : dayDiff === 2 ? '后天' : WEEKDAY_CN[d.getDay()];
  if (!timeKnown) return `${day} · ${d.getMonth() + 1}/${d.getDate()}`;
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${day} ${hh}:${mm}`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 本地时区的 YYYY-MM-DD */
function localDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 条目归到哪一天：有精确时间按观看者本地日期；只知道日期的（TMDB）按北京时间日期，避免跨时区漂移 */
export function upcomingDayKey(item: Pick<UpcomingItem, 'airingAt' | 'timeKnown'>): string {
  return item.timeKnown ? localDateKey(item.airingAt) : new Date(item.airingAt + 8 * 3_600_000).toISOString().slice(0, 10);
}

export interface UpcomingDay {
  key: string;
  /** 今天 / 明天 / 周X */
  label: string;
  /** 3/21 */
  date: string;
  count: number;
}

/** 从今天起连续 7 天（真实日期），统计每天的条目数 */
export function buildUpcomingDays(items: Pick<UpcomingItem, 'airingAt' | 'timeKnown'>[], now = Date.now()): UpcomingDay[] {
  const counts = new Map<string, number>();
  for (const i of items) {
    const k = upcomingDayKey(i);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return Array.from({ length: 7 }, (_, offset) => {
    const d = new Date(now);
    d.setDate(d.getDate() + offset);
    const key = localDateKey(d.getTime());
    return {
      key,
      label: offset === 0 ? '今天' : offset === 1 ? '明天' : WEEKDAY_CN[d.getDay()],
      date: `${d.getMonth() + 1}/${d.getDate()}`,
      count: counts.get(key) ?? 0,
    };
  });
}

/**
 * 首页「即将播出」：接下来 7 天还没播出的内容。
 * 首播/首映：点击加入片单（现在还搜不到）；连载中的新集：点击先看已经播出的集数。
 */
export function UpcomingRow({ onPick }: { onPick: (title: string, pick?: TitlePick) => void }) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const profileId = useProfile().id;
  const { toast } = useToast();
  const [tab, setTab] = useState<'all' | UpcomingKind>('all');
  /** null = 还没选过，自动落在第一个有内容的日子 */
  const [dayPick, setDayPick] = useState<string | 'all' | null>(null);

  const query = useQuery({
    queryKey: ['upcoming'],
    queryFn: ({ signal }) => api.upcoming(signal),
    enabled: doubanEnabled,
    staleTime: 30 * 60_000,
    retry: 1,
  });

  const all = useMemo(
    () =>
      (query.data?.items ?? []).filter(
        (i) => (!i.timeKnown || i.airingAt > Date.now()) && (!yellowFilter || !isAdultContent(i.title)),
      ),
    [query.data, yellowFilter],
  );
  // 未来 7 天，每天一个标签：今天 / 明天 / 周X（含日期）
  const days = useMemo(() => buildUpcomingDays(all), [all]);
  const activeDay = dayPick ?? days.find((d) => d.count > 0)?.key ?? 'all';
  const inDay = useMemo(
    () => (activeDay === 'all' ? all : all.filter((i) => upcomingDayKey(i) === activeDay)),
    [all, activeDay],
  );
  const counts = useMemo(() => {
    const c: Record<string, number> = { all: inDay.length, anime: 0, tv: 0, movie: 0 };
    for (const i of inDay) c[i.kind] += 1;
    return c;
  }, [inDay]);
  const visible = useMemo(
    () => (tab === 'all' ? inDay : inDay.filter((i) => i.kind === tab)).slice(0, 40),
    [inDay, tab],
  );

  if (!doubanEnabled) return null;
  if (!query.isLoading && all.length === 0) return null;

  const handleClick = async (item: UpcomingItem) => {
    const when = formatAiringLabel(item.airingAt, item.timeKnown);
    if (!item.premiere) {
      toast(`《${item.title}》第 ${item.episode ?? '?'} 集将于${when}播出，先看已经播出的集数`, 'info');
      onPick(item.title, { title: item.title, cover: item.cover, rating: item.rating, area: item.area });
      return;
    }
    const localId = favoriteIdOf({ title: item.title });
    const saved = profileId ? await db.favorites.get(`${profileId}::${localId}`) : undefined;
    if (!saved) await toggleFavorite({ localId, title: item.title, pic: item.cover });
    toast(
      `《${item.title}》${item.kind === 'movie' ? '上映' : '首播'}于${when}，${saved ? '已在' : '已加入'}我的片单，播出后片源站收录即可观看`,
      'success',
    );
  };

  return (
    <ShelfRow
      title="即将播出"
      badge="未来 7 天"
      headerExtra={
        <div className="flex flex-col items-end gap-1.5 min-w-0 max-w-full">
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-none max-w-full" role="tablist" aria-label="播出日期">
            {[{ key: 'all', label: '全部', date: '', count: all.length }, ...days].map((d) => (
              <button
                key={d.key}
                type="button"
                role="tab"
                aria-selected={activeDay === d.key}
                disabled={d.count === 0}
                onClick={() => setDayPick(d.key)}
                className={cn(
                  'px-2.5 py-1 rounded-full text-xs transition-colors shrink-0 leading-tight text-center',
                  d.count === 0 ? 'opacity-35 cursor-default' : 'cursor-pointer',
                  activeDay === d.key
                    ? 'bg-accent text-on-accent font-medium shadow-sm'
                    : 'bg-chip text-muted hover:text-content hover:bg-hover',
                )}
              >
                {d.label}
                {d.date && <span className="ml-1 opacity-70">{d.date}</span>}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-none max-w-full">
            {UPCOMING_TABS.map((t) =>
              t.id !== 'all' && counts[t.id] === 0 ? null : (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'px-2 py-0.5 rounded-full text-[11px] transition-colors cursor-pointer shrink-0',
                    tab === t.id
                      ? 'bg-content/15 text-content font-medium'
                      : 'text-muted hover:text-content hover:bg-hover',
                  )}
                >
                  {t.label}
                  {counts[t.id] > 0 && <span className="ml-1 opacity-70">{counts[t.id]}</span>}
                </button>
              ),
            )}
          </div>
        </div>
      }
    >
      {query.isLoading && all.length === 0
        ? Array.from({ length: 7 }).map((_, idx) => (
            <div key={idx} className="w-[7.25rem] sm:w-32 shrink-0 aspect-[2/3] rounded-xl bg-chip animate-pulse" />
          ))
        : visible.map((item) => (
            <div key={item.id} className="w-[7.25rem] sm:w-32 shrink-0">
              <DoubanCard
                item={{
                  title: item.title,
                  cover: item.cover,
                  rating: item.rating,
                  meta: [formatAiringLabel(item.airingAt, item.timeKnown), item.area].filter(Boolean).join(' · '),
                  favorite: {
                    localId: favoriteIdOf({ title: item.title }),
                    title: item.title,
                    pic: item.cover,
                  },
                  badge: item.premiere
                    ? { text: item.kind === 'movie' ? '即将上映' : '首播', tone: 'ok' }
                    : { text: `第${item.episode ?? '?'}集`, tone: 'warn' },
                }}
                onClick={() => void handleClick(item)}
              />
            </div>
          ))}
    </ShelfRow>
  );
}
