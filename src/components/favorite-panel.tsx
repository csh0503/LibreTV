'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { useRouter } from 'next/navigation';
import { Drawer } from './drawer';
import { EmptyState } from './states';
import { SmartImage } from './smart-image';
import { db, toggleFavorite } from '@/lib/db';
import { useProfile } from '@/lib/use-profile';
import { useAppStore } from '@/lib/store';

/** 点播收藏。直播频道的收藏仍在直播页，不放这里。 */
export function FavoritePanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const yellowFilter = useAppStore((s) => s.yellowFilter);
  const imageProxyMode = useAppStore((s) => s.imageProxyMode);
  const customImageProxy = useAppStore((s) => s.customImageProxy);
  const profileId = useProfile().id;
  const rows = useLiveQuery(
    () =>
      profileId
        ? db.favorites.where('profileId').equals(profileId).sortBy('addedAt').then((items) => items.reverse())
        : [],
    [profileId, open]
  );
  const visible = (rows ?? []).filter((row) => !(yellowFilter && row.isAdult));

  return (
    <Drawer open={open} onClose={onClose} title="收藏" width="max-w-lg">
      {visible.length === 0 ? (
        <EmptyState
          icon="search"
          title="还没有收藏"
          description="在海报、详情或播放页点星标即可留下。成人内容关闭时，成人收藏会先藏起来。"
        />
      ) : (
        <ul className="divide-y divide-line">
          {visible.map((row) => (
            <li key={row.id} className="flex items-center gap-3 py-2.5">
              <button
                type="button"
                className="flex items-center gap-3 min-w-0 flex-1 text-left"
                onClick={() => {
                  onClose();
                  router.push(`/?s=${encodeURIComponent(row.title)}`);
                }}
              >
                {row.pic ? (
                  <SmartImage
                    url={row.pic}
                    mode={imageProxyMode}
                    customProxy={customImageProxy}
                    alt=""
                    className="w-10 h-14 object-cover rounded bg-chip shrink-0"
                  />
                ) : (
                  <div className="w-10 h-14 rounded bg-chip shrink-0" />
                )}
                <span className="min-w-0">
                  <span className="block text-sm text-content truncate">{row.title}</span>
                  {row.year && <span className="block text-xs text-faint">{row.year}</span>}
                </span>
              </button>
              <button
                type="button"
                className="text-xs text-faint hover:text-content shrink-0"
                onClick={() => void toggleFavorite({ ...row, localId: row.localId })}
              >
                取消
              </button>
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
