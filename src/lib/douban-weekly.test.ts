import { describe, expect, it } from 'vitest';
import {
  baiduTeleplayToItem,
  biliRankToItem,
  curateRealtimeList,
  doubanCollectionToItem,
  doubanWeeklyToItem,
  interleaveAndDedupeLists,
  isHotListId,
  tmdbTrendingToItem,
} from './douban-weekly';

describe('isHotListId', () => {
  it('白名单校验：兼容旧 ID 与新增多源实时榜单 ID', () => {
    expect(isHotListId('realtime_all')).toBe(true);
    expect(isHotListId('douban_tv_realtime')).toBe(true);
    expect(isHotListId('douban_movie_realtime')).toBe(true);
    expect(isHotListId('bili_guochuang')).toBe(true);
    expect(isHotListId('bili_bangumi')).toBe(true);
    expect(isHotListId('tmdb_trending')).toBe(true);
    expect(isHotListId('douban_movie_weekly')).toBe(true);
    expect(isHotListId('baidu_teleplay')).toBe(true);
    expect(isHotListId('maoyan')).toBe(false);
    expect(isHotListId('')).toBe(false);
  });
});

describe('doubanWeeklyToItem', () => {
  it('评分、封面（原生地址优先）、isTv 正确映射', () => {
    const item = doubanWeeklyToItem(
      {
        id: 36808876,
        title: '奥德赛',
        rating: 8.6,
        cover_proxy: 'https://doubanio.viki.moe/view/photo/p1.jpg',
        cover: 'https://img9.doubanio.com/view/photo/p1.jpg',
      },
      false
    );
    expect(item).toEqual({
      id: '36808876',
      title: '奥德赛',
      cover: 'https://img9.doubanio.com/view/photo/p1.jpg',
      rating: '8.6',
      isTv: false,
    });
  });

  it('原生 cover 缺失时回退 cover_proxy，0 分不输出 rating', () => {
    const item = doubanWeeklyToItem(
      { id: 2, title: 'y', cover_proxy: 'https://doubanio.viki.moe/view/photo/p2.jpg' },
      true
    );
    expect(item).toMatchObject({ cover: 'https://doubanio.viki.moe/view/photo/p2.jpg', isTv: true });
    const zero = doubanWeeklyToItem({ id: 1, title: 'x', cover: 'c', rating: 0 }, true);
    expect(zero).toMatchObject({ cover: 'c', isTv: true });
    expect(zero?.rating).toBeUndefined();
  });

  it('缺 id、标题或封面的脏数据丢弃', () => {
    expect(doubanWeeklyToItem({ title: 'x', cover: 'c' }, false)).toBeUndefined();
    expect(doubanWeeklyToItem({ id: 1, cover: 'c' }, false)).toBeUndefined();
    expect(doubanWeeklyToItem({ id: 1, title: 'x' }, false)).toBeUndefined();
  });
});

describe('baiduTeleplayToItem', () => {
  it('用序号生成 id，不输出 rating，支持热度与简介可选映射', () => {
    expect(baiduTeleplayToItem({ title: '某剧', cover: 'https://img.example/1.jpg' }, 3)).toEqual({
      id: 'baidu_3',
      title: '某剧',
      cover: 'https://img.example/1.jpg',
      isTv: true,
    });

    const rich = baiduTeleplayToItem(
      { title: '九门', cover: 'https://img.example/2.jpg', score_desc: '9.55w', desc: '民国冒险故事' },
      0
    );
    expect(rich).toMatchObject({
      id: 'baidu_0',
      title: '九门',
      remarks: '9.55w热度',
      subtitle: '民国冒险故事',
      sourceLabel: '百度热播',
    });
  });

  it('无海报条目丢弃', () => {
    expect(baiduTeleplayToItem({ title: '某剧', cover: null }, 0)).toBeUndefined();
  });
});

describe('doubanCollectionToItem & biliRankToItem & tmdbTrendingToItem', () => {
  it('解析豆瓣 subject_collection 实时条目（含年份、地区、题材、演职员，不取单条网友差评）', () => {
    const item = doubanCollectionToItem(
      {
        id: '37191789',
        title: '嫁金钗',
        year: '2026',
        card_subtitle: '2026 / 中国大陆 / 剧情 爱情 古装 / 杨龙 / 田曦薇 闫桉',
        episodes_info: '更新至12集',
        pic: { large: 'https://img3.doubanio.com/view/photo/m_ratio_poster/public/p1.jpg' },
        rating: { value: 8.3 },
        comments: [{ comment: '女主为了演出恶女，用力很过猛了-- Mn' }],
      },
      true,
      '豆瓣实时剧集'
    );
    expect(item).toMatchObject({
      id: '37191789',
      title: '嫁金钗',
      year: '2026',
      area: '中国大陆',
      genres: '剧情 爱情 古装',
      remarks: '更新至12集',
      status: 'airing',
      rating: '8.3',
      subtitle: '杨龙 · 田曦薇 闫桉',
      sourceLabel: '豆瓣实时剧集',
    });
  });

  it('解析 B站 PGC 热播榜条目（自动 https 升级、横版大图 backdrop、播放与追番）', () => {
    const item = biliRankToItem(
      {
        season_id: 46585,
        title: '灵笼 第二季',
        cover: 'http://i0.hdslb.com/bfs/bangumi/v.png',
        ss_horizontal_cover: 'http://i0.hdslb.com/bfs/bangumi/h.png',
        rating: '9.8分',
        new_ep: { index_show: '全12话' },
        icon_font: { text: '4亿' },
        stat: { follow: 10900000 },
      },
      { isTv: true, label: 'B站国创热播', area: '中国大陆', genres: '动画 国创' }
    );
    expect(item).toMatchObject({
      id: 'bili_46585',
      title: '灵笼 第二季',
      cover: 'https://i0.hdslb.com/bfs/bangumi/v.png',
      backdrop: 'https://i0.hdslb.com/bfs/bangumi/h.png',
      rating: '9.8',
      remarks: '全12话',
      status: 'ended',
      subtitle: '4亿播放 · 1090万追番',
      sourceLabel: 'B站国创热播',
    });
  });

  it('curateRealtimeList：剔除柯南/小新/银魂等常青老番与中配版，同系列多季折叠并推举最新季', () => {
    const raw = [
      { id: '1', title: '名侦探柯南', cover: 'c', remarks: '更新至第1276话', status: 'airing' as const },
      { id: '2', title: '蜡笔小新 第二季（中文）', cover: 'c', remarks: '全873话', status: 'ended' as const },
      { id: '3', title: '银魂', cover: 'c', remarks: '全200话', status: 'ended' as const },
      { id: '4', title: '黑色四叶草', cover: 'c', remarks: '全171话', status: 'ended' as const },
      { id: '5', title: '咒术回战', cover: 'c', remarks: '全24话', status: 'ended' as const },
      { id: '6', title: '致不灭的你 第三季', cover: 'c', remarks: '更新至第8话', status: 'airing' as const },
      { id: '7', title: '咒术回战 第二季', cover: 'c', remarks: '全23话', status: 'ended' as const },
      { id: '8', title: '咒术回战 第三季', cover: 'c', remarks: '更新至第3话', status: 'airing' as const },
      { id: '9', title: '明日方舟：焰烬曙明', cover: 'c', remarks: '全10话', status: 'ended' as const },
      { id: '10', title: '明日方舟：焰烬曙明 中配版', cover: 'c', remarks: '全10话', status: 'ended' as const },
    ];
    const curated = curateRealtimeList(raw, { filterEvergreen: true, maxEpisodes: 100 });
    expect(curated.map((x) => x.title)).toEqual([
      '咒术回战 第三季',
      '致不灭的你 第三季',
      '明日方舟：焰烬曙明',
    ]);
  });

  it('解析 TMDB 趋势条目并支持多榜交叉去重', () => {
    const tmdb = tmdbTrendingToItem({
      id: 999,
      name: 'The Last of Us',
      media_type: 'tv',
      poster_path: '/p.jpg',
      backdrop_path: '/b.jpg',
      vote_average: 8.76,
      first_air_date: '2025-04-13',
      overview: '末日生存故事',
    });
    expect(tmdb).toMatchObject({
      id: 'tmdb_999',
      title: 'The Last of Us',
      backdrop: 'https://image.tmdb.org/t/p/w1280/b.jpg',
      rating: '8.8',
      year: '2025',
      isTv: true,
    });

    const merged = interleaveAndDedupeLists([
      [{ id: '1', title: '海贼王', cover: 'c1' }, { id: '2', title: '灵笼 第二季', cover: 'c2' }],
      [{ id: '3', title: '航海王', cover: 'c3' }, { id: '4', title: '灵笼 第一季', cover: 'c4' }],
    ]);
    // 海贼王与航海王、灵笼第一季与第二季均按系列主名视为同一部，不重复出现
    expect(merged.map((m) => m.title)).toEqual(['海贼王', '灵笼 第二季']);
  });

  it('fuseMultiSourceRankings：多源 RRF + 跨平台共识加权，把多平台共现作品排到榜首并合成最佳元数据', async () => {
    const { fuseMultiSourceRankings } = await import('./douban-weekly');
    const { fuseCatalogItems } = await import('./douban');

    const ranked = fuseMultiSourceRankings([
      {
        name: 'Bangumi',
        weight: 1.1,
        items: [
          { id: 'b1', title: '独门冷番A', cover: 'c1', rating: '7.8', status: 'airing' },
          { id: 'b2', title: '咒术回战', cover: 'c2', rating: '8.6', status: 'ended' },
        ],
      },
      {
        name: 'B站番剧',
        weight: 1.1,
        items: [
          { id: 'bl1', title: '独门冷番B', cover: 'c3', rating: '7.5', status: 'airing' },
          {
            id: 'bl2',
            title: '咒术回战 第三季',
            cover: 'c4',
            backdrop: 'https://img/jjk-wide.jpg',
            remarks: '更新至第3话',
            status: 'airing',
          },
        ],
      },
      {
        name: '豆瓣新番',
        weight: 1.0,
        items: [
          { id: 'd1', title: '咒术回战 第三季', cover: 'c5', year: '2026', area: '日本', status: 'airing' },
        ],
      },
    ]);

    // 《咒术回战》虽然在前两个榜都是第 2 名，但因 3 源共现，综合得分远超单平台第 1 名，跃居总榜第 1
    expect(ranked[0].title).toBe('咒术回战 第三季');
    expect(ranked[0].backdrop).toBe('https://img/jjk-wide.jpg');
    expect(ranked[0].rating).toBe('8.6');
    expect(ranked[0].year).toBe('2026');
    expect(ranked[0].sourceLabel).toContain('3源共推');

    // 片库融合测试：B站片库的 ended 权威状态自动修正豆瓣滞后的 airing 状态
    const catalog = fuseCatalogItems(
      [
        [{ id: 'db_1', title: '迷宫饭', cover: 'c1', rating: '9.1', remarks: '更新至14集', status: 'airing' }],
        [{ id: 'bili_1', title: '迷宫饭', cover: 'c2', remarks: '全24话', status: 'ended' }],
      ],
      10
    );
    expect(catalog).toHaveLength(1);
    expect(catalog[0].status).toBe('ended');
    expect(catalog[0].remarks).toBe('全24话');
    expect(catalog[0].rating).toBe('9.1');
  });
});


describe('TOP 10 排名：按平台分组的 RRF', () => {
  const item = (title: string, extra: Partial<import('./types').DoubanItem> = {}) => ({ id: title, title, cover: 'c', ...extra });

  it('同一平台的多个榜只算一票，跨平台共现才算共识', async () => {
    const { fuseMultiSourceRankings } = await import('./douban-weekly');
    const ranked = fuseMultiSourceRankings([
      { name: '豆瓣热剧', items: [item('甲'), item('豆瓣三连')] },
      { name: '华语口碑', items: [item('乙'), item('豆瓣三连')] },
      { name: '全球口碑', items: [item('丙'), item('豆瓣三连')] },
      { name: '百度热播', items: [item('跨平台')] },
      { name: 'B站剧集', items: [item('跨平台')] },
    ]);
    const labelOf = (t: string) => ranked.find((r) => r.title === t)?.sourceLabel;
    expect(labelOf('豆瓣三连')).not.toContain('共推');
    expect(labelOf('跨平台')).toContain('2源共推');
    expect(ranked[0].title).toBe('跨平台');
  });

  it('评分会影响名次，但不会压过明显的热度差', async () => {
    const { fuseMultiSourceRankings } = await import('./douban-weekly');
    const close = fuseMultiSourceRankings([
      { name: '豆瓣实时影', items: [item('低分', { rating: '5.6' }), item('高分', { rating: '8.8' })] },
    ]);
    expect(close.map((r) => r.title)).toEqual(['高分', '低分']);
    const far = fuseMultiSourceRankings([
      { name: '豆瓣实时影', items: [item('低分', { rating: '5.6' }), ...Array.from({ length: 30 }, (_, i) => item(`填充${i}`)), item('高分', { rating: '8.8' })] },
    ]);
    const pos = (t: string) => far.findIndex((r) => r.title === t);
    expect(pos('低分')).toBeLessThan(pos('高分'));
  });

  it('多样性配额：前 10 名同一大类最多 4 部', async () => {
    const { diversifyRanking, rankCategory } = await import('./douban-weekly');
    const movies = Array.from({ length: 8 }, (_, i) => item(`电影${i}`, { isTv: false }));
    const shows = Array.from({ length: 8 }, (_, i) => item(`剧${i}`, { isTv: true }));
    const anime = Array.from({ length: 8 }, (_, i) => item(`番${i}`, { isTv: true, genres: '动画 番剧', area: '日本' }));
    const out = diversifyRanking([...movies, ...shows, ...anime]);
    expect(out.slice(0, 10).filter((r) => rankCategory(r) === 'movie')).toHaveLength(4);
    expect(out.slice(0, 10).filter((r) => rankCategory(r) === 'anime')).toHaveLength(2);
    expect(out).toHaveLength(24);
    expect(rankCategory(item('国漫', { genres: '动画 国创', area: '中国大陆' }))).toBe('guoman');
  });

  it('榜单名能归到平台', async () => {
    const { platformOf } = await import('./douban-weekly');
    expect(platformOf('豆瓣实时影')).toBe('douban');
    expect(platformOf('一周口碑影')).toBe('douban');
    expect(platformOf('B站国创')).toBe('bilibili');
    expect(platformOf('TMDB趋势')).toBe('tmdb');
    expect(platformOf('Bangumi')).toBe('bangumi');
  });
});

describe('TOP 10 上升势头', () => {
  const item = (title: string) => ({ id: title, title, cover: 'c' });

  it('名次往前冲的加分、新上榜标记、系数封顶', async () => {
    const { fuseMultiSourceRankings, momentumFactor } = await import('./douban-weekly');
    expect(momentumFactor(30)).toBeCloseTo(1.06);
    expect(momentumFactor(-30)).toBeCloseTo(0.94);
    const titles = ['甲', '乙', '丙', '丁'];
    const without = fuseMultiSourceRankings([{ name: '豆瓣实时影', items: titles.map(item) }]);
    expect(without.map((r) => r.title)).toEqual(titles);
    expect(without.some((r) => r.rankNew || r.rankDelta)).toBe(false);

    // 基准里「丁」原本第 30 名，现在第 4 → 大幅上升；「乙」不在基准里 → 新上榜
    const ranked = fuseMultiSourceRankings([{ name: '豆瓣实时影', items: titles.map(item) }], {
      baseline: { 甲: 0, 丙: 1, 丁: 30 },
    });
    const by = (t: string) => ranked.find((r) => r.title === t)!;
    expect(by('乙').rankNew).toBe(true);
    expect(ranked.indexOf(by('丁'))).toBeLessThan(3);
    expect(by('丁').rankDelta).toBeGreaterThan(20);
  });

  it('基准快照：优先 3~24 小时前最早的一次，没有就用 1 小时前的', async () => {
    const { pickBaseline } = await import('./rank-history');
    const now = 100 * 3600_000;
    const at = (h: number) => ({ at: now - h * 3600_000, ranks: { [`h${h}`]: 0 } });
    expect(pickBaseline([at(30), at(20), at(5), at(0.5)], now)?.at).toBe(now - 20 * 3600_000);
    expect(pickBaseline([at(2), at(0.5)], now)?.at).toBe(now - 2 * 3600_000);
    expect(pickBaseline([at(0.5)], now)).toBeUndefined();
  });
});

describe('片库融合：状态有依据的优先', () => {
  it('豆瓣按年份猜的「完结」不覆盖 B站明确的「连载」；都有依据时完结优先', async () => {
    const { fuseCatalogItems } = await import('./douban');
    const [a] = fuseCatalogItems(
      [
        [{ id: 'db', title: '某新番', cover: 'c', status: 'ended', statusGuessed: true }],
        [{ id: 'bili', title: '某新番', cover: 'c', status: 'airing', remarks: '更新至第3话' }],
      ],
      10,
    );
    expect(a.status).toBe('airing');
    const [b] = fuseCatalogItems(
      [
        [{ id: 'db', title: '迷宫饭', cover: 'c', status: 'airing', remarks: '更新至14集' }],
        [{ id: 'bili', title: '迷宫饭', cover: 'c', status: 'ended', remarks: '全24话' }],
      ],
      10,
    );
    expect(b.status).toBe('ended');
  });
});

describe('综艺不按集数上限剔除', () => {
  it('「更新至20251016期」在综艺榜里保留', async () => {
    const { fuseMultiSourceRankings } = await import('./douban-weekly');
    const items = [{ id: 'v', title: '某综艺', cover: 'c', remarks: '更新至20251016期' }];
    expect(fuseMultiSourceRankings([{ name: '热门综艺', items }])).toHaveLength(0);
    expect(fuseMultiSourceRankings([{ name: '热门综艺', items }], { maxEpisodes: Number.MAX_SAFE_INTEGER })).toHaveLength(1);
  });
});
