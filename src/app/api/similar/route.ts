import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchSimilar } from '@/lib/douban-similar';

export const runtime = 'nodejs';

/** 「看过这部的人也喜欢」：?title=&year=&kind=tv|movie&id=（豆瓣编号，可选） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const sp = new URL(req.url).searchParams;
  const title = (sp.get('title') || '').trim().slice(0, 100);
  if (!title) return NextResponse.json({ error: '缺少 title' }, { status: 400 });
  const kindRaw = sp.get('kind');
  const items = await fetchSimilar({
    title,
    year: /^\d{4}$/.test(sp.get('year') || '') ? sp.get('year')! : undefined,
    kind: kindRaw === 'tv' || kindRaw === 'movie' ? kindRaw : undefined,
    doubanId: sp.get('id') || undefined,
  });
  return NextResponse.json(
    { items },
    { headers: { 'Cache-Control': items.length > 0 ? 'public, s-maxage=21600, stale-while-revalidate=86400' : 'no-store' } },
  );
}
