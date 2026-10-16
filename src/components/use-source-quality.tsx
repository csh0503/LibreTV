'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { probeEpisode } from '@/lib/quality-probe';
import { qualityKey, rankSources } from '@/lib/source-rank';
import { resolveSource, useAppStore } from '@/lib/store';
import { qualityLabel, type SourceQuality } from '@/lib/stream-quality';
import type { SearchResultItem } from '@/lib/types';

/** 一次最多质检几个源；每 30 个一批（服务端单次上限），各批并发 */
const MAX_PROBE = 90;
const BATCH = 30;
/** 服务端测不到的，浏览器最多再测几个、同时测几个 */
const MAX_LOCAL = 40;
const LOCAL_CONCURRENCY = 6;

function timeoutSignal(parent: AbortSignal | undefined, ms: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  parent?.addEventListener('abort', () => ctrl.abort(), { once: true });
  ctrl.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

/**
 * 浏览器自己测：服务端在海外机房，有些采集站的视频网站会挡海外 / 机房的访问或很慢，
 * 但你的浏览器播放时是直连的。播放地址仍由 /api/detail 取，播放列表和分片大小由浏览器直接读。
 */
async function probeInBrowser(
  item: { key: string; vodId: string },
  source: Parameters<typeof api.detail>[1],
  signal?: AbortSignal,
): Promise<SourceQuality> {
  try {
    const detail = await api.detail(item.vodId, source, timeoutSignal(signal, 12000));
    const first = detail.episodes[0];
    if (!first) return { key: item.key, ok: false, error: '没有播放地址', via: 'browser' };
    const result = await probeEpisode(first, {
      text: async (url) => {
        const res = await fetch(url, { signal: timeoutSignal(signal, 10000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      },
      // 跨域只能读到 Content-Length：先 HEAD，读不到就算了（只是少了码率估算）
      segmentBytes: async (url) => {
        try {
          const res = await fetch(url, { method: 'HEAD', signal: timeoutSignal(signal, 6000) });
          const len = parseInt(res.headers.get('content-length') ?? '', 10);
          return res.ok && Number.isFinite(len) && len > 1 ? len : 0;
        } catch {
          return 0;
        }
      },
    });
    return { key: item.key, ...result, via: 'browser' };
  } catch (err) {
    return { key: item.key, ok: false, error: err instanceof Error ? err.message.slice(0, 80) : '质检失败', via: 'browser' };
  }
}

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

  // 服务端测不到的，交给浏览器再测一次
  const failed = useMemo(() => {
    const bad = new Set((query.data?.results ?? []).filter((q) => !q.ok).map((q) => q.key));
    return candidates.filter((c) => bad.has(c.key)).slice(0, MAX_LOCAL);
  }, [query.data, candidates]);
  const local = useQuery({
    queryKey: ['quality-local', failed.map((c) => c.key).sort().join(',')],
    queryFn: async ({ signal }) => {
      const out: SourceQuality[] = [];
      let next = 0;
      const worker = async () => {
        while (next < failed.length) {
          const c = failed[next++];
          const src = resolveSource({ customAPIs, envSources }, c.sourceKey, { url: c.sourceUrl });
          out.push(src ? await probeInBrowser(c, src, signal) : { key: c.key, ok: false, error: '源已移除', via: 'browser' });
        }
      };
      await Promise.all(Array.from({ length: Math.min(LOCAL_CONCURRENCY, failed.length) }, worker));
      return out;
    },
    enabled: failed.length > 0,
    staleTime: 60 * 60_000,
    retry: 0,
  });

  const qualityMap = useMemo(() => {
    const map = Object.fromEntries((query.data?.results ?? []).map((q) => [q.key, q])) as Record<string, SourceQuality>;
    for (const q of local.data ?? []) {
      // 浏览器测到了就用浏览器的；两边都失败时保留服务端的原因（更具体）
      if (q.ok || !map[q.key]) map[q.key] = q;
    }
    return map;
  }, [query.data, local.data]);
  return { qualityMap, isFetching: query.isFetching || local.isFetching };
}

/** 源按钮上的质检小标签：「1080P」「约720P」「广告15秒·已跳过」「无插入广告」 */
export function QualityTag({ q }: { q?: SourceQuality }) {
  // 测不了的不显示（原因只对排查有用）；「疑似广告」是还在观察的规则，也不给用户看
  if (!q || !q.ok) return null;
  const label = q.height ? `${q.estimated ? '约' : ''}${qualityLabel(q.height)}` : '';
  const ads = q.adSeconds && q.adSeconds > 0 ? `已去广告 ${q.adSeconds} 秒` : q.height || q.kbps || q.adSeconds === 0 ? '无插入广告' : '';
  if (!label && !ads) return null;
  return (
    <span
      className="ml-1 text-faint"
      title={[q.kbps ? `约 ${(q.kbps / 1000).toFixed(1)} Mbps` : '', q.minutes ? `第 1 集 ${q.minutes} 分钟` : ''].filter(Boolean).join(' · ') || undefined}
    >
      · {[label, ads].filter(Boolean).join(' · ')}
    </span>
  );
}
