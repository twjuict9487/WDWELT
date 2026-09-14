# G2 Pilot：本週課程與密碼復原

首頁在既有 LAST／CURRENT／NEXT 下方顯示「本週課程」。資料直接使用登入後的 `GET /api/timetable` 回傳內容，依星期一到星期五及節次排序，保留每個課表位置。同一課程在多個位置共用同一筆進度與備註；點擊後開啟原有 Progress editor。儲存回傳值更新既有 account state，返回首頁即可看到最新進度。

未建立課表、當日無課或沒有進度時使用空狀態；課表／進度載入失敗沿用中央資料錯誤與重試流程，不從 localStorage 補出舊資料。

## 密碼復原

登入頁的「忘記密碼」接受帳號與主復原金鑰。`POST /api/auth/recovery/verify` 只建立 `wdwelt_reset` cookie：HttpOnly、SameSite=Strict、Path=/api/auth/recovery，效期 10 分鐘。其 32-byte 隨機 token 只在 cookie 中送回，資料庫只儲存 SHA-256 雜湊。

`POST /api/auth/recovery/reset` 使用該 cookie 與新密碼。後端獨立驗證密碼格式，沿用原有 scrypt 格式，在交易中鎖住使用者並再次檢查 token，更新密碼後移除該帳號所有 reset tokens 與既有登入 sessions。重複或同時送出只能成功一次；資料庫失敗會回復交易。成功回到登入，不自動登入。

一般 authentication 只讀 `wdwelt_session`，不接受 reset cookie；把 reset token 放進一般 session cookie 也無效。帳號不存在或金鑰錯誤顯示相同錯誤。未配置金鑰時 recovery endpoint 回傳 503，原有登入與註冊仍可使用。

本輪不包含 rate limiting、電子郵件、管理頁或額外服務。

## 部署設定

1. 先使用既有備份流程備份資料庫。
2. 使用既有 migration 工具套用新 migration（勿手動改 production schema）：

   ```powershell
   npm.cmd run db:migrate -- --config config/local/database.admin.json
   ```

   新增 `002_password_recovery.sql`／`password_reset_tokens`，含 `token_hash`、`user_id`、`expires_at`、`created_at`。既有安裝器的 migration 階段也會自動套用；主機 readiness 會核對兩份 migration 的 checksum。Runtime 帳號需對新表有既有的 SELECT／INSERT／UPDATE／DELETE 權限；`g2.*` 的 grants 已涵蓋。

3. 由主機管理者設定 **`WDWELT_MASTER_RECOVERY_KEY`**，使用至少 32 字元的隨機秘密，不能使用 `REPLACE_` placeholder。Node 啟動時從環境變數讀取，只在 backend 驗證；Vite 不讀取此值。不要放進 `src`、`VITE_*`、公開設定、migration 或 Git，也不要在命令列直接輸入明文。

   在啟動 Node 的 PowerShell 中，可使用隱藏輸入設定該程序環境：

   ```powershell
   $recoverySecret = Read-Host '輸入主復原金鑰' -AsSecureString
   $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($recoverySecret)
   try {
     $env:WDWELT_MASTER_RECOVERY_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
   } finally {
     [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
     $recoverySecret.Dispose()
   }
   npm.cmd run host
   ```

   Task Scheduler 正式主機以 SYSTEM 執行，不能只設定目前使用者或單一終端機的環境。請由管理者用 Windows 系統環境變數設定相同名稱，並用下列命令確認 Machine 值存在且格式有效；命令不會顯示金鑰：

   ```powershell
   $machineRecoveryKey = [Environment]::GetEnvironmentVariable('WDWELT_MASTER_RECOVERY_KEY', 'Machine')
   if ([string]::IsNullOrEmpty($machineRecoveryKey) -or $machineRecoveryKey.Length -lt 32 -or $machineRecoveryKey.StartsWith('REPLACE_')) {
     throw 'WDWELT_MASTER_RECOVERY_KEY 尚未正確設定。'
   }
   Remove-Variable machineRecoveryKey
   'Recovery key configuration is valid.'
   ```

   設定或輪替後重新啟動 Windows，再啟動／驗證 WDWELT，確保新的 SYSTEM／Node process 取得新值。不要只從設定前已開啟的 PowerShell 視窗執行 `restart`，該 process 可能仍持有舊環境。此專案不會自動讀取 `.env`；教師重設密碼不會修改主復原金鑰。

成功復原會使舊登入及同帳號其他復原權限失效。還原備份時也會清空 reset tokens，避免還原舊驗證權限。API log 僅記錄固定事件，不記錄 request body、金鑰、密碼、token、hash 或 SQL error detail。
