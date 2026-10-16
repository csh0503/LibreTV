import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchDoubanRecommend } from '@/lib/douban';

export const runtime = 'nodejs';

/** 豆瓣推荐：服务端直连 + 缓存，替代旧版浏览器经公共 CORS 代理的方案 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const url = new URL(req.url);
  const kind = url.searchParams.get('kind') === 'tv' ? 'tv' : 'movie';
  const sortParam = url.searchParams.get('sort');
  const sort = sortParam === 'S' || sortParam === 'R' || sortParam === 'U' ? sortParam : 'U';
  const score = url.searchParams.get('score') || '0,10';
  if (!/^(?:[0-9]|10),(?:[0-9]|10)$/.test(score)) {
    return NextResponse.json({ error: '评分范围无效' }, { status: 400 });
  }
  const tags = (url.searchParams.get('tags') || '热门')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (tags.length === 0 || tags.some((tag) => !/^[\u4e00-\u9fa5A-Za-z0-9]{1,20}$/.test(tag))) {
    return NextResponse.json({ error: '筛选标签无效' }, { status: 400 });
  }
  const pageStart = Math.max(0, parseInt(url.searchParams.get('pageStart') || '0', 10) || 0);
  const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get('pageSize') || '24', 10) || 24));

  try {
    const statusParam = url.searchParams.get('status');
    const status = statusParam === 'airing' || statusParam === 'ended' ? statusParam : undefined;
    const { items, total } = await fetchDoubanRecommend({
      kind,
      tags,
      sort,
      score,
      yearRange: null,
      minScore: null,
      pageStart,
      pageSize,
      ...(status ? { status } : {}),
    });
    // 片库变化慢：边缘节点共享 30 分钟，翻页、换筛选回来都更快
    return NextResponse.json(
      { items, total },
      { headers: { 'Cache-Control': 'public, s-maxage=1800, stale-while-revalidate=7200' } },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '豆瓣推荐获取失败' },
      { status: 502 }
    );
  }
}
