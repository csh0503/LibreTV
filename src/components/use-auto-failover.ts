'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { failoverQueryTitle, MAX_FAILOVER_SOURCES, parseTried, pickFailoverCandidates } from '@/lib/failover';
import { qualityKey } from '@/lib/source-rank';
import { resolveSource, useAppStore } from '@/lib/store';
import type { SourceQuality } from '@/lib/stream-quality';
import { buildWatchUrl } from '@/lib/utils';
import { useToast } from './toast';
import { useSourceSearch } from './use-source-search';

/** 换源中 / 换不动了：播放器上显示的状态 */
export type FailoverState =
  | { phase: 'idle' }
  | { phase: 'searching' | 'trying'; reason: string; sourceName?: string }
  | { phase: 'exhausted'; reason: string; tried: number };

/** 详情弹窗和搜索页测过的清晰度 / 广告（react-query 缓存里有就用，没有不另测） */
function cachedQuality(queryClient: ReturnType<typeof useQueryClient>): Record<string, SourceQuality> {
  const map: Record<string, SourceQuality> = {};
  for (const [, data] of queryClient.getQueriesData<{ results: SourceQuality[] }>({ queryKey: ['quality'] })) {
    for (const q of data?.results ?? []) if (q.ok || !map[q.key]) map[q.key] = q;
  }
  for (const [, data] of queryClient.getQueriesData<SourceQuality[]>({ queryKey: ['quality-local'] })) {
    for (const q of data ?? []) if (q.ok) map[q.key] = q;
  }
  return map;
}

/**
 * 播放卡住 / 加载失败时自动换到同一部作品的下一个源，接着播同一集、同一位置。
 * 试过的源记在 URL 的 tried 参数里，一集最多换 MAX_FAILOVER_SOURCES 次。
 */
export function useAutoFailover(opts: {
  title: string;
  year?: string;
  isTv?: boolean;
  sourceKey: string;
  vodId: string;
  index: number;
  sourceName: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const [request, setRequest] = useState<{ reason: string; position: number } | null>(null);
  const [state, setState] = useState<FailoverState>({ phase: 'idle' });
  const runningRef = useRef(false);

  const query = failoverQueryTitle(opts.title, opts.year);
  const search = useSourceSearch(request ? query : '', Boolean(request));
  const tried = parseTried(searchParams.get('tried'));

  // 换到新源 / 新一集后清掉上一轮的状态
  useEffect(() => {
    setRequest(null);
    setState({ phase: 'idle' });
    runningRef.current = false;
  }, [opts.sourceKey, opts.vodId, opts.index]);

  const requestSwitch = useCallback(
    (reason: string, position: number) => {
      const triedNow = parseTried(searchParams.get('tried'));
      if (triedNow.length + 1 >= MAX_FAILOVER_SOURCES) {
        setState({ phase: 'exhausted', reason, tried: triedNow.length + 1 });
        return;
      }
      setRequest({ reason, position });
      setState({ phase: 'searching', reason });
    },
    [searchParams],
  );

  const cancel = useCallback(() => {
    setRequest(null);
    setState({ phase: 'idle' });
    runningRef.current = false;
  }, []);

  useEffect(() => {
    if (!request || runningRef.current) return;
    // 没有可搜的点播源：直接交给用户
    if (search.selectedSources.length === 0) {
      setState({ phase: 'exhausted', reason: request.reason, tried: tried.length + 1 });
      return;
    }
    if (!search.settled) return;
    runningRef.current = true;
    const controller = new AbortController();
    const current = { sourceKey: opts.sourceKey, vodId: opts.vodId };
    const candidates = pickFailoverCandidates({
      list: search.list,
      title: query,
      year: opts.year,
      isTv: opts.isTv,
      current,
      tried,
      health: useAppStore.getState().sourceHealth,
      quality: cachedQuality(queryClient),
    });

    void (async () => {
      // 依次看候选源有没有这一集；有就跳过去，最多看 4 个（每个都要请求一次详情）
      for (const item of candidates.slice(0, 4)) {
        if (controller.signal.aborted) return;
        const src = resolveSource({ customAPIs, envSources }, item.sourceKey, { url: item.sourceUrl });
        if (!src) continue;
        setState({ phase: 'trying', reason: request.reason, sourceName: item.sourceName });
        try {
          const detail = await api.detail(item.vodId, src, controller.signal);
          if (detail.episodes.length <= opts.index) continue;
        } catch {
          if (controller.signal.aborted) return;
          continue;
        }
        const nextTried = [...tried, qualityKey(current)];
        const url = buildWatchUrl({
          sourceKey: item.sourceKey,
          vodId: item.vodId,
          index: opts.index,
          position: request.position > 5 ? request.position - 3 : undefined,
          title: item.name,
          sourceUrl: src.url,
          detail: src.detail,
        });
        toast(`「${opts.sourceName}」${request.reason}，已自动换到「${item.sourceName}」`, 'info');
        router.replace(`${url}&tried=${encodeURIComponent(nextTried.join(','))}`, { scroll: false });
        return;
      }
      if (!controller.signal.aborted) {
        setState({ phase: 'exhausted', reason: request.reason, tried: tried.length + 1 });
      }
    })();
    return () => controller.abort();
    // 只在搜索结束时跑一次；其余依赖在这一轮里是固定的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, search.settled]);

  return { state, requestSwitch, cancel };
}
