import Dexie, { type EntityTable } from 'dexie';
import type { SourceConfig } from './types';
import { normalizeTitle } from './cms-parser';
// 仅类型引入：store.ts 运行时会引用本模块，反向只取类型不会形成运行时循环
import type { LiveProbeEntry } from './store';
import { PERSIST_KEY, flushPendingPersist } from './persist-storage';
import { getActiveProfileId, whenProfileReady } from './profile-session';

/**
 * IndexedDB 持久化（替代旧版 localStorage 数据库）：
 * - 观看历史不再冗余存储全集 URL 列表（旧版长剧 × 50 条极易撑爆 5MB 配额），
 *   只存定位信息（sourceKey+vodId+index），进入播放页时按需重新拉详情，
 *   顺带免费获得「剧集更新同步」能力。
 * - v2：直播测活缓存从 localStorage（随 zustand persist 整体重写）迁入独立表，
 *   高频写入不再拖累设置快照的序列化。
 */

export interface HistoryEntry {
  /** 主键：`${profileId}::${sourceKey}_${vodId}` */
  id: string;
  profileId: string;
  sourceKey: string;
  sourceUrl?: string;
  vodId: string;
  title: string;
  pic?: string;
  episodeIndex: number;
  totalEpisodes: number;
  playbackPosition: number;
  duration: number;
  timestamp: number;
}

export interface ProgressEntry {
  key: string; // `${profileId}::${sourceKey}_${vodId}_${episodeIndex}`
  profileId: string;
  position: number;
  duration: number;
  updatedAt: number;
}

export interface SearchHistoryEntry {
  /** `${profileId}::${text}` */
  id: string;
  profileId: string;
  text: string;
  timestamp: number;
}

export interface SegmentMetaEntry {
  /** Cache Storage 中的 key（归一化的分片绝对地址，或同源代理地址） */
  key: string;
  /** 所属剧集：`${source}:${vodId}:${episodeIndex}`，用于按集淘汰 */
  episodeKey: string;
  /** 片段序号（1 基，便于排查） */
  index: number;
  bytes: number;
  /** 预取时记录的真实耗时（毫秒），loader 命中缓存时合成进 hls.js stats 防 ABR 误判 */
  costMs: number;
  lastAccess: number;
}

export type DownloadStatus = 'waiting' | 'downloading' | 'paused' | 'completed' | 'error';

export interface DownloadTaskEntry {
  id: string;
  /** 播放页 m3u8 地址（直连或代理形式，入队时的原样） */
  url: string;
  title: string;
  /** 输出格式 */
  format: 'TS' | 'MP4';
  status: DownloadStatus;
  finished: number;
  total: number;
  errorNum: number;
  createdAt: number;
  updatedAt: number;
}

/** 本机设定档。个人资料在 prefs 里，换档时整份换上。 */
export interface UserProfile {
  id: string;
  name: string;
  pinHash?: string;
  createdAt: number;
  prefs?: Record<string, unknown>;
}

/** 点播收藏。有源和影片 id 时按它们做主键，推荐卡片只有片名时按标题。 */
export interface FavoriteEntry {
  /** `${profileId}::` + 片源或标题主键 */
  id: string;
  profileId: string;
  /** 不含设定档前缀，收藏按钮用它判断是不是同一部 */
  localId: string;
  title: string;
  pic?: string;
  sourceKey?: string;
  sourceUrl?: string;
  vodId?: string;
  year?: string;
  isAdult?: boolean;
  addedAt: number;
}

/** 界面上收藏一部片子时要带的字段，主键由当前设定档补上 */
export type FavoriteDraft = Omit<FavoriteEntry, 'addedAt' | 'id' | 'profileId'>;

export const db = new Dexie('libretv') as Dexie & {
  history: EntityTable<HistoryEntry, 'id'>;
  progress: EntityTable<ProgressEntry, 'key'>;
  searchHistory: EntityTable<{ text: string; timestamp: number }, 'text'>;
  savedSearches: EntityTable<SearchHistoryEntry, 'id'>;
  liveProbe: EntityTable<LiveProbeEntry & { url: string }, 'url'>;
  segmentMeta: EntityTable<SegmentMetaEntry, 'key'>;
  downloads: EntityTable<DownloadTaskEntry, 'id'>;
  favorites: EntityTable<FavoriteEntry, 'id'>;
  profiles: EntityTable<UserProfile, 'id'>;
};

db.version(1).stores({
  history: 'id, timestamp',
  progress: 'key, updatedAt',
  searchHistory: 'text, timestamp',
});

// v2 仅新增表；Dexie 会自动继承低版本的表结构
db.version(2).stores({
  liveProbe: 'url',
});

// v3：视频片段缓存元数据（Cache Storage 存字节、这里存 LRU 索引）与离线下载任务
db.version(3).stores({
  segmentMeta: 'key, episodeKey, lastAccess',
  downloads: 'id, createdAt',
});

db.version(4).stores({
  favorites: 'id, addedAt',
});

// v5：设定档。历史/收藏/进度的主键仍是字符串，只加 profileId 索引；搜索记录改存 savedSearches。
db.version(5).stores({
  profiles: 'id, createdAt',
  history: 'id, profileId, timestamp',
  favorites: 'id, profileId, addedAt',
  progress: 'key, profileId, updatedAt',
  savedSearches: 'id, profileId, timestamp',
});

async function profileId(): Promise<string> {
  await whenProfileReady();
  const id = getActiveProfileId();
  if (!id) throw new Error('没有当前设定档');
  return id;
}

export const MAX_FAVORITES = 300;

export function favoriteIdOf(input: { sourceKey?: string; vodId?: string; title: string }): string {
  if (input.sourceKey && input.vodId) return `${input.sourceKey}_${input.vodId}`;
  return `t_${normalizeTitle(input.title) || 'untitled'}`;
}

/** 已收藏则取消，返回收藏后的状态。只动当前设定档。 */
export async function toggleFavorite(entry: FavoriteDraft): Promise<boolean> {
  const pid = await profileId();
  const id = `${pid}::${entry.localId}`;
  const existing = await db.favorites.get(id);
  if (existing) {
    await db.favorites.delete(id);
    return false;
  }
  await db.favorites.put({ ...entry, id, profileId: pid, localId: entry.localId, addedAt: Date.now() });
  const mine = await db.favorites.where('profileId').equals(pid).sortBy('addedAt');
  if (mine.length > MAX_FAVORITES) {
    await db.favorites.bulkDelete(mine.slice(0, mine.length - MAX_FAVORITES).map((row) => row.id));
  }
  return true;
}

export const MAX_HISTORY = 100;
export const MAX_SEARCH_HISTORY = 10;

export async function upsertHistory(entry: Omit<HistoryEntry, 'id' | 'profileId'>): Promise<void> {
  const pid = await profileId();
  const id = `${pid}::${entry.sourceKey}_${entry.vodId}`;
  const existing = await db.history.get(id);
  const merged: HistoryEntry = {
    ...existing,
    ...entry,
    id,
    profileId: pid,
    playbackPosition: entry.playbackPosition > 10 ? entry.playbackPosition : existing?.playbackPosition ?? 0,
    duration: entry.duration || existing?.duration || 0,
    timestamp: Date.now(),
  };
  await db.history.put(merged);
  const mine = await db.history.where('profileId').equals(pid).sortBy('timestamp');
  if (mine.length > MAX_HISTORY) {
    await db.history.bulkDelete(mine.slice(0, mine.length - MAX_HISTORY).map((row) => row.id));
  }
}

export async function updateHistoryProgress(
  sourceKey: string,
  vodId: string,
  position: number,
  duration: number
): Promise<void> {
  const pid = await profileId();
  const id = `${pid}::${sourceKey}_${vodId}`;
  const existing = await db.history.get(id);
  if (!existing) return;
  if (Math.abs(existing.playbackPosition - position) < 2 && Math.abs(existing.duration - duration) < 2) return;
  await db.history.update(id, {
    playbackPosition: position,
    duration,
    timestamp: Date.now(),
  });
}

export async function removeHistory(sourceKey: string, vodId: string): Promise<void> {
  const pid = await profileId();
  await db.history.delete(`${pid}::${sourceKey}_${vodId}`);
}

export async function clearAllHistory(): Promise<void> {
  const pid = await profileId();
  const [history, progress] = await Promise.all([
    db.history.where('profileId').equals(pid).primaryKeys(),
    db.progress.where('profileId').equals(pid).primaryKeys(),
  ]);
  await Promise.all([db.history.bulkDelete(history), db.progress.bulkDelete(progress)]);
}

export function progressKeyOf(sourceKey: string, vodId: string, episodeIndex: number): string {
  return `${getActiveProfileId()}::${sourceKey}_${vodId}_${episodeIndex}`;
}

export async function saveProgress(sourceKey: string, vodId: string, episodeIndex: number, position: number, duration: number): Promise<void> {
  if (!duration || position < 1) return;
  const pid = await profileId();
  await db.progress.put({
    key: `${pid}::${sourceKey}_${vodId}_${episodeIndex}`,
    profileId: pid,
    position,
    duration,
    updatedAt: Date.now(),
  });
}

export async function clearProgress(sourceKey: string, vodId: string, episodeIndex: number): Promise<void> {
  const pid = await profileId();
  await db.progress.delete(`${pid}::${sourceKey}_${vodId}_${episodeIndex}`);
}

export async function listSearchHistory(): Promise<SearchHistoryEntry[]> {
  const pid = await profileId();
  const rows = await db.savedSearches.where('profileId').equals(pid).sortBy('timestamp');
  return rows.reverse().slice(0, MAX_SEARCH_HISTORY);
}

export async function addSearchHistory(text: string): Promise<void> {
  const t = text.trim().slice(0, 50);
  if (!t) return;
  const pid = await profileId();
  await db.savedSearches.put({ id: `${pid}::${t}`, profileId: pid, text: t, timestamp: Date.now() });
  const mine = await db.savedSearches.where('profileId').equals(pid).sortBy('timestamp');
  if (mine.length > MAX_SEARCH_HISTORY) {
    await db.savedSearches.bulkDelete(mine.slice(0, mine.length - MAX_SEARCH_HISTORY).map((row) => row.id));
  }
}

export async function removeSearchHistory(text: string): Promise<void> {
  const pid = await profileId();
  await db.savedSearches.delete(`${pid}::${text}`);
}

export async function clearSearchHistory(): Promise<void> {
  const pid = await profileId();
  const keys = await db.savedSearches.where('profileId').equals(pid).primaryKeys();
  await db.savedSearches.bulkDelete(keys);
}

/** 撤销「清空搜索记录」：按原时间戳回填，保持原有顺序 */
export async function restoreSearchHistory(entries: SearchHistoryEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const pid = await profileId();
  await db.savedSearches.bulkPut(entries.map((entry) => ({ ...entry, profileId: pid, id: `${pid}::${entry.text}` })));
}

// —— 直播测活缓存（TTL 过滤由调用方负责，本层只管存取） ——

export async function loadLiveProbeResults(): Promise<Record<string, LiveProbeEntry>> {
  const rows = await db.liveProbe.toArray();
  const out: Record<string, LiveProbeEntry> = {};
  for (const r of rows) out[r.url] = r;
  return out;
}

export async function saveLiveProbeResults(entries: Record<string, LiveProbeEntry>): Promise<void> {
  const rows = Object.entries(entries).map(([url, e]) => ({ ...e, url }));
  if (rows.length > 0) await db.liveProbe.bulkPut(rows);
}

export async function clearLiveProbeResultsDb(): Promise<void> {
  await db.liveProbe.clear();
}

// —— 配置导入导出（兼容旧版 LibreTV-Settings JSON 结构的导出格式） ——

export async function exportConfig(): Promise<string> {
  // 导出前 flush：把节流缓冲中的最新设置落盘，避免导出的是 800ms 前的旧快照
  flushPendingPersist();
  const history = await db.history.toArray();
  const settings = localStorage.getItem(PERSIST_KEY);

  const data: Record<string, unknown> = {
    viewingHistory: JSON.stringify(history),
  };
  if (settings) data[PERSIST_KEY] = settings;

  return JSON.stringify({
    name: 'LibreTV-Settings',
    time: Date.now().toString(),
    cfgVer: '2.0.0',
    data,
  });
}

export async function importConfig(content: string): Promise<void> {
  const config = JSON.parse(content) as {
    name?: string;
    data?: Record<string, string>;
  };
  if (config.name !== 'LibreTV-Settings') throw new Error('配置文件格式不正确');
  const data = config.data || {};

  if (typeof data[PERSIST_KEY] === 'string') {
    // 关键：先 flush 节流缓冲中的旧状态再写导入配置，否则缓冲会在
    // 之后 flush 时用导入前的旧状态覆盖刚写入的配置（导入静默丢失）
    flushPendingPersist();
    localStorage.setItem(PERSIST_KEY, data[PERSIST_KEY]);
  }

  if (typeof data['viewingHistory'] === 'string') {
    // 兼容旧版历史结构（含全集 URL 列表），只迁移定位信息
    const legacy = JSON.parse(data['viewingHistory']) as Record<string, unknown>[];
    for (const item of legacy.slice(0, MAX_HISTORY)) {
      const sourceKey = String(item.sourceCode || item.sourceName || '');
      const vodId = String(item.vod_id || '');
      const title = String(item.title || '未知视频');
      if (!sourceKey || !vodId) continue;
      const totalEpisodes = Array.isArray(item.episodes) ? item.episodes.length : 0;
      await upsertHistory({
        sourceKey,
        vodId,
        title,
        episodeIndex: typeof item.episodeIndex === 'number' ? item.episodeIndex : 0,
        totalEpisodes,
        playbackPosition: typeof item.playbackPosition === 'number' ? item.playbackPosition : 0,
        duration: typeof item.duration === 'number' ? item.duration : 0,
        timestamp: typeof item.timestamp === 'number' ? item.timestamp : Date.now(),
      });
    }
  }
}

export type { SourceConfig };
