/**
 * 记住「片名 → 采集站实际用的名字」（例：大师计划 → 偷天父子兵）。
 * 只存在本机浏览器：下次打开同一部时原名和别名同时搜，不用再等原名落空、查 TMDB、再搜一轮；
 * 片单 / 观看记录也能用它把两个名字对到同一部。
 */
const KEY = 'libretv-title-aliases';
const MAX_ENTRIES = 300;

type AliasMap = Record<string, { alias: string; at: number }>;

function load(): AliasMap {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as AliasMap) : {};
  } catch {
    return {};
  }
}

const norm = (title: string) => title.trim().slice(0, 100);

export function recallAlias(title: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  return load()[norm(title)]?.alias;
}

export function rememberAlias(title: string, alias: string): void {
  if (typeof window === 'undefined') return;
  const t = norm(title);
  const a = norm(alias);
  if (!t || !a || t === a) return;
  try {
    const map = load();
    if (map[t]?.alias === a) return;
    map[t] = { alias: a, at: Date.now() };
    const keys = Object.keys(map);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((x, y) => map[x].at - map[y].at);
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete map[k];
    }
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // 隐私模式等写不了就算了，下次再查一遍
  }
}

export function forgetAlias(title: string): void {
  if (typeof window === 'undefined') return;
  try {
    const map = load();
    if (!map[norm(title)]) return;
    delete map[norm(title)];
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    // 同上
  }
}
