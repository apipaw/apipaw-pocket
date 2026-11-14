# 阶段五 · 核心蓝图：二元经济分账 / 公平路由 / AI Playground

> **文档定位**：阶段五（Phase 5）的**唯一设计真源**。阶段四（账户与通行证）已于 2026-11-11 收官，
> 本阶段在其底座上做三件事：**统一收益分配模型**、**Matchmaker 公平路由**、**Pocket 大模型试炼场**。
>
> **状态**：蓝图评审中 —— **本文档只出方案，不改任何生产代码**（除已完成的阶段四 e2e 补测）。
> **产出位置**：`D:\APIPawPocket\docs\PHASE5-CORE-TODO.md`（沿用阶段四 `PHASE4-AUTH-TODO.md` 的蓝图归属惯例）。
> **作者**：首席架构师（Claude Code 会话） · **日期**：2026-11-11
>
> **红线（阶段五全程适用，继承阶段三/四）**：
> 零新增生产依赖 · 生产源站 Python **3.6.8** + SQLite **3.7.17**（无 UPSERT / 无 partial index /
> 无 `RENAME COLUMN` / 无 `VACUUM INTO` / 无 `Connection.backup()`）· 不改买家侧计费语义（除非显式拍板）
> · 不开"跳过验签/跳过计费"后门 · 改数据形状先 `.backup` + 沙箱矩阵跑通再动生产
> · nginx **只 reload 不 restart** · `sudo` 走管道密码 · GitHub 推送走本地 1080 SOCKS5。

---

## 目录

1. [摸底结论：现状事实清单](#1-摸底结论现状事实清单)
2. [模块 A · 统一收益分配与财务扣除模型](#2-模块-a--统一收益分配与财务扣除模型)
3. [模块 B · Matchmaker 公平路由机制](#3-模块-b--matchmaker-公平路由机制盲派单防挑单)
4. [模块 C · APIPaw Pocket 大模型试炼场](#4-模块-c--apipaw-pocket-大模型试炼场)
5. [跨模块落地顺序 · 开关 · 灰度](#5-跨模块落地顺序--开关--灰度)
6. [不变量与回归红线](#6-不变量与回归红线)
7. [需要拍板的分歧点（决策清单）](#7-需要拍板的分歧点决策清单)
8. [验收矩阵与回归基线](#8-验收矩阵与回归基线)
9. [风险登记](#9-风险登记)

---

## 1. 摸底结论：现状事实清单

> 全部结论均来自 2026-11-11 对 `D:\APIPawCloud` 与 `D:\APIPawPocket` 的实读，附 `文件:行号`。
> **设计必须建立在这份事实上，而不是印象上。**

### 1.1 现有数据模型（`db.py`）

| 表 | 关键字段 | 位置 |
|---|---|---|
| `users` | `account_handle`（跨表引用键）/ `balance_usd` / `balance_frozen_usd`（预扣冻结）/ `daily_limit_usd` / `role`(BUYER/CREATOR/OWNER) / `status` / `owner_wallet` / `creator_wallet` / `creator_id` | `db.py:271-281` |
| `api_keys` | `account_handle` / `key_hash`(sha256) / `key_prefix` / `key_last4` / `status` | `db.py:484-498` |
| `usage_logs` | `api_key`(=account_handle) / `node_id` / `model_id` / `prompt_tokens` / `completion_tokens` / **`cost_usd`(=买家实付总额)** / `model_tier` / `node_earn_usd` / `creator_royalty_usd` / `platform_fee_usd` / `request_id`(唯一索引) | `db.py:305-331` |
| `balance_ledger` | `api_key` / `entry_type`(TOPUP/RECHARGE/HOLD/SETTLE/FAILED/OPENER/USAGE) / `direction`(±1) / `amount_usd`(恒正) / `balance_after_usd` / `request_id` / `idem_key`(唯一) / `cost_usd` / `day_key` / `day_spent_usd` | `db.py:383-415` |
| `daily_spend` | PK(`api_key`,`day_key`) / `spent_usd` | `db.py:422-428` |
| `models` | `model_id` PK / `display_name` / `tier`(BASE/CREATOR) / `prompt_price_per_1k` / `completion_price_per_1k` / `context_window` / `reasoning` / `creator_id` / `creator_name` / **`author_wallet`** / `min_vram_gb` / `num_hidden_layers` | `db.py:335-345`、`db.py:115-127` |
| `nodes_history` | `node_id` PK / `total_tokens_processed` / `total_earnings_paw` / `is_paused` / `last_seen` / `owner_handle` | `db.py:285-301` |
| `creator_withdrawals` | `creator_id` / `author_wallet` / `amount_usd` / `amount_paw` / `status` | `db.py:365-375` |
| `node_registry.db`（独立库） | `node_registry` / `node_credentials`（一机一码 + `owner_wallet`） | `server.py:286-300`、`db.py:2879-2888` |
| `auth_nonces` / `auth_sessions` / `auth_wallets` / `auth_rate_limits` | 阶段四钱包鉴权四表 | `db.py:506-559` |

**关键结构性发现**：

- **模型元数据就在 `models` 表**，没有独立的"模型注册表"；模型↔创作者靠 `models.author_wallet` ↔ `users.creator_wallet`（`db.py:2210`）。
- **账实相符（NET == BAL）不是靠事后对账校验保证的，而是靠"同事务写流水 + 快照"**：
  全库**不存在**任何 `SUM(direction*amount) == users.balance_usd` 的校验函数；不变量只写在注释里（`db.py:1293-1298`）。
- ⚠️ **三方收益都没有"账户"**：
  - 节点收益只累加在 `nodes_history.total_earnings_paw`（`db.py:1552-1569`），业主收益是**只读聚合**（`db.py:2783-2842`），**没有业主余额账户、没有账本流水**；
  - 创作者版税同理：`usage_logs` 聚合 + `creator_withdrawals` 提现流水（`db.py:2501-2523`）；
  - 平台抽成**连聚合表都没有**，只写 `usage_logs.platform_fee_usd` 一列。
  ⇒ **这是模块 A 最大的缺口**：钱"分出来了"，但**没有一本能对账的账**。

### 1.2 现有计费口径（`db.settle_cost`，`db.py:1257-1274`）

```
base    = prompt_tokens/1000 × prompt_price_per_1k
        + completion_tokens/1000 × completion_price_per_1k
node    = base × 0.85
plat    = base × 0.15
creator = base × 0.15        # 仅 model.tier == 'CREATOR'
buyer   = base + creator     # 场景 B 买家实付 = base × 1.15
```

常量：`NODE_SHARE=0.85` / `PLATFORM_SHARE=0.15` / `CREATOR_ROYALTY=0.15`（`db.py:55-59`）。
场景命名：`BASE` = 场景 A · 开源基础模型；`CREATOR` = 场景 B · 社区创作者模型（`db.py:102-105`）。
模型种子：`llama-3.3-70b`(BASE, 0.26/0.40)、`qwen-2.5-72b`(CREATOR, 0.35/0.42)（`db.py:69-100`）。
计价单位：`USD_TO_CGAS=100.0`（`db.py:62`）、`USD_PER_PAW=0.00020`（`db.py:108`）。

> ⚠️ **口径冲突（必须先解决）**：现行版税 **100% 归创作者**，平台在版税上抽 0；
> 用户本阶段要求的口径是 **版税再按 85/15 分给创作者与平台**。两者**不等价**，详见 §2.2 与决策 **D1**。

### 1.3 预扣—结算链路（阶段三成果，必须原样保住）

`server.chat_completions`(`server.py:1914`) →
`db.get_model` → `estimate_tokens` → `estimate_hold_cost`(`server.py:742`，上界 = 输入 + max_tokens×1.5) →
**T0** `db.reserve_usage_atomic`(`db.py:1329`，失败即 402) →
派单(`server.py:1992-2016`) → `db.settle_cost`(`db.py:1257`) →
**T1** `db.finalize_usage_atomic`(`db.py:1455`)；异常 → `db.release_failed_reservation`(`db.py:1609`)；
后台 `reap_stale_holds`(`db.py:1666`) 兜底超时冻结。

- `BEGIN IMMEDIATE` 共 5 处：reserve(`db.py:1360`)/finalize(`db.py:1480`)/release(`db.py:1625`)/reap(`db.py:1681`)/add_balance(`db.py:1823`)。
- **预留 vs 实扣**：`users.balance_frozen_usd` 是"钱卡在哪"的唯一真相（`db.py:440-443`）；
  HOLD 行 `direction=-1`；SETTLE 行 `direction=±1, amount=|hold-actual|`；两行合计 = `-actual` ⇒ **NET == BAL 恒等式由这两行构成**。
- **幂等三重**：`idem_key` 唯一索引（`db.py:412-413`，键 `HOLD:<rid>` / `SETTLE:<rid>`）+ `usage_logs.request_id` 唯一索引（`db.py:326`）+ 事务内先查（`db.py:1363-1369`、`1483-1489`）。
- `finalize` 里 `IntegrityError` 被当成"已结算"吞成 `duplicate=True`（`db.py:1591-1598`）。
- `usage_logs.cost_usd` 存的是**买家实付总额**（`db.py:1497-1503` 写入 `actual`）——**回填历史时必须按此反推 base**。

### 1.4 现有调度/派单（阶段三成果 + 缺口）

- 派单器 = `_select_dispatch_node`(`server.py:2262-2314`) + `dispatch_inference`(`server.py:2349-2437`)，默认关闭（`DISPATCH_ENABLED`，`server.py:128`）。
- 选点条件：进程内 WS 连接 + `status=="IDLE"` + `agent_version` 非空 + 心跳 ≤45s（`server.py:2283-2290`）+ 注册表 WS 通道权威校验（`2295-2296`）+ `is_paused` 过滤（fail closed，`2300-2312`）。
- ❌ **不接收 `model_id`** → **不做 `min_vram_gb` 门槛匹配**，也不限单节点在途并发数。
  （`DISPATCH_PROTOCOL.md:101-121` 描述的 vram 门槛 / `max_vram` 降序 / 并发上限 **均未落地**）
- ❌ 取 `candidates[0]`（**node_id 字典序**）→ 热点不均、尾节点长期饿死。
- 派单帧：下行 `{"type":"INFERENCE_REQUEST","request_id","payload"}`（`server.py:2384-2388`），
  **payload 里带 `model` = model_id**（`server.py:1993-1997`）⇒ **节点能分辨场景 A / B**。
- ⚠️ **结算回执把全部分成推给节点**：`SETTLEMENT_RECEIPT` 含 `node_earn_usd / creator_royalty_usd / platform_fee_usd`（`server.py:2101-2111`、`_notify_settlement:2440`）
  ⇒ **节点既知道模型身份、又知道这一单的三方分成比例** ⇒ 挑单动机与信息**全部齐备**。
- ❌ **无防挑单机制**：节点可回 `503 node_yielded`（`DISPATCH_PROTOCOL.md:222-230`），网关只换下一个重试至多 2 次（`server.py:1999-2016`）；
  **无冷却、无惩罚、无黑名单**（`cooldown` 在 `server.py` 零命中，文档写的 30s 冷却未实现）。
- 节点鉴权：逐节点一机一码 `node_credentials`，WS 握手 fail closed（`server.py:2454-2480`）。

### 1.5 现有 Pocket 前端（`D:\APIPawPocket`）

| 能力 | 现状 | 位置 |
|---|---|---|
| 推理协议 | **真 SSE**（裸 XHR + `onprogress` 增量解析，`[DONE]` 收尾） | `src/api/cloudClient.ts:571-708` |
| 推理答案 | **假**（后端仅当 `APIPAW_DISPATCH_ENABLED=1` 且派单成功才用真实节点，否则走 `build_answer`/`build_reasoning_chain` 模板） | `server.py:125-128`、`2020-2029`、`792-825` |
| 请求参数 | **只有** `{model, messages, stream}`；后端已接受 `max_tokens`/`temperature`（`server.py:686-691`），**无 `top_p`** | `cloudClient.ts:694` |
| system 消息 | **不计费**（预扣只取 `role=='user'` 的文本） | `server.py:1950-1957` |
| 费用拆解数据 | **后端已发**（`usage_payload` 含 `node_earn_usd/creator_royalty_usd/platform_fee_usd`） | `server.py:2126-2137`、`cloudClient.ts:267-276` |
| 费用拆解 UI | ❌ **数据在手、UI 未接**（`RunStats` 只存 `cost_usd/cgas`） | `PlaygroundCard.tsx:327-333` |
| CoT 折叠卡片 | ✅ 已有 `ReasoningCard`（Animated maxHeight 0→460） | `PlaygroundCard.tsx:89-140` |
| 代码导出 | ✅ 已有 curl/python/js 三 tab + 剪贴板 | `PlaygroundCard.tsx:245-308` |
| TTFT / Tokens-s | ✅ 前端本地计时（后端零字段） | `PlaygroundCard.tsx:312-318`、`371-372`、`386-388` |
| 模型目录 | `GET /v1/models`（**无鉴权**），`ModelInfo` 已含 `tier` / `pricing` / `context_window` / `reasoning` | `cloudClient.ts:434`、`165-175` |
| 分析接口 | `GET /api/v1/user/analytics`，`settlement{node_earn, creator_royalty, platform_fee, total}` | `cloudClient.ts:217-223`、`AnalyticsCard.tsx:479-497` |
| UI 基建 | `Slider`（自绘 PanResponder）/ `StatTile` / `Surface` / `Toggle` / `Pill` / `Toast`；图表为组件内手绘 svg | `Slider.tsx`、`ui.tsx`、`AnalyticsCard.tsx:47/194` |
| 鉴权约束 | `/v1/chat/completions` **只认 Bearer API Key**（`server.py:1922-1931`，阶段四 P0 已删匿名兜底）；钱包会话**不参与推理** | `cloudClient.ts:63-79` |
| 部署形态 | `expo export -p web` → `dist/`（绝对路径 `/_expo/...`，必须挂域名根）；**console 与 pocket 是两个独立站点根**（nginx `apipaw-console.conf:26` 与 `:58`），**两个都要覆盖** | 源站 nginx |

---

## 2. 模块 A · 统一收益分配与财务扣除模型

### 2.1 目标口径定义（用户指定）

引入**二级科目**，把"算力"与"内容"彻底分开：

```
P_compute（基础算力费） = prompt_tokens/1000 × prompt_price_per_1k
                        + completion_tokens/1000 × completion_price_per_1k

P_royalty（创作者版税） = P_compute × royalty_rate        （默认 0.15，模型级）

场景 A（BASE，开源基础模型）：
    买家实付 = P_compute
    节点     = 0.85 × P_compute
    平台     = 0.15 × P_compute

场景 B（CREATOR，付费增强模型）：
    买家实付 = P_compute + P_royalty
    节点     = 0.85 × P_compute
    平台     = 0.15 × P_compute  +  0.15 × P_royalty     ← 算力管理费 + 模型市场管理费
    创作者   = 0.85 × P_royalty                          ← 版税池的 85%
```

**守恒不变式（新增，必须进回归）**：

```
Σ(节点 + 创作者 + 平台) == 买家实付     （逐请求精确相等，容差 1e-9）
```

### 2.2 与现状的差异，以及"买家会不会多付"（**最关键的设计判断**）

| 科目 | 现状（`settle_cost`） | 目标口径 | 差异 |
|---|---|---|---|
| 场景 A 节点 | `0.85 × base` | `0.85 × P_compute` | 无 |
| 场景 A 平台 | `0.15 × base` | `0.15 × P_compute` | 无 |
| 场景 B 节点 | `0.85 × base` | `0.85 × P_compute` | 无 |
| 场景 B 创作者 | `0.15 × base` | `0.85 × P_royalty = 0.1275 × base` | **−15%** |
| 场景 B 平台 | `0.15 × base` | `0.15×P_compute + 0.15×P_royalty = 0.1725 × base` | **+15%** |
| **场景 B 买家实付** | **`1.15 × base`** | **`1.15 × base`** | **不变** |

> ✅ **推荐口径（D1 建议采纳）**：把 `P_royalty` 定义为**现行版税池**（`0.15 × P_compute`），
> 再按 85/15 切给创作者与平台 ⇒ **买家实付一分不变**（`1.15 × base`），
> 变的只是"创作者 ↔ 平台"之间那 15% 版税的再分配。
> 这条路径**不触碰"不改计费语义"红线**（红线保护的是买家侧价格与总量）。
>
> ⚠️ 另一条路径：若把 `P_royalty` 定义成**额外的、买家另付的加价**（例如 `P_royalty = 0.15 × base` 之外再加），
> 场景 B 买家实付将变成 `1.1725 × base` ⇒ **涨价**。这需要显式拍板（决策 **D1**）。

### 2.3 落库设计

#### 2.3.1 `models`（模型元数据）

| 新列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `royalty_rate` | REAL | 0.15 | 版税率（作用于 P_compute） |
| `royalty_mode` | TEXT | `'RATE'` | `RATE`=按算力费比例 / `ABSOLUTE`=每 1K 固定加价（预留，阶段五只实现 RATE） |

- 种子模型统一 `royalty_rate=0.15` ⇒ **迁移当天买家价格零变化**（D4）。
- `royalty_mode` 的 `ABSOLUTE` 留位但**不实现**（避免半吊子功能）。

#### 2.3.2 `usage_logs`（用量与分账明细）

新增列（全部 `REAL DEFAULT 0.0`，`_ensure_column` 幂等补齐）：

| 列 | 含义 |
|---|---|
| `p_compute_usd` | P_compute（基础算力费） |
| `p_royalty_usd` | P_royalty（版税池总额） |
| `node_compute_share_usd` | 0.85 × P_compute |
| `platform_compute_fee_usd` | 0.15 × P_compute |
| `creator_share_usd` | 0.85 × P_royalty（**创作者实得**） |
| `platform_royalty_fee_usd` | 0.15 × P_royalty（模型市场管理费） |
| `royalty_rate_snapshot` | 本次结算用的版税率（费率会变，账单要留快照） |

**旧列语义冻结（避免下游全线改口径）**：

| 旧列 | 冻结语义 | 说明 |
|---|---|---|
| `node_earn_usd` | = `node_compute_share_usd` | 数值不变 |
| `creator_royalty_usd` | = **P_royalty 总额**（不是创作者实得！） | ⚠️ 与新 `creator_share_usd` 差 15%，语义必须在注释里写死 |
| `platform_fee_usd` | = `platform_compute_fee_usd` | 数值不变；平台总收另由新列表示 |

> ⚠️ **必须同步修的展示层**：`AnalyticsCard` / `RoyaltyCard` 聚合的是 `SUM(creator_royalty_usd)`，
> 若不改成 `SUM(creator_share_usd)`，**创作者大盘会虚高 15%**（决策 **D2** 一并处理）。
> **平台的展示同理**：现聚合 `SUM(platform_fee_usd)` 会**少算**版税管理费。

#### 2.3.3 新表 `revenue_ledger`（**收益分配的真实落点**）

这是模块 A 的核心新增物：**append-only 的结算级分账流水**，让三方收益各自有据可查、可对账、可提现。

```sql
CREATE TABLE IF NOT EXISTS revenue_ledger (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id            TEXT NOT NULL,          -- 与 usage_logs 同键，幂等
    account_handle        TEXT NOT NULL,          -- 买家句柄
    model_id              TEXT NOT NULL,
    model_tier            TEXT NOT NULL,
    node_id               TEXT DEFAULT '',
    owner_handle          TEXT DEFAULT '',        -- 算力业主句柄（阶段四 D4 口径）
    creator_wallet        TEXT DEFAULT '',        -- 模型创作者钱包
    p_compute_usd         REAL NOT NULL DEFAULT 0.0,
    p_royalty_usd         REAL NOT NULL DEFAULT 0.0,
    node_share_usd        REAL NOT NULL DEFAULT 0.0,
    creator_share_usd     REAL NOT NULL DEFAULT 0.0,
    platform_fee_usd      REAL NOT NULL DEFAULT 0.0,
    prompt_tokens         INTEGER DEFAULT 0,
    completion_tokens     INTEGER DEFAULT 0,
    settled_at            REAL NOT NULL,
    currency              TEXT DEFAULT 'USD'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_revenue_ledger_request
    ON revenue_ledger(request_id);
```

- **`request_id` 唯一索引 = 幂等键**，与 `usage_logs` 同口径（一次请求一条分账流水）。
- 与 `usage_logs` / `balance_ledger` **在同一个 `BEGIN IMMEDIATE` 事务内写入**
  ⇒ 新增不变式"**分账守恒**"与"**账实相符**"同时成立，不需要事后对账。
- **不动 `balance_ledger`**：它是买家侧账本，`NET == BAL` 的口径保持原样（避免动 Phase-3 不变量）。
- 提现口径（P2 切换）：
  - 创作者可提现额 = `SUM(revenue_ledger.creator_share_usd)` − 已提现（`creator_withdrawals`）；
  - 节点业主应收 = `SUM(revenue_ledger.node_share_usd)`（权威口径），`nodes_history.total_earnings_paw` 降级为展示缓存。

#### 2.3.4 `balance_ledger` 与"账实相符"的关系（务必讲清楚）

现状恒等式（`db.py:1293-1298` 注释）：

```
SUM(balance_ledger.direction × amount_usd) == SUM(users.balance_usd)
```

- 该恒等式**只覆盖买家侧**（`balance_ledger.api_key` = 买家句柄）。
- 模块 A **不改变**这个恒等式：分账流水是**另一本账**（`revenue_ledger`），不混入 `balance_ledger`。
- 新增第二条恒等式（模块 A 专属）：

```
Σ(revenue_ledger.node_share + creator_share + platform_fee) == Σ(usage_logs.cost_usd)
```

⇒ 两条账各自自洽，**互不污染**。这是"统一收益分配"与"不破坏阶段三结算"的解耦点。

### 2.4 代码改造点

| # | 改动 | 文件 | 备注 |
|---|---|---|---|
| A-1 | 新增 `settle_cost_v2(model, p_tokens, c_tokens) -> Dict[str, float]` | `db.py` | 返回 **9 个字段**：`p_compute_usd / p_royalty_usd / node_share_usd / creator_share_usd / platform_compute_fee_usd / platform_royalty_fee_usd / platform_fee_usd / total_usd / buyer_total_usd` |
| A-2 | `finalize_usage_atomic` 增加分账参数与 `revenue_ledger` 写入 | `db.py` | **同事务**；`request_id` 冲突按现有 `duplicate=True` 处理 |
| A-3 | `migrate_phase5_billing_split()` | `db.py` | 加列 + 建表 + 建索引；**幂等、可重跑、失败整体回滚**（沿用 `migrate_phase4_*` 模式） |
| A-4 | `get_creator_royalty` / 业主收益聚合改口径 | `db.py` | 改用 `revenue_ledger` |
| A-5 | `/api/v1/user/analytics` 增加 `split` 聚合 | `server.py` | 前端费用拆解的数据源 |
| A-6 | `/api/v1/creator/royalty` 返回口径切换 | `server.py` | 提现页展示 |
| A-7 | `models.royalty_rate` 随 `/v1/models` 下发 | `server.py` | Playground 费率展示需要 |

> ⚠️ **不改 `settle_cost` 本身**：保留 v1 函数与 v2 并存，用开关 `APIPAW_BILLING_SPLIT_V2` 选择，
> 便于影子对账与一键回滚（见 §5）。

### 2.5 历史数据处理（决策 **D2**）

`usage_logs` 已有历史行，`cost_usd` = 买家实付总额：

- BASE 行：`P_compute = cost_usd`，`P_royalty = 0`；
- CREATOR 行：`P_compute = cost_usd / 1.15`，`P_royalty = cost_usd − P_compute`。

**推荐：不回填历史**（新口径只对迁移之后的新请求生效）。
理由：历史行的创作者收益已按旧口径进入 `creator_withdrawals`（已提现），回填会与已提现记录冲突，
且会**追溯改变**三方历史应付金额 —— 这属于"改账"，风险远大于收益。
若决定回填，必须同时：① 冻结提现 ② 写迁移报告 ③ 与财务口径对齐。

---

## 3. 模块 B · Matchmaker 公平路由机制（盲派单防挑单）

### 3.1 问题的准确定位

要防的是**节点挑单（Cherry-Picking）**：节点只挑佣金高的单子，稀缺的高价值算力被低价值单占住，
或高价值单被反复推给"能跑但不想跑"的节点。**根源有两层**：

1. **信息层**：节点能看见模型身份（`payload.model`，`server.py:1994`）**和**这一单的三方分成
   （`SETTLEMENT_RECEIPT` 里的 `creator_royalty_usd` / `platform_fee_usd`，`server.py:2101-2111`）
   ⇒ 节点有足够信息算出"这单值不值"。
2. **价格层**：节点报酬 = `模型单价 × 0.85` ⇒ **跑不同模型单价不同 ⇒ 报酬不同 ⇒ 挑单有经济动机**。
   场景 B 的模型更贵（种子数据 `qwen-2.5-72b` 0.35/0.42 vs `llama-3.3-70b` 0.26/0.40），
   节点跑场景 B 天然赚更多 —— **在现有定价下，"盲派单"在协议层根本做不到**，因为价格差异是公开且可推算的。

⇒ **模块 B 必须同时动"信息"和"价格"两层**，只做信息层是自欺欺人。

### 3.2 设计：盲派单三件套

#### 套件一：**能力等级 + 统一算力单价**（治价格层）

- 节点按硬件能力分档 `compute_class`（如 `C1/C2/C3`，依据 `max_vram_gb` + 硬件类型 + FLOPs 档位）。
- 节点报酬改为 **`compute_class` 单价 × token 数**，**与跑哪个模型无关** ⇒ **单位算力报酬一致**。
- 买家侧 `P_compute` 仍按模型单价计算（模型定价是**买家价**，与节点报酬脱钩）。

> ⚠️ 这会**改变三方分配数额**（节点拿到的 ≠ `0.85 × P_compute`），进而影响"平台赚多少"，
> 属于**定价模型级变更**，必须显式拍板（决策 **D5**）。
> 阶段五推荐**分两步走**：
> - **P0/P1（零定价变更）**：先做套件二 + 套件三（隐藏信息 + 惩罚拒单），把"挑单"从**确定性**降为**不可能**；
> - **P3（定价变更）**：能力等级与统一单价上线，与 APIPaw Agent 客户端 v1.1 一起发。

#### 套件二：**不透明派单**（治信息层）

- 派单帧**不再出现 `model_id`**，改为 `model_ref`（不透明句柄，如 `m-<8位hash>`）+
  `capability_class`（能力等级标签，不是绝对 VRAM 数 —— 绝对显存会反推模型规模进而反推场景）。
- 节点凭 `model_ref` 从受权端点取**执行规格**（权重位置/量化/上下文上限），该规格**不含任何商业信息**
  （无 tier、无费率、无分成）。
- **协议版本 v2**（`DISPATCH_PROTOCOL.md:261-267` 的版本协商条款）：`INIT` 回报 `protocol_version`；
  不支持 v2 的旧节点在过渡期仍收 `model` 字段（云端按节点能力裁剪字段）。
- **结算回执瘦身**：`SETTLEMENT_RECEIPT` 只保留 `tokens` + `node_own_earning` + `class`，
  **删除** `creator_royalty_usd` / `platform_fee_usd` ⇒ 节点不再知道这一单的平台/创作者分成。
  （这一刀成本极低、收益极大，建议 P1 立刻做。）

#### 套件三：**指派而非招揽 + 拒单惩罚**（治行为层）

- 节点**不能自选任务**，只有"接 / 让退"两个动作；让退不是免费的：
  - 让退 → 该节点进入 **30s 冷却**（文档早有约定，`DISPATCH_PROTOCOL.md:222-230`，代码未实现）；
  - 连续让退 → `reliability_score` 降权 → 候选池排序下沉 → 长期反复让退的节点不再被选中；
  - 让退率进入节点信用分，可作为后续"是否进入高价值池"的门槛。
- **单节点在途上限** `max_concurrent_per_node`（默认 1）⇒ 独占派单，杜绝"一个节点囤积所有单"。

### 3.3 候选池与公平排序（治分配层）

**候选池条件**（全部满足）：

| # | 条件 | 依据 | 现状 |
|---|---|---|---|
| 1 | `alive`（心跳 60s 窗口） | 注册表 | ✅ 已有 |
| 2 | `channel == 'websocket'` | 注册表 | ✅ 已有 |
| 3 | `status == 'IDLE'` | 客户端上报 | ✅ 已有 |
| 4 | `capability_class ≥ 模型要求等级` | `models.min_vram_gb` 派生 | ❌ **未实现**（P1/P3 才有） |
| 5 | 在途数 < `max_concurrent_per_node` | 网关计数 | ✅ **P0 已实现**（进程内计数，`APIPAW_NODE_MAX_INFLIGHT=1`） |
| 6 | `now < cooldown_until` | 网关维护 | ✅ **P0 已实现**（进程内字典，`APIPAW_NODE_YIELD_COOLDOWN_SEC=30`） |

**排序规则（公平优先、可复现）**：

1. **`last_dispatched_at` 升序**（最久未被派单的优先）—— **天然公平、防热点**；
2. `reliability_score` 降序（同等待时间时，让退少的优先）—— ❌ `reliability_score` 属 **P2**；
3. `node_id` 字典序（兜底，保证确定性、可测试复现）。

> ⚠️ 改造前现状是 `candidates[0]`（按 node_id 字典序）⇒ **热点节点反复被派、尾部节点饿死**。
>
> ✅ **P0 已落地**（`server.py` 的 `_apply_fair_order`，开关 `APIPAW_MATCHMAKER_FAIR`，**默认关**）：
> ① 剔除冷却中的节点 → ② 剔除在途超限的节点 → ③ 按 `last_dispatched_at` 升序 → ④ `node_id` 字典序兜底。
> `last_dispatched_at` / `cooldown_until` / `inflight` 三项目前都是**进程内**状态
> （v0.1 为单 worker 部署，语义正确；切多 worker 前需外置或按 worker 亲和）。

**新增注册表字段**（`node_registry` 加列，不改列名，兼容 3.7.17）：
`compute_class` / `last_dispatched_at` / `reliability_score` / `cooldown_until` / `inflight_requests`。
（P0 未加列 —— 上述四项走进程内内存；注册表落列留到 P1/P2 与多 worker 方案一并决定。）

### 3.4 可观测性（"公平"必须可证）

每次派单记录**决策元数据**：`candidate_pool_size` / `selected_reason` / `yielded_by` / `retry_count`，
落 `revenue_ledger` 附列或独立 `dispatch_log` 表。派生告警：

- 单节点 10 分钟内被派单占比 > 40% ⇒ 热点告警；
- 让退率 > 20% ⇒ 信用告警；
- 候选池为空（`ERR_INSUFFICIENT_VRAM`）的模型占比上升 ⇒ 算力结构告警。

### 3.5 与既有文档的关系

`DISPATCH_PROTOCOL.md` 的 §2.3「网关缺失的 5 项」与 §10「未决问题」里有若干条目**至今仍未落地**
（下发通道、候选池、失败转移、让退冷却、`SETTLEMENT_RECEIPT` 要不要做）。
阶段五的模块 B **正是把这些欠账一次性清掉** —— 蓝图落地时必须同步更新 `DISPATCH_PROTOCOL.md` 与 `PAWMODEL_SPEC.md`
（§2.3 的结算公式与 `db.settle_cost` 对齐，规格书才是单一真源）。

> ✅ **P0 已完成文档同步（2026-11-11）**：
> `PAWMODEL_SPEC.md` §2.3（目标口径 + 守恒不变式 + 口径演进说明）、
> `DISPATCH_PROTOCOL.md` §3.4（公平排序现状）/ §3.6（让退冷却）/ §4.2（采样参数下发）/
> §4.7（回执瘦身）/ §6.2（两套结算公式 + 系统提示词计费）/ 新增 §17（阶段五 P0 变更记录）。

---

## 4. 模块 C · APIPaw Pocket 大模型试炼场

### 4.1 设计原则

1. **协议真、答案也要真**：现在 SSE 是真的、答案是模板模拟的 —— UI **必须明示来源徽标**（模拟 / 真实节点），
   否则用户会以为模型"不聪明"。这是诚实性红线（决策 **D8**）。
2. **数据在手先接上**：费用拆解（算力费 / 版税）后端**已经发了**，前端只是没接（P0 就能出效果）。
3. **不新增后端依赖**：TTFT / Tokens-s 先在前端本地算（P2），后端补字段留到 P4。

### 4.2 P0 · 参数面板 + 费用拆解（**零定价变更**） ✅ 已完成（2026-11-11）

**前端**（`D:\APIPawPocket\src\components\PlaygroundCard.tsx`）：
- 复用 `Slider.tsx`（props 已含 `label/formatValue/hint/scaleLabels/testID`，`Slider.tsx:7-28`）做
  `temperature`(0~2) / `top_p`(0.05~1) / `max_tokens`(128~8192) 三个滑块；
  testID 分别为 `pg-temp-slider` / `pg-topp-slider` / `pg-maxtokens-slider`（含 `*-track` / `*-thumb`）；
- 参数面板默认收起，开关 `playground-params-toggle`，摘要条 `playground-params-summary` 常驻显示当前值；
- `System Prompt` 用 `TextInput`（testID `pg-system-input`），非空时以 `role="system"` 插到消息数组最前；
- `RunStats` 扩容：`{costUsd, cgas, baseComputeUsd, nodeEarnUsd, creatorRoyaltyUsd, platformFeeUsd}`
  （数据源 `server.py` 的 `usage_payload`，前端类型 `cloudClient.ts:265-278`）；
- 费用拆解三行（`playground-cost-compute` / `playground-cost-royalty` / `playground-cost-platform`）
  —— 算力费 / 创作者版税 / 平台管理费，数值**全部取后端下发值**，前端不自行推算；
- 请求体补参数：`{model, messages, stream, temperature, top_p, max_tokens}`（`cloudClient.ts` 的 `streamChat`）；
- **导出代码同步参数**：curl / python / javascript 三个 tab 的片段都带上当前采样参数与 system 消息。

**后端（小改）**（`D:\APIPawCloud\server.py`）：
- `ChatCompletionReq` 增加 `top_p: Optional[float]`（此前只有 `max_tokens`/`temperature`，前端传 `top_p` 会被静默丢弃）；
- **系统提示词纳入计费**（决策 D7 已拍板"计费"，并在 P0 顺手修掉）：
  预扣与结算的 `prompt_tokens` 改为 `system_text + prompt_text`；
  ⚠️ 真实节点路径不受影响（节点回报的 usage 会覆盖估算值），变化只落在模拟/兜底路径的预扣金额；
- 采样参数**透传给真实节点**并在网关侧夹取边界：`temperature` [0,2] / `top_p` [0,1] / `max_tokens` [1,32768]；
- `usage_payload` 增下发 `base_compute_usd`（供前端展示算力费）；
- 无需改数据库。

**验收**：`e2e/playground-params.cjs`（照抄 `e2e/limit-sync.cjs:130-175` 的 route mock 套路）——
**23/23 通过**：① 面板可展开、四类控件齐全 ② 滑块真的可拖（CDP 触摸事件，摘要随动）
③ 请求体含四个参数 ④ system 消息在最前且内容一致 ⑤ 费用拆解三行取后端下发值。

### 4.3 P1 · 多模型切换与场景标识

- 模型选择器：数据源 `GET /v1/models`（`cloudClient.ts:434`），`ModelInfo` 已含
  `tier` / `pricing.{prompt,completion}_per_1k_usd` / `context_window` / `reasoning`（`cloudClient.ts:165-175`）；
- **场景徽标**：场景 A「开源基础模型」/ 场景 B「社区创作者模型」+ 版税率（`Pill` 组件，`ui.tsx:187`），
  复用后端已有的 `TIER_LABELS`（`db.py:102-105`）与 `share_note` 文案（`db.py:2084`）；
- **切换即时性**：切换后保留对话历史与参数（`usePawStore` 已有会话态持久化）；
- **预估花费**：按当前输入长度 × 模型单价实时估算，显示"本次预计花费"（避免盲发后才发现没钱）。

### 4.4 P2 · 流式、CoT 与性能读数

- **CoT 卡片增强**：已有 `ReasoningCard`（`PlaygroundCard.tsx:89-140`），
  补：来源徽标（真实节点 CoT vs 模拟 CoT —— `server.py:2020-2029` 决定 `reasoning_text` 是否为空）、
  折叠时显示 token 量、复制按钮；
- **TTFT（首字延迟）**：前端本地计时（`PlaygroundCard.tsx:312-318` 已有雏形），
  口径 = 请求发出 → 首个 `content` delta 到达；
- **吞吐（Tokens/s）**：按最后一个 chunk 的 `usage.completion_tokens` ÷ 首字之后的流式耗时；
  ⚠️ 注意"流式时序断言不可靠"（`route.fulfill` 一次性返回全量，e2e 只能断言数值存在，不能断言时序）；
- **性能读数展示**：`StatTile` × 3（TTFT / Tokens/s / 总 token）。

### 4.5 P3 · 代码导出与账单区拆解 ✅ 已完成（2026-11-13）

- **代码导出**：已有 curl/python/js 三 tab（`PlaygroundCard.tsx:245-308`），
  改成**从当前状态生成**（模型 + 四参数 + system + 流式开关），并显示"复制成功"反馈；
- **账单区场景占比**：新增"算力费 vs 版税"占比（照 `AnalyticsCard.tsx:194` 的 `TierDonut` 分段算法手绘 svg，
  `react-native-svg` 已在依赖里，`package.json:19`）；
- **单请求费用拆解卡**：把 `usage_payload` 的四项（算力/版税/平台/总额）在流末一次性渲染成"账单小票"。

### 4.6 P4 · 收官验收

- `design-check.cjs`（33 项）+ `live-console.cjs`（24 项）+ 新增 `playground-params.cjs` 全绿；
- `npx tsc --noEmit` 0 错；
- **双站点根覆盖**（`/var/www/apipaw-console` + `/var/www/apipaw-pocket`，nginx `apipaw-console.conf:26/58`），
  `nginx -t` → **只 `reload`**；
- 后端字段补齐（决策 **D9**）：`usage_payload` 增加 `ttft_ms` / `throughput_tps`（P4 由后端记录，跨设备可比、可回溯）。

### 4.7 前端可复用清单（避免重复造轮子）

| 需求 | 复用 | 备注 |
|---|---|---|
| 参数滑块 | `Slider.tsx` | **必须保持 `panResponder` 引用稳定**（`Slider.tsx:69-92`） |
| 指标读数 | `ui.tsx:60` `StatTile` | TTFT / tok/s / 费用 |
| 场景徽标 | `ui.tsx:187` `Pill` | 场景 A/B |
| CoT 折叠 | `PlaygroundCard.tsx:89` `ReasoningCard` | 已有 |
| 费用占比环 | `AnalyticsCard.tsx:194` `TierDonut` | 手绘 svg，算法可抄 |
| 卡片容器 | `ui.tsx:34` `Surface` | — |
| Toast | `ui.tsx:215` | 固定右下、`pointer-events:none`（`ui.tsx:320-332`） |

> ⚠️ RN 限制：无 `className`；Web 专属效果靠 `id` 前缀 + 注入 CSS（`src/ui/webTheme.ts:14-19`）。

---

## 5. 跨模块落地顺序 · 开关 · 灰度

| 阶段 | 模块 A | 模块 B | 模块 C | 出口判据 |
|---|---|---|---|---|
| **P0**<br>✅ 已完成 | 口径冻结 + 蓝图评审 + `PAWMODEL_SPEC`/`DISPATCH_PROTOCOL` 同步 | 候选池**公平排序**（最久未派单优先）+ 让退 30s 冷却 + `SETTLEMENT_RECEIPT` 瘦身 | 参数面板 + 费用拆解 + `e2e/playground-params.cjs` | 买家价格零变化；沙箱矩阵全绿 |
| **P1** | `settle_cost_v2` + `usage_logs` 新列 + `revenue_ledger` 建表 + `migrate_phase5_billing_split()`（**影子模式**：v2 只算不扣） | `model_ref` 不透明派单（协议 v2，向后兼容）+ `capability_class` 门槛 + 并发上限 | 多模型切换 + 场景徽标 + 预估花费 | 影子账与 v1 账**逐笔相等**（容差 1e-9） |
| **P2**<br>✅ 已完成 | v2 口径**切正**（开关翻正）+ 分账流水写正 + 提现口径切换 + analytics 聚合改口径 | `reliability_score` 降权 + 派单决策元数据落库 + 公平性告警 | CoT 卡片增强 + TTFT/吞吐读数 + 账单小票 | 守恒不变式全绿；买家侧账单无回归 |
| **P3**<br>✅ 已完成 | `royalty_rate` 模型级开放（受控） | **能力等级 + 统一算力单价**（定价级变更，需拍板 D5）**默认关** + Agent 客户端配套（显存上报链路） | 代码导出状态化 + 账单区占比环 | 三方分配额变化与预期一致（对照表签字） |
| **P4** | 对账报表 + 审计导出 | 协议 v2 全量切换 + v1 下线 | `ttft_ms`/`throughput_tps` 后端补齐 + 全量验收 | 两条账各自自洽；双站点根部署完成 |

**开关（全部默认关，逐级打开）**：

```
APIPAW_BILLING_SPLIT_V2=0|1     # A：v2 结算口径（影子→切正）
APIPAW_BILLING_SPLIT_CUTOVER=0|1  # A：v2 切正（权威口径，P2 起生产已开）
APIPAW_MATCHMAKER_FAIR=0|1      # B：公平排序 + 冷却 + 并发上限（P2 起生产已开）
APIPAW_NODE_BLIND_DISPATCH=0|1  # B：不透明 model_ref 派单
APIPAW_NODE_RELIABILITY=0|1     # B：节点信用分降权（默认 1）
APIPAW_COMPUTE_CLASS_PRICING=0|1  # B：能力等级统一算力单价（P3 新增，默认关 —— 定价级变更）
APIPAW_DISPATCH_ENABLED=0|1     # 既有：真实节点派单

# P3 附带：能力等级单价表（USD / 1k tokens，可环境变量覆盖 —— 调价不必改代码）
APIPAW_COMPUTE_CLASS_PRICE_C0=0.10
APIPAW_COMPUTE_CLASS_PRICE_C1=0.20
APIPAW_COMPUTE_CLASS_PRICE_C2=0.28
APIPAW_COMPUTE_CLASS_PRICE_C3=0.35
```

**灰度纪律**：每个开关单独开、单独观测、单独回滚；影子期（v2 只算不扣）至少跑满一个完整计费周期
（含工作日与周末两种负载形态），逐笔 diff 通过后才允许切正。

### 5.1 P0 交付记录（2026-11-11）

**已落地的代码改动**：

| 模块 | 改动 | 文件 |
|---|---|---|
| A（文档） | `PAWMODEL_SPEC.md` §2.3 换成 P_compute / P_royalty 目标口径 + 守恒不变式 + 口径演进说明；`DISPATCH_PROTOCOL.md` §3.4 / §3.6 / §4.2 / §4.7 / §6.2 同步 + 新增 §17 变更记录 | `D:\APIPawCloud\PAWMODEL_SPEC.md`、`DISPATCH_PROTOCOL.md` |
| B（Matchmaker） | 公平路由层 `_apply_fair_order`（冷却剔除 + 在途上限剔除 + 最久未派单优先）；`_mark_node_cooldown`（30s 冷却 + 让退计数）；`_node_inflight_count`；`SETTLEMENT_RECEIPT` 瘦身（只下发 `node_earn_usd`） | `D:\APIPawCloud\server.py` |
| C（Playground） | `ChatCompletionReq` 补 `top_p`；系统提示词纳入计费；采样参数透传 + 边界夹取（`temperature` [0,2] / `top_p` [0,1] / `max_tokens` [1,32768]）；`usage` 下发 `base_compute_usd`；前端参数面板（3 个 `Slider` + System Prompt 输入框）+ 费用拆解三行 + 导出代码同步参数 | `D:\APIPawCloud\server.py`、`D:\APIPawPocket\src\api\cloudClient.ts`、`D:\APIPawPocket\src\components\PlaygroundCard.tsx` |

**开关**（阶段五 P0 全部落地，默认值如下）：

```
APIPAW_MATCHMAKER_FAIR=0        # 默认关 —— P0 只让能力就位，灰度验证后再开
APIPAW_NODE_YIELD_COOLDOWN_SEC=30
APIPAW_NODE_MAX_INFLIGHT=1
```

**回归结果**：

| 套件 | 结果 |
|---|---|
| `D:\APIPawCloud\test_phase5_p0.py` | **25/25 通过**（公平排序 / 冷却 / 在途上限 / 参数透传与夹取 / 系统提示词计费 / 场景 B 口径 / 回执瘦身 / 让退冷却 / 账实相符 / 不透支） |
| `D:\APIPawCloud\test_dispatch.py` | **37/37 通过**（顺带修复了阶段四 P0 遗留的鉴权失配：原为 4/36） |
| `D:\APIPawPocket\e2e\playground-params.cjs` | **23/23 通过**（面板展开 / 滑块可拖 / 参数进请求体 / system 消息在最前 / 费用拆解渲染） |

**生产部署与验收（2026-11-11 ~ 2026-11-12）**：

| 步骤 | 动作 | 结果 |
|---|---|---|
| 备份 | `/opt/apipaw-backups/db/apipaw_20261111-p5p0.db` + `code/server.py.bak.20261111-p5p0` + `web/20261111-p5p0/{console,pocket}` | md5 留档 |
| 后端部署 | 新 `server.py`（md5 `0761c3a0…`，属主 `user001:user001` 644）→ `py_compile`（3.6.8）→ `systemctl restart apipaw-cloud` | `active`；`/health` 200、`/v1/models` 200 |
| 前端部署 | `expo export -p web`（产物 hash `index-32d64463….js`）→ 同步覆盖 `/var/www/apipaw-console` 与 `/var/www/apipaw-pocket` → `nginx -t` → **只 reload** | 两站点根 md5 一致；两域名均返回新 bundle 200 |
| 生产冒烟 | `smoke_p5_p0_prod.py`（现场签发一次性买家 Key，跑完删净） | **9/9 通过**：200 / `base_compute_usd` 下发 / 系统提示词计费(D7) / 场景 B `cost = base×1.15` / 版税 `= base×0.15` / NET==BAL / 冻结结清 |
| 基线复原 | 冒烟后重新采样 | `users=1`、`api_keys=2`、`usage_logs=27`、`balance_ledger=40`、`daily_spend=6`、`bal=net=1016.037562`、`integrity_check=ok` —— **与跑前逐项一致** |
| 线上 e2e | `e2e/live-console.cjs`（OWNER Key） | **24/24 通过**（首跑 22/24，2 项失败为 CF 边缘冷启动抖动 —— 应用渲染耗时 105s，超出脚本等待分级；重跑全绿） |
| 参数面板 e2e | `e2e/playground-params.cjs`（对 `dist/`） | **23/23 通过** |
| 归档 | GitHub：`apipaw-cloud` `2d6d181` + `c78f957`；`apipaw-pocket` `d93f68e`；源站镜像 `89ac23a` | 已推送 |

> 冒烟脚本踩过的坑：**必须用 CREATOR 档模型**（`qwen-2.5-72b`）验证 ×1.15 口径 ——
> `llama-3.3-70b` 是 BASE 档，买家实付 = base（场景 A），用它断言 ×1.15 必然假失败。

**未做（留给 P1 及以后）**：`settle_cost_v2` / `revenue_ledger` 建表 / 影子账 —— 属模块 A 的 P1，**P0 不碰生产计费口径**。

### 5.2 P1 交付记录（2026-11-11 ~ 2026-11-12）

**已落地的代码改动**：

| 模块 | 改动 | 文件 |
|---|---|---|
| A（二元分账底座与影子对账） | `migrate_phase5_billing_split()`（幂等迁移：`models` 补 `royalty_rate`/`royalty_mode`；`usage_logs` 补 7 个分账明细列；新建 `revenue_ledger` + `request_id` **唯一索引 = 幂等键**）；`settle_cost_v2()`（决策 D1 目标口径：场景 A 85/15，场景 B 算力 85/15 + 版税池**再切一次** 85/15 → 创作者 12.75% / 平台 17.25%，买家实付仍是 `1.15 × base`）；影子模式：`finalize_usage_atomic` 在**同一个 `BEGIN IMMEDIATE` 事务内**写明细列 + `revenue_ledger`；**既有列一律保持 v1 原值**（`node_earn_usd` / `creator_royalty_usd` / `platform_fee_usd` 不被覆盖） | `D:\APIPawCloud\db.py`、`server.py` |
| B（盲派单 v2 与硬件门槛） | 派单帧下发 `model_ref`（进程内随机盐加盐散列 → 重启即变）/ `capability_class`（C0~C3 粗分档，只给档位不给绝对显存）/ `protocol_version=2`；过渡期**双发** `payload.model`（线上 Agent 尚未支持 v2 解析）；`_select_dispatch_node(min_vram_gb=...)` 补齐硬件门槛，**fail-open**：没上报显存的节点一律保留，只认 `vram_total_gb`（或 `used+free`），**不认** `max_vram_gb` | `D:\APIPawCloud\server.py`、`DISPATCH_PROTOCOL.md` §3.4/§4.2/§6.2 |
| C（Playground P1） | `/v1/models` 补 `scenario` / `royalty_rate` / `royalty_mode`；前端场景徽标 + 模型下拉逐项场景标签 + 「本次预计花费」实时估算（场景 B 总价 = 算力费 × 1.15，场景 A 不计版税）+ 切换模型保留会话与参数状态 | `D:\APIPawCloud\server.py`、`D:\APIPawPocket\src\api\cloudClient.ts`、`src\components\PlaygroundCard.tsx` |

**开关**（P1 两个开关**已开**，其余保持 P0 默认）：

```
APIPAW_BILLING_SPLIT_V2=1      # A：影子分账（只写不算，买家扣费口径零变化）
APIPAW_NODE_BLIND_DISPATCH=1  # B：盲派单 v2（双发 model，向后兼容）
APIPAW_DISPATCH_ENABLED=1     # 既有：真实节点派单
```

**回归结果**：

| 套件 | 结果 |
|---|---|
| `D:\APIPawCloud\test_phase5_p1.py` | **32/32 通过**（迁移幂等 / 场景 A·B 口径 / 守恒 I6 / v1≡v2 逐笔 40 笔 diff=0 / 无节点折叠 / 幂等 / 显存门槛 fail-open / `model_ref` 与 `capability_class`） |
| `D:\APIPawCloud\test_phase5_p0.py` | **25/25 通过**（P0 未回归） |
| `D:\APIPawCloud\test_dispatch.py` | **37/37 通过** |
| `D:\APIPawPocket\e2e\playground-models.cjs` | **18/18 通过**（hermetic：场景徽标 / 下拉标签 / 版税 15% / 切换保留状态 / 预计花费 = 算力 × 1.15） |
| `D:\APIPawPocket\e2e\playground-params.cjs` | **23/23 通过**（P0 参数面板未回归） |

**生产部署与验收（2026-11-11 ~ 2026-11-12）**：

| 步骤 | 动作 | 结果 |
|---|---|---|
| 备份 | DB：`/opt/apipaw-backups/db/apipaw_20261111-173623-pre-p5p1.db` + `node_registry_20261111-173623-pre-p5p1.db`（`.backup` 快照 + `integrity_check`）；Web：`/var/www/apipaw-console-bak-20261111-173823` + `apipaw-pocket-bak-20261111-173823` | 已留档 |
| 后端部署 | 新 `server.py`（md5 `26eed755…`）+ `db.py`（md5 `8d8d33c6…`）→ `py_compile`（3.6.8）→ `systemctl restart apipaw-cloud` | `active`；启动日志「阶段五 P1 分账底座就绪」 |
| 迁移落地 | `models` +2 列 / `usage_logs` +7 列 / `revenue_ledger` 建表 + `idx_revenue_ledger_request` 唯一索引 | 存量行数不变（`usage_logs=27`），`integrity_check=ok` |
| 开关 | systemd 环境变量追加 `APIPAW_BILLING_SPLIT_V2=1` `APIPAW_NODE_BLIND_DISPATCH=1` | `systemctl show` 已确认 |
| 前端部署 | `expo export -p web`（产物 `index-17cfe767….js`）→ 同步覆盖 `/var/www/apipaw-console` 与 `/var/www/apipaw-pocket` → `nginx -t` → **只 reload** | 两站点根一致；两域名 200；线上 bundle 内含 `playground-scenario-badge` / `playground-cost-preview-*` 新 testID |
| 生产冒烟 | `smoke_p5_p1_prod.py`（现场签发一次性买家 Key，跑完删净） | **53/53 通过**：场景元数据 / 场景 B `cost = base×1.15` / 明细列按 v2 落库 / **旧列仍为 v1 原值** / `revenue_ledger` 一行且自身守恒 / 场景 A 无版税 / 幂等不重复扣费 / NET==BAL / 冻结结清 |
| 基线复原 | 冒烟 + 线上 e2e 后重新采样 | `users=1`、`api_keys=2`、`usage_logs=27`、`balance_ledger=40`、`daily_spend=6`、`revenue_ledger=0`、`models=5`、`bal=net=1016.037562`、`integrity_check=ok` —— **与跑前逐项一致** |
| 线上前端探针 | Playwright 打线上 `console.apipaw.com`（买家 Key） | **10/10 通过**：徽标「场景A · 开源基础」/ 下拉 5 个模型全带场景标签 / 场景 B 带「版税 15%」/ 预计花费随输入变化 / 无 JS 错误 |
| 线上全链路 e2e | `e2e/live-console.cjs` | 19/24 —— 5 项失败均为**业主/创作者端点 403**（本次用的是**买家**临时 Key，无 OWNER 角色），与 P1 无关；P0 时用 OWNER Key 是 24/24 |
| 归档 | GitHub：`apipaw-cloud` `5a14c8d`；`apipaw-pocket` `ed58441`；源站镜像 `c769a06`（+ 冒烟脚本 `faa370d`） | 已推送 |

**P1 踩过的坑**：

1. **`run_in_executor()` 不接受关键字参数** —— `finalize_usage_atomic(..., split=...)` 直接 `TypeError`
   把整笔结算打回（`usage_logs` 都不会落库）。必须用 `functools.partial` 绑定。
2. **键名对不齐会静默变成 0** —— `settle_cost_v2` 返回 `node_share_usd`，若 db.py 读
   `split.get("node_compute_share_usd")`，节点分成列恒为 0、守恒校验必挂。两端统一用 `node_share_usd`。
3. **别在影子模式里覆盖旧列** —— 早期版本把 v2 的值写回 `node_earn_usd` / `creator_royalty_usd` /
   `platform_fee_usd`，等于「打开影子开关就改了历史口径」。现在旧列只取调用方给的 v1 值。
4. **清理脚本的列名各表不同** —— 买家侧三张表用 `api_key` 存账户句柄，`revenue_ledger` 用
   `account_handle`；写错会抛 `no such column`，**清理中断 = 测试痕迹留在生产库**。
5. **响应里的金额是 6 位小数展示值** —— 断言 `usage.cost_usd == usage_logs.cost_usd` 要留 1e-6 容差，
   不是 1e-9。
6. **网关对场景 A 也下发 `royalty_rate=0.15`**（列默认值）—— 前端必须**按场景判定**是否计版税，
   否则场景 A 的预计花费被凭空放大 15%。

---

### 5.3 P2 交付记录（2026-11-12）

**已落地的代码改动**：

| 模块 | 改动 | 文件 |
|---|---|---|
| A（v2 切正 + 读侧全面切换） | 切正开关 `APIPAW_BILLING_SPLIT_CUTOVER`：**新行**买家实付取 v2 权威口径（数值与 v1 恒等 → 不变式 I5），**旧列同时落 v2 数字**（单行自洽，旧列上的 I6 同样成立）；**历史行一律不回填**（决策 D2）；读侧统一用 `CASE WHEN p_compute_usd > 0 THEN <v2 列> ELSE <v1 旧列> END` 平滑兼容 —— 覆盖 `get_usage_analytics`（新增 `eff_node_share_usd`/`eff_creator_share_usd`/`eff_platform_fee_usd`/`eff_royalty_pool_usd` 聚合 + `settlement` 四项 v2 字段）、`get_creator_royalty`（创作者收益 = 版税池 85%，另暴露 `royalty_pool_usd`/`platform_fee_usd` 透明化）、`record_withdrawal`（提现口径，带 `OperationalError` 回落，老库也不会 500）、`get_owner_nodes_revenue`（业主收益聚合新增 `split`） | `D:\APIPawCloud\db.py`、`server.py` |
| B（信用分降权 + 派单可观测性） | 新表 `node_reliability`（**落在主库**，不碰注册表 —— 规避 DAY13「database is locked」事故）与 `dispatch_log`（派单决策元数据：`candidate_pool_size`/`selected_reason`/`yielded_by`/`retry_count`/`outcome`）；`adjust_node_reliability()`（让退扣 0.15、成功接单回补 0.05、钳制在 [0.1, 1.0]）；`_apply_fair_order` 排序键改为 `(node_last_dispatched, -reliability, nid)` —— **信用分只作次级键**，不改变候选资格；信用分与 `MATCHMAKER_FAIR` **解耦**（30s 冷却过了仍要扣信用分）；`get_dispatch_fairness()` 公平性告警（单节点热点 >40% / 让退率 >20% / 候选池为空率 >20%）；`/api/v1/owner/dashboard` 回传 `dispatch_fairness` 与每节点 `reliability_score` | `D:\APIPawCloud\db.py`、`server.py` |
| C（Playground P2） | D8 来源徽标：响应头 `X-APIPaw-Dispatch` + `usage.answer_source` → 回答区与 `ReasoningCard` 双徽标（「真实节点 / 模拟回答」）；CoT 折叠态显示 token 数 + **一键复制**；D9 性能读数：`StatTile` 三连（**前端本地计时** TTFT / 吐字速度 tok/s / 总 token，流式过程中实时跳动）+ 流末「**账单小票**」（算力费 / 创作者版税 / 平台管理费 / 买家实付四项，取 v2 权威口径，老网关回落旧字段） | `D:\APIPawPocket\src\api\cloudClient.ts`、`src\components\PlaygroundCard.tsx`、`e2e\playground-perf.cjs` |
| 运维加固 | 新增 `deploy_backup.sh`（**一次做齐三份备份**：DB `.backup` 快照 + **源站后端代码文件单独备份** + 双站点根前端包）+ `docs/DEPLOY-RUNBOOK.md`（标准部署动作清单，红线写死） | `D:\APIPawCloud\deploy_backup.sh`、`docs\DEPLOY-RUNBOOK.md` |

**开关**（P2 起生产全部打开）：

```
APIPAW_BILLING_SPLIT_V2=1         # A：影子底座（保留，便于对照）
APIPAW_BILLING_SPLIT_CUTOVER=1    # A：v2 切正（权威口径）
APIPAW_MATCHMAKER_FAIR=1          # B：公平排序 + 30s 冷却 + 并发上限
APIPAW_NODE_RELIABILITY=1         # B：信用分降权
APIPAW_NODE_BLIND_DISPATCH=1      # B：盲派单 v2
APIPAW_DISPATCH_ENABLED=1         # 既有：真实节点派单
```

**回归结果**：

| 套件 | 结果 |
|---|---|
| `D:\APIPawCloud\test_phase5_p2.py` | **34/34 通过**（切正后旧列自洽 / 历史行不回填 / analytics 新旧混算 / 创作者 85% 口径 / 提现口径 / 信用分增减与钳制 / 公平性三级告警 / 端到端 I6 守恒） |
| `D:\APIPawCloud\test_phase5_p1.py` | **32/32 通过**（P1 未回归） |
| `D:\APIPawCloud\test_phase5_p0.py` | **25/25 通过**（P0 未回归） |
| `D:\APIPawCloud\test_dispatch.py` | **37/37 通过** |
| `D:\APIPawCloud\test_db_compat.py` / `test_py36_compat.py` | **8/8 / 6/6 通过**（老库兼容 + Python 3.6.8 语法兼容） |
| `D:\APIPawPocket\e2e\playground-perf.cjs` | **19/19 通过**（hermetic：来源徽标 / CoT 徽标 + 复制 + token 数 / TTFT·tok/s·token 三块 StatTile / 账单小票四项 v2 口径） |
| `D:\APIPawPocket\e2e\playground-params.cjs` / `playground-models.cjs` | **23/23 / 18/18 通过**（P0/P1 前端未回归） |

**生产部署与验收（2026-11-12）**：

| 步骤 | 动作 | 结果 |
|---|---|---|
| 备份（固定动作） | `bash deploy_backup.sh p5-p2` → `/opt/apipaw-backups/db/*.db`（`.backup` 快照）+ **`/opt/apipaw-backups/code/p5-p2_*_server.py|_db.py|…`**（**源站后端代码单独备份，P2 新增**）+ `/opt/apipaw-backups/web/*.tar.gz`（双站点根） | 已留档 |
| 后端部署 | `server.py`（md5 `219f1755…`）+ `db.py`（md5 `664ae16f…`）→ **Python 3.6.8 `py_compile` 通过** → `systemctl restart apipaw-cloud` | `active`；启动日志「阶段五 P2 派单底座就绪：`dispatch_log` + `node_reliability`」 |
| 开关 | systemd 追加 `APIPAW_BILLING_SPLIT_CUTOVER=1` / `APIPAW_MATCHMAKER_FAIR=1` / `APIPAW_NODE_RELIABILITY=1` | `systemctl` 已确认 |
| 前端部署 | `expo export -p web`（产物 `index-626ecbb4….js`）→ 同步覆盖 `/var/www/apipaw-console` 与 `/var/www/apipaw-pocket` → `nginx -t` → **只 reload** | 两域名 200，均指向新 bundle |
| 生产冒烟 | `smoke_p5_p2_prod.py`（现场签发一次性买家 Key + 临时创作者模型，跑完删净） | **38/38 通过**：新行 v2 明细守恒 I6 / **旧列也守恒** / 历史 27 行指纹逐字不变 / analytics 新旧混算不清零 / 创作者收益 = 版税池 85% + 池与平台费透明 / `dispatch_log` 元数据齐全 / NET==BAL |
| 基线复原 | 冒烟后重新采样 | `users=1`、`api_keys=2`、`usage_logs=27`、`balance_ledger=40`、`daily_spend=6`、`revenue_ledger=0`、`models=5`、`dispatch_log=0`、`node_reliability=0`、**`bal=net=1016.037562`**、`integrity_check=ok` —— **与跑前逐项一致** |
| 影子对账 | 服务日志 `SHADOW-MISMATCH` 计数 | **0** |
| 线上前端探针 | `node e2e/playground-perf.cjs https://console.apipaw.com`（打线上 bundle，API 用 mock 拦截，不碰真实账务） | **19/19 通过**：来源徽标「真实节点」/ CoT 徽标 + 复制 + token 数 / TTFT 45ms / tok/s / 账单小票四项 —— **线上 bundle 确已生效** |

**P2 踩过的坑**：

1. **无节点折叠分支漏改平台费总额** —— 折叠时把 `platform_compute_fee_usd` 改成 `P_compute`，
   却没重算 `platform_fee_usd`（总额）→ 「节点 + 创作者 + 平台」在 v2 明细上**不守恒**
   （沙箱实测 sum=0.013314 vs cost=0.051037）。切正后旧列也会跟着错。**折叠分支必须同时重算总额**。
2. **CORS 默认不暴露自定义响应头** —— Starlette `CORSMiddleware` 的 `expose_headers=()`，
   浏览器 JS **读不到** `X-APIPaw-Dispatch` → 来源徽标永远拿不到来源。必须显式
   `expose_headers=["X-APIPaw-Dispatch", "X-Request-Id"]`。
3. **urllib 会把响应头名规范化** —— `dict(resp.getheaders())` 给出的是 `X-Apipaw-Dispatch`，
   按 `X-APIPaw-Dispatch` 取会拿到 `None`，冒烟脚本会误报「响应头缺失」。统一转小写做**大小写无关**查找。
4. **冒烟脚本里阻塞 HTTP 调用会冻住事件循环** —— 直接在 asyncio 循环里调 `http.client`
   会让假节点来不及应答，请求拖到 20s 派单超时才发出去。必须 `loop.run_in_executor` 包一层。
5. **凭据大小写陷阱** —— `seed_node_credentials(node_ids, secret)` 的参数顺序；
   `db.get_balance` / `db.get_net_spend` **不存在**，余额核对要直接查 `balance_ledger` 与 `users`。
6. **部署脚本里的引号会吃掉整个循环** —— `"${VAR:-a b}"` 加引号后整串被当成**一个**目录名，
   前端备份循环一次都不执行（且**静默**）。要用无引号展开做分词。
7. **`tar | ssh` + `sudo -S` 会截断传输流** —— 远端 `echo pwd | sudo -S bash -c "tar xzf -"`
   会把 stdin 吞掉一半，报 `gzip: stdin: unexpected end of file`（本轮就把两个站点根清空了）。
   **改用 `scp` 传 `.tar.gz` 再本地解包**，别走管道。

### 5.4 P3 交付记录（2026-11-13）

**已落地的代码改动**：

| 模块 | 改动 | 文件 |
|---|---|---|
| A（模型级版税率） | `models` 补 `royalty_rate_updated_at` / `royalty_rate_updated_by`（**留痕**）；新建 append-only 表 `model_pricing_changes`（**改价流水**）；`db.update_model_royalty_rate()`（**受控**：仅场景 B、费率 ∈ `[0, 0.30]`、模式须为 `RATE`，非法一律抛 `ValueError` ⇒ 400，绝不静默忽略）；`db.list_model_pricing_changes()`；端点 `POST /api/v1/models/{model_id}/royalty`（**仅 OWNER**）+ `GET /api/v1/models/{model_id}/royalty/history`；**四处联动**：`estimate_hold_cost`（预扣按模型自己的费率）、`db.settle_cost`（v1 也跟模型走 —— 否则「关掉切正开关买家价格就悄悄退回 0.15」）、`db.settle_cost_v2`、`GET /v1/models` 下发 | `D:\APIPawCloud\db.py`、`server.py` |
| B（能力等级 + 统一算力单价） | `db.COMPUTE_CLASS_UNIT_PRICE_USD`（`C0`~`C3`，USD / 1k tokens，**可环境变量覆盖** ⇒ 调价不必改代码）；`MAX_NODE_COMPUTE_SHARE_RATIO = 0.85`（**安全上限**，防穿仓）；`db.settle_cost_v2(..., compute_class)` —— 平台算力分成做**差额平衡**（`platform_compute = P_compute - node_share`），守恒 I6 不破；`usage_logs` / `revenue_ledger` 补 `node_compute_class`（**事后可查**"这一单按哪个等级结的"）；`server._node_compute_class_of()`（与派单帧 `capability_class` **同一套判定**）；开关 `APIPAW_COMPUTE_CLASS_PRICING`（**默认关**） | `D:\APIPawCloud\db.py`、`server.py` |
| B′（**P3 补漏**：显存上报链路） | Agent WS 隧道帧新增 `vram_total_gb` / `vram_used_gb` / `vram_free_gb` / `gpu_temp_c`（**硬件**显存，≠ `max_vram` 的"当前模型所需显存"）；`telemetry.collect_gpu_metrics_cached()`（TTL 5s，WS 帧与 HTTP 心跳**共用**一次 `nvidia-smi`）；云端 `server._ws_node_meta()` 提取上述字段写入 `node_registry.meta_json` | `D:\APIPawAgent\telemetry.py`、`ws_tunnel.py`、`D:\APIPawCloud\server.py` |
| C（代码导出状态化 + 账单区占比环） | 导出代码从**当前实时状态**生成（当前模型 / 四参数 / System Prompt / **当前输入框内容** / **流式开关**）；新增**流式开关**（关掉走非流式一次性请求 `cloudClient.chatOnce()`，导出代码同步变成 `stream:false`，复制出去跑出的行为与界面一致）；「复制成功」反馈 + **切换 tab 清掉反馈**（状态化的经典小 bug）；账单区新增**二元费用结构占比环**（基础算力费 vs 版税池，手绘 SVG + 占比条）+ **三方分账**明细（节点 / 创作者 85% / 平台）；后端 `get_usage_analytics()` 新增 `split` 聚合（基础算力费用「总额 − 版税池」**反推** ⇒ 历史 v1 行与 v2 新行**同口径**，直接求和 v2 列会让历史行显示成 0） | `D:\APIPawPocket\src\api\cloudClient.ts`、`src\components\AnalyticsCard.tsx`、`src\components\PlaygroundCard.tsx` |

**开关（P3 新增的只有一个，默认关）**：

```
APIPAW_COMPUTE_CLASS_PRICING=0     # B：能力等级统一算力单价 —— 定价级变更，默认关
APIPAW_COMPUTE_CLASS_PRICE_C0..C3  # B：等级单价表（USD / 1k tokens），可环境变量覆盖
```

> 能力等级单价**默认关**的原因：它是**定价级变更** —— 会改变节点的实际收入
> （典型模型下 C0/C1/C2 节点拿得**比旧口径少**，C3 被安全上限截断后持平）。
> 按灰度纪律「单独开、单独观测、单独回滚」，且需先对照下方签字表。
> 其余 P3 改动（模型级版税率的**能力**、显存上报链路、前端导出与占比环）
> **不改变任何既有金额** ⇒ 可无条件上线。

**回归结果**：

| 套件 | 结果 |
|---|---|
| `D:\APIPawCloud\test_phase5_p3.py` | **45/45 通过**（A1~A12 模型级版税率 / B1~B8 等级单价与对照表 / C1~C5 显存上报链路） |
| `D:\APIPawAgent\test_vram_uplink.py` | **11/11 通过**（缓存语义 / 帧带显存 / 老客户端兼容 / 采集失败降级） |
| `D:\APIPawCloud\test_phase5_p0.py` / `test_phase5_p1.py` / `test_phase5_p2.py` | **25/25 / 32/32 / 34/34 通过**（P0~P2 未回归） |
| `D:\APIPawCloud\test_dispatch.py` | **37/37 通过** |
| `test_crypto_cross` / `test_py36_compat` / `test_auth_jwt` / `test_wallet_auth` / `test_db_compat` | **19 / 6 / 15 / 23 / 8 通过**（阶段四基线全绿） |
| `D:\APIPawPocket\e2e\playground-export.cjs` | **28/28 通过**（hermetic：占比环 / 导出状态化 / 复制反馈 / 流式开关联动） |
| `D:\APIPawPocket\e2e\playground-params.cjs` / `playground-models.cjs` / `playground-perf.cjs` / `limit-sync.cjs` | **23/23 / 18/18 / 19/19 / 8/8 通过**（前端未回归） |
| `npx tsc --noEmit` | **0 错** |

**生产部署与验收（2026-11-13）**：

| 步骤 | 动作 | 结果 |
|---|---|---|
| 备份 | `deploy_backup.sh p5-p3`：DB（`apipaw` + `node_registry` 的 `.backup` 快照）+ 后端源码 + **两个站点根** tar.gz | 已留档 `/opt/apipaw-backups/{db,code,web}` |
| 后端部署 | `server.py` + `db.py` + `smoke_p5_p3_prod.py` → `py_compile`（源站 **Python 3.6.8**）→ `systemctl restart apipaw-cloud` | `active`；`/health` → `{"status":"ok"}` |
| 字节级校验 | 源站文件的 `git hash-object` 与 GitHub `f70d9a0` 的 blob **逐一相等** | `ab44805c…` / `db29c01a…` / `439fd85c…` 三项全等 ⇒ 线上跑的就是已推仓库的那份字节 |
| 开关 | systemd 单元**显式**写入 `APIPAW_COMPUTE_CLASS_PRICING=0`（定价级变更，签字前保持关）+ `APIPAW_COMPUTE_CLASS_PRICE_C0..C3` | `systemctl cat` 已确认；其余 P0~P2 开关原样不动 |
| 前端部署 | `expo export -p web` 产物与线上**已部署** bundle 同哈希（`index-84178333….js`）⇒ 无需再动站点根（避免 `tar \| ssh` + `sudo -S` 的历史事故） | `console.apipaw.com` / `pocket.apipaw.com` 均 200 |
| 生产冒烟 | `smoke_p5_p3_prod.py`（现场签发一次性买家 Key，跑完删净） | **36/36 通过**：A1~A11 模型级版税率闭环（403/400/快照/流水/I6/回滚）/ B1~B5 等级单价与安全上限 / 三方分配额对照表 |
| 显存链路探针 | 对**线上正在跑的那份** `server.py` 抽函数单独 exec（不 import，避免与线上服务抢库） | v1.0.5 帧 → `vram_total_gb/used/free` + `gpu_temp_c` 全部提取到位；v1.0.4 帧 → 元数据保持干净（无 `vram_*`） |
| 基线复原 | 冒烟后重新采样 | `users=1`、`api_keys=2`、`usage_logs=27`、`balance_ledger=40`、`daily_spend=6`、`revenue_ledger=0`、`models=5`、`model_pricing_changes=0`、`bal=net=1016.037562`、`integrity_check=ok` —— **与跑前逐项一致** |
| 线上接口抽查 | `GET /v1/models` 5 个模型全部下发 `royalty_rate=0.15`；`POST/GET /api/v1/models/{id}/royalty`（+`/history`）路由在线（未带 Key → 401） | 买家价格与 P2 逐位相同（**I5 未破**） |
| 归档 | GitHub：`apipaw-cloud` `f70d9a0`；`apipaw-pocket` `9d02a96`；`apipaw-agent` `df2f43f` + tag `v1.0.5` + Release（含 `APIPaw-Agent-v1.0.5-Windows.zip`）；源站镜像 `d84f254` | 已推送 |

**⚠️ 三方分配额签字表（开关打开前必须签字）** —— 模型 `qwen-2.5-72b`，2000 prompt + 1000 completion token：

| 等级 | 算力基价 | 节点 | 创作者 | 平台合计 | 买家实付 | 截断 |
|---|---|---|---|---|---|---|
| （旧路径） | 1.1200000000 | 0.9520000000 | 0.1428000000 | 0.1932000000 | 1.2880000000 | — |
| C0 | 1.1200000000 | 0.3000000000 | 0.1428000000 | 0.8452000000 | 1.2880000000 | no |
| C1 | 1.1200000000 | 0.6000000000 | 0.1428000000 | 0.5452000000 | 1.2880000000 | no |
| C2 | 1.1200000000 | 0.8400000000 | 0.1428000000 | 0.3052000000 | 1.2880000000 | no |
| C3 | 1.1200000000 | 0.9520000000 | 0.1428000000 | 0.1932000000 | 1.2880000000 | YES |

- **买家实付在所有等级下完全一致**（I5 不破）；**创作者始终拿 0.85 × 版税池**（不随等级变）。
- **每一档都绝对守恒** Σ(节点+创作者+平台) == 买家实付（I6）。
- 平台在 C0/C1/C2 下**多拿**（差额平衡），C3 下与旧口径持平（被 0.85 上限截断）。
- ⚠️ **节点侧影响**：C0/C1/C2 节点的收入**低于**旧口径（例：C2 少 11.8%）。
  这是 D5「按能力定价」的必然结果 —— 若认为降幅过大，先调
  `APIPAW_COMPUTE_CLASS_PRICE_C1..C3`（环境变量，改完 restart 即生效，**不必改代码**）。

**P3 踩过的坑**：

1. **能力等级单价在生产会是「空转」** —— 云端要判等级就得知道节点显存，
   而生产主通道是 **WS 隧道**：隧道帧此前既不上报显存（Agent 侧）、
   云端也不提取显存（`_ws_node_meta`）⇒ 等级永远算不出来。
   **HTTP 心跳那条路早就通了**（`NodeHeartbeatReq` 早有 `vram_total_gb`），
   但生产节点几乎都走 WS ⇒ 两条路必须**同时**补齐，否则开关打开也是空转。
2. **`max_vram` 不是硬件显存** —— 它是「当前模型要多少显存」，
   拿它判「这块卡有多强」是**语义错误**。云端早已明确「只认 `vram_total_gb`」，
   P3 的等级判定沿用同一套口径。
3. **每周期跑两次 `nvidia-smi`** —— WS 帧与 HTTP 心跳各采一次，
   Windows 上单次 100~300ms。加 TTL 缓存后两条路**共用**一次采集。
4. **`run_in_executor` 不吃关键字参数** —— `run_in_executor(None, db.update_model_royalty_rate, ...)`
   会把 `changed_by` 当成 `executor` 的位置参数误传，必须用 `functools.partial` 绑定。
5. **Windows 控制台是 GBK** —— 冒烟/自检脚本里带 `⇒` 或 emoji 的用例名会
   直接抛 `UnicodeEncodeError`，让脚本**半路崩掉**（看起来像"脚本坏了"，
   实际只是 print 编码问题）。脚本开头统一 `sys.stdout.reconfigure(encoding="utf-8", errors="replace")`。

---

### 5.5 P4 交付记录（2026-11-14）· 阶段五收官

> 本轮起点是**一次断电/关机事故**（本地机器突然断电）。
> 事故后先做"灾后体检"（本地三仓 `.git/index.lock` / 残留临时文件、生产 systemd 开关、
> 双库 `integrity_check` 与基线采样），确认**生产未被波及**（服务器未重启、
> 服务 `active`、`/health` 200、双库 `integrity_check=ok`、基线逐项一致），
> 才继续推进 P4。**结论：无需任何生产数据回滚。**

**① P3 开关签字生效（`APIPAW_COMPUTE_CLASS_PRICING=1`）**

| 项 | 结果 |
|---|---|
| systemd 单元 | 显式声明 `APIPAW_COMPUTE_CLASS_PRICING=1`（签字后切正），`APIPAW_COMPUTE_CLASS_PRICE_C0..C3` 同时在单元里写明 |
| 线上观测 | `smoke_p5_p3_prod.py` **36/36 通过**（等级表单调、I5 不破、I6 守恒、0.85 上限） |
| 受控探针 | `probe_p5_p3_switch.py` **15/15 通过** —— 两个库指向**临时副本**、`import server`（跑真实部署模块），零生产数据触碰：显存判级 C1/C2/C3 ✓、老版本节点（未上报显存）等级为空（保持旧口径，不悄悄降薪）✓、派单帧与结算**同一套判定** ✓、截断后节点分成恰好 = 0.85×基价 ✓、截断时买家实付与守恒仍不变 ✓ |
| 探针踩坑 | `db.settle_cost()` 返回 `base_compute_usd` / `total_usd`，`settle_cost_v2()` 返回 `buyer_total_usd` —— 键名三套，别混用 |

**② 模块 A · 双账本对账报表 + 审计导出（新增两个 OWNER 只读端点）**

| 端点 | 作用 |
|---|---|
| `GET /api/v1/audit/reconciliation` | 返回 `db.reconcile_ledgers()` 完整结果：`balance_ledger`（账实相符，NET == BAL）、`revenue_ledger`（三方守恒）、`coverage`（v2 行与分账行的**集合级**覆盖）、`problems`（人可读问题清单）。`ok=false` 即账有问题 |
| `GET /api/v1/audit/export.csv` | 逐行导出「分账流水 × 买家实付」，末列 `accounting_ok` 直接给该行是否守恒（财务可用 Excel 直接筛异常行）。表头 `Content-Type: text/csv` + `Cache-Control: no-store` |

- **对账端点必须无副作用**：只读、不写库、不改账 —— 否则"跑一次报表"就能把账改坏。
- **覆盖度检查改为按 `request_id` 集合比对**（旧写法只比行数，行数相同但**行被换掉**也会误判为覆盖完整）。
- **审计导出以 `usage_logs` 为基表** `LEFT JOIN revenue_ledger`：生产 27 条历史行全是切正前的 v1，`revenue_ledger` 为空 ⇒ 以 `revenue_ledger` 为基表的导出会**导出 0 行**。
- v1 历史行的 `accounting_ok` 为**空串**（"不适用"），不是"不平衡" —— 两者语义必须分开。

**③ 模块 B · 派单协议 v2（盲派单全量切换，老版本 Agent 兼容）**

| 项 | 内容 |
|---|---|
| 载荷 | `model_ref`（加盐不透明 `m-<8 hex>`）、`capability_class`、`protocol_version=2`、`model_cipher`（HMAC-SHA256-CTR，密钥 = `SHA256("apipaw-dispatch-v2|" + node_secret)`，格式 `v2:<nonce>:<digest+cipher>`） |
| 密钥 | `dispatch_crypto.py`（`derive_key` / `encrypt_model` / `decrypt_model`），**逐节点密钥** ⇒ 密文只有该节点能解 |
| 开关 | `APIPAW_NODE_BLIND_DISPATCH=1`（systemd 单元显式声明） |
| 兼容 | 无凭证/老版本节点 ⇒ **自动回退 v1 明文派单**，不阻断既有节点接单 |
| 回归 | `test_dispatch_protocol_v2.py` **19/19 通过**（加解密往返、密文不含明文 model、载荷瘦身、无凭证回退 v1、v1 老客户端兼容） |

**④ 模块 C · 性能读数（`ttft_ms` / `throughput_tps`）后端落库 + 前端优先后端**

| 层 | 内容 |
|---|---|
| 后端 | `usage_logs` 增 `ttft_ms` / `throughput_tps` 两列（纯加列、幂等）；`usage_payload` 下发 `ttft_ms` / `throughput_tps` / `perf_source`（`node` = 节点上报，`local` = 服务端本地计时）。`ttft_ms` = 派单下发 → 节点**首个内容分片**；`throughput_tps` = completion_tokens ÷（首字→尾包）耗时 |
| 前端 | `cloudClient.ts` 的 `ChatUsage` 扩字段；`PlaygroundCard.tsx` 的 `finalizeRun` **优先采用后端值**，后端缺失才回退本地计时，并回写 `perfSource` 供 UI 标注数据来源 |
| 构建 | `npx tsc --noEmit` **0 错**；`expo export -p web` 产出 bundle `index-6665d70ec15b56285eb75556ca7078db.js` |
| 发布 | `scp` → `/tmp/webp5p4` → `sudo rsync -a --delete` 同步到 `/var/www/apipaw-console` 与 `/var/www/apipaw-pocket`（**不用 `tar \| ssh`**，历史事故：会把站点根清空）→ `nginx -t` 通过 → `systemctl reload nginx` |

**⑤ 终极回归与基线复原（2026-11-14）**

| 套件 | 结果 |
|---|---|
| `test_phase5_p4.py` | **45/45 通过**（模块 A 对账/审计导出 / 模块 B 协议 v2 / 模块 C 性能读数；含 A9.1 断言 `missing_split_request_ids` 精确等于被删流程的那一行） |
| `smoke_p5_p4_prod.py`（生产） | **35/35 通过**（模块 A：401/403/200、NET==BAL、守恒、CSV 表头与 `accounting_ok` 域、审计端点**只读**证明 / 模块 B：注册表读写、逐节点凭证、`protocol_version`、加解密往返、载荷瘦身、无凭证回退 v1 / 模块 C：`ttft_ms`/`throughput_tps`/`perf_source` 落库且 I6 守恒） |
| `test_phase5_p0/p1/p2/p3.py` | **25/25 / 32/32 / 34/34 / 45/45 通过**（P0~P3 未回归） |
| `test_dispatch.py` / `test_dispatch_protocol_v2.py` | **37/37 / 19/19 通过** |
| `test_node_auth.py` / `test_registry_concurrency.py` / `test_batch2_sandbox.py` | **34/34 / 11/11 / 32/32 通过**（源站 SQLite 3.7.17 上跑的批次 2 沙箱） |
| `test_crypto_cross` / `test_db_compat` / `test_py36_compat` / `test_auth_jwt` / `test_wallet_auth` | **19 / 8 / 6 / 15 / 23 通过**（阶段四基线全绿） |
| `D:\APIPawAgent\test_dispatch_v2.py` | **通过**（Agent 侧 v2 解密与 v1 兼容） |
| 前端 e2e（Playground 参数/模型/性能/导出/限额同步） | **全部通过**（对生产站点的临时 OWNER Key 验收，验完即删） |
| 基线复原 | `users=1`、`api_keys=2`、`usage_logs=27`、`balance_ledger=40`、`daily_spend=6`、`revenue_ledger=0`、`bal=net=1016.037562`、双库 `integrity_check=ok` —— **与跑前逐项一致，误差为 0** |

**P4 踩过的坑**：

1. **冒烟脚本的 `environ` 不继承 systemd 单元的环境变量** ⇒ 冒烟里 `NODE_BLIND_DISPATCH` 恒为 False，
   误判"v2 载荷含明文 model"。正解：**直接读 `/etc/systemd/system/apipaw-cloud.service`** 判断开关，
   再写进 `os.environ` 后才 `import server`。
2. **`media_type="text/csv; charset=utf-8"` 会被 Starlette 再补一次 charset** ⇒ 变成
   `text/csv; charset=utf-8; charset=utf-8`。只写 `"text/csv"`。
3. **只读性断言要取"审计调用前后"的快照**，不能拿"建账户前"的快照比 —— 建账户本身就是写。
4. **CSV 表头断言要看整个 `fieldnames`**，只看 `fieldnames[0]` 会把"缺列"漏成"通过"。
5. **SQLite 3.7.17 没有 `printf()`** ⇒ 生产上算钱用 `ROUND(x, 6)`。
6. **本地 Windows Python 的 SQLite 比生产新** ⇒ UPSERT / `VACUUM INTO` 之类版本差异在本地测不出来；
   批次 2 沙箱必须在**源站 venv（Python 3.6.8 + SQLite 3.7.17）**上跑才算数。

---

## 6. 不变量与回归红线

阶段五**不得破坏**以下既有不变式（阶段三/四已验证）：

| # | 不变量 | 当前保障机制 | 阶段五要求 |
|---|---|---|---|
| I1 | 余额不透支（`balance_usd >= 0`） | `finalize` 的 `WHERE balance_usd >= ?` + rowcount 判定（`db.py:1528-1536`） | 原样 |
| I2 | **账实相符 NET == BAL** | HOLD + SETTLE 两行配对 + 同事务快照（`db.py:1293-1298`） | **不动** `balance_ledger` 结构 |
| I3 | 同一 `request_id` 只结算一次 | `idem_key` 唯一索引 + `usage_logs.request_id` 唯一索引 + 事务内先查 | 新增 `revenue_ledger.request_id` 唯一索引 |
| I4 | 预扣先行（未消耗算力不扣费） | `reserve_usage_atomic` 在派单**之前** | 原样 |
| I5 | 买家价格（场景 A = base，场景 B = base×1.15） | `settle_cost` | **零变化**（决策 D1 推荐口径） |

**新增不变式**：

| # | 不变量 | 校验方式 |
|---|---|---|
| I6 | **分账守恒**：Σ(节点+创作者+平台) == 买家实付 | 沙箱矩阵逐笔断言，容差 1e-9 |
| I7 | **两账分离**：买家账与分账互不混入 | `balance_ledger` 无平台/创作者行；`revenue_ledger` 无买家余额字段 |
| I8 | 影子期 v1 ≡ v2 | 影子模式逐笔 diff（`request_id` 对齐） |

**语法/平台约束（写码时的硬检查）**：

- 禁 `ON CONFLICT ... DO UPDATE`（需 3.24）→ 用 `db.smooth_upsert`（`db.py:205-246`）；
- 禁 partial index（需 3.8.0）→ 主键兜底（`db.py:538` 的做法）；
- 禁 `ALTER TABLE ... RENAME COLUMN`（需 3.25）→ **只加列不改列名**（D4 只换值）；
- 禁 `VACUUM INTO`（需 3.27）→ 热备走 `.backup`；
- `ADD COLUMN IF NOT EXISTS` 不存在 → 用 `db._ensure_column`（`db.py:249-261`）；
- Python 3.6.8：不用 3.7+ 语法（`dataclasses` / `from __future__` 之外的新特性）；
- 迁移函数命名与幂等约定沿用：`migrate_phase5_*`，单 `BEGIN IMMEDIATE` 全事务、失败整体 ROLLBACK、可重跑、返回 stats。

---

## 7. 决策清单（**D1~D9 已全部拍板 · 2026-11-11**）

> **D1~D4 属模块 A（影响钱），D5~D6 属模块 B（影响调度与定价），D7~D9 属模块 C（影响体验与计费细节）。**
>
> ✅ **2026-11-11 用户正式拍板：D1~D9 全盘采纳「推荐」方案。** 下文每条决策下的
> 「推荐」即为**最终口径**，「备选」一律作废，后续实现与评审均以此为准。

### D1 · 买家实付是否变化？【最高优先级】

> ✅ **已拍板（2026-11-11）：采纳甲（不变）。** 场景 B 买家实付维持 `1.15 × P_compute`；
> `P_royalty`（`0.15 × P_compute`）内部按 85/15 切分 —— 创作者实得 **12.75%**、平台合计 **17.25%**。
> **买家侧零变化**，变的只是「创作者 ↔ 平台」那 15% 版税池的再分配。

- **推荐（甲）** ✅采纳：**不变**。`P_royalty` = 现行版税池（`0.15 × P_compute`），再按 85/15 切给创作者/平台。
  场景 B 买家实付仍为 `1.15 × base`；创作者从 15% → 12.75%，平台从 15% → 17.25%。**不触碰"不改计费语义"红线。**
- ~~备选（乙）：平台在版税上另抽、买家额外付费（场景 B 买家实付 `1.1725 × base`）⇒ **涨价**，需产品/财务确认。~~ 作废
- ~~备选（丙）：版税池比例从 15% 改为可配置（如 10%/20%），平台抽成随之变 ⇒ 定价体系重构，工作量与风险最高。~~ 作废

### D2 · 历史 `usage_logs` 是否回填新分账列？

> ✅ **已拍板（2026-11-11）：不回填。** 新口径**仅对新请求生效**，历史 `usage_logs` 保持原样。

- **推荐** ✅采纳：**不回填**（新口径只对迁移后新请求生效）。历史创作者收益已按旧口径进入 `creator_withdrawals` 已提现记录，回填=改账。
- ~~备选：回填（需冻结提现 + 出迁移报告 + 财务确认）。~~ 作废

### D3 · 三方要不要独立"账户 + 余额"？

> ✅ **已拍板（2026-11-11）：采纳「`revenue_ledger` 流水 + 派生余额」。**
> 物理隔离新建 `revenue_ledger` 表保全 `NET == BAL` 不变量，**不动 `users` 表结构**，不引入复式记账。

- **推荐** ✅采纳：阶段五先做 **`revenue_ledger` 流水 + 派生余额**（提现时按 SUM 计算），不动 `users` 表结构，
  不引入复式记账。真实「三方各有余额」留到阶段五 P4 或下一阶段评估。
- ~~备选：直接建三方位账户 + 复式账本（工作量大、回归面翻倍，且与现有 `users` 单表模型冲突）。~~ 作废

### D4 · `royalty_rate` 是否允许模型级自定义？

> ✅ **已拍板（2026-11-11）：P1 固定 0.15，P3 再开放模型级配置**，且**强制留存 `royalty_rate_snapshot`**。

- **推荐** ✅采纳：P1 只读固定 0.15（种子模型全 0.15，零价格变化）；P3 开放模型级配置，并要求"变更需改价、需留快照"。
- ~~备选：现在就开放（等于让创作者自主定价，会立刻改变买家价格）。~~ 作废

### D5 · 节点报酬是否从"模型价派生"改为"算力等级单价"？【模块 B 的命门】

> ✅ **已拍板（2026-11-11）：分两步走。** P0/P1 先治**信息层与公平排序**（回执瘦身、盲派单、
> 让退惩罚），**P3** 再引入 `compute_class` 统一算力单价（与 Agent 客户端配套发版）。

- **推荐** ✅采纳：**分两步** —— P0/P1 先做信息层（隐藏模型身份与分成、回执瘦身、拒单惩罚）+ 公平排序；
  **P3** 才引入能力等级与统一算力单价（与 Agent 客户端配套发版）。
- ~~备选：现在就统一单价（治本，但同时改定价与分配额，P0/P1 风险面过大）。~~ 作废
- ~~备选：永不统一单价（则"盲派单"只能做到事前，无法杜绝事后挑单 —— **这是最诚实的结论**）。~~ 作废

### D6 · 节点是否允许拒单（让退）？

> ✅ **已拍板（2026-11-11）：允许让退，但必须付代价。** 落地 **30s 冷却 + `reliability_score` 降权**
> （P0 落地 30s 冷却；`reliability_score` 属 P2）。

- **推荐** ✅采纳：**允许，但必须付代价** —— 30s 冷却 + `reliability_score` 降权 + 让退率公示。
  完全禁止会让强节点无法因"算力已被占满/显存不足"合理让退，反而造成假死。
- ~~备选：硬禁止（让退即降级为不可用）—— 风险是节点为避免惩罚而**硬扛**超额任务，反而拉高失败率。~~ 作废

### D7 · System Prompt 是否计费？

> ✅ **已拍板（2026-11-11）：计费。** 系统提示词按 prompt token 计入 `P_compute`。
> **已在 P0 顺手修掉**（用户授权："若放 P0 顺手修则一并加上"）—— 见 §4.2 与 `DISPATCH_PROTOCOL.md` §6.2。

- **推荐** ✅采纳：**计费**（按 prompt token 计入 `P_compute`）。现状 `estimate_tokens` 只统计 `role=='user'`（`server.py:1950-1957`），
  等于长 system prompt **免费搭便车**，是实打实的计费漏洞。
- ~~备选：保持免费（对创作者友好，但成本由平台承担）。~~ 作废

### D8 · Playground 是否明示"模拟回答 / 真实节点"？

> ✅ **已拍板（2026-11-11）：明示徽标。** 落在 **P1**（与多模型切换同批做，见 §4.3）。

- **推荐** ✅采纳：**明示徽标**（现状后端在无节点时回退模板答案，`server.py:2020-2029`；用户会误判模型能力）。
- ~~备选：不标（体验"更干净"，但诚实性有亏）。~~ 作废

### D9 · TTFT / Tokens-s 的测量位置？

> ✅ **已拍板（2026-11-11）：P2 前端本地计时 + P4 后端补齐字段。**
> 前端本地计时部分**已在 P0 顺带保留**（`PlaygroundCard.tsx` 的 `finalizeRun` 一直在算 TTFT / tok/s）。

- **推荐** ✅采纳：**P2 前端本地计时**（零后端改动、即时可见）+ **P4 后端补 `ttft_ms`/`throughput_tps`**（跨设备可比、可回溯）。
- ~~备选：只做后端（数据可回溯，但前端要等一轮协议升级才能显示）。~~ 作废

---

## 8. 验收矩阵与回归基线

沿用阶段三/四的成熟做法：**先 `.backup` → 沙箱矩阵 → 生产灰度 → 冒烟 → 回滚点**。

| 阶段 | 沙箱验证 | 生产验证 | 回滚点 |
|---|---|---|---|
| P0 | 沙箱矩阵 +32 项：公平排序（两节点轮流被派）、让退冷却、回执字段消失、参数进请求体、费用拆解出现 | 开关关；仅前端发布（双站点根 + `nginx -t` → reload） | 静态站回滚上一份 tar 包 |
| P1 | 影子对账：v1/v2 逐笔 diff（`request_id` 对齐，容差 1e-9）；`revenue_ledger` 行数 == `usage_logs` 行数 | 影子开关开 24h，观察 diff 与生产库指纹 | 关开关即回滚（数据不动） |
| P2 | 守恒断言 I6 逐笔通过；提现口径切换前后余额一致 | 守恒报表 + 账实相符（NET==BAL）+ integrity_check | 翻回 `APIPAW_BILLING_SPLIT_V2=0` |
| P3<br>✅ 已完成 | 三方分配额与签字对照表一致（沙箱 45/45，含对照表逐档断言）；能力等级筛选命中/落空正确（C3 24GB→C2 / 8GB→C1 / 未上报→保持旧口径） | 分成额抽查 + 节点侧协议 v2 兼容回归 | 能力等级开关（`APIPAW_COMPUTE_CLASS_PRICING`，默认关）+ 协议版本协商回退 v1 |
| P4 | 全量回归（阶段三/四全部矩阵 + 新增） | 端到端 e2e + 审计导出 | 数据迁移只加列/加表，**回滚 = 停用新读路径** |

**回归基线（必须保持全绿）**：
- 后端：`test_crypto_cross` / `test_py36_compat` / `test_auth_jwt` / `test_wallet_auth`（阶段四 40+23 项）；
- 前端：`design-check.cjs` 33 项、`live-console.cjs` 24 项、`wallet-login.cjs` 离线/线上各 17 项；
- 运维：生产双库 `integrity_check`、`NET == BAL`、`/health` 200。

---

## 9. 风险登记

| # | 风险 | 触发条件 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | **买家静默涨价** | 误把 D1 走成"平台另抽、买家另付" | 商业事故 | 蓝图阶段即锁口径；I5 断言"场景 B 买家实付 == base×1.15"进回归 |
| R2 | **历史改账** | 回填 `usage_logs` 历史行 | 创作者已提现金额对不上 | D2 默认不回填；回填需冻结提现 + 迁移报告 |
| R3 | **平台收入口径漂移** | analytics 仍聚合旧列 | 平台与创作者大盘同时失真 | 聚合口径与写入口径**同一批改**（A-5/A-6 与 P2 同批上线） |
| R4 | **节点侧协议断裂** | 下发 `model_ref` 但客户端未升级 | 派单全失败 → 回退模拟回答 | 协议版本协商 + 过渡期双发 + 灰度按节点能力裁剪 |
| R5 | **派单热点转移** | 公平排序上线 | 某些节点被冷落、某些被压满 | 排序含 `reliability_score` 次级键 + 决策元数据可观测 + 告警 |
| R6 | **分账表膨胀** | `revenue_ledger` 追加写 | 写放大 / 库体积 | 按 `settled_at` 归档策略（阶段五先不做，P4 评估） |
| R7 | **影子期双写不一致** | v1/v2 计算路径漂移 | 对账噪声、误判 | I8 逐笔 diff + 影子期至少一个完整计费周期 |
| R8 | **前端与后端参数不匹配** | 前端发 `top_p`，后端静默忽略 | 用户以为调参生效 | 蓝图中明确"后端 P0 加 `top_p` 字段"；e2e 断言请求体而非仅断言 UI |
| R9 | **双站点根漏覆盖** | 只更 pocket 不更 console | console 跑旧包 | 部署清单强制两站点根 + `nginx -t` → 只 reload |
| R10 | **账本污染** | 把平台/创作者流水写进 `balance_ledger` | 破坏 I2 账实相符 | 物理分表 `revenue_ledger`，代码层禁止跨表写（评审检查项） |

---

## 附录 A · 术语对照

| 术语 | 含义 | 代码字段 |
|---|---|---|
| P_compute | 基础算力费 | `p_compute_usd` |
| P_royalty | 创作者版税池 | `p_royalty_usd` |
| 算力业主 | 提供算力的节点所属账户 | `owner_handle` / `owner_wallet` |
| 模型创作者 | 上架场景 B 模型的钱包 | `models.author_wallet` / `creator_wallet` |
| 场景 A / B | 开源基础模型 / 社区创作者模型 | `models.tier` = `BASE` / `CREATOR` |
| 能力等级 | 节点算力档位（模块 B 新增） | `node_registry.compute_class` |
| 盲派单 | 下发帧不含商业信息、节点无挑单空间 | `model_ref` + `capability_class` |

## 附录 B · 本蓝图的事实依据

- 后端：`D:\APIPawCloud\db.py`、`server.py`、`PAWMODEL_SPEC.md`、`DISPATCH_PROTOCOL.md`（实读 2026-11-11）
- 前端：`D:\APIPawPocket\src\components\PlaygroundCard.tsx`、`AnalyticsCard.tsx`、`RoyaltyCard.tsx`、
  `Slider.tsx`、`ui.tsx`、`src/api/cloudClient.ts`、`src/store/usePawStore.ts`、`e2e/*.cjs`
- 阶段四收官状态：`project_apipaw_phase4_current_stage.md`（P0~P5 全部上线，cloud `2ecc76f` / pocket `323d25f`）
