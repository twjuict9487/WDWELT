# 今天上到哪 — Teacher G1

給教師使用的 mobile-first 手動課表與進度工具。已設定使用者打開首頁後，會依實際時間順序看到上一堂、目前課程與下一堂的班級及進度。

主要驗證尺寸是 iPhone 12 Safari 的 390 × 844 CSS pixels。介面使用繁體中文，時間判斷固定為 `Asia/Taipei`。

## 首頁

已有課表時，首頁最多依固定順序呈現：

```text
上一堂
目前課程
下一堂
```

不存在的 context 直接省略。上一堂與下一堂會依 occurrence 的實際時間搜尋，可跨空堂、午休、日期、週末及每週課表邊界；目前課程沿用 `start <= now < end`。

上課中預設展開「目前課程」；非上課中預設展開「下一堂」，沒有下一堂時才展開上一堂。收合卡片顯示 context、班級、星期與時間，以及單行進度；展開卡片顯示完整進度、非空備註、最後更新與適用的操作：

```text
目前課程：[更新進度]
上一堂：[修正進度]
下一堂：無 CTA
```

點擊任一收合卡片會在原位置同步切換展開狀態，動畫為 `250ms ease-out`。動畫結束後，只有使用者主動展開且卡片未完整位於 viewport 時才會 smooth scroll 至接近中央。課表及資料管理操作仍集中在 Settings；首次使用者則保留最小的「設定課表」empty state。

## Settings

設定畫面包含：

- 外觀：深色／淺色
- 文字大小：小／中／大
- 單一「課表設定」入口
- 最底部的「刪除課表」與「清除所有進度」危險操作區

設定使用獨立 localStorage key：

```text
today-progress-g1:preferences:v1
```

預設為深色及中等文字。`index.html` 在載入應用程式前同步讀取設定並先標記背景，避免 fresh load 閃白。文字大小為 15px、17px、19px；表單控制即使在小字模式仍至少為 16px。

## 導覽與未儲存變更

首頁、Settings、課表設定與進度編輯整合瀏覽器 History API：

- 首次載入以 `replaceState` 建立首頁狀態。
- 進入內部畫面時使用 `pushState`。
- 頁面返回按鈕、瀏覽器 Back／Forward 與 iPhone 返回手勢使用同一套導覽狀態。
- 在首頁再次返回會正常離開網站，不會建立 Back loop。

課表或進度只有實際內容與進入畫面時的 snapshot 不同，離開時才會顯示「放棄變更／繼續編輯」。修改後恢復原值不會提示；成功儲存後也不再視為未儲存。真正關閉頁面時，dirty 狀態另以 `beforeunload` 作為瀏覽器原生保底。

## 進度復原

進度儲存成功後，首頁顯示：

```text
✓ 已儲存　[復原]
```

復原只存在目前頁面的 JavaScript memory：

- 只還原最近一次 Save 前的 `progress`、`note` 與 `updatedAt`。
- 10 秒後自動失效；下一次 Save 會取代前一次。
- 成功復原或 reload 後立即失效。
- 儲存或復原失敗時會顯示明確錯誤。

## 背景時間更新

應用程式以 Last／Current／Next 各自的 role、班級 identity、日期及起訖時間建立 context signature。30 秒 schedule 檢查只有在 signature 改變時才重建首頁並套用新的預設展開卡；signature 相同時保留使用者選擇。Progress、Note、updatedAt 與展開狀態不進入 signature。Settings、課表與進度表單不會被 timer 重建；回到前景、pageshow 或重新 focus 時會補做同一個比較。

## 立即啟動：Deno

在專案目錄開啟 PowerShell：

```powershell
deno run -A --node-modules-dir=auto npm:vite@7.3.6
```

開啟終端機顯示的 `Local` 網址，通常是 `http://localhost:5173/`。網址加上 `?debug=1` 可顯示測試日期與時間控制；按 `Ctrl+C` 停止網站。

## 使用 Node.js/npm

需要 Node.js 20.19+ 或 22.12+：

```powershell
npm install
npm run dev
```

正式建置與預覽：

```powershell
npm run build
npm run preview
```

若 PowerShell 執行原則阻擋 `npm.ps1`，可改用 `npm.cmd install` 與 `npm.cmd run dev`，不必修改系統執行原則。

## 在實體 iPhone 上操作

電腦與 iPhone 必須在同一個 LAN。啟動允許其他裝置連線的 server：

```powershell
deno run -A --node-modules-dir=auto npm:vite@7.3.6 --host 0.0.0.0
```

使用 `ipconfig` 找出電腦的 IPv4 Address，然後在 iPhone Safari 開啟 `http://電腦IPv4:5173/`。iPhone 不可使用 `localhost`；各瀏覽器和裝置也各自擁有獨立 localStorage，不會自動同步。

## 固定資料規則

課表固定為星期一至星期五、第 1～8 節的 8×5 格子：

| 節次 | 時間 |
| --- | --- |
| 1 | 08:10–09:00 |
| 2 | 09:10–10:00 |
| 3 | 10:10–11:00 |
| 4 | 11:10–12:00 |
| 5 | 13:05–13:55 |
| 6 | 14:05–14:55 |
| 7 | 15:10–16:00 |
| 8 | 16:10–17:00 |

每格只填班級；空格代表空堂。主要資料仍使用 `today-progress-g1:v2`。班級正規化、穩定 `courseId`、課表狀態判斷、自由文字進度及 storage v2 結構均未改動。

本專案不處理科目、教室、學期、假日、臨時調課、通知、帳號、同步、匯出、匯入或統計。

## 驗證

```powershell
npm test
npm run typecheck
npm run build
```

測試涵蓋固定節次、Last／Current／Next 跨日 occurrence、timeline signature／選擇、storage v2 identity／persistence、Settings、Undo 精確還原，以及課表／進度草稿的 dirty snapshot 比較。
