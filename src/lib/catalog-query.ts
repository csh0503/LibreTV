import { openCatalogDb, sourceAvailability, type CatalogChannel, type WorkRow } from './catalog-db';
import { SORT_COLUMN, decodeCursor, encodeCursor, type CatalogSort } from './catalog-rank';
import { workRowToItem } from './catalog-build';
import { yearSelection } from './recommend';
import type { DoubanItem } from './types';

/**
 * 片库查询（本地 SQLite）：频道 + 题材 / 地区 / 年份 / 状态 / 评分筛选，四种排序，
 * 按（排序值, 作品编号）游标翻页——顺序固定，往后接不重不漏，前面已经出来的卡片不会动。
 */

export interface CatalogQuery {
  channel: CatalogChannel;
  sort: CatalogSort;
  dir?: 'asc' | 'desc';
  genre?: string;
  area?: string;
  year?: string;
  status?: 'all' | 'airing' | 'ended';
  minScore?: number | null;
  cursor?: string | null;
  limit?: number;
}

export type CatalogItem = DoubanItem & { workId: string; available?: number };

export interface CatalogPage {
  items: CatalogItem[];
  nextCursor: string | null;
  /** 第一页才给：符合筛选的总数 */
  total?: number;
}

/** 题材芯片 → 库里题材可能的写法（catalog-meta 统一过题材，这里补几个口语叫法） */
const GENRE_SYNONYMS: Record<string, string[]> = {
  热血: ['热血', '战斗', '动作'],
  机战: ['机甲', '机战'],
  恋爱: ['恋爱', '爱情'],
  搞笑: ['搞笑', '喜剧'],
  催泪: ['催泪', '治愈'],
  日常: ['日常', '治愈'],
  战斗: ['战斗', '动作'],
  悬疑: ['悬疑', '推理'],
  古装: ['古装', '历史'],
  都市: ['都市', '剧情'],
};

/** 地区芯片 → 库里地区可能的写法（地区已统一成「中国大陆 / 中国香港 / 美国」） */
const AREA_SYNONYMS: Record<string, string[]> = {
  华语: ['中国', '华语', '大陆', '香港', '台湾'],
  欧美: ['美国', '英国', '法国', '德国', '意大利', '西班牙', '加拿大', '澳大利亚', '瑞典', '丹麦', '爱尔兰', '俄罗斯', '欧美'],
  中国大陆: ['中国大陆', '大陆'],
  中国香港: ['中国香港', '香港'],
  中国台湾: ['中国台湾', '台湾'],
};

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const LIKE = "LIKE ? ESCAPE '\\'";

export function buildWhere(q: CatalogQuery): { sql: string; params: unknown[] } {
  const where: string[] = ['channel = ?'];
  const params: unknown[] = [q.channel];
  if (q.genre && q.genre !== '全部') {
    const words = GENRE_SYNONYMS[q.genre] ?? [q.genre];
    where.push(`(${words.map(() => `genres ${LIKE}`).join(' OR ')})`);
    params.push(...words.map((w) => `%${escapeLike(w)}%`));
  }
  if (q.area && q.area !== '全部') {
    const words = AREA_SYNONYMS[q.area] ?? [q.area];
    where.push(`(${words.map(() => `area ${LIKE}`).join(' OR ')})`);
    params.push(...words.map((w) => `%${escapeLike(w)}%`));
  }
  if (q.year && q.year !== '全部') {
    const range = yearSelection(q.year).range;
    if (range) {
      where.push('year BETWEEN ? AND ?');
      params.push(range[0], range[1]);
    }
  }
  if (q.status === 'airing' || q.status === 'ended') {
    where.push('status = ?');
    params.push(q.status);
  }
  if (q.minScore) {
    where.push('rating >= ?');
    params.push(q.minScore);
  }
  // 「最新」「评分」：没有日期 / 没有评分的不参加（不然升序时它们全挤在最前面）
  if (q.sort === 'date') where.push("sort_date <> ''");
  if (q.sort === 'rate') where.push('sort_rate > 0');
  return { sql: where.join(' AND '), params };
}

export function queryCatalog(q: CatalogQuery): CatalogPage | null {
  const db = openCatalogDb();
  if (!db) return null;
  const col = SORT_COLUMN[q.sort];
  const desc = (q.dir ?? 'desc') === 'desc';
  const limit = Math.min(60, Math.max(1, q.limit ?? 30));
  const base = buildWhere(q);
  const where = [base.sql];
  const params = [...base.params];
  const cursor = decodeCursor(q.cursor);
  if (cursor) {
    // 降序：排序值更小，或排序值相同、编号更大；升序反过来。编号永远升序，保证全序
    where.push(`(${col} ${desc ? '<' : '>'} ? OR (${col} = ? AND id > ?))`);
    params.push(cursor.v, cursor.v, cursor.id);
  }
  const rows = db
    .prepare(`SELECT * FROM works WHERE ${where.join(' AND ')} ORDER BY ${col} ${desc ? 'DESC' : 'ASC'}, id ASC LIMIT ?`)
    .all(...params, limit + 1) as unknown as WorkRow[];
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const avail = sourceAvailability(page.map((r) => r.title_key));
  const last = page[page.length - 1];
  const out: CatalogPage = {
    items: page.map((r) => workRowToItem(r, avail.get(r.title_key))),
    nextCursor: hasMore && last ? encodeCursor({ v: last[col] as number | string, id: last.id }) : null,
  };
  if (!cursor) {
    const total = db.prepare(`SELECT COUNT(*) AS n FROM works WHERE ${base.sql}`).get(...base.params);
    out.total = Number(total?.n ?? 0);
  }
  return out;
}

/** 首页 / 别处用：某个频道按某种排序取前 N 部（不分页） */
export function topWorks(channel: CatalogChannel, sort: CatalogSort, limit: number, extra: Partial<CatalogQuery> = {}): CatalogItem[] {
  return queryCatalog({ channel, sort, limit, ...extra })?.items ?? [];
}
