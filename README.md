# 今天上到哪 — Teacher G1

給教師使用的 mobile-first 手動課表與進度工具。首頁只處理三件事：顯示目前／下一堂班級、時間，以及該班上次進度。

主要驗證尺寸是 iPhone 12 Safari 的 390 × 844 CSS pixels。介面使用繁體中文，時間判斷固定為 `Asia/Taipei`。

## 功能範圍

- 手動建立星期一至星期五、第 1～8 節的固定 8×5 課表。
- 每格只填班級；空格代表空堂。
- 依時間顯示目前課程、下一堂、課間或今日課程結束狀態。
- 首頁直接顯示該班上次進度、非空備註與最後更新時間。
- 進度使用自由文字並明確按下「儲存」。
- 最近一次進度 Save 可在 10 秒內復原。
- 課表、班級與進度保存在 localStorage。
- `?debug=1` 提供測試日期與時間控制。

本專案不處理學期、假日、臨時調課、通知、日曆、帳號、同步、匯出或匯入。

## 外觀與文字設定

網站預設直接使用低刺激深色外觀及中等文字。設定畫面只包含：

- 外觀：深色／淺色
- 文字大小：小／中／大

設定使用獨立 localStorage key：

```text
today-progress-g1:preferences:v1
```

預設值：

```text
theme: dark
fontSize: medium
```

`index.html` 在載入應用程式模組前同步讀取設定，並在 `<html>` 上預先標記深色背景，因此 fresh load 不需要先顯示淺色畫面再切換。

文字大小對應：

| 選項 | 正文字級 |
| --- | --- |
| 小 | 15px |
| 中 | 17px |
| 大 | 19px |

即使選擇「小」，input、select 與 textarea 仍至少為 16px。

## 進度復原

進度儲存成功後，首頁顯示：

```text
✓ 已儲存　[復原]
```

復原只存在目前頁面的 JavaScript memory：

- 只還原最近一次 Save 前的 `progress`、`note` 與 `updatedAt`。
- 10 秒後自動失效。
- 下一次 Save 取代前一次可復原內容。
- 成功復原後立即失效。
- Reload 後不保留。
- 儲存或復原失敗時會顯示明確錯誤。

## 立即啟動：Deno

在專案目錄開啟 PowerShell：

```powershell
deno run -A --node-modules-dir=auto npm:vite@7.3.6
```

開啟終端機顯示的 `Local` 網址，通常是：

```text
http://localhost:5173/
```

測試時間控制：

```text
http://localhost:5173/?debug=1
```

按 `Ctrl+C` 停止網站。

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

## 在實體 iPhone 上操作

電腦與 iPhone 必須在同一個 LAN。啟動允許其他裝置連線的 server：

```powershell
deno run -A --node-modules-dir=auto npm:vite@7.3.6 --host 0.0.0.0
```

使用 `ipconfig` 找出電腦的 IPv4 Address，然後在 iPhone Safari 開啟：

```text
http://電腦IPv4:5173/
```

各瀏覽器和裝置擁有獨立 localStorage，不會自動同步。

## 固定節次

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

星期、節次及時間由格子位置決定，不能自行修改。

## 課表與進度資料

主要資料使用：

```text
today-progress-g1:v2
```

班級會先 trim 並合併連續空白，再用正規化值建立穩定 `courseId`。相同班級出現在不同格時共用同一份進度；重新建立課表後仍沿用既有 `courseId` 與進度。

刪除課表不會刪除進度；清除所有進度也不會刪除課表。

## 測試

```powershell
npm test
npm run typecheck
npm run build
```

測試涵蓋固定節次、所有既有 schedule states、storage v2 identity 與 persistence、Basic Settings，以及最近一次進度 Save 的精確還原。

專案沒有加入 UI framework、資料庫或額外瀏覽器測試套件。
