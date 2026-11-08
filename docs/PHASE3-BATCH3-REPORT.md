# APIPaw Cloud 后端 · 阶段三批次 3 验证报告：计费系统改造（方案 B：预扣—结算）

> **日期**：2026-11-08
> **范围**：`/opt/apipaw-cloud/{db.py, server.py}`
> **依据**：`docs/PHASE3-BATCH3-BILLING-AUDIT.md` §6.3（方案 B）+ §6.5（配套清单）
> **生产 commit**：`3cc1e45`（`feat: 💰 批次3 计费系统改造…`）+ `c64e83b`（WAL 边车文件 ignore）
> **基线 commit**：`bae4a96`（批次 2）

---

## 0. 一句话结论

批次 3 把计费从「**请求开始读一次快照、请求结束才扣费**」的松散模型，
改造成「**派单前原子预扣 → 推理后按实际用量多退少补 → 失败原路退回并留痕**」的严格模型。
审计报告中的**三大 P0 全部关闭**，并新增了资金账本，使「余额为什么涨/跌」第一次可逐笔核对。

---

## 1. 改造前 → 改造后

| 维度 | 改造前 | 改造后 |
|---|---|---|
| 额度闸门位置 | 请求**开始**（读快照） | **派单之前**（原子预扣，零算力浪费） |
| 余额扣减 | `UPDATE users SET balance_usd = balance_usd - ? WHERE api_key = ?` | `… WHERE api_key = ? AND balance_usd >= ?`（rowcount 判定） |
| 单日限额 | 读已落库 `SUM(usage_logs)` | `daily_spend` 原子累加，`AND spent_usd + ? <= ?` |
| 单日口径 | `time.localtime()`（依赖服务器 TZ） | **UTC 自然日**（与 TZ 解耦） |
| 事务 | Python sqlite3 默认 deferred | `BEGIN IMMEDIATE` 手动写事务（全局串行） |
| 幂等 | `usage_logs.request_id` 软判断 | `usage_logs.request_id` 唯一索引 + `balance_ledger.idem_key` 唯一索引 |
| 资金流水 | **无**（`usage_logs` 只是用量流水） | `balance_ledger` 资金账本（双式记账 + `balance_after` 快照） |
| 冻结资金 | 无概念 | `users.balance_frozen_usd` |
| 扣费失败 | `except` 只 `print` 一行 → **白嫖** | 打印完整堆栈 + **原路退回预扣** + 落 `FAILED` 流水 |
| 结算回执 | 在 try 之外，照发「你赚到了 $X」 | **仅结算成功才下发** |
| 模拟回答 | `settle_node_id = dispatch_node_id or SIM_NODE_ID` → **给假节点计酬** | `or ""` → 无真实节点则分成 0 且**不写 nodes_history** |
| SSE 中途断连 | 无（扣费在结束帧前，但预扣会永久冻结） | `reap_stale_holds` 后台任务 60s 扫一次，超时原路退回 |
| 写锁等待 | 默认 5s → `database is locked` | `busy_timeout = 15000ms` |

---

## 2. 数据模型

### 2.1 `balance_ledger`（资金账本）

| 字段 | 含义 |
|---|---|
| `entry_type` | `OPENER` 期初 / `HOLD` 预扣 / `SETTLE` 结算 / `FAILED` 失败退回 / `USAGE` 历史回填 |
| `direction` | `+1` 入账 / `-1` 出账 |
| `amount_usd` | 恒为正数，方向由 `direction` 决定 |
| `balance_after_usd` | 记账后的余额快照（**对账锚点**） |
| `idem_key` | 幂等键，唯一索引；`HOLD:<rid>` / `SETTLE:<rid>` / `FAILED:<rid>` |
| `day_key` / `day_spent_usd` | UTC 自然日 + 当日累计快照 |
| `request_id` / `model_id` / `node_id` / tokens / `cost_usd` | 用量维度，便于「哪次请求哪个模型花多少」 |

索引：`idx_bl_api_time(api_key, created_at)`、`idx_bl_req(request_id)`、`UNIQUE idx_bl_idem(idem_key)`。

> **SQLite 3.7.17 兼容**：不能用 partial index（需 3.8.0）→ 改用独立 `idem_key` 列 +
> UNIQUE（NULL 可重复，不参与幂等）。

### 2.2 `daily_spend`（单日限额原子表）

`PRIMARY KEY (api_key, day_key)`，`day_key` = UTC `YYYY-MM-DD`。
把「查-改」变成一次原子累加，判据直接写在 `WHERE` 里。

### 2.3 `users.balance_frozen_usd`

已从余额划走但尚未结算的金额 —— 「钱卡在哪」的唯一真相。

### 2.4 双式记账

一次请求的净余额变化 = 该 `request_id` 下所有流水行的 `direction * amount` 之和：

```
HOLD  (-1, hold)          预扣，余额先划走
SETTLE (±1, |hold-actual|) 退差额或补差额
──────────────────────────────────────
净额  = -actual            恰好等于真实消费
```

---

## 3. 核心实现

### 3.1 三道并发防线

1. **`BEGIN IMMEDIATE`** —— 写事务一上来就拿写锁，SQLite 写事务全局串行，
   整段「检查 + 动作」不可被穿插（无 TOCTOU 窗口）。
   ⚠️ Python sqlite3 默认 deferred，从共享锁升级写锁会 BUSY/死锁 → 必须显式手动事务。
2. **判据写在 `WHERE` 里 + `rowcount` 判定** —— 不是「先查后写」：
   ```sql
   UPDATE users SET balance_usd = balance_usd - :hold,
                   balance_frozen_usd = COALESCE(balance_frozen_usd,0) + :hold
    WHERE api_key = :k AND balance_usd >= :hold;   -- rowcount==0 → 余额不足
   ```
   ```sql
   UPDATE daily_spend SET spent_usd = spent_usd + :hold
    WHERE api_key = :k AND day_key = :d AND spent_usd + :hold <= :limit;
   -- rowcount==0 → 限额超了（行不存在时走带条件的 INSERT ... SELECT）
   ```
3. **`idem_key` UNIQUE 索引** —— 幂等兜底由数据库层保证，不靠应用层判断。

### 3.2 预扣金额估算 `estimate_hold_cost`

预扣必须 ≥ 真实消费，否则结算阶段要补扣，补扣时余额可能已不够（只能标 OVERDRAFT）。
- 输入 token 按 `estimate_tokens()` 估算；
- 输出 token：客户端给了 `max_tokens` 就用它；没给则用
  `HOLD_MAX_COMPLETION_TOKENS`（默认 512）× `HOLD_SAFETY_RATIO`（默认 1.5）；
- 上限裁到模型 `context_window`；
- CREATOR 档叠加版税（与 `db.settle_cost` 口径一致）。

两个旋钮均可用环境变量覆盖：`APIPAW_HOLD_MAX_COMPLETION_TOKENS` / `APIPAW_HOLD_SAFETY_RATIO`。

### 3.3 结算失败不吞异常

```python
except Exception as exc:
    print("[billing][FATAL] 结算失败, 原路退回预扣并记录 FAILED …")
    traceback.print_exc()
    db.release_failed_reservation(api_key, request_id, "结算异常: %s" % exc)
    return          # ← 不下发结算回执
```

`release_failed_reservation` 语义：`HOLD(-hold) + FAILED(+hold) = 0` → 买家实付 0，
但账本留下痕迹，事后可对账、可重算。幂等键 `FAILED:<rid>` 保证不重复退。

### 3.4 预扣回收 `reap_stale_holds`

SSE 流式响应在推流途中被客户端断开 → 生成器被关闭 → 结算从未执行 → 钱永久冻结。
后台任务（`@app.on_event("startup")` 启动，60s 一轮）扫出
「`HOLD` 行超 300s 且无对应 `SETTLE`/`FAILED`」的请求，原路退回并落 `FAILED` 痕迹。

### 3.5 历史回填 `backfill_billing_state`

上线瞬间若 `daily_spend` 为空 → 「今日已消费」归零 → 等于给所有用户重发一次单日额度。
所以 `init_db()` 末尾调用回填：
- `daily_spend`：按 (api_key, UTC 自然日) 聚合历史 `usage_logs`；
- `balance_ledger`：每个有历史消费的用户补一条 `OPENER` 期初行（1000.0）
  + 每条消费一条 `USAGE` 行，`balance_after` 由当前余额倒推。

**幂等**：只对「账本里还没有该用户」的账号回填，可重复执行。

生产实跑结果：`[db] 计费账本回填完成: 用户 1, 账本行 20, 日限额行 6`。

### 3.6 模拟回答不再给假节点计酬

```python
settle_node_id = dispatch_node_id or ""
if not settle_node_id:
    settlement["node_earn_usd"] = 0.0
    settlement["platform_fee_usd"] = settlement["base_compute_usd"]
```

`finalize_usage_atomic` 里 `if node_id:` 才写 `nodes_history` → 无真实节点时**一行都不写**。
生产实测：`apipaw-cloud-sim` 的 `total_earnings_paw` 停留在 **489.24725** 不再增长。

---

## 4. 新增接口

### `GET /api/v1/user/ledger?limit=50`

```json
{
  "api_key": "paw_demo_key",
  "balance": {"balance_usd": 999.746878, "balance_frozen_usd": 0.0,
              "daily_limit_usd": 100.0, "spent_today_usd": 0.144256, "found": true},
  "entries": [{"id": 22, "entry_type": "SETTLE", "direction": 1, "amount_usd": 0.323127,
               "balance_after_usd": 999.794373, "request_id": "chatcmpl-8153276c…",
               "model_id": "qwen-2.5-72b", "node_id": "", "day_key": "2026-11-08",
               "day_spent_usd": 0.096761, "note": "推理后结算"}]
}
```

`GET /api/v1/user/usage` 追加 `balance_frozen_usd`（向后兼容）。

---

## 5. 验证

### 5.1 沙箱（源站 Python 3.6.8 + SQLite 3.7.17，跑在 `.backup` 副本上）

**74 项断言全部通过**，覆盖 T1–T16：

| 组 | 用例 | 结果 |
|---|---|---|
| T1–T4 | 单笔预扣 / 结算 / 余额不足 402 / 限额 402 | PASS |
| T5 | **100 并发预扣，余额 10.0** | 成功 10 笔，余额 **0.0 绝不为负**，冻结 10.0，账本 HOLD 10 行 |
| T6 | **50 并发预扣，限额 5.0** | 放行 **5** 笔，其余 45 笔全部 `daily_limit_exceeded`，`spent_today == 5.0` **未被击穿** |
| T7–T8 | 预扣幂等 / 结算幂等 | 第二次返回 `duplicate`，只扣一次，`usage_logs` 只 1 行 |
| T9 | 结算失败 → FAILED | 预扣原路退回，余额复原，冻结归零，账本净额 == 0，重复退回不再加钱 |
| T10/T10b | 少付补扣 / 补扣时余额不足 | 余额扣到 0 并标 **OVERDRAFT**，**绝不成负数** |
| T11 | 模拟回答 | `nodes_history` **没有新增假节点行** |
| T12 | 真实节点 | 收益 / tokens 正确累加 |
| T13 | `get_spend_today` | 读 `daily_spend`，`day_key = 2026-11-08`（UTC） |
| T14 | **账实相符** | 期初 + 账本净额 == `users.balance_usd` |
| T15 | `reap_stale_holds` | 超时预扣原路退回，二次回收不重复退 |
| T16 | server 层端到端 | 200 + 扣款 == `usage.cost_usd`；余额不足 402；超限额 402；被拒时余额不变且不产生 HOLD 行 |

> **沙箱期间抓到的一个生产级逻辑 bug**：单日限额闸门初版在 `daily_spend` 行已存在时
> 直接返回 `daily_limit_exceeded` → 当天第二笔起全部被拒（首轮 62 通过 / 11 失败）。
> 修复为「先做带条件的原子 UPDATE（`AND spent_usd + ? <= ?`），rowcount==0 时再判断行是否存在
> （不存在 → 带条件 INSERT；存在 → 超限）」。修复后 71 → 74 全绿。
> **这个 bug 若直接上生产，会让当天所有真实请求 402。**

### 5.2 生产验证矩阵（33 项全通过）

| # | 用例 | 期望 | 实测 |
|---|---|---|---|
| 1 | `owner/dashboard` 无 key | 401 | 401 ✓ |
| 2 | `owner/dashboard` OWNER key | 200 | 200 ✓ |
| 3 | `nodes` 无 key | 401 | 401 ✓ |
| 4 | toggle 幽灵节点 | 404 + 无新行 | 404 `节点不存在: probe-b3-nonexistent` ✓ |
| 5 | `user/usage` | 200 + `role`/`balance_frozen_usd` | ✓ |
| 6 | `user/ledger` | 200 + 流水 | ✓ |
| 7 | `/v1/models` | 200 | 200 ✓ |
| 8 | 真实推理（非流式） | 200 + 扣款正确 | 200，成本 0.051037，冻结归零 ✓ |
| 9 | 真实推理（SSE） | 200 + 扣款正确 | 200，成本 0.047495 ✓ |
| 10 | 账本新增行 | HOLD + SETTLE 各 1 | HOLD(-0.374164) + SETTLE(+0.323127)，净额 = -0.051037 ✓ |
| 11 | 余额不足 → 402 | 402 `insufficient_balance` | ✓，且**不产生 HOLD 行、余额不变** ✓ |
| 12 | 超限额 → 402 | 402 `daily_limit_exceeded` | ✓，`daily_spend` **未被击穿** ✓ |
| 13 | **40 并发（余额 0.5）** | 余额 ≥ 0 | 3×200 + 37×402，余额 **0.356549 ≥ 0** ✓ |
| 14 | 并发后账本 | HOLD=4 / SETTLE=4，无 FAILED | ✓ |
| 15 | `nodes_history` | sim 收益不再增长 | 停在 **489.24725** ✓ |
| 16 | `usage_logs.node_id` | 新记录为空 | ✓ |
| 17 | **账实核对** | 账本净额 == `users.balance_usd` | 两者均 **999.746878** ✓ |
| 18 | `daily_spend` | UTC 分日 | 6 行，2026-10-25 ~ 2026-11-08 ✓ |
| 19 | `PRAGMA integrity_check`（业务库） | ok | ok ✓ |
| 20 | `PRAGMA integrity_check`（注册表库） | ok | ok ✓ |
| 21 | 临时测试账号清理 | 生产库无残留 | `users` 仅剩 1 条 ✓ |

**回滚点**：`backups/apipaw_20261108-pre-b3-deploy.db`、`.../node_registry_20261108-pre-b3-deploy.db`。

### 5.3 e2e（Pocket 网页端）

`node e2e/live-console.cjs https://pocket.apipaw.com` → **24/24 通过，0 失败**。

覆盖：应用渲染、密钥注入、买家视角（余额卡片 / Playground / Analytics /
`GET /api/v1/user/usage` / `GET /v1/models` / `GET /api/v1/user/analytics`）、
业主视角（算力节点面板 / 模型工作台 / 拓扑 / 版税大盘）、设置密钥弹窗、无 JS 运行时错误。

> 备注：本机 Playwright 原为 1.65.0 但对应 chromium-1254 未缓存，已改装
> **playwright 1.59.0**（对应已缓存的 chromium-1217）以复用本地浏览器缓存，
> `--no-save` 安装，不写入 `package.json`。

---

## 6. 遗留与下一步

| 项 | 说明 |
|---|---|
| **TODO-10 充值接口** | 仍**未做**。系统至今没有任何充值/退款/冲正接口，余额只减不增。本批次让「每一笔扣减」可追溯，但没有解决「钱怎么进来」。**这是下一个批次的头号任务。** |
| **TODO-07 PAW 汇率硬编码** | 仍是函数体内联 `0.00020`，未提为常量、未在 `nodes_history` 记录汇率快照。本批次未动。 |
| 提现并发双花 | `db.record_withdrawal()` 仍是「查 available → INSERT」两段式，未加事务。**仍未修**（审计报告 §3.5）。 |
| 创作者版税发放 | `usage_logs.creator_royalty_usd` 有记录，但**尚未有把版税实际打给创作者钱包的发放流程**（当前只能按 `author_wallet` 聚合查询）。 |
| `daily_spend` 历史回填口径 | 回填按 `usage_logs` 的 `timestamp` 分 UTC 日；`balance_ledger` 的历史行 `request_id` 为空（历史数据本身就没有），故 `HOLD/SETTLE` 幂等只对新请求生效。 |
| 对账工具 | 目前账实核对靠手工 SQL。建议后续加一个 `/api/v1/owner/reconcile` 端点，把「账本净额 vs 余额 vs 用量日志」做成常态化日对账（审计报告 §6.5 第 13 项）。 |

---

## 7. 红线遵守情况

- `3X-UI`（2053 / 39821）、`/opt/apipaw-cloud` 之外的任何服务 —— **未碰**
- `apipaw.db` / `node_registry.db` —— 唯一写入是 `init_db()` 的建表 / 加列 / 回填 +
  正常业务写；审计与改造全程在 `.backup` 副本上验证
- 生产库 —— **不进 git**（`*.db` + `*.db-wal` + `*.db-shm` + `backups/` 四重保险）
- `git config` —— **未修改**，身份用 `-c` 单次传参
- nginx —— **未动**
- `git push` —— **未推**（远端 URL 内嵌 PAT 且未获授权，先在本地闭环）
