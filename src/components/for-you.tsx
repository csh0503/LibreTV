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
import { assembleTaste, confidenceOf, mergeSimilar, rankTaste, signalWeight, type TasteChannel } from '@/lib/taste';
import { shelfDedupeKey } from '@/lib/shelf-defs';
import { rememberDoubanItem } from '@/lib/taste-store';
import { canonicalTitle } from '@/lib/title-aliases';
import type { DoubanItem, TitlePick } from '@/lib/types';
import { useProfile } from '@/lib/use-profile';
import { isNotInterested, useNotInterested } from '@/lib/not-interested';
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

  // 标了「不再推荐」的：不算口味，也不再推荐
  const notInterested = useNotInterested(profileId);

  const tasteInput = useMemo(() => {
    if (!history || !favorites || !tastes) return null;
    return {
      now: Date.now(),
      watches: history.filter((row) => !isNotInterested(notInterested, row.title)).map((row) => ({
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
  }, [history, favorites, tastes, notInterested]);

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

  // —— 「看过这部的人也喜欢」：你最喜欢的几部（看得深、看完、收藏，越近越重）各取豆瓣相似推荐 ——
  // 「因为你看过《某某》」直接用它的相似推荐；「为你推荐」把几部的相似推荐合起来（被几部同时推荐、名次靠前的优先），
  // 不够再用按题材召回的补。比按题材要「同题材高分」准得多。
  const anchors = useMemo(() => {
    const events = assembled?.events ?? [];
    const lookup = new Map<string, { doubanId?: string; isTv?: boolean; year?: string }>();
    for (const row of history ?? []) {
      const key = canonicalTitle(row.title);
      if (key && !lookup.has(key)) lookup.set(key, { doubanId: row.tasteDoubanId, isTv: row.totalEpisodes > 1 ? true : undefined, year: row.tasteYear });
    }
    for (const row of favorites ?? []) {
      const key = canonicalTitle(row.title);
      const prev = lookup.get(key);
      if (key) lookup.set(key, { doubanId: prev?.doubanId || row.tasteDoubanId, isTv: prev?.isTv, year: prev?.year || row.year || row.tasteYear });
    }
    const now = Date.now();
    const ranked = events
      .filter((e) => signalWeight(e) > 0.5 && !isNotInterested(notInterested, e.title))
      .map((e) => ({ title: e.title, weight: confidenceOf(e, now), year: e.year }))
      .sort((a, b) => b.weight - a.weight);
    // 「因为你看过」的那部排第一个（它的相似推荐单独成一行）
    const main = assembled?.anchorTitle ?? singleFallback?.anchorTitle;
    if (main) {
      const at = ranked.findIndex((r) => canonicalTitle(r.title) === canonicalTitle(main));
      if (at > 0) ranked.unshift(...ranked.splice(at, 1));
      else if (at < 0) ranked.unshift({ title: main, weight: 1, year: undefined });
    }
    return ranked.slice(0, 3).map((r) => {
      const meta = lookup.get(canonicalTitle(r.title));
      return { ...r, doubanId: meta?.doubanId, kind: meta?.isTv ? ('tv' as const) : undefined, year: r.year || meta?.year };
    });
  }, [assembled, singleFallback, history, favorites, notInterested]);
  const similarQueries = useQueries({
    queries: anchors.map((a) => ({
      queryKey: ['similar', a.title, a.year, a.kind, a.doubanId],
      queryFn: ({ signal }: { signal: AbortSignal }) => api.similar({ title: a.title, year: a.year, kind: a.kind, doubanId: a.doubanId }, signal),
      enabled: Boolean(doubanEnabled && profileId),
      staleTime: 6 * 3600_000,
      retry: 0,
    })),
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

  const waiting =
    (queries.length > 0 && queries.some((query) => query.isPending)) ||
    similarQueries.some((query) => query.isPending && query.fetchStatus !== 'idle');
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


  const seriesKeyOf = (item: DoubanItem) => shelfDedupeKey(item.title, item.isTv);
  const similarLists = anchors.map((a, i) => ({ weight: a.weight, items: similarQueries[i]?.data?.items ?? [] }));
  /** 「因为你看过」：主锚点的相似推荐够 4 部就用它，不然退回按题材召回的 */
  const becauseFrom = (blocked: Set<string>, fallback: DoubanItem[]) => {
    const own = mergeSimilar(similarLists.slice(0, 1), { blocked, seriesKeyOf, hideAdult: yellowFilter, limit: 12 });
    return own.length >= 4 ? own : fallback;
  };

  if (assembled) {
    const ranked = rankTaste({
      events: assembled.events,
      userPool,
      anchorPool,
      anchorTitle: assembled.anchorTitle,
      blocked: [...assembled.blocked, ...notInterested],
      now: Date.now(),
      hideAdult: yellowFilter,
      channelOf: (item) => channels.get(item.id),
    });
    const blockedSet = new Set(
      [...assembled.blocked, ...notInterested].map((t) => canonicalTitle(t)).filter(Boolean),
    );
    const because = assembled.anchorTitle ? becauseFrom(blockedSet, ranked.because) : [];
    // 「为你推荐」：几部的相似推荐投票合并，不和下一排重复；不够 18 部用按题材召回的补
    const taken = new Set(because.map((item) => canonicalTitle(item.title)));
    const voted = mergeSimilar(similarLists, {
      blocked: new Set([...blockedSet, ...taken]),
      seriesKeyOf,
      hideAdult: yellowFilter,
      limit: 18,
    });
    const forYou = [...voted];
    const have = new Set([...taken, ...voted.map((item) => canonicalTitle(item.title))]);
    for (const item of ranked.forYou) {
      if (forYou.length >= 18) break;
      const key = canonicalTitle(item.title);
      if (!key || have.has(key)) continue;
      have.add(key);
      forYou.push(item);
    }
    if (forYou.length === 0 && because.length === 0) {
      return null;
    }

    return (
      <>
        {forYou.length > 0 && (
          <TasteRow
            title="为你推荐"
            items={forYou}
            onOpen={(item) => open(item, channels.get(item.id))}
            onFavorite={(item) => {
              void rememberDoubanItem(item, channels.get(item.id));
            }}
          />
        )}
        {because.length > 0 && assembled.anchorTitle && (
          <TasteRow
            title={`因为你${assembled.anchorReason}《${assembled.anchorTitle}》`}
            items={because}
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
    const blockedSet = new Set([...singleFallback.blocked.map((t) => canonicalTitle(t)).filter(Boolean), ...notInterested]);
    const singleItems = anchorPool
      .filter((item) => {
        if (yellowFilter && (isAdultContent(item.title) || isAdultContent(item.genres) || isAdultContent(item.remarks))) {
          return false;
        }
        const key = canonicalTitle(item.title);
        return Boolean(key && !blockedSet.has(key));
      })
      .slice(0, 12);
    const items = becauseFrom(blockedSet, singleItems);

    if (items.length === 0) return null;

    return (
      <TasteRow
        title={`因为你${singleFallback.anchorReason}《${singleFallback.anchorTitle}》`}
        items={items}
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
