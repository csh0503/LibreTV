import { api, ApiError } from './client-api';
import { db, type HistoryEntry, type FavoriteEntry } from './db';
import type { ProfileBundle } from './profile-bundle';
import { switchProfile } from './profile';
import {
  getActiveProfileId,
  markProfileDirty,
  onProfileDirty,
  setProfileSnapshot,
  withoutProfileDirty,
} from './profile-session';
import { useAppStore } from './store';

let timer: ReturnType<typeof setTimeout> | undefined;
let syncing = false;
let lastDevice = '';

function stripLocalIds<T extends { id: string; profileId: string }>(row: T): Omit<T, 'id' | 'profileId'> {
  const copy = { ...row };
  delete (copy as { id?: string }).id;
  delete (copy as { profileId?: string }).profileId;
  return copy;
}

function isNotFound(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

async function buildBundle(profileId: string, name: string): Promise<ProfileBundle> {
  const [history, favorites, progress, searches] = await Promise.all([
    db.history.where('profileId').equals(profileId).toArray(),
    db.favorites.where('profileId').equals(profileId).toArray(),
    db.progress.where('profileId').equals(profileId).toArray(),
    db.savedSearches.where('profileId').equals(profileId).toArray(),
  ]);
  const state = useAppStore.getState();
  const prefix = `${profileId}::`;
  return {
    version: 1,
    name,
    updatedAt: Date.now(),
    prefs: {
      yellowFilter: state.yellowFilter,
      adFilter: state.adFilter,
      autoplayNext: state.autoplayNext,
      doubanEnabled: state.doubanEnabled,
      recommendSource: state.recommendSource,
      recommendSourceTouched: state.recommendSourceTouched,
      liveFavorites: state.liveFavorites,
      liveRecent: state.liveRecent,
    },
    history: history.map((row) => stripLocalIds(row)),
    favorites: favorites.map((row) => stripLocalIds(row)),
    progress: progress.map((row) => ({
      localKey: row.key.startsWith(prefix) ? row.key.slice(prefix.length) : row.key,
      position: row.position,
      duration: row.duration,
      updatedAt: row.updatedAt,
    })),
    searches: searches.map((row) => ({ text: row.text, timestamp: row.timestamp })),
    device: {
      customAPIs: state.customAPIs,
      selectedKeys: state.selectedKeys,
      subscriptions: state.subscriptions,
      liveSubscriptions: state.liveSubscriptions,
      liveSelectedUrls: state.liveSelectedUrls,
    },
  };
}

function mergeByUrl<T extends { url?: string }>(local: T[], remote: T[]): T[] {
  const seen = new Set(local.map((item) => item.url).filter(Boolean));
  return [...local, ...remote.filter((item) => item.url && !seen.has(item.url))];
}

async function applyBundle(profileId: string, bundle: ProfileBundle): Promise<void> {
  const history = bundle.history.filter((row) => typeof row.sourceKey === 'string' && typeof row.vodId === 'string') as unknown as Omit<HistoryEntry, 'id' | 'profileId'>[];
  const favorites = bundle.favorites.filter((row) => typeof row.localId === 'string' && typeof row.title === 'string') as unknown as Omit<FavoriteEntry, 'id' | 'profileId'>[];
  await withoutProfileDirty(async () => {
    await db.transaction('rw', [db.history, db.favorites, db.progress, db.savedSearches, db.profiles], async () => {
      await db.history.where('profileId').equals(profileId).delete();
      await db.favorites.where('profileId').equals(profileId).delete();
      await db.progress.where('profileId').equals(profileId).delete();
      await db.savedSearches.where('profileId').equals(profileId).delete();
      if (history.length) {
        await db.history.bulkAdd(history.map((row) => ({
          ...row,
          profileId,
          id: `${profileId}::${row.sourceKey}_${row.vodId}`,
        })));
      }
      if (favorites.length) {
        await db.favorites.bulkAdd(favorites.map((row) => ({
          ...row,
          profileId,
          id: `${profileId}::${row.localId}`,
        })));
      }
      if (bundle.progress.length) {
        await db.progress.bulkAdd(bundle.progress.filter((row) => row.localKey).map((row) => ({
          key: `${profileId}::${row.localKey}`,
          profileId,
          position: row.position,
          duration: row.duration,
          updatedAt: row.updatedAt,
        })));
      }
      if (bundle.searches.length) {
        await db.savedSearches.bulkAdd(bundle.searches.filter((row) => row.text).map((row) => ({
          id: `${profileId}::${row.text}`,
          profileId,
          text: row.text,
          timestamp: row.timestamp,
        })));
      }
      const profile = await db.profiles.get(profileId);
      if (profile) {
        await db.profiles.put({
          ...profile,
          name: bundle.name || profile.name,
          prefs: bundle.prefs,
          cloudUpdatedAt: bundle.updatedAt,
          pendingPush: false,
        });
      }
    });
    const state = useAppStore.getState();
    const device = bundle.device;
    useAppStore.setState({
      ...(bundle.prefs as object),
      customAPIs: mergeByUrl(state.customAPIs, (device?.customAPIs ?? []) as typeof state.customAPIs),
      selectedKeys: [...new Set([...state.selectedKeys, ...(device?.selectedKeys ?? [])])],
      subscriptions: mergeByUrl(state.subscriptions, (device?.subscriptions ?? []) as typeof state.subscriptions),
      liveSubscriptions: mergeByUrl(state.liveSubscriptions, (device?.liveSubscriptions ?? []) as typeof state.liveSubscriptions),
      liveSelectedUrls: [...new Set([...state.liveSelectedUrls, ...(device?.liveSelectedUrls ?? [])])],
    });
    const profile = await db.profiles.get(profileId);
    if (profile && profileId === getActiveProfileId()) {
      setProfileSnapshot({ id: profileId, name: profile.name });
    }
  });
}

export async function pushProfile(profileId: string): Promise<void> {
  const profile = await db.profiles.get(profileId);
  if (!profile) return;
  const bundle = await buildBundle(profile.id, profile.name);
  await api.profileSyncPut({ id: profile.id, name: profile.name, pinHash: profile.pinHash, bundle });
  await db.profiles.update(profile.id, { cloudUpdatedAt: bundle.updatedAt, pendingPush: false });
}

export async function pushActiveProfile(): Promise<void> {
  const profileId = getActiveProfileId();
  if (!profileId) return;
  await pushProfile(profileId);
}

export async function reconcileProfile(): Promise<void> {
  if (syncing) return;
  syncing = true;
  try {
    const profileId = getActiveProfileId();
    const profile = profileId ? await db.profiles.get(profileId) : undefined;
    if (!profile) return;
    let remote: ProfileBundle | null = null;
    try {
      remote = await api.profileSyncGet(profile.id);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
    const cloud = profile.cloudUpdatedAt ?? 0;
    if (remote && !profile.pendingPush && remote.updatedAt > cloud) {
      await applyBundle(profile.id, remote);
      return;
    }
    if (profile.pendingPush || !remote) await pushActiveProfile();
  } finally {
    syncing = false;
  }
}

/** 选中云端设定档：本机没有就先建同 id 的档，再拉下资料。 */
export async function openCloudProfile(id: string, pin?: string): Promise<void> {
  const catalog = await api.profileCatalog();
  const remote = catalog.profiles.find((item) => item.id === id);
  let local = await db.profiles.get(id);
  if (!local) {
    local = {
      id,
      name: remote?.name || '设定档',
      createdAt: Date.now(),
      pinHash: remote?.pinHash,
      cloudUpdatedAt: 0,
    };
    await db.profiles.add(local);
  }
  await switchProfile(id, pin);
  let bundle: ProfileBundle | null = null;
  try {
    bundle = await api.profileSyncGet(id);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (bundle && bundle.updatedAt > (local.cloudUpdatedAt ?? 0)) {
    await applyBundle(id, bundle);
    return;
  }
  await pushProfile(id);
}

export function startProfileSync(): void {
  if (typeof window === 'undefined') return;
  const state = useAppStore.getState();
  lastDevice = JSON.stringify([state.customAPIs, state.selectedKeys, state.subscriptions, state.liveSubscriptions, state.liveSelectedUrls]);
  onProfileDirty(() => {
    const id = getActiveProfileId();
    if (!id) return;
    void db.profiles.update(id, { pendingPush: true });
    clearTimeout(timer);
    timer = setTimeout(() => {
      void reconcileProfile().catch(() => {});
    }, 1500);
  });
  useAppStore.subscribe((next) => {
    const sig = JSON.stringify([next.customAPIs, next.selectedKeys, next.subscriptions, next.liveSubscriptions, next.liveSelectedUrls]);
    if (sig === lastDevice) return;
    lastDevice = sig;
    markProfileDirty();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void reconcileProfile().catch(() => {});
  });
  void reconcileProfile().catch(() => {});
}
