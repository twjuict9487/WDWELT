# WDWELT G2：個人 Windows Host 與 Tailscale Funnel HTTPS

此模式是既有校內 LAN 部署之外的可選入口。Node 與 MySQL 架構不變：WDWELT 只在筆電的 `127.0.0.1:8080` 提供 HTTP，Tailscale daemon 在公開的 `.ts.net` 網址終止 HTTPS，再反向代理到 loopback。TCP 8080 與 MySQL 3306 都不直接公開到 Internet。

```text
Internet browser
    │ HTTPS :443
    ▼
Tailscale Funnel / TLS
    │ HTTP 127.0.0.1:8080
    ▼
WDWELT Node
    │ MySQL 127.0.0.1:3306
    ▼
MySQL g2
```

## 安全邊界

- Funnel backend 必須綁定 `127.0.0.1`；不接受 `0.0.0.0`、LAN IP 或 Tailscale IP。
- 公開 origin 必須是無 path／query／credential 的 `https://<device>.<tailnet>.ts.net`。
- Session 與 reset cookies 維持 `HttpOnly; SameSite=Strict`，Funnel 模式額外加入 `Secure`。
- 所有 POST／PUT／PATCH／DELETE API 必須帶完全相同的 HTTPS `Origin`；直接對 loopback 發出的跨 origin 寫入會得到 403。
- 公開模式預設關閉帳號註冊和 Master Recovery API。帳號應先在可信環境建立；Recovery 可由管理者明確選擇開啟。
- 公開登入每個正規化帳號每 15 分鐘最多 10 次嘗試；若公開開啟 Recovery，驗證每個帳號每 15 分鐘最多 5 次。
- Funnel 登入拒絕少於 12 字元的既有弱密碼；公開 Recovery Key輸入至少需要 20 字元。LAN 模式仍保留原本 pilot 相容性，啟用外網前應先在可信環境更新弱密碼。
- 不存在的帳號仍執行一次 dummy scrypt，降低以 response timing枚舉帳號的差異。
- Session token 與 reset token仍只以 SHA-256 digest 儲存在 DB；reset token限 10 分鐘、單次使用、只能走 recovery path。
- MySQL config loader繼續拒絕非 localhost host；不得新增 TCP 3306 inbound firewall rule。
- Funnel URL 是公開 Internet 入口，不等於只有 tailnet 成員能存取。若只需要私人 tailnet 存取，應使用 Tailscale Serve，而不是 Funnel。

## 前置條件

1. Windows 已安裝 Tailscale，並已登入自己的 tailnet。
2. MagicDNS 與 tailnet HTTPS 已啟用。
3. Tailnet policy 允許這台裝置使用 Funnel。
4. Node.js、MySQL、`config/local/database.runtime.json` 與 production build 已可正常使用。

`-Mode Enable` 會在呼叫 Tailscale 前以 `netstat` 驗證 WDWELT 只監聽 `127.0.0.1:8080`，且 MySQL classic／X Protocol 的既有 listeners只位於 localhost。若發現 `0.0.0.0:3306`、`[::]:3306` 或其他非 loopback listener，流程會停止且不啟用 Funnel。

Tailscale 官方限制 Funnel 只能使用 TLS 與 `.ts.net` DNS，公開 listen port只能是 `443`、`8443` 或 `10000`。本專案固定使用公開 `443`，backend仍為 HTTP `8080`。

## 操作

先查看不寫入計畫：

```powershell
npm.cmd run funnel -- -Mode Plan
echo $LASTEXITCODE
```

只產生本機 Funnel host config：

```powershell
npm.cmd run funnel -- -Mode Configure -PublicOrigin https://YOUR-DEVICE.YOUR-TAILNET.ts.net
echo $LASTEXITCODE
```

後端啟動後，可在不修改 Funnel 的情況下檢查 readiness 與 listeners：

```powershell
npm.cmd run funnel -- -Mode Check
echo $LASTEXITCODE
```

啟動 Node backend並設定持久化 Funnel：

```powershell
npm.cmd run funnel -- -Mode Enable -PublicOrigin https://YOUR-DEVICE.YOUR-TAILNET.ts.net
echo $LASTEXITCODE
```

第一次啟用 Funnel 時，Tailscale 可能要求在瀏覽器核准 tailnet policy。完成後可查看：

```powershell
npm.cmd run funnel -- -Mode Status
curl.exe -I https://YOUR-DEVICE.YOUR-TAILNET.ts.net/health/live
curl.exe -I https://YOUR-DEVICE.YOUR-TAILNET.ts.net/health/ready
```

若確定需要把 Master Recovery 暴露在公開入口，設定時必須明確加入：

```powershell
-EnableMasterRecovery
```

這會保留通用錯誤、短效 capability、Secure cookie和嘗試限制，但全域 Master Recovery Key 一旦洩漏仍可重設已知帳號；應使用足夠長的隨機值並定期輪替。一般情況建議維持預設關閉，從本機或可信 LAN 執行管理復原。

停用公開入口：

```powershell
npm.cmd run funnel -- -Mode Disable
```

這只關閉 Funnel，不會刪除資料庫、帳號、備份或本機設定。

## 驗收

必須從不在同一個 LAN 的裝置使用行動網路測試公開 HTTPS URL：

1. 憑證有效且沒有瀏覽器警告。
2. `/health/live` 與 `/health/ready` 回傳 200。
3. 登入 response cookie包含 `Secure; HttpOnly; SameSite=Strict`。
4. 登入、reload session restore、讀取課表、儲存進度、登出皆成功。
5. 從不同 Origin送出寫入要求得到 403。
6. `/api/auth/register` 與 recovery verify/reset在預設 Funnel config不可用。
7. Windows 上 8080 只監聽 `127.0.0.1`，3306 只監聽 localhost。

Repository 測試與 loopback 驗證不能代替上述真實外網裝置驗收。
