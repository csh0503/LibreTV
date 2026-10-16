'use client';

import { useEffect, useState } from 'react';
import { detectIntro, detectOutro, type AudioDetectResult } from '@/lib/audio-skip';
import { audioSkipEnabled, loadAudioTemplates, saveAudioTemplates } from '@/lib/audio-skip-store';
import { loadSegments, type HlsSegment } from '@/lib/hls-audio';
import { browserAudioDeps } from '@/lib/hls-audio-browser';
import type { SkipTimes } from '@/lib/skip-times';

export type AudioSkipStatus = 'idle' | 'working' | 'done' | 'off';

/** 开播后等一会儿再开始（先让播放器抢带宽起播） */
const START_DELAY_MS = 4000;

/**
 * 在后台比对声音找片头片尾（不播放、不出声）：
 * - 片头：开播几秒后开始。有这部剧的模板就只拿本集开头比；没有就再取另一集（下一集，没有就上一集）开头比，
 *   一般在播到片头之前就算完。
 * - 片尾：播过一半才开始（中途不看了就不浪费流量），做法同上。
 * need 为 false 的那段（已有你手动设的 / 数据库的准确值）不做。
 */
export function useAudioSkip(opts: {
  seriesKey: string;
  episodes: string[];
  index: number;
  adFilter: boolean;
  /** 片子总长已知（播放器开始播了）、数据库也查完了 */
  ready: boolean;
  need: { intro: boolean; outro: boolean };
  positionRef: React.MutableRefObject<{ time: number; duration: number }>;
}): { result: SkipTimes; status: AudioSkipStatus } {
  const [result, setResult] = useState<SkipTimes>({});
  const [status, setStatus] = useState<AudioSkipStatus>('idle');
  const url = opts.episodes[opts.index];
  const otherIndex = opts.index + 1 < opts.episodes.length ? opts.index + 1 : opts.index - 1;
  const otherUrl = otherIndex >= 0 ? opts.episodes[otherIndex] : undefined;
  const { seriesKey, adFilter, ready, positionRef } = opts;
  const needIntro = opts.need.intro;
  const needOutro = opts.need.outro;

  useEffect(() => {
    setResult({});
    if (!url || !ready || (!needIntro && !needOutro)) {
      setStatus('idle');
      return;
    }
    if (!audioSkipEnabled()) {
      setStatus('off');
      return;
    }
    const ctrl = new AbortController();
    const { signal } = ctrl;
    const deps = browserAudioDeps();
    let otherSegs: Promise<HlsSegment[] | null> | undefined;
    const other = () => (otherUrl ? (otherSegs ??= loadSegments(otherUrl, adFilter, deps, signal).catch(() => null)) : Promise.resolve(null));

    const run = async () => {
      setStatus('working');
      const current = await loadSegments(url, adFilter, deps, signal).catch(() => null);
      if (!current || signal.aborted) {
        if (!signal.aborted) setStatus('done');
        return;
      }
      const saved = loadAudioTemplates(seriesKey);

      const solve = async (kind: 'intro' | 'outro'): Promise<AudioDetectResult> => {
        const detect = kind === 'intro' ? detectIntro : detectOutro;
        const template = saved?.[kind];
        if (template) {
          const hit = await detect({ current, template, deps, signal });
          if (hit.seg || signal.aborted) return hit;
        }
        // 没有模板，或模板这集对不上（换了片头曲）：跟另一集比，找到就换成新模板
        const otherSegments = await other();
        if (!otherSegments || signal.aborted) return {};
        const found = await detect({ current, other: otherSegments, deps, signal });
        if (found.template) saveAudioTemplates(seriesKey, { [kind]: found.template });
        return found;
      };

      if (needIntro) {
        const intro = await solve('intro');
        if (signal.aborted) return;
        if (intro.seg) setResult((r) => ({ ...r, intro: intro.seg }));
      }
      if (needOutro) {
        // 播过一半才找片尾；等的时候不显示「正在比对」
        setStatus('idle');
        while (!signal.aborted) {
          const { time, duration } = positionRef.current;
          if (duration > 0 && time >= duration * 0.5) break;
          await new Promise((r) => setTimeout(r, 10_000));
        }
        if (signal.aborted) return;
        setStatus('working');
        const outro = await solve('outro');
        if (signal.aborted) return;
        if (outro.seg) setResult((r) => ({ ...r, outro: outro.seg }));
      }
      setStatus('done');
    };

    const timer = setTimeout(() => void run().catch(() => setStatus('done')), START_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [url, otherUrl, seriesKey, adFilter, ready, needIntro, needOutro, positionRef]);

  return { result, status };
}
