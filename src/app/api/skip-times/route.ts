import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchSkipTimes, resolveMalId } from '@/lib/skip-times';

export const runtime = 'nodejs';

/** 动漫片头片尾：?title=&year=&episode=（从 1 起）&length=（秒）→ { intro?, outro? } */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const sp = new URL(req.url).searchParams;
  const title = (sp.get('title') || '').trim().slice(0, 100);
  const episode = parseInt(sp.get('episode') || '', 10);
  const length = parseInt(sp.get('length') || '', 10);
  const year = /^\d{4}$/.test(sp.get('year') || '') ? sp.get('year')! : undefined;
  if (!title || !Number.isFinite(episode) || episode < 1 || episode > 5000) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }
  const malId = await resolveMalId(title, year);
  const times = malId ? await fetchSkipTimes(malId, episode, Number.isFinite(length) && length > 0 ? length : undefined) : {};
  // 暂时查不了不缓存；查到 / 确定没有缓存一天
  const transient = malId === undefined || times === undefined;
  return NextResponse.json(
    { malId: malId ?? null, ...(times ?? {}) },
    { headers: { 'Cache-Control': transient ? 'no-store' : 'public, s-maxage=86400, stale-while-revalidate=604800' } },
  );
}
