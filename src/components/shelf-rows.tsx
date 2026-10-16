'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { isAdultContent } from '@/lib/cms-parser';
import { favoriteIdOf } from '@/lib/db';
import { SHELF_DEFS, shelfItemKey, type ShelfChannel } from '@/lib/shelf-defs';
import { useAppStore } from '@/lib/store';
import { rememberDoubanItem } from '@/lib/taste-store';
import type { DoubanItem, TitlePick } from '@/lib/types';
import { ShelfRow } from './home-rows';
import { DoubanCard } from './video-card';

/** 一次放出几行；滚动到底部再放下一批，避免首屏同时打十几个上游 */
const BATCH = 3;
/** 一行至少要有几部才值得显示 */
const MIN_ITEMS = 4;
/** 去重后一行最多展示；展示出来的都算这一行占用，后面的行不再重复 */
const MAX_PER_SHELF = 40;

const CHANNEL_LABEL: Record<ShelfChannel, string> = {
  anime: '动漫',
  movie: '电影',
  tv: '电视剧',
  show: '综艺',
  doc: '纪录片',
};

/**
 * 首页货架（Netflix 式）：按固定顺序一行一行往下排。
 * 整页同一部作品只出现一次（含不同季度），TOP 10 综合总榜（也是大图的来源）和排在前面的行优先；
 * 数据取不到或去重后太少的行直接不显示，不留空壳。每行最后一格通往「浏览全部」的对应频道。
 * 点击后走搜索：有片源就能看，没有就显示「暂无片源」并可加入片单（首页不预先探测、不隐藏）。
 */
export function ShelfRows({
  onPick,
  onBrowse,
}: {
  onPick: (title: string, pick?: TitlePick) => void;
  onBrowse: (channel: ShelfChannel) => void;
}) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const [revealed, setRevealed] = useState(BATCH);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // 与大图 / TOP 10 共用同一份缓存，不会多发请求
  const topQuery = useQuery({
    queryKey: ['hot-list', 'realtime_all'],
    queryFn: ({ signal }) => api.hotList('realtime_all', signal),
    enabled: doubanEnabled,
    staleTime: 15 * 60_000,
    retry: 1,
  });

  const queries = useQueries({
    queries: SHELF_DEFS.map((def, idx) => ({
      queryKey: ['shelf', def.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.shelf(def.id, signal),
      enabled: doubanEnabled && idx < revealed,
      staleTime: 15 * 60_000,
      retry: 1,
    })),
  });

  // TOP 10 落地前先不排货架，否则它回来时货架里的卡片会突然消失
  const topPending = topQuery.isLoading;

  // TOP 10 和前面行已用掉的作品，后面的行不再重复
  const shelves = useMemo(() => {
    const seen = new Set<string>((topQuery.data?.items ?? []).slice(0, 10).map(shelfItemKey));
    return SHELF_DEFS.map((def, idx) => {
      const q = queries[idx];
      const items: DoubanItem[] = [];
      const own = new Set<string>();
      for (const item of q.data?.items ?? []) {
        if (yellowFilter && isAdultContent(item.title)) continue;
        const key = shelfItemKey(item);
        if (!key || seen.has(key) || own.has(key)) continue;
        own.add(key);
        items.push(item);
        if (items.length >= MAX_PER_SHELF) break;
      }
      // 只有真正展示的行才占用
      const show = items.length >= MIN_ITEMS;
      if (show) for (const key of own) seen.add(key);
      return {
        def,
        items: show ? items : [],
        loading: q.isLoading || topPending,
        failed: q.isError,
        requested: idx < revealed,
      };
    });
  }, [queries, yellowFilter, revealed, topQuery.data, topPending]);

  const allRevealed = revealed >= SHELF_DEFS.length;
  const settledCount = shelves.filter((s) => s.requested && !s.loading).length;
  const requestedCount = shelves.filter((s) => s.requested).length;

  useEffect(() => {
    if (allRevealed) return;
    // 用滚动位置判断而不是 IntersectionObserver：后台 / 被遮挡的页面里后者可能一直不回调，后面的行就永远出不来
    const check = () => {
      const el = sentinelRef.current;
      if (!el || settledCount < requestedCount) return; // 上一批都落地了才放下一批，保证去重顺序稳定
      if (el.getBoundingClientRect().top < window.innerHeight + 600) {
        setRevealed((n) => Math.min(SHELF_DEFS.length, n + BATCH));
      }
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    window.addEventListener('resize', check);
    return () => {
      window.removeEventListener('scroll', check);
      window.removeEventListener('resize', check);
    };
  }, [allRevealed, settledCount, requestedCount]);

  if (!doubanEnabled) return null;

  return (
    <div className="space-y-7">
      {shelves.map(({ def, items, loading, requested }) => {
        if (!requested) return null;
        if (loading) {
          return (
            <ShelfRow key={def.id} title={def.title} hint={def.hint}>
              {Array.from({ length: 7 }).map((_, i) => (
                <div key={i} className="w-[7.25rem] sm:w-32 shrink-0 aspect-[2/3] rounded-xl bg-chip animate-pulse" />
              ))}
            </ShelfRow>
          );
        }
        if (items.length === 0) return null;
        return (
          <ShelfRow key={def.id} title={def.title} hint={def.hint}>
            {items.map((item) => (
              <div key={`${item.id}_${item.title}`} className="w-[7.25rem] sm:w-32 shrink-0">
                <DoubanCard
                  item={{
                    title: item.title,
                    cover: item.cover,
                    rating: item.rating,
                    meta: [item.year, item.area].filter(Boolean).join(' · ') || undefined,
                    favorite: {
                      localId: favoriteIdOf({ title: item.title }),
                      title: item.title,
                      pic: item.cover,
                      year: item.year,
                    },
                    badge:
                      item.status === 'airing'
                        ? { text: item.remarks && /更新至/.test(item.remarks) ? item.remarks.replace('更新至', '更至') : '连载', tone: 'warn' }
                        : item.status === 'ended'
                          ? { text: '完结', tone: 'ok' }
                          : undefined,
                  }}
                  onClick={() => {
                    void rememberDoubanItem(item, def.channel);
                    onPick(item.title, item);
                  }}
                  onFavorite={() => {
                    void rememberDoubanItem(item, def.channel);
                  }}
                />
              </div>
            ))}
            <button
              type="button"
              onClick={() => onBrowse(def.channel)}
              className="w-[7.25rem] sm:w-32 shrink-0 aspect-[2/3] rounded-xl border border-dashed border-line bg-surface/60 text-muted hover:text-content hover:bg-hover hover:border-accent/50 transition-colors flex flex-col items-center justify-center gap-2 cursor-pointer"
            >
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span className="text-xs font-medium">浏览全部{CHANNEL_LABEL[def.channel]}</span>
              <span className="text-[10px] text-faint">按题材 / 地区 / 年份筛选</span>
            </button>
          </ShelfRow>
        );
      })}
      {!allRevealed && <div ref={sentinelRef} className="h-10" aria-hidden />}
    </div>
  );
}
