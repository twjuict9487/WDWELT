# 課堂活動 API

同站前綴 `/api/learning`。既有 HttpOnly Session、帳號停用判斷與 Origin 檢查沿用。除 status、join preview 外均須登入；臨時密碼帳號須先改密碼。模組關閉回 404；只有新模組缺 schema 時回 503。JSON body 沿用 64 KiB 上限，所有回應 no-store。

| Method／相對路徑 | 權限／輸入 | 結果 |
|---|---|---|
| GET `/status` | 可匿名 | `{enabled:true,ready:boolean}` |
| GET `/home` | 登入 | creator 狀態、有效 workspace roles、可存取 classrooms |
| POST `/workspaces` | 本機指定 creator；`{name}` | `{id}` |
| PUT `/workspaces/:w/roles` | creator 可 manager／teacher，manager 只可 teacher；`{userId,role,active}` | `{updated:true}` |
| GET `/workspaces/:w/accounts?q=` | 該 workspace 管理員 | 最多 50 個穩定 ID、username、display_name，無 credentials |
| POST `/workspaces/:w/classrooms` | 該 workspace 管理員；`{name}` | `{id}` |
| GET `/classrooms/:c` | 該班教師／管理員／學生 | 班級；只有教師／管理員取得 members、policies |
| PUT `/classrooms/:c/teachers` | manager；`{userId,active}`，對象須先有 scoped teacher | 更新班級指派 |
| POST `/classrooms/:c/archive` | manager | 封存，保留資料 |
| POST `/classrooms/:c/students/:u/remove` | 該班教師／管理員 | 移除有效 membership，保留活動歷史 |
| POST `/classrooms/:c/leave` | 本人 | 沒有活動名單紀錄才可離開 |
| POST `/classrooms/:c/policies` | manager；`{days?:7}`，1–30 | 新父政策 ID |
| POST `/classrooms/:c/policies/:p/revoke` | manager | 撤銷父政策 |
| POST `/classrooms/:c/policies/:p/display` | 班級教師／manager | `{token,url,expiresAt}`，子 token 最長十五分鐘 |
| POST `/join/preview` | 匿名可；`{token}` | 只有 workspace／classroom 名稱與截止時間 |
| POST `/join/confirm` | 登入；`{token}` | `{joined:true,alreadyJoined,classroom}` |
| GET `/notifications` | 登入 | 本人最近 100 則站內加入通知 |
| POST `/notifications/:n/read` | 通知本人 | `{read:true}` |
| GET `/classrooms/:c/activities` | 該班有效成員或管理者 | 活動清單 |
| POST `/classrooms/:c/activities` | 班級教師或明確管理模式；`{title,scheduledAt,managementMode?}` | 新 draft ID、當時學生名單快照 |
| GET `/activities/:a?managementMode=true` | 成員可基本資料；教師／管理模式含 participants | activity、criteria、groups、mine；不含原始評分 |
| POST `/activities/:a/prepare` | 教師／管理模式；見下表 | draft 原子更新，version + 1 |
| PUT `/activities/:a/order` | 教師／管理模式；`{version,groupIds,managementMode?}` | 每組一次；live 只能調整 pending 組 |
| POST `/activities/:a/transition` | 教師／管理模式；見狀態表 | 更新狀態；open 額外回傳 QR token／url／roundId |
| POST `/activities/:a/round-link` | 教師／管理模式；`{managementMode?}` | collecting 回合換新定位 token，舊連結失效 |
| POST `/activities/:a/copy` | 教師／管理模式；`{title,scheduledAt,managementMode?}` | 新 draft，複製有效學生、分組及 rubric，不含提交 |
| POST `/evaluate/resolve` | 登入且活動有效學生；`{token}` | 目標組、自己組、rubric、canSubmit、reason、自己的 receipt |
| POST `/rounds/:r/submit` | 獨立學生資格；見下文 | `{receipt,replayed}` |
| GET `/rounds/:r/receipt` | 有效學生本人 | 自己已提交的 receipt |
| GET `/activities/:a/collection?managementMode=true` | 教師／管理模式 | 每回合固定 expected、received、valid、disabled |
| GET `/activities/:a/results?managementMode=true&details=true&page=1` | 教師／管理模式：彙總＋按需 50 筆明細；學生：已發布彙總 | groups、published；學生永遠沒有 evaluations 欄位 |
| POST `/activities/:a/evaluations/:e/void` | 教師／管理模式；`{reason,managementMode?}` | 原始提交保留、voided 與理由、audit |

`scheduledAt` 必須是 `2026-10-26T09:00+08:00` 或帶秒的明確台北時間；不接受主機本地時間或不存在的日曆日期。DB DATETIME 與 connection timezone 均為 +08:00，JSON 日期以帶 offset 的 ISO 時間輸出。

## Draft 操作

每個 body 都帶 `version`，管理代操作另帶 `managementMode:true`。同活動列鎖防止過期覆寫。

| action | 額外欄位 |
|---|---|
| `sync` | 同步目前班級新學生成員 |
| `exclude` | `userId,excluded`，移出組別但不刪名單 |
| `group` | `name` |
| `rename-group` | `groupId,name` |
| `delete-group` | `groupId`，先移除該 draft 組成員關聯 |
| `move` | `userId,groupId`，都必須屬本活動／班級 |
| `criteria` | `names`：1–10 個非空項目名稱 |
| `update` | `title,scheduledAt?` |

## 狀態

活動：`draft → live → ended`，或 `draft → cancelled`。組別：`pending → presenting → collecting → completed`；presenting 可取消回 pending。

Transition body：`{action,version,managementMode?,groupId?,confirmIncomplete?}`。

- `start`：draft，至少兩個非空組、無未分組學生、rubric 完整。
- `cancel`：只 draft。
- `present`：指定下一個 pending groupId；不可跳過或同時報告兩組。
- `cancel-presentation`：只尚未 collecting 的 presenting。
- `open`：presenting，建立唯一 round 與其他組有效學生資格快照。
- `close`：collecting，未交齊須 `confirmIncomplete:true`。
- `end`：live，可提早結束；同交易關閉 collecting，未交齊同樣要確認。
- `publish`／`unpublish`：只 ended。

已結束／取消不重開。相同舊 version 或不合法 transition 回 409。

## 評分與 receipt

```json
{
  "requestKey": "browser-generated-uuid",
  "scores": [
    {"criterionId": 101, "score": 5},
    {"criterionId": 102, "score": 4},
    {"criterionId": 103, "score": 3}
  ],
  "comment": "選填純文字"
}
```

reviewer 由 Session 決定，body 不接受 reviewer、target group 或額外欄位。所有 rubric 必須各出現一次、整數 1–5；comment trim 後最多 500 UTF-16 code units，與 HTML maxlength 一致。所有留言純文字編碼呈現。

同回合／reviewer 唯一。相同 requestKey＋canonical payload hash 重送回既有 receipt，即使回合之後關閉；相同 key 改內容 409，不同 key 再投也 409。此查詢先驗證當前帳號、班級與學生資格，不能替他人取收據。作廢仍保留唯一提交，不允許重投。

彙總只算未作廢提交，沒有提交是 null；各份有相同數目、等權重 rubric，所以總平均等同全部有效原始 score 的平均。學生 API 永遠不包含原始留言、評分者或別人的 receipt。

## 失敗碼

401 未登入／Session 或帳號已失效；403 角色不符、自評／資格不符、未發布；404 不存在或跨範圍；409 版本衝突、非法狀態、已提交；410 邀請或回合已失效；422 欄位驗證；429 節流（Retry-After）；503 schema／DB 暫時不可用。非預期錯誤附 correlation ID，log 不記秘密 token 或整份留言。

GET 不改班級、活動或評分；沿用的 authentication middleware 仍會維護既有 Session last_seen 及續期。
