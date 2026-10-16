import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { fetchBilibiliTimes, fetchTheIntroDbTimes, mergeSkipTimes, parseTmdbRef } from '@/lib/skip-sources';
import { fetchSkipTimes, resolveAnimeIds, type SkipTimes } from '@/lib/skip-times';
import { resolveTitleIdentity } from '@/lib/title-identity';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** 片名里带季数（第三季 / Season 2）：TMDB 编号没写第几季时不能当第 1 季查 */
const HAS_SEASON = /第\s*[一二三四五六七八九十\d]+\s*[季部期]|season\s*\d|\d+(?:st|nd|rd|th)\s*season/i;

/**
 * 片头片尾：?title=&year=&episode=（从 1 起）&length=（秒）&anime=1&kind=tv|movie
 * 动漫：B站官方 + AniSkip + TheIntroDB；其他：TheIntroDB（按 TMDB 编号）。合并后每段挑最可靠的。
 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const sp = new URL(req.url).searchParams;
  const title = (sp.get('title') || '').trim().slice(0, 100);
  const episode = parseInt(sp.get('episode') || '', 10);
  const lengthRaw = parseInt(sp.get('length') || '', 10);
  const length = Number.isFinite(lengthRaw) && lengthRaw > 0 ? lengthRaw : undefined;
  const year = /^\d{4}$/.test(sp.get('year') || '') ? sp.get('year')! : undefined;
  const anime = sp.get('anime') === '1';
  const kind = sp.get('kind') === 'movie' ? 'movie' : 'tv';
  if (!title || !Number.isFinite(episode) || episode < 1 || episode > 5000) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  let transient = false;
  const note = <T,>(v: T | undefined): T | undefined => {
    if (v === undefined) transient = true;
    return v;
  };
  const sources: (SkipTimes | undefined)[] = [];
  let malId: number | null = null;

  if (anime) {
    const ids = note(await resolveAnimeIds(title, year));
    malId = ids?.mal ?? null;
    const tmdb = parseTmdbRef(ids?.tmdb);
    const tmdbUsable = tmdb && (tmdb.kind === 'movie' || tmdb.season !== undefined || !HAS_SEASON.test(title));
    const [bili, aniskip, tidb] = await Promise.all([
      ids?.biliMedia ? fetchBilibiliTimes(ids.biliMedia, episode, length).then(note) : undefined,
      ids?.mal ? fetchSkipTimes(ids.mal, episode, length).then(note) : undefined,
      tmdbUsable ? fetchTheIntroDbTimes(tmdb, episode, length).then(note) : undefined,
    ]);
    sources.push(bili, aniskip, tidb);
  } else {
    const identity = note(await resolveTitleIdentity({ title, year, kind }));
    if (identity) {
      sources.push(
        note(
          await fetchTheIntroDbTimes(
            { kind: identity.kind === 'movie' ? 'movie' : 'tv', id: identity.tmdbId, season: identity.info?.season },
            episode,
            length,
          ),
        ),
      );
    }
  }

  const merged = mergeSkipTimes(sources);
  // 暂时查不了不缓存；查到 / 确定没有缓存一天
  return NextResponse.json(
    { malId, ...merged },
    { headers: { 'Cache-Control': transient ? 'no-store' : 'public, s-maxage=86400, stale-while-revalidate=604800' } },
  );
}
