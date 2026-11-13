'use client';

import { useEffect, useState } from 'react';
import { useAppStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { SmartImage } from './smart-image';
import {
  aggregateResults,
  buildGroupTitleKey,
  normalizeYearToken,
  type AggregatedGroup,
} from '@/lib/title-aliases';
import { FavoriteButton } from './favorite-button';
import type { FavoriteDraft } from '@/lib/db';
import { markNotInterested, unmarkNotInterested } from '@/lib/not-interested';
import { useProfile } from '@/lib/use-profile';
import { useToast } from './toast';

export { aggregateResults, buildGroupTitleKey, normalizeYearToken, type AggregatedGroup };

/**
 * 卡片尺寸（全站一套）：手机约 112~128px、平板约 150px、桌面 175~200px。
 * 横向货架用 SHELF_CARD_W 定宽，网格用 POSTER_GRID 按宽度自动排列。
 */
export const SHELF_CARD_W = 'w-[7.25rem] sm:w-[9.25rem] lg:w-[10.75rem] xl:w-[11.25rem] 2xl:w-[12.5rem]';
export const POSTER_GRID =
  'grid gap-x-3 gap-y-5 grid-cols-[repeat(auto-fill,minmax(6.25rem,1fr))] sm:grid-cols-[repeat(auto-fill,minmax(8.75rem,1fr))] lg:grid-cols-[repeat(auto-fill,minmax(10.25rem,1fr))] 2xl:grid-cols-[repeat(auto-fill,minmax(11.5rem,1fr))]';

export interface PosterCardItem {
  title: string;
  cover: string;
  rating?: string;
  /** 年份 · 地区（或搜索结果的「N 个源」） */
  meta?: string;
  badge?: { text: string; tone: 'ok' | 'warn' };
  favorite?: FavoriteDraft;
  /** 悬停浮层里显示：题材、更新说明、一句话简介 */
  genres?: string;
  remarks?: string;
  subtitle?: string;
  /** 本地片库查到的：几个点播源收录了（>0 显示「有片源」） */
  available?: number;
}

/**
 * 海报卡片（首页货架、片库、搜索结果、为你推荐共用）：
 * - 海报 + 评分 + 连载 / 完结角标，片名两行，下面年份 · 地区；
 * - 桌面悬停（或键盘聚焦）浮出操作层：类型、集数、一句话简介，和「播放 / 加入片单 / 更多信息 / 不感兴趣」；
 * - 触屏点卡片就是「更多信息」（作品详情弹窗，里面有播放 / 选集 / 片单）。
 * onPlay：一键播放（有续播记录直接续播，没有就自动挑最好的源开播）；不给就不显示播放键。
 */
export function DoubanCard({
  item,
  onClick,
  onFavorite,
  onPlay,
  notInterestable,
}: {
  item: PosterCardItem;
  onClick: () => void;
  onFavorite?: () => void;
  onPlay?: () => void;
  /** 显示「不感兴趣」（标了以后首页货架、推荐都不再出现，可撤销） */
  notInterestable?: boolean;
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  const profileId = useProfile().id;
  const { toast } = useToast();
  useEffect(() => setImgFailed(false), [item.cover]);

  const hidden = (e: React.SyntheticEvent) => e.stopPropagation();
  const notInterested = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!profileId) return;
    markNotInterested(profileId, [item.title]);
    toast(`不再推荐《${item.title}》`, 'success', {
      action: { label: '撤销', onClick: () => unmarkNotInterested(profileId, [item.title]) },
    });
  };
  const detailLine = [item.genres?.split(/\s+/).slice(0, 3).join(' / '), item.remarks].filter(Boolean).join(' · ');
  const hasOverlay = Boolean(onPlay || item.favorite || notInterestable);

  return (
    <div
      className="group/card cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      role="button"
      tabIndex={0}
      aria-label={item.title}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          // 阻止空格触发页面滚动
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="relative aspect-[2/3] bg-chip rounded-xl overflow-hidden ring-1 ring-inset ring-content/[0.06] shadow-[0_2px_10px_rgba(0,0,0,0.14)] transition-[transform,box-shadow] duration-300 ease-out group-hover/card:-translate-y-1 group-hover/card:shadow-[0_14px_30px_rgba(0,0,0,0.28)]">
        {item.cover && !imgFailed ? (
          <SmartImage
            url={item.cover}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={item.title}
            className="w-full h-full object-cover"
            onExhausted={() => setImgFailed(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center bg-chip p-3 text-center">
            <span className="text-xs text-faint line-clamp-3">{item.title}</span>
          </div>
        )}
        {/* 触屏没有悬停：收藏键常显在左上角（收藏过的也常显） */}
        {item.favorite && (
          <FavoriteButton
            entry={item.favorite}
            className="absolute top-1.5 left-1.5 z-10 bg-black/50 text-white hover:bg-black/55 opacity-0 [@media(hover:none)]:opacity-100 transition-opacity"
            onToggle={(saved) => {
              if (saved) onFavorite?.();
            }}
          />
        )}
        {item.rating && (
          <span className="absolute top-1.5 right-1.5 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-black/60 text-white/95 font-medium text-[10.5px] tabular-nums">
            <svg width="9" height="9" viewBox="0 0 24 24" className="text-rating" fill="currentColor" aria-hidden="true"><path d="M12 2.8l2.8 5.9 6.4.8-4.7 4.4 1.2 6.4L12 17.2l-5.7 3.1 1.2-6.4-4.7-4.4 6.4-.8z" /></svg>
            {item.rating}
          </span>
        )}
        {(item.badge || (item.available ?? 0) > 0) && (
          <div className="absolute bottom-1.5 left-1.5 right-1.5 flex flex-wrap gap-1">
            {item.badge && (
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/60 text-[10px] text-white/90 font-medium tracking-wide">
                <span className={cn('w-1.5 h-1.5 rounded-full', item.badge.tone === 'ok' ? 'bg-[#a0b89d]' : 'bg-[#d4b88c]')} aria-hidden />
                {item.badge.text}
              </span>
            )}
            {(item.available ?? 0) > 0 && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-md bg-black/60 text-[10px] text-white/90 font-medium" title={`${item.available} 个点播源最近更新过`}>
                有片源
              </span>
            )}
          </div>
        )}

        {/* 悬停浮层（只在有鼠标的设备上）：重点资讯 + 快捷操作 */}
        {hasOverlay && (
          <div
            className="absolute inset-0 hidden [@media(hover:hover)]:flex flex-col justify-end p-2.5 bg-gradient-to-t from-black/90 via-black/55 to-black/0 opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 transition-opacity duration-200"
            onClick={hidden}
          >
            {detailLine && <p className="text-[10.5px] text-white/80 line-clamp-1 mb-1">{detailLine}</p>}
            {item.subtitle && <p className="text-[11px] leading-snug text-white/85 line-clamp-2 mb-2">{item.subtitle}</p>}
            <div className="flex items-center gap-1.5">
              {onPlay && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPlay();
                  }}
                  className="flex-1 min-w-0 inline-flex items-center justify-center gap-1 h-8 rounded-full bg-white text-black text-xs font-semibold hover:bg-white/85 transition-colors"
                  title="立即播放（看过的从上次的位置继续）"
                >
                  <svg className="w-3.5 h-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M8 5.14v13.72a1 1 0 0 0 1.5.86l11.04-6.86a1 1 0 0 0 0-1.72L9.5 4.28A1 1 0 0 0 8 5.14Z" />
                  </svg>
                  <span className="truncate">播放</span>
                </button>
              )}
              {item.favorite && (
                <FavoriteButton
                  entry={item.favorite}
                  className="w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-inset ring-white/30 hover:bg-white/25"
                  onToggle={(saved) => {
                    if (saved) onFavorite?.();
                  }}
                />
              )}
              <IconAction label="更多信息 / 选集换源" onClick={onClick}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 16v-4M12 8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z" />
              </IconAction>
              {notInterestable && profileId && (
                <IconAction label="不感兴趣（不再推荐）" onClick={notInterested}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 14H5.24a2 2 0 0 1-1.95-2.45l1.2-5.2A2 2 0 0 1 6.44 4.8H17v9l-3.5 5.25a1.5 1.5 0 0 1-2.73-1.06L10 14zM17 4.8h2.5v9H17" />
                </IconAction>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="pt-2 px-0.5">
        <div className="text-[13px] sm:text-sm font-medium leading-snug text-content/90 line-clamp-2 min-h-[2.6em]" title={item.title}>
          {item.title}
        </div>
        {item.meta && <div className="text-[11px] sm:text-xs text-faint truncate mt-0.5">{item.meta}</div>}
      </div>
    </div>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      className="w-8 h-8 shrink-0 inline-flex items-center justify-center rounded-full bg-white/15 text-white ring-1 ring-inset ring-white/30 hover:bg-white/25 transition-colors"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={1.8} viewBox="0 0 24 24" aria-hidden>
        {children}
      </svg>
    </button>
  );
}
