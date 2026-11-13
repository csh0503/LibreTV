import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { openCatalogDb, sourceAvailability } from '@/lib/catalog-db';
import { canonicalTitle } from '@/lib/title-aliases';

export const runtime = 'nodejs';

/**
 * POST /api/availability  { titles: string[] } → { ready, results: { [title]: { sources, remarks } } }
 * 片单「上线了」提醒用：查本地片库记下的 26 个点播源最近更新（伺服器每小时扫一次），
 * 不再在首页对每部收藏整站搜 26 个源。没有本地片库时 ready=false（前端就不查了，点进去再搜）。
 */
export async function POST(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;
  let titles: unknown;
  try {
    titles = ((await req.json()) as { titles?: unknown }).titles;
  } catch {
    return jsonError('请求格式不对', 400);
  }
  if (!Array.isArray(titles) || titles.length > 40 || !titles.every((t) => typeof t === 'string' && t.length <= 80)) {
    return jsonError('titles 要是不超过 40 个片名', 400);
  }
  if (!openCatalogDb()) return NextResponse.json({ ready: false, results: {} });
  const keys = new Map((titles as string[]).map((t) => [t, canonicalTitle(t)]));
  const found = sourceAvailability([...keys.values()]);
  const results: Record<string, { sources: number; remarks?: string }> = {};
  for (const [title, key] of keys) {
    const hit = found.get(key);
    results[title] = { sources: hit?.sources ?? 0, ...(hit?.remarks ? { remarks: hit.remarks } : {}) };
  }
  return NextResponse.json({ ready: true, results }, { headers: { 'Cache-Control': 'no-store' } });
}
