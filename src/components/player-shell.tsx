'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Artplayer from 'artplayer';
import Hls, { type HlsConfig } from 'hls.js';

import { PlaybackRecovery, describeHlsError } from '@/lib/playback-recovery';
import { createHlsLoader } from '@/lib/hls-loader';
import {
  getVideoPrefetcher,
  getNextEpisodePrefetcher,
} from '@/lib/video-prefetcher';
import { loadCacheSettings } from '@/lib/video-cache';
import { cn, formatTime } from '@/lib/utils';
import type { SkipSegment } from '@/lib/skip-segment';
import { PLAYBACK_RATES, SEEK_STEPS, loadPlayerPrefs, savePlayerPrefs } from '@/lib/player-prefs';
import { recordPlaybackFail, recordPlaybackStart, recordStall } from '@/lib/playback-stats';

/**
 * 播放器外壳：ArtPlayer + hls.js（旧版 player.js 的 React 化）。
 * 保留：广告分片过滤、自动连播回调、进度回调、快捷键、移动端长按倍速、错误恢复。
 * 控制栏：快退 / 快进 N 秒（N 在设置里选，← → 键同步）、倍速（换集后保持）。
 * 移除：DOM 手工操作、watch.html 跳转链、localStorage 状态总线。
 *
 * 关键设计：ArtPlayer 实例只在挂载时创建一次，换集（url 变化）只「切换 HLS 源」
 * 而不销毁重建。否则在「网页全屏（页面全屏）」下整实例重建会丢失全屏上下文、
 * 重建 <video> 元素，触发「黑屏有声」的渲染竞态。
 */

/** 长按画面时的速度 */
const LONG_PRESS_RATE = 2;
/** 片尾时长不知道时，最后这么多秒出「下一集」卡 */
const UP_NEXT_FALLBACK_SECONDS = 15;
/** 「下一集」卡出来后，开了自动连播的倒数秒数 */
const UP_NEXT_COUNTDOWN = 10;
/** 手指从画面左边滑到右边 = 快进这么多秒 */
const SWIPE_SEEK_SPAN = 120;

// 手机上双击画面交给我们处理（左右快退快进、中间播放暂停），不用 ArtPlayer 自带的「双击暂停」
Artplayer.MOBILE_DBCLICK_PLAY = false;

/** 开了自动跳过时，进入片头 / 片尾后先倒数几秒再跳 */
const AUTO_SKIP_SECONDS = 5;

/** 开播后连续卡住这么久就换源 */
const STALL_TIMEOUT_MS = 25_000;
/** 换到新地址后这么久还没开始播就换源（含直连失败改走代理的时间） */
const START_TIMEOUT_MS = 35_000;

interface PlayerShellProps {
  url: string;
  title: string;
  adFilter: boolean;
  autoplayNext: boolean;
  /** 剧集标识 `${source}:${vodId}:${episodeIndex}`（片段缓存按集淘汰的分组键） */
  episodeKey?: string;
  /** 下一集 m3u8 地址：当前集预取完成后预热下一集前 7 分钟 */
  nextUrl?: string;
  nextEpisodeKey?: string;
  /** 进度恢复：优先 URL position，其次查询该回调（返回 0 表示无记录） */
  getRestorePosition?: () => number | Promise<number>;
  onTimeUpdate?: (position: number, duration: number) => void;
  onEnded?: () => void;
  onPause?: (position: number, duration: number) => void;
  /**
   * 这个源播不了时回调（重试耗尽 / 格式硬失败 / 卡住太久 / 起播太久），父级自动换源。
   * 每集最多回调一次；提供了它就不再显示「请尝试其他视频源」的错误遮罩。
   */
  onRequestSwitchSource?: (reason: string, position: number) => void;
  /** 下一集预热状态回调：用于在下一集倒计时大卡上展示「已预热下一集」 */
  onNextPrefetchState?: (state: 'idle' | 'running' | 'done') => void;
  /** 播放器表面浮层（如播完时的下一集倒计时大卡、「还在看吗？」询问卡），支持全屏内展示 */
  overlay?: React.ReactNode;
  /** 这一集的片头片尾（绝对秒数）；auto = 进入区间倒数后自动跳，否则只显示按钮 */
  skip?: { intro?: SkipSegment; outro?: SkipSegment; auto: boolean };
  /** 你手动标的广告位置：播到就自动跳过 */
  adSkips?: SkipSegment[];
  /** 片尾一直到结尾时，「跳过片尾」直接进下一集；auto = 「下一集」卡倒数完自动切的 */
  onNextEpisode?: (opts?: { auto?: boolean }) => void;
  /** 实时的播放位置（父级点「下一集」时用来记片尾位置） */
  positionRef?: React.MutableRefObject<{ time: number; duration: number }>;
  /** 「下一集」预览卡上的文字，如「第 5 集」 */
  nextTitle?: string;
}

export function PlayerShell({
  url,
  title,
  adFilter,
  autoplayNext,
  episodeKey,
  nextUrl,
  nextEpisodeKey,
  getRestorePosition,
  onTimeUpdate,
  onEnded,
  onPause,
  onRequestSwitchSource,
  onNextPrefetchState,
  overlay,
  skip,
  adSkips,
  onNextEpisode,
  positionRef,
  nextTitle,
}: PlayerShellProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [overlayHost, setOverlayHost] = useState<HTMLDivElement | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const artRef = useRef<any>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [error, setError] = useState('');
  const [hint, setHint] = useState('');
  // 起播前的品牌占位图（沿用旧版 nomedia 素材），实际开始播放后隐藏
  const [showPoster, setShowPoster] = useState(true);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 始终持有最新 props/回调，避免重建播放器
  const propsRef = useRef({
    url, title, adFilter, autoplayNext, episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onRequestSwitchSource, onNextPrefetchState,
    skip, onNextEpisode, positionRef, adSkips, overlay,
  });
  propsRef.current = {
    url, title, adFilter, autoplayNext, episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onRequestSwitchSource, onNextPrefetchState,
    skip, onNextEpisode, positionRef, adSkips, overlay,
  };

  // 跨集共享、每次换集重置的播放链路状态
  // 媒体健康度：音频轨可播不代表视频轨正常（「黑屏但有声」的假死态）。
  // 仅当有分片真正进入 MSE buffer 后才视为恢复，错误遮罩才能被清除。
  const mediaHealthyRef = useRef(true);
  const playbackStartedRef = useRef(false);
  // 起播阶段的 video 元素级错误允许自愈重试一次（重建 hls/MSE）
  const videoErrorRetryUsedRef = useRef(false);
  // 这一集上次看到的位置：每集只查一次，之后每次重建（代理回退 / 出错重试 / 挂载时的重复调用）都用同一个结果
  const restoreRef = useRef<Promise<number | null> | null>(null);
  // timeupdate 续跑预取的游标：必须按集清零，否则会沿用上一集的时间戳推迟首次续跑
  const lastPrefetchEnsureRef = useRef(0);
  // setupHls 可能改走代理形式，video:error 重试要用最近一次的地址
  const currentMediaUrlRef = useRef(url);
  // 本集的恢复策略实例：跨直连/代理两级重建共享计数
  const recoveryRef = useRef<PlaybackRecovery | null>(null);
  // 自然播完标记，卸载时不回写进度（避免覆盖「已看完」记录）
  const endedRef = useRef(false);
  // 本集已经请求过换源（只请求一次，换源中不再重复触发）
  const switchRequestedRef = useRef(false);
  // 卡顿 / 起播看门狗
  const stallTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 跳过片头片尾：当前落在哪一段、这一集已经跳过哪些（自动跳过只跳一次，往回拖不会再跳）
  const [activeSkip, setActiveSkip] = useState<'intro' | 'outro' | null>(null);
  const skippedRef = useRef(new Set<'intro' | 'outro'>());
  // 自动跳过的倒数：进入片头 / 片尾后先倒数几秒（按播放时间），到了才跳
  const autoPendingRef = useRef<{ kind: 'intro' | 'outro'; at: number } | null>(null);
  const [autoLeft, setAutoLeft] = useState<number | null>(null);
  // 长按加速中
  const [holdFast, setHoldFast] = useState(false);
  // 「下一集」预览卡：left = 还有几秒自动播（没开自动连播是 null）
  const [upNext, setUpNext] = useState<{ left: number | null } | null>(null);
  const upNextDismissedRef = useRef(false);
  // 滑动手势进行中的提示（拖进度 / 亮度 / 音量）
  const [gestureHint, setGestureHint] = useState<string | null>(null);
  // 画面亮度（手势调的，换集保持）
  const brightnessRef = useRef(1);
  // 双击快退 / 快进的提示：方向 + 这一串连点累计的秒数
  const [tapSeekInfo, setTapSeekInfo] = useState<{ dir: -1 | 1; seconds: number; id: number } | null>(null);
  const tapSeekTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 这一集要从哪里开始播（上次看到的位置）；开始播放后清掉
  const startAtRef = useRef<number | null>(null);
  // setupHls 要先异步查进度：旧的一轮查完时已经换了别的地址就作废
  const setupSeqRef = useRef(0);
  // 「已从 12:34 继续播放 · 从头播放」小条
  const [resumedFrom, setResumedFrom] = useState<number | null>(null);
  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 当前 <video> 里放的是哪一集：换集时父级先换了 props、播放器后换地址，
  // 这中间触发的 timeupdate / pause 是上一集的位置，不能记到新的一集上
  const loadedKeyRef = useRef<string | undefined>(undefined);

  // 这一集从什么时候开始加载（记起播耗时）；记过了就清掉
  const loadStartedAtRef = useRef(0);
  /** 当前这一集是哪个点播源（episodeKey 的第一段） */
  const currentSourceKey = () => propsRef.current.episodeKey?.split(':')[0] ?? '';

  /** 现在报的进度是不是这一集的、而且真的开播了（没开播时位置是 0，会盖掉上次看到的位置） */
  const canReport = () => playbackStartedRef.current && loadedKeyRef.current === propsRef.current.episodeKey;

  /**
   * 「下一集」预览卡：片尾开始（片尾一直到结尾时用片尾起点，否则最后 15 秒）就出来；
   * 开了自动连播按播放时间倒数 10 秒切下一集（这一集记成看完），没开只给按钮。往回拖到片尾前收起。
   */
  const updateUpNext = (t: number, d: number) => {
    const p = propsRef.current;
    if (!p.nextUrl || !p.onNextEpisode || p.overlay || upNextDismissedRef.current || !(d > 60)) {
      setUpNext((prev) => (prev === null ? prev : null));
      return;
    }
    const outro = p.skip?.outro;
    const creditsStart = outro && outro.end >= d - 3 && outro.start > d * 0.5 ? outro.start : d - UP_NEXT_FALLBACK_SECONDS;
    if (t < creditsStart) {
      setUpNext((prev) => (prev === null ? prev : null));
      return;
    }
    const left = p.autoplayNext ? Math.ceil(Math.min(creditsStart + UP_NEXT_COUNTDOWN, d) - t) : null;
    if (left !== null && left <= 0) {
      setUpNext(null);
      upNextDismissedRef.current = true;
      playNextNow(true);
      return;
    }
    setUpNext((prev) => (prev && prev.left === left ? prev : { left }));
  };

  /** 现在就放下一集：这一集记成看完（位置 = 总长），卸载时不再回写进度 */
  const playNextNow = (auto = false) => {
    const art = artRef.current;
    const p = propsRef.current;
    if (art && art.duration > 0 && canReport()) p.onPause?.(art.duration, art.duration);
    endedRef.current = true;
    p.onNextEpisode?.({ auto });
  };

  const seekTo = (time: number) => {
    const art = artRef.current;
    if (!art) return;
    art.currentTime = time;
  };

  /** 往前 / 往后跳一步（步长在设置里选） */
  const seekBy = (dir: -1 | 1) => {
    const art = artRef.current;
    if (!art) return;
    const step = loadPlayerPrefs().seekStep;
    const d = art.duration || 0;
    const target = Math.max(0, Math.min(art.currentTime + dir * step, d > 0 ? d - 0.5 : Infinity));
    seekTo(target);
    showHint(`${dir < 0 ? '快退' : '快进'} ${step} 秒`);
  };

  /** 双击两侧：跳一步，提示里累计这一串连点一共跳了多少 */
  const tapSeek = (dir: -1 | 1) => {
    const art = artRef.current;
    if (!art) return;
    const step = loadPlayerPrefs().seekStep;
    const d = art.duration || 0;
    seekTo(Math.max(0, Math.min(art.currentTime + dir * step, d > 0 ? d - 0.5 : Infinity)));
    setTapSeekInfo((prev) => ({ dir, seconds: prev && prev.dir === dir ? prev.seconds + step : step, id: Date.now() }));
    if (tapSeekTimerRef.current) clearTimeout(tapSeekTimerRef.current);
    tapSeekTimerRef.current = setTimeout(() => setTapSeekInfo(null), 700);
  };

  const setRate = (rate: number) => {
    const art = artRef.current;
    if (!art) return;
    savePlayerPrefs({ rate });
    art.video.defaultPlaybackRate = rate;
    art.playbackRate = rate;
    const el = controlEl(art, 'rate');
    if (el) {
      // 控制栏上的倍速按钮：文字 + 选中项
      const label = el.querySelector('.art-selector-value') ?? el.firstElementChild ?? el;
      if (label) label.textContent = rateLabel(rate);
      el.querySelectorAll<HTMLElement>('.art-selector-item').forEach((it) => it.classList.toggle('art-current', Number(it.dataset.value) === rate));
    }
    showHint(rate === 1 ? '正常速度' : `${rate} 倍速`);
  };

  const doSkip = (kind: 'intro' | 'outro', auto: boolean) => {
    const art = artRef.current;
    const seg = kind === 'intro' ? propsRef.current.skip?.intro : propsRef.current.skip?.outro;
    if (!art || !seg) return;
    skippedRef.current.add(kind);
    setActiveSkip(null);
    const duration = art.duration || 0;
    if (kind === 'outro' && duration > 0 && seg.end >= duration - 3) {
      // 片尾一直到结尾：自动跳就当这一集播完了（走下一集倒数）；手动点就直接下一集
      if (auto) {
        endedRef.current = true;
        propsRef.current.onEnded?.();
      } else if (propsRef.current.nextUrl && propsRef.current.onNextEpisode) {
        propsRef.current.onNextEpisode();
      } else {
        seekTo(Math.max(0, duration - 0.5));
      }
      return;
    }
    seekTo(seg.end);
    showHint(`${auto ? '已自动跳过' : '已跳过'}${kind === 'intro' ? '片头' : '片尾'}`);
  };

  /** 这个源播不了：交给父级换源；父级没接就显示错误遮罩 */
  const giveUp = (reason: string, fallbackError: string) => {
    clearWatchdogs();
    const cb = propsRef.current.onRequestSwitchSource;
    if (!cb) {
      setError(fallbackError);
      return;
    }
    if (switchRequestedRef.current) return;
    switchRequestedRef.current = true;
    recordPlaybackFail(currentSourceKey());
    hlsRef.current?.stopLoad();
    showHint(`${reason}，正在换源…`);
    // 还没开播就失败：位置是 0，换源后要接着的是本来打算恢复的位置
    cb(reason, playbackStartedRef.current ? (artRef.current?.currentTime ?? 0) : (startAtRef.current ?? 0));
  };

  const clearWatchdogs = () => {
    if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
    if (startTimerRef.current) clearTimeout(startTimerRef.current);
    stallTimerRef.current = null;
    startTimerRef.current = null;
  };

  /** 起播看门狗：换到新地址后这么久还没开始播，就算这个源不行 */
  const armStartWatchdog = () => {
    if (startTimerRef.current) clearTimeout(startTimerRef.current);
    startTimerRef.current = setTimeout(() => {
      // 浏览器挡了自动播放时画面已经加载好、只是停着：不算源的问题
      const loaded = (artRef.current?.video?.readyState ?? 0) >= 2;
      if (!playbackStartedRef.current && !loaded) giveUp(`${START_TIMEOUT_MS / 1000} 秒还没开始播放`, '视频加载超时，请尝试其他视频源');
    }, START_TIMEOUT_MS);
  };

  const showHint = (text: string) => {
    setHint(text);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(''), 2500);
  };

  // 片段缓存开启时调大 hls.js 自身缓冲，缓冲之外的空窗由预取器补齐
  const buildHlsConfig = (): Partial<HlsConfig> => {
    const p = propsRef.current;
    const cacheSettings = loadCacheSettings();
    const cacheEnabled = cacheSettings.enabled && !!p.episodeKey;
    return {
      debug: false,
      enableWorker: true,
      backBufferLength: 90,
      maxBufferLength: cacheEnabled ? 120 : 30,
      maxMaxBufferLength: cacheEnabled ? 600 : 60,
      maxBufferSize: (cacheEnabled ? 90 : 30) * 1000 * 1000,
      maxBufferHole: 0.5,
      fragLoadingMaxRetry: 6,
      fragLoadingRetryDelay: 1000,
      manifestLoadingMaxRetry: 3,
      manifestLoadingRetryDelay: 1000,
      startLevel: -1,
      abrEwmaDefaultEstimate: 500_000,
      appendErrorMaxRetry: 5,
      // 组合 loader：广告过滤（blockAd 随设置）+ 片段缓存命中（cacheEnabled）
      loader: createHlsLoader(Hls, { blockAd: p.adFilter }) as unknown as HlsConfig['loader'],
    };
  };

  const warmNextEpisode = () => {
    const p = propsRef.current;
    if (!p.nextUrl || !p.nextEpisodeKey) return;
    getNextEpisodePrefetcher().ensure({
      m3u8Url: p.nextUrl,
      currentTime: 0,
      episodeKey: p.nextEpisodeKey,
      horizonSeconds: 420,
      onProgress: (nextStats) => {
        if (nextStats.state === 'running' || nextStats.state === 'done') {
          propsRef.current.onNextPrefetchState?.(nextStats.state);
        }
      },
    });
  };

  // 当前集预取（episodeKey 缺省 = 关闭，见 ensure 内部 settings.enabled 判断）
  const ensurePrefetch = (mediaUrl: string, currentTime: number, horizonSeconds?: number) => {
    const p = propsRef.current;
    if (!p.episodeKey) return;
    getVideoPrefetcher().ensure({
      m3u8Url: mediaUrl,
      currentTime,
      episodeKey: p.episodeKey,
      horizonSeconds,
      onProgress: (stats) => {
        // 当前集预取完成且存在下一集：用独立预取器预热下一集前 7 分钟
        if (stats.state === 'done') {
          warmNextEpisode();
        }
      },
    });
  };

  /**
   * 初始化/切换 HLS。allowProxyFallback：直连致命网络错误（CORS/防盗链/分片被拒）时，
   * 自动改走同源 cookie 鉴权的 /api/proxy 重试一次。
   * 注意：不销毁 ArtPlayer，只销毁并重建 hls，从而保留网页全屏等播放器状态。
   */
  const setupHls = async (video: HTMLVideoElement, mediaUrl: string, allowProxyFallback: boolean) => {
    const seq = ++setupSeqRef.current;
    // 播到一半重建（改走代理 / 出错重试）：从刚才的位置接着放，不回到开头。destroy 之后就读不到了
    const resumeFrom = playbackStartedRef.current && video.currentTime > 1 ? video.currentTime : null;
    hlsRef.current?.destroy();
    hlsRef.current = null;
    currentMediaUrlRef.current = mediaUrl;
    // 进度恢复：先查上次看到哪里，再让 hls.js 直接从那里开始加载。
    // 以前是 MANIFEST_PARSED 时 seek，那时 video.duration 多半还没有，判断「位置有效」失败就从头播了
    let startPosition = resumeFrom ?? -1;
    if (resumeFrom === null && !playbackStartedRef.current) {
      if (!restoreRef.current) {
        restoreRef.current = Promise.resolve()
          .then(() => propsRef.current.getRestorePosition?.() ?? 0)
          .then((saved) => (saved > 10 ? saved : null))
          .catch(() => null);
      }
      const startAt = await restoreRef.current;
      if (seq !== setupSeqRef.current) return;
      startAtRef.current = startAt;
      if (startAt !== null) startPosition = startAt;
    }

    if (!Hls.isSupported()) {
      // 没有 MSE（旧版 iOS）：交给系统自带的 HLS 播放（去广告不生效）
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = mediaUrl;
        if (startPosition > 0) {
          video.addEventListener('loadedmetadata', () => { video.currentTime = startPosition; }, { once: true });
        }
        video.play().catch(() => {});
      } else {
        setError('这个浏览器播放不了这种视频，请换 Chrome / Safari / Edge 试试');
      }
      return;
    }

    const hls = new Hls({ ...buildHlsConfig(), startPosition });
    hlsRef.current = hls;

    hls.loadSource(mediaUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      recoveryRef.current?.markHealthy();
      // 新集立即预取（否则要等 timeupdate 的 30s 节流，起播初期无缓存）。
      // 锚点直接用起播位置：Safari 系 video.currentTime 未必已经反映
      ensurePrefetch(mediaUrl, startPosition > 0 ? startPosition : video.currentTime);
      video.play().catch(() => {});
    });
    // 播放链路恢复（FRAG_LOADED / MANIFEST_PARSED）：静默窗外清零连续失败计数
    hls.on(Hls.Events.FRAG_LOADED, () => recoveryRef.current?.markHealthy());
    // 分片真正进入 MSE buffer 才算媒体恢复：此时视频轨可渲染，错误态可解除
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      mediaHealthyRef.current = true;
    });

    hls.on(Hls.Events.ERROR, (_evt, data) => {
      if (!data.fatal) return;
      const recovery = recoveryRef.current;
      if (!recovery) return;
      const decision = recovery.onFatal(data.type, data.details);
      switch (decision.action) {
        case 'ignore':
          break;
        case 'retry': {
          // 前两次重试保留直连；达到退避阈值或清单级错误时升级为代理形式
          // （同源 cookie 鉴权，规避 CORS/防盗链/分片被拒）
          if (
            allowProxyFallback &&
            !mediaUrl.startsWith('/api/proxy') &&
            (decision.attempt >= 2 || data.details === 'manifestLoadError')
          ) {
            showHint('直连失败，改用代理重试...');
            void setupHls(video, `/api/proxy?url=${encodeURIComponent(mediaUrl)}`, false);
            return;
          }
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          recovery.schedule(decision.delayMs, () => hls.startLoad());
          break;
        }
        case 'recover-media': {
          showHint(`${decision.reason}（第 ${decision.attempt} 次）...`);
          if (decision.swapAudio) hls.swapAudioCodec?.();
          hls.recoverMediaError();
          break;
        }
        case 'switch-source': {
          // 覆盖播放开始后的场景：起播失败走 setError 遮罩；
          // 播放中失败走回调弹换源面板（父级未提供回调时同样 setError）
          const message = `${describeHlsError(data.type, data.details)}：${decision.reason}`;
          giveUp(describeHlsError(data.type, data.details), `视频加载失败，${message}，请尝试其他视频源`);
          break;
        }
      }
    });
  };

  /**
   * 换集：重置每集状态并切换到新 HLS 源（不重建 ArtPlayer）。
   * resumeAt：同一集重新加载（如切换去广告）时从这个位置接着放，不再查记录。
   */
  const loadEpisode = (targetUrl: string, resumeAt?: number) => {
    if (!targetUrl) return;
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    loadedKeyRef.current = propsRef.current.episodeKey;
    loadStartedAtRef.current = resumeAt === undefined ? Date.now() : 0;
    startAtRef.current = null;
    restoreRef.current = resumeAt !== undefined ? Promise.resolve(resumeAt > 1 ? resumeAt : null) : null;
    setResumedFrom(null);
    lastPrefetchEnsureRef.current = 0;
    recoveryRef.current = new PlaybackRecovery();
    endedRef.current = false;
    switchRequestedRef.current = false;
    skippedRef.current = new Set();
    upNextDismissedRef.current = false;
    setUpNext(null);
    autoPendingRef.current = null;
    setAutoLeft(null);
    setActiveSkip(null);
    clearWatchdogs();
    armStartWatchdog();
    // 换集时清掉上一集的预取窗口，避免带宽被旧集占用
    getVideoPrefetcher().stop();
    propsRef.current.onNextPrefetchState?.('idle');
    setError('');
    setShowPoster(true);
    const art = artRef.current;
    if (!art) return;
    void setupHls(art.video, targetUrl, true);
  };

  // —— 创建播放器（仅一次，挂载即创建） ——
  useEffect(() => {
    if (!containerRef.current || !propsRef.current.url) return;
    const initialUrl = propsRef.current.url;

    // 初始化每集状态
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoreRef.current = null;
    startAtRef.current = null;
    loadedKeyRef.current = propsRef.current.episodeKey;
    loadStartedAtRef.current = Date.now();
    recoveryRef.current = new PlaybackRecovery();
    endedRef.current = false;
    switchRequestedRef.current = false;
    armStartWatchdog();
    propsRef.current.onNextPrefetchState?.('idle');

    let lastSave = 0;

    const prefs = loadPlayerPrefs();
    // iPhone 没有「整个元素全屏」，ArtPlayer 的全屏会交给系统播放器，我们的「跳过片头」等按钮就看不到了。
    // 这种设备上全屏键改成网页全屏（铺满屏幕，按手机当前的方向：竖着就竖屏全屏，转过来就是横屏），按钮照样在画面上
    const elementFullscreen = Boolean(
      document.fullscreenEnabled || (document as unknown as { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled,
    );
    const art = new Artplayer({
      container: containerRef.current,
      url: initialUrl,
      type: 'm3u8',
      volume: 0.8,
      autoplay: true,
      pip: true,
      autoMini: true,
      screenshot: true,
      setting: true,
      aspectRatio: true,
      fullscreen: elementFullscreen,
      fullscreenWeb: true,
      // 不自动把画面转成横向（用户：竖着按全屏不要直接变横屏）；想横屏就转手机，fixed 铺满会跟着变
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: true,
      hotkey: false,
      // 手机上左边的小锁：锁住后点画面不出控制栏、不响应手势，躺着看不怕误触
      lock: true,
      // ArtPlayer 自带的左右滑拖进度关掉：滑动手势（进度 / 亮度 / 音量）由我们自己处理
      gesture: false,
      theme: '#0a84ff',
      lang: navigator.language.toLowerCase().startsWith('zh') ? 'zh-cn' : 'en',
      moreVideoAttr: { crossOrigin: 'anonymous', playsInline: true },
      controls: [
        {
          name: 'seek-back',
          position: 'left',
          index: 11,
          html: seekIcon(-1, prefs.seekStep),
          tooltip: `快退 ${prefs.seekStep} 秒`,
          click: () => seekBy(-1),
        },
        {
          name: 'seek-forward',
          position: 'left',
          index: 12,
          html: seekIcon(1, prefs.seekStep),
          tooltip: `快进 ${prefs.seekStep} 秒`,
          click: () => seekBy(1),
        },
        {
          name: 'rate',
          position: 'right',
          index: 5,
          html: rateLabel(prefs.rate),
          selector: [...PLAYBACK_RATES].reverse().map((r) => ({ html: r === 1 ? '正常' : `${r}x`, value: r, default: r === prefs.rate })),
          onSelect: (item) => {
            setRate(Number(item.value));
            return rateLabel(Number(item.value));
          },
        },
        ...(elementFullscreen
          ? []
          : [
              {
                name: 'fullscreen-page',
                position: 'right' as const,
                index: 80,
                html: fullscreenIcon(false),
                tooltip: '全屏',
                click: () => {
                  const current = artRef.current;
                  if (!current) return;
                  const video = current.video as HTMLVideoElement & { webkitEnterFullscreen?: () => void };
                  if (loadPlayerPrefs().systemFullscreen && !current.fullscreenWeb && video.webkitEnterFullscreen) {
                    video.webkitEnterFullscreen();
                    return;
                  }
                  current.fullscreenWeb = !current.fullscreenWeb;
                },
              },
            ]),
      ],
      settings: [
        {
          name: 'auto-skip',
          html: '自动跳过片头片尾',
          tooltip: prefs.autoSkip ? '开' : '关',
          switch: prefs.autoSkip,
          onSwitch: (item) => {
            const next = !item.switch;
            savePlayerPrefs({ autoSkip: next });
            item.tooltip = next ? '开' : '关';
            showHint(next ? '片头片尾会倒数 5 秒后自动跳过' : '片头片尾只显示「跳过」按钮');
            return next;
          },
        },
        {
          name: 'audio-skip',
          html: '识别片头片尾',
          tooltip: prefs.audioSkip ? '开' : '关',
          switch: prefs.audioSkip,
          onSwitch: (item) => {
            const next = !item.switch;
            savePlayerPrefs({ audioSkip: next });
            item.tooltip = next ? '开' : '关';
            showHint(next ? '会在后台比对前后几集，找出片头片尾' : '不再识别片头片尾（省流量）');
            return next;
          },
        },
        ...(elementFullscreen
          ? []
          : [
              {
                name: 'fullscreen-mode',
                html: '全屏方式',
                tooltip: prefs.systemFullscreen ? '系统播放器' : '网页全屏',
                selector: [
                  { html: '网页全屏（有跳过按钮）', value: 'page', default: !prefs.systemFullscreen },
                  { html: '系统播放器（收起状态栏）', value: 'system', default: prefs.systemFullscreen },
                ],
                onSelect: (item: { html: string; value?: string }) => {
                  const system = item.value === 'system';
                  savePlayerPrefs({ systemFullscreen: system });
                  showHint(system ? '全屏用系统播放器：没有跳过按钮，自动跳过照常' : '全屏用网页全屏：跳过按钮都在');
                  return system ? '系统播放器' : '网页全屏';
                },
              },
            ]),
        {
          name: 'seek-step',
          html: '快进快退',
          tooltip: `${prefs.seekStep} 秒`,
          selector: SEEK_STEPS.map((n) => ({ html: `${n} 秒`, value: n, default: n === prefs.seekStep })),
          onSelect: (item) => {
            const step = Number(item.value);
            savePlayerPrefs({ seekStep: step });
            for (const dir of [-1, 1] as const) {
              const el = controlEl(artRef.current, dir < 0 ? 'seek-back' : 'seek-forward');
              if (el) {
                el.innerHTML = seekIcon(dir, step);
                el.setAttribute('aria-label', `${dir < 0 ? '快退' : '快进'} ${step} 秒`);
              }
            }
            return item.html;
          },
        },
      ],
      customType: {
        m3u8: (video: HTMLVideoElement, mediaUrl: string) => {
          void setupHls(video, mediaUrl, true);
        },
      },
    });
    artRef.current = art;

    // 浮层宿主挂在 ArtPlayer 的 $player 里：全屏 / 网页全屏的就是这个元素，
    // 挂在外面的话一全屏「跳过片头」、下一集倒数卡、提示就都看不到了
    const host = document.createElement('div');
    host.className = 'player-overlay-host pointer-events-none absolute inset-0 z-[160] flex items-center justify-center';
    art.template.$player.appendChild(host);
    setOverlayHost(host);

    // 网页全屏：锁住页面滚动
    art.on('fullscreenWeb', (on: boolean) => {
      document.documentElement.style.overflow = on ? 'hidden' : '';
      const el = controlEl(art, 'fullscreen-page');
      if (el) el.innerHTML = fullscreenIcon(on);
    });

    art.on('video:loadedmetadata', () => {
      // 换集（换了媒体源）后浏览器会把速度重置成默认值：按你选的速度来
      const rate = loadPlayerPrefs().rate;
      art.video.defaultPlaybackRate = rate;
      if (art.video.playbackRate !== rate) art.video.playbackRate = rate;
      // ArtPlayer 运行时支持 title 选项（类型定义未覆盖），用于界面标题展示
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (art as any).title = propsRef.current.title;
      } catch { /* 忽略 */ }
    });

    art.on('video:playing', () => {
      playbackStartedRef.current = true;
      clearWatchdogs();
      setShowPoster(false);
      // 这个源这次起播花了多久、画面多高：以后排序和自动换源参考（playback-stats）
      if (loadStartedAtRef.current) {
        recordPlaybackStart(currentSourceKey(), Date.now() - loadStartedAtRef.current, art.video.videoHeight);
        loadStartedAtRef.current = 0;
      }
      // 从上次的位置接着播：提示一下，给个「从头播放」
      const startAt = startAtRef.current;
      if (startAt !== null || art.currentTime > 5) unfreezePicture(art.video);
      if (startAt !== null) {
        startAtRef.current = null;
        if (Math.abs(art.currentTime - startAt) < 30) {
          setResumedFrom(startAt);
          if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
          resumeTimerRef.current = setTimeout(() => setResumedFrom(null), 8000);
        }
      }
      // 仅在媒体真正恢复（有分片进入 buffer）后清错误遮罩：
      // 否则「视频轨挂了、音频轨先播出来」时会清掉遮罩，留下黑屏假死态
      if (mediaHealthyRef.current) setError('');
    });
    art.on('video:error', () => {
      mediaHealthyRef.current = false;
      // 起播阶段的 video 元素级错误（MSE/解码偶发失败）：重建一次播放链路自愈，
      // 而不是直接钉死错误遮罩——重建后视频轨重新 append，黑屏有声即可解除
      if (!playbackStartedRef.current && !videoErrorRetryUsedRef.current) {
        videoErrorRetryUsedRef.current = true;
        showHint('播放异常，正在重试...');
        void setupHls(art.video, currentMediaUrlRef.current, true);
        return;
      }
      giveUp('视频解码失败', '视频播放失败，请尝试其他视频源');
    });
    art.on('video:timeupdate', () => {
      const t = art.currentTime;
      const d = art.duration;
      if (propsRef.current.positionRef) propsRef.current.positionRef.current = { time: t, duration: d };
      // 你标过的广告：播到就跳过（拖进去也跳）
      const ad = propsRef.current.adSkips?.find((r) => t >= r.start && t < r.end - 0.5);
      if (ad && !art.video.seeking) {
        seekTo(ad.end);
        showHint('已跳过你标的广告');
        return;
      }
      // 片头片尾：落在区间里显示按钮；这部剧开了自动跳过就直接跳（每集每段只跳一次）
      const sk = propsRef.current.skip;
      let active: 'intro' | 'outro' | null = null;
      if (sk?.intro && t >= sk.intro.start && t < sk.intro.end - 1) active = 'intro';
      else if (sk?.outro && t >= sk.outro.start && t < sk.outro.end - 1) active = 'outro';
      if (active && skippedRef.current.has(active) && !sk?.auto) {
        // 手动跳过之后又拖回来：按钮照样显示
      } else if (
        active &&
        sk?.auto &&
        // 官方数据只有别的版本（位置大概对）：只显示按钮，不自动跳
        !(active === 'intro' ? sk.intro?.approx : sk.outro?.approx) &&
        !skippedRef.current.has(active) &&
        !art.video.seeking
      ) {
        const seg = active === 'intro' ? sk.intro! : sk.outro!;
        if (active === 'outro' && d > 0 && seg.end >= d - 3) {
          // 片尾一直到结尾：片尾曲继续放，上面出「下一集」倒数卡（不暂停、不硬切）
          doSkip('outro', true);
          active = null;
        } else {
          // 不直接跳：按钮上倒数几秒（按播放时间算，暂停时也停），这期间可以点「不跳」留下来看
          if (autoPendingRef.current?.kind !== active) autoPendingRef.current = { kind: active, at: t + AUTO_SKIP_SECONDS };
          const left = Math.ceil(autoPendingRef.current.at - t);
          if (left <= 0) {
            autoPendingRef.current = null;
            setAutoLeft(null);
            doSkip(active, true);
            active = null;
          } else {
            setAutoLeft((prev) => (prev === left ? prev : left));
          }
        }
      }
      if (autoPendingRef.current && autoPendingRef.current.kind !== active) {
        // 离开了这一段（拖走了 / 已跳过）：倒数作废
        autoPendingRef.current = null;
        setAutoLeft(null);
      }
      setActiveSkip((prev) => (prev === active ? prev : active));
      updateUpNext(t, d);
      const now = Date.now();
      // 还没真正开播时（hls.js 还没跳到上次的位置）不存：会用 0 盖掉上次看到的位置
      if (canReport() && now - lastSave > 5000) {
        lastSave = now;
        propsRef.current.onTimeUpdate?.(art.currentTime, art.duration);
      }
      // 每 30s 续跑一次前向预取窗口（ensure 幂等，窗口未覆盖足够余量才会重建）
      if (now - lastPrefetchEnsureRef.current > 30_000) {
        lastPrefetchEnsureRef.current = now;
        // 用 currentMediaUrlRef（代理回退后的实际地址）：否则预取的 key 与
        // loader 读取的 key 不一致，缓存永不命中且直连 fetch 白耗流量
        ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
        // 临近片尾 90 秒内提前预热下一集，保证播完弹出大卡时下一集已预热
        if (art.duration > 0 && art.duration - art.currentTime <= 90) {
          warmNextEpisode();
        }
      }
    });
    art.on('video:seeked', () => {
      if (!art.video.paused) unfreezePicture(art.video);
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
    });
    art.on('video:pause', () => {
      if (canReport()) propsRef.current.onPause?.(art.currentTime, art.duration);
      // 暂停 = 预取黄金窗口：解除限速并无限铺满整集（用户主动行为，带宽占用可接受）
      // waiting 触发的限速在此解除，否则黄金窗口会被 500ms 轮询冻结
      getVideoPrefetcher().setThrottled(false);
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime, 0);
    });
    art.on('video:waiting', () => {
      // 卡顿：预取临时让出带宽给播放
      getVideoPrefetcher().setThrottled(true);
      // 播放中卡住（不是拖动进度引起的）：记一次卡顿
      if (playbackStartedRef.current && !art.video.seeking) recordStall(currentSourceKey());
      // 已经开播后卡住太久（且不是暂停）→ 这个源不行了
      if (playbackStartedRef.current && !stallTimerRef.current) {
        const at = art.currentTime;
        stallTimerRef.current = setTimeout(() => {
          stallTimerRef.current = null;
          if (!art.video.paused && Math.abs(art.currentTime - at) < 1) {
            giveUp(`卡住超过 ${STALL_TIMEOUT_MS / 1000} 秒`, '视频卡住了，请尝试其他视频源');
          }
        }, STALL_TIMEOUT_MS);
      }
    });
    art.on('video:pause', () => {
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    });
    art.on('video:playing', () => {
      getVideoPrefetcher().setThrottled(false);
      if (stallTimerRef.current) clearTimeout(stallTimerRef.current);
      stallTimerRef.current = null;
    });
    art.on('video:ended', () => {
      // 片尾自动「下一集」已经提前触发过：放到真正结尾时不再重复弹倒数
      if (endedRef.current) return;
      endedRef.current = true;
      propsRef.current.onEnded?.();
    });

    // —— 键盘快捷键（旧版 hotkey:false + 自定义逻辑的移植） ——
    const shortcuts = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      // 输入框或按钮获得焦点时不劫持按键：否则空格会吞掉按钮的默认激活
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.closest('button')) return;
      const current = artRef.current;
      if (!current) return;
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); return; } // 由父层处理集数切换
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); return; }
      switch (e.key) {
        case 'ArrowLeft':
          seekBy(-1); e.preventDefault();
          break;
        case 'ArrowRight':
          seekBy(1); e.preventDefault();
          break;
        case '<': case '>': {
          // 跟 YouTube 一样：Shift + , / . 调慢 / 调快
          const i = PLAYBACK_RATES.indexOf(current.playbackRate as (typeof PLAYBACK_RATES)[number]);
          const next = PLAYBACK_RATES[Math.min(PLAYBACK_RATES.length - 1, Math.max(0, (i < 0 ? PLAYBACK_RATES.indexOf(1) : i) + (e.key === '>' ? 1 : -1)))];
          setRate(next); e.preventDefault();
          break;
        }
        case 'ArrowUp':
          if (current.volume < 1) { current.volume = Math.min(1, current.volume + 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case 'ArrowDown':
          if (current.volume > 0) { current.volume = Math.max(0, current.volume - 0.1); showHint(`音量 ${Math.round(current.volume * 100)}%`); e.preventDefault(); }
          break;
        case ' ':
          current.toggle(); showHint('播放/暂停'); e.preventDefault();
          break;
        case 'f': case 'F':
          current.fullscreen = !current.fullscreen; e.preventDefault();
          break;
      }
    };
    document.addEventListener('keydown', shortcuts);

    // —— 长按 2 倍速（手机按住画面 / 电脑按住鼠标），松开恢复；手机双击左右两侧快退 / 快进 ——
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let isLongPress = false;
    let originalRate = 1.0;
    // 刚结束长按：吞掉松手后的那次 click（否则 ArtPlayer 会当成点一下暂停）
    let swallowClickUntil = 0;
    const el = containerRef.current;
    /** 按在控制栏、设置面板、锁、我们自己的按钮上：不算点画面 */
    const onChrome = (target: EventTarget | null) =>
      Boolean((target as HTMLElement | null)?.closest?.('.art-bottom, .art-settings, .art-contextmenus, .art-layer-lock, button'));

    const startHold = () => {
      if (isLongPress || longPressTimer || art.video?.paused || art.isLock) return false;
      originalRate = art.video.playbackRate;
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        if (art.video?.paused) return;
        art.video.playbackRate = Math.max(LONG_PRESS_RATE, originalRate);
        isLongPress = true;
        setHoldFast(true);
      }, 500);
      return true;
    };
    const endHold = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (!isLongPress) return false;
      art.video.playbackRate = originalRate;
      isLongPress = false;
      setHoldFast(false);
      swallowClickUntil = Date.now() + 400;
      return true;
    };

    // 双击：两次轻点间隔 < 300ms。左边三分之一快退、右边三分之一快进（连点累加），中间播放 / 暂停
    let lastTap = { at: 0, zone: 0 };
    let touchStart = { x: 0, y: 0, at: 0 };
    const tapZone = (clientX: number) => {
      const rect = art.template.$player.getBoundingClientRect();
      // 网页全屏竖着拿时画面顺时针转了 90 度：画面的左边在屏幕上方
      const ratio = art.isRotate ? (touchStart.y - rect.top) / rect.height : (clientX - rect.left) / rect.width;
      return ratio < 1 / 3 ? -1 : ratio > 2 / 3 ? 1 : 0;
    };

    // —— 滑动手势：左右滑拖进度（整个画面宽约 2 分钟，松手才跳），左半边上下滑调亮度、右半边调音量 ——
    let swipe:
      | { axis: 'x'; from: number; target: number }
      | { axis: 'y'; side: 'left' | 'right'; from: number }
      | null = null;
    let swipeTracking = false;
    /** 手指相对按下时移动了多少（按画面方向：网页全屏竖着拿时画面顺时针转了 90 度） */
    const videoDelta = (t: Touch) => {
      const rect = art.template.$player.getBoundingClientRect();
      const dx = t.clientX - touchStart.x;
      const dy = t.clientY - touchStart.y;
      return art.isRotate
        ? { dx: dy, dy: -dx, width: rect.height, height: rect.width }
        : { dx, dy, width: rect.width, height: rect.height };
    };
    const onTouchStart = (e: TouchEvent) => {
      // 已有触控在处理时忽略新手指：否则第二指会把 originalRate 捕获成加速后的值，松手后倍速卡住
      if (e.touches.length > 1) { endHold(); swipeTracking = false; return; }
      swipe = null;
      swipeTracking = false;
      if (onChrome(e.target)) return;
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY, at: Date.now() };
      swipeTracking = !art.isLock;
      startHold();
    };
    const finishSwipe = () => {
      if (!swipe) return false;
      if (swipe.axis === 'x' && Math.abs(swipe.target - swipe.from) >= 1) seekTo(swipe.target);
      swipe = null;
      setGestureHint(null);
      return true;
    };
    const onTouchEnd = (e: TouchEvent) => {
      swipeTracking = false;
      if (finishSwipe()) {
        e.preventDefault();
        return;
      }
      if (endHold()) {
        e.preventDefault();
        return;
      }
      if (e.type !== 'touchend' || onChrome(e.target) || art.isLock) return;
      const t = e.changedTouches[0];
      if (!t || Date.now() - touchStart.at > 300 || Math.hypot(t.clientX - touchStart.x, t.clientY - touchStart.y) > 20) return;
      const now = Date.now();
      const zone = tapZone(t.clientX);
      if (now - lastTap.at < 300 && zone === lastTap.zone) {
        if (zone === 0) art.toggle();
        else tapSeek(zone as -1 | 1);
        // 连点：第三下、第四下接着累加
        lastTap = { at: zone === 0 ? 0 : now, zone };
      } else {
        lastTap = { at: now, zone };
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (isLongPress) {
        e.preventDefault();
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      if (longPressTimer && Math.hypot(t.clientX - touchStart.x, t.clientY - touchStart.y) > 12) {
        // 手指在滑：不是长按
        endHold();
      }
      if (!swipeTracking) return;
      const { dx, dy, width, height } = videoDelta(t);
      if (!swipe) {
        if (Math.hypot(dx, dy) < 14) return;
        const rect = art.template.$player.getBoundingClientRect();
        const startRatio = art.isRotate ? (touchStart.y - rect.top) / rect.height : (touchStart.x - rect.left) / rect.width;
        if (Math.abs(dx) > Math.abs(dy)) {
          if (!(art.duration > 0)) { swipeTracking = false; return; }
          swipe = { axis: 'x', from: art.currentTime, target: art.currentTime };
        } else {
          const side = startRatio < 0.5 ? 'left' : 'right';
          swipe = { axis: 'y', side, from: side === 'left' ? brightnessRef.current : art.video.volume };
        }
      }
      e.preventDefault();
      if (swipe.axis === 'x') {
        const d = art.duration || 0;
        swipe.target = Math.max(0, Math.min(d - 1, swipe.from + (dx / width) * SWIPE_SEEK_SPAN));
        const delta = Math.round(swipe.target - swipe.from);
        setGestureHint(`${delta >= 0 ? '快进' : '快退'} ${Math.abs(delta)} 秒 · ${formatTime(swipe.target)} / ${formatTime(d)}`);
      } else if (swipe.side === 'left') {
        const v = Math.max(0.3, Math.min(1.5, swipe.from - (dy / height) * 1.2));
        brightnessRef.current = v;
        art.video.style.filter = Math.abs(v - 1) < 0.02 ? '' : `brightness(${v.toFixed(2)})`;
        setGestureHint(`亮度 ${Math.round(v * 100)}%`);
      } else {
        const v = Math.max(0, Math.min(1, swipe.from - dy / height));
        art.video.volume = v;
        // iPhone 不让网页改音量（video.volume 只读，设了也还是 1）
        setGestureHint(Math.abs(art.video.volume - v) > 0.01 ? '这台设备请用侧边的音量键' : `音量 ${Math.round(v * 100)}%`);
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0 || onChrome(e.target)) return;
      startHold();
    };
    const onMouseUp = () => { endHold(); };
    const onClickCapture = (e: MouseEvent) => {
      if (Date.now() < swallowClickUntil) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    el?.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    el?.addEventListener('click', onClickCapture, true);
    // ArtPlayer 的 contextmenu 组件只在桌面端初始化（移动端构造函数里跳过 init），
    // 长按倍速因而会连带呼出系统原生菜单/气泡。播放器表面没有可用的原生菜单，统一抑制
    const onContextMenu = (e: Event) => e.preventDefault();
    el?.addEventListener('touchstart', onTouchStart, { passive: false });
    el?.addEventListener('touchend', onTouchEnd);
    el?.addEventListener('touchcancel', onTouchEnd);
    el?.addEventListener('touchmove', onTouchMove, { passive: false });
    el?.addEventListener('contextmenu', onContextMenu);

    // 卸载与页面隐藏时保存进度
    const saveOnHide = () => {
      if (document.visibilityState === 'hidden' && canReport()) {
        propsRef.current.onPause?.(art.currentTime, art.duration);
      }
    };
    document.addEventListener('visibilitychange', saveOnHide);

    return () => {
      // 卸载前刷一次最终进度，避免丢失最后几秒。
      // 已自然播完的集数不回写，避免覆盖 onEnded 里清除的「已看完」记录
      if (!endedRef.current && canReport()) {
        try {
          propsRef.current.onPause?.(art.currentTime, art.duration);
        } catch { /* 忽略 */ }
      }
      document.removeEventListener('keydown', shortcuts);
      swipe = null;
      document.documentElement.style.overflow = '';
      document.removeEventListener('visibilitychange', saveOnHide);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current);
      if (tapSeekTimerRef.current) clearTimeout(tapSeekTimerRef.current);
      setupSeqRef.current += 1;
      clearWatchdogs();
      el?.removeEventListener('touchstart', onTouchStart);
      el?.removeEventListener('touchend', onTouchEnd);
      el?.removeEventListener('touchcancel', onTouchEnd);
      el?.removeEventListener('touchmove', onTouchMove);
      el?.removeEventListener('contextmenu', onContextMenu);
      el?.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      el?.removeEventListener('click', onClickCapture, true);
      endHold();
      hlsRef.current?.destroy();
      hlsRef.current = null;
      recoveryRef.current?.dispose();
      getVideoPrefetcher().stop();
      host.remove();
      setOverlayHost(null);
      art.destroy();
      artRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // —— 换集：仅切换 HLS 源，不重建播放器（保留网页全屏等状态） ——
  const firstUrlRef = useRef(true);
  useEffect(() => {
    // 挂载时的首次由创建 effect 的 customType 触发，跳过避免重复加载
    if (firstUrlRef.current) { firstUrlRef.current = false; return; }
    loadEpisode(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  // —— 广告过滤开关变化：重建 HLS loader（无需重建整个播放器） ——
  const firstAdFilterRef = useRef(true);
  useEffect(() => {
    if (firstAdFilterRef.current) { firstAdFilterRef.current = false; return; }
    if (artRef.current && hlsRef.current) {
      // 用当前实际媒体地址：代理回退生效时切广告过滤不应跳回直连形式；从刚才的位置接着放
      loadEpisode(currentMediaUrlRef.current || propsRef.current.url, artRef.current.currentTime);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adFilter]);

  return (
    <div className="relative w-full h-full">
      <div ref={containerRef} className="w-full h-full" style={{ WebkitTouchCallout: 'none' }} />
      {showPoster && !error && (
        <div
          className="absolute inset-0 bg-black pointer-events-none"
          style={{
            backgroundImage: 'url(/player-poster.png)',
            backgroundSize: 'contain',
            backgroundPosition: 'center',
            backgroundRepeat: 'no-repeat',
          }}
        />
      )}
      {overlayHost &&
        createPortal(
          <>
            {error && (
              <div className="pointer-events-auto absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80">
                <p className="text-danger text-sm">{error}</p>
                <button className="btn-ghost text-xs" onClick={() => location.reload()}>
                  重新加载
                </button>
              </div>
            )}
            {hint && (
              <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/50 backdrop-blur-xl border border-white/10 text-white text-sm px-4 py-1.5 rounded-full pointer-events-none animate-fade-in whitespace-nowrap">
                {hint}
              </div>
            )}
            {gestureHint && (
              <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-black/60 backdrop-blur-xl text-white text-sm font-medium px-4 py-2 rounded-2xl pointer-events-none whitespace-nowrap">
                {gestureHint}
              </div>
            )}
            {holdFast && (
              <div className="absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-1.5 bg-black/55 backdrop-blur-xl border border-white/10 text-white text-sm font-medium px-4 py-1.5 rounded-full pointer-events-none whitespace-nowrap">
                <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6l8 6-8 6zM12 6l8 6-8 6z" fill="currentColor" /></svg>
                {LONG_PRESS_RATE} 倍速播放中
              </div>
            )}
            {tapSeekInfo && (
              <div
                key={tapSeekInfo.id}
                className={cn(
                  'absolute top-1/2 -translate-y-1/2 flex flex-col items-center gap-1 px-5 py-3 rounded-full bg-black/45 text-white text-xs font-semibold pointer-events-none animate-fade-in',
                  tapSeekInfo.dir < 0 ? 'left-[12%]' : 'right-[12%]',
                )}
              >
                <span className="text-lg leading-none">{tapSeekInfo.dir < 0 ? '«' : '»'}</span>
                {tapSeekInfo.seconds} 秒
              </div>
            )}
            {resumedFrom !== null && !hint && !holdFast && !error && !overlay && (
              <div className="pointer-events-auto absolute top-4 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/55 backdrop-blur-xl border border-white/10 text-white text-sm pl-4 pr-1.5 py-1.5 rounded-full animate-fade-in whitespace-nowrap">
                <span>已从 {formatTime(resumedFrom)} 继续播放</span>
                <button
                  type="button"
                  className="px-3 py-1 rounded-full bg-white/15 hover:bg-white/25 text-xs font-medium cursor-pointer"
                  onClick={() => {
                    setResumedFrom(null);
                    seekTo(0);
                  }}
                >
                  从头播放
                </button>
              </div>
            )}
          </>,
          overlayHost,
        )}
      {upNext && !error && !overlay && overlayHost &&
        createPortal(
          <UpNextCard
            title={nextTitle}
            countdown={upNext.left ?? undefined}
            onPlay={() => {
              setUpNext(null);
              upNextDismissedRef.current = true;
              playNextNow();
            }}
            onDismiss={() => {
              setUpNext(null);
              upNextDismissedRef.current = true;
            }}
          />,
          overlayHost,
        )}
      {activeSkip && !upNext && !error && !overlay && overlayHost &&
        createPortal(
          <SkipButton
            label={
              activeSkip === 'intro'
                ? '跳过片头'
                : skip?.outro && artRef.current?.duration && skip.outro.end >= artRef.current.duration - 3 && nextUrl && onNextEpisode
                  ? '下一集'
                  : '跳过片尾'
            }
            countdown={autoLeft ?? undefined}
            onClick={() => {
              autoPendingRef.current = null;
              setAutoLeft(null);
              doSkip(activeSkip, false);
            }}
            onCancel={() => {
              // 这次想看片头 / 片尾曲：这一集这一段不再自动跳，按钮也收起
              skippedRef.current.add(activeSkip);
              autoPendingRef.current = null;
              setAutoLeft(null);
              setActiveSkip(null);
            }}
          />,
          overlayHost,
        )}
      {overlay && (overlayHost ? createPortal(overlay, overlayHost) : overlay)}
    </div>
  );
}

/**
 * 「黑屏有声」自救：从中间开始播（续播 / 拖动后），Safari 偶尔声音出来了画面却一直黑，
 * 一全屏（重新排版）画面就回来。开播后先强制重绘一次；1.5 秒内还没有新画面送出来，
 * 就原地往后挪一点点让解码器重新出画面。没有画面的音频流（videoWidth 为 0）不管。
 */
function unfreezePicture(video: HTMLVideoElement) {
  const rvfc = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback;
  requestAnimationFrame(() => {
    video.style.transform = 'translateZ(0)';
    requestAnimationFrame(() => {
      video.style.transform = '';
    });
  });
  if (typeof rvfc !== 'function') return;
  let presented = false;
  rvfc.call(video, () => {
    presented = true;
  });
  setTimeout(() => {
    if (presented || video.paused || video.seeking || !video.videoWidth || document.visibilityState !== 'visible') return;
    // 挪一下本身会触发 seeked → 又进来：10 秒内只挪一次，真的坏了的视频轨不会一直跳
    const last = Number(video.dataset.unfreezeAt || 0);
    if (Date.now() - last < 10_000) return;
    video.dataset.unfreezeAt = String(Date.now());
    video.currentTime = video.currentTime + 0.05;
  }, 1500);
}

/** 控制栏上某个按钮的元素（ArtPlayer 按 name 存在 controls.cache 里） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function controlEl(art: any, name: string): HTMLElement | undefined {
  return art?.controls?.cache?.get?.(name)?.$ref;
}

function rateLabel(rate: number): string {
  return rate === 1 ? '倍速' : `${rate}x`;
}

/** 网页全屏键（给没有元素全屏的 iPhone 用）：四角箭头，进入 / 退出 */
function fullscreenIcon(on: boolean): string {
  const d = on
    ? 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5'
    : 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5';
  return `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/** 控制栏上的快退 / 快进按钮：圆形箭头 + 秒数 */
function seekIcon(dir: -1 | 1, step: number): string {
  const arrow =
    dir < 0
      ? '<path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" fill="currentColor"/>'
      : '<path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z" fill="currentColor"/>';
  return `<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">${arrow}<text x="12" y="16.2" text-anchor="middle" font-size="7.2" font-weight="700" fill="currentColor" font-family="system-ui,sans-serif">${step}</text></svg>`;
}

/** 片尾开始时右下角的「下一集」卡（Netflix 式）：倒数条 + 立即播放 + 继续看片尾 */
function UpNextCard({
  title,
  countdown,
  onPlay,
  onDismiss,
}: {
  title?: string;
  countdown?: number;
  onPlay: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute right-3 bottom-16 sm:right-5 sm:bottom-20 w-56 sm:w-64 rounded-2xl border border-white/15 bg-black/70 backdrop-blur-xl text-white p-3 shadow-2xl space-y-2.5 animate-fade-in">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] text-white/60">{countdown !== undefined ? `${countdown} 秒后播放` : '接下来'}</p>
          <p className="text-sm font-semibold truncate">下一集{title ? ` · ${title}` : ''}</p>
        </div>
        <button type="button" onClick={onDismiss} className="shrink-0 text-xs text-white/60 hover:text-white px-1 cursor-pointer" aria-label="继续看片尾">
          继续看片尾
        </button>
      </div>
      <button
        type="button"
        onClick={onPlay}
        className="relative w-full overflow-hidden rounded-xl bg-white text-slate-950 text-sm font-semibold py-2 cursor-pointer"
      >
        {countdown !== undefined && (
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 bg-slate-300/70"
            style={{ width: `${Math.round(((UP_NEXT_COUNTDOWN - countdown + 1) / UP_NEXT_COUNTDOWN) * 100)}%`, transition: 'width 1s linear' }}
          />
        )}
        <span className="relative">▶ 播放下一集</span>
      </button>
    </div>
  );
}

/** Netflix 式右下角「跳过片头 / 跳过片尾 / 下一集」按钮（挂在播放器里，全屏时也在） */
function SkipButton({
  label,
  countdown,
  onClick,
  onCancel,
}: {
  label: string;
  /** 开了自动跳过时：还有几秒自动跳（期间可以点「不跳」） */
  countdown?: number;
  onClick: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="pointer-events-auto absolute right-4 bottom-16 sm:bottom-20 flex items-center gap-2 animate-fade-in">
      {countdown !== undefined && (
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-2 rounded-xl border border-white/25 bg-black/50 text-white/85 text-xs backdrop-blur-sm hover:bg-black/70 cursor-pointer"
        >
          不跳
        </button>
      )}
      <button
        type="button"
        onClick={onClick}
        className="relative overflow-hidden px-4 py-2 rounded-xl border border-white/40 bg-black/65 text-white text-sm font-semibold backdrop-blur-sm hover:bg-white hover:text-slate-950 transition-colors cursor-pointer"
      >
        {countdown !== undefined && (
          // 倒数进度条：从左往右填满时自动跳
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 bg-white/20"
            style={{ width: `${Math.round(((AUTO_SKIP_SECONDS - countdown + 1) / AUTO_SKIP_SECONDS) * 100)}%`, transition: 'width 1s linear' }}
          />
        )}
        <span className="relative">
          {label}
          {countdown !== undefined ? `（${countdown}）` : ''}
        </span>
      </button>
    </div>
  );
}
