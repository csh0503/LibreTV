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

/**
 * 「谁在看」名单在本实例内存里留 30 秒：每台设备开着页面都会定期来看名单，
 * 存储按读取次数计费。本实例写入后立刻更新缓存；别的实例最多晚 30 秒看到。
 */
const CATALOG_TTL_MS = 30_000;
let catalogCache: { at: number; profiles: CatalogEntry[] } | undefined;

async function readCatalog(): Promise<CatalogEntry[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.profiles;
  const json = await readStoredJson(PROFILE_CATALOG_KEY);
  const data = json ? (JSON.parse(json) as { profiles?: CatalogEntry[] }) : {};
  const profiles = Array.isArray(data.profiles) ? data.profiles : [];
  catalogCache = { at: Date.now(), profiles };
  return profiles;
}

async function writeCatalog(profiles: CatalogEntry[]): Promise<void> {
  await writeStoredJson(PROFILE_CATALOG_KEY, JSON.stringify({ profiles }));
  catalogCache = { at: Date.now(), profiles };
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
    // 写之前绕过缓存读最新名单，免得把别的实例刚加的档盖掉
    catalogCache = undefined;
    const profiles = (await readCatalog()).filter((item) => item.id !== body.id);
    profiles.push({
      id: body.id,
      name: (body.name || '未命名').slice(0, 20),
      pinHash: body.pinHash,
      updatedAt: body.bundle.updatedAt || Date.now(),
    });
    await writeStoredJson(profileDataKey(body.id), json);
    await writeCatalog(profiles);
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
    catalogCache = undefined;
    const profiles = (await readCatalog()).filter((item) => item.id !== id);
    await writeCatalog(profiles);
    await deleteStoredJson(profileDataKey(id));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : '同步存储不可用', 503);
  }
}
