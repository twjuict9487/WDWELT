# 課堂活動實作紀錄

起始 HEAD：`fdb62cc171ace9f7bbfafb57cdea2aaf5812dcdc`，分支 `enviroment-setup`；開始時工作樹乾淨，repository 路徑與上層沒有適用的 AGENTS.md。

## A：現況

- `server/app/api.mjs`：`authenticatedUser` 每次從 MySQL 驗證 Session、停用狀態；所有既有 Organizer 寫入依 session user ID 隔離。新模組沿用此入口與 Origin 檢查，不使用前端 role 作授權。
- `server/app/developer-admin.mjs`：獨立 loopback listener、獨立憑證。新 creator 以本機 CLI 指定確切 user ID，不從 privileged 或 username 推導。
- `server/app/db.mjs`：交易 adapter 提供 execute/query；runtime 是 CRUD，migration 用管理連線。MySQL DATETIME 與連線時區為 `+08:00`。
- `db/operations/migrate.mjs`：按檔名排序、驗 checksum、GET_LOCK 防止重跑競態；DDL 不能整批 rollback。新增 migration 只增表，原有 migration 不改。
- `src/app.ts`：既有自製 routing、登入／記住帳號／週排程／進度與備註；`src/timeline.ts`、`src/weekly.ts` 與相關 tests 保留上一／目前／下一堂與週課程邏輯。
- `courses.user_id` 是私有進度標籤；不能以名稱推導新 classroom，兩者不自動同步。
- `server/app/security.mjs`：same-origin fetch、Origin/CSRF 邊界與 CSP。QR origin 必須使用 canonicalUrl，不能使用 Host 或轉送 headers。
- `server/app/push.mjs` 與 `public/sw.js`：選用 Web Push。班級加入通知用中央 DB，與 Push 無依賴。
- 已安裝 MySQL 8.0 binary，可用另一個 datadir/loopback 隨機 port 作隔離測試；不得讀寫正式 g2。

## 選擇

新模組設定 `classroomActivitiesEnabled`，預設 false。核心 health 只依既有 migrations；新模組自行驗證自己的 migration，缺少時回 503，原 Organizer 保留。加入 QR 採 `/join/#<token>`，邀請秘密不出現在 HTTP 路徑或 query；登入返回僅保存記憶體內的同站流程。父政策七天，展示 token 十五分鐘；DB 僅保留 SHA-256。

## 進度與驗證

以下為 2026-10-24 本機隔離環境的實測；未執行正式 migration、部署、正式服務重啟、真實學生邀請或外部 Push。

| 階段 | 實作／證據 |
|---|---|
| A | 原有 28 檔、149 項基線測試全數通過，無原有失敗；保留進度、歷史、週排程、登入與選用 Push |
| B | 011 additive migration、workspace scope、creator CLI、角色與教師指派、停用／撤權；真實 Session／HTTP 驗證 |
| C | 父政策／十五分鐘 hash token、可解碼 QR、匿名預覽、登入返回、明確加入、站內通知去重、失效／撤銷；瀏覽器兩學生帳號確認加入 |
| D | 012 migration、快照、分組／排序／rubric、未分組阻擋、version 衝突、複製 draft；瀏覽器實際分組與上下移動 |
| E | 唯一進行中組別、兩組依序報告、資格快照、自評拒絕、唯一／冪等提交、收據；真實關閉與提交、移除與提交、停用與提交競態 |
| F | 指定三組分數 fixture、作廢後平均、原始資料保留、發布可見性、兩組瀏覽器全流程、完整備份／還原、隨機 port 測試 Host 重啟後重新登入 |

### 實際命令與環境

Windows、Node v24.19.0、MySQL 8.0 binary：`C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqld.exe`。每次整合測試使用全新 TEMP datadir，loopback 隨機 port，資料庫 `wdwelt_test_learning`／`wdwelt_test_learning_upgrade`。Browser 為 Microsoft Edge headless，五個隔離 context，桌面 1280×900／手機寬度 390×844。

```powershell
npm.cmd test -- --run
npm.cmd run typecheck
npm.cmd run build -- --output runtime/learning-build
node tests/integration/learning.mjs "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqld.exe" --browser --regression
git diff --check
npm.cmd audit --omit=dev --json
```

- 全部單元／既有回歸：29 檔、153 項通過。
- Typecheck、build、語法與 diff check：通過。
- 課堂整合套件：25 組檢查通過；其中另外執行原有 Organizer 真實 MySQL suite：77 checks 通過。
- 同一 NAT／loopback 來源、40 個不同帳號 Session，五條 DB 連線、queue 100：實際 HTTP 並發送出 0/40 失敗，多輪量測 452–1115 ms，最後一輪 1115 ms；服務層另測 40 份最後約 417 ms。另實際建立四十人／十組、成功開始，零份提交皆為 null。不是 production SLA。
- 兩個並發 open request 僅建一回合；雙視窗排序只接受一個版本；跨活動 criterion 被複合 FK 拒絕。
- close/submit 真並發：本次提交先成功、關閉後無新資料。移除／提交與停用／提交：本次異動先完成、提交被拒絕。教師撤權／操作：本次先完成合法操作，下一次操作即拒絕。
- 指定四份 A 組評分：各項 4.25／4.00／3.75、總平均 4.00；作廢全五分後 4.00／3.67／3.33、總平均 3.67，三份有效。零份回 null。
- Browser：creator 建 workspace／授予 manager；manager 搜尋帳號、建班級、確認教師指派；兩學生登入返回／加入；教師建活動、分組、調序、兩組依序報告；自評拒絕、提交、刷新收據、結束與發布。真正攔截成功提交的回應並中斷傳遞，輸入保持，相同 key 在關閉後重送取得原 receipt。
- 已解碼 QR，驗證同站 origin 與 fragment；同一已開分頁掃第二組連結時，hashchange 正確載入新 round，不沿用舊 token。
- 010→012 升級保留舊私人 progress/note；migration 重跑 checksum 一致。完整 dump 先驗證所有新表，再匯入；保留評分／留言／作廢紀錄，清除 Sessions。另一 Node process 與實際測試 Host 重啟後皆讀到資料。
- Production dependencies npm audit：0 advisory。完整 dev audit 另有既有 Vite／Vitest／tinypool／source-map-js 五個項目（含 critical），本功能未擅自升級測試框架大版本；不將開發伺服器對外當正式 Host。
- 本專案沒有 lint script：lint unavailable。

### 權限矩陣

| 動作 | Creator | Workspace manager | Assigned teacher | Student |
|---|---|---|---|---|
| 授予／撤銷 manager | 是 | 否 | 否 | 否 |
| 授予／撤銷 teacher | 是 | 限 scope；不能自授角色 | 否 | 否 |
| 建／封存班級、指派教師、父邀請政策 | 是 | 限 scope | 否 | 否 |
| 展示有效政策的短期加入碼 | 是 | 限 scope | 限授權班級 | 否 |
| 操作活動、原始結果、作廢 | 明確管理模式 | 明確管理模式 | 限授權班級 | 否 |
| 提交互評 | 必須獨立符合學生資格 | 同左 | 自己授課班級禁止 | 有效名單、其他組、開放回合 |
| 查看已發布彙總 | 可 | 可 | 可 | 限自己班級 |

### 與指令的實作選擇及限制

- Creator 使用獨立 `learning_creators` 表與本機 CLI；既有 developer credential 仍為安裝管理信任邊界，不把全域 privileged 直接視為 creator。
- 父政策 ID 是公開定位；只有 CSPRNG 32-byte 子 token 可加入。短期 token 不回讀明碼；互評 token 重新展示會換新定位 token，既有已登入學生的 round 資格仍由 DB 判定。
- 匿名預覽採 POST body，而非 URL query，避免秘密進 request path；GET 不改班級／活動。原有 authentication middleware 的 Session／last_seen 維護照常。
- 新模組 general 限流按有效帳號；匿名 lookup 使用較高且有限的共用桶。既有 Organizer 限流保持原設定。模組頁不額外載入私人 Organizer 課表。
- Web Push 仍選用，加入只發站內 DB 通知。Funnel 原設定預設停用公開註冊；測試使用既有 fixture 帳號，不改此安全預設。
- 本地 `wdwelt.sql` 是舊 004 資料的 Organizer baseline，未納入 Git，也沒有用它覆寫正式或新活動資料；新表由 migration runner 建立。還原時，舊 dump 若缺目標已存在的新表會在任何匯入前拒絕。
- Windows mysql client 還原須明確 `--default-character-set=utf8mb4 --binary-mode`，已用含中文與留言的完整 dump 驗證。
- 開發過程發現正式 8080 的 root 指向 repository `dist`，一般 build 曾寫入該靜態目錄。已將本輪 feature build 保存在忽略的 runtime，並以原 HEAD 重建／恢復原前端（原 asset `index-DAJWmf6f.js`）；正式 PID 保持不變。build metadata 的 build ID 依原 PID 記錄恢復，timestamp 由該 build ID 重建，非宣稱逐 byte 還原原 metadata。後續驗收統一使用 `--output runtime/learning-build`，整合測試也只讀取此隔離目錄。
- **未執行**：實體 iPhone／Android 相機掃碼、Safari／Firefox、真實四十人課堂、校內 LAN／公網 Funnel 現場驗收，以及正式安裝／防火牆／自啟／watchdog 更新。這些不是 headless 或 loopback 測試可證明的項目。
- 新模組預設關閉。導入、creator、API、教師與學生操作、故障回復命令見 [Classroom-Activities.md](Classroom-Activities.md) 與 [Classroom-API.md](Classroom-API.md)。
