# 固定校內環境：一鍵安裝

此分支固定使用 `192.168.0.18:8080`，預設校內網路為 `192.168.0.18/22`、gateway `192.168.1.254`。若裝置禁止 CMD，在目標 Windows 主機的 PowerShell 內進入專案根目錄後執行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\INSTALL-TARGET-ENVIRONMENT.ps1
```

這條 PowerShell 路徑不呼叫 `cmd.exe` 或 `npm.cmd`，而是由 `node.exe` 直接執行 npm CLI。腳本會安裝 npm dependencies、連接現有的本機 MySQL、確認 `g2`、建立或修復 `wdwelt_app@localhost`，然後呼叫同一套 G2 bootstrap 完成建置、封裝、備份、migration、tasks、firewall 與健康檢查。最後在 DB 設定固定主復原密碼；重跑也會恢復該值，並使尚未使用的密碼重設驗證失效。

安裝會建立以 `SYSTEM` 及最高權限執行的 `WDWELT Boot` 與 `WDWELT Watchdog` 工作排程。Windows 正常由 UEFI 開機並進入作業系統後，Boot task 會自動啟動服務；Watchdog 每分鐘檢查一次。此固定環境已啟用 `reclaimPort8080`，若其他程序占用 TCP 8080，watchdog 會記錄 PID 與程序名稱、執行 `taskkill /T /F`、等待埠釋放，再啟動並驗證 WDWELT。

此環境的 MySQL root、`wdwelt_app` 與主復原密碼都設定為 `11335248`。資料庫憑證寫入本機忽略追蹤的 `config/local/`，主復原密碼在 `g2.recovery_config` 以 salted scrypt 保存。若用 `npm.cmd run recovery:set` 臨時更換主復原密碼，下次執行目標環境安裝會重新設為固定值；查詢狀態使用 `npm.cmd run recovery:status`。

目標機需已有 Node.js／npm、MySQL Server 8.x，且 MySQL 只綁定 localhost。Windows 網卡需已配置上述固定 IP 與 gateway；腳本不更改 NIC。若安裝時 TCP 8080 已由其他程序占用，目標環境會先回收該埠。它會要求管理員權限。先檢視不修改系統的安裝計畫，可在上述指令最後加上 `-PlanOnly`。

一般版 `main` 保留原有安裝方式；此固定密碼與自動佈建只存在於 `enviroment-setup` 分支。
