'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db, toggleFavorite, type FavoriteDraft } from '@/lib/db';
import { useProfile } from '@/lib/use-profile';
import { cn } from '@/lib/utils';
import { Icon } from './icon';
import { useToast } from './toast';

/** 收藏星标。放在可点击卡片里时会拦住冒泡，避免点星标变成打开影片。 */
export function FavoriteButton({
  entry,
  className,
  onToggle,
}: {
  entry: FavoriteDraft;
  className?: string;
  onToggle?: (saved: boolean) => void;
}) {
  const profileId = useProfile().id;
  const saved = useLiveQuery(
    () => (profileId ? db.favorites.get(`${profileId}::${entry.localId}`) : undefined),
    [profileId, entry.localId]
  );
  const { toast } = useToast();

  return (
    <button
      type="button"
      className={cn(
        'p-1.5 rounded-full transition-colors',
        saved ? 'text-amber-400 hover:text-amber-300' : 'text-muted hover:text-content hover:bg-hover',
        className,
        // 收藏过的一直显示（卡片上没收藏的只在鼠标移上去时出现）
        saved && '!opacity-100'
      )}
      aria-label={saved ? '取消收藏' : '收藏'}
      title={saved ? '取消收藏' : '收藏'}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        void toggleFavorite(entry).then((on) => {
          onToggle?.(on);
          toast(on ? `已收藏「${entry.title}」` : '已取消收藏', 'success');
        });
      }}
    >
      <Icon name="star" filled={!!saved} className="w-4 h-4" />
    </button>
  );
}
