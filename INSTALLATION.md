# WDWELT G2 Installation

這份文件說明如何把 WDWELT 安裝到一台普通 Windows PC／Laptop，讓同一 LAN 的手機或電腦透過固定的 TCP `8080` 使用。正式環境只運行 Vite production build 與輕量 Node host，不使用 Vite dev server、Docker、VM、database 或 cloud backend。

## 1. 準備條件

Build PC 需要：

- Windows PowerShell
- Node.js 20.19+、22.12+ 或相容的新版本
- 已完成 `npm install` 的 repository

Target PC 需要：

- 一般 Windows 10／11 PC 或 Laptop
- Administrator 權限，用來建立 Task Scheduler tasks 與 Firewall rule
- 可執行 production host 的 Node runtime
- 安裝後日常運行不需要 Internet

Installer 不會自動從網站下載 executable。如果 Node 不在 PATH，可明確提供：

```powershell
-NodePath C:\path\to\node.exe
```

## 2. 建立 production package

在 repository root 執行：

```powershell
npm.cmd install
npm.cmd run build
.\wdwelt.ps1 package -PackagePath .\artifacts\wdwelt-package
```

Package 會包含：

```text
wdwelt-package/
├─ production/
├─ host/
├─ tools/
│  └─ wdwelt.ps1
└─ manifest.json
```

Manifest 包含預期 version、build 與 SHA-256 checksums。請將整個 package directory 複製到 target PC；不要只複製 `dist`。

## 3. 選擇 canonical LAN host

在 target PC 執行：

```powershell
ipconfig
```

找出實際 LAN adapter 的 IPv4，例如 `192.168.1.50`。如果有多張網卡、VPN、ZeroTier、Hyper-V 或虛擬 adapter，installer 不會自行猜測，必須以 `-CanonicalHost` 明確指定。

Port 固定為 `8080`，但 DHCP IP 不一定固定。若要長期維持同一 URL，需要網路管理員設定 DHCP reservation、合法 static IP，或 LAN 能穩定解析的 hostname。WDWELT 不會自行修改 Windows IP 設定。

## 4. 先執行 dry-run

在複製過來的 package directory 開啟 PowerShell：

```powershell
.\tools\wdwelt.ps1 install `
  -InstallPath C:\ProgramData\WDWELT `
  -CanonicalHost 192.168.1.50 `
  -DryRun
```

Dry-run 會驗證 package、Windows、Node 與 canonical host，但不會：

- 建立或修改安裝目錄
- 建立 Task Scheduler tasks
- 建立 Firewall rule
- 啟動 production host
- 修改 network 或 power settings

如果 Node 不在 PATH：

```powershell
.\tools\wdwelt.ps1 install -CanonicalHost 192.168.1.50 -NodePath D:\Runtime\node.exe -DryRun
```

## 5. 正式安裝

以 **Administrator PowerShell** 執行與 dry-run 相同的命令，但移除 `-DryRun`：

```powershell
.\tools\wdwelt.ps1 install `
  -InstallPath C:\ProgramData\WDWELT `
  -CanonicalHost 192.168.1.50
```

Installer 會：

1. 驗證 Administrator、Windows、Node 與 package checksums。
2. 建立 `current`、`previous`、`config`、`logs`、`run`、`tools`。
3. 保存固定 port 與 canonical URL。
4. 建立 idempotent boot、每日 07:00、watchdog tasks。
5. 建立限 TCP 8080／LocalSubnet 的 Firewall rule。
6. 啟動 production host。
7. 驗證 `/health` 的預期 version／build。
8. 顯示 status 與 LAN URL。

若目前 Windows network profile 是 Public，installer 預設停止。只有理解風險後才可明確加入：

```powershell
-AllowPublicProfile
```

Package 內的 installer 會由自己的位置找到 package root，不依賴 PowerShell working directory。所有明確傳入的相對路徑都以 `wdwelt.ps1` 所在目錄為基準；設定檔內的相對路徑則以設定檔目錄為基準。路徑可包含空白。從其他目錄執行時，請使用 script 的完整路徑，例如 `D:\WDWELT Package\tools\wdwelt.ps1 install ...`。

重複執行 installer 會保留既有 canonical URL 與 port；相同 release 不覆寫 `current`，不同 release 走可 rollback 的 update。任一步驟失敗時不會輸出「安裝成功」。

## 6. 安裝後檢查

```powershell
C:\ProgramData\WDWELT\tools\wdwelt.ps1 status `
  -ConfigPath C:\ProgramData\WDWELT\config\wdwelt.json

C:\ProgramData\WDWELT\tools\wdwelt.ps1 health `
  -ConfigPath C:\ProgramData\WDWELT\config\wdwelt.json

C:\ProgramData\WDWELT\tools\wdwelt.ps1 network `
  -ConfigPath C:\ProgramData\WDWELT\config\wdwelt.json
```

本機 health URL：

```text
http://127.0.0.1:8080/health
```

接著使用同一 LAN 的第二台手機／電腦開啟：

```text
http://192.168.1.50:8080/
```

`network` 只能檢查本機設定，不能證明 school Wi-Fi 沒有 client isolation、VLAN 限制或其他裝置真的能連入；第二台裝置的實際測試不可省略。

## 7. 日常命令

```powershell
.\wdwelt.ps1 start
.\wdwelt.ps1 stop
.\wdwelt.ps1 restart
.\wdwelt.ps1 health
.\wdwelt.ps1 status
.\wdwelt.ps1 network
.\wdwelt.ps1 logs
.\wdwelt.ps1 recover
.\wdwelt.ps1 power
```

Installed environment 執行時加上其 `-ConfigPath`，或直接從預設 `C:\ProgramData\WDWELT` 使用。

## 8. localStorage 注意事項

localStorage 位於每一個開啟 WDWELT 的瀏覽器，不在 host PC 的 production build directory。

- 更新或 rollback build 不應清除瀏覽器資料。
- 更換 protocol、hostname／IP 或 port 會形成不同 origin。
- Origin 改變後，舊資料可能看起來消失，但不是被 updater 刪除。
- 不同手機、電腦或瀏覽器的資料不會自動同步。

## 9. 07:00 與電源限制

Task Scheduler 只能在 Windows 已開機時執行。若硬體與 Windows 允許 wake timer，它可能從 sleep 喚醒；不能保證從完全 shutdown 自行開機。完全關機自動開機通常需要 BIOS／UEFI RTC power-on，本專案不會修改 BIOS／UEFI。

Laptop 沒電、拔除電源、網路中斷或 Wi-Fi client isolation 也不是 installer 能自行修復的問題。

更完整的管理、update、rollback、recovery、logging 與 troubleshooting 說明請見 [docs/G2-Windows-LAN-Host.md](docs/G2-Windows-LAN-Host.md)。
