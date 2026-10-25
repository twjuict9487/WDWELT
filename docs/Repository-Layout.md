# 資料夾與產物規則

[返回首頁](../README.md)

## 哪些是原始碼

| 位置 | 用途 |
| --- | --- |
| `src/`、`public/` | 瀏覽器介面與靜態資源 |
| `server/app/` | Host、API、驗證、推播與權限 |
| `db/` | 資料庫工具與歷史 Migration；不可為了縮短目錄而刪除 |
| `install/`、`scripts/` | Windows 部署與 Build 工具 |
| `tests/` | 可重現的單元與整合驗證 |
| `config/` | 共用設定與範例；`config/local/` 是本機私密設定 |
| `docs/` | 操作、功能與驗收參考；日常入口是根 README |

## 哪些是產物

| 位置 | 清理原則 |
| --- | --- |
| `node_modules/` | 可重建，但本機 Host 可能依賴它；不要在運行中刪除 |
| `dist/` | 可能是正在服務的網站；不是可隨手刪除的快取 |
| `artifacts/WDWELT-TARGET.zip` | 保留的部署包；以實際 metadata 確認版本，不能假設最新 |
| `artifacts/wdwelt-package/`、`wdwelt-target-kit/`、`target-kit-verify/` | 封裝與驗證中間副本；流程可重建，完成後可清理，封裝整合測試可能需要重建它們 |
| `runtime/learning-build/` | 最新隔離驗證 Build，不用它取代正式 `dist/` |
| `runtime/release-database/<Build ID>/` | 對應 Build 的全新安裝 SQL 與 checksum 清單；SQL 不含正式帳號 |
| `runtime/archive/` | 本機歷史資料與清理前封存，不加入 Git、不當成部署來源、不對外分享 |
| `runtime/backups/` | 正式資料備份；不列入一般清理 |
| `runtime/logs/`、`runtime/reports/` | 診斷／驗收證據，依保留需求整理，不直接當垃圾刪除 |
| `runtime/run/` | PID、watchdog 與執行意圖；不可僅因看似陳舊而刪除 |
| `*.tsbuildinfo` | 編譯快取，可重建 |

## 本次整理（2026-10-24）

- 封裝中間副本先壓縮到 `runtime/archive/packaging-intermediates-20261024.zip`，逐檔比對 SHA-256 成功後，才移除原副本。
- 歷史原始碼／Build 快照移到 `runtime/archive/classroom-predeployment-20261024/`。
- 原根目錄、含帳號資料的 `wdwelt.sql` 改名為 `runtime/archive/legacy-organizer-data.sql`。它是歷史資料，不是新 Build 產生的空白結構 SQL。
- 不修改正式資料庫、設定、服務、`dist/`、備份與執行狀態。

封存檔還原到獨立檢查目錄即可取回舊副本；不要直接覆寫現行設定或正式資料庫。這次清理不代表重新封裝或完成正式部署驗收。
