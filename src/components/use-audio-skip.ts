'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { detectAcrossEpisodes, detectIntro, detectOutro, type AudioDetectResult } from '@/lib/audio-skip';
import {
  clearAudioTemplate,
  hasAudioMiss,
  loadAudioTemplates,
  recordAudioMiss,
  saveAudioTemplates,
} from '@/lib/audio-skip-store';
import { loadSegments, type HlsSegment } from '@/lib/hls-audio';
import { browserAudioDeps } from '@/lib/hls-audio-browser';
import type { SkipSegment, SkipTimes } from '@/lib/skip-segment';

export type AudioSkipStatus = 'idle' | 'working' | 'done' | 'off';

/** 第一次找时最多拿几集来比 */
const MAX_OTHERS = 3;
/** 开播后等一会儿再开始（先让播放器抢带宽起播） */
const START_DELAY_MS = 2000;

/** 和用户说「跳错了」的那段差不多（±3 秒）就不再用 */
const sameSeg = (a: SkipSegment, b: SkipSegment) => Math.abs(a.start - b.start) <= 3 && Math.abs(a.end - b.end) <= 3;

/**
 * 在后台比对声音找片头片尾（不播放、不出声）：
 * - 开播 2 秒后先找片头、紧接着找片尾（一起做完，不等播到）。
 * - 有这部剧的模板就只拿本集的开头 / 结尾比；没有就依次跟下一集、上一集、下下集比（最多 3 集，
 *   有的集只有片头没片尾、或只有片尾没片头），找到够长的就停；短的要两集一致才存模板。
 * - `retest(kind)`：用户点了「跳错了」——丢掉这段的模板、这集不再用刚才那个结果，重新跟别的集比。
 * enabled = 播放器设置里的「声音比对找片头片尾」。
 */
export function useAudioSkip(opts: {
  seriesKey: string;
  episodes: string[];
  index: number;
  adFilter: boolean;
  /** 片子总长已知（播放器开始播了） */
  ready: boolean;
  enabled: boolean;
}): { result: SkipTimes; status: AudioSkipStatus; retest: (kind: 'intro' | 'outro') => void } {
  const [result, setResult] = useState<SkipTimes>({});
  const [status, setStatus] = useState<AudioSkipStatus>('idle');
  const [nonce, setNonce] = useState(0);
  /** 这一集被用户否掉的结果（同一集重测时比出一样的就不用） */
  const rejectedRef = useRef<{ url: string; intro: SkipSegment[]; outro: SkipSegment[] }>({ url: '', intro: [], outro: [] });
  const url = opts.episodes[opts.index];
  // 拿来比的集：下一集、上一集、下下集、上上集，最多试 3 集（有的集没有片头或没有片尾）
  const otherUrls = [opts.index + 1, opts.index - 1, opts.index + 2, opts.index - 2]
    .filter((i) => i >= 0 && i < opts.episodes.length)
    .slice(0, MAX_OTHERS)
    .map((i) => opts.episodes[i])
    .join('\n');
  const { seriesKey, adFilter, ready, enabled } = opts;
  if (rejectedRef.current.url !== url) rejectedRef.current = { url: url ?? '', intro: [], outro: [] };

  const retest = useCallback(
    (kind: 'intro' | 'outro') => {
      setResult((r) => {
        const seg = r[kind];
        if (seg) rejectedRef.current[kind].push(seg);
        return { ...r, [kind]: undefined };
      });
      clearAudioTemplate(seriesKey, kind);
      setNonce((n) => n + 1);
    },
    [seriesKey],
  );

  useEffect(() => {
    setResult({});
    if (!url || !ready) {
      setStatus('idle');
      return;
    }
    if (!enabled) {
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
    const rejected = rejectedRef.current;
    const notRejected = (kind: 'intro' | 'outro', r: AudioDetectResult): AudioDetectResult =>
      r.seg && rejected[kind].some((s) => sameSeg(s, r.seg!)) ? {} : r;

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
          const hit = notRejected(kind, await detect({ current, template, deps, signal }));
          if (hit.seg || signal.aborted) return hit;
          // 这集以前就确认过没有（比如只有片尾没有片头）：不再下载别的集白比
          if (hasAudioMiss(seriesKey, kind, url)) return {};
        }
        // 没有模板，或模板这集对不上（换了片头曲 / 这集没有）：依次跟别的集比，换成新模板
        const found = await detectAcrossEpisodes({
          kind,
          current,
          others: others.map((u) => () => segmentsOf(u)),
          deps,
          signal,
        });
        if (signal.aborted) return {};
        const usable = notRejected(kind, found);
        if (usable.seg && found.save && found.template) saveAudioTemplates(seriesKey, { [kind]: found.template });
        // 跟几集都比不出：多半是这集本身没有这一段，记下来
        if (found.missed) recordAudioMiss(seriesKey, kind, url);
        return usable;
      };

      const intro = await solve('intro');
      if (signal.aborted) return;
      if (intro.seg) setResult((r) => ({ ...r, intro: { ...intro.seg!, via: 'audio' } }));
      const outro = await solve('outro');
      if (signal.aborted) return;
      if (outro.seg) setResult((r) => ({ ...r, outro: { ...outro.seg!, via: 'audio' } }));
      setStatus('done');
    };

    const timer = setTimeout(() => void run().catch(() => setStatus('done')), START_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [url, otherUrls, seriesKey, adFilter, ready, enabled, nonce]);

  return { result, status, retest };
}
