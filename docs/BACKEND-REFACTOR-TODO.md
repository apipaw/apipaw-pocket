# APIPaw Cloud 后端改造清单（阶段三 · 云端核心业务逻辑打通）

> 面向 Pocket v1.1.0 网页需要展示的三类**真实数据**：
> **① 在线节点数** ② **用户余额扣除** ③ **节点收益增加**
>
> 摸底时间：2026-11-08　摸底对象：`/opt/apipaw-cloud/{server.py(1715行), db.py(1222行)}`
> + `node_registry.db` + `apipaw.db`（生产实时数据）
> 本文档**只读分析产出，未改动任何后端代码**。

---

## 0. 现状速览

**部署拓扑**

```
浏览器 (Pocket v1.1.0)
   │  直连 cloud.apipaw.com（CORS），本地存 key，所有请求带 Authorization: Bearer
   ▼
nginx :80/:443  (cloud.apipaw.com → 127.0.0.1:8000)
   ▼
uvicorn :8000  --workers 1  --ws-ping-interval 30 --ws-ping-timeout 60
   ▼
SQLite ×2：apipaw.db（业务库）/ node_registry.db（节点注册表库）
```

**两套节点数据源并存（核心矛盾）**

| 表 | 位置 | 行数 | 谁写 | 谁读 |
|---|---|---|---|---|
| `node_registry` | node_registry.db | **19** | 心跳（HTTP/WS） | 在线判定、拓扑、`GET /api/v1/nodes` |
| `nodes_history` | apipaw.db | **2** | `record_usage` 结算 + `toggle_node_pause` | 业主面板节点列表、Toggle |

**生产实时数据快照（2026-11-08 03:00 UTC）**

- `users`：仅 1 条 —— `paw_demo_key`，balance **999.891134**、daily_limit 100
- `usage_logs`：共 18 条，**最后一条 2026-11-07 12:00** → 用户昨日验收浏览期间未产生任何真实推理结算
- `nodes_history`：`apipaw-cloud-sim`(825 tok / 320.267 PAW)、`node_default_001`(628 tok / 142.413 PAW)
- `node_registry`：19 条中 **16 条是历史调试探针垃圾**（`probe_*` / `ws_rootcause_probe` / `123`），
  真实节点 3 条（`123` / `node_default_001` / `node_user_002`）最后心跳均在 10~15 小时前 → **在线节点数 = 0**
- `node_credentials`：2 条（`node_default_001`、`node_user_002`），**无 owner 归属字段**

---

## P0 · 安全红线（阻断级，必须先做）

### TODO-01 业主端点零鉴权 —— 公网可任意读写

**现状**
`server.py` 三个端点**没有任何 `authorization` 参数**，实测（公网无任何凭据）：

| 请求 | 结果 |
|---|---|
| `GET /api/v1/owner/dashboard` | **200**，返回全量 node_id、累计 tokens、累计收益 PAW、`last_seen` |
| `GET /api/v1/nodes` | **200**，返回全部节点设备信息 |
| `POST /api/v1/owner/node/{id}/toggle` | **200**，**真的改写了节点状态** |

对比：买家端 `/api/v1/user/usage` 无 key 返回 401（鉴权是生效的），仅业主端是敞开的。

**改造**
1. `server.py:746` `get_owner_dashboard()` 增加 `authorization: Optional[str] = Header(None)`
2. `server.py:768` `toggle_node()` 同样增加
3. `server.py:1713` `list_nodes()` 同样增加（`/health` 可保持公开，但只回计数不回明细）
4. 新增 `require_owner(authorization)` 复用现有 `require_api_key` 模式

**前端零改动**：`src/api/cloudClient.ts:34` 的拦截器已对**所有**请求统一注入
`Authorization: Bearer ${apiKey}`，后端加校验即可生效。

**验收**：无 key 访问三个端点全部 401；带买家 key 但无业主身份 → 403。

---

### TODO-02 缺失「业主」角色模型

**现状**
`users` 表只有 `creator_wallet` / `creator_id`（创作者身份 = 钱包），**没有 owner / role 概念**。
业主面板与创作者面板共用一个账号体系，无法区分"能看全网节点"和"只能看自己的模型"。

**改造**
- `users` 增加 `role TEXT DEFAULT 'BUYER'`（BUYER / CREATOR / OWNER）与 `owner_wallet TEXT DEFAULT ''`
- 种子数据：`paw_demo_key` → OWNER + 绑定 owner_wallet（与 creator_wallet 解耦，业主钱包 = 收节点分成的钱包）
- 新增 `db.get_owner_identity(api_key)` / `db.require_owner_role(...)`

**验收**：买家 key 访问业主端点 403；OWNER key 200。

---

### TODO-03 Toggle 的 INSERT 副作用 —— 可凭空伪造节点

**现状**
`db.py:1016 toggle_node_pause()`：node_id 不存在时**直接 INSERT 一行** `is_paused=1`。
配合 TODO-01 的无鉴权，任何人 POST 一个随机 node_id 就能：
- 在 `nodes_history` 凭空造节点（实测已污染 `registered_nodes_total`）
- 在业主面板上出现幽灵节点

> 本次摸底实测插入了 `probe-nonexistent-9f3a`，已当场清理并复核。

**改造**
1. `toggle_node_pause` 改为**只 UPDATE**，不存在时抛 404（`node_id` 需存在于 `node_registry`）
2. 幂等：重复 toggle 返回当前状态而非翻转

**验收**：对不存在的 node_id 调用 → 404，且 `nodes_history` 行数不变。

---

## P1 · 节点数据模型统一（对应「在线节点数」「节点收益增加」）

### TODO-04 确立单一权威节点表，消除双库割裂

**现状**
在线数来自 `node_registry`（19 条），节点列表来自 `nodes_history`（2 条），**两者永不相交**：
- 只发心跳、没跑过推理的节点 → 不出现在业主面板
- 面板上的 `apipaw-cloud-sim` 根本不在 registry 里
- `active_nodes_online` 与 `registered_nodes_total` 口径不同，UI 上两个数字对不上

**改造（推荐方案：registry 为权威，nodes_history 降级为纯统计表）**
1. `nodes_history` 改名语义为「节点累计产出统计」，**不再承担节点注册表职责**
2. 业主面板的 `nodes` 列表改为**从 `node_registry` 读**，字段：
   `node_id / node_name / hardware_type / agent_version / status / channel / alive / last_heartbeat / total_tokens_processed / total_earnings_paw / is_paused`
3. `active_nodes_online` 与 `nodes.length` 用**同一份数据**计算，口径自洽
4. `GET /api/v1/nodes`（registry 全量）与 dashboard（registry ∩ 产出统计）共用同一查询层

**验收**：面板「在线 N / 登记 M」与 `GET /api/v1/nodes` 的计数完全一致；发心跳未推理的节点出现在列表且 `alive=true`。

---

### TODO-05 节点心跳回写 nodes_history —— 消除「只有结算才有节点」

**现状**
`server.py:231 _touch_node()` **只写 registry**，不碰 `nodes_history`。
`nodes_history` 的行只在 `record_usage` 结算时产生 → 新接入的节点在面板上是隐形的。

**改造**
`_touch_node` 成功后，同事务 upsert 一行 `nodes_history`（只更新 `last_seen`，
`total_tokens_processed` / `total_earnings_paw` 仍由结算累加）。
注意 SQLite 3.7.17 不支持 UPSERT，须复用 `db.smooth_upsert`。

**验收**：节点发一次心跳即出现在面板，`last_seen` 实时刷新。

---

### TODO-06 节点归属钱包缺失 —— 「我的节点收益」无法成立

**现状**
`node_credentials`（db.py:1059）字段只有 `node_id / node_secret / status / created_at / updated_at / note`，
**没有任何 owner 归属**。节点收益 `total_earnings_paw` 只是一串累计数字，
**无法归属到任何钱包/账户**，「节点收益增加」在产品层面无法成立。

**改造**
1. `node_credentials` 增加 `owner_wallet TEXT DEFAULT ''`、`owner_id TEXT DEFAULT ''`
2. `manage_node.py` 增加绑定/改绑命令（当前仅能建/查/吊销）
3. 新增 `GET /api/v1/owner/nodes/revenue`：按 owner_wallet 聚合该业主名下节点的
   `total_earnings_paw` / `total_tokens_processed` / 在线数 / 近 24h 增量
4. 新增 `GET /api/v1/owner/nodes/{node_id}/revenue`：单节点收益时间序列

**验收**：业主面板的「我的节点总收益」= 其名下节点 `total_earnings_paw` 之和，与接口一致。

---

### TODO-07 PAW 换算率硬编码

**现状**
`db.py:record_usage` 内联 `paw_earned = node_earn_usd / 0.00020`，汇率写死在函数体里，
既不可配置也无历史版本 —— 改了汇率会导致历史数据无法重算。

**改造**
- 提为 `db.py` 顶部常量 `USD_TO_PAW = 0.00020`（与 `USD_TO_CGAS` 同级）
- `nodes_history` 增加 `earnings_rate` 列记录当时汇率（结算时快照），保证历史可对账

**验收**：历史行的 PAW 收益不因汇率调整而变化。

---

## P2 · 计费正确性（对应「用户余额扣除」）

### TODO-08 余额只有余额、没有账本

**现状**
`users.balance_usd` 是**单个可变 REAL 列**，`record_usage` 直接
`UPDATE users SET balance_usd = balance_usd - ?`。
没有流水表 → 余额对不上账时**无法追溯**是哪笔推理扣的；也无法做「某段时间消费构成」。

**改造**
1. 新增 `balance_ledger` 表：
   `id / api_key / delta_usd / balance_after / reason(RECHARGE|CONSUME|ADJUST) / ref_id(request_id) / created_at`
2. `record_usage` 在扣余额的**同一事务**内写一条 `delta_usd = -cost` 的流水
3. `balance_after` 落快照 → 任意时刻余额可由流水重放验证

**验收**：`SELECT SUM(delta_usd) FROM balance_ledger WHERE api_key=?` 与 `users.balance_usd` 的差额恒为初始充值额。

---

### TODO-09 额度闸门存在并发击穿与负余额

**现状**
`server.py:967-981` 的校验是**事前**的：
- `balance_usd <= 0` → 拒绝
- `spent_today >= daily_limit` → 拒绝

两个并发请求可**同时通过**校验再各自扣费 → 超额消费；单次大请求也可把余额扣成负数
（结算后无二次校验）。且闸门在闸门之外：闸门通过后到落库之间存在时间窗。

**改造**
1. `record_usage` 内改为**条件式扣款**：
   `UPDATE users SET balance_usd = balance_usd - ? WHERE api_key = ? AND balance_usd >= ?`
   —— `rowcount == 0` 即判定余额不足，回滚并返回 `insufficient_balance`
2. 单日限额同理，改为条件式写入 `usage_logs` 前先原子判定（可用当日累计列或事务内重查）
3. 扣款失败 → 返回 402，且**不写 usage_logs**（当前两者在同一事务，需保证原子性）

**验收**：并发 20 个请求打同一个只剩 $1 余额的账号，最终余额 ≥ 0，超额请求全部 402。

---

### TODO-10 缺失充值/钱包接口，余额只减不增

**现状**
`users` 表里只有 init_db 播种的初始余额，**没有任何充值接口**。
`POST /api/v1/auth/apikey` 能建新 key 并给初始余额（默认 $10），但存量账户无法充值。

**改造**
1. `POST /api/v1/user/recharge`（鉴权 = 买家 key）：写入 `balance_ledger` 的 `RECHARGE` 流水
2. 明确充值是否需要真实支付通道；若第一阶段只做「演示充值」，接口里显式标注 `demo: true`，
   不要让前端误以为已对接支付
3. 充值后需通知前端刷新余额 → 见 TODO-12

**验收**：充值后 `balance_usd` 增加且 ledger 有对应流水。

---

### TODO-11 `get_spend_today` 的时间口径需明确并与 UI 对齐

**现状**
`db.py:376 get_spend_today()` 的时间窗口实现需复核（自然日 or 滚动 24h）；
而前端 UI 上写的是「今日消费」。滑块设的是「单日上限」，两个口径必须与 UI 文案严格一致，
否则用户会看到「已用 $x 超过上限但请求没被拒」。

**改造**：明确为**滚动 24 小时**（与 `/api/v1/user/analytics?hours=24` 同源），并在 UI 文案注明。

---

### TODO-12 前端余额/面板不随推理实时刷新（**前端侧，但需后端配合**）

**现状**
`App.tsx:83-87`：`loadData()` 与 `loadUsage()` **只在 mount 时调用一次**（依赖数组为 `[]`）。
用户在 Playground 跑完一次推理后，**界面上的余额、今日消费、节点收益全是旧值**，
必须手动刷新页面才更新 → 「用户余额扣除 / 节点收益增加」在界面上根本看不到变化。

**改造（两个方案，建议 A）**
- **A（推荐）**：后端在 SSE 响应尾部（`RESPONSE_DONE`）与结算完成后，通过
  `GET /api/v1/user/usage` 的 `ETag`/`version` 字段或新增轻量 `GET /api/v1/user/usage?if_version=N`
  暴露变更版本号；前端轮询（或 SSE 推送）检测到版本变化即刷新余额与面板
- **B**：前端在 Playground 收到 `RESPONSE_DONE` 后主动调一次 `loadUsage()` / `loadData()`
  （改动最小，但节点侧收益仍不实时）

> 注：前端刷新属于 Pocket 仓库改动，后端只需保证 usage/余额接口返回**最新**数据（目前是满足的）。

---

## P3 · 派单与远控真正生效

### TODO-13 `is_paused` 全链路失效 —— 「暂停接单」开关零效果

**现状（本次摸底最严重的功能性缺陷）**
- `toggle_node_pause` 写入 `nodes_history.is_paused`
- **`server.py` 里 `is_paused` 只出现 2 次，都在 toggle 端点内（769-770 行）**
  → 除写入与回显外，**全代码库没有任何地方读它**
- `_select_dispatch_node()`（server.py:1191）的选点条件只有：
  WS 在线 / status==IDLE / 有 agent_version / 心跳未过期 —— **完全不看 is_paused**

结论：业主在面板上把节点切到「已暂停接单」，派单**仍会派给它**。开关是装饰品。

**改造**
1. `_select_dispatch_node` 增加过滤：查 `is_paused`（建议与 registry 合并后的权威节点表，TODO-04）
2. `dispatch_inference` 二次校验节点是否在派单瞬间被暂停 → 拒绝并换节点
3. 暂停语义明确：暂停 = 不再被选中 + 已连接时主动下发 `PAUSE` 帧或断开

**验收**：暂停某在线节点后，在该节点上发起推理 → 请求被路由到其他节点（或返回无可用节点）；
面板上该节点状态为 PAUSED。

---

### TODO-14 HTTP 心跳节点永远接不到派单

**现状**
`connected_nodes` 是**进程内字典**（仅 WS 隧道节点），`_select_dispatch_node` 只从它选。
而注册表里 `channel='http'` 的节点（`node_default_001`、`node_user_002`、`123`）
会被 `_online_node_list()` 展示在**拓扑**里 → **前端展示为"在线可用"的节点，实际永远收不到派单**。

**改造**
1. 选点改为以 registry 为准（`alive && channel 有效 && status==IDLE && !is_paused`），
   WS 节点额外要求 `connected_nodes` 里有活连接
2. HTTP 通道节点要么实现「拉取式推理任务」（节点轮询 `/api/v1/node/tasks`），
   要么明确标注为「仅上报状态，不参与调度」，并在拓扑上区分
3. 评估 `--workers 1` → 多 worker：`connected_nodes` 进程内字典不共享，
   扩 worker 会导致选不到 WS 节点（当前单 worker 掩盖了这个问题）

---

### TODO-15 注册表垃圾数据清理与生命周期

**现状**
`node_registry` 19 条里 16 条是调试探针残留（`probe_*` / `ws_rootcause_probe` / `123`），
永久 `alive=false` 但仍在列表里；`last_heartbeat=0` 的行会让"最后在线时间"显示异常。

**改造**
1. `node_registry` 增加 `retired_at`，心跳超期窗口（如 7 天）后自动标记退役并从默认列表隐藏
2. `manage_node.py` 增加 `prune` / `retire` 命令，清理历史探针
3. `GET /api/v1/nodes` 支持 `?include_retired=1` 供排查

---

## P4 · 工程债（进入深度重构前先铺路）

### TODO-16 后端代码自 v1.0.0 起全部未提交 —— 无版本安全网

**现状**
`/opt/apipaw-cloud` 是 git 仓库，但只有 1 个提交（`ffd443a v1.0.0`），
当前 **db.py + server.py 共 1412 行改动全部处于未提交状态**（含 DAY11~DAY15 的全部成果）。
任何一次误操作都无法回滚。同时目录里堆了 12 个 `.bak` 文件（`server.py.bak.2026*` / `db.py.bak.*`）。

**改造**
1. **先提交一个基线**（`chore: 备份 DAY11-DAY15 未提交基线`），保证有回滚点
2. `.gitignore` 排除 `*.bak*` / `*.db.bak*` / `backups/` / `__pycache__/` / `*.db`
3. 把散落的 `.bak` 文件归档到 `backups/` 并从工作目录清出
4. 后续每个 TODO 一个 Conventional Commit

### TODO-17 无自动化测试

**现状**：仅 `test_e2e.py`（86 行），无 CI。

**改造**：为每个 TODO 补 pytest 用例（余额并发、限额边界、toggle 幂等、鉴权 401/403），
跑在**库副本**上（`sqlite3 .backup`），绝不连生产库。

### TODO-18 部署与回滚流程未固化

**改造**：为 `apipaw-cloud.service` 建立「改码 → 备份 DB → 重启 → 健康检查 → 出错回滚」的
标准动作序列（与前端的 nginx reload 流程同规格），并把 DB 备份纳入 `/opt/apipaw-cloud/backups/`（已存在该目录）。

---

## 执行顺序建议

```
批次 1（安全，最小改动，可当天上线）
  TODO-01 业主端点鉴权  →  TODO-02 角色模型  →  TODO-03 toggle 副作用修复
  价值：立刻堵住公网敞口；前端零改动

批次 2（数据模型，影响面最大）
  TODO-04 节点单一权威  →  TODO-05 心跳回写  →  TODO-06 节点归属钱包
  →  TODO-14 派单选点对齐  →  TODO-13 is_paused 生效
  价值：一次性打通「在线节点数」「节点收益增加」两条数据链

批次 3（计费）
  TODO-08 余额账本  →  TODO-09 并发闸门  →  TODO-10 充值接口  →  TODO-11 口径统一
  →  TODO-12 前端实时刷新
  价值：打通「用户余额扣除」的可见与可对账

批次 4（运维）
  TODO-15 注册表清理  →  TODO-16 git 基线  →  TODO-17 测试  →  TODO-18 部署流程
```

> **建议先做 TODO-16（git 基线）**再动任何代码 —— 当前 1412 行未提交改动没有任何回滚保护。

---

## 附：本次摸底**未触碰**的内容（红线仍有效）

- `/opt/apipaw-cloud/{server.py,db.py}` —— **本次全程只读**，未做任何修改
- 3X-UI（2053 / 39821）—— 未触碰
- `apipaw-cloud.service` —— 未重启（仅读取 unit 文件与状态）
- `apipaw.db` / `node_registry.db` —— 只读查询；
  唯一一次写入是摸底探测插入的 `probe-nonexistent-9f3a`，**已当场删除并复核**
