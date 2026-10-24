# WDWELT｜今天上到哪

給教師使用的手機課表與教學進度工具。

打開網站即可看到上一堂、目前課程與下一堂，並記錄每個班級的教學進度和備註。正式資料保存在主機的 MySQL；同一帳號換裝置登入後仍會取得同一份課表與進度。

目前版本：**G2 Pilot v0.3.0**

> [!IMPORTANT]
> ## 要安裝或啟動？從這裡開始
>
> 先確認你目前所在的資料夾。**Repository 與解壓後的 target kit 使用不同命令；不要混用。**

## ⭐ 安裝／啟動：選擇你的情況

| 你的情況 | 目前資料夾應包含 | 執行命令 |
| --- | --- | --- |
| 開發電腦，第一次執行 | `src/`、`server/`、`package.json`，package name 是 `today-progress-g1` | `npm.cmd install` → `npm.cmd run build` → `npm.cmd run host` |
| Repository 已設定完成，只要再次啟動 | 同上，且已有 `dist/`、`config/local/` | `npm.cmd run host` |
| 已有 Node.js、MySQL、正式帳號，要安裝／更新主機 | Repository 根目錄 | `npm.cmd run setup` |
| 剛解壓 `WDWELT-TARGET.zip`，第一次安裝 | `setup.ps1`、`payload.zip`，package name 是 `wdwelt-target-kit` | `npm.cmd run setup` |
| Target kit 已完成安裝，只要啟動 | 同一個解壓後的 target-kit 資料夾 | `npm.cmd run host` |

### A. 開發電腦：第一次啟動

在 **repository 根目錄** 開啟 PowerShell：

```powershell
npm.cmd install
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npm.cmd run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

npm.cmd run host
```

成功時會看到：

```text
WDWELT 0.3.0 build ... listening on 127.0.0.1:8080
```

接著打開：

- **網站：<http://127.0.0.1:8080/>**
- **開發驗證台：<http://127.0.0.1:8080/?debug=0>**
- Health：<http://127.0.0.1:8080/health>

> [!TIP]
> 已經執行過安裝與 build，只想重新啟動時，直接執行 `npm.cmd run host`。

### B. Repository：安裝或更新 Windows 主機

適用於已經有 Node.js、MySQL 與 G2 帳號的 Windows 電腦：

```powershell
npm.cmd run setup
echo $LASTEXITCODE
```

這個入口會保留既有 MySQL 帳號與 grants。詳細設定見 [既有環境快速安裝](install/EXISTING-ENVIRONMENT.md)。

### C. 解壓後的 WDWELT target kit

先進入**實際解壓出的資料夾**，確認其中有 `setup.ps1`、`payload.zip` 和 `payload.sha256`：

```powershell
cd "C:\path\to\wdwelt-target-kit"

# 第一次安裝或更新
npm.cmd run setup
echo $LASTEXITCODE

# 已安裝完成，只要啟動／確認 Host
npm.cmd run host
echo $LASTEXITCODE
```

> [!WARNING]
> Repository 的 `npm.cmd run host` 直接啟動開發設定；target kit 的同名命令則呼叫已安裝的 Windows Host。執行前一定要確認目前資料夾。

### D. 固定校內環境

在 repository 根目錄執行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\INSTALL-TARGET-ENVIRONMENT.ps1
```

預設為 `192.168.0.18:8080`，允許來源網段 `192.168.0.0/22`。安裝前請閱讀 [固定環境安裝](install/TARGET-ENVIRONMENT.md)。

### 啟動後立刻確認

```powershell
curl.exe -sS http://127.0.0.1:8080/health
echo $LASTEXITCODE
```

正常結果必須同時包含：

```json
{
  "status": "ok",
  "app": "ok",
  "database": "ok"
}
```

| 結果 | 意義 | 下一步 |
| --- | --- | --- |
| 網站可開，Health 是 `ok` | Host 與 MySQL 都正常 | 開始使用 |
| 網站可開，但 Health 是 `degraded`／503 | Node 存活，但 DB 或 Migration 未 ready | 查看 Host log 與 DB 設定 |
| 無法連到 8080 | Host 未啟動、啟動失敗或 port 被占用 | 回到終端查看錯誤訊息 |

開發模式下要停止前景 Host，回到執行 `npm.cmd run host` 的 PowerShell 按 `Ctrl+C`。正式安裝的 Windows Host 請使用 [Windows LAN Host 維運文件](docs/G2-Windows-LAN-Host.md) 所列的管理命令，不要直接結束不明 PID。

> [!NOTE]
> `npm.cmd run dev` 只啟動 Vite 前端開發伺服器，不是完整 WDWELT Host，也不能取代 MySQL、API 或正式部署驗證。

## 主要功能

- 手機優先的每週課表
- 上一堂／目前課程／下一堂自動判斷
- 每門課的進度、備註與最後更新時間
- 儲存後 10 秒復原
- 多帳號資料隔離
- 滑動式 30 天持久登入與多裝置 Session
- 忘記密碼與 Master Recovery Key
- 移除課表時段不會刪除歷史進度
- iPhone 主畫面 Web App、Android 與桌面 Web Push
- 校內 HTTP LAN 與可選的 Tailscale Funnel HTTPS
- Migration、備份、還原、更新與 rollback
- `/?debug=0` 開發驗證台

## 系統架構

```text
手機／瀏覽器
      │
      │ LAN HTTP :8080
      │ 或 Funnel HTTPS :443
      ▼
WDWELT Node Host
  前端 + API + Auth + Push
      │
      │ 127.0.0.1:3306
      ▼
MySQL 8.0 / database g2
```

正式前端、API 與健康檢查由同一個 Node process 提供。MySQL 不應對 LAN 或 Internet 開放。

## 使用方式

1. 登入自己的帳號。
2. 第一次使用時建立課表。
3. 首頁會依 `Asia/Taipei` 時間顯示上一堂、目前課程與下一堂。
4. 點選課程，填寫進度與備註後儲存。
5. 若立即發現輸入錯誤，可在 10 秒內復原。

移除某個課表時段只會封存不再使用的課程，歷史進度仍會保留。日後重新加入同名課程時，原本進度會恢復。

### 上課時間

| 節次 | 時間 |
| ---: | :--- |
| 1 | 08:10–09:00 |
| 2 | 09:10–10:00 |
| 3 | 10:10–11:00 |
| 4 | 11:10–12:00 |
| 5 | 13:05–13:55 |
| 6 | 14:05–14:55 |
| 7 | 15:10–16:00 |
| 8 | 16:10–17:00 |

## 通知

在「設定 → 上課通知」中可以啟用或停用目前裝置、選擇提前 5／10／15／30 分鐘提醒，並傳送測試推播。預設為上課前 10 分鐘。

每台裝置各自保存 Push Subscription。發送時會重新查詢最新課表，已刪除或已更換的課程不會沿用舊通知。

iPhone 必須使用 HTTPS 網址，先將網站加入主畫面，再從主畫面開啟並允許通知。

建立本機 VAPID 設定：

```powershell
npm.cmd run push:generate-vapid -- `
  --output config/local/push.json `
  --subject https://YOUR-CONTACT-URL
```

不要使用 `localhost` 作為 VAPID subject；Apple Web Push 會以 `403 BadJwtToken` 拒絕。

唯讀檢查 Subscription：

```powershell
npm.cmd run push:diagnostics -- `
  --config config/local/database.admin.json
```

## `/?debug=0` 開發驗證台

登入後進入「設定」，可使用：

- 台北時間模擬器與常用時間情境
- PWA、Notification、Service Worker 與 Push 能力檢查
- Session、HTTPS、Cookie 與 API 安全狀態
- 帳號範圍的資料完整性 Dry Run
- 課表 current／next 判斷摘要
- Service Worker 更新、測試推播與診斷報告複製
- iPhone 背景通知、關閉後通知、通知點擊與持久登入 checklist

模擬時間只影響目前瀏覽器畫面，不會修改伺服器時間、正式課表或推播排程。人工 checklist 只保存在目前分頁的 `sessionStorage`。

## 部署模式

### 校內 LAN

- Node 監聽 TCP `8080`
- Windows Firewall 只允許指定校內網段
- 不使用 public port forwarding、UPnP 或 wildcard firewall rule
- MySQL 只監聽 `127.0.0.1:3306`

### 個人筆電 + Tailscale Funnel

Funnel 在公開 `.ts.net` 網址終止 HTTPS，再代理到 `127.0.0.1:8080`。原有 LAN 模式不會被取代。

```powershell
# 只查看計畫
npm.cmd run funnel -- -Mode Plan

# 設定並啟用
npm.cmd run funnel -- `
  -Mode Enable `
  -PublicOrigin https://YOUR-DEVICE.YOUR-TAILNET.ts.net
```

啟用前工具會拒絕以下不安全狀態：

- 8080 不是 loopback-only
- MySQL 3306／33060 監聽非 localhost
- 公開網址不是 HTTPS `.ts.net` origin

公開模式預設停用註冊與 Master Recovery，並啟用 Secure Cookie、Origin 檢查與登入限流。詳見 [Tailscale Funnel HTTPS](docs/G2-Tailscale-Funnel.md)。

## 資料完整性

正式資料以 MySQL `g2` 為唯一來源。

| 資料表 | 用途 |
| --- | --- |
| `users` | 帳號與密碼雜湊 |
| `sessions` | 多裝置登入工作階段 |
| `courses` | 使用者課程與封存狀態 |
| `timetable_entries` | 星期與節次 |
| `course_progress` | 進度與備註 |
| `password_reset_tokens` | 短效密碼重設權限 |
| `push_subscriptions` | 各裝置 Push Subscription |
| `push_deliveries` | 推播去重紀錄 |
| `schema_migrations` | Migration ledger |

安全的唯讀報告：

```powershell
npm.cmd run db:integrity -- `
  --config config/local/database.admin.json
```

正式修復必須指定備份目錄與確認字串：

```powershell
npm.cmd run db:integrity -- `
  --config config/local/database.admin.json `
  --apply `
  --confirm APPLY-INTEGRITY-CLEANUP `
  --backup-output runtime/backups
```

這個修復只封存或重新啟用課程，不會刪除課程或 Progress。詳見 [資料完整性、Session 與 Web Push](docs/G2-Integrity-Push.md)。

## Session 與帳號安全

- Session 最長為「最後正常使用起 30 天」；正常使用會安全續期，但不會簽發超過 30 天的 Cookie
- Token 只放在 `HttpOnly` Cookie，不使用 `localStorage`
- HTTPS 使用 `Secure; HttpOnly; SameSite=Strict`
- Logout 立即撤銷目前裝置
- 密碼重設立即撤銷該帳號所有 Session
- DB 只保存 Session token 的 SHA-256 digest
- API 的 `user_id` 一律由伺服器 Session 決定

管理員撤銷指定帳號 Session：

```powershell
npm.cmd run sessions:revoke -- `
  --config config/local/database.admin.json `
  --username TeacherA `
  --confirm REVOKE-SESSIONS
```

### 本機 Developer Administration

> [!IMPORTANT]
> 管理介面不是 8080 的隱藏頁面。它是另一個只監聽 `127.0.0.1:18081` 的服務；LAN 與 Tailscale Funnel 都無法路由到它。

建立 Git 忽略且受 ACL 保護的獨立 developer credential。密碼至少 12 字元，透過 stdin 傳入，不會建立一般 WDWELT 帳號：

```powershell
$credential = Get-Credential -UserName developer -Message 'WDWELT Developer（密碼至少 12 字元）'
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential.Password)
try {
  @{ username = $credential.UserName; password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } |
    ConvertTo-Json -Compress |
    npm.cmd run developer:setup
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
}
```

完成 Migration 並重啟 Host 後，只能在 Host 本機開啟 `http://127.0.0.1:18081/`。

可搜尋帳號、管理身分標籤／備註、停用或啟用帳號、設定臨時密碼。重設密碼會撤銷該帳號全部 Session，使用者下次登入必須立刻換密碼。所有變更寫入 `developer_audit_log`，不保存或顯示明文密碼。

## 驗證

一般變更至少執行：

```powershell
npm.cmd test
echo $LASTEXITCODE

npm.cmd run typecheck
echo $LASTEXITCODE

npm.cmd run build
echo $LASTEXITCODE
```

資料庫、還原與 Windows lifecycle：

```powershell
npm.cmd run test:db -- --config config/local/database.admin.json
npm.cmd run test:restore -- --config config/local/database.admin.json
npm.cmd run test:g2:lifecycle
```

重建並驗證 Windows target kit：

```powershell
npm.cmd run package:target
```

整合測試只允許使用自動產生的 `wdwelt_test_*` 資料庫，不得對正式 `g2` 執行 destructive tests。

目前沒有 lint script；驗證報告應寫明 `lint unavailable`，不能把它標示成通過。

## 健康檢查

| 路徑 | 意義 |
| --- | --- |
| `/health/live` | Node process 存活 |
| `/health/ready` | DB 與 Migration 可用 |
| `/health` | 完整版本、build、DB 與執行狀態 |

`/health/live` 回傳 200 不代表資料庫已 ready。

## Repository 結構

```text
src/                瀏覽器端介面
server/app/         Node Host、API、Auth、Security、Push
db/migrations/      版本化 Schema Migration
db/operations/      Backup、Restore、Integrity 與管理工具
config/             可提交的環境設定
config/local/       本機密鑰與 DB credentials；不納入 Git
install/            Windows 安裝與維運工具
scripts/build/      Production build 與 target-kit 打包
tests/              單元與整合測試
docs/               深入操作文件
runtime/            Log、backup 與執行狀態；不納入 Git
dist/               Production frontend；建置產物
artifacts/          部署包；建置產物
```

## 延伸文件

- [安裝總覽](install/README.md)
- [既有 Windows 環境安裝](install/EXISTING-ENVIRONMENT.md)
- [固定環境安裝](install/TARGET-ENVIRONMENT.md)
- [Windows LAN Host 維運](docs/G2-Windows-LAN-Host.md)
- [Tailscale Funnel HTTPS](docs/G2-Tailscale-Funnel.md)
- [資料完整性、Session 與 Web Push](docs/G2-Integrity-Push.md)
- [每週課程與密碼復原](docs/G2-Weekly-Recovery.md)

## 專案原則

WDWELT 不是完整校務系統。它專注解決幾個每天會遇到的問題：

> 我現在要去哪一班？上一堂教到哪？下一堂要接著做什麼？

因此專案刻意不加入學生評分、QR 點名、額外帳號角色或與這個流程無關的功能。
