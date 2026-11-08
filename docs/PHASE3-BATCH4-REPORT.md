# 阶段三 · 批次 4 实施验证报告 —— 充值系统与收尾清理

> 日期：2026-11-08
> 范围：**TODO-10（充值接口）** / **TODO-12（实时性缓存契约 · 后端侧）** / **TODO-15（探针节点物理清理）**
> 生产代码：`/opt/apipaw-cloud/{db.py, server.py, manage_node.py}`，commit **`d37a0ad`**
> 回滚点：`backups/apipaw_20261108-pre-b4-deploy.db` + `node_registry_20261108-pre-b4-deploy.db`
> 沙箱脚本：`D:\tmp\apipaw-cloud-b3\test_batch4_sandbox.py`（U1–U11，56 项断言）

---

## 0. 一句话结论

**系统至此第一次拥有「资金进入」的唯一入口。**
在此之前，余额只减不增 —— 买家花的钱进不了系统，节点赚的钱也无处可取，
整个经济闭环是断的。批次 4 补上了这个缺口，并顺手把「历史垃圾数据」
和「实时性靠运气」这两个技术债一并清掉。

---

## 1. TODO-10 · 充值接口

### 1.1 设计决策

充值接口最怕两件事：**入账不原子**（钱加了一半崩了）与**重复入账**（前端重试 / 用户手抖双击）。
两者都靠同一个机制解决：**把"加钱"和"记流水"放进同一个写事务**，再用唯一索引兜幂等。

| 决策 | 选择 | 理由 |
|---|---|---|
| 事务模式 | `BEGIN IMMEDIATE`（`open_tx_conn()`，`isolation_level=None`） | 充值是"检查 + 动作"，deferred 事务从读升级写会 BUSY。与批次 3 口径一致。 |
| 幂等键 | `idem_key = "RECHARGE:<request_id>"`，走 `balance_ledger.idem_key` UNIQUE 索引 | 不用 partial index —— 生产 SQLite **3.7.17** 不支持（需 3.8.0）。 |
| 幂等实现 | 事务内先 SELECT 幂等键，命中直接返回原结果 | 唯一索引只是**最后一道防线**，先查能避免"撞索引后异常冒泡"。 |
| 金额护栏 | `> 0` 且 `<= MAX_RECHARGE_USD (10000)` | 演示充值没有支付通道，防止手滑或被当免费提款机。 |
| 是否真实支付 | **否**，接口返回显式带 `demo: true` | 不让前端误以为已对接支付通道。 |

### 1.2 `db.add_balance()` 关键实现

```python
conn.execute("BEGIN IMMEDIATE")
# 1) 幂等短路
dup = conn.execute("SELECT id, amount_usd, balance_after_usd "
                    "FROM balance_ledger WHERE idem_key = ?", (idem_key,)).fetchone()
if dup is not None:  → 直接返回 duplicate=True
# 2) 加钱（判据写在 WHERE 里，不做「先查后写」）
cur = conn.execute("UPDATE users SET balance_usd = balance_usd + ? WHERE api_key = ?", ...)
if cur.rowcount == 0:  → ROLLBACK, user_not_found
# 3) 读回新余额作对账锚点
balance_after = ...
# 4) 写账本流水
_ledger_write(conn, api_key, "RECHARGE", 1, amount, balance_after, ...)
conn.execute("COMMIT")
```

**为什么余额扣款用 `balance_usd = balance_usd + ?` 而充值也一样**：
余额永远不会被算成负数 —— 充值是加法，不可能负；扣款走批次 3 的
`AND balance_usd >= ?` 条件式 UPDATE。两边共享同一条 `users.balance_usd` 列，
账本 `balance_after_usd` 作锚点，随时可对账。

### 1.3 接口契约

```
POST /api/v1/user/recharge
Authorization: Bearer <买家 key>
Content-Type: application/json

{"amount_usd": 10, "request_id": "可选, 用于幂等"}

→ 200 {"status":"success","demo":true,"api_key":"...",
        "amount_usd":10.0,"balance_usd":1009.746878,"duplicate":false}
→ 401 缺少 / 无效 API Key
→ 400 金额非法（<=0 或 >10000）
→ 404 用户不存在
```

---

## 2. TODO-12 · 实时性（后端配合侧）

### 2.1 三层缓存逐层排查

| 层 | 状态 | 结论 |
|---|---|---|
| nginx（cloud.apipaw.com） | `proxy_cache off` ✅ | 本来就没缓存 |
| Cloudflare | `cf-cache-status: DYNAMIC` ✅ | 本来就没缓存 |
| **FastAPI** | ⚠️ **没有显式声明 Cache-Control** | 唯一缺口 |

前两层都安全，但第三层"碰巧安全"：**FastAPI 默认不设 Cache-Control**，
一旦前面某天有人加了 `proxy_cache`，或者中间插入 CDN 默认规则，
就会静默开始缓存带用户余额的响应 —— 而且这种 bug 极难排查
（"有时候余额不更新"）。

### 2.2 修法：把实时性变成**接口契约**

新增纯 ASGI 中间件 `NoStoreMiddleware`，对 `/api/` 与 `/v1/` 的响应统一补：

```
Cache-Control: no-store, no-cache, must-revalidate
```

**为什么不用 `@app.middleware("http")` / `BaseHTTPMiddleware`**：
starlette 的 `BaseHTTPMiddleware` 会把响应体包成 `StreamingResponse` 再重放，
对 SSE（流式打字机）会**破坏逐块 flush 的时序** → 前端看到"打字机卡住"。
纯 ASGI 中间件只改 `http.response.start` 的头，完全不碰消息体，SSE 行为零变化。
（生产已实测：SSE 仍逐块输出。）

**范围刻意只覆盖 `/api/` 与 `/v1/`**：
静态资源与 `/health` 加 no-store 只会白白多跑一次回源，没有任何收益。
且已存在的 Cache-Control（如 SSE 的 `no-cache`）会被尊重，不覆盖。

---

## 3. TODO-15 · 探针节点物理清理

### 3.1 为什么必须物理删除

批次 2 已经让探针节点"默认不再出现"（统一视图过滤掉"无身份、无产出、无心跳"的节点），
但**数据还躺在表里**。`node_registry` 是运行时状态表，没有软删除语义 ——
留着这些行只会被下一次心跳 UPSERT 覆盖，或永远占位、污染节点数统计。

### 3.2 安全红线（宁可漏删，绝不误删真节点）

| 红线 | 判定依据 | 理由 |
|---|---|---|
| `has_credential` | `node_credentials` 有该 node_id 的行（任意状态） | 它是**注册过的身份**，哪怕 revoked 也是真人节点。 |
| `has_output` | `nodes_history` 有该 node_id 的行 | 它有过产出/结算记录，删了就丢历史收益。 |
| `recently_active` | 心跳在 `--older-than-hours`（默认 24h）内 | 可能只是掉线，不是垃圾。 |
| `prefix_not_allowed` | node_id 前缀不在白名单 | 默认只允许 `probe_` / `ws_rootcause_probe`。 |

命中任一条 → **保留**，并在预览里标注原因，供人工复核。

### 3.3 用法

```bash
python manage_node.py prune                        # 预览（默认，不删）
python manage_node.py prune --apply                # 物理删除
python manage_node.py prune --older-than-hours 48  # 更宽松的离线窗口
python manage_node.py prune --prefix probe_ --prefix debug_ --apply
```

预览输出示例（生产真实数据）：

```
NODE_ID                  AGE_H      CHANNEL      DECISION           REASON
probe_cf_long            54.18      none         DELETE             stale_probe
...
ws_rootcause_probe       67.31      none         DELETE             stale_probe
123                      25.39      http         KEEP               prefix_not_allowed
node_default_001         7.69       http         KEEP               has_credential
node_gtx1060_001         165.72     none         KEEP               prefix_not_allowed
node_user_002            20.75      http         KEEP               has_credential

待删除 16 个，保留 4 个（总计扫描 20 个）
```

---

## 4. 验证

### 4.1 沙箱（源站 Python 3.6.8 + SQLite 3.7.17，`.backup` 副本）

**56/56 全绿**：

| 组 | 用例 | 结果 |
|---|---|---|
| U1 | 充值成功：余额 +10，账本一条 RECHARGE/direction=1/amount=10 | ✅ 9 项 |
| U2/U3 | 账本锚点 `balance_after_usd` 正确；账实相符 | ✅ 2 项 |
| U4 | 幂等：同 request_id 重复充值只入账一次 | ✅ 4 项 |
| U5 | 非法金额：0 / 负数 / 超上限全部被拒，且不留流水 | ✅ 5 项 |
| U6 | **并发充值**：20 并发各 $5 → 余额精确 +100，账本 20 行 | ✅ 4 项 |
| U7/U8 | server 层：200 + 字段正确；401 / 400；幂等重放 | ✅ 12 项 |
| U9 | 缓存契约：`/api/` `/v1/` 带 no-store；`/health` 不带；鉴权未回归 | ✅ 8 项 |
| U10 | prune 判定：四条红线各自正确 | ✅ 5 项 |
| U11 | prune 物理删除 + 幂等 | ✅ 7 项 |

### 4.2 生产验证矩阵

| # | 用例 | 期望 | 实测 |
|---|---|---|---|
| 1 | 充值 无 key | 401 | ✅ 401 |
| 2 | 充值 OWNER key $10 | 200 + 金额/余额 | ✅ `{"status":"success","demo":true,"amount_usd":10.0,"balance_usd":1009.746878,"duplicate":false}` |
| 3 | 同 request_id 重放 | 200 + `duplicate:true`，余额不变 | ✅ 余额仍 1009.746878 |
| 4 | 负金额 | 400 | ✅ 400 |
| 5 | 账本 RECHARGE 流水 | 一条 direction=1 | ✅ `id=33 RECHARGE 1 10.0 1009.746878 RECHARGE:prod-verify-1` |
| 6 | **账实相符** | 账本净额 == 余额 | ✅ `1009.746878 == 1009.746878` |
| 7 | `/api/v1/user/usage` | 200 + `Cache-Control: no-store` | ✅ |
| 8 | `/api/v1/owner/dashboard` | 200 + no-store | ✅ |
| 9 | `/api/v1/nodes` | 200 + no-store | ✅ |
| 10 | `/v1/models` | 200 + no-store | ✅ |
| 11 | `/health` | 200 **不带** no-store | ✅ |
| 12 | dashboard 无 key | 401 | ✅ 401 |
| 13 | dashboard OWNER | 200 | ✅ 200 |
| 14 | nodes 无 key | 401 | ✅ 401 |
| 15 | toggle 无 key / 不存在节点 | 401 / 404 | ✅ 401 / 404 |
| 16 | usage 含 `role` | `"role":"OWNER"` | ✅ |
| 17 | 计费链路（chat 200 + 扣款） | 余额减少，账实相符 | ✅ `1009.325863 == 1009.325863` |
| 18 | SSE 流式 | 逐块输出不卡顿 | ✅ 逐块 `delta.content` |
| 19 | prune 生产执行 | 删 16 个探针，保留 4 个真节点 | ✅ |
| 20 | 清理后 `/api/v1/nodes` | 3 个（隐藏 5 个） | ✅ |
| 21 | 两库 `PRAGMA integrity_check` | ok | ✅ ok / ok |

**Pocket e2e：24/24 全绿**（playwright 1.59.0，https://pocket.apipaw.com）。

---

## 5. 遗留（下一批次）

- **真实支付通道** —— 当前充值是"演示充值"（响应带 `demo: true`），接支付前不得对外宣传充值能力。
- **退款 / 冲正接口** —— 仍然没有。充值做错了只能手工改库。
- **提现原子化** —— `db.record_withdrawal()` 仍是「查 available → INSERT」两段式 → 并发双花，**未修**。
- **PAW 汇率硬编码** `0.00020`（TODO-07）—— 未提常量、未记录汇率快照。
- **创作者版税无发放流程** —— 只记录在 `usage_logs.creator_royalty_usd`。
- **前端实时刷新** —— TODO-12 后端侧已就绪，但 Pocket 的 `App.tsx` 仍只在 mount 时拉数据，
  需在 `RESPONSE_DONE` 后主动刷新（方案 B）。
- **`retired_at` 自动退役** —— TODO-15 的物理清理目前是手动 `prune` 触发，仍需自动退役机制。
- 建议加 `/api/v1/owner/reconcile` 做常态化日对账。

---

## 6. 复现命令

```bash
# 沙箱
mkdir -p /tmp/b4sandbox
sqlite3 /opt/apipaw-cloud/apipaw.db ".backup /tmp/b4sandbox/apipaw.db"
sqlite3 /opt/apipaw-cloud/node_registry.db ".backup /tmp/b4sandbox/node_registry.db"
chown -R user001:user001 /tmp/b4sandbox
B4_SANDBOX_DIR=/tmp/b4sandbox B4_SRC_DIR=/opt/apipaw-cloud/.candidate-b4 \
    ./.venv/bin/python3 .candidate-b4/test_batch4_sandbox.py

# 生产
curl -s -X POST http://127.0.0.1:8000/api/v1/user/recharge \
  -H "Authorization: Bearer paw_demo_key" -H 'Content-Type: application/json' \
  -d '{"amount_usd":10,"request_id":"prod-verify-1"}'

sqlite3 -header -column /opt/apipaw-cloud/apipaw.db \
  "select id,entry_type,direction,amount_usd,balance_after_usd,idem_key \
   from balance_ledger where entry_type='RECHARGE' order by id;"

python /opt/apipaw-cloud/manage_node.py prune            # 预览
python /opt/apipaw-cloud/manage_node.py prune --apply    # 执行
```
