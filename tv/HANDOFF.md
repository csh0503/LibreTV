# LibreTV 電視版交接

給接手的工程師／Agent。先讀完再動手。使用者用中文溝通，繁簡混用。

## 目標

在客廳的 Android 電視上順暢使用自部署的 LibreTV。使用者要求**捲動達到 60 fps**。

正式站：`https://libre-tv-dusky-delta.vercel.app`（Vercel 專案 `simon-chen/libre-tv`，有 `PASSWORD` 保護）。

## 目前狀態

| 項目 | 狀態 |
|---|---|
| 網站能在電視 WebView 開啟 | 已完成，已部署 |
| 登入、選設定檔 | 使用者實測可進入首頁 |
| 遙控器方向鍵導覽 | 用指令測過；實體遙控器只確認能進入首頁 |
| 靜止 60 fps | 達成 |
| **捲動 60 fps** | **未達成**，見下方數據 |
| **影片播放** | **完全沒測過**，這是最大未知數 |
| 把 LibreTV 放到新桌面 | 未做，目前排序由系統決定 |
| 關閉除錯 | **未做**，見「收尾清單」 |

## 建議的下一步

1. 先測影片播放（HLS、硬解、遙控器控制）。結果會決定播放器怎麼做。
2. 做**原生 Android TV App**：資料走下方 API，清單用 RecyclerView，播放用 Media3／ExoPlayer。第一版只做登入、設定檔、首頁、搜尋、詳情選集和播放。
3. 原生版不成立時的備案：用 Moonlight 串流電腦上的瀏覽器。電視已裝 Moonlight v12.2，電腦有 Apollo，但實際 4K 60 未驗證。

繼續調 WebView 很難到 60 fps，原因見下方。

## 電視規格

| 項目 | 值 |
|---|---|
| 機型 | FF 55S375C（FFalcon／TCL，中國版），`tc8000_ay30a2` |
| 系統 | Android 11（SDK 30），build `RQ3A.210705.001.2024063018` |
| 晶片 | Amlogic，Mali-G57，32 位元（`armeabi-v7a`），可用記憶體約 3GB |
| WebView | **Chrome 83.0.4103.120**，系統內建，無 Google 服務，無法更新 |
| 解碼 | HEVC 硬解上限 3840×2160，每秒 1944000 區塊（等於 4K60）；也有 AV1、VP9、AVC |
| 畫面 | Android 介面只回報 1080p 60Hz；WebView `dpr=1.5`，CSS 寬度 1280 |
| 網路 | `192.168.31.184`，5GHz Wi-Fi，連線速度約 780–866 Mbps |
| ADB | `adb connect 192.168.31.184:5555`，已授權給這台電腦 |

## 已修改的網站程式（都在 `main`）

| commit | 內容 |
|---|---|
| `c93f232` | 新增 `scripts/lower-client-syntax.mjs`，build 後把 chunk 降到 chrome83；補按鈕透明底（`:where()` 要 Chrome 88） |
| `1272696` | chunk 以 IIFE 包裝，避免 esbuild 輔助函數在全域互相覆蓋 |
| `fb7166f` | CSS 也降級，修 `inset`（Chrome 87），否則 fixed 彈窗會跑出螢幕 |

只靠 `browserslist` + `transpilePackages` 降不掉依賴的私有方法（`#x()`，Chrome 84）。

**坑：** Next 的 chunk 檔名雜湊在降級前算好，降級不會改檔名。裝置上有舊快取時會繼續用舊檔，改了降級邏輯要用 `adb shell pm clear app.libretv.tv` 清掉（會清掉登入狀態）。

## 電視 App（WebView 外殼）

原始碼在 `tv/android-webview/`，套件名 `app.libretv.tv`。已裝在電視上。

- `MainActivity.java`：全螢幕 WebView，攔截方向鍵交給 JS，返回鍵處理。
- `assets/tv-nav.js`：方向鍵焦點導覽和所有 TV 專用優化。
- `assets/early.js`：**除錯用**，記錄錯誤。

`tv-nav.js` 目前的處理：
- 關閉模糊、陰影、轉場和動畫。
- 用 margin 模擬 flex `gap`（Chrome 84），用 JS 設定海報高度（`aspect-ratio` 要 Chrome 88）。不要用 `padding-top` 百分比，它相對於父元素，曾把版面撐爆。
- 畫面外的列 `display:none`，每列先渲染 9 張，焦點右移時再補。
- 焦點限制在最上層的對話框或全螢幕遮罩內（否則會卡在「谁在看？」後面）。
- 圖片改小尺寸：TMDB `w185`、大圖 `w780`、Bangumi `/c/`。

### 建置

```powershell
$env:JAVA_HOME = "<JDK 17>"
$env:ANDROID_HOME = "<Android SDK，需 platform 34、build-tools 34.0.0>"
cd tv\android-webview
"sdk.dir=<SDK 路徑，反斜線要跳脫>" | Out-File -Encoding ascii local.properties
.\gradlew.bat assembleRelease
adb -s 192.168.31.184:5555 install -r app\build\outputs\apk\release\app-release.apk
```

目前的工具在 `%TEMP%\claude\tvtools\`（`build\jdk`、`build\sdk`、`pt\platform-tools`）。那是暫存資料夾，可能被清掉，不見了就重裝。

## 效能數據

全部是電視上實測，工具在 `tv/tools/`。

| 情況（目前版本） | 幀率 | 95% 幀耗時 |
|---|---|---|
| 靜止 | 60 fps | 16.7 ms |
| 往回捲（已渲染過） | 約 43 fps | 100 ms |
| 第一次往下捲 | **12–16 fps** | 200 ms 以上 |

歷程（舊測試，來回混合，不可和上表直接比）：原本 1.3 fps → 關特效 4.8 → 只渲染附近列約 16 → 每列限 9 張約 29。

| 實驗 | 結果 |
|---|---|
| 拿掉全部圖片 | 幾乎沒變，圖片不是主因 |
| 拿掉圓角 | 沒變 |
| 拿掉首頁大圖和卡片按鈕 | 小幅提升 |
| 不切換列的顯示 | 往下約 21，往回掉到約 22 |
| 移除 `*::before` 規則、閒置時處理 | 沒有明顯提升 |

Trace（往下捲 3.2 秒）：`UpdateLayoutTree` 約 680–790 ms，每次約 45 ms，最長 86 ms，是主執行緒最大的工作。Chrome 83 沒有 `content-visibility`。

**量測的限制：** 用的是 JS `scrollBy` 加 `requestAnimationFrame`，屬於壓力測試，遙控器一格一格按的實際感受沒量過。

## 除錯方法

App 目前開著 WebView 遠端除錯，可以直接讀頁面：

```powershell
$p = (adb -s 192.168.31.184:5555 shell pidof app.libretv.tv).Trim()
adb -s 192.168.31.184:5555 forward tcp:9222 "localabstract:webview_devtools_remote_$p"
node tv\tools\cdp.mjs tv\tools\perf3.js    # 靜止／往下／往回的幀率
node tv\tools\prof.mjs                     # CPU Profiler
node tv\tools\trace.mjs                    # 主執行緒工作拆解
adb -s 192.168.31.184:5555 exec-out screencap -p > screen.png
adb -s 192.168.31.184:5555 shell "logcat -d -s LibreTvWeb:*"
```

`cdp.mjs` 接一個內含 JS 表達式的檔案。`probe*.js` 是當時的一次性檢查，可參考。

## 原生版會用到的 API

都在 `src/app/api/`，呼叫方式看 `src/lib/client-api.ts`。

| 用途 | 路由 |
|---|---|
| 登入、狀態 | `/api/auth`（cookie）、`/api/status` |
| 設定檔同步 | `/api/profile-sync` |
| 首頁貨架 | `/api/shelves`、`/api/shelf`、`/api/hot-list`、`/api/upcoming`、`/api/schedule` |
| 片庫與推薦 | `/api/douban`、`/api/browse`、`/api/similar`、`/api/bangumi/calendar` |
| 搜尋與詳情 | `/api/search`（`stream=1` 是 NDJSON）、`/api/detail` |
| 播放 | `/api/proxy`（直連失敗時）、`/api/skip-times` |
| 直播 | `/api/live/playlist`、`/api/live/epg`、`/api/live/stream` |

設定檔、歷史和收藏目前在瀏覽器 IndexedDB／localStorage，再同步到 `/api/profile-sync`，原生版要處理這個格式（`src/lib/profile-bundle.ts`、`src/lib/db.ts`）。播放器邏輯在 `src/components/player-shell.tsx`（直連優先，失敗走代理）。

## 必須遵守

**電視**
- **動電視前先查前景：** `adb shell "dumpsys activity activities | grep -m1 mFocusedApp"`。如果是 `com.limelight/.Game`，表示使用者正在串流，**不要動**。之前因為沒遵守打斷過一次。
- **絕對不要停用或移除 `com.tcl.cyberui`**，否則開機動畫會卡住。也不要動 `com.tcl.tv`、`com.tcl.settings`、`com.tcl.systemserver`、`com.sohu.inputmethod.sogou.tv`、`com.tcl.autopair`、`com.tcl.tcl_bt_rcu_service`、`com.tcl.miracast`。
- 只用 `pm disable-user`，不要解除安裝。

**專案**
- **不要用 Vercel Preview：** 不要推功能分支，部署就直接推 `main`，到正式站驗證。推送前要使用者同意。
- 本機 `main` 比 GitHub 舊，開工前先 `git fetch`，以 `origin/main` 為基礎。
- 這個 repo 是**公開**的，不要提交密碼、金鑰或裝置備份。
- `src/app/api/live/probe/route.test.ts` 的 10 個失敗是既有問題，可忽略。

**憑證**
- LibreTV 密碼和 Netflix 帳號由使用者自己在電視上輸入，不要索取也不要寫進程式。

## 電視的其他狀態

- **已停用 27 個 App：** 清單在 `tv/cleanup/`（`1-ads.txt`、`2-apps.txt`）。`com.tcl.vod` 曾自己被重新啟用，原因不明；最近一次檢查總數是 27，但重開機後是否維持沒驗證。
- **保留：** 雲視聽小電視、應用商店、電視衛士、USB 播放、多屏互動。
- **新桌面：** cleanyourtv 桌面（`com.gathin.tvhome`），主題在 `tv/cleanup/my-theme/`，開了 `HomeKeyService`，`boot_app_componentname` 已指向新桌面。
- **使用者還沒回報：** 待機喚醒和實體遙控器（同主機板有按鍵服務擋住喚醒的回報）、冷開機是否閃過原廠桌面。
- **還原紀錄：** `%USERPROFILE%\.cleanyourtv\recovery-192.168.31.184-*.json`，要保留。工具來自 `Gathin23/cleanyourtv`，`tools/restore.ps1`。
- **Netflix：** 這台沒有 Google 服務，決定裝在 Apple TV，不在電視上硬裝。

## 收尾清單

- [ ] 測影片播放
- [ ] 移除 `WebView.setWebContentsDebuggingEnabled(true)`、`onConsoleMessage` 記錄和 `early.js`
- [ ] 把 App 放到新桌面（`tv/cleanup/my-theme/config.json` 的 `dock_apps` 加 `app.libretv.tv`，再用 `tools/theme.ps1` 推送）
- [ ] 全部完成且使用者不再要裝 App 時，關閉電視的 ADB
