import fs from 'node:fs';
import path from 'node:path';

/**
 * 本地片库（SQLite，Node 22 自带的 node:sqlite，不用编译任何原生依赖）。
 * 放在资料目录（伺服器 /opt/libretv/data/catalog/ → 容器 /app/.data/catalog/），容器重启不丢。
 *
 * - works：融合好的作品（每部一行），四种排序各有预先算好的分数，片库直接按索引翻页；
 * - raw_items：各来源抓到的原始条目（重新融合时用；30 天没再见到的删掉）；
 * - source_index：26 个点播源最近更新的片子（标「已有片源」和最新集数）；
 * - kv：同步进度、首页快照等小东西。
 *
 * Vercel（只读文件系统、函数不常驻）或 Node 没有 node:sqlite 时返回 null，调用方退回现场抓取。
 */

export type CatalogChannel = 'anime' | 'movie' | 'tv' | 'show' | 'doc';
export const CATALOG_CHANNELS: CatalogChannel[] = ['anime', 'movie', 'tv', 'show', 'doc'];

/** node:sqlite 用到的那一小部分（类型自己写，免得依赖 @types/node 的版本） */
export interface SqlStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}
export interface SqlDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  close(): void;
}

/** 作品一行（写入 / 读出都用它） */
export interface WorkRow {
  id: string;
  channel: CatalogChannel;
  title: string;
  title_key: string;
  series_key: string;
  original_title: string | null;
  is_tv: number;
  year: number | null;
  first_date: string | null;
  last_date: string | null;
  area: string | null;
  genres: string | null;
  cover: string;
  backdrop: string | null;
  status: string | null;
  status_guessed: number;
  remarks: string | null;
  rating: number | null;
  ratings_json: string | null;
  votes: number;
  pop_all: number;
  pop_recent: number;
  sort_rate: number;
  sort_date: string;
  ids_json: string;
  signals_json: string;
  updated_at: number;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS works (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  title_key TEXT NOT NULL,
  series_key TEXT NOT NULL,
  original_title TEXT,
  is_tv INTEGER NOT NULL DEFAULT 0,
  year INTEGER,
  first_date TEXT,
  last_date TEXT,
  area TEXT,
  genres TEXT,
  cover TEXT NOT NULL,
  backdrop TEXT,
  status TEXT,
  status_guessed INTEGER NOT NULL DEFAULT 0,
  remarks TEXT,
  rating REAL,
  ratings_json TEXT,
  votes INTEGER NOT NULL DEFAULT 0,
  pop_all REAL NOT NULL DEFAULT 0,
  pop_recent REAL NOT NULL DEFAULT 0,
  sort_rate REAL NOT NULL DEFAULT 0,
  sort_date TEXT NOT NULL DEFAULT '',
  ids_json TEXT NOT NULL DEFAULT '{}',
  signals_json TEXT NOT NULL DEFAULT '{}',
  updated_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS works_hot ON works(channel, pop_all DESC, id);
CREATE INDEX IF NOT EXISTS works_recent ON works(channel, pop_recent DESC, id);
CREATE INDEX IF NOT EXISTS works_date ON works(channel, sort_date DESC, id);
CREATE INDEX IF NOT EXISTS works_rate ON works(channel, sort_rate DESC, id);
CREATE INDEX IF NOT EXISTS works_title_key ON works(title_key);
CREATE TABLE IF NOT EXISTS raw_items (
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  data TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (source, source_id)
);
CREATE INDEX IF NOT EXISTS raw_channel ON raw_items(channel);
CREATE TABLE IF NOT EXISTS source_index (
  source_key TEXT NOT NULL,
  vod_id TEXT NOT NULL,
  title_key TEXT NOT NULL,
  name TEXT NOT NULL,
  year INTEGER,
  remarks TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source_key, vod_id)
);
CREATE INDEX IF NOT EXISTS source_title ON source_index(title_key);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  at INTEGER NOT NULL
);
`;

let db: SqlDatabase | null | undefined;

export function catalogDbPath(): string {
  return process.env.CATALOG_DB || path.join(process.cwd(), '.data', 'catalog', 'catalog.db');
}

/** 这个部署要不要用本地片库（Vercel 上不用；CATALOG_DISABLED=1 可关） */
export function catalogEnabled(): boolean {
  if (process.env.CATALOG_DISABLED === '1') return false;
  if (process.env.VERCEL && !process.env.CATALOG_DB) return false;
  return true;
}

function loadSqlite(): { DatabaseSync: new (file: string) => SqlDatabase } | null {
  try {
    const get = (process as unknown as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    const mod = get?.call(process, 'node:sqlite') as { DatabaseSync?: new (file: string) => SqlDatabase } | undefined;
    return mod?.DatabaseSync ? { DatabaseSync: mod.DatabaseSync } : null;
  } catch {
    return null;
  }
}

/** 打开（第一次会建表）；用不了返回 null */
export function openCatalogDb(): SqlDatabase | null {
  if (db !== undefined) return db;
  if (!catalogEnabled()) return (db = null);
  const sqlite = loadSqlite();
  if (!sqlite) {
    console.warn('[catalog] 这个 Node 没有 node:sqlite，片库退回现场抓取');
    return (db = null);
  }
  try {
    const file = catalogDbPath();
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    const handle = new sqlite.DatabaseSync(file);
    handle.exec(SCHEMA);
    db = handle;
  } catch (err) {
    console.warn('[catalog] 打不开本地片库，退回现场抓取：', err instanceof Error ? err.message : err);
    db = null;
  }
  return db;
}

/** 测试用：换一个库（:memory:） */
export function useCatalogDbForTest(file: string): SqlDatabase | null {
  db?.close();
  db = undefined;
  process.env.CATALOG_DB = file;
  delete process.env.CATALOG_DISABLED;
  return openCatalogDb();
}

export function closeCatalogDb() {
  db?.close();
  db = undefined;
}

export function transaction<T>(handle: SqlDatabase, fn: () => T): T {
  handle.exec('BEGIN');
  try {
    const out = fn();
    handle.exec('COMMIT');
    return out;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

export function kvGet<T>(key: string): { value: T; at: number } | undefined {
  const handle = openCatalogDb();
  if (!handle) return undefined;
  const row = handle.prepare('SELECT v, at FROM kv WHERE k = ?').get(key);
  if (!row) return undefined;
  try {
    return { value: JSON.parse(String(row.v)) as T, at: Number(row.at) };
  } catch {
    return undefined;
  }
}

export function kvSet(key: string, value: unknown): void {
  const handle = openCatalogDb();
  if (!handle) return;
  handle.prepare('INSERT INTO kv (k, v, at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, at = excluded.at').run(
    key,
    JSON.stringify(value),
    Date.now(),
  );
}

/** 各来源的原始条目：同一来源同一编号覆盖 */
export function upsertRawItems(source: string, rows: { id: string; channel: CatalogChannel; data: unknown }[]): number {
  const handle = openCatalogDb();
  if (!handle || rows.length === 0) return 0;
  const now = Date.now();
  const stmt = handle.prepare(
    'INSERT INTO raw_items (source, source_id, channel, data, seen_at) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(source, source_id) DO UPDATE SET channel = excluded.channel, data = excluded.data, seen_at = excluded.seen_at',
  );
  transaction(handle, () => {
    for (const r of rows) stmt.run(source, r.id, r.channel, JSON.stringify(r.data), now);
  });
  return rows.length;
}

export function loadRawItems<T>(channel: CatalogChannel): T[] {
  const handle = openCatalogDb();
  if (!handle) return [];
  return handle
    .prepare('SELECT data FROM raw_items WHERE channel = ?')
    .all(channel)
    .map((r) => {
      try {
        return JSON.parse(String(r.data)) as T;
      } catch {
        return undefined;
      }
    })
    .filter((x): x is T => x !== undefined);
}

/** 很久没再见到的原始条目（来源下架了）删掉 */
export function pruneRawItems(olderThanMs: number): number {
  const handle = openCatalogDb();
  if (!handle) return 0;
  const res = handle.prepare('DELETE FROM raw_items WHERE seen_at < ?').run(Date.now() - olderThanMs);
  return Number(res.changes);
}

const WORK_COLUMNS: (keyof WorkRow)[] = [
  'id', 'channel', 'title', 'title_key', 'series_key', 'original_title', 'is_tv', 'year', 'first_date', 'last_date',
  'area', 'genres', 'cover', 'backdrop', 'status', 'status_guessed', 'remarks', 'rating', 'ratings_json', 'votes',
  'pop_all', 'pop_recent', 'sort_rate', 'sort_date', 'ids_json', 'signals_json', 'updated_at',
];

/** 整个频道换成新算好的一批（一个事务：查询那边要么看到旧的、要么看到新的） */
export function replaceChannelWorks(channel: CatalogChannel, works: WorkRow[]): void {
  const handle = openCatalogDb();
  if (!handle) return;
  const stmt = handle.prepare(
    `INSERT OR REPLACE INTO works (${WORK_COLUMNS.join(', ')}) VALUES (${WORK_COLUMNS.map(() => '?').join(', ')})`,
  );
  transaction(handle, () => {
    handle.prepare('DELETE FROM works WHERE channel = ?').run(channel);
    for (const w of works) stmt.run(...WORK_COLUMNS.map((c) => w[c] ?? null));
  });
}

export function countWorks(channel?: CatalogChannel): number {
  const handle = openCatalogDb();
  if (!handle) return 0;
  const row = channel
    ? handle.prepare('SELECT COUNT(*) AS n FROM works WHERE channel = ?').get(channel)
    : handle.prepare('SELECT COUNT(*) AS n FROM works').get();
  return Number(row?.n ?? 0);
}

/** 点播源最近更新的片子 */
export function upsertSourceIndex(
  rows: { sourceKey: string; vodId: string; titleKey: string; name: string; year?: number; remarks?: string }[],
): void {
  const handle = openCatalogDb();
  if (!handle || rows.length === 0) return;
  const now = Date.now();
  const stmt = handle.prepare(
    'INSERT INTO source_index (source_key, vod_id, title_key, name, year, remarks, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
      'ON CONFLICT(source_key, vod_id) DO UPDATE SET title_key = excluded.title_key, name = excluded.name, year = excluded.year, remarks = excluded.remarks, updated_at = excluded.updated_at',
  );
  transaction(handle, () => {
    for (const r of rows) stmt.run(r.sourceKey, r.vodId, r.titleKey, r.name, r.year ?? null, r.remarks ?? null, now);
  });
}

/** 一批片名（规范化后）在点播源里的收录情况：几个源有、最新的更新说明 */
export function sourceAvailability(titleKeys: string[]): Map<string, { sources: number; remarks?: string; year?: number }> {
  const out = new Map<string, { sources: number; remarks?: string; year?: number }>();
  const handle = openCatalogDb();
  const keys = [...new Set(titleKeys.filter(Boolean))];
  if (!handle || keys.length === 0) return out;
  for (let i = 0; i < keys.length; i += 400) {
    const chunk = keys.slice(i, i + 400);
    const rows = handle
      .prepare(
        `SELECT title_key, COUNT(DISTINCT source_key) AS n, MAX(updated_at) AS at, MAX(year) AS year,
                (SELECT remarks FROM source_index s2 WHERE s2.title_key = s1.title_key ORDER BY updated_at DESC LIMIT 1) AS remarks
         FROM source_index s1 WHERE title_key IN (${chunk.map(() => '?').join(',')}) GROUP BY title_key`,
      )
      .all(...chunk);
    for (const r of rows) {
      out.set(String(r.title_key), {
        sources: Number(r.n),
        remarks: r.remarks ? String(r.remarks) : undefined,
        year: r.year == null ? undefined : Number(r.year),
      });
    }
  }
  return out;
}

export function pruneSourceIndex(olderThanMs: number): void {
  openCatalogDb()?.prepare('DELETE FROM source_index WHERE updated_at < ?').run(Date.now() - olderThanMs);
}
