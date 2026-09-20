# WDWELT 安裝、更新與修復

Windows 與 MySQL 是持續保留的主機環境；WDWELT 應用檔案可以重裝，資料留在 MySQL。

## 單一入口

在完整專案根目錄執行：

```powershell
npm.cmd run setup
```

也可以執行根目錄 `INSTALL-OR-REPAIR.cmd`。兩者進入相同的 installer，不必自行選擇 fresh install、update 或 repair。來源路徑可包含中文與空白；預設正式安裝位置為 `C:\ProgramData\WDWELT`。無須先 npm install，setup 會使用 lockfile 執行 npm ci、建置及封裝。

管理員 UAC 之後，installer 檢查環境並在必要時要求 administrative DB credential。它優先使用安裝目錄的既有 credential，其次使用專案 `config/local/`。有效的 runtime config 保留；無效或缺少時，嘗試以 admin credential 建立或修復專用 `wdwelt_app@localhost`，產生新的受 ACL 保護設定，不更改自訂帳號。

## 必要環境

- Windows 10／11、Node.js 20.19+、22.12+ 或 24+，以及 npm.cmd。
- 已安裝 MySQL Server 8.x service、mysql.exe、mysqldump.exe。缺少 MySQL 時只提示人工安裝，不下載或重裝 MySQL。
- 已建立 g2，可空白或包含既有資料。
- Admin account 能備份、migration、讀寫 g2；runtime 修復另需管理 wdwelt_app@localhost 的帳號及授權權限。若權限不足，修復會停止並回報 Runtime Account 階段。
- MySQL classic 與啟用的 X Protocol 只綁 localhost。
- `config/deployment.json` 的固定 LAN IP、prefix、gateway 已由 IT 配置；允許的來源網段只限明確校內 private ranges。程式不修改 NIC。
- TCP 8080 可用；允許建立 Domain／Private firewall rule 及 scheduled tasks。

## 安裝流程

自動偵測 fresh／existing／older／incomplete installation，先檢查套件與 MySQL，再建立 `backups\pre-reinstall-YYYYMMDD-HHMMSS.sql`。同秒重跑會使用數字尾碼，避免覆寫。備份失敗時不停止服務、不替換應用；repair 備份不清除既有備份。

備份後取得 maintenance lock、停止已驗證的 WDWELT、再次驗證套件，保存舊 release 再替換 frontend、host 及 DB tools。接著執行 migration、驗證／修復 runtime account、初始化或保留主復原密碼、重建 tasks 和 firewall，最後檢查 live、ready、runtime DB connection、Recovery availability 與 LAN。

主復原密碼已存在時顯示 preserved；沒有時使用隱藏輸入並再次確認，只在 DB 保存 salted scrypt。更改方式見 [Recovery 文件](../docs/G2-Weekly-Recovery.md)。不需重啟作業系統或 Node。

安裝保留 g2、users、courses、timetable_entries、course_progress、recovery_config、backups 及有效 runtime credential。應用失敗時自動還原前一份應用及設定，重新驗證健康狀態；migration 不自動逆轉，DB restore 必須另外明確執行。缺少可用舊版時會如實回報 rollback unavailable。

## 結果與重跑

只有看到 `WDWELT DEPLOYMENT SUCCESS` 才代表所有 gate 完成。結果列出 Application、Database、Migration、Runtime account、Recovery、Host、LAN 與備份路徑。

失敗報告提供 Stage、Reason、Application rollback 與 Database。若已嘗試 migration，會明確顯示 forward migration 未還原，不冒稱資料庫完全沒變。修正該階段後，重跑相同入口。

```powershell
npm.cmd run setup -- -PlanOnly
npm.cmd run setup -- -MySqlServiceName MySQL80
npm.cmd run setup -- -NonInteractive
npm.cmd run setup -- -FullValidation
```

NonInteractive 要求已有 administrative config 與 Recovery 設定，缺少密碼不會使用預設值。FullValidation 的 DB 測試需要額外建立／刪除 wdwelt_test_* 的權限；一般安裝不需要此測試權限。

離線部署先在有網路環境用相同 lockfile 準備 npm cache，再執行 setup 的 `-Offline -NpmCachePath <cache>`；Node 和 MySQL 須先裝好。

日常健康狀態、備份、還原與排程見 [主機維運](../docs/G2-Windows-LAN-Host.md)。

## 開發驗證

部署流程的失敗注入測試使用暫存目錄與系統操作替身：`npm.cmd run test:g2:deployment`。

實際套件與 MySQL 整合測試需先建置封裝，再執行：

```powershell
npm.cmd run build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File install/wdwelt.ps1 package -PackagePath artifacts/wdwelt-package
npm.cmd run test:setup:db -- "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqld.exe"
```

此測試建立暫存 MySQL instance、臨時帳號與套件安裝目錄，啟動僅綁定 loopback 的 8080 host。執行前須讓 8080 保持可用；測試不會停止既有占用程序，也不修改正式 MySQL service、tasks 或 firewall。它驗證套件健康狀態、Recovery 初始化、密碼輪替即時生效、token 作廢及重設後登入。

同一測試也執行真正的 installer 函式、DB backup／migration、憑證 ACL、檔案替換與 host lifecycle，確認安裝、重裝及 ready 失敗回復。管理員檢查、MySQL service 查詢、NIC、tasks 與 firewall 佈建使用替身；正式主機的 Windows 與 LAN 設定仍須由部署時的 gate 驗證。
