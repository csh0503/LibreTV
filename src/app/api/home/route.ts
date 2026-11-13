import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { readHomeSnapshot } from '@/lib/home-snapshot';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/home：首页公共内容一次给齐（大图 / TOP 10 各榜、即将播出、所有货架），
 * 直接返回伺服器背景算好的快照（毫秒级；容器重启后读上一份存档）。
 * 还没有快照时返回 { ready: false }，前端各行照旧自己请求。
 */
export async function GET(req: Request) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const snap = readHomeSnapshot();
  if (!snap) return NextResponse.json({ ready: false }, { headers: { 'Cache-Control': 'no-store' } });
  return new NextResponse(snap.json, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'private, max-age=60',
      'X-Snapshot-Age': String(Math.round((Date.now() - snap.at) / 1000)),
    },
  });
}
