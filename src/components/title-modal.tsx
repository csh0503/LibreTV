'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLiveQuery } from 'dexie-react-hooks';
import { recallAlias } from '@/lib/alias-memory';
import { db, favoriteIdOf, toggleFavorite } from '@/lib/db';
import { describeContinueWatching } from '@/lib/home-features';
import { resolveSource, useAppStore } from '@/lib/store';
import { aggregateResults, canonicalTitle, matchingGroups, type AggregatedGroup } from '@/lib/title-aliases';
import type { SearchResultItem, TitlePick } from '@/lib/types';
import { useProfile } from '@/lib/use-profile';
import { buildWatchUrl, cn, formatTime } from '@/lib/utils';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { Spinner } from './states';
import { useToast } from './toast';
import { useFocusTrap } from './use-focus-trap';
import { useAliasFallback, useSourceSearch } from './use-source-search';

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
  onClose,
  onOpenSource,
  onShowResults,
}: {
  pick: TitlePick | null;
  onClose: () => void;
  /** 选定某个源 → 打开该源的选集弹窗 */
  onOpenSource: (item: SearchResultItem) => void;
  /** 去搜索结果页看全部（含名称相近的） */
  onShowResults: (title: string) => void;
}) {
  if (!pick) return null;
  // 换一部作品时整体重建，搜索、图片失败等状态不串
  return (
    <TitleModalBody
      key={pick.title}
      pick={pick}
      onClose={onClose}
      onOpenSource={onOpenSource}
      onShowResults={onShowResults}
    />
  );
}

function TitleModalBody({
  pick,
  onClose,
  onOpenSource,
  onShowResults,
}: {
  pick: TitlePick;
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

  const { searchQuery, selectedSources, streamedOutcomes, isSearching, settled, list, failures } = useSourceSearch(
    pick.title,
  );
  const groups = useMemo(() => aggregateResults(list, pick.title), [list, pick.title]);
  const matched = useMemo(() => matchingGroups(groups, pick.title), [groups, pick.title]);
  const othersCount = groups.length - matched.length;

  // 原名全部源都没有 → 查这部作品的其他中文名，逐个再搜
  const primaryMissing = settled && matched.length === 0 && selectedSources.length > 0;
  const fallback = useAliasFallback(pick, primaryMissing);
  const aliasNames = fallback.names;
  const alias = fallback.alias;
  /** 实际展示的片源：原名优先，没有就用别名找到的 */
  const shown = matched.length > 0 ? matched : fallback.groups;
  const foundVia = matched.length === 0 ? fallback.foundVia : undefined;
  const lookingUpAliases = fallback.lookingUp;
  const nothingFound = fallback.nothingFound;
  const sourceTotal = useMemo(() => new Set(shown.flatMap((g) => g.items.map((i) => i.sourceKey))).size, [shown]);

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
    toast(on ? `已加入我的片单` : '已移出我的片单', 'success');
  };

  const noSourcesConfigured = selectedSources.length === 0;
  const best = shown[0]?.items[0];

  const primary = (() => {
    if (history && resumeView) return { label: `继续播放 · ${resumeView.posterLabel}`, onClick: resume };
    if (best) return { label: '播放', onClick: () => onOpenSource(best) };
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
      : pick.status === 'ended'
        ? '已完结'
        : undefined;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center overflow-y-auto bg-black/80 py-6 sm:py-10 px-3 sm:px-4 animate-fade-in"
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
        className="relative bg-surface-raised rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden animate-slide-up outline-none"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="absolute top-3 right-3 z-20 w-9 h-9 rounded-full bg-black/60 text-white hover:bg-black/80 flex items-center justify-center transition-colors"
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
                className="hidden sm:block w-28 aspect-[2/3] object-cover rounded-lg shadow-lg shrink-0"
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
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white text-black font-semibold text-sm hover:bg-white/85 disabled:bg-white/25 disabled:text-white/70 disabled:cursor-default transition-colors"
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
                  className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl bg-black/40 border border-white/20 text-white text-sm hover:bg-black/60 transition-colors"
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
              {pick.rating && <span className="text-rating font-semibold">★ {pick.rating}</span>}
              {meta && <span className="text-muted">{meta}</span>}
              {statusBadge && (
                <span
                  className={cn(
                    'px-2 py-0.5 rounded text-[11px] font-medium text-white',
                    pick.status === 'airing' ? 'bg-amber-500/90' : 'bg-emerald-600/90',
                  )}
                >
                  {statusBadge}
                </span>
              )}
            </div>
          )}
          {pick.subtitle && <p className="text-sm text-muted leading-relaxed line-clamp-4">{pick.subtitle}</p>}

          <section aria-label="片源" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-base font-bold text-content">
                片源
                <span className="ml-2 text-xs font-normal text-faint">
                  {noSourcesConfigured
                    ? '尚未勾选点播源'
                    : isSearching
                      ? `正在查找 ${streamedOutcomes.length}/${selectedSources.length} 个点播源…`
                      : shown.length > 0
                        ? `${sourceTotal} 个点播源可看${foundVia ? ` · 按别名《${foundVia}》找到` : ''}`
                        : lookingUpAliases
                          ? alias
                            ? `原名没找到，正在按别名《${alias}》查找…`
                            : '原名没找到，正在查这部作品的其他译名…'
                          : settled
                            ? `已查询 ${selectedSources.length - failures.length} 个点播源`
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
                {shown.slice(0, MAX_GROUPS).map((g) => (
                  <SourceGroupRow key={g.key} group={g} onOpenSource={onOpenSource} />
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

          {pick.sourceLabel && <p className="text-[11px] text-faint">热度来源：{pick.sourceLabel}</p>}
        </div>
      </div>
    </div>
  );
}

function SourceGroupRow({
  group,
  onOpenSource,
}: {
  group: AggregatedGroup;
  onOpenSource: (item: SearchResultItem) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? group.items : group.items.slice(0, SOURCES_PER_GROUP);
  const hidden = group.items.length - shown.length;
  return (
    <li className="rounded-xl bg-chip/60 border border-line px-3.5 py-3">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-2">
        <span className="text-sm font-medium text-content">{group.name}</span>
        {group.year && <span className="text-xs text-faint">{group.year}</span>}
        {group.typeName && <span className="text-xs text-faint">{group.typeName}</span>}
        {group.remarks && <span className="text-xs text-muted">{group.remarks}</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {shown.map((item) => (
          <button
            key={`${item.sourceKey}_${item.vodId}`}
            type="button"
            onClick={() => onOpenSource(item)}
            title={item.remarks ? `${item.sourceName} · ${item.remarks}` : item.sourceName}
            className="px-2.5 py-1 rounded-lg text-xs bg-surface border border-line text-muted hover:text-content hover:border-accent/60 transition-colors"
          >
            {item.sourceName}
            {item.remarks && <span className="ml-1 text-faint">{item.remarks}</span>}
          </button>
        ))}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="px-2.5 py-1 rounded-lg text-xs text-accent hover:bg-accent/10 transition-colors"
          >
            +{hidden} 个源
          </button>
        )}
      </div>
    </li>
  );
}
