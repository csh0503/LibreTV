import { describe, expect, it } from 'vitest';
import type { DoubanItem } from './types';
import { buildDoubanRequest } from './recommend';
import {
  assembleTaste,
  describeWatch,
  idfTable,
  mergeSimilar,
  mmrPick,
  rankTaste,
  readTasteSnapshot,
  signalWeight,
  confidenceOf,
  unionTasteSnapshots,
  type TasteEvent,
  type TasteMeta,
  type TasteWatch,
} from './taste';

const NOW = Date.UTC(2026, 9, 16);

function movie(title: string, at = NOW): TasteWatch {
  return { title, playbackPosition: 90, duration: 100, episodeIndex: 0, totalEpisodes: 1, timestamp: at };
}

function meta(title: string, genres: string, extra: Partial<TasteMeta> = {}): TasteMeta {
  return { title, genres, channel: 'anime', area: '日本', year: '2020', ...extra };
}

function card(title: string, genres: string, rating = '8'): DoubanItem {
  return { id: title, title, cover: 'cover', genres, rating, area: '日本', year: '2020' };
}

function finished(title: string, genres: string[]): TasteEvent {
  return {
    title,
    channel: 'anime',
    genres,
    area: '日本',
    year: '2020',
    depth: 1,
    finished: true,
    abandoned: false,
    favorite: false,
    at: NOW,
  };
}

describe('观看深浅', () => {
  it('电影看完、开头离开、刚打开，权重不一样', () => {
    expect(describeWatch({ playbackPosition: 90, duration: 100, episodeIndex: 0, totalEpisodes: 1 })).toMatchObject({
      finished: true,
      abandoned: false,
    });
    const left = describeWatch({ playbackPosition: 10, duration: 100, episodeIndex: 0, totalEpisodes: 1 });
    expect(left.abandoned).toBe(true);
    expect(signalWeight({ ...left, favorite: false })).toBeLessThan(0);
    const opened = describeWatch({ playbackPosition: 0, duration: 0, episodeIndex: 0, totalEpisodes: 1 });
    expect(opened.abandoned).toBe(false);
    expect(signalWeight({ ...opened, favorite: false, finished: false })).toBeLessThan(0.5);
  });

  it('剧集看到第 3 集不算弃剧', () => {
    const onThird = describeWatch({ playbackPosition: 0, duration: 0, episodeIndex: 2, totalEpisodes: 12 });
    expect(onThird.abandoned).toBe(false);
    expect(onThird.depth).toBeGreaterThan(0.3);
  });

  it('收藏比看到一半更重，越近的越重', () => {
    const partial = { depth: 0.4, finished: false, abandoned: false, favorite: false };
    const saved = { depth: 0, finished: false, abandoned: false, favorite: true };
    expect(signalWeight(saved)).toBeGreaterThan(signalWeight(partial));
    const recent = finished('新', ['热血']);
    const old = { ...recent, at: NOW - 200 * 86_400_000 };
    expect(confidenceOf(recent, NOW)).toBeGreaterThan(confidenceOf(old, NOW));
  });
});

describe('召回', () => {
  it('两部热血动画会去豆瓣要动画和热血，地区跟得上', () => {
    const taste = assembleTaste({
      watches: [movie('甲'), movie('乙')],
      saves: [],
      metas: [meta('甲', '热血'), meta('乙', '热血')],
      now: NOW,
    });
    expect(taste).not.toBeNull();
    const request = buildDoubanRequest(taste!.jobs[0].selection);
    expect(request?.tags).toEqual(['动画', '热血', '日本']);
    // 主口味：近期热门一页 + 高分一页
    expect(request?.sort).toBe('U');
    expect(taste!.jobs.map((job) => buildDoubanRequest(job.selection)?.sort)).toEqual(['U', 'S']);
    expect(taste!.jobs.map((job) => job.pageStart)).toEqual([0, 0]);
    expect(taste!.jobs[0].forAnchor).toBe(true);
  });

  it('芯片上的机战仍交给豆瓣的机甲标签', () => {
    const taste = assembleTaste({
      watches: [movie('甲'), movie('乙')],
      saves: [],
      metas: [meta('甲', '机战'), meta('乙', '机战')],
      now: NOW,
    });
    const tags = buildDoubanRequest(taste!.jobs[0].selection)?.tags ?? [];
    expect(tags).toContain('机甲');
    expect(tags).not.toContain('机战');
  });

  it('副标题的动作和奇幻不会被当成热血', () => {
    const taste = assembleTaste({
      watches: [movie('甲'), movie('乙')],
      saves: [],
      metas: [meta('甲', '动作 奇幻', { channel: undefined, area: '美国' }), meta('乙', '动作 奇幻', { channel: undefined, area: '美国' })],
      now: NOW,
    });
    const tags = taste!.jobs.flatMap((job) => buildDoubanRequest(job.selection)?.tags ?? []);
    expect(tags).toContain('动作');
    expect(tags).not.toContain('热血');
    expect(taste!.jobs.every((job) => job.selection.channel === 'movie')).toBe(true);
  });

  it('只有一部片子，或只是点开过，先不推荐', () => {
    expect(assembleTaste({
      watches: [movie('甲')],
      saves: [],
      metas: [meta('甲', '热血')],
      now: NOW,
    })).toBeNull();
    expect(assembleTaste({
      watches: [
        { title: '甲', playbackPosition: 0, duration: 0, episodeIndex: 0, totalEpisodes: 1, timestamp: NOW },
        { title: '乙', playbackPosition: 0, duration: 0, episodeIndex: 0, totalEpisodes: 1, timestamp: NOW },
      ],
      saves: [],
      metas: [meta('甲', '热血'), meta('乙', '热血')],
      now: NOW,
    })).toBeNull();
  });

  it('地区只在多数片子都有时才收窄', () => {
    const taste = assembleTaste({
      watches: [movie('甲'), movie('乙'), movie('丙'), movie('丁')],
      saves: [],
      metas: [
        meta('甲', '热血'),
        meta('乙', '热血', { area: undefined }),
        meta('丙', '热血', { area: undefined }),
        meta('丁', '热血', { area: undefined }),
      ],
      now: NOW,
    });
    expect(buildDoubanRequest(taste!.jobs[0].selection)?.tags).not.toContain('日本');
  });
});

describe('排序', () => {
  const watches = [movie('看过一'), movie('看过二')];
  const metas = [meta('看过一', '热血'), meta('看过二', '热血')];

  it('弃掉的题材不再推荐，看过的片子和别名也不再推荐', () => {
    const taste = assembleTaste({
      watches: [...watches, { title: '海贼王', playbackPosition: 90, duration: 100, episodeIndex: 0, totalEpisodes: 1, timestamp: NOW }, {
        title: '吓到了',
        playbackPosition: 5,
        duration: 100,
        episodeIndex: 0,
        totalEpisodes: 1,
        timestamp: NOW,
      }],
      saves: [],
      metas: [...metas, meta('海贼王', '热血'), meta('吓到了', '恐怖', { channel: 'movie', area: '美国' })],
      now: NOW,
    });
    const ranked = rankTaste({
      events: taste!.events,
      userPool: [card('航海王', '热血'), card('新热血', '热血', '9'), card('别看', '恐怖', '9')],
      anchorPool: [card('新热血', '热血', '9'), card('另一部', '热血', '8')],
      anchorTitle: taste!.anchorTitle,
      blocked: taste!.blocked,
      now: NOW,
      hideAdult: true,
    });
    const titles = ranked.forYou.map((item) => item.title);
    expect(titles).toContain('新热血');
    expect(titles).not.toContain('航海王');
    expect(titles).not.toContain('别看');
    expect(titles).not.toContain('海贼王');
  });

  it('看过第二季不再推同一季的另一个译名，第三季仍可以推', () => {
    const taste = assembleTaste({
      watches: [...watches, { title: '海贼王 第二季', playbackPosition: 90, duration: 100, episodeIndex: 0, totalEpisodes: 12, timestamp: NOW }],
      saves: [],
      metas: [...metas, meta('海贼王 第二季', '热血')],
      now: NOW,
    });
    const ranked = rankTaste({
      events: taste!.events,
      userPool: [card('航海王 第二季', '热血', '9'), card('航海王 第三季', '热血', '8'), card('新热血', '热血', '9')],
      anchorPool: [],
      anchorTitle: null,
      blocked: taste!.blocked,
      now: NOW,
      hideAdult: true,
    });
    const titles = ranked.forYou.map((item) => item.title);
    expect(titles).not.toContain('航海王 第二季');
    expect(titles).toContain('航海王 第三季');
  });

  it('同样的口味，评分高的在前面', () => {
    const taste = assembleTaste({ watches, saves: [], metas, now: NOW });
    const ranked = rankTaste({
      events: taste!.events,
      userPool: [card('低分', '热血', '6'), card('高分', '热血', '9')],
      anchorPool: [],
      anchorTitle: null,
      blocked: taste!.blocked,
      now: NOW,
      hideAdult: true,
    });
    expect(ranked.forYou.map((item) => item.title)).toEqual(['高分', '低分']);
  });

  it('成人片名在过滤开着时不出现', () => {
    const taste = assembleTaste({ watches, saves: [], metas, now: NOW });
    const ranked = rankTaste({
      events: taste!.events,
      userPool: [card('伦理片特辑', '热血', '9'), card('普通', '热血', '8')],
      anchorPool: [],
      anchorTitle: null,
      blocked: taste!.blocked,
      now: NOW,
      hideAdult: true,
    });
    expect(ranked.forYou.map((item) => item.title)).toEqual(['普通']);
  });

  it('MMR 不会把几乎一样的片子排满前两名', () => {
    const axis = (token: string) => new Map([[token, 1]]);
    const picked = mmrPick([
      { score: 0.9, vec: axis('hot'), value: '热1' },
      { score: 0.88, vec: axis('hot'), value: '热2' },
      { score: 0.8, vec: axis('soft'), value: '愈1' },
    ], 3);
    expect(picked.slice(0, 2)).toEqual(['热1', '愈1']);
  });

  it('少见的题材比到处都有的题材权重大', () => {
    const table = idfTable([['g:剧情'], ['g:剧情'], ['g:剧情'], ['g:剧情'], ['g:机甲']]);
    expect(table.get('g:机甲') ?? 0).toBeGreaterThan(table.get('g:剧情') ?? 0);
  });
});

describe('题材档案合并', () => {
  it('较新的一条补上题材时，旧的题材还留着', () => {
    const merged = unionTasteSnapshots(
      [{ title: '甲', updatedAt: 1, genres: '热血', area: '日本' }],
      [{ title: '甲', updatedAt: 2, genres: '奇幻' }],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0].genres?.split(' ')).toEqual(expect.arrayContaining(['热血', '奇幻']));
    expect(merged[0].area).toBe('日本');
    expect(merged[0].updatedAt).toBe(2);
  });

  it('不合规的档案丢掉', () => {
    expect(readTasteSnapshot({ title: '甲' })).toBeNull();
    expect(readTasteSnapshot(null)).toBeNull();
    expect(readTasteSnapshot({ title: '甲', updatedAt: 3, genres: '热血', channel: 'anime' })?.genres).toBe('热血');
  });
});

describe('看过的人也喜欢', () => {
  const seriesKeyOf = (item: DoubanItem) => item.title.replace(/第.季$/, '').trim();

  it('被几部同时推荐的排前面，看过的不推', () => {
    const merged = mergeSimilar(
      [
        { weight: 1, items: [card('甲', ''), card('乙', ''), card('看过', '')] },
        { weight: 1, items: [card('丙', ''), card('乙', '')] },
      ],
      { blocked: new Set(['看过']), seriesKeyOf, hideAdult: true, limit: 10 },
    );
    expect(merged.map((item) => item.title)[0]).toBe('乙');
    expect(merged.map((item) => item.title)).not.toContain('看过');
  });

  it('看了第二季，没看过的第三季照推，但同系列只留一部', () => {
    const merged = mergeSimilar(
      [{ weight: 1, items: [card('咒术回战 第三季', ''), card('咒术回战 第一季', ''), card('鬼灭之刃', '')] }],
      { blocked: new Set(['咒术回战第二季']), seriesKeyOf, hideAdult: true, limit: 10 },
    );
    expect(merged.map((item) => item.title)).toEqual(['咒术回战 第三季', '鬼灭之刃']);
  });
});
