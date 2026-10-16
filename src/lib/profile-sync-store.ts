import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { del, get, put } from '@vercel/blob';
import { unlink } from 'fs/promises';


/**
 * 设定档云端副本。优先用 Redis（Upstash / 旧版 Vercel KV，免费额度每月约 50 万次命令），
 * 其次 Vercel Blob（免费额度每月约 1 万次读、2 千次写），本地开发两样都没有时写到 .data；
 * Vercel 上一样都没接则明确报错。
 *
 * 从 Blob 换到 Redis：两个都接着时，Redis 里没有的键会回头到 Blob 读一次并搬进 Redis，
 * 读到「谁在看」名单时顺带把名单上每个设定档都搬过去；之后只读写 Redis，Blob 不再被访问。
 */

function assertProfileId(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('设定档无效');
  return id;
}

/**
 * Vercel 市场的 Upstash 集成默认给 KV_REST_API_URL / KV_REST_API_TOKEN（连接时填了前缀就是 前缀_KV_REST_API_*），
 * 直接在 Upstash 建的库是 UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN。都认。
 */
function redisConfig(): { url: string; token: string } | null {
  const env = process.env;
  const direct = env.KV_REST_API_URL && env.KV_REST_API_TOKEN
    ? { url: env.KV_REST_API_URL, token: env.KV_REST_API_TOKEN }
    : env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN
      ? { url: env.UPSTASH_REDIS_REST_URL, token: env.UPSTASH_REDIS_REST_TOKEN }
      : null;
  if (direct) return direct;
  // 连接时自定义了前缀：前缀_KV_REST_API_URL，或前缀直接替换了 KV（前缀_REST_API_URL，值指向 upstash.io）
  for (const [name, url] of Object.entries(env)) {
    if (!url || !name.endsWith('_REST_API_URL')) continue;
    if (!name.endsWith('_KV_REST_API_URL') && !/upstash\.io/.test(url)) continue;
    const token = env[name.replace(/_URL$/, '_TOKEN')];
    if (token) return { url, token };
  }
  return null;
}

function hasBlob(): boolean {
  // 新的 Blob 连接默认只下发 BLOB_STORE_ID，函数里用 OIDC 读写，不必再勾长期令牌。
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}

export type SyncStorage = 'redis' | 'blob' | 'file' | 'none';

/** 当前实际在用的存储（给 /api/status 显示，方便确认切换成功） */
export function syncStorageKind(): SyncStorage {
  if (redisConfig()) return 'redis';
  if (hasBlob()) return 'blob';
  return process.env.VERCEL ? 'none' : 'file';
}

function backend(): 'redis' | 'blob' | 'file' {
  const kind = syncStorageKind();
  if (kind === 'none') {
    throw new Error('要在 Vercel 项目里连接 Upstash Redis（或 Blob）存储，换手机才能同步设定档。接好后重新部署一次。');
  }
  return kind;
}

async function redisCommand(command: unknown[]): Promise<unknown> {
  const cfg = redisConfig()!;
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`Redis 请求失败 (${res.status})`);
  const data = (await res.json()) as { result?: unknown; error?: string };
  if (data.error) throw new Error(`Redis 请求失败：${data.error}`);
  return data.result;
}

const redisKey = (key: string) => `profile:${key}`;
const blobPath = (key: string) => `profile-sync/${key}`;

function filePath(key: string): string {
  return path.join(process.cwd(), '.data', 'profile-sync', key);
}

async function readBlob(key: string): Promise<string | null> {
  const result = await get(blobPath(key), { access: 'private', useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) return null;
  return new Response(result.stream).text();
}

/** Redis 里没有、Blob 里有：搬一份进 Redis。搬家失败不影响这次读取。 */
async function migrateFromBlob(key: string): Promise<string | null> {
  if (!hasBlob()) return null;
  let json: string | null = null;
  try {
    json = await readBlob(key);
  } catch {
    return null;
  }
  if (json === null) return null;
  try {
    await redisCommand(['SET', redisKey(key), json]);
  } catch {
    // 下次读到再搬
  }
  if (key === PROFILE_CATALOG_KEY) await migrateListedProfiles(json);
  return json;
}

/** 名单搬过来时，把名单上每个设定档的资料也一起搬，免得以后断开 Blob 时有漏网的 */
async function migrateListedProfiles(catalogJson: string): Promise<void> {
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(catalogJson) as { profiles?: { id?: string }[] };
    ids = (parsed.profiles ?? []).map((p) => p.id ?? '').filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  } catch {
    return;
  }
  for (const id of ids) {
    const key = profileDataKey(id);
    try {
      const exists = await redisCommand(['EXISTS', redisKey(key)]);
      if (exists === 1) continue;
      const json = await readBlob(key);
      if (json !== null) await redisCommand(['SET', redisKey(key), json]);
    } catch {
      // 单个失败不挡其他；读到这个设定档时还会再搬
    }
  }
}

export async function readStoredJson(key: string): Promise<string | null> {
  const kind = backend();
  if (kind === 'redis') {
    const result = await redisCommand(['GET', redisKey(key)]);
    if (typeof result === 'string') return result;
    return migrateFromBlob(key);
  }
  if (kind === 'blob') return readBlob(key);
  try {
    return await readFile(filePath(key), 'utf8');
  } catch {
    return null;
  }
}

export async function writeStoredJson(key: string, json: string): Promise<void> {
  const kind = backend();
  if (kind === 'redis') {
    await redisCommand(['SET', redisKey(key), json]);
    return;
  }
  if (kind === 'blob') {
    await put(blobPath(key), json, {
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/json',
    });
    return;
  }
  const target = filePath(key);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, json, 'utf8');
}

export async function deleteStoredJson(key: string): Promise<void> {
  const kind = backend();
  if (kind === 'redis') {
    await redisCommand(['DEL', redisKey(key)]);
    // Blob 里的旧副本也删掉，否则搬家逻辑可能把删掉的设定档又读回来
    if (hasBlob()) {
      try {
        await del(blobPath(key));
      } catch {
        // 本来就没有
      }
    }
    return;
  }
  if (kind === 'blob') {
    try {
      await del(blobPath(key));
    } catch {
      // 本来就没有这份资料时，删名单即可
    }
    return;
  }
  try {
    await unlink(filePath(key));
  } catch {
    // 本地文件不存在
  }
}

export function profileDataKey(id: string): string {
  return `profiles/${assertProfileId(id)}.json`;
}

export const PROFILE_CATALOG_KEY = 'catalog.json';
