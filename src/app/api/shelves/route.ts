import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { parseShelfIds } from '@/lib/shelf-defs';
import { loadShelf } from '@/lib/shelves';
import type { DoubanItem } from '@/lib/types';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * 首页货架：一次最多三行（?ids=a,b,c）。
 * 某一行失败不影响其他行。同一进程里重叠的热榜、正在算的同一行，由 loadShelf / fetchHotList 合并成一次上游请求。
 * 原来的 /api/shelf 仍可用。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const ids = parseShelfIds(new URL(req.url).searchParams.get('ids'));
  if (!ids) {
    return NextResponse.json({ error: '货架参数无效' }, { status: 400 });
  }

  const shelves = await Promise.all(
    ids.map(async (id) => {
      try {
        const items = await loadShelf(id);
        return { id, items };
      } catch (err) {
        return {
          id,
          items: [] as DoubanItem[],
          error: err instanceof Error ? err.message : '货架获取失败',
        };
      }
    }),
  );

  return NextResponse.json(
    { shelves },
    { headers: { 'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=3600' } },
  );
}
