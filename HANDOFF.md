# 交接说明（给接手的会话）

> **部署规则（用户要求）**：每次改完、测试通过并推送分支后，**直接部署**，不要让用户自己去 Vercel 按 Redeploy。做法：把 main 快进到工作分支（`git push origin HEAD:main`，main 是线性历史，只快进、不强推），Vercel 会自动部署 Production；页脚的提交短哈希可确认线上版本。出问题可在 Vercel 的 Deployments 里 Promote 上一个版本回滚。
>
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
- **连载 / 完结判定只有一处**：`src/lib/title-status.ts` 的 `judgeStatus`。豆瓣热榜、B站热播榜、B站片库（`is_finish`）、Bangumi 片库（首播 120 天内算当季在播）、豆瓣片库（`deriveStatus` 只是包装）、放送表校准（`absentFromCalendar`）都只把线索交给它。新增来源时也请走它，不要再写正则。
- 未播出判定：`unreleased.ts` 的 `fetchUnreleasedIndex` + `dropUnreleased`；片库（`douban.ts`）、热榜、货架出口都过一遍。
- 片库缓存键已升到 `douban:v3`。

## 还没做（按建议顺序）

1. **看部署后的真实样式**：还是没能截图。云端容器的网络策略拦截了 TMDB / 豆瓣 / B站 / Bangumi，本地起服务也拿不到真实数据；要等用户给线上截图（货架卡片、间距、骨架屏、「浏览全部」按钮、新的「暂无片源」卡）。
2. ~~B 方案的「暂无片源」提示~~ **已完成**：首页各行（Billboard、TOP 10、热播货架、为你推荐、即将播出的续集、我的片单、浏览全部）点卡片时把封面 / 年份带给首页（`TitlePick`，存在 `page.tsx` 模块级 `pickedTitles`，从播放页后退也还在）。全部源结算后用 `hasTitleMatch`（`title-aliases.ts`）判断结果里有没有这部本身：一条都没有 → `NoSourceNotice` 整卡；只有名字相近的 → 结果上方一条提示。两种都能加入片单，有源超时会提示重试，全部源都没响应时不说「暂无」。组件在 `src/components/no-source.tsx`。
   - 第二轮截图后：日漫新番的 TMDB 补充改为「近 30 天有新集播出」；科幻 / 喜剧 / 动作行排除动画；题材行多取一页、门槛放低；整页去重改为一行展示出来的全部占用（之前只占前 20 部，导致《怪兽8号》在日漫和动作行重复）。用户的片源覆盖很全，「暂无片源」很难触发，尚未在线上看到实际样子。
   - 用户第一轮截图（桌面）后已修：日漫新番混入国创（按地区过滤）、《守护解放西5/4》两张卡（剧集结尾数字算季数）、货架与 TOP 10 / 大图重复（货架跳过 TOP 10 综合总榜）、两个「收起筛选」、行滚到底就结束（热榜后接 TMDB discover 补到约 40 部，末尾加「浏览全部 X」格子跳到对应频道）、浏览全部网格同系列多季（`dedupeSeasons`）。页脚显示 Vercel 提交短哈希，方便确认部署的是哪次提交。手机截图待用户发。
   - **作品详情弹窗**（Netflix 式「更多信息」）：首页任何卡片点开先进 `src/components/title-modal.tsx`，上半部分是元数据（横图 / 海报、评分、年份、地区、题材、连载状态、简介），下半部分打开时才并发查点播源，按季列出能看的源（`matchingGroups`），点源打开原来的选集弹窗；看过的变成「继续播放」；没有片源时明确写「暂无片源」并可加入片单；「全部搜索结果」走原搜索页（共用搜索缓存，`src/components/use-source-search.ts`）。本地用假数据冒烟截图验证过布局，线上真实数据还没看。
   - **片库翻页修复**：「浏览全部」下一页的偏移原来用「已加载卡片数」，而每页是四个来源各取一页融合的（常常超过一页），导致豆瓣 / B站 / TMDB 每次翻页都跳过一整页；改为「页数 × 每页条数」。`/api/douban` 加 `s-maxage=1800`。
   - **片库按状态筛选改到服务端**：「连载中 / 已完结」原来只在前端从各源热门里挑，结果很少；现在 `status` 传到 `/api/douban`，B站片库用 `is_finish`，TMDB 用 `with_status`（连载另加近 60 天有新集），Bangumi 按首播日期（120 天）；动漫「连载中」混入整份放送表；翻页不再按豆瓣 total 停，只在一页凑不满时停。融合时按年份猜的状态（`statusGuessed`）让位给有依据的状态。
   - **记住别名**：`src/lib/alias-memory.ts`（本机 localStorage）记「片名 → 实际找到的别名」，下次原名和别名同时搜；记住的别名落空就忘掉；详情弹窗「继续播放」也按别名对观看记录。
3. **统一条目层**：第一步已完成——**片名对不上**的问题。`src/lib/title-identity.ts` + `/api/identity`：用 TMDB（`/search/multi` 按片名 + 年份 + 类型认作品，或直接用 `tmdb_` id）取 `alternative_titles` 和 `translations`，收集大陆 / 港 / 台 / 新加坡中文名，繁体用 `opencc-js`（锁 1.0.5，只在服务端用）转简体。作品详情弹窗里原名查不到时依次按最多 3 个别名再查（例：《大师计划》→《终极盗局》）。TMDB 暂时失败时不缓存（`no-store`）。**还没做**：货架整页去重仍按标题，没按跨源 id 合并；找到的别名没有存进收藏 / 历史，搜索结果页（手动输入的搜索）也已接入别名查找（`useAliasFallback`，与弹窗共用）。
4. **综艺补全**（已加 B站综艺 season_type=7 进综艺融合榜，货架也有 TMDB 补充）：纪录片已补 TMDB，综艺行仍只有豆瓣；TMDB 综艺要合并 `10764|10767`，可再加 B站综艺源。
5. **TOP 10 排名算法**：第一版重写已完成（`fuseMultiSourceRankings`）：按平台分组 RRF（K=60，同平台多个榜只取最好名次）、去掉 +0.06 共识奖励、评分改为 ±12% 乘法系数、综合总榜前 10 同一大类最多 4 部（`diversifyRanking`）、Bangumi 在播改按全周真实热度排序（`popularity`）。之后又加了：**上升势头**（`src/lib/rank-history.ts`：综合总榜每小时最多记一次名次快照到设定档同一个存储，和 3~24 小时前比，名次系数 ±6%、新上榜 +3%，卡片显示「↑N」「新上榜」）；`/api/hot-list` 返回 `meta`（算出时间、各来源取数情况）并加 `s-maxage=600`；TOP 10 标题旁显示「HH:mm 更新 · N 个来源」，「怎么排的？」展开规则说明和本次来源；客户端每 15 分钟自动刷新。
6. ~~部分国创年番没有开播日期~~：补了 `looksUnreleased`（来源自己写「即将开播 / 敬请期待 / 定档」的直接不进片库和热榜）。仍没有任何标记的个别条目可能漏网。

## 已知情况

- **片源质检 `/api/quality`**（`src/lib/stream-quality.ts`）：详情弹窗搜完后、搜索结果卡片展开时（共用 `use-source-quality.tsx`），对最靠前的 8 个源取第 1 集播放列表：主列表有 RESOLUTION 就读分辨率，否则 Range 量一个分片大小按码率估；用播放时同一套 `stripAdGroups` 数能识别的插入广告秒数。结果缓存 1 小时，`rankSources` 排序为：没出错 → 清晰度档位 → 集数 → 广告少 → 速度。压在画面里的水印 / 口播广告测不出来。
- **数据源体检页 `/diagnostics`**（`/api/diagnostics`）：现场请求热榜、片库（动漫连载/完结）、TMDB 别名、设定档存储的每个上游，列出条数、耗时、报错、前几个片名。云端容器连不上这些上游，排查时请用户截这一页。

- **Vercel Blob 免费额度**（每月约 1 万次读、2 千次写）：设定档同步原来每 2 秒读一次名单、播放时每 5 秒整份上传，额度很快用完。已改为：轮询 2 分钟一次 + 切回页面时；播放进度 `markProfileDirty('lazy')` 最多 5 分钟传一次、离开页面时补传；上传前名单显示云端没变就不再下载；服务端名单内存缓存 30 秒；榜单快照每实例每小时读一次。以后加任何读写存储的功能都要先算请求次数。**已接 Upstash Redis（2026-10-16，库名 libretv，iad1，Free）**，`profile-sync-store.ts` 认 `KV_REST_API_*`、`UPSTASH_REDIS_REST_*` 和自定义前缀的变量：两个都接着时 Redis 优先，Redis 没有的键回 Blob 读一次并搬进来，读到名单时整批搬设定档；删除时连 Blob 旧副本一起删。`/api/status` 的 `syncStorage` 显示当前用的是哪个。

- `src/app/api/live/probe/route.test.ts` 有 10 个用例本来就超时失败（在我的改动之前就是），与本项目无关，可忽略。
- 线上 Vercel 部署有 Vercel 登录保护，无法直接 curl；调接口请直连上游或本地起服务。
- 提交的署名行按会话里给的 attribution 要求来写。
