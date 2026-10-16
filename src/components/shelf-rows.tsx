'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { isAdultContent } from '@/lib/cms-parser';
import { favoriteIdOf } from '@/lib/db';
import { SHELF_DEFS, shelfDedupeKey } from '@/lib/shelf-defs';
import { useAppStore } from '@/lib/store';
import { rememberDoubanItem } from '@/lib/taste-store';
import type { DoubanItem } from '@/lib/types';
import { ShelfRow } from './home-rows';
import { DoubanCard } from './video-card';

/** 一次放出几行；滚动到底部再放下一批，避免首屏同时打十几个上游 */
const BATCH = 3;
/** 一行至少要有几部才值得显示 */
const MIN_ITEMS = 4;
/** 去重后一行最多展示 */
const MAX_PER_SHELF = 20;

/**
 * 首页货架（Netflix 式）：按固定顺序一行一行往下排。
 * 整页同一部作品只出现一次（含不同季度），排在前面的行优先；
 * 数据取不到或去重后太少的行直接不显示，不留空壳。
 * 点击后走搜索：有片源就能看，没有就在搜索结果里提示。
 */
export function ShelfRows({ onPick }: { onPick: (title: string) => void }) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const [revealed, setRevealed] = useState(BATCH);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const queries = useQueries({
    queries: SHELF_DEFS.map((def, idx) => ({
      queryKey: ['shelf', def.id],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.shelf(def.id, signal),
      enabled: doubanEnabled && idx < revealed,
      staleTime: 15 * 60_000,
      retry: 1,
    })),
  });

  // 前面行已用掉的标题，后面的行不再重复
  const shelves = useMemo(() => {
    const seen = new Set<string>();
    return SHELF_DEFS.map((def, idx) => {
      const q = queries[idx];
      const items: DoubanItem[] = [];
      for (const item of q.data?.items ?? []) {
        if (yellowFilter && isAdultContent(item.title)) continue;
        const key = shelfDedupeKey(item.title);
        if (!key || seen.has(key)) continue;
        items.push(item);
        if (items.length >= MAX_PER_SHELF) break;
      }
      // 只有真正展示的行才占用标题
      const show = items.length >= MIN_ITEMS;
      if (show) for (const item of items) seen.add(shelfDedupeKey(item.title));
      return { def, items: show ? items : [], loading: q.isLoading, failed: q.isError, requested: idx < revealed };
    });
  }, [queries, yellowFilter, revealed]);

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
                    onPick(item.title);
                  }}
                  onFavorite={() => {
                    void rememberDoubanItem(item, def.channel);
                  }}
                />
              </div>
            ))}
          </ShelfRow>
        );
      })}
      {!allRevealed && <div ref={sentinelRef} className="h-10" aria-hidden />}
    </div>
  );
}
