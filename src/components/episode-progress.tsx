'use client';

import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '@/lib/db';
import { useProfile } from '@/lib/use-profile';
import { cn } from '@/lib/utils';

/** 看到这个比例就算这一集看完了（片尾曲、下集预告不用看完） */
export const EPISODE_WATCHED_RATIO = 0.9;

/**
 * 这个源这部片每一集看到哪里：集序号 → 看过的比例（0~1，看完的是 1）。
 * 进度表按「设定档::源_影片_集序号」存，播完的一集记成位置 = 总长。
 */
export function useEpisodeProgress(sourceKey?: string, vodId?: string): Map<number, number> {
  const profileId = useProfile().id;
  const rows = useLiveQuery(
    () =>
      profileId && sourceKey && vodId
        ? db.progress.where('key').startsWith(`${profileId}::${sourceKey}_${vodId}_`).toArray()
        : [],
    [profileId, sourceKey, vodId],
  );
  const map = new Map<number, number>();
  const prefixLength = `${profileId}::${sourceKey}_${vodId}_`.length;
  for (const row of rows ?? []) {
    const rest = row.key.slice(prefixLength);
    // 影片编号本身带下划线时前缀会匹配到别的片：剩下的必须只是集序号
    if (!/^\d+$/.test(rest) || !row.duration) continue;
    const ratio = Math.min(1, row.position / row.duration);
    map.set(Number(rest), ratio >= EPISODE_WATCHED_RATIO ? 1 : ratio);
  }
  return map;
}

/** 集数按钮底部的进度条：看了一半显示到哪里，看完的整条 */
export function EpisodeProgressBar({ ratio, active }: { ratio?: number; active?: boolean }) {
  if (!ratio || ratio < 0.02) return null;
  return (
    <span aria-hidden className={cn('absolute left-1.5 right-1.5 bottom-1 h-[3px] rounded-full', active ? 'bg-page/25' : 'bg-content/15')}>
      <span
        className={cn('block h-full rounded-full', ratio >= 1 ? (active ? 'bg-page/60' : 'bg-content/40') : 'bg-accent')}
        style={{ width: `${Math.round(ratio * 100)}%` }}
      />
    </span>
  );
}

/** 鼠标提示里的文字 */
export function episodeProgressHint(ratio?: number): string {
  if (!ratio || ratio < 0.02) return '';
  return ratio >= 1 ? '看过了' : `看到 ${Math.round(ratio * 100)}%`;
}
