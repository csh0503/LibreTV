'use client';

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, favoriteIdOf, toggleFavorite } from '@/lib/db';
import { loadListUpdates, markListUnavailable, saveListUpdates } from '@/lib/watchlist-updates';
import { useAppStore } from '@/lib/store';
import type { TitlePick } from '@/lib/types';
import { useProfile } from '@/lib/use-profile';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { SmartImage } from './smart-image';
import { useToast } from './toast';

/**
 * 首页卡片点开后搜不到这部作品时的提示（B 方案：首页照常显示，可看性在点开后才判断）。
 * - full：一条结果都没有，代替「没有找到匹配的结果」
 * - inline：只有名字相近的别的片，放在结果上方
 * 有源没响应时不下「暂无」的定论，提示重试。
 */
export function NoSourceNotice({
  pick,
  sourceCount,
  failedCount,
  onRetry,
  variant,
}: {
  pick: TitlePick;
  sourceCount: number;
  failedCount: number;
  onRetry: () => void;
  variant: 'full' | 'inline';
}) {
  const profileId = useProfile().id;
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const { toast } = useToast();
  const [imgFailed, setImgFailed] = useState(false);
  const localId = favoriteIdOf({ title: pick.title });
  const saved = useLiveQuery(
    () => (profileId ? db.favorites.get(`${profileId}::${localId}`) : undefined),
    [profileId, localId],
  );

  const answered = Math.max(0, sourceCount - failedCount);
  const headline = answered === 0 ? '点播源没有响应' : variant === 'full' ? '暂无片源' : '暂无这部的片源';
  const detail =
    answered === 0
      ? `${sourceCount} 个点播源都没有响应，暂时确认不了有没有《${pick.title}》。`
      : variant === 'full'
        ? `已查询 ${answered} 个点播源，都还没有收录《${pick.title}》。`
        : `已查询 ${answered} 个点播源，没有找到《${pick.title}》本身，下面是名称相近的结果。`;

  const addToList = async () => {
    const on = await toggleFavorite({ localId, title: pick.title, pic: pick.cover, year: pick.year });
    // 确实查过、没有：之后搜到了在首页片单上标「上线了」
    if (on && answered > 0 && profileId) saveListUpdates(profileId, markListUnavailable(loadListUpdates(profileId), localId));
    toast(on ? `已加入我的片单，有片源了会在首页片单上提醒你` : '已移出我的片单', 'success');
  };

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => void addToList()}
        className={cn('btn-sm', saved ? 'btn-ghost' : 'btn-primary')}
        aria-pressed={!!saved}
      >
        <Icon name="star" filled={!!saved} className="w-4 h-4" />
        {saved ? '已在我的片单' : '加入我的片单'}
      </button>
      {failedCount > 0 && (
        <button type="button" onClick={onRetry} className="btn-ghost btn-sm">
          重试
        </button>
      )}
    </div>
  );

  const failedNote =
    failedCount > 0 && answered > 0 ? (
      <p className="text-xs text-warning">另有 {failedCount} 个源没有响应，结果可能不完整，可以稍后重试。</p>
    ) : null;

  if (variant === 'inline') {
    return (
      <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-3 rounded-xl border border-line bg-chip px-4 py-3">
        <div className="flex-1 min-w-0 space-y-1">
          <p className="text-sm font-medium text-content">{headline}</p>
          <p className="text-xs text-muted">{detail}</p>
          {failedNote}
        </div>
        {actions}
      </div>
    );
  }

  return (
    <div className="flex flex-col sm:flex-row items-center sm:items-start gap-5 rounded-2xl border border-line bg-surface/60 p-5 sm:p-6 max-w-2xl mx-auto">
      <div className="w-28 sm:w-32 shrink-0 aspect-[2/3] rounded-xl overflow-hidden bg-chip">
        {pick.cover && !imgFailed ? (
          <SmartImage
            url={pick.cover}
            mode={imageProxyMode}
            customProxy={customImageProxy}
            alt={pick.title}
            className="w-full h-full object-cover grayscale-[35%]"
            onExhausted={() => setImgFailed(true)}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <Icon name="search" className="w-6 h-6 text-faint" />
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0 space-y-2 text-center sm:text-left">
        <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/15 text-warning">
          {headline}
        </span>
        <h3 className="text-lg font-bold text-content break-words">{pick.title}</h3>
        {(pick.year || pick.area || pick.rating) && (
          <p className="text-xs text-faint">
            {[pick.year, pick.area, pick.rating && `★ ${pick.rating}`].filter(Boolean).join(' · ')}
          </p>
        )}
        <p className="text-sm text-muted leading-relaxed">
          {detail}采集站通常会在播出后陆续收录，先加入片单，之后在「我的片单」里点开就会重新查找。
        </p>
        {failedNote}
        <div className="pt-1 flex justify-center sm:justify-start">{actions}</div>
      </div>
    </div>
  );
}
