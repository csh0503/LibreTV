import { db, type UserProfile } from './db';
import {
  getActiveProfileId,
  readStoredProfileId,
  registerProfileStarter,
  resetProfileReady,
  setProfileSnapshot,
} from './profile-session';
import { api } from './client-api';
import { createSyncSecret } from './sync-code';
import { markProfileDirty } from './profile-session';
import { useAppStore, type LiveRecentEntry } from './store';

/** 跟着设定档走的个人资料。点播源、订阅、封面代理仍是这台设备共用的。 */
export interface ProfilePrefs {
  yellowFilter: boolean;
  adFilter: boolean;
  autoplayNext: boolean;
  doubanEnabled: boolean;
  recommendSource: 'douban' | 'bangumi' | 'hot-list';
  recommendSourceTouched: boolean;
  liveFavorites: string[];
  liveRecent: LiveRecentEntry[];
}

const PREF_KEYS: (keyof ProfilePrefs)[] = [
  'yellowFilter',
  'adFilter',
  'autoplayNext',
  'doubanEnabled',
  'recommendSource',
  'recommendSourceTouched',
  'liveFavorites',
  'liveRecent',
];

function defaultPrefs(): ProfilePrefs {
  return {
    yellowFilter: true,
    adFilter: true,
    autoplayNext: true,
    doubanEnabled: true,
    recommendSource: 'hot-list',
    recommendSourceTouched: false,
    liveFavorites: [],
    liveRecent: [],
  };
}

function readPrefs(): ProfilePrefs {
  const state = useAppStore.getState();
  return {
    yellowFilter: state.yellowFilter,
    adFilter: state.adFilter,
    autoplayNext: state.autoplayNext,
    doubanEnabled: state.doubanEnabled,
    recommendSource: state.recommendSource,
    recommendSourceTouched: state.recommendSourceTouched,
    liveFavorites: state.liveFavorites,
    liveRecent: state.liveRecent,
  };
}

function applyPrefs(prefs: ProfilePrefs): void {
  useAppStore.setState(prefs);
}

function prefsOf(profile: UserProfile | undefined): ProfilePrefs | null {
  const raw = profile?.prefs;
  if (!raw || typeof raw !== 'object') return null;
  const prefs = defaultPrefs();
  for (const key of PREF_KEYS) {
    if (key in raw) (prefs as unknown as Record<string, unknown>)[key] = raw[key];
  }
  return prefs;
}

async function hashPin(profileId: string, pin: string): Promise<string> {
  const data = new TextEncoder().encode(`${profileId}:${pin}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(buf)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 把升级前没有设定档的历史、收藏、进度和搜索记录归到默认档。 */
async function migrateLegacyRows(profileId: string): Promise<void> {
  if (typeof localStorage !== 'undefined' && localStorage.getItem('libretv-profile-data-v1') === '1') return;
  await db.transaction('rw', [db.history, db.favorites, db.progress, db.searchHistory, db.savedSearches], async () => {
    const history = await db.history.toArray();
    for (const row of history) {
      if (row.profileId) continue;
      await db.history.delete(row.id);
      await db.history.put({ ...row, profileId, id: `${profileId}::${row.id}` });
    }
    const favorites = await db.favorites.toArray();
    for (const row of favorites) {
      if (row.profileId) continue;
      const localId = row.localId || row.id;
      await db.favorites.delete(row.id);
      await db.favorites.put({ ...row, localId, profileId, id: `${profileId}::${localId}` });
    }
    const progress = await db.progress.toArray();
    for (const row of progress) {
      if (row.profileId) continue;
      await db.progress.delete(row.key);
      await db.progress.put({ ...row, profileId, key: `${profileId}::${row.key}` });
    }
    const searches = await db.searchHistory.toArray();
    if (searches.length > 0) {
      await db.savedSearches.bulkPut(
        searches.map((row) => ({
          id: `${profileId}::${row.text}`,
          profileId,
          text: row.text,
          timestamp: row.timestamp,
        }))
      );
      await db.searchHistory.clear();
    }
  });
  if (typeof localStorage !== 'undefined') localStorage.setItem('libretv-profile-data-v1', '1');
}

async function savePrefs(profileId: string, prefs: ProfilePrefs): Promise<void> {
  const profile = await db.profiles.get(profileId);
  if (!profile) return;
  await db.profiles.put({ ...profile, prefs: { ...prefs } });
}

let syncing = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function startPrefsSync(): void {
  useAppStore.subscribe((state) => {
    const id = getActiveProfileId();
    if (!id || syncing) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const prefs: ProfilePrefs = {
        yellowFilter: state.yellowFilter,
        adFilter: state.adFilter,
        autoplayNext: state.autoplayNext,
        doubanEnabled: state.doubanEnabled,
        recommendSource: state.recommendSource,
        recommendSourceTouched: state.recommendSourceTouched,
        liveFavorites: state.liveFavorites,
        liveRecent: state.liveRecent,
      };
      markProfileDirty();
      void savePrefs(id, prefs);
    }, 200);
  });
}

async function initProfiles(): Promise<void> {
  const id = readStoredProfileId();
  let profile = id ? await db.profiles.get(id) : undefined;
  if (!profile) {
    const all = await db.profiles.orderBy('createdAt').toArray();
    profile = all[0];
  }
  if (!profile) {
    // 本机还没有设定档时不要立刻新建「默认」。
    // 每次换一个部署链接都是新的浏览器存储，自动新建会在云端堆出很多同名档。
    setProfileSnapshot({ id: '', name: '' });
    startPrefsSync();
    return;
  }
  if (!profile.syncSecret) {
    profile = { ...profile, syncSecret: createSyncSecret() };
    await db.profiles.put(profile);
  }
  await migrateLegacyRows(profile.id);
  setProfileSnapshot({ id: profile.id, name: profile.name });
  const prefs = prefsOf(profile);
  if (!prefs) {
    const seeded = readPrefs();
    await savePrefs(profile.id, seeded);
  } else {
    syncing = true;
    applyPrefs(prefs);
    syncing = false;
  }
  startPrefsSync();
}

let started: Promise<void> | null = null;

export function startProfiles(): Promise<void> {
  if (!started) {
    started = initProfiles().catch((err) => {
      started = null;
      resetProfileReady();
      throw err;
    });
  }
  return started;
}

registerProfileStarter(startProfiles);

export async function listProfiles(): Promise<UserProfile[]> {
  await startProfiles();
  return db.profiles.orderBy('createdAt').toArray();
}

export async function createProfile(name: string, pin?: string): Promise<void> {
  await startProfiles();
  const current = getActiveProfileId();
  if (current) await savePrefs(current, readPrefs());
  const id = crypto.randomUUID();
  const trimmed = name.trim().slice(0, 20);
  const profile: UserProfile = {
    id,
    name: trimmed || '未命名',
    createdAt: Date.now(),
    pinHash: pin ? await hashPin(id, pin) : undefined,
    syncSecret: createSyncSecret(),
    prefs: { ...defaultPrefs() },
  };
  await db.profiles.add(profile);
  syncing = true;
  setProfileSnapshot({ id, name: profile.name });
  applyPrefs(defaultPrefs());
  syncing = false;
  markProfileDirty();
}

export async function switchProfile(id: string, pin?: string): Promise<void> {
  await startProfiles();
  if (id === getActiveProfileId()) return;
  const next = await db.profiles.get(id);
  if (!next) throw new Error('设定档不存在');
  if (next.pinHash && (await hashPin(id, pin || '')) !== next.pinHash) {
    throw new Error('密码不对');
  }
  const current = getActiveProfileId();
  if (current) await savePrefs(current, readPrefs());
  syncing = true;
  setProfileSnapshot({ id: next.id, name: next.name });
  applyPrefs(prefsOf(next) ?? defaultPrefs());
  syncing = false;
}

export async function renameProfile(id: string, name: string): Promise<void> {
  const profile = await db.profiles.get(id);
  if (!profile) return;
  const trimmed = name.trim().slice(0, 20);
  if (!trimmed) return;
  await db.profiles.update(id, { name: trimmed });
  if (id === getActiveProfileId()) setProfileSnapshot({ id, name: trimmed });
}

/** 只删这台浏览器里的档，不动云端。别的设备已经删掉时用这个。 */
export async function eraseLocalProfile(id: string): Promise<void> {
  await db.transaction('rw', [db.profiles, db.history, db.favorites, db.progress, db.savedSearches, db.tastes], async () => {
    await db.profiles.delete(id);
    await db.history.where('profileId').equals(id).delete();
    await db.favorites.where('profileId').equals(id).delete();
    await db.progress.where('profileId').equals(id).delete();
    await db.savedSearches.where('profileId').equals(id).delete();
    await db.tastes.where('profileId').equals(id).delete();
  });
}

export function clearActiveProfile(): void {
  syncing = true;
  setProfileSnapshot({ id: '', name: '' });
  syncing = false;
}

export async function deleteProfile(id: string): Promise<void> {
  const all = await db.profiles.orderBy('createdAt').toArray();
  if (all.length <= 1) throw new Error('至少留一个设定档');
  try {
    await api.profileSyncDelete(id);
  } catch {
    // 云端没有这份时，仍然删本机
  }
  await eraseLocalProfile(id);
  if (id !== getActiveProfileId()) return;
  const fallback = (await db.profiles.orderBy('createdAt').toArray())[0];
  if (!fallback) {
    clearActiveProfile();
    return;
  }
  syncing = true;
  setProfileSnapshot({ id: fallback.id, name: fallback.name });
  applyPrefs(prefsOf(fallback) ?? defaultPrefs());
  syncing = false;
}
