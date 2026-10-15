import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import { readProfileBlob, writeProfileBlob } from '@/lib/profile-sync-store';
import { normalizeSyncCode } from '@/lib/sync-code';

export const runtime = 'nodejs';

const MAX_BYTES = 2_000_000;

function readCode(input: string): string | NextResponse {
  const code = normalizeSyncCode(input);
  if (code.length < 16 || code.length > 64) return jsonError('同步码无效', 400);
  return code;
}

/** 用同步码读取设定档。需要先登录这个站点。 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const parsed = readCode(new URL(req.url).searchParams.get('code') || '');
  if (parsed instanceof NextResponse) return parsed;
  try {
    const json = await readProfileBlob(parsed);
    if (!json) return jsonError('找不到这个同步码', 404);
    return NextResponse.json(JSON.parse(json) as unknown);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '同步存储不可用', 503);
  }
}

/** 把当前设定档整份写上云端。 */
export async function PUT(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  let body: { code?: string; bundle?: { version?: number } };
  try {
    body = (await req.json()) as { code?: string; bundle?: { version?: number } };
  } catch {
    return jsonError('请求格式错误', 400);
  }
  const parsed = readCode(body.code || '');
  if (parsed instanceof NextResponse) return parsed;
  if (!body.bundle || body.bundle.version !== 1) return jsonError('设定档格式无效', 400);
  const json = JSON.stringify(body.bundle);
  if (json.length > MAX_BYTES) return jsonError('设定档太大', 413);
  try {
    await writeProfileBlob(parsed, json);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '同步存储不可用', 503);
  }
}
