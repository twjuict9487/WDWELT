# 已備妥 Windows／Node.js／MySQL 的快速安裝

適用於 Windows 10／11 已安裝 Node.js、MySQL Server，且 IT 已建立 `g2` database 與專用帳號的環境。

## 執行方式

1. 將完整專案解壓縮到可寫入的資料夾，例如 `C:\WDWELT` 或 `Downloads\今天上到哪`。專案路徑可含空白與中文；不要直接在 ZIP 內執行。
2. 修改 `config/deployment.json`，填入這台電腦實際配置的固定 LAN IP、子網路、gateway 與允許的使用者網段。
3. 在專案資料夾的終端機執行一次：

```powershell
npm.cmd run setup
```

不需要先執行 `npm install`。此指令會自行執行 `npm ci --include=dev` 安裝 lockfile 指定的依賴、建置、封裝，接著備份、更新資料表與安裝服務。單獨執行 `npm.cmd install` 只會安裝 JavaScript 依賴。

依畫面同意 Windows UAC，輸入既有的安裝／備份帳號及程式讀寫帳號名稱與密碼，確認最終安裝位置與網址即可。密碼以隱藏輸入收取，不會放入命令列或安裝紀錄。預設安裝到 `C:\ProgramData\WDWELT`，完成後畫面會顯示 `http://設定的IP:8080/`。

帳號設定保存在受 Windows ACL 保護且被 Git 忽略的 `config/local/database.admin.json` 與 `config/local/database.runtime.json`。重跑時沿用，不會重設 MySQL 密碼、建立帳號或修改 grants。若 IT 已準備這兩個 JSON，便不會再次要求輸入。模板在 `config/database.admin.example.json` 與 `config/database.runtime.example.json`；帳號名稱可自行指定，不必是 `root` 或 `wdwelt_app`。

## 請 IT 事先確認

- Node.js 符合專案需求：20.19+、22.12+ 或 24 以上；包含 `npm.cmd`。
- MySQL Server 8.x Windows service，以及 `mysql.exe`、`mysqldump.exe` 已安裝。只有 Workbench 不足以執行服務。
- `g2` database 已建立；可以是空白，也可以是既有 G2 資料庫。安裝會先備份再執行 migration。
- 安裝／備份帳號具備 `g2.*` 的建表、變更資料表、索引、參照及讀寫、備份／還原所需權限。隔離測試使用的是 `ALL PRIVILEGES ON g2.*`，不需要 root 或讀取 `mysql.user` 的權限。若既有資料庫含額外 stored routines 等物件，IT 也須提供其備份所需權限。
- 程式帳號具備 `g2.*` 的 `SELECT, INSERT, UPDATE, DELETE`。建議與維護帳號分開；若 IT 僅提供一個有足夠權限的專用帳號，可在兩處填入相同帳號，安裝器不會改動其權限。
- 兩個帳號都能透過同一個本機 TCP port 連入 `g2`，預設 `127.0.0.1:3306`。
- MySQL `bind_address` 及啟用中的 `mysqlx_bind_address` 已限制為 localhost。此模式會檢查設定，請 IT 處理不符處，不會重寫共用 MySQL 設定。
- 固定 LAN IP、prefix 與 gateway 符合 `config/deployment.json`；網路 profile 為 Private／Domain，TCP 8080 可用，具備 Administrator／UAC 權限。
- 首次安裝需要取得 npm packages 的網路連線；正式使用只需要區域網路。主機服務期間保持開機且不睡眠。

VS Code 可用來編輯設定，但不是執行服務的必要條件。將專案放在 C 槽或 Downloads 不會改變正式安裝位置。不要搬移既有 `C:\ProgramData\WDWELT`，也不要把另一台電腦的密碼設定或 `runtime` 當成新環境設定。

## 重跑、檢查與故障排除

```powershell
# 只顯示計畫，不寫入或安裝
npm.cmd run setup -- -PlanOnly

# 有多個 MySQL service 時指定一個
npm.cmd run setup -- -MySqlServiceName MySQL80

# 已有設定檔的自動化安裝（仍可能需要 Windows UAC）
npm.cmd run setup -- -NonInteractive
```

任何必要步驟失敗都會停止；修正錯誤後重跑同一指令。不要以最後曾出現網址作為成功判斷，必須看到「WDWELT 安裝完成」。詳細紀錄在 `runtime/logs/bootstrap-日期時間.log`。安裝會驗證 migration 後的資料表和程式讀寫權限，並檢查服務健康與網路。

開發測試不需要在每次部署重跑。若使用 `-FullValidation`，隔離 DB／restore 測試還需要可建立及移除 `wdwelt_test_*` 資料庫的測試管理帳號；只有 `g2.*` 權限的正式帳號不具備此權限。一般安裝請使用預設指令。

若 Node.js、MySQL 或帳號尚未備妥，請改看 [完整安裝指南](README.md) 的 `START-WDWELT.cmd` 流程。
