'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Header } from '@/components/header';
import { RecommendSection } from '@/components/douban-section';
import { ForYouRows } from '@/components/for-you';
import { ShelfRows } from '@/components/shelf-rows';
import type { ShelfChannel } from '@/lib/shelf-defs';
import {
  ContinueWatchingRow,
  HeroBillboard,
  MyListRow,
  ScheduleRow,
  TopTenRow,
  UpcomingRow,
} from '@/components/home-rows';
import { DetailModal } from '@/components/detail-modal';
import { TitleModal } from '@/components/title-modal';
import { favoriteIdOf } from '@/lib/db';
import { aggregateResults, DoubanCard, type AggregatedGroup } from '@/components/video-card';
import { useAppStore, isInDisabledSubscription, isSourceDisabled } from '@/lib/store';
import { sourceIsAdult } from '@/lib/adult-sources';
import { useLoadMore } from '@/components/use-load-more';
import { useAliasFallback, useSourceSearch } from '@/components/use-source-search';
import type { SearchResultItem, TitlePick } from '@/lib/types';
import { hasTitleMatch, kindOfTypeName } from '@/lib/title-aliases';
import {
  applySearchFilters,
  countBy,
  DEFAULT_SEARCH_FILTERS,
  groupKind,
  groupRegion,
  groupStatus,
  KIND_LABELS,
  REGION_LABELS,
  SORT_LABELS,
  STATUS_LABELS,
  YEAR_LABELS,
  type SearchFilters,
  type SearchSort,
  type SearchYear,
} from '@/lib/search-filters';
import { SearchHistoryDropdown, useSearchHistory } from '@/components/search-history';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { EmptyState, Spinner } from '@/components/states';
import { NoSourceNotice } from '@/components/no-source';
import { Icon } from '@/components/icon';
import { SiteFooter } from '@/components/site-footer';

/**
 * 首页：搜索（URL ?s= 驱动，可后退/分享）+ 豆瓣推荐。
 * 搜索状态由 React Query 管理，失败源在结果区顶部以非阻塞方式展示。
 */
/** 搜索结果分批渲染的批大小：一次挂载上千张卡片会明显掉帧 */
const RESULT_PAGE_SIZE = 60;

/**
 * 首页卡片点开时记下的元数据（封面、年份），按片名存。
 * 放在模块里而不是组件 state：从播放页后退回到搜索结果时组件会重建，记录仍在。
 */
const pickedTitles = new Map<string, TitlePick>();

export default function HomePage() {
  return (
    <Suspense>
      <HomeContent />
    </Suspense>
  );
}

function HomeContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { toast } = useToast();
  const urlQuery = searchParams.get('s') || '';
  // 精确订阅所需字段（对齐 live 页的做法）：搜索流式期间逐源写健康度、
  // 打开设置抽屉/历史面板等无关 store 变化，都不应触发首页整树重渲染
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);
  const [input, setInput] = useState(urlQuery);
  const [detailItem, setDetailItem] = useState<SearchResultItem | null>(null);
  /** 作品详情弹窗（Netflix 式「更多信息」）当前展示的作品 */
  const [titlePick, setTitlePick] = useState<TitlePick | null>(null);
  /** 从搜索结果打开时，弹窗直接用这张卡的片源 */
  const [presetItems, setPresetItems] = useState<SearchResultItem[] | undefined>(undefined);
  /** 「浏览全部」筛选墙默认收起，首页以 Netflix 式的行为主 */
  const [browseAll, setBrowseAll] = useState(false);
  /** 从货架末尾点「浏览全部」时落在哪个频道；每点一次 nonce +1，用来重建筛选区并滚过去 */
  const [browseTarget, setBrowseTarget] = useState<{ channel: ShelfChannel; nonce: number }>({ channel: 'anime', nonce: 0 });
  const browseRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // URL 驱动搜索：?s= 变化时回填输入框
  useEffect(() => {
    if (urlQuery) setInput(urlQuery);
  }, [urlQuery]);

  const adultSourceCount = useMemo(
    () => [...customAPIs, ...envSources].filter((s) => sourceIsAdult(s)).length,
    [customAPIs, envSources]
  );

  const { searchQuery, selectedSources, streamedOutcomes, isSearching, settled: searchSettled, list, failures, sourceName } =
    useSourceSearch(urlQuery);
  const disabledSources = useMemo(
    () => selectedKeys.filter((key) => isSourceDisabled({ sourceHealth }, key)),
    [selectedKeys, sourceHealth]
  );
  // 来自已关闭订阅的源：勾选状态还在，但本次搜索用不到，必须明确告知
  const offSubscriptionSources = useMemo(
    () =>
      selectedKeys.filter(
        (key) => !isSourceDisabled({ sourceHealth }, key) && isInDisabledSubscription({ subscriptions }, key)
      ),
    [selectedKeys, sourceHealth, subscriptions]
  );


  // 最近搜索改为搜索框下拉（聚焦展开、按输入过滤），不再常驻首屏
  const searchHistory = useSearchHistory(input);

  const runSearch = (q: string) => {
    const query = q.trim().slice(0, 100);
    if (!query) {
      toast('请输入搜索内容', 'info');
      inputRef.current?.focus();
      return;
    }
    if (selectedSources.length === 0) {
      toast('请先在设置中添加并勾选点播源', 'warning');
      return;
    }
    router.push(`/?s=${encodeURIComponent(query)}`, { scroll: false });
    searchHistory.record(query);
  };

  /** 首页各行的卡片点开：先打开作品详情弹窗（弹窗里查片源）；元数据也记下来，去搜索结果页时「暂无片源」卡要用 */
  const pickTitle = (title: string, pick?: TitlePick & { yearSoft?: boolean }) => {
    // 按筛选条件填上去的年份（B站片库按年份筛）不是这部的真实年份：拿它去认作品会认错（「航海王」+ 2026 → 乐高特别篇）
    const { yearSoft, ...rest } = pick ?? {};
    const full: TitlePick = { ...rest, title, ...(yearSoft ? { year: undefined } : {}) };
    pickedTitles.set(title.trim().slice(0, 100), full);
    setPresetItems(undefined);
    setTitlePick(full);
  };

  /** 搜索结果卡片点开：同一个详情弹窗，片源直接用这张卡聚合到的，不再搜一遍 */
  const openGroup = (group: AggregatedGroup) => {
    setPresetItems(group.items);
    setTitlePick({
      title: group.name,
      cover: group.pic,
      year: group.year,
      genres: group.typeName,
      remarks: group.remarks,
      isTv: kindOfTypeName(group.typeName) === undefined ? undefined : kindOfTypeName(group.typeName) === 'tv',
    });
  };

  const closeTitleModal = useCallback(() => setTitlePick(null), []);

  /** 弹窗里点「全部搜索结果」：关弹窗，走原来的搜索结果页 */
  const showResults = (title: string) => {
    setTitlePick(null);
    setInput(title);
    runSearch(title);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const openBrowse = (channel: ShelfChannel) => {
    setBrowseAll(true);
    setBrowseTarget((t) => ({ channel, nonce: t.nonce + 1 }));
  };
  useEffect(() => {
    if (browseTarget.nonce > 0) browseRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [browseTarget]);

  const pickHistory = (text: string) => {
    setInput(text);
    searchHistory.close();
    runSearch(text);
  };

  // 跨源同名聚合：同名影片合并为一张卡片，展开后可选择具体来源
  const groups = useMemo(() => aggregateResults(list, urlQuery), [list, urlQuery]);
  // 从首页卡片点进来、全部源都结算了还没有这部作品本身 → 「暂无片源」
  const picked = pickedTitles.get(urlQuery);
  // 原名没搜到这部作品本身 → 按它的其他中文名（港台译名等）再查；手动输入的搜索也一样
  const titleMissing = searchSettled && selectedSources.length > 0 && !hasTitleMatch(groups, urlQuery);
  const fallback = useAliasFallback(picked ?? { title: urlQuery }, titleMissing);
  // 别名也都没有，才给「暂无片源」
  const pickMissing = Boolean(picked) && titleMissing && fallback.nothingFound;

  // 筛选和排序：排序记住（默认年份从新到旧），其他条件换一次搜索就清掉
  const [filters, setFilters] = useState<SearchFilters>(() => ({ ...DEFAULT_SEARCH_FILTERS, sort: loadSearchSort() }));
  useEffect(() => setFilters((f) => ({ ...DEFAULT_SEARCH_FILTERS, sort: f.sort })), [urlQuery]);
  const updateFilters = useCallback((patch: Partial<SearchFilters>) => {
    setFilters((f) => {
      const next = { ...f, ...patch };
      if (patch.sort) saveSearchSort(patch.sort);
      return next;
    });
  }, []);
  const filteredGroups = useMemo(() => applySearchFilters(groups, filters, undefined, urlQuery), [groups, filters, urlQuery]);

  // 分批渲染：新一次搜索 / 换筛选时重置回首批
  const [visibleCount, setVisibleCount] = useState(RESULT_PAGE_SIZE);
  const visibleGroups = useMemo(() => filteredGroups.slice(0, visibleCount), [filteredGroups, visibleCount]);
  useEffect(() => setVisibleCount(RESULT_PAGE_SIZE), [filteredGroups]);
  const showMoreResults = useCallback(() => {
    setVisibleCount((count) => count + RESULT_PAGE_SIZE);
  }, []);
  const hasMoreResults = filteredGroups.length > visibleCount;
  const resultSentinel = useLoadMore(hasMoreResults, visibleCount, showMoreResults);

  return (
    <div className="min-h-screen flex flex-col">
      <Header />

      <main className="relative flex-1 max-w-6xl w-full mx-auto px-4 py-6">
        {/* 首屏氛围渐变 */}
        {!urlQuery && (
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-0 h-[420px] -z-10"
            style={{
              background:
                'radial-gradient(60% 60% at 50% 0%, rgba(35,173,229,0.10) 0%, rgba(35,173,229,0.03) 45%, transparent 75%)',
            }}
          />
        )}

        {/* 搜索区 */}
        <section className={cn('flex flex-col items-center', urlQuery ? 'mb-6' : 'mt-8 mb-8')}>
          {!urlQuery && (
            <header className="text-center mb-6">
              <h1 className="text-4xl sm:text-5xl font-bold brand-gradient">LibreTV</h1>
            </header>
          )}
          {urlQuery && <h1 className="sr-only">LibreTV 视频搜索</h1>}
          {/* 定位容器比胶囊宽一圈：浮层按它的宽度对齐，接缝处不会与胶囊边框错位 1px */}
          <div ref={searchHistory.containerRef} className="relative w-full max-w-2xl">
            <form
              className="w-full"
              onSubmit={(e) => {
                e.preventDefault();
                runSearch(input);
              }}
            >
              {/* 输入框与搜索按钮合并为一个胶囊：内部无边框，焦点态由容器统一表达；
                  下拉展开时改为「上圆下直」并隐去底边，与下方浮层拼成同一个面板 */}
              <div
                className={cn(
                  // 12px 圆角矩形（非胶囊）：收起态与展开态共用同一组上圆角，
                  // 展开时输入框这部分形状完全不发生变化，上下圆角也与下拉保持一致；
                  // 右侧与上下不留内边距，由搜索按钮拉伸填满、与搜索框边缘贴合
                  'flex items-center min-h-[52px] pl-4 pr-1.5 glass shadow-[0_8px_30px_rgba(0,0,0,0.18)]',
                  'transition-[background-color,border-color,border-radius,box-shadow] duration-200',
                  searchHistory.visible
                    ? // 展开时：只把底边改为内部分隔线，和下面的浮层拼成同一个面板
                      'rounded-t-[22px] rounded-b-none !border-b-content/10'
                    : 'rounded-[22px] focus-within:ring-2 focus-within:ring-accent/40'
                )}
              >
                <Icon name="search" className="w-[18px] h-[18px] text-faint shrink-0 mr-2.5" />
                <input
                  ref={inputRef}
                  className="flex-1 min-w-0 pr-2 bg-transparent text-[15px] text-content placeholder:text-faint focus:outline-none"
                  placeholder="搜索电影、剧集、动漫"
                  value={input}
                  maxLength={100}
                  onChange={(e) => {
                    setInput(e.target.value);
                    searchHistory.resetActive();
                  }}
                  onFocus={searchHistory.onFocus}
                  onKeyDown={(e) => searchHistory.onKeyDown(e, pickHistory)}
                  role="combobox"
                  aria-label="搜索影片"
                  aria-expanded={searchHistory.visible}
                  aria-controls="home-search-history"
                  aria-autocomplete="list"
                  aria-activedescendant={
                    searchHistory.visible && searchHistory.activeIndex >= 0
                      ? `home-search-history-${searchHistory.activeIndex}`
                      : undefined
                  }
                />
                {input && (
                  <button
                    type="button"
                    className="shrink-0 self-center mr-1 p-1.5 rounded-full text-faint hover:text-content hover:bg-hover transition-colors"
                    onClick={() => {
                      setInput('');
                      searchHistory.resetActive();
                      inputRef.current?.focus();
                    }}
                    aria-label="清空"
                  >
                    <Icon name="close" className="w-4 h-4" />
                  </button>
                )}
                {/* 主操作按钮：框内右侧的小胶囊（回车同样能搜） */}
                <button type="submit" className="btn-primary shrink-0 px-4 py-2 !rounded-2xl">
                  搜索
                </button>
              </div>
            </form>

            {/* 最近搜索：与输入框无缝拼接；浮层不占文档流，出现/消失不会顶动下方内容 */}
            {searchHistory.visible && (
              <SearchHistoryDropdown
                id="home-search-history"
                matches={searchHistory.matches}
                activeIndex={searchHistory.activeIndex}
                onPick={pickHistory}
                onRemove={searchHistory.remove}
                onClearAll={searchHistory.clearAll}
              />
            )}
          </div>

          {/* 成人内容开关：关 = 过滤（默认），开 = 启用成人源并允许成人分类 */}
          <div className="flex items-center gap-2 mt-3 text-xs">
            <button
              type="button"
              onClick={() => {
                const hide = !yellowFilter;
                useAppStore.getState().updateSettings({ yellowFilter: hide });
                if (hide) {
                  toast(adultSourceCount > 0 ? `已隐藏成人内容，并停用 ${adultSourceCount} 个成人源` : '已隐藏成人内容', 'info');
                } else {
                  toast(
                    adultSourceCount > 0 ? `已解锁，并启用 ${adultSourceCount} 个成人源` : '已解锁。当前没有标记为成人的点播源',
                    'warning'
                  );
                }
              }}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1 rounded-full border transition-all text-xs font-medium',
                yellowFilter
                  ? 'border-line text-muted bg-surface/50 hover:bg-chip hover:text-content'
                  : 'border-red-500/50 text-red-500 bg-red-500/10 shadow-[0_0_12px_rgba(239,68,68,0.35)]'
              )}
              title={yellowFilter ? '解锁成人源、成人片名和成人分类' : '重新隐藏成人内容'}
              aria-pressed={!yellowFilter}
            >
              <span>{yellowFilter ? '成人内容 · 关' : '成人内容 · 开'}</span>
              {!yellowFilter && adultSourceCount > 0 && (
                <span className="text-[10px] opacity-80">{adultSourceCount} 个源</span>
              )}
            </button>
          </div>
        </section>

        {/* 搜索结果 */}
        {urlQuery && (
          <section aria-label="搜索结果" className="mb-10">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm text-muted">
                “<span className="text-content">{urlQuery}</span>” 的搜索结果
                {isSearching ? (
                  <span className="text-faint">
                    （已就绪 {streamedOutcomes.length}/{selectedSources.length} 个源…）
                  </span>
                ) : (
                  searchQuery.data && (
                    <span className="text-faint">
                      （{groups.length} 部影片 · {list.length} 条结果{failures.length > 0 && `，${failures.length} 个源失败`}）
                    </span>
                  )
                )}
              </h2>
            </div>
            {searchQuery.data?.aliases && searchQuery.data.aliases.length > 0 && (
              <p className="text-xs text-faint mb-3 -mt-1">
                片源站常用别名，已同时搜索：{searchQuery.data.aliases.join('、')}
              </p>
            )}

            {failures.length > 0 && (
              <div className="mb-3 text-xs bg-chip rounded-xl px-3 py-2 flex flex-wrap gap-x-3 gap-y-1">
                <span className="text-faint">{isSearching ? '以下源暂时无响应：' : '部分点播源请求失败：'}</span>
                {failures.map((f) => (
                  <span key={f.sourceKey} className={f.timedOut ? 'text-warning' : 'text-faint'}>
                    {f.timedOut ? '⏱' : '✗'} {sourceName(f.sourceKey)}
                    {f.timedOut ? ' 超时' : ''}
                  </span>
                ))}
              </div>
            )}

            {disabledSources.length > 0 && (
              <div className="mb-3 text-xs text-faint bg-chip rounded-xl px-3 py-2">
                {disabledSources.length} 个源因连续超时/失败已暂停参与搜索（临时停用的到期自动恢复，
                长期停用的需在设置中手动恢复）：{disabledSources.map((key) => sourceName(key)).join('、')}
              </div>
            )}

            {offSubscriptionSources.length > 0 && (
              <div className="mb-3 text-xs text-faint bg-chip rounded-xl px-3 py-2">
                {offSubscriptionSources.length} 个源所属的订阅已停用，未参与本次搜索（在设置 → 数据源订阅中可重新启用）：
                {offSubscriptionSources.map((key) => sourceName(key)).join('、')}
              </div>
            )}

            {fallback.lookingUp && (
              <div className="mb-4 flex items-center gap-2.5 rounded-xl border border-line bg-chip px-4 py-3 text-sm text-muted">
                <Spinner size="sm" />
                {fallback.alias
                  ? `原名没有找到《${urlQuery}》本身，正在按别名《${fallback.alias}》查找…`
                  : `原名没有找到《${urlQuery}》本身，正在查这部作品的其他译名…`}
              </div>
            )}
            {fallback.foundVia && (
              <div className="mb-6">
                <p className="mb-3 text-sm text-muted">
                  原名没有找到，按别名<span className="text-content font-medium">《{fallback.foundVia}》</span>找到：
                </p>
                <SearchPosterGrid groups={fallback.groups} onOpen={openGroup} />
                {list.length > 0 && <h3 className="mt-6 text-sm text-faint">名称相近的其他结果</h3>}
              </div>
            )}
            {fallback.nothingFound && fallback.names.length > 0 && (
              <p className="mb-3 text-xs text-faint">也按别名《{fallback.names.join('》《')}》查过，都没有找到。</p>
            )}
            {selectedSources.length === 0 ? (
              <NoSourceGuide hasSources={customAPIs.length > 0 || envSources.length > 0} />
            ) : list.length > 0 ? (
              <>
                {pickMissing && picked && (
                  <NoSourceNotice
                    variant="inline"
                    pick={picked}
                    sourceCount={selectedSources.length}
                    failedCount={failures.length}
                    onRetry={() => void searchQuery.refetch()}
                  />
                )}
                <SearchFilterBar groups={groups} filters={filters} onChange={updateFilters} shown={filteredGroups.length} />
                {filteredGroups.length === 0 ? (
                  <p className="py-12 text-center text-sm text-faint">
                    没有符合筛选条件的结果。
                    <button type="button" className="text-accent hover:underline" onClick={() => updateFilters({ ...DEFAULT_SEARCH_FILTERS, sort: filters.sort })}>
                      清除筛选
                    </button>
                  </p>
                ) : (
                  <SearchPosterGrid groups={visibleGroups} onOpen={openGroup} />
                )}
                {hasMoreResults && <div ref={resultSentinel} className="h-8" />}
              </>
            ) : isSearching ? (
              <ResultsSkeleton />
            ) : fallback.lookingUp || fallback.foundVia ? null : pickMissing && picked ? (
              <NoSourceNotice
                variant="full"
                pick={picked}
                sourceCount={selectedSources.length}
                failedCount={failures.length}
                onRetry={() => void searchQuery.refetch()}
              />
            ) : (
              <EmptyState
                icon="search"
                title="没有找到匹配的结果"
                description="请尝试其他关键词或更换点播源"
                className="!py-16"
              />
            )}
          </section>
        )}

        {/* 首页大盘（有搜索时隐藏）：主推大图 -> 继续观看 / 我的片单 -> 个性化推荐 -> 本周前十 -> 即将播出 -> 货架（按行）-> 浏览全部（筛选） */}
        {!urlQuery && (
          <div className="space-y-7">
            <HeroBillboard
              onPick={pickTitle}
            />
            <ContinueWatchingRow />
            <MyListRow
              onPick={pickTitle}
              onOpen={(item) => setDetailItem(item)}
            />
            <ScheduleRow onPick={pickTitle} />
            <ForYouRows
              onPick={pickTitle}
            />
            <TopTenRow
              onPick={pickTitle}
            />
            <UpcomingRow
              onPick={pickTitle}
            />
            <ShelfRows onPick={pickTitle} onBrowse={openBrowse} />
            <div className="pt-2">
              <button
                type="button"
                onClick={() => setBrowseAll((v) => !v)}
                aria-expanded={browseAll}
                className="w-full sm:w-auto px-4 py-2 rounded-xl border border-line bg-surface/80 text-sm text-muted hover:text-content hover:bg-hover transition-colors cursor-pointer"
              >
                {browseAll ? '收起「浏览全部」' : '浏览全部 · 按题材 / 地区 / 年份筛选'}
              </button>
            </div>
            {browseAll && (
              <RecommendSection
                key={browseTarget.nonce}
                ref={browseRef}
                initialChannel={browseTarget.channel}
                onPick={pickTitle}
                onOpen={(item) => setDetailItem(item)}
              />
            )}
          </div>
        )}
      </main>

      <SiteFooter />

      <TitleModal
        pick={titlePick}
        presetItems={presetItems}
        onClose={closeTitleModal}
        onOpenSource={(item) => {
          setTitlePick(null);
          setDetailItem(item);
        }}
        onShowResults={showResults}
      />
      <DetailModal item={detailItem} onClose={() => setDetailItem(null)} />
    </div>
  );
}

function ResultsSkeleton() {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
      {Array.from({ length: 6 }).map((_, i) => (
        // 结构对齐真实结果卡（左侧缩略图 + 右侧文字块），避免占位与真实卡片形状不符
        <div key={i} className="card flex h-28 overflow-hidden">
          <div className="w-[105px] sm:w-[120px] shrink-0 bg-chip animate-pulse" />
          <div className="flex-1 p-2.5 space-y-2">
            <div className="h-4 w-3/4 rounded bg-chip animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-chip animate-pulse" />
            <div className="h-3 w-full rounded bg-chip animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** 无点播源 / 未勾选点播源时的引导（替代旧版首屏静默空白） */
function NoSourceGuide({ hasSources = false }: { hasSources?: boolean }) {
  return (
    <div className="border border-dashed border-line rounded-xl p-10 text-center max-w-lg mx-auto">
      <h3 className="text-content font-medium mb-2">{hasSources ? '尚未勾选点播源' : '先添加一个点播源'}</h3>
      <p className="text-sm text-muted leading-relaxed">
        {hasSources ? (
          <>点击右上角「设置」，勾选要参与搜索的点播源后重新搜索。</>
        ) : (
          <>
            LibreTV 不内置任何采集站。点击右上角「设置 → 添加 API」，填入一个
            Apple CMS 采集站地址（如 <code className="text-accent text-xs">https://example.com/api.php/provide/vod</code>），
            勾选后即可开始搜索。
          </>
        )}
      </p>
    </div>
  );
}

/** 搜索结果：和首页一样的海报卡片，一部一张，点开是同一个详情弹窗 */
const SEARCH_SORT_KEY = 'libretv:search-sort';

function loadSearchSort(): SearchSort {
  try {
    const v = localStorage.getItem(SEARCH_SORT_KEY);
    if (v && v in SORT_LABELS) return v as SearchSort;
  } catch {
    // 读不到用默认
  }
  return DEFAULT_SEARCH_FILTERS.sort;
}

function saveSearchSort(sort: SearchSort) {
  try {
    localStorage.setItem(SEARCH_SORT_KEY, sort);
  } catch {
    // 存不了就这次有效
  }
}

/**
 * 搜索结果的筛选条：排序、类型、地区、年份、状态。
 * 每个选项后面是这次结果里有几部；一部都没有的选项不显示（「全部」和已选中的除外）。
 */
function SearchFilterBar({
  groups,
  filters,
  onChange,
  shown,
}: {
  groups: AggregatedGroup[];
  filters: SearchFilters;
  onChange: (patch: Partial<SearchFilters>) => void;
  shown: number;
}) {
  const nowYear = new Date().getFullYear();
  const yearOf = (g: AggregatedGroup): SearchYear | undefined => {
    const y = parseInt(g.year ?? '', 10);
    if (!y) return undefined;
    if (y >= nowYear) return 'this';
    if (y >= 2020) return '2020s';
    if (y >= 2010) return '2010s';
    return 'older';
  };
  const kindCounts = countBy(groups, groupKind);
  const regionCounts = countBy(groups, groupRegion);
  const statusCounts = countBy(groups, groupStatus);
  const yearCounts = countBy(groups, yearOf);
  const recentCount = groups.filter((g) => (parseInt(g.year ?? '', 10) || 0) >= nowYear - 2).length;
  const active = filters.kind !== 'all' || filters.region !== 'all' || filters.year !== 'all' || filters.status !== 'all';

  const row = <K extends string>(
    label: string,
    options: Record<K, string>,
    value: K,
    counts: Map<K, number> | ((k: K) => number) | null,
    set: (k: K) => void,
  ) => {
    const keys = (Object.keys(options) as K[]).filter((k) => {
      // 排序（counts 为 null）的选项都显示
      if (counts === null || k === 'all' || k === value) return true;
      return (typeof counts === 'function' ? counts(k) : counts.get(k) ?? 0) > 0;
    });
    // 只剩「全部」和一个选项：没得筛，不显示这一行
    if (counts !== null && keys.length <= 2 && value === ('all' as K)) return null;
    return (
      <div className="flex items-center gap-2 min-w-0">
        <span className="shrink-0 text-xs text-faint w-8">{label}</span>
        <div className="flex gap-1.5 overflow-x-auto scrollbar-none -my-1 py-1">
          {keys.map((k) => {
            const n = k === 'all' || counts === null ? undefined : typeof counts === 'function' ? counts(k) : counts.get(k);
            return (
              <button
                key={k}
                type="button"
                onClick={() => set(k)}
                className={cn(
                  'shrink-0 px-2.5 py-1 rounded-full text-xs transition-colors whitespace-nowrap',
                  value === k ? 'bg-content text-page font-medium' : 'bg-chip text-muted hover:text-content',
                )}
              >
                {options[k]}
                {n ? <span className={cn('ml-1', value === k ? 'opacity-60' : 'text-faint')}>{n}</span> : null}
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div className="mb-4 rounded-2xl bg-surface-raised/60 border border-line p-3 space-y-2">
      {row('排序', SORT_LABELS, filters.sort, null, (sort) => onChange({ sort }))}
      {row('类型', KIND_LABELS, filters.kind, kindCounts, (kind) => onChange({ kind }))}
      {row('地区', REGION_LABELS, filters.region, regionCounts, (region) => onChange({ region }))}
      {row(
        '年份',
        YEAR_LABELS,
        filters.year,
        (k: SearchYear) => (k === 'recent' ? recentCount : yearCounts.get(k) ?? 0),
        (year) => onChange({ year }),
      )}
      {row('状态', STATUS_LABELS, filters.status, statusCounts, (status) => onChange({ status }))}
      {active && (
        <p className="text-xs text-faint">
          筛选后 {shown} 部 ·{' '}
          <button type="button" className="text-accent hover:underline" onClick={() => onChange({ kind: 'all', region: 'all', year: 'all', status: 'all' })}>
            清除筛选
          </button>
        </p>
      )}
    </div>
  );
}

function SearchPosterGrid({ groups, onOpen }: { groups: AggregatedGroup[]; onOpen: (group: AggregatedGroup) => void }) {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-7 gap-3">
      {groups.map((group) => {
        const sources = new Set(group.items.map((i) => i.sourceKey)).size;
        const remarks = group.remarks?.trim();
        return (
          <DoubanCard
            key={group.key}
            item={{
              title: group.name,
              cover: group.pic ?? '',
              meta: [group.year, group.typeName, `${sources} 个源`].filter(Boolean).join(' · '),
              badge: remarks && remarks.length <= 12 ? { text: remarks, tone: 'ok' } : undefined,
              favorite: { localId: favoriteIdOf({ title: group.name }), title: group.name, pic: group.pic, year: group.year },
            }}
            onClick={() => onOpen(group)}
          />
        );
      })}
    </div>
  );
}
