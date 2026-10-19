'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { recallAlias } from '@/lib/alias-memory';
import { addSearchHistory, db, favoriteIdOf, toggleFavorite } from '@/lib/db';
import { loadListUpdates, markListUnavailable, saveListUpdates } from '@/lib/watchlist-updates';
import { describeContinueWatching } from '@/lib/home-features';
import { resolveSource, useAppStore } from '@/lib/store';
import { aggregateResults, canonicalTitle, matchingGroups, rankGroupsForPick, specificTitle, type AggregatedGroup } from '@/lib/title-aliases';
import type { SearchResultItem, TitlePick } from '@/lib/types';
import { useProfile } from '@/lib/use-profile';
import { buildWatchUrl, cn, formatTime } from '@/lib/utils';
import { EpisodeProgressBar, episodeProgressHint, useEpisodeProgress } from '@/components/episode-progress';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { Spinner } from './states';
import { useToast } from './toast';
import { useFocusTrap } from './use-focus-trap';
import { useAliasFallback, useSourceSearch, useTitleIdentity } from './use-source-search';
import { qualityKey, rankSources } from '@/lib/source-rank';
import { qualityLabel, type SourceQuality } from '@/lib/stream-quality';
import { QualityTag, useSourceQuality } from './use-source-quality';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { describeRatings } from '@/lib/catalog-meta';

/** 一组里最多直接列出几个源，其余折叠成「+N」 */
const SOURCES_PER_GROUP = 6;
/** 最多列出几组（各季 / 剧场版） */
const MAX_GROUPS = 6;

/**
 * 作品详情弹窗（Netflix 式「更多信息」）：首页任何一张卡片点开都先到这里。
 * 上半部分是作品本身（来自豆瓣 / TMDB / B站 / Bangumi 的元数据），下半部分是可看性：
 * 打开时才并发查所有点播源，列出这部作品（含各季）在哪些源能看；原名查不到时再用它的其他中文名
 * （TMDB 的港台译名、别名，转简体）依次查，都没有才说「暂无片源」并可加入片单。
 */
export function TitleModal({
  pick,
  presetItems,
  onClose,
  onOpenSource,
  onShowResults,
}: {
  pick: TitlePick | null;
  /** 搜索结果页点开时已经有这部的片源，直接用，不再搜一遍 */
  presetItems?: SearchResultItem[];
  onClose: () => void;
  /** 弹窗里取不到剧集时的退路：打开该源的选集弹窗 */
  onOpenSource: (item: SearchResultItem) => void;
  /** 去搜索结果页看全部（含名称相近的） */
  onShowResults: (title: string) => void;
}) {
  // 卡片就是 TMDB 的条目、而它的中文名和别的作品撞了（乐高特别篇也叫「航海王」）：用它更具体的名字
  const fromTmdb = Boolean(pick?.id?.startsWith('tmdb_'));
  const identity = useTitleIdentity(pick ?? { title: '' }, fromTmdb);
  // 只对 TMDB 自己的卡片换名字（别处打开时同一份查询缓存里也可能有数据，不能拿来用）
  const names = fromTmdb ? identity.data?.identity?.names : undefined;
  if (!pick) return null;
  const specific = names ? specificTitle(pick.title, names) : undefined;
  const effective = specific ? { ...pick, title: specific } : pick;
  // 换一部作品时整体重建，搜索、图片失败等状态不串
  return (
    <TitleModalBody
      key={effective.title}
      pick={effective}
      presetItems={presetItems}
      onClose={onClose}
      onOpenSource={onOpenSource}
      onShowResults={onShowResults}
    />
  );
}

function TitleModalBody({
  pick,
  presetItems,
  onClose,
  onOpenSource,
  onShowResults,
}: {
  pick: TitlePick;
  presetItems?: SearchResultItem[];
  onClose: () => void;
  onOpenSource: (item: SearchResultItem) => void;
  onShowResults: (title: string) => void;
}) {
  const router = useRouter();
  const { toast } = useToast();
  const profileId = useProfile().id;
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const panelRef = useRef<HTMLDivElement>(null);
  const [heroFailed, setHeroFailed] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);

  const live = useSourceSearch(pick.title, !presetItems);
  const { searchQuery, selectedSources, failures } = live;
  const list = presetItems ?? live.list;
  const settled = presetItems ? true : live.settled;
  const isSearching = presetItems ? false : live.isSearching;
  const groups = useMemo(() => aggregateResults(list, pick.title), [list, pick.title]);
  // 从搜索结果点开的就是这张卡本身（解说类等匹配不上的也照样列出来）
  const matched = useMemo(() => {
    const m = matchingGroups(groups, pick.title);
    return rankGroupsForPick(presetItems && m.length === 0 ? groups : m, pick);
  }, [groups, pick, presetItems]);
  const othersCount = groups.length - matched.length;

  // 原名全部源都没有 → 查这部作品的其他中文名，逐个再搜
  const primaryMissing = settled && matched.length === 0 && selectedSources.length > 0;
  const fallback = useAliasFallback(pick, primaryMissing);
  const aliasNames = fallback.names;
  /** 实际展示的片源：原名优先，没有就用别名找到的 */
  const aliasGroups = useMemo(
    () => rankGroupsForPick(fallback.groups, { ...pick, title: fallback.alias || pick.title }),
    [fallback.groups, fallback.alias, pick],
  );
  const shown = matched.length > 0 ? matched : aliasGroups;
  const foundVia = matched.length === 0 ? fallback.foundVia : undefined;
  const lookingUpAliases = fallback.lookingUp;
  const nothingFound = fallback.nothingFound;

  const localId = favoriteIdOf({ title: pick.title });
  const saved = useLiveQuery(
    () => (profileId ? db.favorites.get(`${profileId}::${localId}`) : undefined),
    [profileId, localId],
  );
  // 看过同一部（按标准片名）→ 主按钮变成「继续播放」
  // 看过的可能是用别名找到的那一版（大师计划 → 偷天父子兵），两个名字都算
  const history = useLiveQuery(async () => {
    const keys = new Set([pick.title, recallAlias(pick.title) ?? ''].map((t) => canonicalTitle(t)).filter(Boolean));
    if (!profileId || keys.size === 0) return undefined;
    const rows = await db.history.where('profileId').equals(profileId).toArray();
    return rows.filter((r) => keys.has(canonicalTitle(r.title))).sort((a, b) => b.timestamp - a.timestamp)[0];
  }, [profileId, pick.title]);
  const resumeView = history ? describeContinueWatching(history, undefined, formatTime) : undefined;

  useFocusTrap(true, panelRef);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const resume = () => {
    if (!history || !resumeView) return;
    const src = resolveSource({ customAPIs, envSources }, history.sourceKey, { url: history.sourceUrl });
    router.push(
      buildWatchUrl({
        sourceKey: history.sourceKey,
        vodId: history.vodId,
        index: resumeView.targetEpisodeIndex,
        position: resumeView.targetPosition,
        title: history.title,
        sourceUrl: src?.url || history.sourceUrl,
        detail: src?.detail,
      }),
    );
  };

  const toggleList = async () => {
    const on = await toggleFavorite({ localId, title: pick.title, pic: pick.cover, year: pick.year });
    // 搜完了一部都没有：之后搜到了在首页片单上标「上线了」
    if (on && nothingFound && profileId) saveListUpdates(profileId, markListUnavailable(loadListUpdates(profileId), localId));
    toast(on ? `已加入我的片单` : '已移出我的片单', 'success');
  };

  const noSourcesConfigured = selectedSources.length === 0;
  // 每组里的源按「最近没出错 → 集数多 → 响应快」排，「播放」用排第一的
  const sourceHealth = useAppStore((st) => st.sourceHealth);
  // 片源质检（在浏览器里做）：搜索结果一出来就开始测，每个源测完就更新
  const shownItemGroups = useMemo(() => shown.map((g) => g.items), [shown]);
  const searchDone = !isSearching && !lookingUpAliases;
  const { qualityMap } = useSourceQuality(shownItemGroups, shown.length > 0);
  const ranked = useMemo(
    () => shown.map((g) => ({ ...g, items: rankSources(g.items, sourceHealth, qualityMap) })),
    [shown, sourceHealth, qualityMap],
  );
  const best = ranked[0]?.items[0];

  // 选集：默认用推荐的源，点别的源就换成那个源的剧集
  const [selected, setSelected] = useState<SearchResultItem | null>(null);
  // 看过这部：默认用上次看的那个源（还在列表里的话），选集也是那个源的
  const lastWatched = useMemo(
    () =>
      history ? ranked.flatMap((g) => g.items).find((i) => i.sourceKey === history.sourceKey && i.vodId === history.vodId) : undefined,
    [history, ranked],
  );
  const current = selected ?? lastWatched ?? best;
  const currentSrc = current
    ? resolveSource({ customAPIs, envSources }, current.sourceKey, { url: current.sourceUrl })
    : undefined;
  const episodesQuery = useQuery({
    queryKey: ['detail-info', current?.sourceKey, current?.vodId],
    queryFn: ({ signal }) => api.detail(current!.vodId, currentSrc!, signal),
    enabled: Boolean(current && currentSrc) && searchDone,
    staleTime: 30 * 60_000,
    retry: 0,
  });
  const episodes = episodesQuery.data?.episodes ?? [];
  // 集数按列表位置算；源给的集名不可靠，只在鼠标停留时提示
  const episodeNames = episodesQuery.data?.episodeNames;
  const [reversed, setReversed] = useState(false);
  const episodeProgress = useEpisodeProgress(current?.sourceKey, current?.vodId);
  const watchedIndex =
    history && current && history.sourceKey === current.sourceKey && history.vodId === current.vodId
      ? history.episodeIndex
      : undefined;
  const playEpisode = (index: number) => {
    if (!current) return;
    addSearchHistory(current.name).catch(() => {});
    router.push(
      buildWatchUrl({ sourceKey: current.sourceKey, vodId: current.vodId, index, title: current.name, sourceUrl: current.sourceUrl }),
    );
  };

  const primary = (() => {
    if (history && resumeView) return { label: `继续播放 · ${resumeView.posterLabel}`, onClick: resume };
    if (best) {
      const q = qualityMap[qualityKey(best)];
      const tag = q?.ok && q.height ? ` · ${q.estimated ? '约' : ''}${qualityLabel(q.height)}` : '';
      // 剧集取到了就直接播第 1 集；还没取到 / 取不到时退回选集弹窗
      return {
        label: `播放${tag}`,
        onClick: () => (current && episodes.length > 0 ? playEpisode(0) : onOpenSource(current ?? best)),
      };
    }
    if (noSourcesConfigured) return { label: '先添加点播源', disabled: true };
    if (!settled || lookingUpAliases) return { label: '查找片源中…', disabled: true, busy: true };
    return { label: '暂无片源', disabled: true };
  })();

  const heroUrl = pick.backdrop || pick.cover;
  const hasBackdrop = Boolean(pick.backdrop) && !heroFailed;
  const meta = [pick.year, pick.area, pick.genres].filter(Boolean).join(' · ');
  const statusBadge =
    pick.status === 'airing'
      ? pick.remarks && /更新至/.test(pick.remarks)
        ? pick.remarks
        : '连载中'
      : pick.status === 'ended' && !pick.statusGuessed
        ? '已完结'
        : undefined;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/55 backdrop-blur-xl py-6 sm:py-10 px-3 sm:px-4 animate-fade-in"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`${pick.title} 详情`}
        className="relative bg-surface-raised rounded-[28px] w-full max-w-3xl shadow-[0_24px_80px_rgba(0,0,0,0.55)] ring-1 ring-content/10 overflow-hidden animate-slide-up outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="absolute top-3 right-3 z-20 w-9 h-9 rounded-full bg-black/40 backdrop-blur-xl border border-white/15 text-white hover:bg-black/60 flex items-center justify-center transition-colors"
        >
          <Icon name="close" className="w-5 h-5" />
        </button>

        {/* 大图：有横图用横图，没有就用海报虚化铺底 */}
        <div className="relative h-56 sm:h-72 bg-chip overflow-hidden">
          {heroUrl && !heroFailed && (
            <SmartImage
              url={heroUrl}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt=""
              loading="eager"
              className={cn(
                'absolute inset-0 w-full h-full object-cover',
                !hasBackdrop && 'scale-110 blur-2xl opacity-60',
              )}
              onExhausted={() => setHeroFailed(true)}
            />
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-surface-raised via-surface-raised/50 to-transparent" />
          <div className="absolute inset-x-0 bottom-0 p-5 sm:p-6 flex items-end gap-4">
            {!hasBackdrop && pick.cover && !posterFailed && (
              <SmartImage
                url={pick.cover}
                mode={imageProxyMode}
                customProxy={customImageProxy}
                alt={pick.title}
                loading="eager"
                className="hidden sm:block w-28 aspect-[2/3] object-cover rounded-2xl shadow-lg ring-1 ring-white/10 shrink-0"
                onExhausted={() => setPosterFailed(true)}
              />
            )}
            <div className="min-w-0 space-y-3">
              <h2 className="text-2xl sm:text-3xl font-bold text-content break-words drop-shadow">{pick.title}</h2>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={primary.onClick}
                  disabled={primary.disabled}
                  className="inline-flex items-center gap-2 px-6 py-2.5 rounded-full bg-content text-page font-semibold text-sm hover:bg-content/85 active:scale-[0.97] disabled:bg-content/25 disabled:text-content/70 disabled:cursor-default transition-colors"
                >
                  {primary.busy ? (
                    <Spinner size="sm" />
                  ) : (
                    !primary.disabled && (
                      <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                        <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11.04-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14Z" />
                      </svg>
                    )
                  )}
                  {primary.label}
                </button>
                <button
                  type="button"
                  onClick={() => void toggleList()}
                  aria-pressed={!!saved}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-content/[0.1] backdrop-blur-xl ring-1 ring-content/15 text-content text-sm font-medium hover:bg-content/[0.18] active:scale-[0.97] transition-all"
                >
                  <Icon name={saved ? 'check' : 'plus'} className="w-4 h-4" />
                  {saved ? '已在片单' : '我的片单'}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="p-5 sm:p-6 pt-3 space-y-5">
          {(pick.rating || meta || statusBadge) && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
              {pick.rating && (
                <span className="text-rating font-semibold" title={describeRatings(pick.ratings)}>
                  ★ {pick.rating}
                </span>
              )}
              {meta && <span className="text-muted">{meta}</span>}
              {statusBadge && (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-content/[0.08] text-[11px] font-medium text-content">
                  <span className={cn('w-1.5 h-1.5 rounded-full', pick.status === 'airing' ? 'bg-warning' : 'bg-success')} aria-hidden />
                  {statusBadge}
                </span>
              )}
            </div>
          )}
          <TitleSynopsisAndInfo pick={pick} best={best} enabled={searchDone} />

          <section aria-label="片源" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-[17px] font-semibold text-content">
                片源
                <span className="ml-2 text-xs font-normal text-faint">
                  {noSourcesConfigured
                    ? '尚未勾选点播源'
                    : isSearching
                      ? '正在查找…'
                      : shown.length > 0
                        ? foundVia
                          ? `按别名《${foundVia}》找到`
                          : ''
                        : lookingUpAliases
                          ? '正在查其他译名…'
                          : ''}
                </span>
              </h3>
              <button
                type="button"
                onClick={() => onShowResults(foundVia ?? pick.title)}
                className="text-xs text-accent hover:underline"
              >
                全部搜索结果{othersCount > 0 ? `（另有 ${othersCount} 部相近）` : ''}
              </button>
            </div>

            {noSourcesConfigured ? (
              <p className="text-sm text-muted">点击右上角「设置」添加并勾选点播源后，这里会列出能看的片源。</p>
            ) : shown.length > 0 ? (
              <ul className="space-y-2">
                {ranked.slice(0, MAX_GROUPS).map((g, gi) => (
                  <SourceGroupRow
                    key={g.key}
                    group={g}
                    onSelect={setSelected}
                    currentKey={current ? qualityKey(current) : undefined}
                    recommended={gi === 0}
                    quality={qualityMap}
                  />
                ))}
              </ul>
            ) : nothingFound ? (
              <div className="rounded-xl border border-dashed border-line px-4 py-4 text-sm text-muted leading-relaxed">
                <p className="font-medium text-content mb-1">暂无片源</p>
                点播源都还没有收录《{pick.title}》{aliasNames.length > 0 ? `（也按《${aliasNames.join('》《')}》查过）` : ''}。采集站通常会在播出后陆续收录，
                {saved ? '它已经在你的片单里，' : '可以先加入片单，'}之后在「我的片单」里点开会重新查找。
              </div>
            ) : (
              <div className="space-y-2" aria-hidden>
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="h-16 rounded-xl bg-chip animate-pulse" />
                ))}
              </div>
            )}

            {settled && failures.length > 0 && (
              <p className="text-xs text-warning">
                {failures.length} 个点播源没有响应，结果可能不完整。
                <button type="button" onClick={() => void searchQuery.refetch()} className="ml-2 underline">
                  重试
                </button>
              </p>
            )}
          </section>

          {current && (
            <section aria-label="选集" className="space-y-2.5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[17px] font-semibold text-content">
                  选集
                  <span className="ml-2 text-xs font-normal text-faint">
                    {current.sourceName}
                    {current.name !== pick.title ? ` · ${current.name}` : ''}
                  </span>
                </h3>
                {episodes.length > 1 && (
                  <button type="button" onClick={() => setReversed((v) => !v)} className="text-xs text-accent hover:underline">
                    {reversed ? '正序' : '倒序'}
                  </button>
                )}
              </div>
              {episodesQuery.isLoading ? (
                <div className="grid grid-cols-5 sm:grid-cols-8 gap-1.5" aria-hidden>
                  {Array.from({ length: 8 }).map((_, i) => (
                    <div key={i} className="h-8 rounded-xl bg-chip animate-pulse" />
                  ))}
                </div>
              ) : episodes.length > 0 ? (
                <div className="grid grid-cols-5 sm:grid-cols-8 md:grid-cols-10 gap-1.5 max-h-64 overflow-y-auto pr-1">
                  {(reversed ? [...episodes.keys()].reverse() : [...episodes.keys()]).map((i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => playEpisode(i)}
                      className={cn(
                        'relative overflow-hidden h-9 rounded-xl text-[13px] font-medium transition-colors',
                        i === watchedIndex
                          ? 'bg-content text-page'
                          : episodeProgress.get(i) === 1
                            ? 'bg-content/[0.06] text-faint hover:bg-content/[0.12] hover:text-content'
                            : 'bg-content/[0.06] text-content/80 hover:bg-content/[0.12] hover:text-content',
                      )}
                      title={
                        [
                          i === watchedIndex ? '上次看到这一集' : episodeProgressHint(episodeProgress.get(i)),
                          episodeNames?.[i] && episodeNames[i] !== String(i + 1) ? `源标的集名：${episodeNames[i]}` : '',
                        ]
                          .filter(Boolean)
                          .join(' · ') || undefined
                      }
                    >
                      {i + 1}
                      <EpisodeProgressBar ratio={episodeProgress.get(i)} active={i === watchedIndex} />
                    </button>
                  ))}
                </div>
              ) : episodesQuery.isError || episodesQuery.isSuccess ? (
                <p className="text-sm text-muted">这个源取不到剧集，换上面另一个源试试。</p>
              ) : null}
            </section>
          )}

        </div>
      </div>
    </div>
  );
}

function SourceGroupRow({
  group,
  onSelect,
  currentKey,
  recommended,
  quality,
}: {
  group: AggregatedGroup;
  /** 点源 → 下方选集换成这个源 */
  onSelect: (item: SearchResultItem) => void;
  currentKey?: string;
  /** 这一组的第一个源就是「播放」会用的那个 */
  recommended?: boolean;
  quality: Record<string, SourceQuality | undefined>;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? group.items : group.items.slice(0, SOURCES_PER_GROUP);
  const hidden = group.items.length - shown.length;
  return (
    <li className="rounded-2xl bg-content/[0.04] ring-1 ring-content/[0.06] px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-2">
        <span className="text-sm font-medium text-content">{group.name}</span>
        {group.year && <span className="text-xs text-faint">{group.year}</span>}
        {group.typeName && <span className="text-xs text-faint">{group.typeName}</span>}
        {group.remarks && <span className="text-xs text-muted">{group.remarks}</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((item, i) => (
          <button
            key={`${item.sourceKey}_${item.vodId}`}
            type="button"
            onClick={() => onSelect(item)}
            aria-pressed={qualityKey(item) === currentKey}
            title={item.remarks ? `${item.sourceName} · ${item.remarks}` : item.sourceName}
            className={cn(
              'px-3 py-1.5 rounded-full text-xs transition-colors',
              qualityKey(item) === currentKey
                ? 'bg-content text-page [&_*]:!text-page/70'
                : 'bg-content/[0.07] text-content/85 hover:bg-content/[0.13] hover:text-content',
            )}
          >
            {recommended && i === 0 && <span className="mr-1 font-semibold">推荐</span>}
            {item.sourceName}
            <QualityTag q={quality[qualityKey(item)]} />
            {item.remarks && <span className="ml-1 text-faint">{item.remarks}</span>}
          </button>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="px-3 py-1.5 rounded-full text-xs text-accent hover:bg-accent/10 transition-colors"
          >
            +{hidden} 个源
          </button>
        )}
      </div>
    </li>
  );
}


/** 采集站的简介常带 HTML 标签和 &nbsp; */
function cleanDesc(text?: string): string {
  return (text ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 「张三,李四/王五」→ 前几位，用「 / 」连起来 */
function shortList(text: string | undefined, n: number): string {
  return (text ?? '')
    .split(/[,，/、]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .slice(0, n)
    .join(' / ');
}

/**
 * 剧情简介 + 资讯。简介优先用 TMDB 的中文简介，没有就用排第一的片源详情里的简介；
 * 导演、主演优先用片源详情（中文名更全），类型、首播、集数、状态用 TMDB。
 */
function TitleSynopsisAndInfo({
  pick,
  best,
  enabled,
}: {
  pick: TitlePick;
  best?: SearchResultItem;
  enabled: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const info = useTitleIdentity(pick, true).data?.identity?.info;
  const src = best ? resolveSource({ customAPIs, envSources }, best.sourceKey, { url: best.sourceUrl }) : undefined;
  const detailQuery = useQuery({
    queryKey: ['detail-info', best?.sourceKey, best?.vodId],
    queryFn: ({ signal }) => api.detail(best!.vodId, src!, signal),
    enabled: enabled && Boolean(best && src),
    staleTime: 30 * 60_000,
    retry: 0,
  });
  const vi = detailQuery.data?.videoInfo;

  const synopsis =
    info?.overview || cleanDesc(vi?.desc) || (pick.subtitle && pick.subtitle.length > 30 ? pick.subtitle : '');
  const isMovie = pick.isTv === false;
  const episodes = info?.episodes
    ? `${info.season ? `第 ${info.season} 季 · ` : ''}${info.episodes} 集${info.seasons && info.seasons > 1 ? ` · 全剧共 ${info.seasons} 季` : ''}`
    : '';
  const rows: [string, string][] = [
    ['类型', info?.genres.length ? info.genres.join(' / ') : vi?.typeName || pick.genres || ''],
    [isMovie ? '上映' : '首播', info?.date || vi?.year || pick.year || ''],
    [isMovie ? '片长' : '集数', isMovie ? (info?.runtime ? `${info.runtime} 分钟` : '') : episodes || cleanDesc(vi?.remarks)],
    ['状态', info?.status || ''],
    [isMovie ? '导演' : '主创', shortList(vi?.director, 3) || info?.directors.join(' / ') || ''],
    ['主演', shortList(vi?.actor, 6) || info?.cast.join(' / ') || ''],
    ['地区', vi?.area || pick.area || ''],
    ['播出平台', info?.networks.join(' / ') || ''],
    // 综合分是各站按偏差校正后的加权平均，后面列出各站原始分
    ['评分', [pick.rating && `综合 ${pick.rating}`, describeRatings(pick.ratings), !pick.ratings?.tmdb && info?.rating && `TMDB ${info.rating}${info.votes ? `（${info.votes} 人）` : ''}`].filter(Boolean).join(' · ')],
  ].filter((r): r is [string, string] => Boolean(r[1]));

  if (!synopsis && rows.length === 0) return null;
  return (
    <div className="space-y-3">
      {info?.tagline && <p className="text-sm text-content italic">「{info.tagline}」</p>}
      {synopsis ? (
        <div>
          <p className={cn('text-sm text-muted leading-relaxed', !expanded && 'line-clamp-4')}>{synopsis}</p>
          {synopsis.length > 120 && (
            <button type="button" onClick={() => setExpanded((v) => !v)} className="mt-1 text-xs text-accent hover:underline">
              {expanded ? '收起' : '展开简介'}
            </button>
          )}
        </div>
      ) : detailQuery.isFetching ? (
        <div className="h-12 rounded-xl bg-chip animate-pulse" aria-hidden />
      ) : null}
      {rows.length > 0 && (
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
          {rows.map(([k, v]) => (
            <div key={k} className="flex gap-2 min-w-0">
              <dt className="text-faint shrink-0 w-14">{k}</dt>
              <dd className="text-muted truncate" title={v}>
                {v}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
