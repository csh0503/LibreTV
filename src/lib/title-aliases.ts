import { normalizeTitle } from './cms-parser';
import type { SearchResultItem } from './types';

/**
 * 豆瓣/Bangumi 译名和片源站通行名不是同一套。
 * 点「航海王」时要同时搜「海贼王」，搜「黑色五叶草」时要同时搜「黑色四叶草」，否则来源会很少或分裂。
 */
export const ALIAS_GROUPS: string[][] = [
  ['航海王', '海贼王', 'ONE PIECE'],
  ['黑色五叶草', '黑色四叶草', 'Black Clover'],
  ['境·界', '死神', 'BLEACH'],
  ['哆啦A梦', '机器猫', '小叮当'],
  ['宝可梦', '宠物小精灵', '神奇宝贝', '口袋妖怪', '精灵宝可梦'],
  ['数码宝贝', '数码暴龙'],
  ['龙珠', '七龙珠'],
  ['灌篮高手', '男儿当入樽'],
  ['名侦探柯南', '柯南'],
  ['新世纪福音战士', '福音战士', 'EVA'],
  ['电锯人', '链锯人'],
  ['间谍过家家', '间谍家家酒'],
  ['药屋少女的呢喃', '药师少女的呢喃'],
  ['关于我转生变成史莱姆这档事', '转生史莱姆'],
  ['Re:从零开始的异世界生活', '从零开始的异世界生活'],
  ['五等分的新娘', '五等分的花嫁'],
  ['东京喰种', '东京食尸鬼'],
  ['全职猎人', 'HUNTER×HUNTER'],
  ['千与千寻', '神隐少女'],
  ['哈尔的移动城堡', '霍尔的移动城堡'],
  ['蜘蛛侠', '蜘蛛人'],
  ['钢铁侠', '铁甲奇侠'],
  ['星球大战', '星际大战'],
  ['指环王', '魔戒'],
  ['哈利·波特', '哈利波特'],
  ['加勒比海盗', '神鬼奇航'],
  ['速度与激情', '狂野极速'],
  ['碟中谍', '职业特工队'],
  ['驯龙高手', '驯龙记'],
  ['疯狂动物城', '动物方城市'],
  ['寻梦环游记', '玩转极乐世界'],
  ['冰雪奇缘', '魔雪奇缘'],
  ['超人总动员', '超人特工队'],
  ['头脑特工队', '脑筋急转弯'],
  ['飞屋环游记', '天外奇迹'],
  ['机器人总动员', '瓦力'],
  ['玩具总动员', '反斗奇兵'],
  ['我的英雄学院', '我的英雄学园'],
  ['反叛的鲁路修', 'Code Geass'],
  ['死亡笔记', '死亡笔记本'],
  ['命运石之门', 'Steins;Gate'],
  ['某科学的超电磁炮', '科学超电磁炮'],
  ['更衣人偶坠入爱河', '恋上换装娃娃'],
  ['足球小将', '队长小翼'],
  ['美少女战士', '水手月亮'],
  ['致不灭的你', '给不灭的你'],
  ['迷宫饭', '舌尖上的地下城'],
  ['蓝色监狱', '蓝锁'],
  ['辉夜大小姐想让我告白', '辉夜姬想让人告白'],
  ['无职转生', '无职转生～到了异世界就拿出真本事～'],
  ['赛博朋克：边缘行者', '赛博朋克：边缘跑手', 'Cyberpunk: Edgerunners'],
  ['葬送的芙莉莲', '葬送的芙莉蓮', '芙莉莲'],
  ['孤独摇滚', '孤独摇滚！'],
  ['我推的孩子', '【我推的孩子】'],
  ['败犬女主太多了', '败北女角太多了'],
];

const MAX_TERMS = 4;

/**
 * 提取带有冒号、破折号、波浪号或长副标题的主片名，
 * 用于点击「列女战纪：女娲石记」「无职转生Ⅲ 到了异世界就拿出真本事」等卡片时并发回退检索。
 * 注意：不拆分「海贼王剧场版」这类无分隔符的短词。
 */
export function extractCoreSearchStem(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // 1. 显式分隔符（冒号、波浪号、破折号）前的主标题
  const colonMatch = trimmed.match(/^(.{2,15}?)\s*[:：～~—\-]\s*.+$/);
  if (colonMatch) {
    const stem = colonMatch[1]
      .replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+$/, '')
      .replace(/第[一二三四五六七八九十\d]+[季部篇期]$/, '')
      .trim();
    if (stem.length >= 2 && stem !== trimmed) return stem;
  }

  // 2. 罗马数字季数或空格副标题（如「无职转生Ⅲ 到了异世界就拿出真本事」「灵笼 第二季」）
  const spaceMatch = trimmed.match(/^([\u4e00-\u9fa5A-Za-z0-9]{2,12}?)(?:[ⅠⅡⅢⅣⅤⅥ]|\s+第[一二三四五六七八九十\d]+[季部篇期]|\s+[\u4e00-\u9fa5]{4,}).*$/);
  if (spaceMatch) {
    const stem = spaceMatch[1].trim();
    if (stem.length >= 2 && stem !== trimmed) return stem;
  }

  return undefined;
}

/** 原词在前，其余是别名或主片名降级词。没有别名时只返回原词。 */
export function expandSearchTerms(wd: string): string[] {
  const raw = wd.trim();
  if (!raw) return [];
  const normalized = normalizeTitle(raw);
  const terms: string[] = [raw];

  for (const group of ALIAS_GROUPS) {
    const matched = group.find((alias) => {
      const n = normalizeTitle(alias);
      return n.length >= 2 && (normalized === n || normalized.includes(n));
    });
    if (!matched) continue;
    // 「海贼王剧场版」这种已经带后缀且无分隔符的搜索不再拆成整部作品的每个别名
    if (normalizeTitle(matched) !== normalized) break;
    for (const alias of group) {
      if (normalizeTitle(alias) === normalized) continue;
      if (!terms.some((term) => normalizeTitle(term) === normalizeTitle(alias))) terms.push(alias);
      if (terms.length >= MAX_TERMS) break;
    }
    return terms;
  }

  const stem = extractCoreSearchStem(raw);
  if (stem && !terms.some((t) => normalizeTitle(t) === normalizeTitle(stem))) {
    terms.push(stem);
    // 若主片名本身还有同义词（如「黑色五叶草 第二季」→ 主名「黑色五叶草」→ 别名「黑色四叶草」），一并补入
    const stemNorm = normalizeTitle(stem);
    for (const group of ALIAS_GROUPS) {
      if (group.some((a) => normalizeTitle(a) === stemNorm)) {
        for (const alias of group) {
          if (normalizeTitle(alias) !== stemNorm && terms.length < MAX_TERMS) {
            terms.push(alias);
          }
        }
        break;
      }
    }
  }

  return terms.slice(0, MAX_TERMS);
}

/** 同一作品的不同译名收成同一个键。没有别名时就是去掉标点后的原名。 */
export function canonicalTitle(title: string): string {
  const normalized = normalizeTitle(title.trim());
  if (!normalized) return '';
  for (const group of ALIAS_GROUPS) {
    if (group.some((alias) => normalizeTitle(alias) === normalized)) return normalizeTitle(group[0]);
  }
  return normalized;
}

/**
 * 将标题中出现的已知同义词前缀替换为统一主名（保留季数/副标题），
 * 例如「黑色四叶草 第二季」→「黑色五叶草 第二季」。
 */
export function replaceAliasInTitle(title: string, preferredQuery?: string): string {
  let result = title.trim();
  if (!result) return '';
  const queryNorm = preferredQuery ? normalizeTitle(preferredQuery) : '';

  for (const group of ALIAS_GROUPS) {
    const targetReplacement =
      (queryNorm && group.find((a) => normalizeTitle(a) === queryNorm)) || group[0];
    for (const alias of group) {
      if (alias === targetReplacement) continue;
      if (result.startsWith(alias)) {
        result = targetReplacement + result.slice(alias.length);
        return result;
      }
    }
  }
  return result;
}

/** 结果标题是否属于这次搜索的别名（用来把航海王和海贼王、黑色四叶草和黑色五叶草收成一张卡片） */
export function titleMatchesQuery(name: string, query: string): boolean {
  const terms = expandSearchTerms(query);
  if (terms.length < 2) return false;
  const normalized = normalizeTitle(name);
  if (!normalized) return false;
  return terms.some((term) => {
    const n = normalizeTitle(term);
    return n.length >= 2 && (normalized === n || normalized.includes(n));
  });
}

// —— 跨源同名搜索结果智能聚合 ——

export interface AggregatedGroup {
  key: string;
  name: string;
  year?: string;
  typeName?: string;
  pic?: string;
  remarks?: string;
  items: SearchResultItem[];
}

const CN_DIGITS: Record<string, string> = {
  '01': '一', '1': '一',
  '02': '二', '2': '二',
  '03': '三', '3': '三',
  '04': '四', '4': '四',
  '05': '五', '5': '五',
  '06': '六', '6': '六',
  '07': '七', '7': '七',
  '08': '八', '8': '八',
  '09': '九', '9': '九',
  '10': '十',
};

/** 提取标准 4 位年份（把 "2017-"、"2017年" 归一为 "2017"） */
export function normalizeYearToken(raw?: string): string | undefined {
  if (!raw) return undefined;
  const m = raw.match(/\b(19\d{2}|20\d{2})\b/);
  return m ? m[1] : undefined;
}

function isCommentaryItem(item: SearchResultItem): boolean {
  return /\[?电影解说\]?|影视解说|几分钟看/.test(item.name || '') || /解说/.test(item.typeName || '');
}

const TRAILING_SEASON = /第[一二三四五六七八九十百]+[季部篇期]$/;

/**
 * 搜索结果里有没有「这部作品本身」：同名，或同名加季数 / 副标题（首页卡片多是不带季数的系列名）。
 * 解说类不算。只用来决定要不要提示「暂无片源」，宁可漏判也不误报。
 */
export function hasTitleMatch(groups: AggregatedGroup[], title: string): boolean {
  if (!buildGroupTitleKey(title, title, false)) return groups.length > 0;
  return groups.some(groupMatcher(title));
}

/**
 * 只留这部作品本身（含各季）的分组，供作品详情弹窗列片源。
 * 比 hasTitleMatch 严：片名后面直接接别的字（九门八甲、九门提督）不算同一部，
 * 只认季数、年份、版本这类后缀，或原名里本来就用空格 / 冒号隔开的副标题。
 * 严格规则一个都留不下时退回宽松规则，免得把有片源的作品判成没有。
 */
export function matchingGroups(groups: AggregatedGroup[], title: string): AggregatedGroup[] {
  const strict = groups.filter(groupMatcher(title, true));
  return strict.length > 0 ? strict : groups.filter(groupMatcher(title));
}

/** 片名后面跟着这些，才算同一部的某一季 / 某个版本 */
const SAME_WORK_SUFFIX =
  /^(?:\d{1,4}|[一二三四五六七八九十]+|第[\d一二三四五六七八九十百]+[季部篇期章]|.{0,4}[季篇章]|season\d+|s\d{1,2}|part\d+|[\u2160-\u217f]+|ova|oad|sp|特别篇|番外篇?|剧场版|电影版|国语版?|粤语版?|普通话版?|日语版?|原声版?|tv版?|未删减版?|导演剪辑版?|加长版?)?$/i;
const SUBTITLE_SEPARATOR = /[\s:：·\-—(（]/;

/** 搜索源的分类名 → 电影 / 剧集；看不出来返回 undefined */
export function kindOfTypeName(typeName?: string): 'movie' | 'tv' | undefined {
  const t = typeName?.trim();
  if (!t || /动画片/.test(t)) return undefined;
  if (/片$|电影/.test(t)) return 'movie';
  if (/剧|综艺|动漫|番/.test(t)) return 'tv';
  return undefined;
}

/** 分组片名去掉结尾和年份相同的数字（「九门2026」→「九门」），用来把同一部的不同写法并在一起 */
function workKeyOf(g: AggregatedGroup, title: string): string {
  const k = buildGroupTitleKey(g.name, title, false);
  const y = normalizeYearToken(g.year);
  return y && k.length > 4 && k.endsWith(y) ? k.slice(0, -4) : k;
}

/**
 * 作品详情弹窗里的分组：同一部的不同写法合成一组，再按和点开的这部有多像排序——
 * 年份对得上（差 1 年以内）> 电影 / 剧集对得上 > 片名完全一样 > 片源多。
 * 否则同名的旧电影（源多）会排在刚上线的新剧前面，「播放」也会播错。
 */
export function rankGroupsForPick(
  groups: AggregatedGroup[],
  pick: { title: string; year?: string; isTv?: boolean },
): AggregatedGroup[] {
  const titleKey = buildGroupTitleKey(pick.title, pick.title, false);
  const merged: { key: string; year?: number; group: AggregatedGroup; idx: number }[] = [];
  groups.forEach((g, idx) => {
    const key = workKeyOf(g, pick.title);
    const y = normalizeYearToken(g.year);
    const year = y ? parseInt(y, 10) : undefined;
    const same = merged.find(
      (m) => m.key === key && (m.year === undefined || year === undefined || Math.abs(m.year - year) <= 1),
    );
    if (!same) {
      merged.push({ key, year, group: g, idx });
      return;
    }
    const seen = new Set(same.group.items.map((i) => `${i.sourceKey}_${i.vodId}`));
    const extra = g.items.filter((i) => !seen.has(`${i.sourceKey}_${i.vodId}`));
    const keepName = buildGroupTitleKey(same.group.name, pick.title, false) === titleKey ? same.group.name : g.name;
    same.group = {
      ...same.group,
      key: `${same.group.key}+${g.key}`,
      name: keepName,
      year: same.group.year ?? g.year,
      typeName: same.group.typeName ?? g.typeName,
      pic: same.group.pic ?? g.pic,
      remarks: same.group.remarks ?? g.remarks,
      items: [...same.group.items, ...extra],
    };
    if (same.year === undefined) same.year = year;
  });

  const pickYear = normalizeYearToken(pick.year);
  const want = pick.isTv === true ? 'tv' : pick.isTv === false ? 'movie' : undefined;
  const score = (m: (typeof merged)[number]) => {
    const yearScore = pickYear && m.year !== undefined ? (Math.abs(m.year - parseInt(pickYear, 10)) <= 1 ? 2 : 0) : 1;
    const kind = kindOfTypeName(m.group.typeName);
    const kindScore = want && kind ? (want === kind ? 1 : -1) : 0;
    const exact = m.key === titleKey ? 1 : 0;
    return [yearScore, kindScore, exact, new Set(m.group.items.map((i) => i.sourceKey)).size];
  };
  return merged
    .map((m) => ({ m, s: score(m) }))
    .sort((a, b) => {
      for (let i = 0; i < a.s.length; i++) if (a.s[i] !== b.s[i]) return b.s[i] - a.s[i];
      return a.m.idx - b.m.idx;
    })
    .map((x) => x.m.group);
}

function groupMatcher(title: string, strict = false): (g: AggregatedGroup) => boolean {
  const key = buildGroupTitleKey(title, title, false);
  const base = key.replace(TRAILING_SEASON, '');
  return (g) => {
    if (!key || g.items.every(isCommentaryItem)) return false;
    const k = buildGroupTitleKey(g.name, title, false);
    if (k === key) return true;
    if (base.length < 2 || !k.startsWith(base)) return false;
    if (!strict) return true;
    return SAME_WORK_SUFFIX.test(k.slice(base.length)) || SUBTITLE_SEPARATOR.test(g.name.trim());
  };
}

/**
 * 计算聚合分桶键：
 * - 统一同义词（如「黑色四叶草」→「黑色五叶草」、「海贼王」→「航海王」）
 * - 统一季数写法（「第02季 / 第2季」→「第二季」）
 * - 吸收穿插在主名与副标题之间的可选「剧场版 / 电影版」（使「黑色五叶草 剧场版 魔法帝之剑」与「黑色五叶草：魔法帝之剑」合一）
 * - 去除所有空格与全半角标点（使「Q版！黑色五叶草」与「Q版! 黑色五叶草」、「黑色五叶草 第二季」与「黑色五叶草第二季」合一）
 */
export function buildGroupTitleKey(rawName: string, query?: string, commentary = false): string {
  const aliased = replaceAliasInTitle(rawName, query);
  const normalized = aliased
    .toLowerCase()
    .replace(/第(0?[1-9]|10)([季部篇期])/g, (_, num: string, unit: string) => `第${CN_DIGITS[num] || num}${unit}`)
    .replace(/(?:剧场版|电影版)(?=\s*[:：·\-]?\s*[\u4e00-\u9fa5a-z0-9]{2,})/g, '')
    .replace(/[\s·:：!！?？,，.。、~～\-—_《》〈〉()（）]+/g, '');
  const baseKey = canonicalTitle(normalized) || normalized;
  return commentary ? `__commentary__:${baseKey}` : baseKey;
}

function pickBestDisplayName(items: SearchResultItem[], query?: string): string {
  const searched = query?.trim();
  const aliasedNames = items.map((i) => replaceAliasInTitle((i.name || '').trim(), searched));
  if (searched) {
    const queryKey = buildGroupTitleKey(searched, searched, false);
    const firstKey = buildGroupTitleKey(aliasedNames[0] || '', searched, isCommentaryItem(items[0]));
    if (queryKey === firstKey) return searched;
  }
  const freq = new Map<string, number>();
  for (const name of aliasedNames) {
    if (!name) continue;
    freq.set(name, (freq.get(name) ?? 0) + 1);
  }
  let best = aliasedNames[0] || '';
  let bestScore = -1;
  for (const [name, count] of freq) {
    const score = count * 10 + (/[:：\s]/.test(name) ? 1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return best;
}

function buildGroup(name: string, year: string | undefined, items: SearchResultItem[]): AggregatedGroup {
  return {
    key: `${name}|${year ?? ''}|${items.map((i) => `${i.sourceKey}_${i.vodId}`).join(',')}`,
    name,
    year,
    typeName: items.find((i) => i.typeName)?.typeName,
    pic: items.find((i) => i.pic)?.pic,
    remarks: items.find((i) => i.remarks)?.remarks,
    items,
  };
}

/**
 * 把扁平的跨源搜索结果按「归一化同名影片」聚合：
 * - 消除空格、标点、剧场版前缀、同义译名（如黑色四叶草/五叶草）造成的碎片卡片；
 * - 年份清洗为 4 位数字（"2017-" → "2017"），并对相差 ≤1 年的采集站年份误差自动聚类合并；
 * - 电影解说类条目单独归类并排在末尾。
 */
export function aggregateResults(list: SearchResultItem[], query?: string): AggregatedGroup[] {
  const byBucket = new Map<string, SearchResultItem[]>();
  const searched = query?.trim();

  for (const item of list) {
    const raw = (item.name || '').trim();
    if (!raw) continue;
    const commentary = isCommentaryItem(item);
    const k = buildGroupTitleKey(raw, searched, commentary);
    if (!k) continue;
    if (!byBucket.has(k)) byBucket.set(k, []);
    byBucket.get(k)!.push(item);
  }

  const groups: AggregatedGroup[] = [];
  for (const [, bucketItems] of byBucket) {
    const displayName = pickBestDisplayName(bucketItems, searched);
    const yearCounts = new Map<number, number>();
    for (const item of bucketItems) {
      const y = normalizeYearToken(item.year);
      if (y) {
        const num = parseInt(y, 10);
        yearCounts.set(num, (yearCounts.get(num) ?? 0) + 1);
      }
    }

    const sortedYears = [...yearCounts.keys()].sort((a, b) => a - b);
    const clusters: { representative: number; years: Set<number> }[] = [];
    for (const y of sortedYears) {
      const prev = clusters[clusters.length - 1];
      if (prev && [...prev.years].some((py) => Math.abs(py - y) <= 1)) {
        prev.years.add(y);
        if ((yearCounts.get(y) ?? 0) > (yearCounts.get(prev.representative) ?? 0)) {
          prev.representative = y;
        }
      } else {
        clusters.push({ representative: y, years: new Set([y]) });
      }
    }

    if (clusters.length <= 1) {
      const repYear = clusters[0] ? String(clusters[0].representative) : undefined;
      groups.push(buildGroup(displayName, repYear, bucketItems));
    } else {
      for (const cluster of clusters) {
        const matched = bucketItems.filter((i) => {
          const y = normalizeYearToken(i.year);
          return y && cluster.years.has(parseInt(y, 10));
        });
        if (matched.length > 0) {
          groups.push(buildGroup(displayName, String(cluster.representative), matched));
        }
      }
      const noYear = bucketItems.filter((i) => !normalizeYearToken(i.year));
      if (noYear.length > 0) {
        groups.push(buildGroup(displayName, undefined, noYear));
      }
    }
  }

  const searchedKey = searched ? buildGroupTitleKey(searched, searched, false) : '';
  return groups
    .map((g, idx) => ({ g, idx }))
    .sort((a, b) => {
      const aComm = a.g.items.some(isCommentaryItem) ? 1 : 0;
      const bComm = b.g.items.some(isCommentaryItem) ? 1 : 0;
      if (aComm !== bComm) return aComm - bComm;
      if (searchedKey) {
        const aExact = buildGroupTitleKey(a.g.name, searched, false) === searchedKey ? 1 : 0;
        const bExact = buildGroupTitleKey(b.g.name, searched, false) === searchedKey ? 1 : 0;
        if (aExact !== bExact) return bExact - aExact;
      }
      if (b.g.items.length !== a.g.items.length) return b.g.items.length - a.g.items.length;
      return a.idx - b.idx;
    })
    .map((x) => x.g);
}


/**
 * 同名作品里更具体的那个名字：TMDB 给 2026 年的乐高特别篇的中文名也是「航海王」，
 * 它的其他中文名里有「乐高航海王」——包含原名、只多几个字的，就用它（卡片、详情、找片源都更准）。
 */
export function specificTitle(title: string, names: string[]): string | undefined {
  const base = canonicalTitle(title);
  if (!base) return undefined;
  return names.find((n) => {
    const key = canonicalTitle(n);
    return key !== base && key.includes(base) && key.length <= base.length + 6 && /[\u4e00-\u9fa5]/.test(n);
  });
}
