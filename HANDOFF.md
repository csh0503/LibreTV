# 交接说明（给接手的会话）

> 先读完这份再动手。用户用中文（繁体/简体混用）沟通；`PASSWORD` 环境变量未设置时所有 `/api/*` 返回 503，本地调试需要自建 `.env.local`（已被 git 忽略）。

## 用户的目标

把首页做成**完全参照 Netflix 的结构**，但数据来自**多个来源互相补缺**（Netflix 各地区片库不完整，这里用多源拼出完整条目）。现在来源太多、页面很乱，要收敛成：

- 每部作品只有一个身份（同一部、不同季度只出现一张卡）。
- 首页由「行」组成（Billboard、TOP 10、热播、新上线、按题材分行、即将播出），不再是一堵筛选墙。
- 「是否已播出」「连载 / 完结」只在一处判断，所有行共用同一套结果。
- 没有片源的作品**仍然显示**（用户选了 B 方案），点进去没片源时提示并可加入片单；不要隐藏。

## 已完成（都在 main 上）

| commit | 内容 |
|---|---|
| `51aa338` | 「即将播出」按真实日期分 7 天；新增 `src/lib/unreleased.ts`（Bangumi + TMDB 开播日期索引）统一剔除未播出条目；`deriveStatus` 不再把未开播剧集标「已完结」；AniList 罗马音/英文名参与中文名匹配 |
| `dc95feb` | Bangumi 放送表按 `air_date` 剔除未开播定档作品（《边缘行者 2》曾因客户端 `mergeAiringCalendar` 混进片库「连载」） |
| `7b64a9b` | Netflix 式货架：`/api/shelf?id=`（`src/lib/shelves.ts` + `shelf-defs.ts`）、客户端 `src/components/shelf-rows.tsx`、首页接入；筛选墙收进「浏览全部」按钮 |

## 架构要点

- 货架目录在 `src/lib/shelf-defs.ts`（客户端 / 服务端共用），取数在 `src/lib/shelves.ts`：热榜类复用 `fetchHotList`（`douban-weekly.ts` 的多源 RRF 融合），题材类用 TMDB discover（`src/lib/tmdb.ts` 的 `tmdbGet`）。
- 整页去重在客户端（`shelfDedupeKey`），前面的行优先；去重后少于 4 部的行不显示；每次放出 3 行，滚动到底再放下一批（用 scroll 事件，不用 IntersectionObserver）。
- 未播出判定：`unreleased.ts` 的 `fetchUnreleasedIndex` + `dropUnreleased`；片库（`douban.ts`）、热榜、货架出口都过一遍。
- 片库缓存键已升到 `douban:v3`。

## 还没做（按建议顺序）

1. **看部署后的真实样式**：我没能截图验证视觉，需要看货架的卡片、间距、骨架屏、「浏览全部」按钮；用户会给截图。
2. **B 方案的「暂无片源」提示**：目前点卡片只是跳到搜索，没片源时只有搜索无结果。要做成点进去明确提示「暂无片源」并提供加入片单（参考 `UpcomingRow.handleClick` 对首播条目的处理）。
3. **统一条目层**：跨源统一身份（Bangumi id / TMDB id / 豆瓣 id 对应同一部），现在只靠标题字符串去重。
4. **综艺补全**：纪录片已补 TMDB，综艺行仍只有豆瓣；TMDB 综艺要合并 `10764|10767`，可再加 B站综艺源。
5. **TOP 10 排名算法重写**（`fuseMultiSourceRankings`）：问题是共识奖励重复计分（每多一个源 +0.06 远大于名次差）、同平台多个榜算多源、Bangumi 名次是 7 天交错的假名次、评分几乎不起作用、没有时间动量、缓存只在单实例内存。建议：按平台分组 RRF（K≈60）、贝叶斯加权评分、榜单快照算动量（可复用 `profile-sync-store.ts` 的 KV）、MMR / 分类配额保证多样性、`Cache-Control: s-maxage` 让边缘共享缓存。
6. 部分国创年番（《谷雨街后巷》《记忆管理局》《镖人 第二季》）没评分没集数，Bangumi / TMDB 查不到开播日期，仍会留在片库；可用 B站片库索引判断。

## 已知情况

- `src/app/api/live/probe/route.test.ts` 有 10 个用例本来就超时失败（在我的改动之前就是），与本项目无关，可忽略。
- 线上 Vercel 部署有 Vercel 登录保护，无法直接 curl；调接口请直连上游或本地起服务。
- 提交需带：`Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
