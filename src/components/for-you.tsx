'use client';

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { api } from '@/lib/client-api';
import { db, favoriteIdOf } from '@/lib/db';
import { useAppStore } from '@/lib/store';
import { useProfile } from '@/lib/use-profile';
import { assembleTaste, rankTaste, type TasteChannel } from '@/lib/taste';
import { rememberDoubanItem } from '@/lib/taste-store';
import { buildDoubanRequest, HALL_PAGE_SIZE } from '@/lib/recommend';
import type { DoubanItem } from '@/lib/types';
import { DoubanCard } from './video-card';

/** 首页最上面两行：这个设定档的口味，以及「因为你看过」。冷启动时不占位置。 */
export function ForYouRows({ onPick }: { onPick: (title: string) => void }) {
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
  const assembled = useMemo(() => {
    if (!history || !favorites || !tastes) return null;
    return assembleTaste({
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
    });
  }, [history, favorites, tastes]);
  const jobs = assembled?.jobs ?? [];
  const queries = useQueries({
    queries: jobs.map((job) => {
      const request = buildDoubanRequest(job.selection);
      return {
        queryKey: ['for-you', profileId, request?.kind, request?.tags.join(','), request?.sort, job.pageStart],
        enabled: Boolean(doubanEnabled && profileId && request),
        staleTime: 10 * 60 * 1000,
        retry: 1,
        queryFn: ({ signal }: { signal: AbortSignal }) => api.douban({
          kind: request!.kind,
          tags: request!.tags,
          sort: request!.sort,
          score: request!.score,
          pageStart: job.pageStart,
          pageSize: HALL_PAGE_SIZE,
        }, signal),
      };
    }),
  });

  if (!doubanEnabled || !profileId || !history || !favorites || !tastes) return null;

  const open = (item: DoubanItem, channel?: TasteChannel) => {
    void rememberDoubanItem(item, channel);
    onPick(item.title);
  };

  if (!assembled) {
    if (history.length + favorites.length < 2) return null;
    return (
      <p className="mb-6 text-xs text-faint">
        从下面的大厅点开几部片子后，会按这个设定档的口味推荐。以前看过的，要在大厅里再遇到同一部，才会记上题材。
      </p>
    );
  }

  const waiting = queries.length > 0 && queries.some((query) => query.isPending);
  if (waiting) {
    return (
      <section aria-label="为你推荐" className="mb-8 space-y-2">
        <h2 className="text-sm font-semibold text-content">为你推荐</h2>
        <div className="flex gap-2.5 overflow-hidden">
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

  const userPool: DoubanItem[] = [];
  const anchorPool: DoubanItem[] = [];
  const channels = new Map<string, TasteChannel>();
  jobs.forEach((job, index) => {
    const channel = job.selection.channel === 'adult' ? undefined : job.selection.channel;
    for (const item of queries[index]?.data?.items ?? []) {
      if (channel && !channels.has(item.id)) channels.set(item.id, channel);
      if (job.forUser) userPool.push(item);
      if (job.forAnchor) anchorPool.push(item);
    }
  });
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
    if (queries.length > 0 && queries.every((query) => query.isError)) {
      return <p className="mb-6 text-xs text-faint">按你的口味找片子失败了，下面的大厅还能继续看。</p>;
    }
    return null;
  }

  return (
    <div className="mb-8 space-y-6">
      {ranked.forYou.length > 0 && (
        <TasteRow
          title="为你推荐"
          hint="只按这个设定档看完、收藏和弃掉的片子来排"
          items={ranked.forYou}
          onOpen={(item) => open(item, channels.get(item.id))}
          onFavorite={(item) => { void rememberDoubanItem(item, channels.get(item.id)); }}
        />
      )}
      {ranked.because.length > 0 && assembled.anchorTitle && (
        <TasteRow
          title={`因为你${assembled.anchorReason}《${assembled.anchorTitle}》`}
          items={ranked.because}
          onOpen={(item) => open(item, channels.get(item.id))}
          onFavorite={(item) => { void rememberDoubanItem(item, channels.get(item.id)); }}
        />
      )}
    </div>
  );
}

function TasteRow({
  title,
  hint,
  items,
  onOpen,
  onFavorite,
}: {
  title: string;
  hint?: string;
  items: DoubanItem[];
  onOpen: (item: DoubanItem) => void;
  onFavorite: (item: DoubanItem) => void;
}) {
  return (
    <section aria-label={title} className="space-y-2">
      <div>
        <h2 className="text-sm font-semibold text-content line-clamp-2">{title}</h2>
        {hint && <p className="text-xs text-faint mt-0.5">{hint}</p>}
      </div>
      <div className="flex gap-2.5 overflow-x-auto pb-1">
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
                badge: item.status === 'ended'
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
      </div>
    </section>
  );
}
