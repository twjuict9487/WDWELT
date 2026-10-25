# WDWELT｜今天上到哪

教師的手機課表與教學進度工具。資料保存在 Windows 主機的 MySQL，支援校內 LAN 與可選的 Tailscale Funnel HTTPS。

原始碼版本 **0.3.0012** · G2 Pilot · [完整操作參考](docs/Operations.md)

> [!IMPORTANT]
> **安裝／更新看下表；只是查看程式或執行測試，不需要啟動服務。**
> 這份 checkout 的 `dist/` 可能正被網站使用，一般 Build 或部署會覆寫它；驗證請用下方的隔離 Build。

## 安裝或啟動

先進入正確資料夾，再開啟 PowerShell。**Repository 和解壓後的 target kit 雖有同名命令，作用不同。**

| 情況 | 在哪裡執行 | 命令 |
| --- | --- | --- |
| 已有 Node.js、MySQL 和帳號，安裝／更新 Windows Host | Repository 根目錄 | `npm.cmd run setup` |
| 尚未安裝 Node.js／MySQL | Repository | 雙擊 `install/START-WDWELT.cmd`；[先看前置條件](install/README.md) |
| 使用下載的部署包 | 解壓後包含 `setup.ps1`、`payload.zip` 的資料夾 | `npm.cmd run setup` |
| 部署包已完成安裝，只要啟動／確認 Host | 同一個解壓資料夾 | `npm.cmd run host` |
| 已設定好的開發環境，手動以前景方式執行 | Repository 根目錄 | `npm.cmd run host`；**不是常駐安裝** |

安裝可能要求 **Windows 管理員權限**，並更改工作排程、防火牆及 MySQL 設定。先閱讀 [安裝入口](install/README.md)，不要為了「試看看」執行 setup。

### 確認服務是否正常（不會啟動網站）

```powershell
curl.exe -sS --fail-with-body http://127.0.0.1:8080/health/ready
echo $LASTEXITCODE
```

成功應為 exit code `0`，JSON 包含 `status: "ok"`、`database: "ok"`。503 表示尚未 ready；`/health/live` 成功只代表 Node 存活。

## 平常需要的文件

| 要做什麼 | 看哪裡 |
| --- | --- |
| 安裝、更新、校內固定 IP | [安裝入口](install/README.md) |
| 常駐、自啟、watchdog、備份／還原 | [Windows Host 維運](docs/G2-Windows-LAN-Host.md) |
| 個人筆電提供外網 HTTPS | [Tailscale Funnel](docs/G2-Tailscale-Funnel.md) |
| 通知、30 天登入、資料完整性、開發驗證台 | [操作與驗證參考](docs/Operations.md) |
| 啟用課堂活動與授權角色 | [課堂活動](docs/Classroom-Activities.md)；預設關閉，舊帳號不自動取得新角色 |
| 判斷哪些檔案能清理 | [資料夾與產物規則](docs/Repository-Layout.md) |

## 開發驗證：不動正式網站

已安裝開發依賴後，在 repository 根目錄執行；每一步失敗就停止：

```powershell
npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Typecheck failed' }
npm.cmd test
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
npm.cmd run build -- --output runtime/learning-build
if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
```

此流程不啟動網站、不套用正式 Migration。真機通知、校內 LAN、公開 Funnel 與 Windows 自啟仍需各自在目標環境驗證。

## 版本與資料庫

`0.3.0012` = 產品系列 `0.3` + 發行版結構版本 `0012`；另保留 Build ID 辨認程式修正。

- **既有主機：** 使用 setup 升級，先備份，再補缺少的 Migration；不用逐份手動跑。
- **空白資料庫：** Build 產生的 `runtime/release-database/<Build ID>/wdwelt.sql` 僅含結構，不含正式帳號。一般安裝仍使用 setup。
- **版本確認：** 網站設定顯示 Build；`/health/ready` 的 `migration` 顯示實際 DB 紀錄。原始碼版本不代表已部署。

> [!WARNING]
> 不要把全新安裝 SQL 匯入既有資料庫。不要分享 `config/local/`、資料備份或歷史 SQL。MySQL 的 3306／33060 不應對 LAN 或 Internet 開放。
