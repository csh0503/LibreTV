import { createHash } from 'crypto';
import { mkdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { get, put } from '@vercel/blob';
import { normalizeSyncCode } from './sync-code';

/**
 * 设定档云端副本。优先用 Vercel KV 或 Blob（换设备才不会丢），
 * 本地开发没有这两样时写到 .data，Vercel 上没接存储则明确报错。
 */

function blobKey(code: string): string {
  const normalized = normalizeSyncCode(code);
  return createHash('sha256').update(normalized).digest('hex');
}

function backend(): 'kv' | 'blob' | 'file' {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) return 'kv';
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'blob';
  if (process.env.VERCEL) {
    throw new Error('要在 Vercel 项目里连接 KV 或 Blob 存储，换手机才能同步设定档。接好后重新部署一次。');
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

function filePath(hash: string): string {
  return path.join(process.cwd(), '.data', 'profile-sync', `${hash}.json`);
}

export async function readProfileBlob(code: string): Promise<string | null> {
  const hash = blobKey(code);
  const kind = backend();
  if (kind === 'kv') {
    const result = await kvCommand(['GET', `profile:${hash}`]);
    return typeof result === 'string' ? result : null;
  }
  if (kind === 'blob') {
    const result = await get(`profile-sync/${hash}.json`, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200 || !result.stream) return null;
    return new Response(result.stream).text();
  }
  try {
    return await readFile(filePath(hash), 'utf8');
  } catch {
    return null;
  }
}

export async function writeProfileBlob(code: string, json: string): Promise<void> {
  const hash = blobKey(code);
  const kind = backend();
  if (kind === 'kv') {
    await kvCommand(['SET', `profile:${hash}`, json]);
    return;
  }
  if (kind === 'blob') {
    await put(`profile-sync/${hash}.json`, json, {
      access: 'private',
      allowOverwrite: true,
      contentType: 'application/json',
    });
    return;
  }
  const target = filePath(hash);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, json, 'utf8');
}
