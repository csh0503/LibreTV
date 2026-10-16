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
import { useAudioSkip, type AudioSkipStatus } from '@/components/use-audio-skip';
import { audioSkipEnabled, saveAudioTemplates, setAudioSkipEnabled } from '@/lib/audio-skip-store';
import {
  classifySkip,
  loadSkipMarks,
  parseClock,
  resolveEpisodeSkip,
  saveSkipMarks,
  seriesKeyOf,
  type EpisodeSkip,
  type LearnedSkip,
  type SkipSource,
} from '@/lib/skip-marks';

type PlayerPrompt = { text: string; actions: { label: string; onClick: () => void; primary?: boolean }[] };
import { failoverQueryTitle } from '@/lib/failover';
import type { SkipVia } from '@/lib/skip-times';
import { enqueueDownload } from '@/components/download-manager';
import { FavoriteButton } from '@/components/favorite-button';
import { Icon } from '@/components/icon';
import { SmartImage } from '@/components/smart-image';
import { useAuth } from '@/components/auth';
import { resolveSource, useAppStore } from '@/lib/store';
import {
  clearProgress,
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
  const [nextPrefetchState, setNextPrefetchState] = useState<'idle' | 'running' | 'done'>('idle');
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

  // —— 跳过片头片尾 ——
  const { toast } = useToast();
  const videoYear = detailQuery.data?.videoInfo?.year;
  const seriesKey = seriesKeyOf(videoTitle, videoYear);
  const [learned, setLearned] = useState<LearnedSkip | undefined>(undefined);
  useEffect(() => setLearned(loadSkipMarks(seriesKey)), [seriesKey]);
  const [duration, setDuration] = useState(0);
  useEffect(() => setDuration(0), [currentIndex, sourceKey, vodId]);
  const positionRef = useRef({ time: 0, duration: 0 });
  const isAnime = /动漫|动画|番/.test(detailQuery.data?.videoInfo?.typeName ?? '');
  // 查片头片尾数据库（片子总长确定之后，用它挑同一版本的时间点）：动漫查 B站官方 / AniSkip / TheIntroDB，其他查 TheIntroDB
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
  // 后台声音比对：这一段已经有你手动设的或数据库的准确值就不做（省流量）
  const baseSkip = useMemo(() => resolveEpisodeSkip(remoteSkip.data, learned, duration), [remoteSkip.data, learned, duration]);
  const audioSkip = useAudioSkip({
    seriesKey,
    episodes,
    index: currentIndex,
    adFilter: store.adFilter,
    ready: duration > 60 && !remoteSkip.isFetching && !source?.isAdult,
    need: {
      intro: !learned?.ignoreRemote && baseSkip.source.intro !== 'manual' && baseSkip.source.intro !== 'remote',
      outro: !learned?.ignoreRemote && baseSkip.source.outro !== 'manual' && baseSkip.source.outro !== 'remote',
    },
    positionRef,
  });
  const episodeSkip = useMemo(
    () => resolveEpisodeSkip(remoteSkip.data, learned, duration, audioSkip.result),
    [remoteSkip.data, learned, duration, audioSkip.result],
  );
  const updateLearned = useCallback(
    (patch: Partial<LearnedSkip> | null) => setLearned(saveSkipMarks(seriesKey, patch)),
    [seriesKey],
  );
  /** 播放器里的小卡：你刚跳过一大段时问要不要记成片头 / 片尾 */
  const [skipPrompt, setSkipPrompt] = useState<PlayerPrompt | null>(null);
  const [skipEditorOpen, setSkipEditorOpen] = useState(false);
  const promptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showSkipPrompt = useCallback((p: PlayerPrompt | null) => {
    if (promptTimerRef.current) clearTimeout(promptTimerRef.current);
    promptTimerRef.current = p ? setTimeout(() => setSkipPrompt(null), 12_000) : null;
    setSkipPrompt(p);
  }, []);
  useEffect(() => () => showSkipPrompt(null), [currentIndex, sourceKey, vodId, showSkipPrompt]);
  /**
   * 你自己跳了一大段、像在跳片头 / 片尾：直接问要不要记下（你点了才记）。
   * 这一段已经有 AniSkip 的准确时间或你手动设过的，就不问。
   * 在片尾点播放器下方的「下一集」：页面要换集，改用页面顶部的提示问。
   */
  const learnSkip = useCallback(
    (from: number, to: number, total: number, opts?: { viaNextButton?: boolean }) => {
      const hit = classifySkip(from, to, total);
      if (!hit) return;
      const src = episodeSkip.source[hit.kind];
      if (src === 'remote' || src === 'manual' || src === 'audio') return;
      const name = hit.kind === 'intro' ? '片头' : '片尾';
      const range =
        hit.kind === 'intro'
          ? `${formatTime(hit.seg.start)}–${formatTime(hit.seg.end)}`
          : `${formatTime(total - hit.fromEnd)}–${hit.toEnd === 0 ? '结尾' : formatTime(total - hit.toEnd)}`;
      const save = () => {
        updateLearned(
          hit.kind === 'intro' ? { intro: hit.seg, introLength: undefined } : { outro: { fromEnd: hit.fromEnd, toEnd: hit.toEnd } },
        );
        showSkipPrompt(null);
        toast(`已记成这部的${name}（${range}），之后每集会显示「跳过${name}」`, 'success');
      };
      const text = `刚才跳过了 ${range}，记成这部的${name}？`;
      if (opts?.viaNextButton) {
        toast(text, 'info', { action: { label: `记成${name}`, onClick: save }, duration: 9000 });
        return;
      }
      showSkipPrompt({
        text,
        actions: [
          { label: `记成${name}`, onClick: save, primary: true },
          {
            label: '手动设置',
            onClick: () => {
              showSkipPrompt(null);
              setSkipEditorOpen(true);
            },
          },
          { label: '不用', onClick: () => showSkipPrompt(null) },
        ],
      });
    },
    [episodeSkip.source, updateLearned, toast, showSkipPrompt],
  );

  // 进度恢复优先级：URL position 参数 > IndexedDB progress 表 > 已同步的观看历史
  const getRestorePosition = useCallback(async () => {
    await whenProfileReady();
    const urlPos = parseInt(searchParams.get('position') || '0', 10) || 0;
    if (urlPos > 0) return urlPos;
    if (!vodId) return 0;
    const entry = await db.progress.get(progressKeyOf(sourceKey, vodId, currentIndex));
    if (entry?.position && entry.position > 0) return entry.position;
    const pid = getActiveProfileId();
    if (pid) {
      const hist = await db.history.get(`${pid}::${sourceKey}_${vodId}`);
      if (hist && hist.episodeIndex === currentIndex && hist.playbackPosition > 0) {
        return hist.playbackPosition;
      }
    }
    return 0;
  }, [searchParams, sourceKey, vodId, currentIndex]);

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
    if (vodId) clearProgress(sourceKey, vodId, currentIndex).catch(() => {});
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
                  title: `${videoTitle}${episodes.length > 1 ? ` 第${currentIndex + 1}集` : ''}`,
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
            <div className="aspect-video bg-black rounded-lg overflow-hidden">
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
                  onNextPrefetchState={setNextPrefetchState}
                  onRequestSwitchSource={vodId ? failover.requestSwitch : undefined}
                  skip={episodeSkip.intro || episodeSkip.outro || episodeSkip.introJump ? episodeSkip : undefined}
                  onUserSeek={learnSkip}
                  prompt={skipPrompt}
                  onNextEpisode={currentIndex + 1 < episodes.length ? () => goEpisode(currentIndex + 1) : undefined}
                  positionRef={positionRef}
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
                        prefetchState={nextPrefetchState}
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
                onClick={() => {
                  // 在片尾附近点「下一集」：当成跳过片尾，记下片尾大概从哪开始
                  const { time, duration: total } = positionRef.current;
                  learnSkip(time, total, total, { viaNextButton: true });
                  goEpisode(currentIndex + 1);
                }}
              >
                下一集
              </button>
              {nextPrefetchState !== 'idle' && currentIndex + 1 < episodes.length && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-emerald-500/15 text-emerald-500 font-medium">
                  <Icon name="bolt" className="w-3 h-3" />
                  {nextPrefetchState === 'done'
                    ? `第 ${currentIndex + 2} 集已预热就绪`
                    : `正在预热第 ${currentIndex + 2} 集…`}
                </span>
              )}
              {duration > 0 && (
                <SkipSettingsRow
                  skip={episodeSkip}
                  learned={learned}
                  audioStatus={audioSkip.status}
                  onAuto={(on) => updateLearned({ auto: on })}
                  onEdit={() => setSkipEditorOpen((v) => !v)}
                  onDistrust={() => {
                    updateLearned({ ignoreRemote: true });
                    toast('这部剧不再用自动找到的时间点（数据库和声音比对），可以点「设置」手动填', 'info');
                  }}
                  onReset={() => {
                    updateLearned(null);
                    saveAudioTemplates(seriesKey, null);
                    toast('已清除这部剧的片头片尾设置', 'info');
                  }}
                />
              )}
              <label className={cn('flex items-center gap-1.5 text-xs text-muted cursor-pointer', !(duration > 0) && 'ml-auto')}>
                <input
                  type="checkbox"
                  className="h-3.5 w-3.5 accent-[#2563eb]"
                  checked={store.autoplayNext}
                  onChange={(e) => store.updateSettings({ autoplayNext: e.target.checked })}
                />
                自动连播
              </label>
            </div>
            {skipEditorOpen && duration > 0 && (
              <SkipEditor
                skip={episodeSkip}
                learned={learned}
                duration={duration}
                positionRef={positionRef}
                onSave={(patch) => {
                  updateLearned({ ...patch, manual: true });
                  setSkipEditorOpen(false);
                  toast('已保存这部剧的片头片尾，每集都按这个来', 'success');
                }}
                onClose={() => setSkipEditorOpen(false)}
              />
            )}
          </div>

          {/* 剧集侧栏 */}
          <aside className="bg-surface-raised rounded-lg p-3 h-fit">
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
                    index={realIndex}
                    active={realIndex === currentIndex}
                    onClick={() => goEpisode(realIndex)}
                  />
                ))}
              </div>
            )}
            <p className="hidden md:block text-[10px] text-faint mt-3 leading-relaxed">
              快捷键：空格 播放/暂停 · ←/→ 快退/快进 5s · ↑/↓ 音量 · F 全屏 · Alt+←/→ 切换集数
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

const VIA_LABEL: Record<SkipVia, string> = { bilibili: 'B站官方', aniskip: 'AniSkip', theintrodb: 'TheIntroDB', audio: '声音比对' };
function sourceLabel(src: SkipSource, seg: { via?: SkipVia }): string {
  if (src === 'manual') return '你手动设的';
  if (src === 'learned') return '你跳过后记下的';
  if (src === 'audio') return '声音比对';
  const via = seg.via ? VIA_LABEL[seg.via] : '数据库';
  return src === 'remote' ? via : `${via}，约略位置，只显示按钮`;
}

/** 播放器下方：这一集的片头片尾在哪、哪来的、自动跳过开关、设置 / 不准 / 重设 */
function SkipSettingsRow({
  skip,
  learned,
  audioStatus,
  onAuto,
  onEdit,
  onDistrust,
  onReset,
}: {
  skip: EpisodeSkip;
  learned?: LearnedSkip;
  audioStatus: AudioSkipStatus;
  onAuto: (on: boolean) => void;
  onEdit: () => void;
  onDistrust: () => void;
  onReset: () => void;
}) {
  const fromRemote = [skip.source.intro, skip.source.outro].some((s) => s === 'remote' || s === 'remote-approx' || s === 'audio');
  const describe = (kind: 'intro' | 'outro') => {
    const name = kind === 'intro' ? '片头' : '片尾';
    const s = skip[kind];
    const src = skip.source[kind];
    if (s && src) return `${name} ${formatTime(s.start)}–${formatTime(s.end)}（${sourceLabel(src, s)}）`;
    if (kind === 'intro' && skip.introJump) return `片头长 ${formatTime(skip.introJump)}（开头附近按「跳过片头」往后跳）`;
    // 两段都没有时不逐条说原因（大多数剧集数据库里都没有），只在另一段有的时候说明这段为什么缺
    const m = skip.intro || skip.outro || skip.introJump ? skip.missing[kind] : undefined;
    if (m === 'none') return `${name}：数据库里还没有这一集`;
    if (m === 'other-version') return `${name}：数据库里的版本对不上`;
    return '';
  };
  const parts = [describe('intro'), describe('outro')].filter(Boolean);
  const linkCls = 'hover:text-content underline-offset-2 hover:underline cursor-pointer';
  const hasOwn = learned && (learned.intro || learned.outro || learned.introLength || learned.ignoreRemote || learned.auto);
  return (
    <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted ml-auto">
      {(skip.intro || skip.outro) && (
        <label className="flex items-center gap-1.5 cursor-pointer" title="这部剧进入片头 / 片尾时自动跳过；关着时只显示按钮">
          <input
            type="checkbox"
            className="h-3.5 w-3.5 accent-[#2563eb]"
            checked={skip.auto}
            onChange={(e) => onAuto(e.target.checked)}
          />
          自动跳过片头片尾
        </label>
      )}
      <span className="text-faint">
        （{parts.length > 0 ? parts.join(' · ') : audioStatus === 'working' ? '正在比对声音找片头片尾…' : '片头片尾还没设'}
        {parts.length > 0 && audioStatus === 'working' && !(skip.intro && skip.outro) ? ' · 正在比对声音…' : ''}
        {' · '}
        <button type="button" className={linkCls} onClick={onEdit}>
          设置
        </button>
        {fromRemote && (
          <>
            {' · '}
            <button type="button" className={linkCls} onClick={onDistrust}>
              不准
            </button>
          </>
        )}
        {hasOwn && (
          <>
            {' · '}
            <button type="button" className={linkCls} onClick={onReset}>
              重设
            </button>
          </>
        )}
        ）
      </span>
    </span>
  );
}

/**
 * 手动设片头片尾：填时间（1:30 / 01:02:03 / 90 都行），或播到那里点「现在」。
 * 片头前的剧情每集长度不一样时，可以只填片头长度：开头附近会显示「跳过片头 1:30」，按下时往后跳这么多。
 * 保存后这部剧每集都按这个来（片尾按离结尾多远记），比 AniSkip 优先。
 */
function SkipEditor({
  skip,
  learned,
  duration,
  positionRef,
  onSave,
  onClose,
}: {
  skip: EpisodeSkip;
  learned?: LearnedSkip;
  duration: number;
  positionRef: React.MutableRefObject<{ time: number; duration: number }>;
  onSave: (patch: Partial<LearnedSkip>) => void;
  onClose: () => void;
}) {
  const fmt = (n?: number) => (typeof n === 'number' ? formatTime(n) : '');
  const [introStart, setIntroStart] = useState(fmt(skip.intro?.start));
  const [introEnd, setIntroEnd] = useState(fmt(skip.intro?.end));
  const [introLength, setIntroLength] = useState(fmt(learned?.introLength));
  const [outroStart, setOutroStart] = useState(fmt(skip.outro?.start));
  const [outroEnd, setOutroEnd] = useState(fmt(skip.outro?.end));
  const [outroToEnd, setOutroToEnd] = useState(!skip.outro || skip.outro.end >= duration - 3);
  const [error, setError] = useState('');
  const [audioOn, setAudioOn] = useState(() => audioSkipEnabled());

  const now = () => formatTime(positionRef.current.time);
  const save = () => {
    const iS = parseClock(introStart);
    const iE = parseClock(introEnd);
    const iL = parseClock(introLength);
    const oS = parseClock(outroStart);
    const oE = outroToEnd ? duration : parseClock(outroEnd);
    const bad = (text: string) => setError(text);
    if ((introStart.trim() && iS === undefined) || (introEnd.trim() && iE === undefined)) return bad('片头时间看不懂，用 1:30 这样的格式');
    if ((iS === undefined) !== (iE === undefined)) return bad('片头要填开始和结束两个时间（或只填片头长度）');
    if (iS !== undefined && iE !== undefined && !(iE > iS && iE - iS <= 600 && iE <= duration)) return bad('片头结束要在开始之后，且不超过 10 分钟');
    if (introLength.trim() && (iL === undefined || iL < 5 || iL > 600)) return bad('片头长度填 5 秒到 10 分钟之间，比如 1:30');
    if (outroStart.trim() && oS === undefined) return bad('片尾时间看不懂，用 22:15 这样的格式');
    if (!outroToEnd && outroEnd.trim() && oE === undefined) return bad('片尾结束时间看不懂');
    if (oS !== undefined && (oE === undefined || !(oE > oS) || oE > duration)) return bad('片尾结束要在开始之后，且不超过这一集的长度');
    setError('');
    onSave({
      intro: iS !== undefined && iE !== undefined ? { start: iS, end: iE } : undefined,
      introLength: iS === undefined && iL ? iL : undefined,
      outro:
        oS !== undefined && oE !== undefined
          ? { fromEnd: Math.round(duration - oS), toEnd: outroToEnd ? 0 : Math.round(duration - oE) }
          : undefined,
    });
  };

  const field = (label: string, value: string, set: (v: string) => void, disabled = false) => (
    <label className="flex items-center gap-1.5">
      <span className="text-faint">{label}</span>
      <input
        value={value}
        onChange={(e) => set(e.target.value)}
        disabled={disabled}
        placeholder="0:00"
        inputMode="numeric"
        className="w-16 px-2 py-1 rounded-md bg-surface border border-line text-content text-xs disabled:opacity-40"
      />
      {!disabled && (
        <button type="button" className="text-accent hover:underline" onClick={() => set(now())} title="填入现在播放到的位置">
          现在
        </button>
      )}
    </label>
  );

  return (
    <div className="mt-3 rounded-xl border border-line bg-surface-raised p-3 sm:p-4 space-y-3 text-xs text-muted">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-content">设置这部剧的片头片尾</h3>
        <button type="button" className="text-faint hover:text-content" onClick={onClose}>
          收起
        </button>
      </div>
      <p className="text-faint leading-relaxed">
        填时间（如 1:30），或者播到那个位置点「现在」。片尾按离结尾多远记，每集长度差几秒也对得上。保存后比数据库（B站 / AniSkip / TheIntroDB）优先。
      </p>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="w-8 font-medium text-content">片头</span>
          {field('开始', introStart, setIntroStart)}
          {field('结束', introEnd, setIntroEnd)}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pl-12">
          <label className="flex items-center gap-1.5">
            <span className="text-faint">或只填长度</span>
            <input
              value={introLength}
              onChange={(e) => setIntroLength(e.target.value)}
              placeholder="1:30"
              className="w-16 px-2 py-1 rounded-md bg-surface border border-line text-content text-xs"
            />
          </label>
          <span className="text-faint">片头前的剧情每集长短不一时用：开头附近显示「跳过片头 1:30」，片头开始时按一下</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="w-8 font-medium text-content">片尾</span>
          {field('开始', outroStart, setOutroStart)}
          {field('结束', outroEnd, setOutroEnd, outroToEnd)}
          <label className="flex items-center gap-1.5 cursor-pointer">
            <input type="checkbox" className="h-3.5 w-3.5 accent-[#2563eb]" checked={outroToEnd} onChange={(e) => setOutroToEnd(e.target.checked)} />
            一直到结尾（片尾后没有剧情）
          </label>
        </div>
      </div>
      <label className="flex items-start gap-1.5 cursor-pointer">
        <input
          type="checkbox"
          className="mt-0.5 h-3.5 w-3.5 accent-[#2563eb]"
          checked={audioOn}
          onChange={(e) => {
            setAudioOn(e.target.checked);
            setAudioSkipEnabled(e.target.checked);
          }}
        />
        <span>
          后台比对声音自动找片头片尾（所有剧都适用）
          <span className="block text-faint">
            每部剧第一次会多下载另一集开头 / 结尾几分钟（约几十 MB），之后每集只用本集的；用手机流量时可以关掉
          </span>
        </span>
      </label>
      {error && <p className="text-danger">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="button" className="btn-primary btn-sm" onClick={save}>
          保存
        </button>
        <button type="button" className="btn-ghost btn-sm" onClick={onClose}>
          取消
        </button>
      </div>
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
function EpisodeButton({ index, active, onClick }: { index: number; active: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <button
      ref={ref}
      className={cn('btn btn-sm !px-1', active ? 'episode-active' : 'btn-ghost')}
      onClick={onClick}
    >
      {index + 1}
    </button>
  );
}

function BackButton() {
  const router = useRouter();
  return (
    <button
      className="p-2 -ml-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
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
      className="p-2 rounded-md text-muted hover:text-content hover:bg-hover transition-colors"
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
  prefetchState,
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
  prefetchState: 'idle' | 'running' | 'done';
  onPlayNow: () => void;
  onCancelCountdown: () => void;
  onDismiss: () => void;
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);

  const nextEpNum = state.nextIndex + 1;

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
                className="w-16 sm:w-20 aspect-[2/3] rounded-lg object-cover bg-slate-800 shrink-0 shadow-md"
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
              {prefetchState !== 'idle' && (
                <p className="text-[11px] text-emerald-400 flex items-center gap-1">
                  <Icon name="bolt" className="w-3.5 h-3.5" />
                  <span>下一集已预热完毕，点按即可秒播</span>
                </p>
              )}
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
              className="relative w-16 sm:w-20 aspect-[2/3] rounded-lg overflow-hidden bg-slate-800 shrink-0 shadow-md cursor-pointer group"
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
              {prefetchState !== 'idle' && (
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/20 text-emerald-300">
                  <Icon name="bolt" className="w-3 h-3" />
                  {prefetchState === 'done' ? '已预热' : '预热中'}
                </span>
              )}
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

