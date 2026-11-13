import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { CATALOG_CHANNELS, countWorks, openCatalogDb, type CatalogChannel } from '@/lib/catalog-db';
import { queryCatalog } from '@/lib/catalog-query';
import type { CatalogSort } from '@/lib/catalog-rank';
import { catalogSyncStatus } from '@/lib/catalog-sync';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SORTS: CatalogSort[] = ['hot', 'recent', 'date', 'rate'];

/**
 * GET /api/catalog?channel=anime&sort=hot&genre=&area=&year=&status=&score=&cursor=&limit=
 * 本地片库（SQLite）分页查询。片库还没建好 / 这个部署没有本地片库时返回 { ready: false }，前端退回现场抓取。
 * GET /api/catalog?sync=1：同步状态（各频道作品数、上次全量 / 增量时间）。
 */
export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const sp = new URL(req.url).searchParams;
  if (!openCatalogDb()) return NextResponse.json({ ready: false });
  if (sp.get('sync') === '1') return NextResponse.json({ ready: true, ...catalogSyncStatus() });

  const channel = sp.get('channel') as CatalogChannel | null;
  if (!channel || !CATALOG_CHANNELS.includes(channel)) return NextResponse.json({ error: '频道无效' }, { status: 400 });
  if (countWorks(channel) === 0) return NextResponse.json({ ready: false });
  const sort = (SORTS as string[]).includes(sp.get('sort') ?? '') ? (sp.get('sort') as CatalogSort) : 'hot';
  const score = parseFloat(sp.get('score') ?? '');
  const statusParam = sp.get('status');
  const text = (k: string) => {
    const v = (sp.get(k) ?? '').trim();
    return /^[一-龥A-Za-z0-9-]{0,20}$/.test(v) ? v : '';
  };
  const t = Date.now();
  const page = queryCatalog({
    channel,
    sort,
    dir: sp.get('dir') === 'asc' ? 'asc' : 'desc',
    genre: text('genre') || undefined,
    area: text('area') || undefined,
    year: text('year') || undefined,
    status: statusParam === 'airing' || statusParam === 'ended' ? statusParam : 'all',
    minScore: Number.isFinite(score) && score > 0 ? score : null,
    cursor: sp.get('cursor'),
    limit: parseInt(sp.get('limit') ?? '30', 10) || 30,
  });
  if (!page) return NextResponse.json({ ready: false });
  return NextResponse.json(
    { ready: true, ...page, ms: Date.now() - t },
    { headers: { 'Cache-Control': 'private, max-age=60' } },
  );
}
