import { qualityKey, rankSources } from './source-rank';
import type { SourceHealthEntry } from './store';
import type { SourceQuality } from './stream-quality';
import { aggregateResults, matchingGroups, normalizeYearToken, rankGroupsForPick } from './title-aliases';
import type { SearchResultItem } from './types';

/**
 * 播放中自动换源：这个源播不了（卡住 / 加载失败）时，从同一部作品的其他源里挑下一个。
 * 纯计算部分放这里，方便测试；搜索和跳转在 use-auto-failover.ts。
 */

/** 一集最多自动换几次源（含最初那个），再不行就交给用户手动换 */
export const MAX_FAILOVER_SOURCES = 5;

/** 源站片名常把年份接在后面（「九门2026」）：搜索和匹配用去掉年份的名字 */
export function failoverQueryTitle(title: string, year?: string): string {
  const t = title.trim();
  const y = normalizeYearToken(year);
  const stripped = t.replace(/\s*[(（]?((?:19|20)\d{2})[)）]?$/, (m, found: string) => (!y || found === y ? '' : m));
  return stripped.length >= 2 ? stripped : t;
}

/** URL 里的 tried 参数：已经试过（播不了）的源，逗号分隔的「源_影片」 */
export function parseTried(raw: string | null | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 20);
}

/**
 * 候选源：同一部作品（优先当前这一组，即同一季 / 同一年），排除当前和试过的，
 * 按片源排名（没出错 > 清晰度 > 集数 > 广告 > 速度）排。
 */
export function pickFailoverCandidates(opts: {
  list: SearchResultItem[];
  title: string;
  year?: string;
  isTv?: boolean;
  current: { sourceKey: string; vodId: string };
  tried: string[];
  health: Record<string, SourceHealthEntry | undefined>;
  quality: Record<string, SourceQuality | undefined>;
}): SearchResultItem[] {
  const { list, title, current } = opts;
  const groups = rankGroupsForPick(matchingGroups(aggregateResults(list, title), title), {
    title,
    year: opts.year,
    isTv: opts.isTv,
  });
  if (groups.length === 0) return [];
  const currentKey = qualityKey(current);
  const own = groups.find((g) => g.items.some((i) => qualityKey(i) === currentKey)) ?? groups[0];
  const skip = new Set([currentKey, ...opts.tried]);
  // 同一个点播源里的另一条（同名重复收录）多半一样坏，排到最后
  const usable = own.items.filter((i) => !skip.has(qualityKey(i)));
  const ranked = rankSources(usable, opts.health, opts.quality);
  const triedSources = new Set([current.sourceKey, ...opts.tried.map((k) => k.slice(0, k.lastIndexOf('_')))]);
  return [...ranked.filter((i) => !triedSources.has(i.sourceKey)), ...ranked.filter((i) => triedSources.has(i.sourceKey))];
}
