/**
 * 「我的片单」更新提醒：片单里的剧出了新一集、原来没有片源的上线了，就在首页卡片上打角标。
 *
 * 只存在这台设备的 localStorage（按设定档分开）：每次打开首页都会变的东西不写进设定档，
 * 否则会触发云端同步（存储按请求次数计费）。
 * - base：你上次看到时的样子（集数 / 有没有片源）；第一次查到时就当作已看过，不打角标。
 * - now：最近一次查到的样子 + 时间（没绑片源的要整站搜索，6 小时内不重复搜）。
 */

export interface ListSnapshot {
  eps?: number;
  avail?: boolean;
}

export interface ListUpdateRecord {
  base: ListSnapshot;
  now: ListSnapshot & { at: number };
}

export type ListUpdates = Record<string, ListUpdateRecord>;

/** 没绑片源、要整站搜索的：这么久内不重复搜 */
export const LIST_SEARCH_TTL_MS = 6 * 3600_000;

const storageKey = (profileId: string) => `libretv:list-updates:v1:${profileId}`;

export function loadListUpdates(profileId: string): ListUpdates {
  if (!profileId || typeof localStorage === 'undefined') return {};
  try {
    const raw = localStorage.getItem(storageKey(profileId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as ListUpdates) : {};
  } catch {
    return {};
  }
}

export function saveListUpdates(profileId: string, data: ListUpdates): void {
  if (!profileId || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(storageKey(profileId), JSON.stringify(data));
  } catch {
    /* 存满了就算了 */
  }
}

/** 记下最新查到的样子；第一次查到的直接当作看过 */
export function recordListCheck(data: ListUpdates, localId: string, seen: ListSnapshot, at = Date.now()): ListUpdates {
  const prev = data[localId];
  const now = { ...prev?.now, ...seen, at };
  const base: ListSnapshot = { ...prev?.base };
  if (base.eps === undefined && now.eps !== undefined) base.eps = now.eps;
  if (base.avail === undefined && now.avail !== undefined) base.avail = now.avail;
  return { ...data, [localId]: { base, now } };
}

/** 加进片单时就知道没有片源（「暂无片源」卡 / 详情弹窗里没搜到）：之后搜到了要提醒「上线了」 */
export function markListUnavailable(data: ListUpdates, localId: string, at = Date.now()): ListUpdates {
  return { ...data, [localId]: { base: { avail: false }, now: { avail: false, at } } };
}

/** 点开看过了：角标消失，以后跟现在比 */
export function acknowledgeListUpdate(data: ListUpdates, localId: string): ListUpdates {
  const rec = data[localId];
  if (!rec) return data;
  const base = { eps: rec.now.eps ?? rec.base.eps, avail: rec.now.avail ?? rec.base.avail };
  return { ...data, [localId]: { base, now: rec.now } };
}

/**
 * 角标文字；没有就是 undefined。
 * watchedTotal：观看记录里这部当时的总集数（你已经看到最新一集时不算「更新了」）。
 */
export function listUpdateBadge(rec: ListUpdateRecord | undefined, watchedTotal = 0): string | undefined {
  if (!rec) return undefined;
  const { base, now } = rec;
  if (base.avail === false && now.avail) return '上线了';
  if (now.eps !== undefined && base.eps !== undefined && now.eps > Math.max(base.eps, watchedTotal)) {
    return `更新至 ${now.eps} 集`;
  }
  return undefined;
}

/** 没绑片源的：上次搜过、还没过期就不再搜 */
export function needsListSearch(rec: ListUpdateRecord | undefined, now = Date.now()): boolean {
  return !rec || rec.now.avail === undefined || now - rec.now.at > LIST_SEARCH_TTL_MS;
}
