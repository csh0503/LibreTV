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
}: {
  entry: FavoriteDraft;
  className?: string;
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
        'p-1.5 rounded-md transition-colors',
        saved ? 'text-amber-400 hover:text-amber-300' : 'text-muted hover:text-content hover:bg-hover',
        className
      )}
      aria-label={saved ? '取消收藏' : '收藏'}
      title={saved ? '取消收藏' : '收藏'}
      onClick={(event) => {
        event.stopPropagation();
        event.preventDefault();
        void toggleFavorite(entry).then((on) => toast(on ? `已收藏「${entry.title}」` : '已取消收藏', 'success'));
      }}
    >
      <Icon name="star" filled={!!saved} className="w-4 h-4" />
    </button>
  );
}
