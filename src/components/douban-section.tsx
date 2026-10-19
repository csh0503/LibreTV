'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { DoubanItem, SearchResultItem, TitlePick } from '@/lib/types';
import { isAdultContent } from '@/lib/cms-parser';
import {
  HALL_PAGE_SIZE,
  buildDoubanRequest,
  filterHallItems,
  mergeAiringCalendar,
  reconcileStatusWithCalendar,
  sortHallItems,
  type HallChannel,
  type HallScore,
  type HallSortDir,
  type HallSortKey,
  type HallStatus,
} from '@/lib/recommend';
import { SortArrows } from './sort-arrows';
import { DoubanCard } from './video-card';
import { favoriteIdOf } from '@/lib/db';
import { dedupeSeasons } from '@/lib/shelf-defs';
import { mergeSameWorks } from '@/lib/work-identity';
import { absorbHallTaste, rememberDoubanItem } from '@/lib/taste-store';
import { AdultLibrary } from './adult-library';
import { useLoadMore } from './use-load-more';

/** 细线图标（1.6 描边，跟着文字颜色），不再用 emoji */
const CHANNEL_ICON_PATHS: Record<Exclude<HallChannel, 'adult'>, string> = {
  anime: 'M12 3.5c.7 4.3 3.2 6.8 7.5 7.5-4.3.7-6.8 3.2-7.5 7.5-.7-4.3-3.2-6.8-7.5-7.5 4.3-.7 6.8-3.2 7.5-7.5z',
  movie: 'M4 6.5h16v11H4zM4 10h16M8.5 6.5 10 10M13.5 6.5 15 10',
  tv: 'M3.5 6.5h17v10.5h-17zM9 20.5h6M12 17v3.5',
  show: 'M12 3.5a2.5 2.5 0 0 1 2.5 2.5v5a2.5 2.5 0 0 1-5 0V6A2.5 2.5 0 0 1 12 3.5zM6.5 11a5.5 5.5 0 0 0 11 0M12 16.5v4M9 20.5h6',
  doc: 'M12 20.5a8.5 8.5 0 1 0 0-17 8.5 8.5 0 0 0 0 17zM3.5 12h17M12 3.5c2.4 2.4 3.4 5.2 3.4 8.5s-1 6.1-3.4 8.5c-2.4-2.4-3.4-5.2-3.4-8.5s1-6.1 3.4-8.5z',
};
const CHANNELS: { id: Exclude<HallChannel, 'adult'>; label: string }[] = [
  { id: 'anime', label: '动漫' },
  { id: 'movie', label: '电影' },
  { id: 'tv', label: '电视剧' },
  { id: 'show', label: '综艺' },
  { id: 'doc', label: '纪录片' },
];

function ChannelIcon({ id }: { id: Exclude<HallChannel, 'adult'> }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={CHANNEL_ICON_PATHS[id]} />
    </svg>
  );
}

const GENRES: Record<Exclude<HallChannel, 'adult'>, string[]> = {
  anime: ['全部', '热血', '奇幻', '恋爱', '日常', '搞笑', '科幻', '治愈', '机战', '悬疑', '冒险', '战斗', '校园', '催泪'],
  movie: ['全部', '喜剧', '爱情', '动作', '科幻', '动画', '悬疑', '犯罪', '惊悚', '冒险', '奇幻', '恐怖', '战争', '武侠', '历史', '灾难', '音乐'],
  tv: ['全部', '剧情', '悬疑', '犯罪', '古装', '都市', '爱情', '喜剧', '奇幻', '科幻', '武侠', '战争', '历史', '惊悚', '短剧'],
  show: ['全部', '真人秀', '音乐', '脱口秀', '搞笑', '恋爱', '游戏', '访谈', '选秀'],
  doc: ['全部', '自然', '历史', '人物', '科技', '社会', '战争', '灾难', '传记'],
};

const AREAS = ['全部', '华语', '中国大陆', '中国香港', '中国台湾', '日本', '韩国', '美国', '英国', '法国', '德国', '泰国', '印度', '欧美'];
const YEARS = ['全部', '2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2015-2018', '2010-2014', '2000年代', '90年代', '更早'];
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function RecommendSection({
  ref,
  initialChannel = 'anime',
  onPick,
  onOpen,
}: {
  ref?: React.Ref<HTMLElement>;
  /** 从首页货架末尾点进来时直接落在对应频道 */
  initialChannel?: HallChannel;
  onPick: (title: string, pick?: TitlePick) => void;
  onOpen: (item: SearchResultItem) => void;
}) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const nowYear = new Date().getFullYear();

  const [channel, setChannel] = useState<HallChannel>(initialChannel);
  const [genre, setGenre] = useState('全部');
  const [area, setArea] = useState('全部');
  const [year, setYear] = useState('全部');
  const [status, setStatus] = useState<HallStatus>('all');
  const [score, setScore] = useState<HallScore>('all');
  const [sortKey, setSortKey] = useState<HallSortKey>('hot');
  const [sortDir, setSortDir] = useState<HallSortDir>('desc');
  const [weekday, setWeekday] = useState<number | 'all'>('all');
  const [filtersExpanded, setFiltersExpanded] = useState(true);

  useEffect(() => {
    if (yellowFilter && channel === 'adult') setChannel('anime');
  }, [yellowFilter, channel]);

  const genreList = channel === 'adult' ? [] : GENRES[channel];
  const showStatus = channel === 'anime' || channel === 'tv' || channel === 'show';
  const weekdayMode = channel === 'anime' && weekday !== 'all';

  const request = useMemo(
    () => buildDoubanRequest({ channel, genre, area, year, sort: sortKey, score, status }),
    [channel, genre, area, year, sortKey, score, status]
  );

  const doubanQuery = useInfiniteQuery({
    queryKey: ['douban-hall', request?.kind, request?.tags.join(','), request?.sort, request?.score, request?.status],
    queryFn: ({ pageParam, signal }) =>
      api.douban({ ...request!, pageStart: pageParam, pageSize: HALL_PAGE_SIZE }, signal),
    initialPageParam: 0,
    getNextPageParam: (last, allPages) => {
      if (last.items.length === 0) return undefined;
      const prev = allPages[allPages.length - 2];
      if (prev?.items[0]?.id && prev.items[0].id === last.items[0]?.id) return undefined;
      // 偏移按「第几页 × 每页条数」算，不能用已加载的卡片数：每页是豆瓣 / B站 / TMDB / Bangumi
      // 各取一页融合出来的，常常比一页多，拿它当偏移会让各来源跳过中间整页
      // 不按豆瓣给的总数停：豆瓣翻完了，B站 / TMDB / Bangumi 往往还有很多；一页凑不满才算到底
      const nextStart = allPages.length * HALL_PAGE_SIZE;
      if (last.items.length < HALL_PAGE_SIZE) return undefined;
      return nextStart;
    },
    enabled: doubanEnabled && request !== null && !weekdayMode,
    placeholderData: keepPreviousData,
    retry: 1,
  });
  const {
    data: doubanData,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isLoading,
    isError,
    fetchNextPage,
  } = doubanQuery;

  const bangumiQuery = useQuery({
    queryKey: ['bangumi-calendar'],
    queryFn: ({ signal }) => api.bangumiCalendar(signal),
    enabled: doubanEnabled && channel === 'anime',
  });

  const items = useMemo(() => {
    if (weekdayMode) {
      const day = bangumiQuery.data?.days.find((d) => d.weekday === weekday)?.items ?? [];
      return dedupeSeasons(sortHallItems(
        day
          .map((item) => ({ ...item, status: 'airing' as const, area: item.area || '日本', year: item.year || String(nowYear), isTv: true }))
          .filter((item) => status !== 'ended' && (!yellowFilter || !isAdultContent(item.title))),
        sortKey,
        sortDir
      ));
    }
    if (!request) return [];
    // 各来源分页不一样，同一部常落在不同页（还可能换了译名）：按作品合并，不只按编号
    const doubanItems = mergeSameWorks((doubanData?.pages ?? []).flatMap((page) => page.items));
    const allCalendar = channel === 'anime' ? bangumiQuery.data?.days.flatMap((d) => d.items) ?? [] : [];
    const reconciledDouban =
      channel === 'anime' ? reconcileStatusWithCalendar(doubanItems, allCalendar, nowYear) : doubanItems;

    // 过滤掉豆瓣里今年刚立项官宣、尚无评分也无集数且不在当周放送表中的「未开播空气词条」
    const playableDouban = reconciledDouban.filter((item) => {
      if (item.year === String(nowYear) && !item.rating && !item.remarks && item.status !== 'airing') {
        return false;
      }
      return true;
    });

    const mergeCalendar =
      channel === 'anime' &&
      status !== 'ended' &&
      genre === '全部' &&
      (area === '全部' || area === '日本') &&
      (year === '全部' || year === String(nowYear) || year === String(nowYear - 1));
    // 默认「全部」视图只混入评分 ≥ 6.8 的高人气当季在播番，避免 3~5 分冷门泡面番霸占第一排
    // 「连载中」就是要看当季在播的：整份放送表都放进来；其余视图只混入高分的，免得冷门泡面番占满第一排
    const popularCalendar = mergeCalendar
      ? status === 'airing'
        ? allCalendar
        : allCalendar.filter((c) => parseFloat(c.rating ?? '0') >= 6.8)
      : [];
    const merged = mergeAiringCalendar(playableDouban, popularCalendar, nowYear);
    const filtered = filterHallItems(merged, {
      genre,
      area,
      yearRange: request.yearRange,
      status,
      applyStatus: showStatus,
      minScore: request.minScore,
      hideAdult: yellowFilter,
    });
    // 同一系列不同季只留排序靠前的一张
    return dedupeSeasons(sortHallItems(filtered, sortKey, sortDir));
  }, [
    weekdayMode,
    weekday,
    bangumiQuery.data,
    yellowFilter,
    status,
    request,
    doubanData,
    channel,
    genre,
    area,
    year,
    nowYear,
    showStatus,
    sortKey,
    sortDir,
  ]);

  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetching) void fetchNextPage();
  }, [hasNextPage, isFetching, fetchNextPage]);
  const sentinel = useLoadMore(!weekdayMode && !!hasNextPage && !isFetching, doubanData?.pages.length ?? 0, loadMore);

  const loadedPages = doubanData?.pages.length ?? 0;
  useEffect(() => {
    if (channel === 'adult' || items.length === 0) return;
    const handle = window.setTimeout(() => {
      void absorbHallTaste(items, channel, genre);
    }, 500);
    return () => window.clearTimeout(handle);
  }, [items, channel, genre]);
  useEffect(() => {
    // 年份区间会裁掉一整页。最多再补 2 页，避免某个标签把 500 条全部翻完、骨架一直不消失。
    if (weekdayMode || items.length > 0 || isError) return;
    if (!hasNextPage || isFetching || loadedPages >= 3) return;
    void fetchNextPage();
  }, [weekdayMode, items.length, hasNextPage, isFetching, isError, loadedPages, fetchNextPage]);

  if (!doubanEnabled) return null;

  const reset = () => {
    setGenre('全部');
    setArea('全部');
    setYear('全部');
    setStatus('all');
    setScore('all');
    setSortKey('hot');
    setSortDir('desc');
    setWeekday('all');
  };

  const hasActiveFilter =
    genre !== '全部' ||
    area !== '全部' ||
    year !== '全部' ||
    status !== 'all' ||
    score !== 'all' ||
    sortKey !== 'hot' ||
    sortDir !== 'desc' ||
    weekday !== 'all';

  const pickChannel = (id: HallChannel) => {
    setChannel(id);
    // 片库页：频道写进网址，刷新 / 分享 / 从详情返回都还在这个频道（不触发路由，免得整页重建）
    if (location.pathname === '/browse' && id !== 'adult') {
      history.replaceState(history.state, '', `/browse?channel=${id}`);
    }
    setGenre('全部');
    setWeekday('all');
  };

  return (
    <section ref={ref} aria-label="影视与动漫大厅" className="space-y-3.5 pt-2 scroll-mt-20">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
          <h2 className="text-lg sm:text-xl font-semibold text-content tracking-tight">分类片库</h2>
          {/* 分段控件（Apple TV 式）：一条浅底，选中的那段浮起来 */}
          <div role="tablist" aria-label="频道" className="flex items-center gap-0.5 p-1 rounded-full bg-content/[0.06] ring-1 ring-inset ring-content/[0.06] overflow-x-auto scrollbar-none max-w-full">
            {CHANNELS.map((c) => (
              <ChannelButton key={c.id} active={channel === c.id} onClick={() => pickChannel(c.id)}>
                <ChannelIcon id={c.id} />
                <span>{c.label}</span>
              </ChannelButton>
            ))}
            {!yellowFilter && (
              <ChannelButton active={channel === 'adult'} onClick={() => pickChannel('adult')}>
                <span className="text-[11px] font-semibold tabular-nums">18+</span>
                <span>成人</span>
              </ChannelButton>
            )}
          </div>
        </div>
        {channel !== 'adult' && (
          <div className="flex items-center gap-2 ml-auto">
            {hasActiveFilter && (
              <button
                type="button"
                onClick={reset}
                className="px-3 py-1.5 rounded-full text-xs text-muted hover:text-content transition-colors cursor-pointer"
              >
                重置筛选
              </button>
            )}
            <button
              type="button"
              onClick={() => setFiltersExpanded((v) => !v)}
              aria-expanded={filtersExpanded}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-muted ring-1 ring-inset ring-content/[0.1] hover:text-content hover:bg-content/[0.05] transition-colors cursor-pointer"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" aria-hidden="true">
                <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
                <circle cx="16" cy="7" r="2" />
                <circle cx="10" cy="17" r="2" />
              </svg>
              {filtersExpanded ? '收起筛选' : '筛选'}
            </button>
          </div>
        )}
      </div>

      {channel === 'adult' ? (
        <AdultLibrary onOpen={onOpen} />
      ) : (
        <>
          {filtersExpanded && (
            <div className="rounded-2xl bg-content/[0.03] ring-1 ring-inset ring-content/[0.06] px-3 py-3 sm:px-4 sm:py-3.5 space-y-2.5 text-xs">
              {channel === 'anime' && (
                <FilterRow label="放送">
                  <FilterChip active={weekday === 'all'} onClick={() => setWeekday('all')}>
                    全部
                  </FilterChip>
                  {WEEKDAYS.map((label, index) => (
                    <FilterChip key={label} active={weekday === index + 1} onClick={() => setWeekday(index + 1)}>
                      {label}
                    </FilterChip>
                  ))}
                </FilterRow>
              )}
              <FilterRow label="题材">
                {genreList.map((name) => (
                  <FilterChip key={name} active={genre === name} onClick={() => setGenre(name)}>
                    {name}
                  </FilterChip>
                ))}
              </FilterRow>
              <FilterRow label="地区">
                {AREAS.map((name) => (
                  <FilterChip key={name} active={area === name} onClick={() => setArea(name)}>
                    {name}
                  </FilterChip>
                ))}
              </FilterRow>
              <FilterRow label="年份">
                {YEARS.map((name) => (
                  <FilterChip key={name} active={year === name} onClick={() => setYear(name)}>
                    {name}
                  </FilterChip>
                ))}
              </FilterRow>
              {showStatus && (
                <FilterRow label="状态">
                  <FilterChip active={status === 'all'} onClick={() => setStatus('all')}>全部</FilterChip>
                  <FilterChip active={status === 'airing'} onClick={() => setStatus('airing')}>连载中</FilterChip>
                  <FilterChip active={status === 'ended'} onClick={() => setStatus('ended')}>已完结</FilterChip>
                </FilterRow>
              )}
              <FilterRow label="评分">
                <FilterChip active={score === 'all'} onClick={() => setScore('all')}>全部</FilterChip>
                <FilterChip active={score === '9'} onClick={() => setScore('9')}>9 分以上</FilterChip>
                <FilterChip active={score === '8'} onClick={() => setScore('8')}>8 分以上</FilterChip>
                <FilterChip active={score === '7'} onClick={() => setScore('7')}>7 分以上</FilterChip>
              </FilterRow>
              <FilterRow label="排序">
                <SortArrows
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onChange={(key, dir) => {
                    setSortKey(key);
                    setSortDir(dir);
                  }}
                />
              </FilterRow>
            </div>
          )}

          {weekdayMode && (
            <p className="text-xs text-faint">这一行是 Bangumi 本周放送。题材、地区、年份和评分留到「全部」放送时再生效。</p>
          )}

          {isError && !weekdayMode ? (
            <p className="text-center text-sm text-faint py-12">推荐内容加载失败，请检查网络</p>
          ) : (weekdayMode ? bangumiQuery.isLoading : isLoading) ? (
            <GridSkeleton />
          ) : items.length === 0 ? (
            <div className="text-center py-12 space-y-2">
              <p className="text-sm text-muted">当前筛选下没有片子</p>
              <button type="button" className="text-xs text-accent underline hover:opacity-80" onClick={reset}>
                重置筛选
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5 sm:gap-3">
                {items.map((item) => (
                  <DoubanCard
                    key={`${item.id}_${item.title}`}
                    item={toCard(item)}
                    onClick={() => {
                      void rememberDoubanItem(item, channel, genre === '全部' ? undefined : genre);
                      onPick(item.title, item);
                    }}
                    onFavorite={() => {
                      void rememberDoubanItem(item, channel, genre === '全部' ? undefined : genre);
                    }}
                  />
                ))}
              </div>
              {!weekdayMode && hasNextPage && (
                <div ref={sentinel} className="py-6 text-center text-xs text-faint">
                  {isFetchingNextPage ? '正在加载更多…' : '继续下滑'}
                </div>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}

function toCard(item: DoubanItem) {
  const meta = [item.year, item.area].filter(Boolean).join(' · ');
  return {
    title: item.title,
    cover: item.cover,
    rating: item.rating,
    meta: meta || undefined,
    favorite: {
      localId: favoriteIdOf({ title: item.title }),
      title: item.title,
      pic: item.cover,
      year: item.year,
    },
    badge:
      item.status === 'ended'
        ? { text: '完结', tone: 'ok' as const }
        : item.status === 'airing'
          ? { text: '连载', tone: 'warn' as const }
          : undefined,
  };
}

function ChannelButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      role="tab"
      aria-selected={active}
      className={cn(
        'flex shrink-0 items-center gap-1.5 px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-all duration-200',
        active
          ? 'bg-surface-raised text-content shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.06)]'
          : 'text-muted hover:text-content'
      )}
    >
      {children}
    </button>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-faint shrink-0 w-10 sm:w-12 pt-1 tracking-wide">{label}</span>
      <div className="flex flex-1 min-w-0 overflow-x-auto scrollbar-none sm:flex-wrap gap-1 pb-0.5">{children}</div>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        'px-2.5 py-1 rounded-full text-xs transition-colors shrink-0',
        // 选中：实心的深色胶囊（Apple 式），不再用亮蓝
        active ? 'bg-content text-page font-medium' : 'text-muted hover:text-content hover:bg-content/[0.06]'
      )}
      aria-pressed={active}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i} className="animate-pulse">
          <div className="aspect-[2/3] rounded-xl bg-chip" />
          <div className="h-3.5 mt-2 rounded bg-chip w-3/4" />
        </div>
      ))}
    </div>
  );
}
