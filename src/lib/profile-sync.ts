import { api, ApiError } from './client-api';
import { db, MAX_FAVORITES, MAX_HISTORY, MAX_SEARCH_HISTORY, type HistoryEntry, type FavoriteEntry } from './db';
import { canonicalTitle } from './title-aliases';
import { trimHistory } from './history-work';
import { loadNotInterestedMarks, mergeNotInterestedMarks, replaceNotInterestedMarks } from './not-interested';
import { readTasteSnapshot, snapshotFromStored, unionTasteSnapshots, type TasteSnapshot } from './taste';
import type { ProfileBundle } from './profile-bundle';
import { clearActiveProfile, eraseLocalProfile, switchProfile } from './profile';
import {
  getActiveProfileId,
  markProfileDirty,
  onProfileDirty,
  setProfileSnapshot,
  withoutProfileDirty,
} from './profile-session';
import { useAppStore } from './store';

let timer: ReturnType<typeof setTimeout> | undefined;
let lazyTimer: ReturnType<typeof setTimeout> | undefined;
/** 待上传的只有播放进度：定时轮询和切回页面时先不传，等延后上传的那次或离开页面时再传 */
let lazyOnly = false;
let syncing = false;
/**
 * 云端存储按请求次数计费，节奏按服务端实际用的存储定（/api/status 的 syncStorage）：
 * - Redis（免费每月约 50 万次）：每 30 秒看一眼别的设备，播放进度最多 1 分钟传一次；
 * - Blob（免费每月约 1 万次读、2 千次写）：每 2 分钟看一眼，进度最多 5 分钟传一次。
 * 收藏等操作 1 秒内上传；切回页面时立刻看一次，离开页面时补传攒着的进度。
 * 还不知道是哪种存储时按保守的 Blob 节奏。
 */
const PUSH_DEBOUNCE_MS = 1000;
const CADENCE = {
  redis: { poll: 30_000, lazy: 60_000 },
  conservative: { poll: 2 * 60_000, lazy: 5 * 60_000 },
} as const;
let cadence: { poll: number; lazy: number } = CADENCE.conservative;
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

type CatalogProfile = { id: string; name: string; pinHash?: string; updatedAt: number };

/**
 * 云端名单里没有的旧档，是别的设备删掉的。
 * 本机刚建、还没上传成功的不算，那种要留下来推上去。
 */
export function shouldDropLocalProfile(
  profile: { id: string; pendingPush?: boolean; cloudUpdatedAt?: number },
  catalogIds: Set<string>
): boolean {
  if (catalogIds.has(profile.id)) return false;
  if (profile.pendingPush && profile.cloudUpdatedAt == null) return false;
  return true;
}

/** 按云端名单清掉本机已经不该存在的设定档。云端没连上时返回 null，本机先不动。 */
export async function forgetProfilesRemovedFromCloud(): Promise<CatalogProfile[] | null> {
  let profiles: CatalogProfile[];
  try {
    profiles = (await api.profileCatalog()).profiles;
  } catch {
    return null;
  }
  const ids = new Set(profiles.map((item) => item.id));
  const local = await db.profiles.toArray();
  const drop = local.filter((profile) => shouldDropLocalProfile(profile, ids));
  const active = getActiveProfileId();
  await withoutProfileDirty(async () => {
    for (const profile of drop) await eraseLocalProfile(profile.id);
    if (drop.some((profile) => profile.id === active)) clearActiveProfile();
  });
  return profiles;
}

async function buildBundle(profileId: string, name: string): Promise<ProfileBundle> {
  const [history, favorites, progress, searches, tasteRows] = await Promise.all([
    db.history.where('profileId').equals(profileId).toArray(),
    db.favorites.where('profileId').equals(profileId).toArray(),
    db.progress.where('profileId').equals(profileId).toArray(),
    db.savedSearches.where('profileId').equals(profileId).toArray(),
    db.tastes.where('profileId').equals(profileId).toArray(),
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
    notInterested: loadNotInterestedMarks(profileId),
    tastes: unionTasteSnapshots(
      tasteRows.map((row) => ({
        title: row.title,
        updatedAt: row.updatedAt,
        doubanId: row.doubanId,
        channel: row.channel,
        genres: row.genres,
        area: row.area,
        year: row.year,
        rating: row.rating,
      })),
      history.flatMap((row) => {
        const snap = snapshotFromStored(row);
        return snap ? [snap] : [];
      }),
      favorites.flatMap((row) => {
        const snap = snapshotFromStored(row);
        return snap ? [snap] : [];
      }),
    ),
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

/**
 * 以最后一次同步成功的时间为界，合并两边的收藏、历史和进度。
 * 那之后任一边新增的留下；那之前只剩一边的，算另一边删掉了。
 */
export function mergeSyncedRows<T>(
  base: number,
  local: T[],
  remote: T[],
  keyOf: (row: T) => string,
  timeOf: (row: T) => number,
): T[] {
  const localMap = new Map<string, T>();
  const remoteMap = new Map<string, T>();
  for (const row of local) {
    const key = keyOf(row);
    const prev = localMap.get(key);
    if (!prev || timeOf(row) >= timeOf(prev)) localMap.set(key, row);
  }
  for (const row of remote) {
    const key = keyOf(row);
    const prev = remoteMap.get(key);
    if (!prev || timeOf(row) >= timeOf(prev)) remoteMap.set(key, row);
  }
  const out: T[] = [];
  for (const key of new Set([...localMap.keys(), ...remoteMap.keys()])) {
    const left = localMap.get(key);
    const right = remoteMap.get(key);
    if (left && right) {
      out.push(timeOf(left) >= timeOf(right) ? left : right);
      continue;
    }
    const only = left ?? right;
    if (only && timeOf(only) > base) out.push(only);
  }
  return out;
}

type HistRow = Omit<HistoryEntry, 'id' | 'profileId'>;
type FavRow = Omit<FavoriteEntry, 'id' | 'profileId'>;

async function applyBundle(profileId: string, bundle: ProfileBundle, opts?: { live?: boolean; keepPending?: boolean }): Promise<void> {
  const remoteHistory = bundle.history.filter((row) => typeof row.sourceKey === 'string' && typeof row.vodId === 'string') as unknown as HistRow[];
  const remoteFavorites = bundle.favorites.filter((row) => typeof row.localId === 'string' && typeof row.title === 'string') as unknown as FavRow[];
  const remoteProgress = bundle.progress.filter((row) => row.localKey);
  const remoteSearches = bundle.searches.filter((row) => row.text);
  await withoutProfileDirty(async () => {
    await db.transaction('rw', [db.history, db.favorites, db.progress, db.savedSearches, db.profiles, db.tastes], async () => {
      const profile = await db.profiles.get(profileId);
      const base = profile?.cloudUpdatedAt ?? 0;
      const prefix = `${profileId}::`;
      const localHistory = (await db.history.where('profileId').equals(profileId).toArray()).map((row) => {
        const copy = { ...row };
        delete (copy as { id?: string }).id;
        delete (copy as { profileId?: string }).profileId;
        return copy as HistRow;
      });
      const localFavorites = (await db.favorites.where('profileId').equals(profileId).toArray()).map((row) => {
        const copy = { ...row };
        delete (copy as { id?: string }).id;
        delete (copy as { profileId?: string }).profileId;
        return copy as FavRow;
      });
      const localProgress = (await db.progress.where('profileId').equals(profileId).toArray()).map((row) => ({
        localKey: row.key.startsWith(prefix) ? row.key.slice(prefix.length) : row.key,
        position: row.position,
        duration: row.duration,
        updatedAt: row.updatedAt,
      }));
      const localSearches = (await db.savedSearches.where('profileId').equals(profileId).toArray()).map((row) => ({
        text: row.text,
        timestamp: row.timestamp,
      }));
      const history = trimHistory(
        mergeSyncedRows(base, localHistory, remoteHistory, (row) => `${row.sourceKey}_${row.vodId}`, (row) => row.timestamp),
        MAX_HISTORY,
      ).keep;
      const favorites = mergeSyncedRows(base, localFavorites, remoteFavorites, (row) => row.localId, (row) => row.addedAt)
        .sort((a, b) => b.addedAt - a.addedAt)
        .slice(0, MAX_FAVORITES);
      const progress = mergeSyncedRows(base, localProgress, remoteProgress, (row) => row.localKey, (row) => row.updatedAt);
      const searches = mergeSyncedRows(base, localSearches, remoteSearches, (row) => row.text, (row) => row.timestamp)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, MAX_SEARCH_HISTORY);
      const localTastes = (await db.tastes.where('profileId').equals(profileId).toArray()).map((row) => ({
        title: row.title,
        updatedAt: row.updatedAt,
        doubanId: row.doubanId,
        channel: row.channel,
        genres: row.genres,
        area: row.area,
        year: row.year,
        rating: row.rating,
      }));
      const remoteTastes = (bundle.tastes ?? [])
        .map((row) => readTasteSnapshot(row))
        .filter((row): row is TasteSnapshot => row !== null);
      const carried = [...history, ...favorites].flatMap((row) => {
        const snap = snapshotFromStored(row);
        return snap ? [snap] : [];
      });
      const tastes = unionTasteSnapshots(localTastes, remoteTastes, carried);
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
      if (progress.length) {
        await db.progress.bulkAdd(progress.map((row) => ({
          key: `${profileId}::${row.localKey}`,
          profileId,
          position: row.position,
          duration: row.duration,
          updatedAt: row.updatedAt,
        })));
      }
      if (searches.length) {
        await db.savedSearches.bulkAdd(searches.map((row) => ({
          id: `${profileId}::${row.text}`,
          profileId,
          text: row.text,
          timestamp: row.timestamp,
        })));
      }
      await db.tastes.where('profileId').equals(profileId).delete();
      if (tastes.length) {
        await db.tastes.bulkAdd(tastes.map((row) => ({
          ...row,
          profileId,
          id: `${profileId}::${canonicalTitle(row.title)}`,
        })));
      }
      if (profile) {
        await db.profiles.put({
          ...profile,
          name: bundle.name || profile.name,
          prefs: opts?.keepPending ? profile.prefs : bundle.prefs,
          cloudUpdatedAt: bundle.updatedAt,
          pendingPush: Boolean(opts?.keepPending),
        });
      }
    });
    const live = (opts?.live ?? profileId === getActiveProfileId()) && !opts?.keepPending;
    if (live) {
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
    }
  });
  // 旧包裹没有 notInterested 时不要清本机名单。较新的取消盖过较早的标记；
  // 合并结果和云端不一样（本机有更新的取消）时再传上去。
  if (bundle.notInterested) {
    const merged = mergeNotInterestedMarks(loadNotInterestedMarks(profileId), bundle.notInterested);
    replaceNotInterestedMarks(profileId, merged);
    const remote = mergeNotInterestedMarks([], bundle.notInterested);
    const same =
      merged.length === remote.length &&
      merged.every((mark) => remote.some((other) => other.title === mark.title && other.at === mark.at && other.on === mark.on));
    if (!same) markProfileDirty();
  }
}

const pulling = new Map<string, Promise<void>>();

/** 把云端某一个设定档的历史、收藏和偏好写进这台浏览器。不切换当前正在看的人。 */
async function pullCatalogProfile(item: CatalogProfile): Promise<void> {
  const inflight = pulling.get(item.id);
  if (inflight) return inflight;
  const job = pullCatalogProfileOnce(item).finally(() => pulling.delete(item.id));
  pulling.set(item.id, job);
  return job;
}

async function pullCatalogProfileOnce(item: CatalogProfile): Promise<void> {
  const local = await db.profiles.get(item.id);
  // 名单上的时间没变就不用把整份收藏和历史再下一次。
  if (local && (local.cloudUpdatedAt ?? 0) >= (item.updatedAt || 0)) {
    if (local.name !== (item.name || local.name) || local.pinHash !== item.pinHash) {
      await db.profiles.update(item.id, { name: item.name || local.name, pinHash: item.pinHash });
    }
    return;
  }
  let bundle: ProfileBundle | null = null;
  try {
    bundle = await api.profileSyncGet(item.id);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  if (!bundle) {
    if (!local) {
      await db.profiles.add({
        id: item.id,
        name: item.name || '设定档',
        createdAt: item.updatedAt || Date.now(),
        pinHash: item.pinHash,
        cloudUpdatedAt: item.updatedAt,
        pendingPush: false,
      });
    }
    return;
  }
  if (local && (local.cloudUpdatedAt ?? 0) >= bundle.updatedAt) {
    if (local.name !== item.name || local.pinHash !== item.pinHash) {
      await db.profiles.update(item.id, { name: item.name || local.name, pinHash: item.pinHash });
    }
    return;
  }
  if (!local) {
    await db.profiles.add({
      id: item.id,
      name: item.name || bundle.name || '设定档',
      createdAt: item.updatedAt || Date.now(),
      pinHash: item.pinHash,
      pendingPush: false,
    });
  } else if (item.pinHash !== local.pinHash) {
    await db.profiles.update(item.id, { pinHash: item.pinHash });
  }
  await applyBundle(item.id, bundle, {
    live: item.id === getActiveProfileId(),
    keepPending: Boolean(local?.pendingPush),
  });
}

/** 云端有的设定档，立刻拉到这台设备。删掉的也会从本机去掉。 */
export async function syncCloudProfilesToDevice(): Promise<CatalogProfile[] | null> {
  const catalog = await forgetProfilesRemovedFromCloud();
  if (!catalog) return null;
  for (const item of catalog) {
    try {
      await pullCatalogProfile(item);
    } catch {
      // 一个档失败不挡住其他档，下次打开再拉
    }
  }
  return catalog;
}

export async function pushProfile(profileId: string, knownCatalog?: CatalogProfile[]): Promise<void> {
  const profile = await db.profiles.get(profileId);
  if (!profile) return;
  // 刚读过名单就直接用，省一次存储读取
  const catalog = knownCatalog ? { profiles: knownCatalog } : await api.profileCatalog();
  const ids = new Set(catalog.profiles.map((item) => item.id));
  // 别的设备刚删掉的档，不能因为本机还留着就再写回云端。
  if (shouldDropLocalProfile(profile, ids)) {
    await withoutProfileDirty(async () => {
      await eraseLocalProfile(profileId);
      if (getActiveProfileId() === profileId) clearActiveProfile();
    });
    return;
  }
  let remote: ProfileBundle | null = null;
  // 名单上的更新时间不比本机新，说明别的设备没动过这份，不用先下载再合并
  const listedEntry = catalog.profiles.find((item) => item.id === profile.id);
  const remoteMayBeNewer = !listedEntry || (listedEntry.updatedAt || 0) > (profile.cloudUpdatedAt ?? 0);
  if (remoteMayBeNewer) {
    try {
      remote = await api.profileSyncGet(profile.id);
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }
  // 先把另一台刚加上的收藏和记录并进来，再整份上传，避免盖掉对方。
  if (remote && remote.updatedAt > (profile.cloudUpdatedAt ?? 0)) {
    await applyBundle(profile.id, remote, { live: profile.id === getActiveProfileId(), keepPending: true });
  }
  const latest = await db.profiles.get(profile.id);
  if (!latest) return;
  const bundle = await buildBundle(latest.id, latest.name);
  await api.profileSyncPut({ id: latest.id, name: latest.name, pinHash: latest.pinHash, bundle });
  await db.profiles.update(latest.id, { cloudUpdatedAt: bundle.updatedAt, pendingPush: false });
}

export async function pushActiveProfile(knownCatalog?: CatalogProfile[]): Promise<void> {
  const profileId = getActiveProfileId();
  if (!profileId) return;
  await pushProfile(profileId, knownCatalog);
}

export async function reconcileProfile(): Promise<void> {
  if (syncing) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reconcileProfile().catch(() => {});
    }, 300);
    return;
  }
  syncing = true;
  try {
    const catalog = await syncCloudProfilesToDevice();
    const profileId = getActiveProfileId();
    const profile = profileId ? await db.profiles.get(profileId) : undefined;
    if (!profile) return;
    const wantPush = profile.pendingPush && !(lazyOnly && lazyTimer !== undefined);
    if (!catalog) {
      if (wantPush) await pushActiveProfile();
      if (wantPush) lazyOnly = false;
      return;
    }
    const listed = catalog.some((item) => item.id === profile.id);
    // 名单已经确认没有这份，就停。再上传会把别的手机删掉的档写回去。
    if (!listed && profile.cloudUpdatedAt != null) return;
    if (wantPush && (listed || profile.cloudUpdatedAt == null)) {
      await pushActiveProfile(catalog);
      lazyOnly = false;
    }
  } finally {
    syncing = false;
  }
}

/** 选中云端设定档：本机没有就先建同 id 的档，再拉下资料。 */
export async function openCloudProfile(id: string, pin?: string): Promise<void> {
  const catalog = await api.profileCatalog();
  const ids = new Set(catalog.profiles.map((item) => item.id));
  const remote = catalog.profiles.find((item) => item.id === id);
  let local = await db.profiles.get(id);
  if (local && shouldDropLocalProfile(local, ids)) {
    await withoutProfileDirty(async () => {
      await eraseLocalProfile(id);
      if (getActiveProfileId() === id) clearActiveProfile();
    });
    throw new Error('这个设定档已经在其他设备删除');
  }
  if (!local) {
    if (!remote) throw new Error('云端还没有这个设定档');
    local = {
      id,
      name: remote.name || '设定档',
      createdAt: Date.now(),
      pinHash: remote.pinHash,
      cloudUpdatedAt: 0,
    };
    await db.profiles.add(local);
  }
  await switchProfile(id, pin);
  const current = (await db.profiles.get(id)) ?? local;
  let bundle: ProfileBundle | null = null;
  try {
    bundle = await api.profileSyncGet(id);
  } catch (err) {
    if (!isNotFound(err)) throw err;
  }
  // 云端这份不比本机旧，就只用云端的。不要用当前画面的偏好把别人的档盖掉。
  if (bundle && !current.pendingPush) {
    if (bundle.updatedAt > (current.cloudUpdatedAt ?? 0)) await applyBundle(id, bundle);
    return;
  }
  await pushProfile(id);
}

export function startProfileSync(): void {
  if (typeof window === 'undefined') return;
  const state = useAppStore.getState();
  lastDevice = JSON.stringify([state.customAPIs, state.selectedKeys, state.subscriptions, state.liveSubscriptions, state.liveSelectedUrls]);
  onProfileDirty((kind) => {
    const id = getActiveProfileId();
    if (!id) return;
    void db.profiles.update(id, { pendingPush: true });
    if (kind === 'lazy') {
      if (!timer) lazyOnly = true;
      // 已经排着一次就不再推迟，保证最多 5 分钟传一次
      if (!lazyTimer) {
        lazyTimer = setTimeout(() => {
          lazyTimer = undefined;
          void reconcileProfile().catch(() => {});
        }, cadence.lazy);
      }
      return;
    }
    lazyOnly = false;
    clearTimeout(lazyTimer);
    lazyTimer = undefined;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void reconcileProfile().catch(() => {});
    }, PUSH_DEBOUNCE_MS);
  });
  useAppStore.subscribe((next) => {
    const sig = JSON.stringify([next.customAPIs, next.selectedKeys, next.subscriptions, next.liveSubscriptions, next.liveSelectedUrls]);
    if (sig === lastDevice) return;
    lastDevice = sig;
    markProfileDirty();
  });
  // 切回页面：看看别的设备有没有新东西；离开页面：把攒着的进度传上去
  const flushPending = () => {
    if (!lazyTimer) return;
    clearTimeout(lazyTimer);
    lazyTimer = undefined;
    void reconcileProfile().catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void reconcileProfile().catch(() => {});
    else flushPending();
  });
  window.addEventListener('pagehide', flushPending);
  // 页面开着时定期把别的设备新收藏、新观看记录拉下来（间隔随存储类型变化，所以用 setTimeout 接力）
  const poll = () => {
    window.setTimeout(() => {
      if (document.visibilityState === 'visible') void reconcileProfile().catch(() => {});
      poll();
    }, cadence.poll);
  };
  poll();
  void api
    .status()
    .then((s) => {
      if (s.syncStorage === 'redis' || s.syncStorage === 'file') cadence = CADENCE.redis;
    })
    .catch(() => {});
  void reconcileProfile().catch(() => {});
}
