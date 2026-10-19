import { NextResponse } from 'next/server';
import { guardRequest } from '@/lib/api-guard';
import { lookupSchedule, type ScheduleQuery } from '@/lib/airing-schedule';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** 追剧日历：POST { titles: [{ title, year? }] } → 21 天内要出新一集的（见 airing-schedule） */
export async function POST(req: Request) {
  const guarded = guardRequest(req);
  if (guarded) return guarded;
  let body: { titles?: unknown };
  try {
    body = (await req.json()) as { titles?: unknown };
  } catch {
    return NextResponse.json({ error: '请求格式不对' }, { status: 400 });
  }
  const titles: ScheduleQuery[] = (Array.isArray(body.titles) ? body.titles : [])
    .map((t) => (t && typeof t === 'object' ? (t as Record<string, unknown>) : {}))
    .filter((t) => typeof t.title === 'string')
    .map((t) => ({
      title: String(t.title).slice(0, 100),
      year: typeof t.year === 'string' && /^\d{4}$/.test(t.year) ? t.year : undefined,
    }));
  const entries = await lookupSchedule(titles);
  return NextResponse.json({ entries }, { headers: { 'Cache-Control': 'private, max-age=1800' } });
}
