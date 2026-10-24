# 課堂活動：導入與操作

此模組為可選功能，`classroomActivitiesEnabled` 預設 `false`。開關關閉時 `/api/learning/*` 不提供功能，Organizer 繼續運作。以下為部署時的操作文件，本次開發不自動執行正式 migration、creator 指派或重啟。

## 導入

1. 使用既有備份工具，確認備份成功並保留 SHA-256。勿將 migration 當成可自動 rollback 的交易。
2. 由管理連線執行既有 migration runner。011 新增 workspace／授權／班級／邀請／通知／audit；012 新增活動、名單、分組、評分項目、回合、資格與原始提交。不修改 001–010，不改既有 users 的角色。
3. 查明確帳號 ID，以本機管理 CLI 指派 creator。不能靠名字或註冊先後自動取得 creator。

```powershell
npm.cmd run db:migrate -- --config config/local/database.admin.json
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 把 123 改成已確認的既有帳號 ID；不是要求建立此帳號。
npm.cmd run learning:creator -- --config config/local/database.admin.json --user-id 123 --confirm CREATOR:123
echo $LASTEXITCODE
```

此 CLI 需要可讀取管理設定的本機權限；不使用 UAC 自啟。重跑不建立重複 creator。撤銷加上 `--revoke`。不得把正式 credentials 放在測試 fixture。

4. 在實際 Host 設定加入 `"classroomActivitiesEnabled": true`，沿用已驗證的 `canonicalUrl`／Funnel `publicOrigin`。依正常部署流程重啟。不要修改 8080、18081 或 MySQL listener。
5. 登入 creator → 設定 → 課堂活動 → 建工作空間 → 人員授權。搜尋顯示 ID／username／既有顯示名稱後指派 manager。manager 同樣指派 teacher，建立班級並指派確切教師 ID。

Runtime 沿用既有 `SELECT, INSERT, UPDATE, DELETE ON g2.*`，包含新表；不需要全域權限、DDL 或額外 MySQL listener。新模組獨立驗證 011／012 checksum，未就緒顯示不可用，既有 core health 的必要 migrations 不增加新模組要求。

可設定 `classroomActivityLimits`：`lookup` 預設 600／分鐘、`mutations` 60／帳號／分鐘、`display` 10／帳號／分鐘、`submit` 30／帳號／分鐘。既有 general API 限流仍適用。Funnel 匿名 lookup 是共用安全桶，不能用來辨識個人；已登入操作以帳號為主。所有限制回 429 和 Retry-After。

啟用課堂活動時 MySQL pool 仍使用預設五條連線，等候佇列至少 100，讓四十人同時提交可以等待交易完成；停用模組仍沿用原本 queue 20。DB 設定可指定 `queueLimit`（1–1000），不是無界佇列。

## 管理員與教師

- 班級名稱可相同，所有操作按 ID 隔離；私人 courses 與 classroom 不做自動映射。
- manager 建立七天父政策（API 可指定 1–30 天），教師只能在有效政策下產生十五分鐘展示 token。重新展示產生新秘密，只回傳一次；DB 保存 hash。
- QR 用本機 qrcode library 生成，不使用第三方服務。連結為 `/join/#token`，fragment 不送進 HTTP path、query 或請求 log；登入前預覽只顯示 workspace／班級名稱與狀態，登入後按確認才加入。登入和註冊不改邀請 fragment，不處理任意外站 return URL。
- 本機 canonicalUrl 只適合本機測試；手機必須使用已設定的 LAN／公開 HTTPS origin。UI 提醒 loopback 限制。
- 撤銷政策、封存班級、撤銷教師指派或工作空間角色會使相關展示碼失效；重授權不延長已失效碼。其他教師的有效碼保留。
- 教師在授權班級建立活動，填台北日期／時間。draft 名單來自當時班級成員；可同步新增、排除、分組、改名與上下移動。至少兩個非空組、無未分組學生、1–10 個項目才可開始。
- 預設內容／表達／合作，各 1–5 整數、等權重。live 不可改名單、組員或 rubric；過期 version 回 409。
- 管理員操作教師活動時必須勾選「授權管理模式」，所有操作記錄 actor、scope 與動作。
- 依序開始報告 → 開放互評／QR → 查看已收／資格快照人數 → 關閉 → 下一組。尚未交齊先顯示未交數並確認；也可提前結束整場，原子關閉正在 collecting 的回合。
- 已結束／取消不能重開；可複製成新 draft，重新確認名單與時間。50 分鐘不是系統強制截止。
- 教師結果顯示總平均、各項平均、有效／收到／作廢份數，可按需展開 50 筆明細，作廢須填理由。評分不刪除、不重開補投。結束後手動發布／收回彙總。

## 學生

登入 → 開啟加入連結 → 確認以學生加入 → 我的班級／活動。重掃不重複 membership 或通知；加入政策／教師已失效則拒絕，不會半加入。Web Push 不必啟用。

開啟教師的互評 QR → 確認對象／自己的組 → 選 1–5 分、留言選填 → 確認送出。教師可查看評分者與原始留言；不宣傳匿名。不能自評或修改已提交內容。

輸入只留在目前頁面記憶體；斷線錯誤保留輸入和 request key，重試不重複計票。成功後顯示 receipt；刷新／重登入仍可讀取自己的 receipt。活動結束後，已成功相同 request 重送仍回原收據，新提交拒絕。當頁關閉前未成功的輸入不保證保留。

學生看不到教師原始明細。結果預設未發布，發布後只有組別彙總，沒有其他人的留言或 reviewer ID。班級移除／停用帳號立即停止新投票；已收到的原始資料保留。未曾列入活動的學生可離班。

## 資料、競態與恢復

`workspace → classroom → activity → round → evaluation` 是寫入鎖順序。角色與班級 mutation 也先鎖 workspace，與評分資格異動序列化。停用帳號讀取 user share lock。交易只做資料庫工作，deadlock 最多重試兩次。每回合評分者唯一鍵與 request key 唯一鍵防止重複。

活動列維護 active group pointer，最多一組 presenting／collecting。回合保存開放時資格快照，後續移除或停用不回改分母。原始分數皆保留，MySQL 以 decimal 求平均，顯示時才取兩位；未交不算零，零份顯示尚無評分。

教師活動輪詢約五秒，學生約十秒；隱藏頁面暫停，失敗退避最多六十秒，離頁取消。重新載入會重新讀 DB。課堂模組不新增 WebSocket 或離線同步引擎。

關旗標並正常重新啟動即可停止模組；資料保留，重新啟用不重開截止活動。回舊程式時保留新表，不執行 destructive down migration。還原必須使用涵蓋新模組的完整備份，先在隔離資料庫驗證；不要直接匯入舊 `wdwelt.sql` 覆蓋已有活動的主機。

## 隔離驗證與 demo fixture

```powershell
npm.cmd test
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
npm.cmd run build -- --output runtime/learning-build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# 不用正式 credential；建立自己的 temporary datadir、隨機 loopback port。
npm.cmd run test:learning -- "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqld.exe" --browser --regression
echo $LASTEXITCODE
```

Fixture 帳號為 fixture-1～fixture-50，密碼僅限暫存實例的 `fixture-password-only-2026`；1=creator、2=manager、3=teacher，其餘作測試學生。這不影響正式帳號。腳本 finally 關閉自己產生的 HTTP/MySQL process，只刪除自己 `mkdtemp` 建立且驗證位於 TEMP 的目錄；不能指定任意 DB／datadir。`--browser` 使用已安裝 Microsoft Edge 的 headless 模式、隔離 cookie jars 與 390px 手機寬度。QR 解碼與真機掃描分開驗收。

若測試被強制終止，依終端報錯的 TEMP 路徑與測試專屬 PID 查明後再清理；不得停止系統 MySQL80 或刪除正式資料。

完整 API 參考：[Classroom-API.md](Classroom-API.md)。實際驗證結果與未完成矩陣：[Classroom-Implementation.md](Classroom-Implementation.md)。
