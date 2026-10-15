import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { get, put } from '@vercel/blob';


/**
 * 设定档云端副本。优先用 Vercel KV 或 Blob（换设备才不会丢），
 * 本地开发没有这两样时写到 .data，Vercel 上没接存储则明确报错。
 */

function assertProfileId(id: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('设定档无效');
  return id;
}

function backend(): 'kv' | 'blob' | 'file' {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) return 'kv';
  // 新的 Blob 连接默认只下发 BLOB_STORE_ID，函数里用 OIDC 读写，不必再勾长期令牌。
  if (process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID) return 'blob';
  if (process.env.VERCEL) {
    throw new Error('要在 Vercel 项目里连接 Blob 存储，换手机才能同步设定档。接好后重新部署一次。');
  }
  return 'file';
}

async function kvCommand(command: unknown[]): Promise<unknown> {
  const res = await fetch(process.env.KV_REST_API_URL!, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.KV_REST_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(command),
  });
  if (!res.ok) throw new Error(`KV 请求失败 (${res.status})`);
  const data = (await res.json()) as { result?: unknown };
  return data.result;
}

function filePath(key: string): string {
  return path.join(process.cwd(), '.data', 'profile-sync', key);
}

export async function readStoredJson(key: string): Promise<string | null> {
  const kind = backend();
  if (kind === 'kv') {
    const result = await kvCommand(['GET', `profile:${key}`]);
    return typeof result === 'string' ? result : null;
  }
  if (kind === 'blob') {
    const result = await get(`profile-sync/${key}`, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return new Response(result.stream).text();
  }
  try {
    return await readFile(filePath(key), 'utf8');
  } catch {
    return null;
  }
}

export async function writeStoredJson(key: string, json: string): Promise<void> {
  const kind = backend();
  if (kind === 'kv') {
    await kvCommand(['SET', `profile:${key}`, json]);
    return;
  }
  if (kind === 'blob') {
    await put(`profile-sync/${key}`, json, {
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

export function profileDataKey(id: string): string {
  return `profiles/${assertProfileId(id)}.json`;
}

export const PROFILE_CATALOG_KEY = 'catalog.json';
