# 安裝、更新與啟動

[返回專案首頁](../README.md) · [進階安裝器參考](REFERENCE.md)

> [!IMPORTANT]
> **只需要讓已安裝的網站常駐運行，不需要 VS Code 保持開啟。** 正式安裝使用 Windows 工作排程；[常駐與維運命令](../docs/G2-Windows-LAN-Host.md)。Repository 的前景 `npm.cmd run host` 不等於常駐安裝。

## 選擇一個入口

| 環境 | 入口 | 先讀 |
| --- | --- | --- |
| 已有 Node.js、MySQL 與正式帳號 | Repository 根目錄：`npm.cmd run setup` | [既有環境安裝](EXISTING-ENVIRONMENT.md) |
| 從零安裝 Windows 主機 | 雙擊 `install/START-WDWELT.cmd` | [前置條件與完整流程](REFERENCE.md) |
| 已下載 `WDWELT-TARGET.zip` | 解壓後，在含 `setup.ps1`、`payload.zip` 的資料夾執行 `npm.cmd run setup` | [操作參考](../docs/Operations.md) |
| 校內固定 IP 環境 | Repository 的 `INSTALL-TARGET-ENVIRONMENT.cmd` | [固定環境設定](TARGET-ENVIRONMENT.md) |
| 個人筆電、外網 HTTPS | 先完成主機安裝，再配置 Funnel | [HTTPS 設定](../docs/G2-Tailscale-Funnel.md) |

## 執行前確認

- **權限：** 安裝可能要求 UAC／管理員權限，更改服務、工作排程及防火牆。
- **網路：** 校內安裝先核對 `config/deployment.json`。預設固定 IP 是 `192.168.0.18`、來源網段 `192.168.0.0/22`，不是每台電腦都能直接套用。
- **資料：** 保留 `config/local/`、MySQL 帳號與備份。既有資料升級走 setup；不匯入全新安裝 SQL。
- **部署包：** 檔案存在不代表最新。先確認封裝的 Build ID；本機歷史版本見 `artifacts/README.md`。
- **影響：** setup 是實際安裝／更新操作，可能停止或重啟網站；先安排維護時段。

## 完成後確認

```powershell
echo $LASTEXITCODE
curl.exe -sS --fail-with-body http://127.0.0.1:8080/health/ready
echo $LASTEXITCODE
```

兩次 exit code 都應為 `0`，Health 應包含 `status: "ok"`、`database: "ok"`。再用實際 LAN／HTTPS 網址測試登入，手機通知與關閉 VS Code 後的常駐也需另外驗證。

離線套件、手動封裝、還原、回滾與錯誤排除保留在 [進階參考](REFERENCE.md)。
