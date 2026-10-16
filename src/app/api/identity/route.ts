import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { resolveTitleIdentity } from '@/lib/title-identity';

export const runtime = 'nodejs';

/** 作品身份：?title=&year=&kind=movie|tv&tmdb= → 这部作品的其他中文名（找片源的备用搜索词） */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;

  const sp = new URL(req.url).searchParams;
  const title = (sp.get('title') || '').trim().slice(0, 100);
  if (!title) return NextResponse.json({ error: '缺少 title' }, { status: 400 });
  const kindRaw = sp.get('kind');
  const kind = kindRaw === 'movie' || kindRaw === 'tv' ? kindRaw : undefined;
  const year = /^\d{4}$/.test(sp.get('year') || '') ? sp.get('year')! : undefined;
  const tmdb = parseInt(sp.get('tmdb') || '', 10);

  const identity = await resolveTitleIdentity({
    title,
    year,
    kind,
    tmdbId: Number.isFinite(tmdb) && tmdb > 0 ? tmdb : undefined,
  });
  // 暂时查不了（TMDB 失败）时不让边缘节点缓存，下次再试
  return NextResponse.json(
    { identity: identity ?? null },
    {
      headers: {
        'Cache-Control':
          identity === undefined ? 'no-store' : 'public, s-maxage=86400, stale-while-revalidate=604800',
      },
    },
  );
}
