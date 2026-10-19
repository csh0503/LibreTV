import type Hls from 'hls.js';
import type { HlsConfig } from 'hls.js';

/**
 * 拖进度时的预览画面：另开一个静音、不显示控件的小 <video> 加载同一个流，拖到哪就 seek 到哪。
 * 直接把这个 <video> 摆在画面上当小窗（不画到 canvas：跨域片段会把 canvas 弄脏读不出来）。
 * 每次 seek 只会拉目标位置那一个分片；拖得快时只保留最后一次请求，上一跳完成后再跳过去。
 */
export class SeekPreview {
  readonly video: HTMLVideoElement;
  private hls: Hls | null = null;
  private seeking = false;
  private pending: number | null = null;
  private last = -1;
  private primed = false;

  constructor(HlsCtor: typeof Hls | null, url: string, config: Partial<HlsConfig>) {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.disablePictureInPicture = true;
    v.preload = 'auto';
    v.className = 'seek-preview-video';
    this.video = v;
    v.addEventListener('seeked', this.onSeeked);
    if (HlsCtor && HlsCtor.isSupported()) {
      const hls = new HlsCtor({
        ...config,
        // 只要目标位置那一点：不预读、不缓冲后面，最低码率最快
        maxBufferLength: 2,
        maxMaxBufferLength: 4,
        maxBufferSize: 4 * 1000 * 1000,
        backBufferLength: 0,
        startLevel: 0,
        capLevelToPlayerSize: true,
        enableWorker: true,
        fragLoadingMaxRetry: 1,
        manifestLoadingMaxRetry: 1,
      });
      hls.loadSource(url);
      hls.attachMedia(v);
      this.hls = hls;
    } else {
      v.src = url;
    }
  }

  private onSeeked = () => {
    this.seeking = false;
    if (this.pending !== null) {
      const next = this.pending;
      this.pending = null;
      this.seek(next);
    }
  };

  /** iOS 上没播放过的 <video> seek 了也不出画面：静音播一下马上停 */
  private prime() {
    if (this.primed) return;
    this.primed = true;
    const p = this.video.play();
    if (p) p.then(() => this.video.pause()).catch(() => {});
  }

  seek(time: number) {
    if (!Number.isFinite(time) || time < 0) return;
    // 差不到 1 秒不重新拉
    if (Math.abs(time - this.last) < 1) return;
    this.prime();
    if (this.seeking) {
      this.pending = time;
      return;
    }
    this.last = time;
    this.seeking = true;
    try {
      this.video.currentTime = time;
    } catch {
      this.seeking = false;
    }
    // 有的浏览器在还没 metadata 时不发 seeked：别卡死
    setTimeout(() => { if (this.seeking && this.last === time) this.onSeeked(); }, 2500);
  }

  destroy() {
    this.video.removeEventListener('seeked', this.onSeeked);
    this.hls?.destroy();
    this.hls = null;
    this.video.removeAttribute('src');
    try { this.video.load(); } catch { /* 忽略 */ }
    this.video.remove();
  }
}
