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
import { formatTime } from '@/lib/utils';
import type { SkipSegment } from '@/lib/skip-segment';
import { PLAYBACK_RATES, SEEK_STEPS, loadPlayerPrefs, savePlayerPrefs } from '@/lib/player-prefs';

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
  /** 片尾一直到结尾时，「跳过片尾」直接进下一集 */
  onNextEpisode?: () => void;
  /** 实时的播放位置（父级点「下一集」时用来记片尾位置） */
  positionRef?: React.MutableRefObject<{ time: number; duration: number }>;
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
    skip, onNextEpisode, positionRef, adSkips,
  });
  propsRef.current = {
    url, title, adFilter, autoplayNext, episodeKey, nextUrl, nextEpisodeKey,
    getRestorePosition, onTimeUpdate, onEnded, onPause, onRequestSwitchSource, onNextPrefetchState,
    skip, onNextEpisode, positionRef, adSkips,
  };

  // 跨集共享、每次换集重置的播放链路状态
  // 媒体健康度：音频轨可播不代表视频轨正常（「黑屏但有声」的假死态）。
  // 仅当有分片真正进入 MSE buffer 后才视为恢复，错误遮罩才能被清除。
  const mediaHealthyRef = useRef(true);
  const playbackStartedRef = useRef(false);
  // 起播阶段的 video 元素级错误允许自愈重试一次（重建 hls/MSE）
  const videoErrorRetryUsedRef = useRef(false);
  // 进度恢复每集只执行一次（MANIFEST_PARSED 可能因代理回退再次触发）
  const restoredRef = useRef(false);
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
    hlsRef.current?.stopLoad();
    showHint(`${reason}，正在换源…`);
    cb(reason, artRef.current?.currentTime ?? 0);
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
  const setupHls = (video: HTMLVideoElement, mediaUrl: string, allowProxyFallback: boolean) => {
    hlsRef.current?.destroy();
    currentMediaUrlRef.current = mediaUrl;
    const hls = new Hls(buildHlsConfig());
    hlsRef.current = hls;

    hls.loadSource(mediaUrl);
    hls.attachMedia(video);

    hls.on(Hls.Events.MANIFEST_PARSED, async () => {
      recoveryRef.current?.markHealthy();
      // 预取锚点：恢复进度时直接取恢复目标。赋值后 video.currentTime 未必立刻反映
      // （Safari 系），而 ensure 是以「锚点未变」为前提复用 parsing 中的运行的——
      // 这里读到旧值会把窗口建在片头，且白等一次纠错重建。
      let prefetchAnchor = video.currentTime;
      // 进度恢复（每集一次）：优先 URL position，其次 IndexedDB 记录
      if (!restoredRef.current) {
        restoredRef.current = true;
        try {
          const saved = (await propsRef.current.getRestorePosition?.()) ?? 0;
          const duration = artRef.current?.duration || 0;
          if (saved > 10 && duration > 0 && saved < duration - 2) {
            if (artRef.current) seekTo(saved);
            prefetchAnchor = saved;
            showHint(`已从 ${formatTime(saved)} 继续播放`);
          }
        } catch { /* 忽略恢复失败 */ }
      }
      // 新集立即预取（否则要等 timeupdate 的 30s 节流，起播初期无缓存）
      ensurePrefetch(mediaUrl, prefetchAnchor);
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
            setupHls(video, `/api/proxy?url=${encodeURIComponent(mediaUrl)}`, false);
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

  /** 换集：重置每集状态并切换到新 HLS 源（不重建 ArtPlayer）。 */
  const loadEpisode = (targetUrl: string) => {
    if (!targetUrl) return;
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    lastPrefetchEnsureRef.current = 0;
    recoveryRef.current = new PlaybackRecovery();
    endedRef.current = false;
    switchRequestedRef.current = false;
    skippedRef.current = new Set();
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
    setupHls(art.video, targetUrl, true);
  };

  // —— 创建播放器（仅一次，挂载即创建） ——
  useEffect(() => {
    if (!containerRef.current || !propsRef.current.url) return;
    const initialUrl = propsRef.current.url;

    // 初始化每集状态
    mediaHealthyRef.current = true;
    playbackStartedRef.current = false;
    videoErrorRetryUsedRef.current = false;
    restoredRef.current = false;
    recoveryRef.current = new PlaybackRecovery();
    endedRef.current = false;
    switchRequestedRef.current = false;
    armStartWatchdog();
    propsRef.current.onNextPrefetchState?.('idle');

    let lastSave = 0;

    const prefs = loadPlayerPrefs();
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
      fullscreen: true,
      fullscreenWeb: true,
      miniProgressBar: true,
      mutex: true,
      backdrop: true,
      playsInline: true,
      airplay: true,
      hotkey: false,
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
          setupHls(video, mediaUrl, true);
        },
      },
    });
    artRef.current = art;

    // 在播放器容器内部挂载浮层宿主：网页全屏与系统全屏下均可显示倒计时大卡与「还在看吗？」
    const host = document.createElement('div');
    host.className = 'pointer-events-none absolute inset-0 z-[160] flex items-center justify-center';
    containerRef.current.appendChild(host);
    setOverlayHost(host);

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
        setupHls(art.video, currentMediaUrlRef.current, true);
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
      const now = Date.now();
      if (now - lastSave > 5000) {
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
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime);
    });
    art.on('video:pause', () => {
      propsRef.current.onPause?.(art.currentTime, art.duration);
      // 暂停 = 预取黄金窗口：解除限速并无限铺满整集（用户主动行为，带宽占用可接受）
      // waiting 触发的限速在此解除，否则黄金窗口会被 500ms 轮询冻结
      getVideoPrefetcher().setThrottled(false);
      ensurePrefetch(currentMediaUrlRef.current, art.currentTime, 0);
    });
    art.on('video:waiting', () => {
      // 卡顿：预取临时让出带宽给播放
      getVideoPrefetcher().setThrottled(true);
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

    // —— 移动端长按 3 倍速 ——
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    let isLongPress = false;
    let originalRate = 1.0;
    const el = containerRef.current;

    const onTouchStart = (e: TouchEvent) => {
      if (art.video?.paused) return;
      // 已有触控在处理时忽略新手指：否则第二指会把 originalRate 捕获成 3.0，
      // 松手后倍速永久卡在 3x；旧定时器句柄也会被覆盖成无法清除的幽灵触发
      if (isLongPress || longPressTimer) return;
      // 控制栏 / 设置面板上的长按不触发倍速（按住进度条拖动、长按倍速菜单项会误触）
      if ((e.target as HTMLElement).closest?.('.art-controls, .art-settings')) return;
      originalRate = art.video.playbackRate;
      longPressTimer = setTimeout(() => {
        if (art.video?.paused) return;
        art.video.playbackRate = 3.0;
        isLongPress = true;
        showHint('3 倍速');
      }, 500);
    };
    const onTouchEnd = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (isLongPress) {
        art.video.playbackRate = originalRate;
        isLongPress = false;
        showHint(`${originalRate} 倍速`);
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (isLongPress) e.preventDefault();
    };
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
      if (document.visibilityState === 'hidden') {
        propsRef.current.onPause?.(art.currentTime, art.duration);
      }
    };
    document.addEventListener('visibilitychange', saveOnHide);

    return () => {
      // 卸载前刷一次最终进度，避免丢失最后几秒。
      // 已自然播完的集数不回写，避免覆盖 onEnded 里清除的「已看完」记录
      if (!endedRef.current) {
        try {
          propsRef.current.onPause?.(art.currentTime, art.duration);
        } catch { /* 忽略 */ }
      }
      document.removeEventListener('keydown', shortcuts);
      document.removeEventListener('visibilitychange', saveOnHide);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      clearWatchdogs();
      el?.removeEventListener('touchstart', onTouchStart);
      el?.removeEventListener('touchend', onTouchEnd);
      el?.removeEventListener('touchcancel', onTouchEnd);
      el?.removeEventListener('touchmove', onTouchMove);
      el?.removeEventListener('contextmenu', onContextMenu);
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
      // 用当前实际媒体地址：代理回退生效时切广告过滤不应跳回直连形式
      loadEpisode(currentMediaUrlRef.current || propsRef.current.url);
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
      {error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/80">
          <p className="text-danger text-sm">{error}</p>
          <button className="btn-ghost text-xs" onClick={() => location.reload()}>
            重新加载
          </button>
        </div>
      )}
      {hint && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-black/50 backdrop-blur-xl border border-white/10 text-white text-sm px-4 py-1.5 rounded-full pointer-events-none animate-fade-in">
          {hint}
        </div>
      )}
      {activeSkip && !error && !overlay && overlayHost &&
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

/** 控制栏上某个按钮的元素（ArtPlayer 按 name 存在 controls.cache 里） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function controlEl(art: any, name: string): HTMLElement | undefined {
  return art?.controls?.cache?.get?.(name)?.$ref;
}

function rateLabel(rate: number): string {
  return rate === 1 ? '倍速' : `${rate}x`;
}

/** 控制栏上的快退 / 快进按钮：圆形箭头 + 秒数 */
function seekIcon(dir: -1 | 1, step: number): string {
  const arrow =
    dir < 0
      ? '<path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z" fill="currentColor"/>'
      : '<path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8z" fill="currentColor"/>';
  return `<svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true">${arrow}<text x="12" y="16.2" text-anchor="middle" font-size="7.2" font-weight="700" fill="currentColor" font-family="system-ui,sans-serif">${step}</text></svg>`;
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
