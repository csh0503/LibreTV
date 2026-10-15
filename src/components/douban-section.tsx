'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/client-api';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import type { DoubanItem } from '@/lib/types';
import { DoubanCard } from './video-card';

// —— 分类与筛选项常量 ——
export type ChannelType = 'anime' | 'movie' | 'tv' | 'show' | 'doc';

const CHANNELS: { id: ChannelType; label: string; icon: string }[] = [
  { id: 'anime', label: '动漫新番', icon: '🌸' },
  { id: 'movie', label: '电影', icon: '🍿' },
  { id: 'tv', label: '电视剧集', icon: '📺' },
  { id: 'show', label: '综艺娱乐', icon: '🎪' },
  { id: 'doc', label: '纪录片', icon: '🌍' },
];

const ANIME_GENRES = ['全部', '热血', '奇幻', '恋爱', '日常', '搞笑', '科幻', '治愈', '机战', '悬疑', '冒险', '异世界', '战斗', '百合'];
const MOVIE_GENRES = ['全部', '热门', '科幻', '喜剧', '动作', '悬疑', '爱情', '动画', '恐怖', '犯罪', '惊悚', '战争', '奇幻', '经典'];
const TV_GENRES = ['全部', '国产剧', '韩剧', '美剧', '日剧', '港剧', '英剧', '悬疑', '古装', '都市', '科幻', '短剧'];
const SHOW_GENRES = ['全部', '真人秀', '搞笑', '脱口秀', '音乐', '恋爱', '美食', '游戏'];
const DOC_GENRES = ['全部', '自然', '历史', '科技', '美食', '人文', '宇宙', '人物'];

const YEARS = ['全部', '2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2015-2018', '2010-2014', '2000年代', '更早'];
const STATUSES = ['全部', '完结', '连载中'];
const SORTS = [
  { id: 'hot', label: '🔥 热门推荐' },
  { id: 'rate', label: '⭐ 高分榜' },
  { id: 'new', label: '🕒 最新上线' },
];
const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

export function RecommendSection({ onPick }: { onPick: (title: string) => void }) {
  const doubanEnabled = useAppStore((s) => s.doubanEnabled);
  const yellowFilter = useAppStore((s) => s.yellowFilter);

  // 一级频道
  const [channel, setChannel] = useState<ChannelType>('anime');
  // 题材标签
  const [genre, setGenre] = useState('全部');
  // 年份
  const [year, setYear] = useState('全部');
  // 连载状态
  const [status, setStatus] = useState('全部');
  // 排序
  const [sort, setSort] = useState('hot');
  // 动漫专属：星期放送筛选（仅当选择动漫且年份为全部时激活）
  const [weekday, setWeekday] = useState<number | 'all'>('all');

  // 获取当前频道的题材列表
  const genreList = useMemo(() => {
    switch (channel) {
      case 'anime': return ANIME_GENRES;
      case 'movie': return MOVIE_GENRES;
      case 'tv': return TV_GENRES;
      case 'show': return SHOW_GENRES;
      case 'doc': return DOC_GENRES;
    }
  }, [channel]);

  // 1. 数据获取：豆瓣影视库
  const doubanTag = useMemo(() => {
    if (channel === 'anime') {
      return genre === '全部' ? '日本动画' : genre;
    }
    if (channel === 'show') return '综艺';
    if (channel === 'doc') return '纪录片';
    if (genre !== '全部') return genre;
    if (sort === 'rate') return '豆瓣高分';
    if (sort === 'new') return '最新';
    return '热门';
  }, [channel, genre, sort]);

  const doubanType = channel === 'movie' ? 'movie' : 'tv';

  const doubanQuery = useQuery({
    queryKey: ['douban', doubanType, doubanTag],
    queryFn: ({ signal }) => api.douban(doubanType, doubanTag, 0, 50, signal),
    enabled: doubanEnabled,
  });

  // 2. 数据获取：Bangumi 每日放送（用于动漫新番与周历）
  const bangumiQuery = useQuery({
    queryKey: ['bangumi-calendar'],
    queryFn: ({ signal }) => api.bangumiCalendar(signal),
    enabled: doubanEnabled && channel === 'anime',
  });

  // 综合条目生成与多维过滤
  const items = useMemo(() => {
    let list: DoubanItem[] = [];

    // 如果是动漫频道，并且选择当周放送/未选特定年份
    if (channel === 'anime' && (year === '全部' || year === '2025' || year === '2026') && bangumiQuery.data) {
      const bgmItems = weekday === 'all'
        ? bangumiQuery.data.days.flatMap((d) => d.items)
        : (bangumiQuery.data.days.find((d) => d.weekday === weekday)?.items ?? []);
      
      const doubanItems = doubanQuery.data?.items ?? [];
      // 合并两方数据并按名称去重
      const map = new Map<string, DoubanItem>();
      for (const item of bgmItems) map.set(item.title.trim(), item);
      for (const item of doubanItems) {
        if (!map.has(item.title.trim())) map.set(item.title.trim(), item);
      }
      list = Array.from(map.values());
    } else {
      list = doubanQuery.data?.items ?? [];
    }

    // 状态过滤（完结 / 连载中）：通过名称或已有信息识别，连载新番与电影
    if (status !== '全部') {
      if (status === '完结') {
        list = list.filter((i) => !i.title.includes('更新') && !i.title.includes('连载'));
      } else if (status === '连载中') {
        list = list.filter((i) => i.isTv);
      }
    }

    // 高分排序
    if (sort === 'rate') {
      list = [...list].sort((a, b) => {
        const ra = parseFloat(a.rating || '0');
        const rb = parseFloat(b.rating || '0');
        return rb - ra;
      });
    }

    // 成人过滤：若开启了 yellowFilter，排除敏感关键词
    if (yellowFilter) {
      const sensitiveWords = ['伦理', '福利', '无码', '有码', '里番', '18禁', '三级'];
      list = list.filter((i) => !sensitiveWords.some((w) => i.title.includes(w)));
    }

    return list;
  }, [channel, year, status, sort, weekday, bangumiQuery.data, doubanQuery.data, yellowFilter]);

  if (!doubanEnabled) return null;

  return (
    <section aria-label="影视与动漫大厅" className="space-y-3.5">
      {/* 1. 一级频道导航（大分类） */}
      <div className="flex items-center justify-between border-b border-line pb-2.5">
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          {CHANNELS.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                setChannel(c.id);
                setGenre('全部');
                setWeekday('all');
              }}
              className={cn(
                'flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl text-xs sm:text-sm font-semibold transition-all',
                channel === c.id
                  ? 'bg-accent text-on-accent shadow-sm scale-105'
                  : 'bg-chip text-muted hover:text-content hover:bg-hover'
              )}
            >
              <span>{c.icon}</span>
              <span>{c.label}</span>
            </button>
          ))}
        </div>

        {/* 排序方式选择 */}
        <div className="hidden sm:flex items-center gap-1 bg-chip p-1 rounded-lg text-xs">
          {SORTS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSort(s.id)}
              className={cn(
                'px-2.5 py-1 rounded-md transition-colors',
                sort === s.id ? 'bg-accent text-on-accent font-medium' : 'text-muted hover:text-content'
              )}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* 2. 多维度筛选矩阵 */}
      <div className="bg-surface/60 border border-line rounded-2xl p-3 sm:p-4 space-y-2.5 text-xs">
        {/* A. 动漫专属：按周几放送 */}
        {channel === 'anime' && (
          <div className="flex items-start sm:items-center gap-2">
            <span className="text-muted shrink-0 w-12 font-medium pt-1 sm:pt-0">新番放送:</span>
            <div className="flex flex-wrap gap-1">
              <FilterChip active={weekday === 'all'} onClick={() => setWeekday('all')}>
                全部星期
              </FilterChip>
              {WEEKDAYS.map((w, idx) => (
                <FilterChip key={w} active={weekday === idx + 1} onClick={() => setWeekday(idx + 1)}>
                  {w}
                </FilterChip>
              ))}
            </div>
          </div>
        )}

        {/* B. 题材筛选 */}
        <div className="flex items-start sm:items-center gap-2">
          <span className="text-muted shrink-0 w-12 font-medium pt-1 sm:pt-0">题材类型:</span>
          <div className="flex flex-wrap gap-1">
            {genreList.map((g) => (
              <FilterChip key={g} active={genre === g} onClick={() => setGenre(g)}>
                {g}
              </FilterChip>
            ))}
          </div>
        </div>

        {/* C. 年份筛选 */}
        <div className="flex items-start sm:items-center gap-2">
          <span className="text-muted shrink-0 w-12 font-medium pt-1 sm:pt-0">发布年份:</span>
          <div className="flex flex-wrap gap-1">
            {YEARS.map((y) => (
              <FilterChip key={y} active={year === y} onClick={() => setYear(y)}>
                {y}
              </FilterChip>
            ))}
          </div>
        </div>

        {/* D. 连载状态 */}
        <div className="flex items-start sm:items-center gap-2">
          <span className="text-muted shrink-0 w-12 font-medium pt-1 sm:pt-0">更新状态:</span>
          <div className="flex flex-wrap gap-1">
            {STATUSES.map((st) => (
              <FilterChip key={st} active={status === st} onClick={() => setStatus(st)}>
                {st === '全部' ? '全部状态' : st === '完结' ? '✅ 已完结' : '⏳ 连载中'}
              </FilterChip>
            ))}
          </div>
        </div>
      </div>

      {/* 3. 卡片网格展示 */}
      {doubanQuery.isError ? (
        <p className="text-center text-sm text-faint py-12">推荐内容加载失败，请检查网络</p>
      ) : doubanQuery.isLoading ? (
        <GridSkeleton />
      ) : items.length === 0 ? (
        <div className="text-center py-12 space-y-2">
          <p className="text-sm text-muted">当前筛选条件下暂无片源</p>
          <button
            onClick={() => {
              setGenre('全部');
              setYear('全部');
              setStatus('全部');
              setWeekday('all');
            }}
            className="text-xs text-accent underline hover:opacity-80"
          >
            重置所有筛选条件
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5 sm:gap-3">
          {items.map((item) => (
            <div key={`${item.id}_${item.title}`} className="relative group">
              <DoubanCard item={item} onClick={() => onPick(item.title)} />
              {/* 完结/类型标签指示 */}
              {status === '完结' && (
                <span className="absolute bottom-9 left-1.5 px-1.5 py-0.5 rounded bg-emerald-600/90 text-[10px] text-white font-medium shadow-sm pointer-events-none">
                  完结
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        'px-2.5 py-0.5 rounded-full text-xs transition-colors shrink-0',
        active
          ? 'bg-accent text-on-accent font-medium shadow-sm'
          : 'bg-chip text-muted hover:text-content hover:bg-hover'
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function GridSkeleton() {
  return (
    <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2.5">
      {Array.from({ length: 16 }).map((_, i) => (
        <div key={i} className="animate-pulse">
          <div className="aspect-[2/3] rounded-lg bg-chip" />
          <div className="h-3.5 mt-2 rounded bg-chip w-3/4" />
        </div>
      ))}
    </div>
  );
}
