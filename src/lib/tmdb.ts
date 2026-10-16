import { fetchUpstream } from './fetch-utils';
import { getTmdbApiKey } from './douban-weekly';

/** TMDB v3 GET（zh-CN）：支持 v3 api_key 与 v4 Bearer 两种凭证；失败返回 undefined，调用方自行降级 */
export async function tmdbGet<T>(path: string, params: Record<string, string>): Promise<T | undefined> {
  const apiKey = getTmdbApiKey();
  if (!apiKey) return undefined;
  const isBearer = apiKey.length > 40 && apiKey.includes('.');
  const sp = new URLSearchParams({ language: 'zh-CN', ...params });
  if (!isBearer) sp.set('api_key', apiKey);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': 'LibreTV (+https://github.com/LibreSpark/LibreTV)',
  };
  if (isBearer) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const res = await fetchUpstream(`https://api.themoviedb.org/3${path}?${sp.toString()}`, { timeoutMs: 7000, headers });
    if (!res.ok) return undefined;
    return (await res.json()) as T;
  } catch {
    return undefined;
  }
}
