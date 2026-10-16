'use client';

import { useEffect, useState } from 'react';
import { detectIntro, detectOutro, type AudioDetectResult } from '@/lib/audio-skip';
import { audioSkipEnabled, hasAudioMiss, loadAudioTemplates, recordAudioMiss, saveAudioTemplates } from '@/lib/audio-skip-store';
import { loadSegments, type HlsSegment } from '@/lib/hls-audio';
import { browserAudioDeps } from '@/lib/hls-audio-browser';
import type { SkipTimes } from '@/lib/skip-times';

export type AudioSkipStatus = 'idle' | 'working' | 'done' | 'off';

/** 第一次找时最多拿几集来比 */
const MAX_OTHERS = 3;
/** 开播后等一会儿再开始（先让播放器抢带宽起播） */
const START_DELAY_MS = 2000;

/**
 * 在后台比对声音找片头片尾（不播放、不出声）：
 * - 开播 2 秒后先找片头、紧接着找片尾（一起做完，不等播到）。
 * - 有这部剧的模板就只拿本集的开头 / 结尾比；没有就依次跟下一集、上一集、下下集比（最多 3 集，
 *   有的集只有片头没片尾、或只有片尾没片头），找到就停。
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
  // 拿来比的集：下一集、上一集、下下集、上上集，最多试 3 集（有的集没有片头或没有片尾）
  const otherUrls = [opts.index + 1, opts.index - 1, opts.index + 2, opts.index - 2]
    .filter((i) => i >= 0 && i < opts.episodes.length)
    .slice(0, MAX_OTHERS)
    .map((i) => opts.episodes[i])
    .join('\n');
  const { seriesKey, adFilter, ready } = opts;
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
    const others = otherUrls ? otherUrls.split('\n') : [];
    const loaded = new Map<string, Promise<HlsSegment[] | null>>();
    const segmentsOf = (u: string) => {
      if (!loaded.has(u)) loaded.set(u, loadSegments(u, adFilter, deps, signal).catch(() => null));
      return loaded.get(u)!;
    };

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
          // 这集以前就确认过没有（比如只有片尾没有片头）：不再下载别的集白比
          if (hasAudioMiss(seriesKey, kind, url)) return {};
        }
        // 没有模板，或模板这集对不上（换了片头曲 / 这集没有）：依次跟别的集比，找到就停、换成新模板
        for (const other of others) {
          const otherSegments = await segmentsOf(other);
          if (signal.aborted) return {};
          if (!otherSegments) continue;
          const found = await detect({ current, other: otherSegments, deps, signal });
          if (signal.aborted) return {};
          if (found.seg) {
            if (found.template) saveAudioTemplates(seriesKey, { [kind]: found.template });
            return found;
          }
        }
        // 跟几集都比不出：多半是这集本身没有这一段，记下来
        if (others.length > 0) recordAudioMiss(seriesKey, kind, url);
        return {};
      };

      if (needIntro) {
        const intro = await solve('intro');
        if (signal.aborted) return;
        if (intro.seg) setResult((r) => ({ ...r, intro: intro.seg }));
      }
      if (needOutro) {
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
  }, [url, otherUrls, seriesKey, adFilter, ready, needIntro, needOutro]);

  return { result, status };
}
