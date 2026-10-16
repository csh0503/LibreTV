'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sourceIsAdult } from '@/lib/adult-sources';
import { api } from '@/lib/client-api';
import { isInDisabledSubscription, isSourceDisabled, resolveSource, useAppStore } from '@/lib/store';
import type { SourceSearchOutcome } from '@/lib/types';
import { formatDisableTtl, validateSourceUrl } from '@/lib/utils';
import { useToast } from './toast';

/** 本次搜索实际会用到的点播源：已勾选、地址有效、未被自动停用、所属订阅未关闭、按成人开关过滤 */
export function useSelectedSources() {
  // 精确订阅所需字段：搜索流式期间逐源写健康度等无关 store 变化不触发重渲染
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const subscriptions = useAppStore((s) => s.subscriptions);

  return useMemo(() => {
    // selectedKeys 可能含历史残留的重复 key：按 key 去重，避免同源重复搜索
    const seen = new Set<string>();
    return selectedKeys
      .map((key) => resolveSource({ customAPIs, envSources }, key))
      .filter((s): s is NonNullable<typeof s> => {
        if (!s || !validateSourceUrl(s.url) || seen.has(s.key)) return false;
        seen.add(s.key);
        // 成人内容过滤开启时，成人源（含这 8 个已知地址）不参与搜索
        if (yellowFilter && sourceIsAdult(s)) return false;
        return true;
      })
      .map((s) => (sourceIsAdult(s) ? { ...s, isAdult: true } : s))
      // 自动停用期内的源不参与搜索（到期自动恢复）
      .filter((s) => !isSourceDisabled({ sourceHealth }, s.key))
      // 所属订阅被整体停用的源同样跳过（无损：各源勾选状态保留，重新启用即恢复）
      .filter((s) => !isInDisabledSubscription({ subscriptions }, s.key));
  }, [customAPIs, envSources, selectedKeys, sourceHealth, subscriptions, yellowFilter]);
}

/**
 * 并发查所有点播源（流式：逐源结算即可渲染）。首页搜索结果和作品详情弹窗共用同一份缓存：
 * 在弹窗里查过的片名，点「查看全部搜索结果」不会再搜一遍。
 */
export function useSourceSearch(rawQuery: string, enabled = true) {
  const query = rawQuery.trim().slice(0, 100);
  const { toast } = useToast();
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const selectedKeys = useAppStore((s) => s.selectedKeys);
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const selectedSources = useSelectedSources();
  /** 流式搜索中已结算的源（data 就绪前用于增量渲染） */
  const [streamedOutcomes, setStreamedOutcomes] = useState<SourceSearchOutcome[]>([]);

  // 源名回显：失败/停用提示里显示友好名称而非裸 key
  const sourceName = (key: string) =>
    customAPIs.find((a) => a.key === key)?.name ?? envSources.find((a) => a.key === key)?.name ?? key;

  const searchQuery = useQuery({
    queryKey: ['search', query, selectedKeys, yellowFilter],
    queryFn: ({ signal }) => {
      setStreamedOutcomes([]);
      return api.search(query, selectedSources, yellowFilter, {
        signal,
        // 逐源结算即更新：结果边搜边渲染，同时滚动健康度
        onSource: (outcome) => {
          setStreamedOutcomes((prev) => [...prev, outcome]);
          for (const ev of useAppStore.getState().recordSourceHealth([outcome])) {
            toast(
              ev.permanent
                ? `「${sourceName(ev.key)}」多次失败，已停止参与搜索，可在设置中恢复`
                : `「${sourceName(ev.key)}」连续超时/失败，已停用 ${formatDisableTtl(ev.ttlMs ?? 0)}`,
              'warning'
            );
          }
        },
      });
    },
    enabled: enabled && Boolean(query) && selectedSources.length > 0,
    // 5 分钟内从播放页返回时直接使用缓存，不重新搜索（服务端另有 60s 结果缓存兜底）
    staleTime: 300_000,
  });

  const isSearching = Boolean(query) && searchQuery.isFetching && !searchQuery.data;
  // 聚合数据未就绪时，用已结算源的结果增量渲染（健康源不再等坏源超时）
  const list = useMemo(
    () => searchQuery.data?.list ?? (isSearching ? streamedOutcomes.flatMap((o) => o.list) : []),
    [searchQuery.data, isSearching, streamedOutcomes]
  );
  const failures = useMemo(
    () =>
      searchQuery.data?.failures ??
      streamedOutcomes
        .filter((o) => !o.ok)
        .map((o) => ({ sourceKey: o.sourceKey, error: o.error || '请求失败', timedOut: o.timedOut })),
    [searchQuery.data, streamedOutcomes]
  );

  return {
    searchQuery,
    selectedSources,
    streamedOutcomes,
    isSearching,
    /** 全部源都结算了（不再拉取） */
    settled: Boolean(searchQuery.data) && !searchQuery.isFetching,
    list,
    failures,
    sourceName,
  };
}
