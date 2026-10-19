import { describe, expect, it } from 'vitest';
import {
  LIST_SEARCH_TTL_MS,
  acknowledgeListUpdate,
  listUpdateBadge,
  markListUnavailable,
  needsListSearch,
  recordListCheck,
} from './watchlist-updates';

describe('片单更新提醒', () => {
  it('第一次查到的集数当作看过，之后多出来的集才提醒；点开后消失', () => {
    let data = recordListCheck({}, 'a', { eps: 10 }, 1);
    expect(listUpdateBadge(data.a)).toBeUndefined();
    data = recordListCheck(data, 'a', { eps: 12 }, 2);
    expect(listUpdateBadge(data.a)).toBe('更新至 12 集');
    // 已经看到第 12 集了：不提醒
    expect(listUpdateBadge(data.a, 12)).toBeUndefined();
    data = acknowledgeListUpdate(data, 'a');
    expect(listUpdateBadge(data.a)).toBeUndefined();
  });

  it('加进片单时没有片源，之后搜到了提醒「上线了」', () => {
    let data = markListUnavailable({}, 'b', 1);
    expect(listUpdateBadge(data.b)).toBeUndefined();
    data = recordListCheck(data, 'b', { avail: true }, 2);
    expect(listUpdateBadge(data.b)).toBe('上线了');
    data = acknowledgeListUpdate(data, 'b');
    expect(listUpdateBadge(data.b)).toBeUndefined();
  });

  it('第一次搜就有片源：不提醒（不知道以前有没有）', () => {
    const data = recordListCheck({}, 'c', { avail: true }, 1);
    expect(listUpdateBadge(data.c)).toBeUndefined();
  });

  it('整站搜索 6 小时内不重复', () => {
    const data = recordListCheck({}, 'd', { avail: false }, 1000);
    expect(needsListSearch(data.d, 1000 + LIST_SEARCH_TTL_MS - 1)).toBe(false);
    expect(needsListSearch(data.d, 1000 + LIST_SEARCH_TTL_MS + 1)).toBe(true);
    expect(needsListSearch(undefined)).toBe(true);
  });
});
