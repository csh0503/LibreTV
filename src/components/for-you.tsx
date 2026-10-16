'use client';

import { useMemo } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { api } from '@/lib/client-api';
import { isAdultContent } from '@/lib/cms-parser';
import { db, favoriteIdOf } from '@/lib/db';
import { buildSingleAnchorFallback } from '@/lib/home-features';
import { buildDoubanRequest, HALL_PAGE_SIZE, reconcileStatusWithCalendar } from '@/lib/recommend';
import { useAppStore } from '@/lib/store';
import { assembleTaste, rankTaste, type TasteChannel } from '@/lib/taste';
import { rememberDoubanItem } from '@/lib/taste-store';
import { canonicalTitle } from '@/lib/title-aliases';
import type { DoubanItem, TitlePick } from '@/lib/types';
import { useProfile } from '@/lib/use-profile';
import { ShelfRow } from './home-rows';
import { DoubanCard } from './video-card';

/** 首页口味排：「为你推荐」与「因为你看过《某某》」。 */
export function ForYouRows({ onPick }: { onPick: (title: string, pick?: TitlePick) => void }) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const profileId = useProfile().id;
  const history = useLiveQuery(
    () => (profileId ? db.history.where('profileId').equals(profileId).toArray() : []),
    [profileId],
  );
  const favorites = useLiveQuery(
    () => (profileId ? db.favorites.where('profileId').equals(profileId).toArray() : []),
    [profileId],
  );
  const tastes = useLiveQuery(
    () => (profileId ? db.tastes.where('profileId').equals(profileId).toArray() : []),
    [profileId],
  );

  const tasteInput = useMemo(() => {
    if (!history || !favorites || !tastes) return null;
    return {
      now: Date.now(),
      watches: history.map((row) => ({
        title: row.title,
        playbackPosition: row.playbackPosition,
        duration: row.duration,
        episodeIndex: row.episodeIndex,
        totalEpisodes: row.totalEpisodes,
        timestamp: row.timestamp,
        genres: row.tasteGenres,
        area: row.tasteArea,
        year: row.tasteYear,
        channel: row.tasteChannel,
      })),
      saves: favorites.map((row) => ({
        title: row.title,
        addedAt: row.addedAt,
        genres: row.tasteGenres,
        area: row.tasteArea,
        year: row.tasteYear,
        channel: row.tasteChannel,
      })),
      metas: tastes.map((row) => ({
        title: row.title,
        genres: row.genres,
        area: row.area,
        year: row.year,
        channel: row.channel,
      })),
    };
  }, [history, favorites, tastes]);

  const assembled = useMemo(() => {
    if (!tasteInput) return null;
    return assembleTaste(tasteInput);
  }, [tasteInput]);

  // 单部兜底：刚看过 1 部有题材的片子时，立刻能展示「因为你看过《某某》」
  const singleFallback = useMemo(() => {
    if (assembled || !tasteInput) return null;
    return buildSingleAnchorFallback(tasteInput);
  }, [assembled, tasteInput]);

  const jobs = useMemo(() => {
    if (assembled) return assembled.jobs;
    if (singleFallback) {
      return [
        {
          selection: singleFallback.selection,
          pageStart: 0,
          forUser: false,
          forAnchor: true,
        },
      ];
    }
    return [];
  }, [assembled, singleFallback]);

  const queries = useQueries({
    queries: jobs.map((job) => {
      const request = buildDoubanRequest(job.selection);
      return {
        queryKey: ['for-you', profileId, request?.kind, request?.tags.join(','), request?.sort, job.pageStart],
        enabled: Boolean(doubanEnabled && profileId && request),
        staleTime: 10 * 60 * 1000,
        retry: 1,
        queryFn: ({ signal }: { signal: AbortSignal }) =>
          api.douban(
            {
              kind: request!.kind,
              tags: request!.tags,
              sort: request!.sort,
              score: request!.score,
              pageStart: job.pageStart,
              pageSize: HALL_PAGE_SIZE,
            },
            signal,
          ),
      };
    }),
  });

  const bangumiQuery = useQuery({
    queryKey: ['bangumi-calendar'],
    queryFn: ({ signal }) => api.bangumiCalendar(signal),
    enabled: doubanEnabled,
  });

  if (!doubanEnabled || !profileId || !history || !favorites || !tastes) return null;

  const open = (item: DoubanItem, channel?: TasteChannel) => {
    void rememberDoubanItem(item, channel);
    onPick(item.title, item);
  };

  if (!assembled && !singleFallback) {
    return null;
  }

  const waiting = queries.length > 0 && queries.some((query) => query.isPending);
  if (waiting) {
    return (
      <section aria-label="为你推荐加载中" className="space-y-2.5">
        <div className="h-5 w-40 rounded bg-chip animate-pulse" />
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 8 }).map((_, index) => (
            <div key={index} className="w-[7.25rem] sm:w-32 shrink-0">
              <div className="aspect-[2/3] rounded-xl bg-chip animate-pulse" />
              <div className="mt-2 h-3 w-3/4 rounded bg-chip animate-pulse" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  const nowYear = new Date().getFullYear();
  const calendarItems = bangumiQuery.data?.days.flatMap((d) => d.items) ?? [];
  const userPool: DoubanItem[] = [];
  const anchorPool: DoubanItem[] = [];
  const channels = new Map<string, TasteChannel>();
  jobs.forEach((job, index) => {
    const channel = job.selection.channel === 'adult' ? undefined : job.selection.channel;
    const rawItems = queries[index]?.data?.items ?? [];
    const items =
      channel === 'anime' ? reconcileStatusWithCalendar(rawItems, calendarItems, nowYear) : rawItems;
    for (const item of items) {
      if (channel && !channels.has(item.id)) channels.set(item.id, channel);
      if (job.forUser) userPool.push(item);
      if (job.forAnchor) anchorPool.push(item);
    }
  });

  if (assembled) {
    const ranked = rankTaste({
      events: assembled.events,
      userPool,
      anchorPool,
      anchorTitle: assembled.anchorTitle,
      blocked: assembled.blocked,
      now: Date.now(),
      hideAdult: yellowFilter,
      channelOf: (item) => channels.get(item.id),
    });
    if (ranked.forYou.length === 0 && ranked.because.length === 0) {
      return null;
    }

    return (
      <>
        {ranked.forYou.length > 0 && (
          <TasteRow
            title="为你推荐"
            items={ranked.forYou}
            onOpen={(item) => open(item, channels.get(item.id))}
            onFavorite={(item) => {
              void rememberDoubanItem(item, channels.get(item.id));
            }}
          />
        )}
        {ranked.because.length > 0 && assembled.anchorTitle && (
          <TasteRow
            title={`因为你${assembled.anchorReason}《${assembled.anchorTitle}》`}
            items={ranked.because}
            onOpen={(item) => open(item, channels.get(item.id))}
            onFavorite={(item) => {
              void rememberDoubanItem(item, channels.get(item.id));
            }}
          />
        )}
      </>
    );
  }

  if (singleFallback) {
    const blockedSet = new Set(singleFallback.blocked.map((t) => canonicalTitle(t)).filter(Boolean));
    const singleItems = anchorPool
      .filter((item) => {
        if (yellowFilter && (isAdultContent(item.title) || isAdultContent(item.genres) || isAdultContent(item.remarks))) {
          return false;
        }
        const key = canonicalTitle(item.title);
        return Boolean(key && !blockedSet.has(key));
      })
      .slice(0, 12);

    if (singleItems.length === 0) return null;

    return (
      <TasteRow
        title={`因为你${singleFallback.anchorReason}《${singleFallback.anchorTitle}》`}
        items={singleItems}
        onOpen={(item) => open(item, channels.get(item.id))}
        onFavorite={(item) => {
          void rememberDoubanItem(item, channels.get(item.id));
        }}
      />
    );
  }

  return null;
}

function TasteRow({
  title,
  items,
  onOpen,
  onFavorite,
}: {
  title: string;
  items: DoubanItem[];
  onOpen: (item: DoubanItem) => void;
  onFavorite: (item: DoubanItem) => void;
}) {
  return (
    <ShelfRow title={title}>
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
                item.status === 'ended'
                  ? { text: '完结', tone: 'ok' }
                  : item.status === 'airing'
                    ? { text: '连载', tone: 'warn' }
                    : undefined,
            }}
            onClick={() => onOpen(item)}
            onFavorite={() => onFavorite(item)}
          />
        </div>
      ))}
    </ShelfRow>
  );
}
