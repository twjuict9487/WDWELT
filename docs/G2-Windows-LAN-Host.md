# WDWELT G2：單一 Windows PC LAN Host 操作文件

## 架構

同一個 Node process 監聽 `0.0.0.0:8080`，提供 production static frontend、`/api/*` 與 `/health*`；同機 MySQL Windows service 只監聽 `127.0.0.1:3306`。Browser 永遠不會取得 DB credential。沒有 Docker、VM、nginx、Redis、SQLite、PostgreSQL、cloud DB 或第二台監控機。

Application data 的唯一來源是 MySQL。舊 `today-progress-g1:v2` localStorage 保留但不讀寫、不自動匯入；theme／font size 仍使用 preference key。

## 固定校內網路政策

以下值由 `install/deployment.settings.json` 提供；換部署環境時只修改該檔案並重新執行 installer，不必改 PowerShell 程式碼。目前核准值為：

IT 已指定 production host：

```text
IP:       192.168.0.18
Prefix:   /22 (255.255.252.0)
Gateway:  192.168.1.254
URL:      http://192.168.0.18:8080
```

Bootstrap 與正式 installer 不再從 DHCP／VPN／測試網路 candidates 選 canonical address。正式寫入前必須確認 Windows 已有上述 IP、prefix 與 gateway；不符合就停止，且不自行修改 NIC、route 或 DNS。

WDWELT 建立的 inbound rule 固定為 TCP `8080`、local `192.168.0.18`、remote `192.168.0.0/22`、Domain／Private profile，並阻擋 edge traversal。它不建立 port forwarding、UPnP、public tunnel、reverse proxy 或 MySQL LAN rule。`3306` 仍只監聽 localhost。

目前只知道 `192.168.0.0/22` 已核准。若合法教師裝置位於其他 routed VLAN，這條規則會阻擋連線；必須由 IT 提供額外 CIDR／range，再以 installer 的 `-AllowedRemoteAddress` 明確加入。不可用 `Any`、`Internet` 或 `0.0.0.0/0` 代替。

正式 runtime 只需要本機 Node.js、packaged `node_modules`、production files 與 localhost MySQL，不呼叫外部 API／CDN／updater。WinGet、Node/MySQL 下載與 npm registry 都只是 installation-time dependency；完全無外網部署方式與 offline cache 準備命令見 `install/README.md`。

## 日常命令

```powershell
$tool = 'C:\ProgramData\WDWELT\tools\wdwelt.ps1'
$config = 'C:\ProgramData\WDWELT\config\wdwelt.json'
& $tool start -ConfigPath $config
& $tool stop -ConfigPath $config
& $tool restart -ConfigPath $config
& $tool health -ConfigPath $config
& $tool status -ConfigPath $config
& $tool network -ConfigPath $config
& $tool logs -ConfigPath $config
& $tool recover -ConfigPath $config
& $tool backup -ConfigPath $config
```

相對 CLI path 以 script 所在目錄解析；config 中的相對 path 以 config 檔所在目錄解析。這使工具可從任意 working directory 執行，也能處理含空白的路徑。

`start` 只要 `/health/live` 成功就保留 Node；DB 暫時 unavailable 時 API／ready 回 `503`，pool 會以 bounded backoff 重連。Watchdog 也只用 liveness 決定是否重啟 Node；live 正常但 ready 失敗時不進入 Node restart loop，僅嘗試啟動 configured MySQL service。Manual stop、maintenance lock、unknown port owner、stale PID 與 cooldown 都有獨立保護。

## Health 與 status

- `/health/live`：Node、active build 與 memory／uptime；DB 掛掉仍是 `200`。
- `/health/ready`：有 timeout 的 DB check，並驗證必要 migration checksum；DB unavailable 或 schema 不符時為 `503`。
- `/health`：完整 version/build/app/database/current migration；degraded 為 `503`。

Health 不回傳 DB user、password、connection string、Windows username 或 filesystem path。

`status` 顯示 Node PID／listen address、liveness、readiness、MySQL service、DB connection、current migration、last DB check、last backup、current／previous release、tasks 與最近錯誤。`network` 顯示 LAN candidates、8080 owner、firewall 與本機 live／ready，但無法證明 school Wi-Fi 沒有 client isolation。

## Tasks、logs 與電源

Tasks 為 `WDWELT Boot`、`WDWELT 0700`、`WDWELT Watchdog`、`WDWELT DB Backup 1800`；重裝會更新同名 task，不建立 duplicate，multiple instance 為 IgnoreNew。

Logs 位於 build 外，記錄 register/login/logout、DB connect/unavailable/reconnect、migration、backup、restore 與 lifecycle event；不記錄 password、hash、salt、raw token、cookie、DB password 或 progress/note body。

Task Scheduler 只能在 Windows 已開機時執行。Wake timer 不保證能從完全 shutdown 開機；BIOS／UEFI RTC power-on 不在本專案範圍。`power` 預設只 audit，只有明確 `power -Apply` 才更改插電模式設定。

## Update 與 rollback

```powershell
& $tool update -ConfigPath $config -PackagePath 'D:\WDWELT\new-package'
& $tool rollback -ConfigPath $config
```

Update 順序是 package checksum validation → pre-migration DB backup → maintenance lock → stop → migration → activate staged production/host/DB tools → `/health/ready` version/build verification。Migration 是 forward-only；若新版啟動失敗，檔案 release 會 rollback，但已成功的 DB migration 不會自動 downgrade。這是刻意避免 destructive schema rollback。

Config、credentials、logs、backups 與 runtime state都在 release directories 外。Rollback 只維護 current／previous，不建立無限 history；未知 process 永不會被工具停止。

## Backup 與 restore

Backup 使用 `mysqldump --single-transaction` 與受保護的 temporary option file，密碼不出現在 process command line。成功必須 exit code 0、非空、包含 `users`，正常 G2 backup 也必須包含 migration ledger；retention 只刪除 backup directory 中符合 WDWELT filename pattern 的舊 dump。

Restore 只接受明確本機 `.sql` file，會先備份、maintenance、stop、restore、migration check、清除 sessions、start、ready check。失敗不會宣稱成功；production restore 必須由操作者明確執行。

## 故障排查

1. 執行 `status`：先分清 Node liveness 與 DB readiness。
2. `live` 失敗：看 port owner、PID、release files 與 host log，再執行 `recover`。
3. `live` 正常、`ready` 503：看 `MySQL80` service、`127.0.0.1:3306` listener、credential ACL、migration 與 operations log；不要反覆重啟 Node。
4. 本機皆正常但手機 `ERR_CONNECTION_REFUSED`：核對手機使用 PC 的 LAN IPv4（不是 `127.0.0.1`）、TCP 8080 firewall、兩台裝置同 LAN、client isolation／VLAN。
5. 不要用 `taskkill /IM node.exe`，也不要開放 MySQL 3306 給 LAN。
