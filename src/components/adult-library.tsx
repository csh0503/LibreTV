'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { sourceIsAdult } from '@/lib/adult-sources';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { SearchResultItem, VodListItem } from '@/lib/types';
import { DoubanCard } from './video-card';
import { favoriteIdOf } from '@/lib/db';
import { areaMatches, deriveStatus, sortHallItems, yearSelection, type HallSortDir, type HallSortKey, type HallStatus } from '@/lib/recommend';
import { SortArrows } from './sort-arrows';
import { useLoadMore } from './use-load-more';

const AREAS = ['全部', '日本', '韩国', '大陆', '国产', '欧美', '美国', '香港', '台湾', '泰国'];
const YEARS = ['全部', '2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2015-2018', '2010-2014', '2000年代', '90年代', '更早'];

/**
 * 成人片库。分类、年份、地区、完结都来自已启用的成人采集站，不走豆瓣。
 * 豆瓣没有这些分类；采集站的 remarks 才写着「完结」或「更新至」。
 */
export function AdultLibrary({ onOpen }: { onOpen: (item: SearchResultItem) => void }) {
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);

  const allAdult = useMemo(
    () => [...customAPIs, ...envSources].filter((s) => sourceIsAdult(s)),
    [customAPIs, envSources]
  );
  const sources = useMemo(() => {
    const selected = new Set(selectedKeys);
    return allAdult.filter((s) => selected.has(s.key));
  }, [allAdult, selectedKeys]);

  const [sourceKey, setSourceKey] = useState('');
  const [typeId, setTypeId] = useState('all');
  const [area, setArea] = useState('全部');
  const [year, setYear] = useState('全部');
  const [status, setStatus] = useState<HallStatus>('all');
  const [sortKey, setSortKey] = useState<HallSortKey>('date');
  const [sortDir, setSortDir] = useState<HallSortDir>('desc');

  const active = sources.find((s) => s.key === sourceKey) ?? sources[0];

  useEffect(() => {
    setTypeId('all');
  }, [active?.key]);

  const yearPick = yearSelection(year);
  const apiYear = yearPick.range && yearPick.range[0] === yearPick.range[1] ? String(yearPick.range[0]) : undefined;
  const apiArea = area !== '全部' && area !== '欧美' ? area : undefined;

  const browseQuery = useInfiniteQuery({
    queryKey: ['browse', active?.url, typeId, apiYear ?? '', apiArea ?? ''],
    queryFn: ({ pageParam, signal }) =>
      api.browse(
        {
          url: active!.url,
          t: typeId === 'all' ? undefined : typeId,
          year: apiYear,
          area: apiArea,
          page: pageParam,
        },
        signal
      ),
    initialPageParam: 1,
    getNextPageParam: (last) => {
      if (last.items.length === 0) return undefined;
      if (last.page >= last.pageCount) return undefined;
      return last.page + 1;
    },
    enabled: Boolean(active?.url),
    retry: 1,
  });
  const {
    data: browseData,
    hasNextPage,
    isFetching,
    isFetchingNextPage,
    isLoading,
    isError,
    fetchNextPage,
  } = browseQuery;

  const items = useMemo(() => {
    const nowYear = new Date().getFullYear();
    const range = yearSelection(year).range;
    const seen = new Set<string>();
    let list = browseData?.pages.flatMap((page) => page.items) ?? [];
    list = list.filter((item) => {
      if (seen.has(item.vodId)) return false;
      seen.add(item.vodId);
      if (range) {
        const y = parseInt(item.year ?? '', 10);
        if (!Number.isFinite(y) || y < range[0] || y > range[1]) return false;
      }
      if (area !== '全部' && item.area && !areaMatches(area, item.area)) return false;
      const play = deriveStatus({ episodesInfo: item.remarks, year: item.year }, nowYear);
      if (status === 'airing' && play !== 'airing') return false;
      if (status === 'ended' && play !== 'ended') return false;
      return true;
    });
    return sortHallItems(
      list.map((item) => ({ ...item, title: item.name })),
      sortKey,
      sortDir
    );
  }, [browseData, year, area, status, sortKey, sortDir]);

  const classes = browseData?.pages[0]?.classes ?? [];
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetching) void fetchNextPage();
  }, [hasNextPage, isFetching, fetchNextPage]);
  const sentinel = useLoadMore(sources.length > 0 && !!hasNextPage && !isFetching, browseData?.pages.length ?? 0, loadMore);

  const loadedPages = browseData?.pages.length ?? 0;
  useEffect(() => {
    if (sources.length === 0 || items.length > 0 || isError) return;
    if (!hasNextPage || isFetching || loadedPages >= 3) return;
    void fetchNextPage();
  }, [sources.length, items.length, hasNextPage, isFetching, isError, loadedPages, fetchNextPage]);

  if (sources.length === 0) {
    return (
      <div className="text-center py-12 space-y-2">
        <p className="text-sm text-muted">
          {allAdult.length === 0
            ? '还没有成人点播源。把黄色仓库、lsb、155、玉兔、souav、jkun、CK 加到设置里，就会出现在这里。'
            : '成人源已添加，但还没参与浏览。'}
        </p>
        {allAdult.length > 0 && (
          <button
            type="button"
            className="text-xs text-accent underline hover:opacity-80"
            onClick={() => useAppStore.getState().updateSettings({ yellowFilter: false })}
          >
            启用 {allAdult.length} 个成人源
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3.5">
      <div className="bg-surface/60 border border-line rounded-2xl p-3 sm:p-4 space-y-2.5 text-xs">
        {sources.length > 1 && (
          <FilterRow label="点播源">
            {sources.map((s) => (
              <FilterChip key={s.key} active={active?.key === s.key} onClick={() => setSourceKey(s.key)}>
                {s.name}
              </FilterChip>
            ))}
          </FilterRow>
        )}
        <FilterRow label="分类">
          <FilterChip active={typeId === 'all'} onClick={() => setTypeId('all')}>
            全部
          </FilterChip>
          {classes.map((cls) => (
            <FilterChip key={cls.id} active={typeId === cls.id} onClick={() => setTypeId(cls.id)}>
              {cls.name}
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
        <FilterRow label="状态">
          <FilterChip active={status === 'all'} onClick={() => setStatus('all')}>全部</FilterChip>
          <FilterChip active={status === 'airing'} onClick={() => setStatus('airing')}>连载中</FilterChip>
          <FilterChip active={status === 'ended'} onClick={() => setStatus('ended')}>已完结</FilterChip>
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

      {isError ? (
        <p className="text-center text-sm text-faint py-12">这个成人源的分类暂时拉不下来</p>
      ) : isLoading ? (
        <GridSkeleton />
      ) : items.length === 0 ? (
        <p className="text-center text-sm text-muted py-12">这个分类下没有符合筛选的片子</p>
      ) : (
        <>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5 sm:gap-3">
            {items.map((item) => (
              <DoubanCard
                key={`${active?.key}_${item.vodId}_${item.name}`}
                item={toCard(item, active)}
                onClick={() => active && onOpen(toPlayable(active, item))}
              />
            ))}
          </div>
          {hasNextPage && (
            <div ref={sentinel} className="py-6 text-center text-xs text-faint">
              {isFetchingNextPage ? '正在加载更多…' : '继续下滑'}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function toCard(item: VodListItem, source?: { key: string; name: string; url: string }) {
  const nowYear = new Date().getFullYear();
  const play = deriveStatus({ episodesInfo: item.remarks, year: item.year }, nowYear);
  const meta = [item.year, item.area].filter(Boolean).join(' · ');
  return {
    title: item.name,
    cover: item.pic || '',
    rating: item.rating,
    meta: meta || undefined,
    favorite: {
      id: favoriteIdOf({ sourceKey: source?.key, vodId: item.vodId, title: item.name }),
      title: item.name,
      pic: item.pic,
      sourceKey: source?.key,
      sourceUrl: source?.url,
      vodId: item.vodId,
      year: item.year,
      isAdult: true,
    },
    badge:
      play === 'ended'
        ? { text: '完结', tone: 'ok' as const }
        : play === 'airing'
          ? { text: '连载', tone: 'warn' as const }
          : undefined,
  };
}

function toPlayable(
  source: { key: string; name: string; url: string },
  item: VodListItem
): SearchResultItem {
  return {
    sourceKey: source.key,
    sourceName: source.name,
    sourceUrl: source.url,
    isAdult: true,
    vodId: item.vodId,
    name: item.name,
    pic: item.pic,
    typeName: item.typeName,
    year: item.year,
    area: item.area,
    remarks: item.remarks,
    rating: item.rating,
  };
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted shrink-0 w-12 font-medium pt-1">{label}</span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        'px-2.5 py-0.5 rounded-full text-xs transition-colors shrink-0',
        active ? 'bg-accent text-on-accent font-medium shadow-sm' : 'bg-chip text-muted hover:text-content hover:bg-hover'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
      {Array.from({ length: 12 }).map((_, i) => (
        <div key={i} className="animate-pulse">
          <div className="aspect-[2/3] rounded-lg bg-chip" />
          <div className="h-3.5 mt-2 rounded bg-chip w-3/4" />
        </div>
      ))}
    </div>
  );
}
