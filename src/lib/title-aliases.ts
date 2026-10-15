import { normalizeTitle } from './cms-parser';

/**
 * 豆瓣/Bangumi 译名和片源站通行名不是同一套。
 * 点「航海王」时要同时搜「海贼王」，否则来源会很少。
 * 只收确实不一样的写法，同一标题的标点差异交给 normalizeTitle。
 */
const ALIAS_GROUPS: string[][] = [
  ['航海王', '海贼王', 'ONE PIECE'],
  ['境·界', '死神', 'BLEACH'],
  ['哆啦A梦', '机器猫', '小叮当'],
  ['宝可梦', '宠物小精灵', '神奇宝贝', '口袋妖怪'],
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
];

const MAX_TERMS = 4;

/** 原词在前，其余是别名。没有别名时只返回原词。 */
export function expandSearchTerms(wd: string): string[] {
  const raw = wd.trim();
  if (!raw) return [];
  const normalized = normalizeTitle(raw);
  for (const group of ALIAS_GROUPS) {
    const matched = group.find((alias) => {
      const n = normalizeTitle(alias);
      return n.length >= 2 && (normalized === n || normalized.includes(n));
    });
    if (!matched) continue;
    // 「海贼王剧场版」这种已经带后缀的搜索不再拆成整部作品的每个别名
    if (normalizeTitle(matched) !== normalized) return [raw];
    const terms = [raw];
    for (const alias of group) {
      if (normalizeTitle(alias) === normalized) continue;
      if (!terms.some((term) => normalizeTitle(term) === normalizeTitle(alias))) terms.push(alias);
      if (terms.length >= MAX_TERMS) break;
    }
    return terms;
  }
  return [raw];
}

/** 结果标题是否属于这次搜索的别名（用来把航海王和海贼王收成一张卡片） */
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
