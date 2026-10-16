import { describe, expect, it } from 'vitest';
import {
  buildSingleAnchorFallback,
  decideEpisodeEndAction,
  describeContinueWatching,
  extractTasteFromVideoInfo,
  hasNewEpisodes,
  NEXT_EPISODE_COUNTDOWN_SECONDS,
  STILL_WATCHING_THRESHOLD,
} from './home-features';

describe('继续观看与追更提醒 (describeContinueWatching / hasNewEpisodes)', () => {
  it('能正确计算播放进度百分比、时间文案以及续播秒数', () => {
    const view = describeContinueWatching({
      episodeIndex: 2,
      totalEpisodes: 12,
      playbackPosition: 620,
      duration: 1200,
    });
    expect(view.showProgress).toBe(true);
    expect(view.percent).toBe(52);
    expect(view.posterLabel).toBe('第 3 集 · 10:20');
    expect(view.subLabel).toBe('看到第 3/12 集');
    expect(view.targetEpisodeIndex).toBe(2);
    expect(view.targetPosition).toBe(620);
    expect(view.hasUpdate).toBe(false);
  });

  it('连载剧集数变多时标记「更新了」，且此前已看完最新集时点击直接跳到新出的一集', () => {
    expect(hasNewEpisodes(12, 14)).toBe(true);
    expect(hasNewEpisodes(12, 12)).toBe(false);
    expect(hasNewEpisodes(0, 12)).toBe(false);

    // 此前已经把第 12/12 集看到片尾（>=92%），现在更到了 14 集 -> 点击直接进第 13 集（index 12）
    const caughtUp = describeContinueWatching(
      {
        episodeIndex: 11,
        totalEpisodes: 12,
        playbackPosition: 1400,
        duration: 1440,
      },
      14,
    );
    expect(caughtUp.hasUpdate).toBe(true);
    expect(caughtUp.updateBadge).toBe('更新了');
    expect(caughtUp.targetEpisodeIndex).toBe(12);
    expect(caughtUp.targetPosition).toBe(0);
    expect(caughtUp.subLabel).toContain('更至 14 集');

    // 此前还在看第 5/12 集半截，现在更到了 14 集 -> 标「更新了」，点击仍接着第 5 集半截播
    const midSeries = describeContinueWatching(
      {
        episodeIndex: 4,
        totalEpisodes: 12,
        playbackPosition: 300,
        duration: 1200,
      },
      14,
    );
    expect(midSeries.hasUpdate).toBe(true);
    expect(midSeries.updateBadge).toBe('更新了');
    expect(midSeries.targetEpisodeIndex).toBe(4);
    expect(midSeries.targetPosition).toBe(300);
  });
});

describe('播完时的下一集倒计时大卡与「还在看吗？」 (decideEpisodeEndAction)', () => {
  it('最后一集或单集电影播完时不弹下一集卡', () => {
    expect(
      decideEpisodeEndAction({
        currentIndex: 0,
        totalEpisodes: 1,
        autoplayNext: true,
        consecutiveAutoPlays: 0,
      }),
    ).toEqual({ mode: 'none' });
    expect(
      decideEpisodeEndAction({
        currentIndex: 11,
        totalEpisodes: 12,
        autoplayNext: true,
        consecutiveAutoPlays: 1,
      }),
    ).toEqual({ mode: 'none' });
  });

  it('开启自动连播且未达连续集数上限时返回倒计时大卡', () => {
    expect(
      decideEpisodeEndAction({
        currentIndex: 2,
        totalEpisodes: 12,
        autoplayNext: true,
        consecutiveAutoPlays: STILL_WATCHING_THRESHOLD - 1,
      }),
    ).toEqual({
      mode: 'countdown',
      nextIndex: 3,
      seconds: NEXT_EPISODE_COUNTDOWN_SECONDS,
    });
  });

  it('连续自动连播达到上限时弹出「还在看吗？」暂停自动切集', () => {
    expect(
      decideEpisodeEndAction({
        currentIndex: 3,
        totalEpisodes: 12,
        autoplayNext: true,
        consecutiveAutoPlays: STILL_WATCHING_THRESHOLD,
      }),
    ).toEqual({
      mode: 'still-watching',
      nextIndex: 4,
      streak: STILL_WATCHING_THRESHOLD,
    });
  });

  it('关闭自动连播时仍展示下一集大卡但不自动倒计时', () => {
    expect(
      decideEpisodeEndAction({
        currentIndex: 0,
        totalEpisodes: 12,
        autoplayNext: false,
        consecutiveAutoPlays: 0,
      }),
    ).toEqual({
      mode: 'manual-next',
      nextIndex: 1,
    });
  });
});

describe('点播详情口味提取与单部「因为你看过」兜底', () => {
  it('能从采集站分类和地区提取出频道与题材', () => {
    expect(
      extractTasteFromVideoInfo({
        typeName: '日韩动漫',
        area: '日本',
        year: '2025',
      }),
    ).toEqual({
      channel: 'anime',
      genres: undefined,
      area: '日本',
      year: '2025',
    });

    expect(
      extractTasteFromVideoInfo({
        typeName: '动作片',
        area: '美国',
        year: '2024',
      }),
    ).toEqual({
      channel: 'movie',
      genres: '动作',
      area: '美国',
      year: '2024',
    });
  });

  it('只看过 1 部有题材的片子时也能生成「因为你看过《某某》」召回条件', () => {
    const fallback = buildSingleAnchorFallback({
      now: Date.now(),
      watches: [
        {
          title: '葬送的芙莉莲',
          playbackPosition: 600,
          duration: 1400,
          episodeIndex: 2,
          totalEpisodes: 28,
          timestamp: Date.now(),
          genres: '奇幻 冒险',
          area: '日本',
          channel: 'anime',
        },
      ],
      saves: [],
      metas: [],
    });
    expect(fallback).not.toBeNull();
    expect(fallback?.anchorTitle).toBe('葬送的芙莉莲');
    expect(fallback?.anchorReason).toBe('看过');
    expect(fallback?.selection.channel).toBe('anime');
    expect(fallback?.selection.genre).toBe('奇幻');
    expect(fallback?.selection.area).toBe('日本');
  });
});
