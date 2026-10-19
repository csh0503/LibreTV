import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { isShelfId } from '@/lib/shelf-defs';
import { loadShelf } from '@/lib/shelves';

export const runtime = 'nodejs';
// 第一次算要补 B站单季详情（每个榜几十个请求，最多等 6 秒），留足时间
export const maxDuration = 30;

/** 首页货架：一次一行（?id=），各行独立缓存、独立失败，边缘节点可共享缓存 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const id = new URL(req.url).searchParams.get('id') || '';
  if (!isShelfId(id)) {
    return NextResponse.json({ error: `未知货架: ${id.slice(0, 30)}` }, { status: 400 });
  }
  try {
    const items = await loadShelf(id);
    return NextResponse.json(
      { items },
      { headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '货架获取失败' },
      { status: 502 },
    );
  }
}
