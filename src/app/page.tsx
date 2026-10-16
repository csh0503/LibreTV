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
  TopTenRow,
  UpcomingRow,
} from '@/components/home-rows';
import { DetailModal } from '@/components/detail-modal';
import { TitleModal } from '@/components/title-modal';
import { AggregatedCard, aggregateResults } from '@/components/video-card';
import { useAppStore, isInDisabledSubscription, isSourceDisabled } from '@/lib/store';
import { sourceIsAdult } from '@/lib/adult-sources';
import { useLoadMore } from '@/components/use-load-more';
import { useSourceSearch } from '@/components/use-source-search';
import type { SearchResultItem, TitlePick } from '@/lib/types';
import { hasTitleMatch } from '@/lib/title-aliases';
import { SearchHistoryDropdown, useSearchHistory } from '@/components/search-history';
import { cn } from '@/lib/utils';
import { useToast } from '@/components/toast';
import { EmptyState } from '@/components/states';
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
  const pickTitle = (title: string, pick?: TitlePick) => {
    const full = { ...pick, title };
    pickedTitles.set(title.trim().slice(0, 100), full);
    setTitlePick(full);
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
  const pickMissing = Boolean(picked) && searchSettled && !hasTitleMatch(groups, urlQuery);

  // 分批渲染：新一次搜索（groups 变化）时重置回首批
  const [visibleCount, setVisibleCount] = useState(RESULT_PAGE_SIZE);
  const visibleGroups = useMemo(() => groups.slice(0, visibleCount), [groups, visibleCount]);
  useEffect(() => setVisibleCount(RESULT_PAGE_SIZE), [groups]);
  const showMoreResults = useCallback(() => {
    setVisibleCount((count) => count + RESULT_PAGE_SIZE);
  }, []);
  const hasMoreResults = groups.length > visibleCount;
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
                  'flex items-stretch min-h-12 pl-4 border',
                  'transition-[background-color,border-color,border-radius] duration-200',
                  searchHistory.visible
                    ? // 展开时：外框（含上圆角）沿用输入框的聚焦样式不变，只把底边改为内部分隔线，
                      // 使输入区在展开状态下仍是边界清晰的独立输入框，而非与列表糊成一片
                      'rounded-t-xl rounded-b-none border-accent border-b-line bg-surface-raised'
                    : 'rounded-xl border-line bg-chip focus-within:border-accent focus-within:ring-1 focus-within:ring-accent/40'
                )}
              >
                <input
                  ref={inputRef}
                  className="flex-1 min-w-0 pr-2 bg-transparent text-sm text-content placeholder:text-faint focus:outline-none"
                  placeholder="输入影片名称..."
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
                {/* 主操作按钮：贴合搜索框右端——右侧圆角跟随容器、左侧直角，展开时右下角
                    跟着容器一起改直角；按压改用亮度反馈（缩放会让贴合边缘露出缝隙） */}
                <button
                  type="submit"
                  className={cn(
                    'btn-primary shrink-0 px-4 font-medium transition-[background-color,filter] active:brightness-90',
                    '!rounded-l-none',
                    searchHistory.visible ? '!rounded-tr-xl !rounded-br-none' : '!rounded-r-xl'
                  )}
                >
                  <Icon name="search" className="w-4 h-4" />
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
              <div className="mb-3 text-xs bg-chip rounded-lg px-3 py-2 flex flex-wrap gap-x-3 gap-y-1">
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
              <div className="mb-3 text-xs text-faint bg-chip rounded-lg px-3 py-2">
                {disabledSources.length} 个源因连续超时/失败已暂停参与搜索（临时停用的到期自动恢复，
                长期停用的需在设置中手动恢复）：{disabledSources.map((key) => sourceName(key)).join('、')}
              </div>
            )}

            {offSubscriptionSources.length > 0 && (
              <div className="mb-3 text-xs text-faint bg-chip rounded-lg px-3 py-2">
                {offSubscriptionSources.length} 个源所属的订阅已停用，未参与本次搜索（在设置 → 数据源订阅中可重新启用）：
                {offSubscriptionSources.map((key) => sourceName(key)).join('、')}
              </div>
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
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 items-start">
                  {visibleGroups.map((group) => (
                    <AggregatedCard
                      key={group.key}
                      group={group}
                      onOpen={(item) => setDetailItem(item)}
                    />
                  ))}
                </div>
                {hasMoreResults && <div ref={resultSentinel} className="h-8" />}
              </>
            ) : isSearching ? (
              <ResultsSkeleton />
            ) : pickMissing && picked ? (
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
