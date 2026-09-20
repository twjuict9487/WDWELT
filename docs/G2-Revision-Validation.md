# Recovery／Deployment revision 驗收

驗證日期：2026-09-21。這份記錄針對程式與套件修訂，不代表已部署到正式主機。

| 原始需求 | 實作與驗證依據 |
| --- | --- |
| 1 移除 recovery environment variable | source 搜尋無舊環境變數；API 每次由 DB 讀取設定；套件 CLI 輪替後同一 host 立即生效。 |
| 2 DB salted scrypt | migration 003 僅存 singleton ID、hash、salt、parameters、timestamp；與帳號共用 password module；DB 與 CLI 測試驗證。 |
| 3 初始化與保留 | PowerShell secure prompt 實測 initialize；重跑 initialize 及真正 installer 後保留設定。 |
| 4 管理 CLI | status 僅回狀態與時間；確認不符不變更；rotation transaction 清除 tokens；實際套件驗證免重啟。 |
| 5 Recovery flow | API 整合驗證 10 分鐘期限、單次使用、session 隔離、清除帳號 sessions／tokens；套件驗證 reset 與後續登入。 |
| 6 Diagnostics | public status 僅 available；六種 log 事件及 credential 不洩漏由 recovery-api 測試驗證。 |
| 7 單一入口 | INSTALL-OR-REPAIR.cmd 與 npm setup 都呼叫 bootstrap；bootstrap tests 驗證路徑與流程。 |
| 8 Auto mode | deployment-repair 涵蓋 fresh、same、older、broken；實際 installer 涵蓋安裝與重裝。 |
| 9 保留資料與設定 | migrations 重跑、現有 user／grants／recovery／runtime bytes／backups 保留測試；替換路徑僅 app、host、DB tools。 |
| 10 自動流程 | deployment.ps1 串接全部階段；deployment-database 執行實際備份、migration、runtime、recovery、host 與 HTTP gates。 |
| 11 備份失敗停止 | pre-reinstall 檔名與既有備份保留實測；fault injection 確認 backup 失敗不 stop；真實 installer 每輪產生備份。 |
| 12 失敗回復 | live／ready failure injection；真實 ready 失敗恢復前一份 app 並通過健康檢查；不執行 DB downgrade／restore。 |
| 13 保留 MySQL | bootstrap 只查既有 service；缺少時人工安裝訊息；preflight 實際連線及 bind 檢查；既有帳號測試禁止 MySQL 配置修改。 |
| 14 Runtime repair | 有效自訂設定逐位元保留；密碼失效與帳號鎖定實測修復專用 localhost account；不修改自訂 grants。 |
| 15 結果報告 | bootstrap 前置失敗報告實測；installer success／各失敗 stage／rollback／DB state 經故障注入及真實 installer 驗證。 |
| 16 App／data 分離 | app snapshot 與 DB backup 分離；安裝回復不還原 DB；文件列明持續保存與可替換內容。 |

驗證命令及環境需求見 [安裝文件](../install/README.md#開發驗證)。一般測試 88 項、資料庫整合 67 項、lifecycle 49 項、既有帳號與套件整合 13 項、部署故障注入 92 項。

隔離整合測試替代管理員檢查、service 查詢、NIC、tasks 和 firewall 佈建，不修改正式機器設定。這些正式環境 gate 保留在 installer，部署時任一 gate 失敗均不能回報成功。
