# 安裝或修復既有 Windows／MySQL 環境

將完整專案解壓到可寫入路徑，確認 config/deployment.json 符合 IT 配置，再執行根目錄 INSTALL-OR-REPAIR.cmd，或：

```powershell
npm.cmd run setup
```

不需先 npm install，也不需自行判斷 fresh／update／repair。有效的既有 runtime credential 和資料都會保留；連線密碼失效時，installer 使用 admin credential 嘗試修復專用應用帳號。

每次修復先備份，成功才替換應用檔案。首次 Recovery 密碼以隱藏輸入初始化；重新安裝保留。部署完成必須顯示 WDWELT DEPLOYMENT SUCCESS。

詳細權限、環境、失敗回復與參數見 [安裝指南](README.md)。
