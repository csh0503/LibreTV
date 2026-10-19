'use client';

import { Suspense, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Header } from '@/components/header';
import { SiteFooter } from '@/components/site-footer';
import { SmartImage } from '@/components/smart-image';
import { useTitleFlow } from '@/components/title-flow';
import { api } from '@/lib/client-api';
import { isAdultContent } from '@/lib/cms-parser';
import type { HotListId } from '@/lib/douban-weekly';
import { rememberDoubanItem } from '@/lib/taste-store';
import { useAppStore } from '@/lib/store';
import type { DoubanItem } from '@/lib/types';
import { cn } from '@/lib/utils';

/** 每张榜：用的就是首页 TOP 10 那几份多源融合热榜（同一份缓存） */
const BOARDS: { id: string; list: HotListId; label: string; short: string }[] = [
  { id: 'all', list: 'realtime_all', label: '综合 · 全网实时', short: '综合' },
  { id: 'tv', list: 'douban_tv_realtime', label: '电视剧 · 本周热门', short: '电视剧' },
  { id: 'movie', list: 'douban_movie_realtime', label: '电影 · 本周热门', short: '电影' },
  { id: 'anime', list: 'bili_bangumi', label: '日漫 · 当季热播', short: '日漫' },
  { id: 'guoman', list: 'bili_guochuang', label: '国漫 · 本周热播', short: '国漫' },
  { id: 'show', list: 'douban_show_hot', label: '综艺 · 本周热门', short: '综艺' },
  { id: 'cn', list: 'douban_tv_domestic', label: '国产剧 · 热播', short: '国产剧' },
  { id: 'kr', list: 'douban_tv_korean', label: '日韩剧 · 热播', short: '日韩剧' },
  { id: 'us', list: 'douban_tv_american', label: '欧美剧 · 热播', short: '欧美剧' },
  { id: 'doc', list: 'bili_doc', label: '纪录片 · 热播', short: '纪录片' },
];

/** 「全部榜单」那页每张榜放几名；单张榜的页面放全部 */
const OVERVIEW_SIZE = 10;

export default function RankPage() {
  return (
    <Suspense>
      <RankContent />
    </Suspense>
  );
}

function RankContent() {
  const params = useSearchParams();
  const router = useRouter();
  const tab = BOARDS.some((b) => b.id === params.get('board')) ? params.get('board')! : 'overview';
  const { pickTitle, modals } = useTitleFlow();
  const open = (item: DoubanItem) => {
    void rememberDoubanItem(item);
    pickTitle(item.title, item);
  };
  const go = (id: string) => router.replace(id === 'overview' ? '/rank' : `/rank?board=${id}`, { scroll: false });
  const board = BOARDS.find((b) => b.id === tab);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6 space-y-6">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-content">排行榜</h1>
          <div role="tablist" aria-label="榜单" className="flex items-center gap-0.5 p-1 rounded-full bg-content/[0.06] ring-1 ring-inset ring-content/[0.06] overflow-x-auto scrollbar-none max-w-full">
            <Tab active={tab === 'overview'} onClick={() => go('overview')}>全部榜单</Tab>
            {BOARDS.map((b) => (
              <Tab key={b.id} active={tab === b.id} onClick={() => go(b.id)}>{b.short}</Tab>
            ))}
          </div>
        </div>

        {board ? (
          <BoardPanel board={board} limit={50} columns onOpen={open} />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {BOARDS.map((b) => (
              <BoardPanel key={b.id} board={b} limit={OVERVIEW_SIZE} onOpen={open} onMore={() => go(b.id)} />
            ))}
          </div>
        )}
      </main>
      <SiteFooter />
      {modals}
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'shrink-0 px-3.5 py-1.5 rounded-full text-[13px] font-medium transition-all duration-200 cursor-pointer',
        active
          ? 'bg-surface-raised text-content shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_0.5px_rgba(0,0,0,0.06)]'
          : 'text-muted hover:text-content',
      )}
    >
      {children}
    </button>
  );
}

function BoardPanel({
  board,
  limit,
  columns = false,
  onOpen,
  onMore,
}: {
  board: (typeof BOARDS)[number];
  limit: number;
  /** 单张榜整页：桌面上排成两列 */
  columns?: boolean;
  onOpen: (item: DoubanItem) => void;
  onMore?: () => void;
}) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const query = useQuery({
    // 和首页 TOP 10 同一个缓存键：已经看过的榜不用再请求
    queryKey: ['hot-list', board.list],
    queryFn: ({ signal }) => api.hotList(board.list, signal),
    enabled: doubanEnabled,
    staleTime: 15 * 60_000,
    retry: 1,
  });
  const items = useMemo(
    () =>
      (query.data?.items ?? [])
        .filter((item) => !yellowFilter || (!isAdultContent(item.title) && !isAdultContent(item.genres)))
        .slice(0, limit),
    [query.data, yellowFilter, limit],
  );
  const updatedAt = query.data?.meta?.updatedAt;

  return (
    <section
      aria-label={board.label}
      className="rounded-2xl bg-content/[0.03] ring-1 ring-inset ring-content/[0.06] p-3 sm:p-4"
    >
      <header className="flex items-center justify-between gap-2 px-1 pb-2">
        <h2 className="flex items-center gap-2 text-[15px] font-semibold text-content tracking-tight">
          <span aria-hidden className="w-[3px] h-4 rounded-full bg-accent" />
          {board.label}
        </h2>
        <div className="flex items-center gap-2 text-[11px] text-faint">
          {updatedAt && <span className="tabular-nums">{clock(updatedAt)} 更新</span>}
          {onMore && (
            <button type="button" onClick={onMore} className="inline-flex items-center gap-0.5 text-muted hover:text-content cursor-pointer">
              更多
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" aria-hidden="true">
                <path d="M9 6l6 6-6 6" />
              </svg>
            </button>
          )}
        </div>
      </header>

      {query.isLoading ? (
        <ol className={cn(columns && 'md:grid md:grid-cols-2 md:gap-x-6')}>
          {Array.from({ length: Math.min(limit, 10) }).map((_, i) => (
            <li key={i} className="flex items-center gap-3 px-1 py-2">
              <div className="w-6 h-4 rounded bg-chip animate-pulse" />
              <div className="w-11 h-[62px] rounded-md bg-chip animate-pulse" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 w-2/3 rounded bg-chip animate-pulse" />
                <div className="h-3 w-1/3 rounded bg-chip animate-pulse" />
              </div>
            </li>
          ))}
        </ol>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-sm text-faint">{query.isError ? '这张榜暂时取不到，稍后再试' : '暂无数据'}</p>
      ) : (
        <ol className={cn(columns && 'md:grid md:grid-cols-2 md:gap-x-6')}>
          {items.map((item, index) => (
            <RankRow key={`${item.id}_${item.title}`} item={item} rank={index + 1} onOpen={() => onOpen(item)} />
          ))}
        </ol>
      )}
    </section>
  );
}

function RankRow({ item, rank, onOpen }: { item: DoubanItem; rank: number; onOpen: () => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const progress = describeProgress(item);
  const sub = [progress, item.year, item.area?.split(/\s+/)[0]].filter(Boolean).join(' · ');
  return (
    <li className="border-b border-content/[0.06] last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        className="group w-full flex items-center gap-3 px-1 py-2 rounded-lg text-left hover:bg-content/[0.04] transition-colors cursor-pointer"
      >
        <span
          className={cn(
            'w-6 shrink-0 text-center tabular-nums font-semibold',
            rank <= 3 ? 'text-[17px] text-rating' : 'text-sm text-faint',
          )}
        >
          {rank}
        </span>
        <div className="relative w-11 h-[62px] shrink-0 rounded-md overflow-hidden bg-chip ring-1 ring-inset ring-content/[0.06]">
          {item.cover && (
            <SmartImage
              url={item.cover}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt=""
              className="w-full h-full object-cover"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium text-content truncate group-hover:text-content">{item.title}</div>
          {sub && <div className="mt-0.5 text-[12px] text-faint truncate">{sub}</div>}
        </div>
        <div className="shrink-0 flex flex-col items-end gap-0.5 text-[11px] tabular-nums">
          {item.rating && Number(item.rating) > 0 && <span className="text-muted">★ {item.rating}</span>}
          {item.rankNew ? (
            <span className="text-warning">新上榜</span>
          ) : item.rankDelta ? (
            <span className={item.rankDelta > 0 ? 'text-success' : 'text-faint'}>
              {item.rankDelta > 0 ? `↑${item.rankDelta}` : `↓${-item.rankDelta}`}
            </span>
          ) : null}
        </div>
      </button>
    </li>
  );
}

/** 「更新至 18 集」「全 24 集」「已完结」这种短说明；热度数字这种长的不放 */
function describeProgress(item: DoubanItem): string | undefined {
  const r = item.remarks?.trim();
  if (r && r.length <= 14 && /集|期|完结|更新|全/.test(r)) return r;
  if (item.status === 'airing') return '连载中';
  if (item.status === 'ended') return '已完结';
  return undefined;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
