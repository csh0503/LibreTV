import { describe, expect, it } from 'vitest';
import type { DoubanItem } from './types';
import { episodeCountOf, sameWork } from './work-identity';
import { fuseCatalogItems } from './douban';
import { fuseMultiSourceRankings } from './douban-weekly';

const item = (p: Partial<DoubanItem> & { id: string; title: string }): DoubanItem => ({ cover: `${p.id}.jpg`, isTv: true, ...p });

// 用户截图：分类片库「动漫 · 2026」里的《航海王》，封面是老番、简介是 TMDB 的乐高特别篇
const classicBili = item({ id: 'bili_idx_33415', title: '航海王', year: '2026', yearSoft: true, remarks: '更新至第1150话', area: '日本', genres: '动画' });
const legoTmdb = item({ id: 'tmdb_281234', title: '航海王', year: '2026', rating: '7.7', sourceLabel: 'TMDB' });
const classicDouban = item({ id: '1453238', title: '航海王', year: '1999', rating: '9.2' });

describe('同名不同作品不合并', () => {
  it('乐高特别篇（2026 开播）和播到 1150 话的老番不是同一部', () => {
    expect(sameWork(classicBili, legoTmdb, { nowYear: 2026 })).toBe(false);
    expect(sameWork(classicDouban, legoTmdb, { nowYear: 2026 })).toBe(false);
    expect(sameWork(classicBili, classicDouban, { nowYear: 2026 })).toBe(true);
  });

  it('分类片库：两部各一张卡，老番的封面不再配乐高的年份', () => {
    const fused = fuseCatalogItems([[classicDouban], [classicBili], [legoTmdb]], 10);
    expect(fused).toHaveLength(2);
    const classic = fused.find((i) => i.id === '1453238')!;
    expect(classic.year).toBe('1999');
    expect(classic.remarks).toBe('更新至第1150话');
    const lego = fused.find((i) => i.id === 'tmdb_281234')!;
    expect(lego.cover).toBe('tmdb_281234.jpg');
  });

  it('同一来源编号不同、电影 vs 剧集、年份差两年以上：都不合并', () => {
    expect(sameWork(item({ id: 'tmdb_1', title: 'x' }), item({ id: 'tmdb_2', title: 'x' }))).toBe(false);
    expect(sameWork(item({ id: '1', title: 'x', isTv: true }), item({ id: '2', title: 'x', isTv: false }))).toBe(false);
    expect(sameWork(item({ id: '1', title: 'x', year: '2019' }), item({ id: 'tmdb_2', title: 'x', year: '2024' }))).toBe(false);
    // 跨年开播、各站登记差一年：算同一部
    expect(sameWork(item({ id: '1', title: 'x', year: '2025' }), item({ id: 'tmdb_2', title: 'x', year: '2026' }))).toBe(true);
    // B站片库和 B站热播榜是同一套编号
    expect(sameWork(item({ id: 'bili_idx_7', title: 'x' }), item({ id: 'bili_7', title: 'x' }))).toBe(true);
  });

  it('按筛选年份填的年份让位给来源自己给的', () => {
    const fused = fuseCatalogItems([[item({ id: 'bili_idx_9', title: '某番', year: '2026', yearSoft: true })], [item({ id: 'tmdb_9', title: '某番', year: '2025' })]], 10);
    expect(fused).toHaveLength(1);
    expect(fused[0].year).toBe('2025');
    expect(fused[0].yearSoft).toBeUndefined();
  });

  it('排行榜：同一系列的不同季照样合并成一个坑位，同名的电影和剧集分开', () => {
    const ranked = fuseMultiSourceRankings(
      [
        { name: '豆瓣实时剧', items: [item({ id: 'a1', title: '某剧 第三季', year: '2026', status: 'airing' }), item({ id: 'm1', title: '同名', isTv: false })] },
        { name: 'B站番剧', items: [item({ id: 'bili_1', title: '某剧', year: '2020' }), item({ id: 'bili_2', title: '同名', isTv: true })] },
      ],
      { filterEvergreen: false },
    );
    expect(ranked.filter((i) => i.title.startsWith('某剧'))).toHaveLength(1);
    expect(ranked.filter((i) => i.title === '同名')).toHaveLength(2);
  });

  it('集数：「全24集」「更新至1150话」算，「更新至20251016期」不算', () => {
    expect(episodeCountOf('全24集')).toBe(24);
    expect(episodeCountOf('更新至第1150话')).toBe(1150);
    expect(episodeCountOf('更新至20251016期')).toBeUndefined();
  });
});

describe('动画和真人版不合并', () => {
  it('《时光代理人》TMDB 动画 vs B站真人剧', () => {
    const anime = item({ id: 'tmdb_123542', title: '时光代理人', year: '2021', genres: '动画 科幻奇幻 悬疑' });
    const live = item({ id: 'bili_47841', title: '时光代理人', genres: '剧情' });
    expect(sameWork(anime, live)).toBe(false);
    expect(sameWork(anime, live, { acrossSeasons: true })).toBe(false);
    // 题材没写的不算矛盾
    expect(sameWork(anime, item({ id: '1', title: '时光代理人' }))).toBe(true);
  });
});

describe('各站中文译名不同：靠原名认同一部', () => {
  it('Bangumi「相反的你和我」+ TMDB「正相反的你与我」+ 豆瓣「相反的你和我」→ 一张卡', () => {
    const fused = fuseCatalogItems(
      [
        [item({ id: '37134598', title: '相反的你和我', year: '2026', genres: '喜剧 爱情 动画' })],
        [item({ id: 'bgm_525565', title: '相反的你和我', year: '2026', genres: '动画 恋爱 校园', originalTitle: '正反対な君と僕' })],
        [item({ id: 'tmdb_278043', title: '正相反的你与我', year: '2026', genres: '动画 喜剧', originalTitle: '正反対な君と僕' })],
      ],
      10,
    );
    expect(fused).toHaveLength(1);
    expect(fused[0].title).toBe('相反的你和我');
  });

  it('Bangumi 条目标着「动画」：不会和豆瓣同名的动画拆开', () => {
    const fused = fuseCatalogItems(
      [[item({ id: '38194261', title: '尼古喵喵', year: '2026', genres: '动画' })], [item({ id: 'bgm_622206', title: '尼古喵喵', year: '2026', genres: '动画 搞笑' })]],
      10,
    );
    expect(fused).toHaveLength(1);
  });
});

describe('季数写法 / 副标题不同：靠系列名和季数认同一部', () => {
  it('「无职转生 第三季 ～…～」=「无职转生Ⅲ …」', async () => {
    const { seasonKey } = await import('./work-identity');
    expect(seasonKey('无职转生 第三季 ～到了异世界就拿出真本事～')).toBe(seasonKey('无职转生Ⅲ 到了异世界就拿出真本事'));
    expect(seasonKey('葬送的芙莉莲 第二季')).toBe(seasonKey('葬送的芙莉莲 Season 2'));
    expect(seasonKey('某剧 第十二季')).toBe('season:某剧#12');
    // 第一季、没写季数、续作电影：不出季数键
    expect(seasonKey('无职转生 第一季')).toBeUndefined();
    expect(seasonKey('无职转生')).toBeUndefined();
    expect(seasonKey('坠落2：死点')).toBeUndefined();
    // 第二季和第三季不是同一个键
    expect(seasonKey('咒术回战 第二季')).not.toBe(seasonKey('咒术回战 第三季'));
  });

  it('片库：两种写法合成一张卡', () => {
    const fused = fuseCatalogItems(
      [
        [item({ id: '35460732', title: '无职转生Ⅲ 到了异世界就拿出真本事', year: '2026', genres: '动画' })],
        [item({ id: 'bgm_501963', title: '无职转生 第三季 ～到了异世界就拿出真本事～', year: '2026', genres: '动画 异世界' })],
      ],
      10,
    );
    expect(fused).toHaveLength(1);
  });
});

describe('跨页合并', () => {
  it('第一页 TMDB「黄泉的使者」、第二页 Bangumi「黄泉使者」（原名相同）→ 留第一张', async () => {
    const { mergeSameWorks } = await import('./work-identity');
    const out = mergeSameWorks([
      item({ id: 'tmdb_260463', title: '黄泉的使者', year: '2026', genres: '动画', originalTitle: '黄泉のツガイ' }),
      item({ id: '1', title: '别的', year: '2026' }),
      item({ id: 'bgm_568572', title: '黄泉使者', year: '2026', genres: '动画 战斗', originalTitle: '黄泉のツガイ', rating: '7.9' }),
      item({ id: '37938249', title: '炒翻天', year: '2026', genres: '剧情 动画' }),
      item({ id: 'bgm_615835', title: '炒翻天', year: '2026', genres: '动画 美食' }),
    ]);
    expect(out.map((i) => i.title)).toEqual(['黄泉的使者', '别的', '炒翻天']);
    expect(out[0].rating).toBe('7.9');
  });
});

describe('撞名的新作换成更具体的名字', () => {
  it('乐高特别篇：「航海王」→「乐高航海王」；经典版的别名「海贼王」不算', async () => {
    const { specificTitle } = await import('./title-aliases');
    expect(specificTitle('航海王', ['乐高航海王', 'LEGO 航海王', '乐高海贼王'])).toBe('乐高航海王');
    expect(specificTitle('航海王', ['海贼王'])).toBeUndefined();
    // 长得多的不算（多半是另一部的副标题版）
    expect(specificTitle('航海王', ['航海王剧场版：红发歌姬特别加长纪念版'])).toBeUndefined();
  });
});
