import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { probeCatalogUpstreams } from '@/lib/douban';
import { probeHotListUpstreams, timeProbe, type UpstreamProbe } from '@/lib/douban-weekly';
import { readStoredJson, syncStorageKind } from '@/lib/profile-sync-store';
import { resolveTitleIdentity } from '@/lib/title-identity';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * 数据源体检：现场把每个上游请求一遍（不走缓存），列出条数、耗时、报错和前几个片名。
 * 只在打开体检页时调用，一次大约二三十个上游请求。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const storage = syncStorageKind();
  const probes: Promise<UpstreamProbe>[] = [
    ...probeHotListUpstreams(),
    ...probeCatalogUpstreams(),
    timeProbe('找片源', 'TMDB 别名（大师计划）', async () => {
      const identity = await resolveTitleIdentity({ title: '大师计划', year: '2026', kind: 'movie' });
      if (identity === undefined) throw new Error('TMDB 暂时查不了');
      return (identity?.names ?? []).map((name, i) => ({ id: String(i), title: name, cover: '' }));
    }),
    timeProbe('设定档同步', `存储（${storage}）读取名单`, async () => {
      const json = await readStoredJson('catalog.json');
      const profiles = json ? ((JSON.parse(json) as { profiles?: { name?: string }[] }).profiles ?? []) : [];
      return profiles.map((p, i) => ({ id: String(i), title: p.name || '设定档', cover: '' }));
    }),
  ];
  const results = await Promise.all(probes);
  return NextResponse.json(
    { at: Date.now(), storage, results },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
