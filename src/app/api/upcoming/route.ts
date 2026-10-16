import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchUpcoming } from '@/lib/upcoming';

export const runtime = 'nodejs';

/** 即将播出：接下来 7 天的未播出内容（AniList 放送表 + Bangumi 中文名 + TMDB 剧集/电影） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  try {
    const items = await fetchUpcoming();
    return NextResponse.json({ items });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : '即将播出获取失败' },
      { status: 502 }
    );
  }
}
