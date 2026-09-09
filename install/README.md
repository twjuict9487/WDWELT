# WDWELT G2：從零開始的 Windows 安裝與上線指南

**若另一台 Windows 10 已裝好 Node.js、MySQL，且 IT 已建立 G2 專用帳號：請先看 [既有環境快速安裝](EXISTING-ENVIRONMENT.md)，設定網路後執行 `npm.cmd run setup`。** 此模式使用既有帳號；以下 `START-WDWELT.cmd` 則適用於從零安裝及建立帳號。

本文件寫給目前只有一台 Windows 10／11 電腦與 Visual Studio Code、沒有 Node.js、npm、MySQL、Git 或伺服器經驗的人。照順序完成後，這台電腦會成為固定 `192.168.0.18/22` 的 WDWELT 單機校內 LAN host，使用者以 Safari 開啟 `http://192.168.0.18:8080`。

## 先改唯一的環境設定檔

所有會隨部署地點改變的網路值集中在 `config/deployment.json`：

```json
{
  "schemaVersion": 1,
  "environmentName": "school-production",
  "hostAddress": "192.168.0.18",
  "subnetCidr": "192.168.0.0/22",
  "defaultGateway": "192.168.1.254",
  "allowedClientRanges": ["192.168.0.0/22"]
}
```

換環境時只改這個檔案，再執行 `install/START-WDWELT.cmd`。Bootstrap、installer、Firewall 與 production package 都讀同一份設定。設定檔只接受一致的 RFC1918 private IPv4 網路，並拒絕 `Any`、`Internet`、`LocalSubnet` 和 `0.0.0.0/0`。

`8080`、MySQL classic／X Protocol 只綁定 localhost、禁止 public tunnel，以及 Browser → Node → MySQL 的架構是安全規則，不是環境變數；不要放進設定檔放寬。

本文件後面的 IP 範例皆對應目前提交的 `school-production` 設定。

本指南對應 WDWELT G2 Pilot `0.3.0`。不要跳過紅線、安全設定或驗證步驟。

## 最快方式：雙擊一個檔案

如果你已經下載並解壓縮完整 WDWELT repository，請在 Windows 檔案總管開啟其中的 `install` 資料夾，然後雙擊：

```text
START-WDWELT.cmd
```

這是給「電腦目前只有 Windows 與 Visual Studio Code」情況使用的引導安裝器。它不依賴你從正確的 terminal 目錄執行；repository 放在含空白、中文或不同磁碟的路徑也可以。它會依照自己所在位置找到整個專案。

### 它會自動處理什麼

1. 顯示完整計畫，並要求 Windows UAC 的 Administrator 權限。
2. 偵測 Node.js；缺少時透過 Windows WinGet 安裝官方 Node.js LTS。
3. 偵測 MySQL Server 8.x、MySQL Windows service、`mysql.exe` 與 `mysqldump.exe`。
4. 備份 `my.ini`，把 MySQL classic protocol 與 X Protocol 都限制為只監聽 `127.0.0.1`；套用失敗會還原備份。
5. 以隱藏輸入要求 MySQL `root` 密碼；密碼不會放進 process command line 或 bootstrap log。
6. 建立 `g2` database、受 ACL 保護的 administrative credential，以及最小權限 runtime account。
7. 執行鎖版的 `npm ci`、DB preflight、backup、migration、runtime check 與 production build；預設略過開發測試以加快部署。
8. 建立 production package。
9. 驗證 Windows 已由 IT 配置 `192.168.0.18/22` 與 gateway `192.168.1.254`；不使用 DHCP／VPN／測試網路位址，也不自行修改 NIC。
10. 先執行不寫入系統的 installer dry-run，列出 PC／iPhone URL，再要求最後一次確認。
11. 正式建立 WDWELT 安裝目錄、Task Scheduler tasks 與只允許來源 `192.168.0.0/22`、目的地 `192.168.0.18:8080` 的 firewall rule，啟動並驗證服務。

平常直接雙擊即可走快速 production install。若要在安裝前額外執行完整 unit、typecheck 與隔離式 DB tests，改在 PowerShell 執行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install\bootstrap.ps1 -FullValidation
```

任何步驟失敗都會停止，不會顯示「安裝成功」。已完成且安全重跑的步驟可以保留，所以排除問題後可再次雙擊同一個檔案。執行紀錄位於 repository 的 `runtime\logs\bootstrap-日期時間.log`；該目錄不會上傳 Git。

### 仍然需要你親自確認的畫面

完整自動化不代表完全沒有確認。基於 Windows 與密碼安全，以下畫面不能合理跳過：

- Windows UAC：選 **Yes**。
- 第一次安裝 MySQL：官方 MySQL Installer wizard 會開啟。依畫面提示選 `MySQL Server 8.0`、取消 MySQL firewall port、設定並記住 `root` 密碼；關閉 wizard 後 bootstrap 繼續。
- MySQL root 密碼：回到黑色安裝視窗輸入，畫面不會顯示字元。
- 固定網路不符：安裝會停止並列出偵測到的位址；請 IT 配置正確 IP、mask 與 gateway，bootstrap 不會代替 IT 修改 NIC。
- 正式部署：看完 dry-run 的安裝位置與 URL 後輸入 `y`。

如果承載 `192.168.0.18` 的 Windows 網路介面被標示為 **Public**，bootstrap 預設會在 firewall 階段安全停止。先請 IT 確認 profile；只有經明確授權才使用下列參數。即使啟用 Public profile，remote scope 仍保持 `192.168.0.0/22`，不會改成 Internet／Any：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\install\bootstrap.ps1 `
  -AllowPublicProfile
```

### 先看計畫，不做任何變更

在 VS Code 開啟 repository 後，選 **Terminal → New Terminal**，執行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\install\bootstrap.ps1 `
  -PlanOnly
```

`-PlanOnly` 不要求 UAC，不建立 log，不安裝 package，也不修改檔案、MySQL service、Task Scheduler 或 firewall。

### WinGet 不存在時

支援中的 Windows 10／11 通常可由 **App Installer** 提供 WinGet。如果電腦沒有可用的 WinGet，bootstrap 不會從不明網址靜默下載 executable；它會開啟 Node.js 或 MySQL 官方下載頁並停止。完成官方 installer 後，再雙擊 `START-WDWELT.cmd`，流程會從偵測階段安全重跑。

### 完全無外網的安裝模式

正式 runtime 不需要 Internet；需要外網的是安裝素材取得階段。請先在可上網的準備電腦完成：

1. 從 Node.js 官方網站下載 signed Node.js LTS `.msi`。
2. 從 MySQL 官方網站下載 `mysql-installer-community` **full bundle**；不要拿只有下載器的 `web-community` 版本。
3. 在同版本 repository 中建立完整 npm cache：

```powershell
npm.cmd ci --cache .\install\offline\npm-cache --no-audit --fund=false
```

4. 將 repository、兩個 MSI 與整個 `npm-cache` 透過 IT 核准的離線媒介帶到正式主機。
5. 在正式主機的 Administrator PowerShell 執行；路徑可放在 repository 內或使用絕對路徑：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\install\bootstrap.ps1 `
  -Offline `
  -NodeInstallerPath .\install\offline\node-lts.msi `
  -MySqlInstallerPath .\install\offline\mysql-installer-community-full.msi `
  -NpmCachePath .\install\offline\npm-cache
```

`-Offline` 會禁止 bootstrap 使用 WinGet、開啟下載頁或讓 npm 補抓缺少的 package。兩個 MSI 必須通過 Windows Authenticode 驗證；npm cache 缺少任何 lockfile dependency 時會停止。MySQL full bundle 啟動後若詢問網路，選擇 offline mode。

外網依賴分類如下：

| 項目 | 類型 | 完全離線時的處理 |
| --- | --- | --- |
| WinGet source 與 Node.js package | installation-only | 改用預先下載且 signed 的 Node.js LTS MSI |
| MySQL product manifest／web installer payload | installation-only | 改用預先下載的 MySQL full bundle |
| npm registry packages | build／installation-only | 使用與 `package-lock.json` 對應的預填 npm cache 及 `npm ci --offline` |
| Node.js executable | runtime dependency | 安裝後留在主機；執行時不連 Internet |
| MySQL Windows service | runtime dependency | 僅連 `127.0.0.1:3306`；執行時不連 Internet |
| production frontend／Node host／packaged `node_modules` | runtime | 沒有外部 API、CDN、tunnel 或 updater dependency |

本文件其餘部分是每一階段的完整手動做法、驗證方式與故障排除。自動引導失敗時，直接跳到對應章節檢查，不必從頭猜測。

## 最終會得到什麼

```text
iPhone Safari
    │
    │ 校內 Wi-Fi，TCP 8080
    ▼
Windows PC／Laptop
    ├─ WDWELT Node host：網頁與 /api/*
    └─ MySQL 8.0：只接受本機 127.0.0.1:3306
```

正式安裝位置預設是：

```text
C:\ProgramData\WDWELT\
├─ current\                 正式網頁
├─ tools\host\              Node host
├─ db\                      DB tools 與 migrations
├─ config\                  受 ACL 保護的設定與憑證
├─ backups\                 SQL backups
├─ logs\                    執行紀錄
└─ run\                     PID、lock 與健康狀態
```

### 兩條網路規則

1. iPhone 只連 Windows 主機的 `8080`。
2. MySQL `3306` 只准 Windows 主機自己以 `127.0.0.1` 連線。

不要在路由器設定 port forwarding。不要建立對外的 MySQL firewall rule。不要把 `3306` 開給 LAN。

## 完整流程地圖

請依序完成：

1. 準備 Windows 主機與專案資料夾。
2. 安裝 Node.js LTS。
3. 安裝並設定 MySQL Server 8.0。
4. 把 MySQL 限制在 localhost。
5. 建立空的 `g2` database。
6. 安裝專案 dependencies。
7. 建立本機 database credential files。
8. 執行 preflight、backup、migration 與 runtime-account bootstrap。
9. 執行測試與 production build。
10. 在本機試跑。
11. 找出正確的 LAN IPv4。
12. 建立 package，先 dry-run，再正式安裝。
13. 從本機與 iPhone 驗證。
14. 驗證重開機、備份與日常維護。

---

# 第一部分：認識 VS Code Terminal

## 1. 開啟正確的專案資料夾

如果專案已經在電腦上：

1. 開啟 Visual Studio Code。
2. 選擇 **File → Open Folder...**。
3. 選擇包含 `package.json` 的 WDWELT 資料夾。
4. 按 **Select Folder**。
5. 如果 VS Code 詢問是否信任作者，確認這是你取得的 WDWELT repository 後才選擇信任。

如果尚未取得專案，而且沒有 Git：

1. 用瀏覽器開啟 `https://github.com/twjuict9487/WDWELT`。
2. 按 **Code → Download ZIP**。
3. 在 Windows 檔案總管對 ZIP 按右鍵，選擇 **Extract All...**。
4. 把解壓縮後的資料夾放到容易找到的位置，例如 `Documents\WDWELT`。
5. 用 VS Code 開啟那個包含 `package.json` 的資料夾；不要只開啟裡面的 `src` 或 `install`。

## 2. 開啟 PowerShell Terminal

在 VS Code：

1. 選擇 **Terminal → New Terminal**。
2. Terminal 通常會出現在視窗下方。
3. 右上角 shell 名稱應該是 **PowerShell**。若不是，按 terminal 的下拉箭頭，選 **Select Default Profile → PowerShell**，再建立新 terminal。

先輸入：

```powershell
Get-Location
Test-Path .\package.json
```

第二行必須顯示：

```text
True
```

如果是 `False`，代表 terminal 不在 repository root。使用下面的命令切換；把路徑換成自己的實際位置：

```powershell
Set-Location -LiteralPath 'C:\Users\你的Windows帳號\Documents\WDWELT'
Test-Path .\package.json
```

路徑含空白或中文沒有問題，但必須保留單引號並使用 `-LiteralPath`。

## 3. 一般 terminal 與 Administrator terminal

本指南會使用兩種 terminal：

- **一般 terminal**：VS Code 內建 terminal，用於下載 dependencies、build、test 與準備設定。
- **Administrator PowerShell**：Windows 以系統管理員身分開啟的 PowerShell，用於修改 MySQL 設定、Windows service、Task Scheduler、Firewall 與正式安裝。

不要讓日常開發一直使用 Administrator 權限。只有標示「Administrator」的步驟才提升權限。

開啟 Administrator PowerShell：

1. 按 Windows 開始鍵。
2. 輸入 `PowerShell`。
3. 對 **Windows PowerShell** 按右鍵。
4. 選擇 **Run as administrator／以系統管理員身分執行**。
5. Windows 詢問是否允許變更時，選 **Yes**。
6. 用 `Set-Location -LiteralPath '你的 repository 路徑'` 切換到 repository root。

---

# 第二部分：安裝 Node.js 與 npm

## 4. 下載 Node.js LTS

1. 開啟 Node.js 官方下載頁：`https://nodejs.org/en/download`。
2. 選擇 **LTS**，不要選 Current、Nightly 或已 EOL 的版本。
3. 選 Windows 的 `.msi` installer，通常是 x64。
4. 執行下載的 installer。
5. 接受授權條款。
6. 保留預設安裝路徑與功能。
7. 確認包含 npm 並勾選加入 PATH 的選項。
8. 完成安裝。

WDWELT 需要 Node.js `20.19+`／`22.12+` 或相容的新版本；新安裝應直接使用目前仍受支援的 LTS。2026-09-08 查核時，Node.js 官方列出的 LTS branches 是 24 與 22。

## 5. 讓 VS Code 重新讀取 PATH

安裝完成後：

1. 關閉 VS Code 裡所有 terminals。
2. 完全關閉 VS Code。
3. 重新開啟 VS Code 與 repository。
4. 建立新的 PowerShell terminal。

執行：

```powershell
node --version
npm.cmd --version
where.exe node
where.exe npm
```

成功時會看到 Node 與 npm 版本，以及像下面的路徑：

```text
C:\Program Files\nodejs\node.exe
C:\Program Files\nodejs\npm
C:\Program Files\nodejs\npm.cmd
```

如果仍顯示「無法辨識 npm」：

1. 確認你開的是安裝完成後建立的新 terminal。
2. 重新啟動 Windows。
3. 檢查 `C:\Program Files\nodejs\node.exe` 是否存在。
4. 重新執行 Node.js installer，確認 PATH 功能有安裝。

在 PowerShell 中本指南一律使用 `npm.cmd`，可避開部分電腦對 `npm.ps1` 的 execution-policy 限制。

---

# 第三部分：安裝 MySQL Server 8.0

## 6. 下載 MySQL Installer

1. 開啟官方頁面：`https://dev.mysql.com/downloads/windows/installer/`。
2. WDWELT G2 使用 **MySQL Server 8.0**。
3. 有穩定網路時選較小的 `mysql-installer-web-community`。
4. 需要離線安裝時選完整的 `mysql-installer-community`。
5. 執行 `.msi` installer。

MySQL 8.0 是最後支援 MySQL Installer 的系列，因此不要在這份 G2 安裝中自行改用 MySQL 9.x。也不要安裝 MariaDB 當作替代品。

如果 installer 提示缺少 Microsoft Visual C++ Redistributable，依畫面安裝 prerequisite，完成後回到 MySQL Installer。

## 7. 選擇安裝內容

初次安裝時選：

```text
Setup Type: Server only
Product: MySQL Server 8.0（installer 提供的最新 8.0 patch）
```

Workbench、Router、Samples 與 Connector/ODBC 都不是 WDWELT 必要條件。若你想用 GUI 查看資料庫，可以額外裝 Workbench，但本指南不依賴它。

依序按 **Next → Execute**，直到 MySQL Server 顯示 Complete，再進入 Product Configuration。

## 8. MySQL Server Configuration：逐頁設定

不同 patch 版的字樣可能略有差異；核心設定必須如下。

### Type and Networking

```text
Config Type: Development Computer
TCP/IP: Enabled
Port: 3306
X Protocol Port: 保留預設
Open Windows Firewall port for network access: 不勾選
Named Pipe: 不需要
Shared Memory: 不需要
```

這台電腦同時執行 Windows、Node host 與 MySQL，因此選 Development Computer 可降低 MySQL 的預設記憶體占用。

`Open Windows Firewall port for network access` 必須取消。WDWELT 的 Node host 需要 `8080`，MySQL 的 `3306` 不需要讓其他電腦連線。

### Authentication Method

選擇：

```text
Use Strong Password Encryption for Authentication
```

不要為了這個專案切換到 legacy MySQL 5.x authentication。

### Accounts and Roles

1. 為 MySQL `root` 設定一個強密碼。
2. 把密碼記在受保護的 password manager；不要貼到聊天室、README、Git commit 或 terminal command。
3. 目前不需要用 installer 建立其他 MySQL user；稍後 WDWELT 會建立最小權限的 `wdwelt_app@localhost`。

若密碼包含 JSON 的 `"` 或 `\`，稍後寫入 JSON 設定時必須分別寫成 `\"` 與 `\\`。不確定時可使用長度足夠、由英數字及其他不含雙引號／反斜線符號組成的強密碼。

### Windows Service

```text
Configure MySQL Server as a Windows Service: 勾選
Windows Service Name: MySQL80
Start the MySQL Server at System Startup: 勾選
Run Windows Service as: Standard System Account
```

如果 `MySQL80` 已被使用，installer 可能提出另一個名稱。請記下實際名稱，後面的 `-MySqlServiceName` 必須使用同一個名稱。

### Server File Permissions

保留 installer 的安全預設：只有 MySQL service account 與 Administrators 擁有完整權限。

### Apply Configuration

1. 按 **Execute**。
2. 等待每個項目變成綠色勾號。
3. 如果任何項目失敗，不要繼續；開啟 Log 查看錯誤。
4. 全部成功後按 **Finish**。

## 9. 確認 MySQL service

在一般 VS Code terminal 執行：

```powershell
Get-Service -Name MySQL80
Get-CimInstance Win32_Service -Filter "Name='MySQL80'" | Select-Object Name,State,StartMode
```

預期：

```text
Status   Name      DisplayName
Running  MySQL80   MySQL80
```

如果找不到：

```powershell
Get-Service | Where-Object Name -Like '*mysql*' | Format-Table Status,Name,DisplayName
```

記下真正的 service name。以下範例仍以 `MySQL80` 表示。

---

# 第四部分：把 MySQL 限制在本機

## 10. 找到並備份 `my.ini`

MySQL Installer 常見的設定檔位置是：

```text
C:\ProgramData\MySQL\MySQL Server 8.0\my.ini
```

`ProgramData` 是隱藏資料夾。請在 **Administrator PowerShell** 執行：

```powershell
$myIni = 'C:\ProgramData\MySQL\MySQL Server 8.0\my.ini'
Test-Path -LiteralPath $myIni
```

如果顯示 `False`，搜尋實際位置：

```powershell
Get-ChildItem -LiteralPath 'C:\ProgramData\MySQL' -Filter my.ini -File -Recurse
```

把 `$myIni` 改成輸出中的正確完整路徑。先建立可回復備份：

```powershell
$backupName = "$myIni.wdwelt-before-localhost-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item -LiteralPath $myIni -Destination $backupName
$backupName
```

不要跳過備份。

## 11. 設定 `bind-address=127.0.0.1`

用提升權限的文字編輯器開啟 `$myIni`。最簡單的方法是在 Administrator PowerShell 執行：

```powershell
Start-Process notepad.exe -Verb RunAs -ArgumentList "`"$myIni`""
```

Windows 內建 Notepad 只用於這個需要管理權限的設定檔。如果你確定 VS Code 本身是以 Administrator 身分啟動，也可以用 VS Code 編輯。

在檔案中找到 `[mysqld]` 區段：

```ini
[mysqld]
```

在這個區段加入或修改成：

```ini
bind-address=127.0.0.1
```

注意：

- 如果已經有 `bind-address=*`、`bind-address=0.0.0.0` 或其他值，直接修改原本那一行。
- 不要同時保留兩行不同的 `bind-address`。
- 不要把這行放到 `[client]` 區段。
- 不要改動 datadir、port 或其他不理解的設定。

儲存並關閉編輯器。

## 12. 重啟並驗證 MySQL

在 Administrator PowerShell 執行：

```powershell
Restart-Service -Name MySQL80
Get-Service -Name MySQL80
Get-NetTCPConnection -State Listen -LocalPort 3306 | Format-Table LocalAddress,LocalPort,OwningProcess
```

`LocalAddress` 應是 `127.0.0.1`。不得是 `0.0.0.0` 或 `::`。

也可用：

```powershell
netstat -ano -p TCP | Select-String ':3306'
```

如果 service 無法重啟：

1. 不要重複亂改設定。
2. 把目前 `my.ini` 另存一份供檢查。
3. 用剛才的 `.wdwelt-before-localhost-*` 備份還原。
4. 再執行 `Restart-Service -Name MySQL80`。
5. 開啟 MySQL Installer，對 MySQL Server 選 **Reconfigure**，檢查錯誤。

---

# 第五部分：建立 WDWELT database

## 13. 找到 MySQL command-line client

回到一般 VS Code terminal，在 repository root 執行：

```powershell
$mysql = 'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe'
Test-Path -LiteralPath $mysql
```

必須顯示 `True`。如果 MySQL 安裝在別處，用檔案總管或下面命令尋找：

```powershell
Get-ChildItem -LiteralPath 'C:\Program Files\MySQL' -Filter mysql.exe -File -Recurse
```

將 `$mysql` 改成正確路徑。

## 14. 測試 root 登入

```powershell
& $mysql -u root -p -e "SELECT VERSION() AS version, @@bind_address AS bind_address;"
```

看到 `Enter password:` 時才輸入 MySQL root 密碼。輸入期間畫面不會顯示星號，這是正常的。不要使用 `-p你的密碼`，因為那會把密碼放進 process command line 與 terminal history。

預期 `bind_address` 是 `127.0.0.1`。

## 15. 建立空的 `g2`

```powershell
& $mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS g2 CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci; SHOW DATABASES LIKE 'g2';"
```

預期輸出包含：

```text
g2
```

這一步只建立 database。WDWELT 的 tables 會由版本化 migration 建立，不要手動建立或猜測 table schema。

---

# 第六部分：準備專案與本機憑證

## 16. 安裝 JavaScript dependencies

確認 terminal 在 repository root：

```powershell
Test-Path .\package.json
```

顯示 `True` 後執行：

```powershell
npm.cmd install
```

完成後驗證：

```powershell
Test-Path .\node_modules
npm.cmd list --depth=0
```

不要把 `node_modules` 手動複製到別台電腦，也不要把它加入 Git。

## 17. 建立 administrative database config

```powershell
New-Item -ItemType Directory -Force .\config\local | Out-Null
Copy-Item .\config\database.admin.example.json .\config\local\database.admin.json
code .\config\local\database.admin.json
```

如果 `code` command 不存在，直接在 VS Code Explorer 展開 `config → local`，點選 `database.admin.json`。

把：

```json
"password": "REPLACE_WITH_EXISTING_ADMIN_SECRET"
```

改成剛才設定的 MySQL root 密碼。其他預設應保持：

```json
"host": "127.0.0.1",
"port": 3306,
"database": "g2",
"user": "root"
```

檢查工具路徑是否存在：

```powershell
Test-Path 'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe'
Test-Path 'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe'
```

若 MySQL 安裝路徑不同，同步修改 JSON 中的 `mysqlDumpPath` 與 `mysqlClientPath`。JSON 內的 Windows 反斜線必須寫成 `\\`。

重要：

- `config/local/` 已被 `.gitignore` 忽略；這裡只放本機 credential，不會進 Git。
- 仍然不要把 credential file 傳給別人、貼到 issue 或截圖。
- 不要把 root password 放進 `config/local/` 以外的 `config/`、`src/`、`README.md` 或任何會 commit 的檔案。

## 18. 執行只讀 preflight

```powershell
npm.cmd run db:preflight -- --config .\config\local\database.admin.json
```

Preflight 會檢查：

- 實際連到 `g2`。
- MySQL version。
- current MySQL user 與 grants。
- `bind_address` 與 `mysqlx_bind_address`。
- 目前 tables。
- 若 `users` 已存在，顯示 schema 與 row count。
- 是否已有 `wdwelt_app` account。

第一次全新安裝時 `tables`、`usersSchema`、`usersCount` 可以是空陣列，因為 migration 還沒執行。以下情況不可以繼續：

- `Access denied`。
- database 不是 `g2`。
- `bind_address` 是 `*`、`0.0.0.0` 或 `::`。
- 無法連到 `127.0.0.1:3306`。

## 19. 先備份，再 migration

即使是空 database，也先建立流程上的第一份 backup：

```powershell
node .\db\operations\backup.mjs `
  --config .\config\local\database.admin.json `
  --output .\runtime\backups `
  --label pre-migration
```

確認產生 SQL 檔：

```powershell
Get-ChildItem .\runtime\backups\*.sql | Sort-Object LastWriteTime -Descending | Select-Object -First 3 Name,Length,LastWriteTime
```

然後執行 migration：

```powershell
npm.cmd run db:migrate -- --config .\config\local\database.admin.json
```

Migration 會：

- 建立 `schema_migrations` ledger。
- 建立或升級 `users`。
- 建立 `sessions`、`courses`、`timetable_entries`、`course_progress`。
- 保留可相容的既有 user rows。
- 將舊 plaintext password 轉成 salted scrypt 後移除 plaintext column。
- 記錄 migration checksum；已套用的 migration 被事後修改時會拒絕繼續。

重跑同一個 migration command 應顯示 already applied，而不是重建資料。

## 20. 建立最小權限 runtime account

執行：

```powershell
node .\db\operations\bootstrap.mjs `
  --admin-config .\config\local\database.admin.json `
  --runtime-config .\config\local\database.runtime.json
```

這一步會：

- 產生一個隨機 runtime password。
- 建立 `wdwelt_app@localhost`。
- 只授予 `g2.*` 的 `SELECT, INSERT, UPDATE, DELETE`。
- 建立 `config/local/database.runtime.json`。
- 在 Windows 套用 credential ACL。

不要手動把 runtime account 改成 `%` host，不要授予 `GRANT OPTION`、`CREATE USER` 或全域管理權限。

確認 runtime connection：

```powershell
node .\db\operations\runtime-check.mjs --config .\config\local\database.runtime.json
```

預期輸出包含：

```json
"ready": true
```

再次執行 preflight，這次應看到六個 application／migration tables：

```powershell
npm.cmd run db:preflight -- --config .\config\local\database.admin.json
```

---

# 第七部分：測試與本機試跑

## 21. 執行基本驗證

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

三個命令都必須 exit code 0。Build 成功後會建立：

```text
dist\index.html
dist\assets\...
dist\build-metadata.json
```

可再執行隔離式 database tests：

```powershell
npm.cmd run test:db -- --config .\config\local\database.admin.json
npm.cmd run test:restore -- --config .\config\local\database.admin.json
```

這兩個測試使用名稱以 `wdwelt_test_` 開頭的臨時 databases，完成後刪除。不要自行把測試程式的 database name 改成 `g2`。

## 22. 啟動本機 host

在 VS Code terminal 執行：

```powershell
npm.cmd run host
```

保持這個 terminal 開啟。另開一個 VS Code terminal，測試：

```powershell
Invoke-WebRequest http://127.0.0.1:8080/health/live | Select-Object StatusCode,Content
Invoke-WebRequest http://127.0.0.1:8080/health/ready | Select-Object StatusCode,Content
```

兩個 `StatusCode` 都應是 `200`。然後用這台 PC 的 Chrome／Edge 開啟：

```text
http://127.0.0.1:8080/
```

測試建立帳號、登入、設定課表與儲存進度。結束本機試跑時，回到執行 host 的 terminal 按 `Ctrl+C`。

這一節啟動的是 repository 的 development config，所以只監聽 `127.0.0.1`。正式安裝則只監聽 `config/deployment.json` 的 `hostAddress`，Windows PC 與 iPhone 都使用該 LAN URL。

---

# 第八部分：驗證 IT 指定的固定 LAN 地址

## 23. 確認 PC 連上正確網路

正式 host PC 必須由 IT 配置：

```text
IP:      192.168.0.18
Mask:    255.255.252.0  (/22)
Gateway: 192.168.1.254
```

此外應：

- 使用穩定的校內 Ethernet 或 Wi-Fi。
- 連接電源。
- 不在服務期間睡眠或關機。
- 不使用 guest Wi-Fi。
- 不把行動熱點、VPN、VirtualBox、Hyper-V 或 Docker virtual adapter 當成 LAN 網卡。

執行：

```powershell
Get-NetIPConfiguration |
  Where-Object { $_.NetAdapter.Status -eq 'Up' -and $_.IPv4DefaultGateway } |
  Select-Object InterfaceAlias,@{Name='IPv4';Expression={$_.IPv4Address.IPAddress}},@{Name='Gateway';Expression={$_.IPv4DefaultGateway.NextHop}}
```

正確輸出必須包含：

```text
InterfaceAlias  IPv4           Gateway
Ethernet        192.168.0.18   192.168.1.254
```

另外確認 prefix：

```powershell
Get-NetIPAddress -AddressFamily IPv4 -IPAddress 192.168.0.18 |
  Format-Table IPAddress,PrefixLength,InterfaceAlias,AddressState
```

`PrefixLength` 必須是 `22`。Bootstrap／installer 只驗證，不會自行修改 NIC。如果只看到 `10.0.0.78`、其他 DHCP 位址或錯誤 gateway，請停止並交由 IT 設定；不得把它當作 production canonical address。

不要使用：

- `127.0.0.1`
- `169.254.*.*`
- VPN adapter
- `vEthernet`
- 沒有 default gateway 的 adapter

有其他網卡、VPN 或 `vEthernet` 不影響固定值，但不得用它們取代 `192.168.0.18`。

把選定地址存成目前 terminal 的變數；請換成自己的值：

```powershell
$lanIp = '192.168.0.18'
$lanIp
```

固定方式、DHCP reservation 或 static assignment 由 IT 管理；WDWELT 不修改 Windows IP、DNS、route 或 gateway。

## 24. 確認 Windows network profile

```powershell
Get-NetConnectionProfile | Format-Table InterfaceAlias,NetworkCategory,IPv4Connectivity
```

WDWELT firewall rule 僅套用到 local address `192.168.0.18`，只允許 remote `192.168.0.0/22` 連 TCP `8080`，並阻擋 edge traversal。預設 profile 是 Domain／Private。若承載固定 IP 的介面顯示 Public，先詢問 IT；不要放寬為 Internet／Any。

`LocalSubnet` 在這張正確配置的 `/22` 介面上可涵蓋同網段來源，但它是動態 keyword，也可能受到其他本機介面影響。因此正式規則使用明確的 `192.168.0.0/22`。代價是：若合法老師裝置位於另一個 routed VLAN，它會被擋下。這不是程式可猜測的資料；需 IT 提供額外 CIDR／IP range，再以明確的 `-AllowedRemoteAddress` 更新，不能改成 Any。

---

# 第九部分：建立正式 package

## 25. Build 並 package

在一般 VS Code terminal、repository root 執行：

```powershell
npm.cmd run build
powershell.exe -NoProfile -ExecutionPolicy Bypass `
  -File .\install\wdwelt.ps1 `
  package `
  -PackagePath .\artifacts\wdwelt-package
```

成功時顯示：

```text
Package created: ...\artifacts\wdwelt-package
```

Package 內容：

```text
artifacts\wdwelt-package\
├─ production\
├─ host\
│  └─ node_modules\
├─ db\
│  ├─ core\
│  ├─ operations\
│  └─ migrations\
├─ tools\
│  ├─ wdwelt.ps1
│  └─ database\
└─ manifest.json
```

`manifest.json` 包含 package files 的 SHA-256。不要手動修改 package 裡的檔案，也不要只複製 `dist`。

---

# 第十部分：Dry-run 與正式安裝

## 26. 準備不含密碼的路徑變數

在一般 terminal 執行：

```powershell
$lanIp = '192.168.0.18'
$nodePath = (Get-Command node).Source
$runtimeDb = (Resolve-Path .\config\local\database.runtime.json).Path
$adminDb = (Resolve-Path .\config\local\database.admin.json).Path
$packageTool = (Resolve-Path .\artifacts\wdwelt-package\tools\wdwelt.ps1).Path

$lanIp
$nodePath
$runtimeDb
$adminDb
$packageTool
```

輸出的五個值都必須正確。變數只包含 IP 與檔案路徑，不包含明文密碼。

## 27. 先執行 dry-run

只對目前的一般 terminal 放寬 `.ps1` 執行限制：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

然後執行：

```powershell
& $packageTool install `
  -InstallPath 'C:\ProgramData\WDWELT' `
  -CanonicalHost $lanIp `
  -AllowedRemoteAddress '192.168.0.0/22' `
  -NodePath $nodePath `
  -MySqlServiceName 'MySQL80' `
  -DatabaseConfigPath $runtimeDb `
  -AdminDatabaseConfigPath $adminDb `
  -DryRun
```

Dry-run 會驗證 package 與輸入路徑，但不建立目錄、scheduled tasks、firewall rule，也不啟動 host。輸出必須顯示 canonical URL `http://192.168.0.18:8080`、prefix `/22`、gateway `192.168.1.254` 與 firewall remote `192.168.0.0/22`。Dry-run 可以在準備電腦顯示 fixed NIC 尚未 ready；正式寫入則會直接拒絕錯誤 NIC 設定。

## 28. 開啟 Administrator PowerShell 並重新建立變數

PowerShell 變數不會自動從一般 terminal 傳到 Administrator 視窗。請在 Administrator PowerShell 執行：

```powershell
Set-Location -LiteralPath 'C:\Users\你的Windows帳號\Documents\WDWELT'

$lanIp = '192.168.0.18'
$nodePath = (Get-Command node).Source
$runtimeDb = (Resolve-Path .\config\local\database.runtime.json).Path
$adminDb = (Resolve-Path .\config\local\database.admin.json).Path
$packageTool = (Resolve-Path .\artifacts\wdwelt-package\tools\wdwelt.ps1).Path
```

如果 Administrator PowerShell 找不到 `node`，直接指定普通 terminal 中 `where.exe node` 顯示的完整路徑，例如：

```powershell
$nodePath = 'C:\Program Files\nodejs\node.exe'
```

只對目前 Administrator terminal 放寬 `.ps1` 執行限制：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

這不會永久修改整台電腦的 policy。

## 29. 正式安裝

確認已備份資料，且 `$lanIp` 與 MySQL service name 正確，再執行：

```powershell
& $packageTool install `
  -InstallPath 'C:\ProgramData\WDWELT' `
  -CanonicalHost $lanIp `
  -AllowedRemoteAddress '192.168.0.0/22' `
  -NodePath $nodePath `
  -MySqlServiceName 'MySQL80' `
  -DatabaseConfigPath $runtimeDb `
  -AdminDatabaseConfigPath $adminDb
```

Installer 會依序：

1. 驗證 package manifest 與每個 SHA-256。
2. 驗證 Node executable。
3. 驗證 MySQL service、`g2`、localhost bind 與 runtime account。
4. 建立 `C:\ProgramData\WDWELT`。
5. 複製並以 Windows ACL 保護兩份 DB credentials。
6. 建立 pre-migration backup。
7. 再次執行 idempotent migration。
8. 安裝 `WDWELT Boot`、`WDWELT 0700`、`WDWELT Watchdog` 與 `WDWELT DB Backup 1800` tasks。
9. 建立 local `192.168.0.18`、remote `192.168.0.0/22`、TCP `8080`、Domain／Private profile、禁止 edge traversal 的 firewall rule。
10. 啟動 WDWELT 並驗證 health。

最後應顯示：

```text
安裝成功：http://192.168.0.18:8080
```

不要關閉視窗前只看最後一行；向上確認沒有紅色 error。

---

# 第十一部分：安裝後驗證

## 30. 建立管理工具變數

一般或 Administrator PowerShell 均可執行只讀 status／health：

```powershell
$tool = 'C:\ProgramData\WDWELT\tools\wdwelt.ps1'
$config = 'C:\ProgramData\WDWELT\config\wdwelt.json'
$installed = Get-Content -Raw -Encoding UTF8 $config | ConvertFrom-Json
```

## 31. 驗證 process、health、network 與 tasks

```powershell
& $tool status -ConfigPath $config
& $tool health -ConfigPath $config
& $tool network -ConfigPath $config
```

本機 HTTP 驗證：

```powershell
Invoke-WebRequest "$($installed.canonicalUrl)/health/live" | Select-Object StatusCode,Content
Invoke-WebRequest "$($installed.canonicalUrl)/health/ready" | Select-Object StatusCode,Content
```

兩者都要回傳 `200`。`/health/live` 表示 Node process 有回應；`/health/ready` 表示 Node 與 MySQL 都可以服務。

在 Administrator PowerShell 檢查 scheduled tasks 與 firewall：

```powershell
Get-ScheduledTask -TaskName 'WDWELT*' | Format-Table TaskName,State
Get-NetFirewallRule -DisplayName 'WDWELT LAN TCP 8080' | Format-Table DisplayName,Enabled,Profile,Direction,Action
```

## 32. 在 host PC 開啟正式網址

```powershell
$installed = Get-Content -Raw -Encoding UTF8 $config | ConvertFrom-Json
Start-Process $installed.canonicalUrl
```

完成 register、login、設定一筆課表、儲存進度與備註、logout，再次 login 並確認資料仍存在。

---

# 第十二部分：從實際 iPhone 操作

## 33. iPhone 連線條件

1. iPhone 必須能經校內 routing 以來源位址落在目前已核准的 `192.168.0.0/22`；其他 VLAN 尚未獲得 IT allowlist，不能假定可用。
2. 不要使用 guest Wi-Fi。
3. PC 必須開機、連網，且不能睡眠。
4. Safari 輸入完整網址，例如：

```text
http://192.168.0.18:8080/
```

不要輸入 `http://127.0.0.1:8080/`。在 iPhone 上，`127.0.0.1` 指 iPhone 自己，不是 Windows PC。

## 34. iPhone 完整驗收

請實際完成：

1. 開啟首頁。
2. Register。
3. Login。
4. 儲存週一到週五課表。
5. 驗證現在／上一堂／下一堂。
6. 儲存進度與備註。
7. 關閉 Safari 再開啟。
8. Logout。
9. 再 Login，確認 DB 資料仍存在。

PC 自己能開、iPhone 卻顯示 connection refused 或逾時，最常見原因是使用了 `127.0.0.1`、host 尚未正確配置固定 IP、iPhone 來源不在已核准 `/22`、Windows profile 是 Public、校內 Wi-Fi 啟用 client isolation／VLAN／ACL 阻擋，或 PC 睡眠。

Client isolation／VLAN 只能由第二台裝置實測並請網管處理，程式無法從同一台 PC 自行證明。

---

# 第十三部分：重開機與日常操作

## 35. 重開機驗證

1. 關閉所有 VS Code terminals。
2. 重新啟動 Windows。
3. 等待 MySQL service 與 scheduled tasks 啟動。
4. 不要手動執行 `npm run host`。
5. 執行：

```powershell
$tool = 'C:\ProgramData\WDWELT\tools\wdwelt.ps1'
$config = 'C:\ProgramData\WDWELT\config\wdwelt.json'
& $tool status -ConfigPath $config
& $tool health -ConfigPath $config
```

6. 再用 iPhone 開啟 canonical URL。

## 36. 常用管理命令

```powershell
& $tool status  -ConfigPath $config
& $tool health  -ConfigPath $config
& $tool network -ConfigPath $config
& $tool logs    -ConfigPath $config
& $tool restart -ConfigPath $config
& $tool stop    -ConfigPath $config
& $tool start   -ConfigPath $config
```

`stop` 是明確的 manual stop，watchdog 不會立刻把它自動啟動。要恢復服務時使用 `start`。

## 37. 手動 backup

```powershell
& $tool backup -ConfigPath $config
Get-ChildItem 'C:\ProgramData\WDWELT\backups' | Sort-Object LastWriteTime -Descending | Select-Object -First 10
```

每日 `18:00` task 會建立 backup，保留最近 14 份。單機同一顆 SSD 上的 backup 無法防止整顆 SSD 故障；定期把 backup 複製到有存取控制的外部媒體。

## 38. Restore

Restore 會進入 maintenance、先建立 pre-restore backup、停止 host、還原、重跑 migration check、清除 sessions、重啟並驗證 readiness。

只有在確認 backup 檔與目標 `g2` 正確後，才於 Administrator PowerShell 執行：

```powershell
& $tool restore `
  -ConfigPath $config `
  -BackupFile 'C:\ProgramData\WDWELT\backups\g2-manual-實際時間.sql'
```

不要對 production `g2` 執行 automated restore integration test。

## 39. 安裝更新

在 source repository：

```powershell
npm.cmd install
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install\wdwelt.ps1 package -PackagePath .\artifacts\wdwelt-package
```

然後在 Administrator PowerShell：

```powershell
$tool = 'C:\ProgramData\WDWELT\tools\wdwelt.ps1'
$config = 'C:\ProgramData\WDWELT\config\wdwelt.json'
$package = (Resolve-Path .\artifacts\wdwelt-package).Path
& $tool update -ConfigPath $config -PackagePath $package
```

需要手動回到 previous release 時：

```powershell
& $tool rollback -ConfigPath $config
```

---

# 第十四部分：常見錯誤逐項排除

## `npm` 或 `node` 無法辨識

```powershell
where.exe node
where.exe npm
Test-Path 'C:\Program Files\nodejs\node.exe'
```

關閉所有 terminals 與 VS Code 後重開。如果仍不存在，重新安裝 Node.js LTS。

## `npm.ps1 cannot be loaded because running scripts is disabled`

使用 `npm.cmd install`。不要改用不明來源的 execution-policy workaround。

## `ENOENT package.json`

```powershell
Get-Location
Test-Path .\package.json
```

Terminal 不在 repository root；用 `Set-Location -LiteralPath '正確路徑'` 修正。

## MySQL `Access denied for user 'root'@'localhost'`

- 檢查輸入的是 MySQL root 密碼，不是 Windows 密碼。
- 檢查 `config/local/database.admin.json` 的 password。
- 若密碼含 `"` 或 `\`，確認 JSON escape 正確。
- 不要把密碼加在 `mysql -p密碼` command line。

## `ECONNREFUSED 127.0.0.1:3306`

```powershell
Get-Service -Name MySQL80
Get-NetTCPConnection -State Listen -LocalPort 3306
```

MySQL service 必須 Running，且 listener 必須存在。

## Installer 說 MySQL bind address 不是 localhost

重新檢查 `my.ini` 的 `[mysqld]` 有 `bind-address=127.0.0.1`，儲存後用 Administrator PowerShell 執行 `Restart-Service -Name MySQL80`。

## 找不到 `MySQL80`

```powershell
Get-Service | Where-Object Name -Like '*mysql*'
```

將實際名稱傳給 `-MySqlServiceName`。

## Port `8080` 已被占用

```powershell
$tool = 'C:\ProgramData\WDWELT\tools\wdwelt.ps1'
$config = 'C:\ProgramData\WDWELT\config\wdwelt.json'
& $tool network -ConfigPath $config
Get-NetTCPConnection -State Listen -LocalPort 8080 | Format-Table LocalAddress,LocalPort,OwningProcess
```

WDWELT 不會停止不屬於自己的 process，也不會偷偷改用 8081。先識別 owner；不要隨便結束不認識的 PID。

## PC 顯示正常，但 iPhone `ERR_CONNECTION_REFUSED`

依序確認 PC `/health/live` 是 200、iPhone URL 使用 PC LAN IPv4、兩台裝置在同一 LAN、canonical URL 正確、firewall rule 存在、PC 沒睡眠，再請網管確認 client isolation／VLAN。

## 顯示兩個或更多 network addresses

這通常是同時存在 Wi-Fi、Ethernet、VPN、Hyper-V、VirtualBox 或其他 virtual adapter。只選擇 Status Up、有 IPv4 default gateway，且對應 iPhone 所連校內網路的實體 Wi-Fi／Ethernet。不確定時不要猜。

## Installer 拒絕 Public profile

這是安全限制。先請網管確認網路應設為 Private／Domain。`-AllowPublicProfile` 不是一般排錯捷徑。

## `database.runtime.json` 不見，但 `wdwelt_app` 已存在

Bootstrap 會拒絕自行重設已存在 account 的密碼。先從安全 backup 還原 runtime config；沒有 backup 時由資料庫管理者明確處理 account。

## Laptop 關蓋後 iPhone 不能連

電腦已進入睡眠。WDWELT 無法在睡眠中的電腦提供服務。將主機接電，依學校政策設定服務期間不睡眠。

---

# 第十五部分：安全與完成檢查表

## 不可違反的安全界線

- [ ] MySQL `bind-address=127.0.0.1`。
- [ ] `3306` 沒有 LAN inbound allow rule。
- [ ] Router 沒有 port forwarding。
- [ ] `runtime/` credentials 沒有 commit、上傳或截圖。
- [ ] Node 使用 `wdwelt_app`，不是 MySQL root。
- [ ] iPhone 只使用 `http://LAN-IP:8080/`。
- [ ] Firewall local address 是 `192.168.0.18`，remote address 是 `192.168.0.0/22`，只允許 TCP 8080。
- [ ] Host PC 有穩定供電，服務期間不睡眠。
- [ ] Backups 有額外的受保護副本。

## 從零安裝完成標準

- [ ] `node --version` 與 `npm.cmd --version` 正常。
- [ ] `MySQL80` Running／Automatic。
- [ ] MySQL classic protocol `3306` 與 X Protocol 都只 listen 在 localhost。
- [ ] `g2` database 存在。
- [ ] Migration 完成且六個 tables 存在。
- [ ] `wdwelt_app@localhost` 僅有 CRUD grants。
- [ ] `npm.cmd test`、typecheck、build 通過。
- [ ] Package 建立成功。
- [ ] Dry-run 顯示正確 canonical URL。
- [ ] 正式 installer 成功。
- [ ] `/health/live` 與 `/health/ready` 都是 200。
- [ ] PC browser 可以 register／login／save。
- [ ] 實際 iPhone 可以完成完整驗收。
- [ ] Windows 重開機後服務自行恢復。
- [ ] 手動 backup 成功且知道檔案位置。

完成以上所有項目，才算是「從只有 VS Code 到實際可用的 WDWELT LAN host」。

---

# 官方參考資料

以下連結已於 2026-09-08 核對：

- Node.js 官方下載：`https://nodejs.org/en/download`
- Node.js release／LTS 狀態：`https://nodejs.org/en/about/previous-releases`
- VS Code integrated terminal：`https://code.visualstudio.com/docs/terminal/basics`
- Microsoft WinGet install command：`https://learn.microsoft.com/windows/package-manager/winget/install`
- Microsoft `New-NetFirewallRule` address scopes：`https://learn.microsoft.com/powershell/module/netsecurity/new-netfirewallrule`
- npm `ci`：`https://docs.npmjs.com/cli/commands/npm-ci/`
- npm offline config：`https://docs.npmjs.com/cli/using-npm/config/#offline`
- MySQL Installer for Windows：`https://dev.mysql.com/downloads/windows/installer/`
- MySQL Installer web／full bundle 與 offline mode：`https://dev.mysql.com/doc/mysql-installer/en/mysql-installer.html`
- MySQL 8.0 Windows installation：`https://dev.mysql.com/doc/refman/8.0/en/windows-installation.html`
- MySQL Installer configuration workflow：`https://dev.mysql.com/doc/refman/8.0/en/mysql-installer-workflow.html`
- MySQL Installer Console reference：`https://dev.mysql.com/doc/refman/8.0/en/MySQLInstallerConsole.html`
- MySQL Windows service：`https://dev.mysql.com/doc/refman/8.0/en/windows-start-service.html`
