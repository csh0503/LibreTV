import { NextResponse } from 'next/server';
import { guardRequest, jsonError } from '@/lib/api-guard';
import {
  PROFILE_CATALOG_KEY,
  deleteStoredJson,
  profileDataKey,
  readStoredJson,
  writeStoredJson,
} from '@/lib/profile-sync-store';

export const runtime = 'nodejs';

const MAX_BYTES = 2_000_000;

interface CatalogEntry {
  id: string;
  name: string;
  pinHash?: string;
  updatedAt: number;
}

async function readCatalog(): Promise<CatalogEntry[]> {
  const json = await readStoredJson(PROFILE_CATALOG_KEY);
  if (!json) return [];
  const data = JSON.parse(json) as { profiles?: CatalogEntry[] };
  return Array.isArray(data.profiles) ? data.profiles : [];
}

/** 网站密码通过后，列出云端全部设定档。选中哪一个再拉那一份资料。 */
export async function GET(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const id = new URL(req.url).searchParams.get('id') || '';
  try {
    if (!id) {
      const profiles = await readCatalog();
      return NextResponse.json({
        profiles: profiles.map((item) => ({
          id: item.id,
          name: item.name,
          hasPin: Boolean(item.pinHash),
          pinHash: item.pinHash,
          updatedAt: item.updatedAt,
        })),
      });
    }
    const json = await readStoredJson(profileDataKey(id));
    if (!json) return jsonError('云端还没有这个设定档', 404);
    return NextResponse.json(JSON.parse(json) as unknown);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '同步存储不可用', 503);
  }
}

/** 把一个设定档整份写上云端，并更新「谁在看」列表。 */
export async function PUT(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  let body: { id?: string; name?: string; pinHash?: string; bundle?: { version?: number; updatedAt?: number } };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonError('请求格式错误', 400);
  }
  if (!body.id || !body.bundle || body.bundle.version !== 1) return jsonError('设定档格式无效', 400);
  const json = JSON.stringify(body.bundle);
  if (json.length > MAX_BYTES) return jsonError('设定档太大', 413);
  try {
    const profiles = (await readCatalog()).filter((item) => item.id !== body.id);
    profiles.push({
      id: body.id,
      name: (body.name || '未命名').slice(0, 20),
      pinHash: body.pinHash,
      updatedAt: body.bundle.updatedAt || Date.now(),
    });
    await writeStoredJson(profileDataKey(body.id), json);
    await writeStoredJson(PROFILE_CATALOG_KEY, JSON.stringify({ profiles }));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '同步存储不可用', 503);
  }
}

/** 从「谁在看」名单和云端资料里删掉一个设定档。 */
export async function DELETE(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  const id = new URL(req.url).searchParams.get('id') || '';
  if (!id) return jsonError('设定档无效', 400);
  try {
    const profiles = (await readCatalog()).filter((item) => item.id !== id);
    await writeStoredJson(PROFILE_CATALOG_KEY, JSON.stringify({ profiles }));
    await deleteStoredJson(profileDataKey(id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '同步存储不可用', 503);
  }
}
