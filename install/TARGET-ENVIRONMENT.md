# 固定校內環境：一鍵安裝

此分支固定使用 `192.168.0.18:8080`，預設校內網路為 `192.168.0.18/22`、gateway `192.168.1.254`。在目標 Windows 主機的專案根目錄執行：

```powershell
.\INSTALL-TARGET-ENVIRONMENT.cmd
```

也可執行 `npm.cmd run setup:target`。腳本先安裝 npm dependencies、連接現有的本機 MySQL、確認 `g2`、建立或修復 `wdwelt_app@localhost`，然後呼叫同一套 G2 bootstrap 完成建置、封裝、備份、migration、tasks、firewall 與健康檢查。最後在 DB 初始化主復原密碼。整個流程可重跑；已設定的主復原密碼不會被覆蓋。

此環境的 MySQL root、`wdwelt_app` 與首次主復原密碼都設定為 `11335248`。資料庫憑證寫入本機忽略追蹤的 `config/local/`，主復原密碼在 `g2.recovery_config` 以 salted scrypt 保存。首次設定後若要更換主復原密碼，執行 `npm.cmd run recovery:set`；查詢狀態使用 `npm.cmd run recovery:status`。更換不需重啟 Node。

目標機需已有 Node.js／npm、MySQL Server 8.x，且 MySQL 只綁定 localhost。Windows 網卡需已配置上述固定 IP 與 gateway，TCP 8080 需可用；腳本不更改 NIC。它會要求管理員權限。先檢視不修改系統的安裝計畫，可執行 `npm.cmd run setup:target -- -PlanOnly`。

一般版 `main` 保留原有安裝方式；此固定密碼與自動佈建只存在於 `environment-setup` 分支。
