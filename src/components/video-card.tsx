'use client';

import { useEffect, useMemo, useState } from 'react';
import type { SearchResultItem } from '@/lib/types';
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
import { QualityTag, useSourceQuality } from './use-source-quality';
import { qualityKey, rankSources } from '@/lib/source-rank';
import type { FavoriteDraft } from '@/lib/db';

export { aggregateResults, buildGroupTitleKey, normalizeYearToken, type AggregatedGroup };

/**
 * 聚合影片卡片：
 * - 单源：点击直接打开该源详情（与旧体验一致）；
 * - 多源：显示「N 个来源」徽章，点击展开各源列表，选择具体源后打开详情。
 */
export function AggregatedCard({
  group,
  onOpen,
}: {
  group: AggregatedGroup;
  onOpen: (item: SearchResultItem) => void;
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const showImg = !!group.pic && !imgFailed;

  const multi = group.items.length > 1;
  const adult = useMemo(() => group.items.some((i) => i.isAdult), [group.items]);
  const groupItems = useMemo(() => [group.items], [group.items]);
  // 展开时才质检（清晰度 / 插入广告），按「没出错 → 清晰 → 集数 → 广告少 → 快」排，第一个标推荐
  const sourceHealth = useAppStore((s) => s.sourceHealth);
  const { qualityMap, isFetching: qualityFetching } = useSourceQuality(groupItems, multi && expanded);
  const rankedItems = useMemo(
    () => rankSources(group.items, sourceHealth, qualityMap),
    [group.items, sourceHealth, qualityMap],
  );

  const activate = () => {
    if (multi) setExpanded((v) => !v);
    else onOpen(group.items[0]);
  };

  return (
    <div className={cn('card', !multi && 'hover:scale-[1.02] hover:shadow-md', multi && expanded && 'ring-1 ring-accent/40')}>
      {/* 不用 h-full：展开面板需要撑高卡片，等高裁切会让面板不可见 */}
      <div
        className="flex h-full cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
        role="button"
        tabIndex={0}
        aria-expanded={multi ? expanded : undefined}
        onClick={activate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            activate();
          }
        }}
      >
        {showImg ? (
          <div className="relative flex-shrink-0 w-[105px] sm:w-[120px] aspect-[2/3] bg-chip">
            <SmartImage
              url={group.pic}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt={group.name}
              className="absolute inset-0 h-full w-full object-cover"
              onExhausted={() => setImgFailed(true)}
            />
            <div className="absolute inset-0 bg-gradient-to-r from-black/30 to-transparent" />
            {multi && (
              <span className="absolute top-1.5 left-1.5 tag bg-black/60 text-white font-medium">
                {group.items.length} 源
              </span>
            )}
          </div>
        ) : (
          <div className="relative flex-shrink-0 w-[105px] sm:w-[120px] aspect-[2/3] bg-chip flex items-center justify-center">
            <svg className="w-8 h-8 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z" />
            </svg>
            {multi && (
              <span className="absolute top-1.5 left-1.5 tag bg-black/60 text-white font-medium">
                {group.items.length} 源
              </span>
            )}
          </div>
        )}

        <div className="p-2.5 flex flex-col flex-grow min-w-0">
          <div className="flex-grow">
            <h3 className="font-semibold text-sm text-content mb-1.5 line-clamp-2" title={group.name}>
              {group.name}
            </h3>
            <div className="flex flex-wrap gap-1 mb-1.5">
              {group.typeName && <span className="tag bg-content/[0.07] text-muted">{group.typeName}</span>}
              {group.year && <span className="tag bg-content/[0.07] text-muted">{group.year}</span>}
              {adult && <span className="tag bg-danger/15 text-danger">(18+)</span>}
            </div>
            <p className="text-xs text-muted line-clamp-2 mb-2">{group.remarks || '暂无介绍'}</p>
          </div>
          <div className="flex items-center justify-between mt-auto pt-1.5 border-t border-line">
            <span className="tag bg-chip text-muted truncate max-w-[80%]">
              {multi ? `${group.items.length} 个来源` : group.items[0].sourceName}
            </span>
            {multi && (
              <svg
                className={cn('w-4 h-4 text-faint transition-transform', expanded && 'rotate-180')}
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                aria-hidden
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            )}
          </div>
        </div>
      </div>

      {multi && expanded && (
        <div className="border-t border-line p-2.5 animate-fade-in">
          <p className="text-[10px] text-faint mb-1.5">
            选择来源播放{qualityFetching ? ' · 正在挑选画质最好的片源…' : ''}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {rankedItems.map((item, i) => (
              <button
                key={`${item.sourceKey}_${item.vodId}`}
                className={cn(
                  'group inline-flex items-center gap-1.5 max-w-full rounded-xl border px-2.5 py-1.5',
                  'text-xs transition-all cursor-pointer',
                  'border-line bg-chip hover:border-accent hover:bg-accent/10',
                  i === 0 && Object.keys(qualityMap).length > 0 && 'border-accent/60',
                  item.isAdult && 'border-danger/30'
                )}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(item);
                }}
                aria-label={`使用 ${item.sourceName} 播放`}
              >
                {i === 0 && Object.keys(qualityMap).length > 0 && <span className="text-accent font-medium">推荐</span>}
                <span className="font-medium text-content truncate max-w-[9em]">{item.sourceName}</span>
                <span className="text-faint truncate max-w-[7em]">{item.remarks || '暂无介绍'}</span>
                <QualityTag q={qualityMap[qualityKey(item)]} />
                <svg
                  className="w-3.5 h-3.5 text-accent shrink-0 transition-transform group-hover:scale-110"
                  fill="currentColor"
                  viewBox="0 0 24 24"
                  aria-hidden
                >
                  <path d="M8 5v14l11-7z" />
                </svg>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 影片卡片：封面加载失败时逐级降级到占位图（未聚合的单一结果使用） */
export function VideoCard({ item, onClick }: { item: SearchResultItem; onClick: () => void }) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  const showImg = !!item.pic && !imgFailed;

  return (
    <div
      className="card cursor-pointer hover:scale-[1.02] hover:shadow-md h-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          // 阻止空格触发页面滚动（AggregatedCard 已是此写法，此处对齐）
          e.preventDefault();
          onClick();
        }
      }}
    >
      <div className="flex h-full">
        {showImg ? (
          <div className="relative flex-shrink-0 w-[105px] sm:w-[120px] aspect-[2/3] bg-chip">
            <SmartImage
              url={item.pic}
              mode={imageProxyMode}
              customProxy={customImageProxy}
              alt={item.name}
              className="h-full w-full object-cover"
              onExhausted={() => setImgFailed(true)}
            />
            <div className="absolute inset-0 bg-gradient-to-r from-black/30 to-transparent" />
          </div>
        ) : (
          <div className="flex-shrink-0 w-[105px] sm:w-[120px] aspect-[2/3] bg-chip flex items-center justify-center">
            <svg className="w-8 h-8 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z" />
            </svg>
          </div>
        )}

        <div className="p-2.5 flex flex-col flex-grow min-w-0">
          <div className="flex-grow">
            <h3 className="font-semibold text-sm text-content mb-1.5 line-clamp-2" title={item.name}>
              {item.name}
            </h3>
            <div className="flex flex-wrap gap-1 mb-1.5">
              {item.typeName && <span className="tag bg-accent/15 text-accent">{item.typeName}</span>}
              {item.year && <span className="tag bg-content/[0.07] text-muted">{item.year}</span>}
            </div>
            <p className="text-xs text-muted line-clamp-2 mb-2">{item.remarks || '暂无介绍'}</p>
          </div>
          <div className="flex items-center justify-between mt-auto pt-1.5 border-t border-line">
            <span className="tag bg-chip text-muted truncate max-w-[80%]">{item.sourceName}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 推荐卡片。badge 用来标完结 / 连载，meta 是年份和地区。 */
export function DoubanCard({
  item,
  onClick,
  onFavorite,
}: {
  item: {
    title: string;
    cover: string;
    rating?: string;
    meta?: string;
    badge?: { text: string; tone: 'ok' | 'warn' };
    favorite?: FavoriteDraft;
  };
  onClick: () => void;
  onFavorite?: () => void;
}) {
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => setImgFailed(false), [item.cover]);

  return (
    <div
      className="group/card cursor-pointer rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          // 阻止空格触发页面滚动（AggregatedCard 已是此写法，此处对齐）
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
          <div className="w-full h-full flex items-center justify-center bg-chip">
            <svg className="w-8 h-8 text-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16m10-16v16M3 6a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm8 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6zm4 0a1 1 0 011-1h1a1 1 0 011 1v12a1 1 0 01-1 1h-1a1 1 0 01-1-1V6z" />
            </svg>
          </div>
        )}
        {item.favorite && (
          <FavoriteButton
            entry={item.favorite}
            className="absolute top-1.5 left-1.5 z-10 bg-black/50 text-white hover:bg-black/55 opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity"
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
        {item.badge && (
          <span className="absolute bottom-1.5 left-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-black/60 text-[10px] text-white/90 font-medium tracking-wide">
            <span className={cn('w-1.5 h-1.5 rounded-full', item.badge.tone === 'ok' ? 'bg-[#a0b89d]' : 'bg-[#d4b88c]')} aria-hidden />
            {item.badge.text}
          </span>
        )}
      </div>
      <div className="pt-2 px-0.5">
        <div className="text-[13px] font-medium text-content/90 truncate" title={item.title}>
          {item.title}
        </div>
        {item.meta && <div className="text-[11px] text-faint truncate mt-0.5">{item.meta}</div>}
      </div>
    </div>
  );
}
