'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
// 播放器（artplayer + hls.js）按需加载：拆出独立 chunk，不占首屏 First Load JS
const PlayerShell = dynamic(() => import('@/components/player-shell').then((m) => m.PlayerShell), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center">
      <Spinner size="lg" />
    </div>
  ),
});
import { EmptyState, LoadingState, Spinner } from '@/components/states';
import { SwitchSourceModal } from '@/components/switch-source';
import { useAutoFailover, type FailoverState } from '@/components/use-auto-failover';
import { useToast } from '@/components/toast';
import { EpisodeProgressBar, episodeProgressHint, useEpisodeProgress } from '@/components/episode-progress';
import { useAudioSkip } from '@/components/use-audio-skip';
import { usePlayerPrefs } from '@/lib/player-prefs';
import { diagnosePlaylist, formatDiagnosis } from '@/lib/ad-diagnose';
import { loadAdMarks, saveAdMarks } from '@/lib/ad-marks';
import { browserAudioDeps } from '@/lib/hls-audio-browser';
import { makeAbsolute } from '@/lib/m3u8';
import { bestVariant, parseMasterPlaylist } from '@/lib/stream-quality';
import { parseClock, pickEpisodeSkip, seriesKeyOf, type SkipSegment } from '@/lib/skip-segment';
import { failoverQueryTitle } from '@/lib/failover';
import { enqueueDownload } from '@/components/download-manager';
import { FavoriteButton } from '@/components/favorite-button';
import { Icon } from '@/components/icon';
import { SmartImage } from '@/components/smart-image';
import { useAuth } from '@/components/auth';
import { resolveSource, useAppStore } from '@/lib/store';
import {
  progressKeyOf,
  saveProgress,
  updateHistoryProgress,
  upsertHistory,
  db,
  favoriteIdOf,
} from '@/lib/db';
import {
  decideEpisodeEndAction,
  extractTasteFromVideoInfo,
} from '@/lib/home-features';
import { getActiveProfileId, whenProfileReady } from '@/lib/profile-session';
import { rememberVideoInfo } from '@/lib/taste-store';
import { canonicalTitle } from '@/lib/title-aliases';
import { cn, formatTime } from '@/lib/utils';

/**
 * 播放页（唯一入口，替代旧版 watch.html → player.html 跳转链）。
 * 状态全部由 URL 驱动：/watch?source=xx&id=..&index=..&title=..
 * 集数列表由服务端详情接口获取；进度与历史走 IndexedDB。
 */
export default function WatchPage() {
  return (
    <Suspense>
      <WatchContent />
    </Suspense>
  );
}

function WatchContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const store = useAppStore();
  const { verified } = useAuth();

  const sourceKey = searchParams.get('source') || '';
  const vodId = searchParams.get('id') || '';
  const directUrl = searchParams.get('url') || '';
  const titleParam = searchParams.get('title') || '';
  const indexParam = parseInt(searchParams.get('index') || '0', 10) || 0;

  const [reversed, setReversed] = useState(false);
  const [switchOpen, setSwitchOpen] = useState(false);

  const source = resolveSource(store, sourceKey, {
    url: searchParams.get('sourceUrl') || undefined,
    detail: searchParams.get('detail') || undefined,
  });

  // 详情查询：无 id（纯直连链接分享）时跳过
  const detailQuery = useQuery({
    queryKey: ['detail', sourceKey, vodId, source?.url],
    queryFn: ({ signal }) => api.detail(vodId, source!, signal),
    enabled: Boolean(source && vodId && verified),
    staleTime: 5 * 60_000,
  });

  const episodes = useMemo(() => detailQuery.data?.episodes ?? [], [detailQuery.data]);
  // 集数按列表位置算。源给的集名不可靠（实测最大资源把第二季第 1~3 集标成「第02~04集」），只当提示
  const labelOf = (i: number) => String(i + 1);
  const episodeNames = detailQuery.data?.episodeNames;
  const videoTitle = titleParam || detailQuery.data?.videoInfo?.title || '未知视频';

  // 当前播放地址：优先取剧集列表中的当前集，其次直连 URL 参数
  const currentUrl = useMemo(() => {
    if (episodes.length > 0) {
      const idx = Math.min(Math.max(indexParam, 0), episodes.length - 1);
      return episodes[idx] || directUrl;
    }
    return directUrl;
  }, [episodes, indexParam, directUrl]);

  const currentIndex = useMemo(() => {
    if (episodes.length > 0) return Math.min(Math.max(indexParam, 0), episodes.length - 1);
    return indexParam;
  }, [episodes, indexParam]);

  type EndOverlayState =
    | { mode: 'countdown'; nextIndex: number; remaining: number; total: number }
    | { mode: 'manual-next'; nextIndex: number }
    | { mode: 'still-watching'; nextIndex: number; streak: number }
    | null;

  const [endOverlay, setEndOverlay] = useState<EndOverlayState>(null);
  // 播放卡住 / 加载失败 → 自动换到同一部的下一个源，接着播同一集同一位置
  const failover = useAutoFailover({
    title: videoTitle,
    year: detailQuery.data?.videoInfo?.year,
    isTv: episodes.length > 1 ? true : undefined,
    sourceKey,
    vodId,
    index: currentIndex,
    sourceName: source?.name ?? sourceKey,
  });
  /** 连续自动连播计数：手动点选集数或确认「还在看」时归零 */
  const autoPlayStreakRef = useRef(0);

  const goEpisode = useCallback(
    (index: number, opts?: { fromAuto?: boolean }) => {
      if (!opts?.fromAuto) {
        autoPlayStreakRef.current = 0;
      }
      setEndOverlay(null);
      const sp = new URLSearchParams(searchParams.toString());
      sp.set('index', String(index));
      sp.set('url', episodes[index] || directUrl);
      sp.delete('position');
      // 自动换源试过哪些只对那一集有效
      sp.delete('tried');
      router.replace(`/watch?${sp.toString()}`, { scroll: false });
    },
    [router, searchParams, episodes, directUrl]
  );

  // 切换剧集或 URL 变化时关闭上一集的片尾卡片
  useEffect(() => {
    setEndOverlay(null);
  }, [currentIndex, currentUrl]);

  // 详情加载后顺带把题材、地区、年份记入口味表
  useEffect(() => {
    const info = detailQuery.data?.videoInfo;
    if (!info || source?.isAdult || !videoTitle) return;
    void rememberVideoInfo(videoTitle, extractTasteFromVideoInfo(info));
  }, [detailQuery.data?.videoInfo, source?.isAdult, videoTitle]);

  // —— 跳过片头片尾：有官方数据（B站 / AniSkip / TheIntroDB）先用官方的；
  //    同时后台比对这一集和别的集的声音，找到了就盖过官方的（就是这个片源的位置，最准）——
  const videoYear = detailQuery.data?.videoInfo?.year;
  const seriesKey = seriesKeyOf(videoTitle, videoYear);
  const prefs = usePlayerPrefs();
  const [duration, setDuration] = useState(0);
  useEffect(() => setDuration(0), [currentIndex, sourceKey, vodId]);
  const positionRef = useRef({ time: 0, duration: 0 });
  const isAnime = /动漫|动画|番/.test(detailQuery.data?.videoInfo?.typeName ?? '');
  const skipKind: 'tv' | 'movie' = episodes.length > 1 ? 'tv' : 'movie';
  const remoteSkip = useQuery({
    queryKey: ['skip-times', failoverQueryTitle(videoTitle, videoYear), videoYear, currentIndex + 1, Math.round(duration / 5), isAnime, skipKind],
    queryFn: ({ signal }) =>
      api.skipTimes(
        {
          title: failoverQueryTitle(videoTitle, videoYear),
          year: videoYear,
          episode: currentIndex + 1,
          length: duration,
          anime: isAnime,
          kind: skipKind,
        },
        signal,
      ),
    enabled: duration > 60 && Boolean(videoTitle) && !source?.isAdult,
    staleTime: 24 * 3600_000,
    retry: 0,
  });
  const audioSkip = useAudioSkip({
    seriesKey,
    episodes,
    index: currentIndex,
    adFilter: store.adFilter,
    ready: duration > 60 && !source?.isAdult,
    enabled: prefs.audioSkip,
  });
  const episodeSkip = useMemo(() => {
    const { intro, outro } = pickEpisodeSkip(remoteSkip.data, audioSkip.result, duration);
    return intro || outro ? { intro, outro, auto: prefs.autoSkip } : undefined;
  }, [remoteSkip.data, audioSkip.result, duration, prefs.autoSkip]);
  // 你手动标的广告（按集记）：播到自动跳过
  const adEpisodeKey = `${sourceKey}:${vodId}:${currentIndex}`;
  const [adMarks, setAdMarks] = useState<SkipSegment[]>([]);
  useEffect(() => setAdMarks(loadAdMarks(adEpisodeKey)), [adEpisodeKey]);
  const [adPanelOpen, setAdPanelOpen] = useState(false);

  // 进度恢复优先级：URL position 参数 > IndexedDB progress 表 > 已同步的观看历史 > 同一部别的源看到的位置
  const getRestorePosition = useCallback(async () => {
    await whenProfileReady();
    // 快看完了（最后 15 秒内）就当这集看完了，从头播
    const valid = (pos: number, dur: number) => (pos > 0 && (!dur || pos < dur - 15) ? pos : 0);
    const urlPos = parseInt(searchParams.get('position') || '0', 10) || 0;
    if (urlPos > 0) {
      // 只用一次：留在地址栏里的话，之后重新加载（切换去广告、刷新）会跳回这个旧位置
      const sp = new URLSearchParams(window.location.search);
      sp.delete('position');
      window.history.replaceState(window.history.state, '', `?${sp.toString()}`);
      return urlPos;
    }
    if (!vodId) return 0;
    const entry = await db.progress.get(progressKeyOf(sourceKey, vodId, currentIndex));
    if (entry && valid(entry.position, entry.duration)) return entry.position;
    const pid = getActiveProfileId();
    if (!pid) return 0;
    const hist = await db.history.get(`${pid}::${sourceKey}_${vodId}`);
    if (hist && hist.episodeIndex === currentIndex && valid(hist.playbackPosition, hist.duration)) {
      return hist.playbackPosition;
    }
    // 换了个源看同一集（详情弹窗里点了别的源 / 自动换源）：用那个源上看到的位置。
    // 不同源的片头长短可能差几秒，往回退 5 秒
    const key = canonicalTitle(videoTitle);
    if (!key) return 0;
    const other = (await db.history.where('profileId').equals(pid).toArray())
      .filter(
        (h) =>
          h.id !== hist?.id &&
          h.episodeIndex === currentIndex &&
          canonicalTitle(h.title) === key &&
          valid(h.playbackPosition, h.duration),
      )
      .sort((a, b) => b.timestamp - a.timestamp)[0];
    return other ? Math.max(0, other.playbackPosition - 5) : 0;
  }, [searchParams, sourceKey, vodId, currentIndex, videoTitle]);

  // 写入观看历史（进入页面即记录，进度后续增量更新）
  useEffect(() => {
    if (!verified || !sourceKey || !currentUrl) return;
    const timer = setTimeout(() => {
      upsertHistory({
        sourceKey,
        sourceUrl: source?.url,
        vodId: vodId || currentUrl,
        title: videoTitle,
        pic: detailQuery.data?.videoInfo?.cover,
        episodeIndex: currentIndex,
        totalEpisodes: episodes.length,
        playbackPosition: 0,
        duration: 0,
        timestamp: Date.now(),
      }).catch(() => {});
    }, 2000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verified, sourceKey, vodId, currentIndex, videoTitle, currentUrl, episodes.length]);

  // 播放中与暂停时的进度落盘逻辑一致，共用同一回调
  const handleProgress = useCallback(
    (position: number, duration: number) => {
      if (duration > 0) setDuration((d) => (Math.abs(d - duration) > 1 ? duration : d));
      if (vodId) {
        saveProgress(sourceKey, vodId, currentIndex, position, duration).catch(() => {});
        updateHistoryProgress(sourceKey, vodId || currentUrl, position, duration).catch(() => {});
      }
    },
    [sourceKey, vodId, currentIndex, currentUrl]
  );

  // 倒计时大卡每秒递减，归零时自动切入下一集并累加连播计数
  useEffect(() => {
    if (!endOverlay || endOverlay.mode !== 'countdown') return;
    if (endOverlay.remaining <= 0) {
      autoPlayStreakRef.current += 1;
      goEpisode(endOverlay.nextIndex, { fromAuto: true });
      return;
    }
    const timer = window.setTimeout(() => {
      setEndOverlay((prev) =>
        prev && prev.mode === 'countdown'
          ? { ...prev, remaining: prev.remaining - 1 }
          : prev
      );
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [endOverlay, goEpisode]);

  const handleEnded = useCallback(() => {
    // 记成「看完了」（位置 = 总长）：选集按钮标看过；下次点这一集从头播
    const total = positionRef.current.duration;
    if (vodId && total > 0) saveProgress(sourceKey, vodId, currentIndex, total, total).catch(() => {});
    const decision = decideEpisodeEndAction({
      currentIndex,
      totalEpisodes: episodes.length,
      autoplayNext: store.autoplayNext,
      consecutiveAutoPlays: autoPlayStreakRef.current,
    });
    if (decision.mode === 'none') {
      setEndOverlay(null);
      return;
    }
    if (decision.mode === 'countdown') {
      setEndOverlay({
        mode: 'countdown',
        nextIndex: decision.nextIndex,
        remaining: decision.seconds,
        total: decision.seconds,
      });
      return;
    }
    if (decision.mode === 'still-watching') {
      setEndOverlay({
        mode: 'still-watching',
        nextIndex: decision.nextIndex,
        streak: decision.streak,
      });
      return;
    }
    setEndOverlay({
      mode: 'manual-next',
      nextIndex: decision.nextIndex,
    });
  }, [store.autoplayNext, currentIndex, episodes.length, sourceKey, vodId]);

  // Alt+←/→ 集数切换快捷键
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.altKey) return;
      if (e.key === 'ArrowLeft' && currentIndex > 0) {
        e.preventDefault();
        goEpisode(currentIndex - 1);
      } else if (e.key === 'ArrowRight' && currentIndex < episodes.length - 1) {
        e.preventDefault();
        goEpisode(currentIndex + 1);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [currentIndex, episodes.length, goEpisode]);

  const episodeProgress = useEpisodeProgress(sourceKey, vodId);
  const orderedEpisodes = reversed ? [...episodes].map((_, i) => episodes.length - 1 - i) : episodes.map((_, i) => i);

  if (!verified) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <p className="text-faint text-sm">等待访问验证...</p>
      </div>
    );
  }

  if (!source) {
    return (
      <div className="min-h-screen flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <h1 className="text-content font-medium mb-2">点播源不存在</h1>
          <p className="text-sm text-muted mb-4">
            该视频来自点播源「{sourceKey}」，但它可能已被删除。请在设置中重新添加后重试。
          </p>
          <Link href="/" className="btn-primary">返回首页</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-40 bg-surface/90 backdrop-blur border-b border-line">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center gap-3">
          <BackButton />
          <HomeButton />
          <div className="min-w-0">
            <h1 className="text-sm font-medium text-content truncate">{videoTitle}</h1>
            <p className="text-xs text-faint">
              {source.name}
              {episodes.length > 0 && ` · 第 ${currentIndex + 1}/${episodes.length} 集`}
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <FavoriteButton
              entry={{
                localId: favoriteIdOf({ sourceKey, vodId: vodId || currentUrl, title: videoTitle }),
                title: videoTitle,
                pic: detailQuery.data?.videoInfo?.cover,
                sourceKey,
                sourceUrl: source.url,
                vodId: vodId || currentUrl,
                isAdult: source.isAdult,
              }}
            />
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                if (!currentUrl) return;
                enqueueDownload({
                  url: currentUrl,
                  // 多集才带集数后缀；单集影片（含电影）文件名就是纯标题
                  title: `${videoTitle}${episodes.length > 1 ? ` 第${labelOf(currentIndex)}集` : ''}`,
                  format: 'MP4',
                });
                // 「已加入下载队列」由 DownloadManager 在真正入队后提示：
                // 这里先提示的话，用户随后取消保存位置会出现「已加入→已取消」的矛盾
              }}
            >
              下载本集
            </button>
            <button className="btn-ghost btn-sm" onClick={() => setSwitchOpen(true)}>
              切换资源
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-4">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4">
          <div>
            <div className="aspect-video bg-black rounded-xl overflow-hidden">
              {currentUrl ? (
                <PlayerShell
                  url={currentUrl}
                  title={videoTitle}
                  adFilter={store.adFilter}
                  autoplayNext={store.autoplayNext}
                  episodeKey={`${sourceKey}:${vodId}:${currentIndex}`}
                  nextUrl={currentIndex + 1 < episodes.length ? episodes[currentIndex + 1] : undefined}
                  nextEpisodeKey={currentIndex + 1 < episodes.length ? `${sourceKey}:${vodId}:${currentIndex + 1}` : undefined}
                  getRestorePosition={getRestorePosition}
                  onTimeUpdate={handleProgress}
                  onPause={handleProgress}
                  onEnded={handleEnded}
                  onRequestSwitchSource={vodId ? failover.requestSwitch : undefined}
                  skip={episodeSkip}
                  adSkips={adMarks}
                  onNextEpisode={
                    currentIndex + 1 < episodes.length
                      ? (opts) => {
                          if (!opts?.auto) return goEpisode(currentIndex + 1);
                          // 「下一集」卡倒数完自动切：算一次自动连播，连看太多集先问「还在看吗？」
                          const decision = decideEpisodeEndAction({
                            currentIndex,
                            totalEpisodes: episodes.length,
                            autoplayNext: store.autoplayNext,
                            consecutiveAutoPlays: autoPlayStreakRef.current,
                          });
                          if (decision.mode === 'still-watching') {
                            setEndOverlay({ mode: 'still-watching', nextIndex: decision.nextIndex, streak: decision.streak });
                            return;
                          }
                          autoPlayStreakRef.current += 1;
                          goEpisode(currentIndex + 1, { fromAuto: true });
                        }
                      : undefined
                  }
                  positionRef={positionRef}
                  nextTitle={currentIndex + 1 < episodes.length ? `第 ${labelOf(currentIndex + 1)} 集` : undefined}
                  overlay={
                    failover.state.phase !== 'idle' ? (
                      <FailoverOverlayCard
                        state={failover.state}
                        sourceName={source.name}
                        onManual={() => {
                          failover.cancel();
                          setSwitchOpen(true);
                        }}
                        onRetry={() => window.location.reload()}
                      />
                    ) : endOverlay ? (
                      <EndEpisodeOverlayCard
                        state={endOverlay}
                        title={videoTitle}
                        cover={detailQuery.data?.videoInfo?.cover}
                        totalEpisodes={episodes.length}
                        nextLabel={labelOf(endOverlay.nextIndex)}
                        onPlayNow={() => {
                          autoPlayStreakRef.current = 0;
                          goEpisode(endOverlay.nextIndex);
                        }}
                        onCancelCountdown={() => {
                          if (endOverlay.mode === 'countdown') {
                            setEndOverlay({ mode: 'manual-next', nextIndex: endOverlay.nextIndex });
                          } else {
                            setEndOverlay(null);
                          }
                        }}
                        onDismiss={() => setEndOverlay(null)}
                      />
                    ) : undefined
                  }
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  {detailQuery.isLoading ? (
                    <Spinner size="lg" />
                  ) : (
                    <p className="text-faint text-sm">
                      {detailQuery.isError ? '视频加载失败，请尝试其他资源' : '无可用播放地址'}
                    </p>
                  )}
                </div>
              )}
            </div>

            {/* 操作栏 */}
            <div className="flex flex-wrap items-center gap-2 mt-3">
              <button
                className="btn-ghost btn-sm"
                disabled={currentIndex <= 0}
                onClick={() => goEpisode(currentIndex - 1)}
              >
                上一集
              </button>
              <button
                className="btn-ghost btn-sm"
                disabled={episodes.length === 0 || currentIndex >= episodes.length - 1}
                onClick={() => goEpisode(currentIndex + 1)}
              >
                下一集
              </button>
              <button className="btn-ghost btn-sm" onClick={() => setAdPanelOpen((v) => !v)}>
                广告详情
              </button>
              <label className="ml-auto flex items-center gap-1.5 text-xs text-muted cursor-pointer">
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[rgb(var(--c-accent))]"
                  checked={store.autoplayNext}
                  onChange={(e) => store.updateSettings({ autoplayNext: e.target.checked })}
                />
                自动连播
              </label>
            </div>
            {adPanelOpen && currentUrl && (
              <AdPanel
                url={currentUrl}
                title={`${videoTitle}${episodes.length > 1 ? ` 第${labelOf(currentIndex)}集` : ''} · ${source.name}`}
                positionRef={positionRef}
                marks={adMarks}
                onChange={(next) => {
                  setAdMarks(next);
                  saveAdMarks(adEpisodeKey, next);
                }}
                onClose={() => setAdPanelOpen(false)}
              />
            )}
          </div>

          {/* 剧集侧栏 */}
          <aside className="bg-surface-raised rounded-xl p-3 h-fit">
            <div className="flex items-center justify-between gap-2 mb-2.5">
              <h2 className="text-sm font-semibold text-content">
                剧集列表{episodes.length > 0 && `（${episodes.length}）`}
              </h2>
              {/* 排列开关紧贴它所作用的列表：放在这里才看得出它管的是这一栏的顺序 */}
              {episodes.length > 1 && (
                <button
                  className="btn-ghost btn-sm shrink-0"
                  onClick={() => setReversed((v) => !v)}
                  aria-label={reversed ? '切换为正序排列' : '切换为倒序排列'}
                  title="调整剧集列表的排列顺序"
                >
                  <Icon
                    name="arrowDown"
                    className={cn('w-3.5 h-3.5 transition-transform', reversed && 'rotate-180')}
                  />
                  {reversed ? '正序排列' : '倒序排列'}
                </button>
              )}
            </div>
            {episodes.length === 0 ? (
              detailQuery.isLoading ? (
                <LoadingState />
              ) : (
                <EmptyState variant="plain" title={detailQuery.isError ? '获取剧集失败' : '暂无剧集信息'} />
              )
            ) : (
              <div className="grid grid-cols-5 lg:grid-cols-4 gap-1.5 max-h-[65vh] overflow-y-auto scrollbar-thin pr-1">
                {orderedEpisodes.map((realIndex) => (
                  <EpisodeButton
                    key={realIndex}
                    label={labelOf(realIndex)}
                    hint={episodeNames?.[realIndex]}
                    progress={episodeProgress.get(realIndex)}
                    active={realIndex === currentIndex}
                    onClick={() => goEpisode(realIndex)}
                  />
                ))}
              </div>
            )}
            <p className="hidden md:block text-[10px] text-faint mt-3 leading-relaxed">
              快捷键：空格 播放/暂停 · ←/→ 快退/快进 {prefs.seekStep} 秒 · {'<'} / {'>'} 调速 · ↑/↓ 音量 · F 全屏 · Alt+←/→ 切换集数
            </p>
          </aside>
        </div>
      </main>

      {switchOpen && (
        <SwitchSourceModal
          currentTitle={videoTitle}
          currentSourceKey={sourceKey}
          currentVodId={vodId}
          currentIndex={currentIndex}
          onClose={() => setSwitchOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * 「广告详情」：
 * - 已去掉的广告：被去广告规则剔除的每一段，可以单独预览原片确认；
 * - 技术信息（折叠）：在浏览器里读这一集的播放列表，按插播段和「换了网站 / 路径 / 命名」切组列出来，反馈问题时复制。
 * - 手动标广告：填时间或播到那里点「现在」，这一集播到就自动跳过。
 */
function AdPanel({
  url,
  title,
  positionRef,
  marks,
  onChange,
  onClose,
}: {
  url: string;
  title: string;
  positionRef: React.MutableRefObject<{ time: number; duration: number }>;
  marks: SkipSegment[];
  onChange: (next: SkipSegment[]) => void;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [previewing, setPreviewing] = useState<number | null>(null);
  const diag = useQuery({
    queryKey: ['ad-diag', url],
    queryFn: async ({ signal }) => {
      const deps = browserAudioDeps();
      let res = await deps.fetchText(url, signal);
      const variants = parseMasterPlaylist(res.text);
      if (variants.length > 0) res = await deps.fetchText(makeAbsolute(bestVariant(variants)!.uri, res.url), signal);
      return diagnosePlaylist(res.text, res.url);
    },
    staleTime: 10 * 60_000,
    retry: 0,
  });
  const text = diag.data ? `${formatDiagnosis(diag.data, title)}\n当前播放到 ${formatTime(positionRef.current.time)}` : '';
  const add = () => {
    const a = parseClock(start);
    const b = parseClock(end);
    if (a === undefined || b === undefined || b <= a || b - a > 600) {
      toast('填广告的开始和结束时间（如 8:44 和 9:14），最长 10 分钟', 'warning');
      return;
    }
    onChange([...marks.filter((m) => m.end <= a || m.start >= b), { start: a, end: b }]);
    setStart('');
    setEnd('');
    toast(`已标记 ${formatTime(a)}–${formatTime(b)}，这一集播到会自动跳过`, 'success');
  };
  const input = (value: string, set: (v: string) => void, label: string) => (
    <label className="flex items-center gap-1.5">
      <span className="text-faint">{label}</span>
      <input
        value={value}
        onChange={(e) => set(e.target.value)}
        placeholder="0:00"
        className="w-16 px-2 py-1 rounded-lg bg-surface border border-line text-content text-xs"
      />
      <button type="button" className="text-accent hover:underline" onClick={() => set(formatTime(positionRef.current.time))}>
        现在
      </button>
    </label>
  );
  return (
    <div className="mt-3 rounded-xl border border-line bg-surface-raised p-3 sm:p-4 space-y-3 text-xs text-muted">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-content">广告详情</h3>
        <button type="button" className="text-faint hover:text-content" onClick={onClose}>
          收起
        </button>
      </div>
      <div className="space-y-2">
        <p className="font-medium text-content">
          已去掉的广告
          {diag.data && diag.data.removed.length > 0
            ? `（${diag.data.removed.length} 段，共 ${Math.round(diag.data.strippedSeconds)} 秒，播放时自动跳过）`
            : ''}
        </p>
        {diag.isLoading ? (
          <p className="text-faint">正在检查…</p>
        ) : diag.isError ? (
          <p className="text-faint">暂时检查不了这一集。</p>
        ) : diag.data && diag.data.removed.length > 0 ? (
          <>
            <div className="flex flex-wrap gap-1.5">
              {diag.data.removed.map((clip, i) => (
                <button
                  key={clip.start}
                  type="button"
                  onClick={() => setPreviewing((v) => (v === i ? null : i))}
                  className={cn('btn-sm', previewing === i ? 'btn-primary' : 'btn-ghost')}
                >
                  {previewing === i ? '收起' : '预览'} {formatTime(clip.start)}–{formatTime(clip.start + clip.seconds)}（{Math.round(clip.seconds)} 秒）
                </button>
              ))}
            </div>
            {previewing !== null && diag.data.removed[previewing] && (
              <ClipPreview key={diag.data.removed[previewing].start} playlist={diag.data.removed[previewing].playlist} />
            )}
            <p className="text-faint">时间是原片里的位置。如果预览出来是正片，可以在设置里暂时关掉「去广告」，并把下面的技术信息发给我们。</p>
          </>
        ) : (
          <p className="text-faint">这一集没有发现插播广告。</p>
        )}
      </div>
      <div className="space-y-2">
        <p className="font-medium text-content">还有漏掉的？标出来，这一集播到会自动跳过</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {input(start, setStart, '开始')}
          {input(end, setEnd, '结束')}
          <button type="button" className="btn-primary btn-sm" onClick={add}>
            标记
          </button>
        </div>
        {marks.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {marks.map((m) => (
              <li key={`${m.start}-${m.end}`} className="flex items-center gap-1 px-2 py-0.5 rounded-lg bg-chip text-content">
                {formatTime(m.start)}–{formatTime(m.end)}
                <button
                  type="button"
                  className="text-faint hover:text-danger"
                  aria-label="删除这个标记"
                  onClick={() => onChange(marks.filter((x) => x !== m))}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <details className="group">
        <summary className="cursor-pointer text-faint hover:text-content select-none">技术信息（反馈问题时用）</summary>
        <div className="mt-2 space-y-1.5">
          <div className="flex justify-end">
            <button
              type="button"
              className="btn-ghost btn-sm"
              disabled={!text}
              onClick={() =>
                void navigator.clipboard
                  .writeText(text)
                  .then(() => toast('已复制', 'success'))
                  .catch(() => toast('复制失败，可以手动选中文字复制', 'warning'))
              }
            >
              复制
            </button>
          </div>
          <pre className="max-h-64 overflow-auto rounded-xl bg-surface border border-line p-2 text-[11px] leading-relaxed text-content whitespace-pre-wrap break-all select-all">
            {text || (diag.isError ? `读不到播放列表：${diag.error instanceof Error ? diag.error.message : '失败'}` : '…')}
          </pre>
        </div>
      </details>
    </div>
  );
}

/**
 * 只播一小段被去掉的原片（不影响上面的正片播放）：用这几个分片拼一个小播放列表交给 hls.js；
 * 直连失败（跨域 / 防盗链）就把分片和密钥地址都换成本站代理再试一次。
 */
function ClipPreview({ playlist }: { playlist: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let destroy = () => {};
    const viaProxy = (text: string) =>
      text
        .split('\n')
        .map((l) =>
          /^https?:\/\//.test(l)
            ? `${location.origin}/api/proxy?url=${encodeURIComponent(l)}`
            : l.replace(/URI="(https?:\/\/[^"]+)"/, (_, u: string) => `URI="${location.origin}/api/proxy?url=${encodeURIComponent(u)}"`),
        )
        .join('\n');
    void import('hls.js').then(({ default: Hls }) => {
      if (cancelled || !videoRef.current) return;
      const video = videoRef.current;
      const start = (text: string, isRetry: boolean) => {
        destroy();
        const blobUrl = URL.createObjectURL(new Blob([text], { type: 'application/vnd.apple.mpegurl' }));
        if (!Hls.isSupported()) {
          video.src = blobUrl;
          destroy = () => URL.revokeObjectURL(blobUrl);
          return;
        }
        const hls = new Hls({ enableWorker: true });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data.fatal) return;
          if (!isRetry && data.type === Hls.ErrorTypes.NETWORK_ERROR) start(viaProxy(playlist), true);
          else setError('这一段播不了（片源拒绝访问或格式不支持）');
        });
        hls.loadSource(blobUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => void video.play().catch(() => {}));
        destroy = () => {
          hls.destroy();
          URL.revokeObjectURL(blobUrl);
        };
      };
      start(playlist, false);
    });
    return () => {
      cancelled = true;
      destroy();
    };
  }, [playlist]);
  return (
    <div className="space-y-1">
      <video ref={videoRef} controls playsInline className="w-full max-w-md aspect-video rounded-xl bg-black" />
      {error && <p className="text-danger">{error}</p>}
    </div>
  );
}

/** 自动换源时盖在播放器上的小卡：正在换 / 换不动了 */
function FailoverOverlayCard({
  state,
  sourceName,
  onManual,
  onRetry,
}: {
  state: Exclude<FailoverState, { phase: 'idle' }>;
  sourceName: string;
  onManual: () => void;
  onRetry: () => void;
}) {
  const exhausted = state.phase === 'exhausted';
  return (
    <div className="pointer-events-auto inset-0 w-full h-full bg-black/70 backdrop-blur-[2px] flex items-center justify-center p-4 animate-fade-in">
      <div
        role="status"
        className="w-full max-w-sm rounded-2xl border border-white/15 bg-[#0f172a]/95 text-white p-5 shadow-2xl space-y-3"
      >
        {exhausted ? (
          <>
            <h3 className="text-base font-bold">换了 {state.tried} 个源都播不了</h3>
            <p className="text-xs text-slate-300">
              最后一次：「{sourceName}」{state.reason}。可以手动挑一个源，或者稍后重试。
            </p>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2.5">
              <Spinner size="sm" />
              <h3 className="text-sm font-bold">正在自动换源…</h3>
            </div>
            <p className="text-xs text-slate-300">
              「{sourceName}」{state.reason}
              {state.phase === 'trying' && state.sourceName ? `，正在试「${state.sourceName}」` : '，正在找同一部的其他源'}
            </p>
          </>
        )}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onManual}
            className="flex-1 px-3 py-2 rounded-xl bg-white text-slate-950 hover:bg-slate-100 text-xs font-semibold cursor-pointer"
          >
            手动换源
          </button>
          <button
            type="button"
            onClick={onRetry}
            className="px-3 py-2 rounded-xl border border-white/20 bg-white/10 hover:bg-white/20 text-xs font-medium cursor-pointer"
          >
            重试这个源
          </button>
        </div>
      </div>
    </div>
  );
}

/** 集数按钮：激活时自动滚动进可视区（长剧列表） */
function EpisodeButton({
  label,
  hint,
  progress,
  active,
  onClick,
}: {
  label: string;
  hint?: string;
  /** 看过的比例（看完是 1） */
  progress?: number;
  active: boolean;
  onClick: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 只滚列表自己：scrollIntoView 会连整页一起滚，手机上列表在播放器下面，一进来页面就被拖到播放器下方
    const el = ref.current;
    const list = el?.parentElement;
    if (!active || !el || !list) return;
    const top = el.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    if (top < list.scrollTop || top + el.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = top - (list.clientHeight - el.offsetHeight) / 2;
    }
  }, [active]);

  return (
    <button
      ref={ref}
      className={cn('btn btn-sm !px-1 relative overflow-hidden', active ? 'episode-active' : 'btn-ghost', !active && progress === 1 && 'text-faint')}
      title={[episodeProgressHint(progress), hint && hint !== label ? `源标的集名：${hint}` : ''].filter(Boolean).join(' · ') || undefined}
      onClick={onClick}
    >
      {label}
      <EpisodeProgressBar ratio={progress} active={active} />
    </button>
  );
}

function BackButton() {
  const router = useRouter();
  return (
    <button
      className="p-2 -ml-2 rounded-lg text-muted hover:text-content hover:bg-hover transition-colors"
      onClick={() => {
        if (window.history.length > 1) router.back();
        else router.push('/');
      }}
      aria-label="返回"
    >
      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
      </svg>
    </button>
  );
}

/** 首页按钮：直达首页，避免从外链进入时逐级 back */
function HomeButton() {
  return (
    <Link
      href="/"
      className="p-2 rounded-lg text-muted hover:text-content hover:bg-hover transition-colors"
      aria-label="回首页"
      title="回首页"
    >
      <Icon name="home" className="w-5 h-5" />
    </Link>
  );
}

/**
 * 播完时的 Netflix 风格大卡：
 * - countdown / manual-next：展示海报、集名、预热就绪状态、几秒后自动播放倒计时进度，支持立即播放或取消自动播放；
 * - still-watching：连看多集后弹出「还在看吗？」确认，避免睡着或离开后自动连播停不下来。
 */
function EndEpisodeOverlayCard({
  state,
  title,
  cover,
  totalEpisodes,
  nextLabel,
  onPlayNow,
  onCancelCountdown,
  onDismiss,
}: {
  state:
    | { mode: 'countdown'; nextIndex: number; remaining: number; total: number }
    | { mode: 'manual-next'; nextIndex: number }
    | { mode: 'still-watching'; nextIndex: number; streak: number };
  title: string;
  cover?: string;
  totalEpisodes: number;
  nextLabel: string;
  onPlayNow: () => void;
  onCancelCountdown: () => void;
  onDismiss: () => void;
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);

  const nextEpNum = nextLabel;

  if (state.mode === 'still-watching') {
    return (
      <div className="pointer-events-auto inset-0 w-full h-full bg-black/80 backdrop-blur-md flex items-center justify-center p-4 animate-fade-in">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="还在看吗？"
          className="w-full max-w-md rounded-2xl border border-white/15 bg-[#0f172a]/95 text-white p-5 sm:p-6 shadow-2xl space-y-4"
        >
          <div className="flex items-center gap-3.5">
            {cover && !imgFailed ? (
              <SmartImage
                url={cover}
                mode={imageProxyMode}
                customProxy={customImageProxy}
                alt={title}
                className="w-16 sm:w-20 aspect-[2/3] rounded-xl object-cover bg-slate-800 shrink-0 shadow-md"
                onExhausted={() => setImgFailed(true)}
              />
            ) : null}
            <div className="min-w-0 space-y-1">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-500/20 text-amber-300">
                已连续播放 {state.streak} 集
              </span>
              <h3 className="text-lg sm:text-xl font-bold text-white">还在看吗？</h3>
              <p className="text-xs sm:text-sm text-slate-300 line-clamp-2">
                《{title}》即将播放 <span className="text-white font-semibold">第 {nextEpNum} 集</span>
                {totalEpisodes > 0 ? `（共 ${totalEpisodes} 集）` : ''}
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 pt-1">
            <button
              type="button"
              onClick={onPlayNow}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-white text-slate-950 hover:bg-slate-100 font-semibold text-sm shadow transition-colors cursor-pointer"
            >
              <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
              继续观看第 {nextEpNum} 集
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="px-4 py-2.5 rounded-xl border border-white/20 bg-white/10 hover:bg-white/20 text-white text-sm font-medium transition-colors cursor-pointer"
            >
              先不看了
            </button>
          </div>
        </div>
      </div>
    );
  }

  const isCounting = state.mode === 'countdown';
  const progressPct = isCounting
    ? Math.min(100, Math.max(0, Math.round(((state.total - state.remaining) / state.total) * 100)))
    : 100;

  return (
    <div className="pointer-events-auto inset-0 w-full h-full bg-black/65 backdrop-blur-[2px] flex items-end sm:items-center justify-center sm:justify-end p-3 sm:p-6 animate-fade-in">
      <div
        role="dialog"
        aria-label={`下一集：第 ${nextEpNum} 集`}
        className="w-full max-w-sm sm:max-w-md rounded-2xl border border-white/15 bg-[#0f172a]/95 text-white p-4 sm:p-5 shadow-2xl space-y-3.5"
      >
        <div className="flex items-start gap-3.5">
          {cover && !imgFailed ? (
            <div
              onClick={onPlayNow}
              role="button"
              tabIndex={-1}
              className="relative w-16 sm:w-20 aspect-[2/3] rounded-xl overflow-hidden bg-slate-800 shrink-0 shadow-md cursor-pointer group"
            >
              <SmartImage
                url={cover}
                mode={imageProxyMode}
                customProxy={customImageProxy}
                alt={title}
                className="w-full h-full object-cover group-hover:scale-105 transition-transform"
                onExhausted={() => setImgFailed(true)}
              />
              <div className="absolute inset-0 bg-black/30 flex items-center justify-center">
                <div className="w-8 h-8 rounded-full bg-white/90 text-slate-950 flex items-center justify-center shadow">
                  <svg className="w-4 h-4 fill-current ml-0.5" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                </div>
              </div>
            </div>
          ) : null}

          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-sky-400">
                {isCounting ? `${state.remaining} 秒后自动播放下一集` : '下一集就绪'}
              </span>
            </div>

            <h3 className="text-sm sm:text-base font-bold text-white truncate" title={title}>
              {title}
            </h3>

            <p className="text-xs sm:text-sm text-slate-300 font-medium">
              第 {nextEpNum} 集
              {totalEpisodes > 0 && <span className="text-slate-400"> / 共 {totalEpisodes} 集</span>}
            </p>
          </div>
        </div>

        {isCounting && (
          <div className="h-1.5 w-full rounded-full bg-white/15 overflow-hidden">
            <div
              className="h-full bg-sky-400 transition-all duration-700"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        )}

        <div className="flex items-center gap-2.5 pt-0.5">
          <button
            type="button"
            onClick={onPlayNow}
            className="flex-1 inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-xl bg-white text-slate-950 hover:bg-slate-100 font-semibold text-xs sm:text-sm shadow transition-colors cursor-pointer"
          >
            <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
            立即播放
          </button>

          {isCounting ? (
            <button
              type="button"
              onClick={onCancelCountdown}
              className="px-3.5 py-2 rounded-xl border border-white/20 bg-white/10 hover:bg-white/20 text-white text-xs sm:text-sm font-medium transition-colors cursor-pointer"
            >
              取消自动播放
            </button>
          ) : (
            <button
              type="button"
              onClick={onDismiss}
              className="px-3.5 py-2 rounded-xl border border-white/20 bg-white/10 hover:bg-white/20 text-white text-xs sm:text-sm font-medium transition-colors cursor-pointer"
            >
              留在本集
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

