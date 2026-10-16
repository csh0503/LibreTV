import type { DoubanItem } from './types';
import { db, type FavoriteEntry, type HistoryEntry, type TasteEntry } from './db';
import { getActiveProfileId, markProfileDirty, whenProfileReady } from './profile-session';
import { canonicalTitle } from './title-aliases';
import {
  genresFromCard,
  unionGenres,
  type TasteChannel,
  type TasteSnapshot,
} from './taste';

async function currentProfile(): Promise<string | null> {
  await whenProfileReady();
  return getActiveProfileId() || null;
}

function snapshotOf(prev: TasteEntry | undefined, item: Pick<DoubanItem, 'id' | 'title' | 'genres' | 'area' | 'year' | 'rating'>, channel: TasteChannel | undefined, pickedGenre?: string): TasteSnapshot {
  const year = item.year && /^\d{4}$/.test(item.year) ? item.year : undefined;
  return {
    title: item.title.trim() || prev?.title || '',
    updatedAt: Date.now(),
    doubanId: item.id || prev?.doubanId,
    channel: prev?.channel ?? channel,
    genres: unionGenres(prev?.genres, genresFromCard(pickedGenre, item.genres)),
    area: prev?.area || item.area?.trim() || undefined,
    year: prev?.year || year,
    rating: prev?.rating || item.rating,
  };
}

function sameTaste(prev: TasteEntry, next: TasteSnapshot): boolean {
  return prev.title === next.title
    && prev.channel === next.channel
    && (prev.genres ?? '') === (next.genres ?? '')
    && (prev.area ?? '') === (next.area ?? '')
    && (prev.year ?? '') === (next.year ?? '')
    && (prev.rating ?? '') === (next.rating ?? '')
    && (prev.doubanId ?? '') === (next.doubanId ?? '');
}

async function stampRows(profileId: string, key: string, next: TasteSnapshot): Promise<boolean> {
  const [history, favorites] = await Promise.all([
    db.history.where('profileId').equals(profileId).toArray(),
    db.favorites.where('profileId').equals(profileId).toArray(),
  ]);
  let changed = false;
  for (const row of history) {
    if (canonicalTitle(row.title) !== key) continue;
    const patch = rowPatch(row, next);
    if (!patch) continue;
    await db.history.update(row.id, patch);
    changed = true;
  }
  for (const row of favorites) {
    if (canonicalTitle(row.title) !== key) continue;
    const patch = rowPatch(row, next);
    if (!patch) continue;
    await db.favorites.update(row.id, patch);
    changed = true;
  }
  return changed;
}

function rowPatch(
  row: HistoryEntry | FavoriteEntry,
  next: TasteSnapshot,
): { tasteGenres?: string; tasteArea?: string; tasteYear?: string; tasteChannel?: TasteChannel; tasteRating?: string; tasteDoubanId?: string } | null {
  const genres = unionGenres(row.tasteGenres, next.genres);
  const channel = row.tasteChannel ?? next.channel;
  const area = row.tasteArea || next.area;
  const year = row.tasteYear || next.year;
  const rating = row.tasteRating || next.rating;
  const doubanId = row.tasteDoubanId || next.doubanId;
  if (
    (row.tasteGenres ?? '') === (genres ?? '')
    && row.tasteChannel === channel
    && (row.tasteArea ?? '') === (area ?? '')
    && (row.tasteYear ?? '') === (year ?? '')
    && (row.tasteRating ?? '') === (rating ?? '')
    && (row.tasteDoubanId ?? '') === (doubanId ?? '')
  ) {
    return null;
  }
  return {
    ...(genres ? { tasteGenres: genres } : {}),
    ...(channel ? { tasteChannel: channel } : {}),
    ...(area ? { tasteArea: area } : {}),
    ...(year ? { tasteYear: year } : {}),
    ...(rating ? { tasteRating: rating } : {}),
    ...(doubanId ? { tasteDoubanId: doubanId } : {}),
  };
}

/** 记下豆瓣卡片上的题材。大厅点过、收藏过、以及和观看记录对得上的片子都会进来。 */
export async function rememberDoubanItem(
  item: Pick<DoubanItem, 'id' | 'title' | 'genres' | 'area' | 'year' | 'rating'>,
  channel?: TasteChannel,
  pickedGenre?: string,
  opts?: { quiet?: boolean },
): Promise<boolean> {
  const profileId = await currentProfile();
  const title = item.title.trim();
  const key = canonicalTitle(title);
  if (!profileId || !key) return false;
  const id = `${profileId}::${key}`;
  const prev = await db.tastes.get(id);
  const next = snapshotOf(prev, item, channel, pickedGenre);
  if (!next.genres && !next.channel && !next.area) return false;
  let changed = false;
  if (!prev || !sameTaste(prev, next)) {
    await db.tastes.put({ ...next, id, profileId, updatedAt: Date.now() });
    changed = true;
  }
  if (await stampRows(profileId, key, next)) changed = true;
  if (changed && !opts?.quiet) markProfileDirty();
  return changed;
}

/** 从采集站详情（typeName / area / year）补齐口味，让直接搜索播放的影片也能参与推荐 */
export async function rememberVideoInfo(
  title: string,
  extracted: { channel?: TasteChannel; genres?: string; area?: string; year?: string },
): Promise<boolean> {
  if (!extracted.channel && !extracted.genres && !extracted.area) return false;
  return rememberDoubanItem(
    {
      id: '',
      title,
      genres: extracted.genres,
      area: extracted.area,
      year: extracted.year,
    },
    extracted.channel,
  );
}

/** 大厅这一页里，如果有已经看过或收藏过的片子，把卡片上的题材补到那条记录上。 */
export async function absorbHallTaste(items: DoubanItem[], channel: TasteChannel, pickedGenre: string): Promise<void> {
  const profileId = await currentProfile();
  if (!profileId || items.length === 0) return;
  const [history, favorites] = await Promise.all([
    db.history.where('profileId').equals(profileId).toArray(),
    db.favorites.where('profileId').equals(profileId).toArray(),
  ]);
  const known = new Set<string>();
  for (const row of [...history, ...favorites]) {
    const key = canonicalTitle(row.title);
    if (key) known.add(key);
  }
  let changed = false;
  for (const item of items) {
    if (getActiveProfileId() !== profileId) return;
    if (!known.has(canonicalTitle(item.title))) continue;
    if (await rememberDoubanItem(item, channel, pickedGenre === '全部' ? undefined : pickedGenre, { quiet: true })) {
      changed = true;
    }
  }
  if (changed) markProfileDirty();
}

