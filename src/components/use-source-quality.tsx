'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { qualityKey, rankSources } from '@/lib/source-rank';
import { resolveSource, useAppStore } from '@/lib/store';
import { qualityLabel, type SourceQuality } from '@/lib/stream-quality';
import type { SearchResultItem } from '@/lib/types';

/** 一次最多质检几个源；每 30 个一批（服务端单次上限），各批并发 */
const MAX_PROBE = 90;
const BATCH = 30;

/**
 * 片源质检：对排在前面的几个源，让服务端看第 1 集的清晰度和可识别的插入广告。
 * 作品详情弹窗和搜索结果卡片共用，结果按「源 + 影片」缓存 1 小时（服务端同样缓存）。
 */
export function useSourceQuality(groups: SearchResultItem[][], enabled: boolean) {
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const sourceHealth = useAppStore((s) => s.sourceHealth);

  const candidates = useMemo(
    () =>
      // 按组的先后测：第一组（点开的那一季）全部先测，名额有剩再测后面的季；
      // 不能全部混在一起排，否则「集数多的优先」会把刚开播、才两三集的新一季挤到最后
      groups
        .flatMap((items) => rankSources(items, sourceHealth))
        .slice(0, MAX_PROBE)
        .flatMap((item) => {
          const src = resolveSource({ customAPIs, envSources }, item.sourceKey, { url: item.sourceUrl });
          return src
            ? [{ key: qualityKey(item), sourceKey: item.sourceKey, sourceName: item.sourceName, sourceUrl: src.url, vodId: item.vodId }]
            : [];
        }),
    [groups, sourceHealth, customAPIs, envSources],
  );

  const query = useQuery({
    queryKey: ['quality', candidates.map((c) => c.key).sort().join(',')],
    queryFn: async ({ signal }) => {
      const batches: (typeof candidates)[] = [];
      for (let i = 0; i < candidates.length; i += BATCH) batches.push(candidates.slice(i, i + BATCH));
      const parts = await Promise.all(batches.map((b) => api.quality(b, signal)));
      return { results: parts.flatMap((p) => p.results) };
    },
    enabled: enabled && candidates.length > 0,
    staleTime: 60 * 60_000,
    retry: 0,
  });

  const qualityMap = useMemo(
    () => Object.fromEntries((query.data?.results ?? []).map((q) => [q.key, q])) as Record<string, SourceQuality>,
    [query.data],
  );
  return { qualityMap, isFetching: query.isFetching };
}

/** 源按钮上的质检小标签：「1080P」「约720P」「广告15秒·已跳过」「无插入广告」 */
export function QualityTag({ q }: { q?: SourceQuality }) {
  if (!q) return null;
  if (!q.ok) return <span className="ml-1 text-faint" title={q.error}>· 测不了</span>;
  const label = q.height ? `${q.estimated ? '约' : ''}${qualityLabel(q.height)}` : '';
  const parts: string[] = [];
  if (q.adSeconds && q.adSeconds > 0) parts.push(`广告${q.adSeconds}秒·已跳过`);
  if (q.suspectSeconds && q.suspectSeconds > 0) parts.push(`疑似广告${q.suspectSeconds}秒`);
  const ads = parts.length > 0 ? parts.join(' · ') : q.height || q.kbps ? '无插入广告' : '';
  if (!label && !ads) return null;
  return (
    <span
      className="ml-1 text-faint"
      title={[q.kbps ? `约 ${(q.kbps / 1000).toFixed(1)} Mbps` : '', q.minutes ? `第 1 集 ${q.minutes} 分钟` : '']
        .filter(Boolean)
        .join(' · ')}
    >
      · {[label, ads].filter(Boolean).join(' · ')}
    </span>
  );
}
