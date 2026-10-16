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
      remarks: '🔥 9.55w热度',
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
});
