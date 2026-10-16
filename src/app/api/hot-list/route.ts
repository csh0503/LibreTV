import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchHotListWithMeta, isHotListId } from '@/lib/douban-weekly';

export const runtime = 'nodejs';

/** 影视热榜：多源融合排名（见 fuseMultiSourceRankings），附带算出时间与各来源取数情况 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const id = new URL(req.url).searchParams.get('id') || '';
  if (!isHotListId(id)) {
    return NextResponse.json({ error: `未知榜单: ${id.slice(0, 30)}` }, { status: 400 });
  }

  try {
    const { items, meta } = await fetchHotListWithMeta(id);
    // 边缘节点共享 10 分钟：所有人看到同一份榜单，冷启动的实例也不用把十几个上游重新拉一遍
    return NextResponse.json(
      { items, meta },
      { headers: { 'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=1800' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '榜单获取失败' },
      { status: 502 }
    );
  }
}
