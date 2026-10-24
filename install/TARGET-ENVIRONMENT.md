# 固定校內環境：一鍵安裝

此分支固定使用 `192.168.0.18:8080`，預設校內網路為 `192.168.0.18/22`、gateway `192.168.1.254`。若裝置禁止 CMD，在目標 Windows 主機的 PowerShell 內進入專案根目錄後執行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\INSTALL-TARGET-ENVIRONMENT.ps1
```

這條 PowerShell 路徑不呼叫 `cmd.exe` 或 `npm.cmd`，而是由 `node.exe` 直接執行 npm CLI。腳本會安裝 npm dependencies、連接現有的本機 MySQL、確認 `g2`、建立或驗證最小權限的 `wdwelt_app@localhost`，然後呼叫同一套 G2 bootstrap 完成建置、封裝、備份、migration、tasks、firewall 與健康檢查。設定主復原密碼會使尚未使用的密碼重設驗證失效。

同一條命令同時用於首次安裝與更新。若 `package-lock.json` 未改變且 `node_modules` 完整，會略過 `npm ci`；即使需要安裝 dependencies，也只執行一次。若懷疑 dependencies 損壞，可加上 `-ForceDependencies` 強制重裝。需要完整開發驗證時才加上 `-FullValidation`。

安裝會建立以 `SYSTEM` 及最高權限執行的 `WDWELT Boot` 與 `WDWELT Watchdog` 工作排程。Windows 正常由 UEFI 開機並進入作業系統後，Boot task 會自動啟動服務；Watchdog 每分鐘檢查一次。此固定環境已啟用 `reclaimPort8080`，若其他程序占用 TCP 8080，watchdog 會記錄 PID 與程序名稱，依序嘗試 PowerShell `Stop-Process`、CIM `Terminate` 與 `taskkill /T /F`，等待埠釋放，再啟動並驗證 WDWELT。

部署前須預先提供受 ACL 保護的 `config/local/database.admin.json`。若該檔不存在，須由執行環境提供 `WDWELT_DB_ROOT_PASSWORD`，安裝器才會建立管理者設定。新建的 `wdwelt_app` 使用獨立隨機密碼；若既有 runtime 與管理者密碼相同，安裝會停止，不會自動重設既有帳號。主復原密碼須由執行環境提供至少 12 字元的 `WDWELT_RECOVERY_PASSWORD`，不會要求互動輸入；其雜湊保存在 `g2.recovery_config`。執行目標安裝器仍會觸發 Windows UAC，因此遠端無法核准 UAC 時，請勿執行安裝器。

目標機需已有 Node.js／npm、MySQL Server 8.x，且 MySQL 只綁定 localhost。Windows 網卡需已配置上述固定 IP 與 gateway；腳本不更改 NIC。若安裝時 TCP 8080 已由其他程序占用，目標環境會先回收該埠。它會要求管理員權限。先檢視不修改系統的安裝計畫，可在上述指令最後加上 `-PlanOnly`。

快速診斷使用：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\INSTALL-TARGET-ENVIRONMENT.ps1 -Diagnose
```

診斷會直接列出 Node、MySQL service、TCP 8080 的 PID／程序／命令列、已安裝版本與網路狀態。每次正式執行會寫入 `runtime\logs\target-setup-日期時間.log`；失敗時另產生固定路徑 `runtime\logs\LAST-ERROR.txt`，其中包含失敗階段、原因、建議處理方式、完整 log 路徑及最後 30 行輸出。

`-ExecutionPolicy Bypass` 可避開一般 PowerShell execution policy，但不能凌駕 AppLocker、WDAC 或組織的裝置管理政策。若 Windows 禁止 `powershell.exe` 或 `node.exe` 執行，必須由裝置管理員調整政策；專案內沒有能安全或可靠覆寫該政策的命令。

一般版 `main` 保留原有安裝方式；此固定密碼與自動佈建只存在於 `enviroment-setup` 分支。
