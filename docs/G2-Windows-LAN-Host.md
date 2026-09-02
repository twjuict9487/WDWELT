# WDWELT G2：單一 Windows PC LAN Host

## 架構與限制

G2 只使用一台普通 Windows PC／Laptop：Vite 產生 `dist`，同一台電腦上的 Node built-in HTTP host 監聽 `0.0.0.0:8080`，Windows Task Scheduler 負責 boot、每日 07:00 與 watchdog。沒有 Docker、VM、database、reverse proxy、cloud backend 或第二台監控主機；正式運行不使用 Vite、`npm run dev` 或 `vite preview`。

`/health` 只證明 host process 與 active build 可讀取並回應，不證明瀏覽器 localStorage、Firewall、學校 LAN 或另一台裝置一定正常。若 host 完全停止或 LAN 無法連線，瀏覽器只能顯示自己的連線錯誤；尚未載入的 WDWELT 不可能自行顯示客製故障頁，應使用 `status`、`health`、`network` 與 logs 診斷。

## Build 與 package

開發機需要 Node 與現有 npm dependencies：

```powershell
npm.cmd install
npm.cmd run build
.\wdwelt.ps1 package -PackagePath .\artifacts\wdwelt-package
```

`npm run build` 先 typecheck、再執行 Vite production build，最後由 `package.json` version 與當次 UTC timestamp 產生唯一的 `dist/build-metadata.json`。Package 包含 production files、Node host、管理工具、manifest 與 SHA-256 checksums。

Target PC 不需要 Vite或完整開發環境，只需要 Windows PowerShell、Windows 原生管理元件，以及能執行 host 的 Node runtime。Installer 不會自行從網站下載 executable；Node 必須由使用者明確安裝，或以 `-NodePath C:\path\to\node.exe` 提供。安裝完成後日常運行不需要 Internet。

## 第一次安裝

先以 dry-run 查看，不會修改系統：

```powershell
.\artifacts\wdwelt-package\tools\wdwelt.ps1 install -InstallPath C:\ProgramData\WDWELT -CanonicalHost 192.168.1.50 -DryRun
```

實際安裝需以 Administrator PowerShell 執行。Installer 會檢查 package、Windows／Node、建立 `current`、`previous`、`config`、`logs`、`run`、`tools`，建立 idempotent tasks 與最小 TCP 8080 LocalSubnet Firewall rule，啟動後核對 `/health` version/build。若目前 network profile 是 Public，預設停止；只有理解風險後才可明確使用 `-AllowPublicProfile`。

LAN IPv4 若有多個候選、VPN 或虛擬網卡，installer 不會猜測，必須明確指定 `-CanonicalHost`。固定 port 不代表固定 IP。真正固定 URL 需要網管 DHCP reservation、合法 static IP，或 LAN 確實可解析的 hostname；WDWELT 不會修改 Windows IP 設定，也不能保證 DHCP 地址不變。

## 單一管理入口

管理 script 可從任何 working directory 執行，但要用正確的 script 路徑；下例假設目前位於 installed `tools`。相對參數以 script 目錄為基準，config 內相對路徑以 config 目錄為基準，路徑可包含空白。Installed environment 可加 `-ConfigPath C:\ProgramData\WDWELT\config\wdwelt.json`：

```powershell
.\wdwelt.ps1 start
.\wdwelt.ps1 stop
.\wdwelt.ps1 restart
.\wdwelt.ps1 ensure
.\wdwelt.ps1 health
.\wdwelt.ps1 status
.\wdwelt.ps1 recover
.\wdwelt.ps1 network
.\wdwelt.ps1 logs
.\wdwelt.ps1 power
```

`start` 清除 manual-stop、避免 duplicate、啟動 production host，只有 health 成功才回報完成。`stop` 建立帶 timestamp 的 manual-stop marker，以 PID、Node path／command line、port owner或 host control token 驗證 instance，先送 local control request，逾時且仍可驗證才強制停止；不會使用 `taskkill /IM node.exe`。`restart`、`recover`、`update`、`rollback` 使用具 owner、timestamp、expiry 的 maintenance lock。Expired lock 與 stale PID 會被安全處理；未知 port owner只會報錯，不會被停止。

Manual stop 持續到 Start／Restart、Windows 下一次 boot task，或每日 07:00 fallback。Watchdog 使用集中設定的 interval、timeout、threshold 與 cooldown，使用 exclusive guard 避免重疊；manual-stop 與有效 maintenance lock 期間不介入，healthy 時不重複寫 log。

## Windows tasks 與 07:00

Task names 固定為 `WDWELT Boot`、`WDWELT 0700`、`WDWELT Watchdog`，重跑以 `/F` 更新同名 task，不建立 duplicate；multiple-instance policy 為 IgnoreNew。Boot 使用有限 retry/backoff。每日 07:00 會清除前一天 manual-stop：若 health 已正常就不重啟，否則 recovery。Watchdog 達 failure threshold 且通過 cooldown 才 recovery。

Task Scheduler 只能在 Windows 已開機時執行。若硬體與 Windows 允許 wake timer，07:00 task 可能從 sleep 喚醒；它不能保證從完全 shutdown 自行開機。完全關機自動開機通常需要 BIOS/UEFI RTC power-on，本次不實作。Laptop 沒電、拔除電源、網路中斷、Wi-Fi client isolation 也不是程式能自行修復的問題。

## Status、network、logs 與 power

`status` 顯示 running/health/PID/listen address/canonical URL/LAN candidates/version/build/uptime/markers/releases/tasks/recent error；無法確認就明確顯示「無法確認」，不會把 process 存在但 health 失敗寫成正常。

`network` 檢查 IPv4 candidates、canonical host、8080 owner、localhost health、Windows network profile、Firewall、hostname resolution 與多網卡／VPN warning。它只會區分「本機 WDWELT 正常」、「本機 LAN 設定看起來可用」與「另一台裝置實際連線尚未驗證」。請使用同一 LAN 的第二台手機／電腦實際開啟 canonical URL；host PC 無法證明 school Wi-Fi 沒有 client isolation、VLAN 封鎖或其他網路限制。

Logs 位於 build 外的 `logs`，每筆包含 timestamp、level、event、version/build、message；依大小 rotation 並按 retention 清理。清理只匹配 WDWELT log directory內的 rotated filenames，rotation 失敗不會使 host crash。

`power` 預設只 audit AC sleep、hibernate、wake timer、lid action 與供電狀態。只有 `power -Apply` 才列出並套用插電模式所需調整；不改 battery、BIOS/UEFI，無法確認的硬體能力不會被宣稱可用。

## Update、rollback 與 recovery

Updater 只接受明確指定的本機 package directory，不使用 GitHub、Internet 或背景下載：

```powershell
C:\ProgramData\WDWELT\tools\wdwelt.ps1 update -PackagePath D:\WDWELT\new-package -ConfigPath C:\ProgramData\WDWELT\config\wdwelt.json
C:\ProgramData\WDWELT\tools\wdwelt.ps1 rollback -ConfigPath C:\ProgramData\WDWELT\config\wdwelt.json
```

Update 在停止 current 前完成 manifest、checksum、metadata、index 與 host 驗證，stage 到 current 外，取得 maintenance lock，再 stop → current 保存為 previous → 啟用新版 production/host → start → 核對預期 version/build。新版失敗時停止失敗 release、恢復 previous host/build 並驗證；成功時明確回報 `Update failed; previous release restored.`。若 previous 也失敗，保留 logs 與 release artifacts、回傳 non-zero，絕不宣稱 rollback 成功。

Manual rollback 先顯示 current/previous version/build，沒有 previous 時安全失敗且不停止服務；只維護 current/previous，不建立無限 release history。Config、logs、runtime state 與管理工具不由 build replacement 清除。

`recover` 依序 inspect → 尊重 manual stop／maintenance lock → 處理 stale state → 只停止已驗證的 broken WDWELT → 驗證 release/config → start → health/version verify。它不刪除 config、logs、current 或 previous，也不停止未知程序。

## localStorage origin

**localStorage 位於每一個開啟 WDWELT 的瀏覽器，而不是 host PC 的 production build 資料夾。更換 build 不應清除資料；但更改 protocol、hostname/IP 或 port 會形成不同 origin，使原資料看起來消失。**

因此 canonical URL 與 port 在 update 中保持不變。每台裝置、每個瀏覽器各自保存 Storage v2，沒有 account、sync、host-side progress storage、Export／Import 或 cross-origin migration。

## 常見故障順序

1. `.\wdwelt.ps1 status`
2. `.\wdwelt.ps1 health`
3. `.\wdwelt.ps1 logs`
4. `.\wdwelt.ps1 network`
5. 確認 PC 已開機、接電且未 sleep，Node runtime path 可用
6. 確認 canonical host 未因 DHCP 改變
7. 用第二台裝置實測 canonical URL
8. 若本機 unhealthy，且非 manual stop／maintenance，執行 `.\wdwelt.ps1 recover`

不要為了排錯停止所有 `node.exe`；Port 8080 若由未知 process 占用，先識別 owner。
