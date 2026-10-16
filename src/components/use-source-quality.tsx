'use client';

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { PROXY_BASE, unproxyM3u8 } from '@/lib/m3u8';
import { probeEpisode } from '@/lib/quality-probe';
import { qualityKey, rankSources } from '@/lib/source-rank';
import { resolveSource, useAppStore } from '@/lib/store';
import { qualityLabel, type SourceQuality } from '@/lib/stream-quality';
import type { SearchResultItem, SourceConfig } from '@/lib/types';

/**
 * 片源质检，全部在你的浏览器里做（不经过服务器的质检接口）：
 * - 第 1 集地址直接用搜索结果里带的（没有才请求一次详情）；
 * - 播放列表先直连读，读不到（跨域 / 被挡）再经本站代理读，代理改写过的地址还原回原地址再分析；
 * - 每个源测完立刻出结果（不等最慢的那个），同时测 8 个；
 * - 结果存在这台设备上 6 小时，再打开同一部是秒出。
 */

const MAX_PROBE = 60;
const CONCURRENCY = 8;
const TTL = 6 * 3600_000;
const STORE_KEY = 'libretv:quality:v1';
const MAX_STORED = 600;

type Stored = Record<string, { q: SourceQuality; at: number }>;
let stored: Stored | null = null;
function readStore(): Stored {
  if (stored) return stored;
  try {
    stored = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Stored;
  } catch {
    stored = {};
  }
  return stored;
}
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function remember(key: string, q: SourceQuality) {
  const all = readStore();
  all[key] = { q, at: Date.now() };
  if (flushTimer) return;
  // 一批结果攒一下再写（每个源都写一次太频繁）
  flushTimer = setTimeout(() => {
    flushTimer = null;
    const keys = Object.keys(all);
    if (keys.length > MAX_STORED) {
      for (const k of keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - MAX_STORED)) delete all[k];
    }
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch {
      // 存满了：这次照样用
    }
  }, 800);
}
function recall(key: string): { q: SourceQuality; at: number } | undefined {
  const hit = readStore()[key];
  return hit && Date.now() - hit.at < TTL ? hit : undefined;
}

/** 同时最多测几个（所有弹窗 / 卡片共用），排队的按先来先测 */
let running = 0;
const waiting: (() => void)[] = [];
async function limited<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (running >= CONCURRENCY) await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    if (signal?.aborted) throw new Error('已取消');
    return await task();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}

function timeoutSignal(parent: AbortSignal | undefined, ms: number): AbortSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  parent?.addEventListener('abort', () => ctrl.abort(), { once: true });
  ctrl.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  return ctrl.signal;
}

async function readText(url: string, signal?: AbortSignal): Promise<string> {
  try {
    const res = await fetch(url, { signal: timeoutSignal(signal, 5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (signal?.aborted) throw err;
    const res = await fetch(`${PROXY_BASE}${encodeURIComponent(url)}`, { signal: timeoutSignal(signal, 9000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return unproxyM3u8(await res.text());
  }
}

/** 跨域时只读得到 Content-Length：HEAD 一下，读不到就算了（只是少了码率估算） */
async function readSize(url: string, signal?: AbortSignal): Promise<number> {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: timeoutSignal(signal, 4000) });
    const len = parseInt(res.headers.get('content-length') ?? '', 10);
    return res.ok && Number.isFinite(len) && len > 1 ? len : 0;
  } catch {
    return 0;
  }
}

interface Candidate {
  key: string;
  vodId: string;
  firstEpisode?: string;
  source?: SourceConfig;
}

async function probeLocal(c: Candidate, signal?: AbortSignal): Promise<SourceQuality> {
  try {
    if (!c.source) return { key: c.key, ok: false, error: '源已移除' };
    let first = c.firstEpisode;
    if (!first) first = (await api.detail(c.vodId, c.source, timeoutSignal(signal, 10000))).episodes[0];
    if (!first) return { key: c.key, ok: false, error: '没有播放地址' };
    const result = await probeEpisode(first, {
      text: (url) => readText(url, signal),
      segmentBytes: (url) => readSize(url, signal),
    });
    return { key: c.key, ...result };
  } catch (err) {
    return { key: c.key, ok: false, error: err instanceof Error ? err.message.slice(0, 80) : '质检失败' };
  }
}

/**
 * 片源质检：看第 1 集的清晰度和能识别的插入广告。作品详情弹窗和搜索结果卡片共用；
 * enabled 一打开就开始测（搜索结果边出边测），每个源单独缓存。
 */
export function useSourceQuality(groups: SearchResultItem[][], enabled: boolean) {
  const customAPIs = useAppStore((s) => s.customAPIs);
  const envSources = useAppStore((s) => s.envSources);
  const sourceHealth = useAppStore((s) => s.sourceHealth);

  const candidates = useMemo<Candidate[]>(
    () =>
      // 按组的先后测：第一组（点开的那一季）全部先测，名额有剩再测后面的季
      groups
        .flatMap((items) => rankSources(items, sourceHealth))
        .slice(0, MAX_PROBE)
        .map((item) => ({
          key: qualityKey(item),
          vodId: item.vodId,
          firstEpisode: item.firstEpisode,
          source: resolveSource({ customAPIs, envSources }, item.sourceKey, { url: item.sourceUrl }),
        })),
    [groups, sourceHealth, customAPIs, envSources],
  );

  const results = useQueries({
    queries: candidates.map((c) => {
      const hit = recall(c.key);
      return {
        queryKey: ['quality-local', c.key],
        queryFn: async ({ signal }: { signal?: AbortSignal }) => {
          const q = await limited(() => probeLocal(c, signal), signal);
          // 取消的不记（下次再测）；测不了的也记，免得每次打开都白等
          if (!signal?.aborted) remember(c.key, q);
          return q;
        },
        enabled,
        initialData: hit?.q,
        initialDataUpdatedAt: hit?.at,
        staleTime: TTL,
        gcTime: TTL,
        retry: 0,
      };
    }),
  });
  // 只在有源测完时才换新的 map（每次渲染都换会让下游的排序白算）
  const signature = results.map((r) => r.dataUpdatedAt).join(',');
  const isFetching = results.some((r) => r.isFetching);
  const qualityMap = useMemo(() => {
    const map: Record<string, SourceQuality> = {};
    for (const r of results) if (r.data) map[r.data.key] = r.data;
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);
  return { qualityMap, isFetching };
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
