# WDWELT G2 Installation

這份文件安裝 WDWELT G2 Pilot `0.3.0` 到一台既有 MySQL 的 Windows 10／11 PC。Installer 不會安裝、升級、重設或刪除 MySQL，也不會建立 `g2` database；不會把 `3306` 開給 LAN。

## 1. 前置條件

Target PC 必須已有：

- Node.js 20.19+／22.12+ 或相容版本。
- MySQL 8.0 Windows service（例如 `MySQL80`），Startup type 為 Automatic。
- database `g2` 與既有 `users` table。
- Administrator PowerShell，用於安裝 tasks、TCP 8080 firewall rule 與保護 credential ACL。
- MySQL `bind-address=127.0.0.1`。用 `netstat -ano -p TCP | Select-String ':3306'` 確認不得是 `0.0.0.0:3306` 或 `[::]:3306`。

不要把密碼貼到命令列、log、Git 或 `VITE_*`。Repository 外的舊測試檔也不要複製進專案。

## 2. 準備本機 DB 設定

在 repository root 建立未追蹤的 migration credential：

```powershell
Copy-Item .\g2\config.database.admin.example.json .\g2\runtime\config\migration.database.json
```

只在檔案內填入既有 administrative credential。接著執行只讀 preflight：

```powershell
node .\db\preflight.mjs --config .\g2\runtime\config\migration.database.json
```

確認 database 是 `g2`、MySQL version、service、bind address、table list、`users` DDL／row count、current user 與 grants。輸出不得含密碼。

## 3. 先備份，再 migration

第一次 mutation 前：

```powershell
node .\db\backup.mjs `
  --config .\g2\runtime\config\migration.database.json `
  --output .\g2\runtime\backups `
  --label pre-migration

node .\db\migrate.mjs `
  --config .\g2\runtime\config\migration.database.json
```

Migration 有 lock、ledger 與 checksum；重跑為 idempotent，已套用的 SQL 若被修改會失敗。既有相容 `users` rows 會保留並把 plaintext password 轉成 salted scrypt 後移除 plaintext column；不相容 schema 會先 rename 成 timestamped legacy table，不會 drop／truncate。

建立最小權限 runtime account 與未追蹤設定：

```powershell
node .\db\bootstrap.mjs `
  --admin-config .\g2\runtime\config\migration.database.json `
  --runtime-config .\g2\config.database.local.json
```

`wdwelt_app@localhost` 只取得 `g2.*` 的 `SELECT, INSERT, UPDATE, DELETE`；Node host 不使用 root。這兩個 credential files 要限制 Windows ACL，且都不可進 Git。

## 4. Build 與 package

```powershell
npm.cmd install
npm.cmd run build
.\wdwelt.ps1 package -PackagePath .\artifacts\wdwelt-package
```

Package 內容：

```text
wdwelt-package/
├─ production/
├─ host/
│  └─ node_modules/        # mysql2 與 production dependencies
├─ db/
│  └─ migrations/
├─ tools/
│  ├─ wdwelt.ps1
│  └─ database/
└─ manifest.json
```

Manifest format 2 列出所有 packaged files 與 SHA-256。請複製整個 package，不要只複製 `dist`。

## 5. Dry-run 與正式安裝

選擇 host 真正的 LAN IPv4，例如 `192.168.1.50`。有多網卡／VPN 時不要猜。

```powershell
$runtimeDb = (Resolve-Path .\g2\config.database.local.json).Path
$adminDb = (Resolve-Path .\g2\runtime\config\migration.database.json).Path
.\artifacts\wdwelt-package\tools\wdwelt.ps1 install `
  -InstallPath C:\ProgramData\WDWELT `
  -CanonicalHost 192.168.1.50 `
  -MySqlServiceName MySQL80 `
  -DatabaseConfigPath $runtimeDb `
  -AdminDatabaseConfigPath $adminDb `
  -DryRun
```

Dry-run 不寫 filesystem、tasks、firewall 或 service；正式安裝前仍要自行完成上述 MySQL preflight。確認後，以 Administrator PowerShell 執行同一命令並移除 `-DryRun`。

Installer 會驗證 package、Node、既有 MySQL service／`g2`／localhost bind，將兩份 credentials 複製到 `C:\ProgramData\WDWELT\config` 並鎖定 ACL，建立 pre-migration backup、執行 migration、安裝 boot／07:00／watchdog／18:00 backup tasks、只建立 TCP 8080 LocalSubnet firewall rule，最後驗證 `/health/ready`。它不建立 3306 firewall rule。

若 Node 不在 PATH，可傳入 `-NodePath C:\path\to\node.exe`。Public network profile 預設拒絕建立規則；只有理解風險後才用 `-AllowPublicProfile`。

所有相對參數以執行的 `wdwelt.ps1` 所在目錄為基準，config 內相對路徑以 config 目錄為基準；路徑可含空白。從別的 working directory 執行時可直接用 script 絕對路徑。

## 6. 安裝後驗證

```powershell
$tool = 'C:\ProgramData\WDWELT\tools\wdwelt.ps1'
$config = 'C:\ProgramData\WDWELT\config\wdwelt.json'
& $tool status -ConfigPath $config
& $tool health -ConfigPath $config
& $tool network -ConfigPath $config
```

本機確認：

```text
http://127.0.0.1:8080/health/live   -> 200
http://127.0.0.1:8080/health/ready  -> 200
```

再從同一 LAN 的 iPhone 開 `http://192.168.1.50:8080/`，實際完成 register → login → 儲存課表 → 儲存進度 → logout → login。School Wi-Fi 的 client isolation／VLAN 只能用第二台裝置實測。

## 7. Backup 與 restore

每日 18:00 task 把 verified SQL dump 寫到 build 外的 `C:\ProgramData\WDWELT\backups`，保留最近 14 份。手動備份：

```powershell
& $tool backup -ConfigPath $config
```

Restore 是明確的維護操作：先建立 pre-restore backup、進入 maintenance、停止 host、restore、重跑 migration check、清除所有 sessions、重新啟動並驗證 readiness。

```powershell
& $tool restore -ConfigPath $config -BackupFile 'C:\ProgramData\WDWELT\backups\g2-manual-....sql'
```

單機同碟 backup 無法防止 SSD／整台機器損毀；應另外複製到受保護的外部媒體。不要對 production `g2` 執行 automated restore test。
