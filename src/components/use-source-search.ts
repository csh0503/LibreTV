'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sourceIsAdult } from '@/lib/adult-sources';
import { api } from '@/lib/client-api';
import { isInDisabledSubscription, isSourceDisabled, resolveSource, useAppStore } from '@/lib/store';
import { forgetAlias, recallAlias, rememberAlias } from '@/lib/alias-memory';
import { aggregateResults, matchingGroups } from '@/lib/title-aliases';
import { episodeCount } from '@/lib/source-rank';
import type { SourceSearchOutcome, TitlePick } from '@/lib/types';
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

/** 原名搜不到时，最多再按几个别名（港台译名等）查 */
const MAX_ALIAS_TRIES = 3;

/**
 * 原名在所有点播源都没有这部作品时（primaryMissing），向 /api/identity 要这部作品的其他中文名
 * （TMDB 的港台译名、别名，转简体），逐个再搜，直到有一个找到或都试完。
 * 作品详情弹窗和搜索结果页共用。
 */
/**
 * 作品身份（TMDB）：其他中文名 + 简介、类型、集数等资讯。
 * 详情弹窗一打开就查（显示资讯），别名查找也用同一份缓存。
 */
export function useTitleIdentity(pick: TitlePick, enabled: boolean) {
  const kind = pick.isTv === true ? 'tv' : pick.isTv === false ? 'movie' : undefined;
  const tmdb = pick.id?.startsWith('tmdb_') ? pick.id.slice(5) : undefined;
  const first = useQuery({
    queryKey: ['identity', pick.title, pick.year, kind, tmdb],
    queryFn: ({ signal }) => api.identity({ title: pick.title, year: pick.year, kind, tmdb }, signal),
    enabled,
    staleTime: 24 * 3600_000,
    retry: 0,
  });
  // 片源站年份标错（360 把 1999 年的《航海王》标成 2025）时，按年份会认成同名的别的作品（2026 年 2 集的乐高特别篇）：
  // 集数对不上就不带年份再认一次，还对不上就当作认不出
  const eps = episodeCount(pick.remarks);
  const wrong = (info?: { episodes?: number }) => identityContradicts(eps, info);
  const retryNeeded = !tmdb && Boolean(pick.year) && wrong(first.data?.identity?.info);
  const retry = useQuery({
    queryKey: ['identity', pick.title, undefined, kind, undefined],
    queryFn: ({ signal }) => api.identity({ title: pick.title, kind }, signal),
    enabled: enabled && retryNeeded,
    staleTime: 24 * 3600_000,
    retry: 0,
  });
  if (!retryNeeded) return first;
  if (retry.data && wrong(retry.data.identity?.info)) return { ...retry, data: { identity: null } } as typeof retry;
  return retry;
}

/** 片源已经播到的集数远多于认到的作品的总集数（多三倍以上）：认错了 */
export function identityContradicts(sourceEpisodes: number, info?: { episodes?: number }): boolean {
  return Boolean(sourceEpisodes && info?.episodes && sourceEpisodes > info.episodes * 3 + 10);
}

export function useAliasFallback(pick: TitlePick, primaryMissing: boolean) {
  const identityQuery = useTitleIdentity(pick, primaryMissing);
  // 上次在这台设备上用哪个别名找到过：开局就和原名一起搜，不用等原名落空
  const [remembered, setRemembered] = useState<{ title: string; alias?: string }>({ title: '' });
  useEffect(() => setRemembered({ title: pick.title, alias: recallAlias(pick.title) }), [pick.title]);
  const known = remembered.title === pick.title ? remembered.alias : undefined;
  const names = useMemo(() => {
    const out = known ? [known] : [];
    for (const n of identityQuery.data?.identity?.names ?? []) if (!out.includes(n)) out.push(n);
    return out.slice(0, MAX_ALIAS_TRIES);
  }, [identityQuery.data, known]);
  // 换片名时从第一个别名重新开始
  const [cursor, setCursor] = useState({ title: pick.title, idx: 0 });
  const idx = cursor.title === pick.title ? cursor.idx : 0;
  const alias = primaryMissing || (known && idx === 0) ? (names[idx] ?? '') : '';
  const search = useSourceSearch(alias, Boolean(alias));
  const groups = useMemo(
    () => (alias ? matchingGroups(aggregateResults(search.list, alias), alias) : []),
    [alias, search.list]
  );
  const exhausted = idx + 1 >= names.length;
  useEffect(() => {
    if (alias && search.settled && groups.length === 0 && !exhausted) {
      setCursor({ title: pick.title, idx: idx + 1 });
    }
  }, [alias, search.settled, groups.length, exhausted, pick.title, idx]);

  const lookingUp =
    primaryMissing &&
    groups.length === 0 &&
    (identityQuery.isLoading || (Boolean(alias) && (!search.settled || !exhausted)));

  // 找到了就记住；记住的别名这次落空了就忘掉，免得每次白搜
  useEffect(() => {
    if (!alias || !search.settled) return;
    if (groups.length > 0) {
      if (primaryMissing) rememberAlias(pick.title, alias);
    } else if (alias === known) {
      forgetAlias(pick.title);
    }
  }, [alias, search.settled, groups.length, primaryMissing, known, pick.title]);

  // 原名找得到时，别名结果不展示（记住的别名会提前搜，但只在原名落空时才用）
  const usable = primaryMissing ? groups : [];

  return {
    /** 当前在试的别名 */
    alias,
    /** 准备试的全部别名 */
    names,
    /** 按别名找到的这部作品的分组 */
    groups: usable,
    /** 别名搜索的原始结果（搜索结果页展示用） */
    list: search.list,
    /** 找到时用的是哪个别名 */
    foundVia: usable.length > 0 ? alias : undefined,
    lookingUp,
    /** 原名、别名都查完了还是没有 */
    nothingFound: primaryMissing && !lookingUp && groups.length === 0,
  };
}
