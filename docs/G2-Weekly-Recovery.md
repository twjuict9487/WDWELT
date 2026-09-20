# G2：本週課程與密碼復原

首頁在 LAST／CURRENT／NEXT 下方顯示星期一至星期五每個課表位置，依節次排序。同一課程共用進度與備註；點擊使用既有進度編輯器，正式資料來自帳號 API。

## 資料庫主復原密碼

`003_recovery_config.sql` 新增單列 `recovery_config`。除固定識別欄位外，只保存 `password_hash`、`salt`、`hash_parameters`、`updated_at`，沿用帳號的 salted scrypt，不保存明文，也不依賴作業系統環境設定。

```powershell
npm.cmd run recovery:status
npm.cmd run recovery:set
```

可加上 `-- -ConfigPath <administrative-config-path>` 指定主機 administrative config。Status 只顯示配置狀態與更新時間。Set 使用隱藏輸入及二次確認，密碼透過匿名 stdin pipe 傳入後端，不寫入命令列、檔案或 log。密碼規則沿用帳號的 3–256 字元。

`install/recovery.ps1 -Mode initialize` 已有設定時保留，沒有設定時提示 Set Master Recovery Password 與確認；非互動模式缺少設定會停止。

輪替在同一交易更新雜湊並清除所有 reset tokens。API 每次讀取 DB，不需重啟 Node、Windows 或重建排程。驗證與輪替共用資料列鎖，防止輪替後再使用舊密碼建立權杖。

## 網頁與診斷

POST `/api/auth/recovery/verify` 驗證帳號與主復原密碼，建立 10 分鐘 reset-only cookie（HttpOnly、SameSite=Strict、Path=/api/auth/recovery）。DB 只保存 token 的 SHA-256。

POST `/api/auth/recovery/reset` 在交易中更新密碼並刪除帳號所有 sessions 和 reset tokens。只能成功使用一次，不自動登入，也不能把 reset token 當 session。

GET `/api/auth/recovery/status` 只回傳 `{"available":true}` 或 `{"available":false}`。DB 故障時回 503 與 false；缺少設定時 verify 回 503。帳號不存在與密碼錯誤使用相同訊息。

Log 區分 recovery_config_missing、recovery_verify_failed、recovery_verified、recovery_token_invalid、recovery_reset_success、recovery_database_error，不包含 credential、hash、salt、token、SQL detail。

Runtime 帳號需要讀取 recovery_config 及讀寫 password_reset_tokens；g2.* CRUD grants 已涵蓋。備份還原保留主復原設定，清空 sessions 與 reset tokens。
