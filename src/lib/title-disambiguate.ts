import type { DoubanItem } from './types';
import { isEvergreenTitle } from './douban-weekly';
import { resolveTitleIdentity } from './title-identity';
import { specificTitle } from './title-aliases';

/**
 * TMDB 条目的中文名和常年连载的老作品撞名（2026 年的乐高特别篇也叫「航海王」）时，
 * 换成它更具体的中文名（「乐高航海王」，来自 TMDB 的别名 / 译名）。
 * 只处理「TMDB 条目 + 撞的是航海王、柯南这类长寿作品 + 近两年的新作」，每批最多 4 部（身份查询缓存一天）。
 */
export async function disambiguateTitles(items: DoubanItem[], now = Date.now()): Promise<DoubanItem[]> {
  const nowYear = new Date(now + 8 * 3600_000).getUTCFullYear();
  const targets = items
    .map((item, i) => ({ item, i }))
    .filter(({ item }) => /^tmdb_\d+$/.test(item.id) && (parseInt(item.year ?? '', 10) || 0) >= nowYear - 1 && isEvergreenTitle(item.title))
    .slice(0, 4);
  if (targets.length === 0) return items;
  const out = [...items];
  await Promise.all(
    targets.map(async ({ item, i }) => {
      const identity = await resolveTitleIdentity({
        title: item.title,
        kind: item.isTv === false ? 'movie' : 'tv',
        tmdbId: Number(item.id.slice(5)),
      }).catch(() => undefined);
      const better = identity ? specificTitle(item.title, identity.names) : undefined;
      if (better) out[i] = { ...item, title: better };
    }),
  );
  return out;
}
