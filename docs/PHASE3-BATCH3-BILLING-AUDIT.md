# 阶段三 · 批次 3 计费系统摸底审计报告（只读）

- **日期**：2026-11-08
- **审计对象**：`/opt/apipaw-cloud`（香港生产机），commit `bae4a96`
- **运行环境**：Python 3.6.8 / SQLite **3.7.17** / **TZ = UTC** / uvicorn `--workers 1`
- **审计范围**：`server.py`（2014 行）、`db.py`（1550 行）中一切与**计费、扣款、额度、分成、提现**相关的代码 + 生产库表结构与数据抽样
- **审计方式**：**纯只读**。源文件 `scp` 到本地后逐行阅读；生产库只经 `sqlite3 "file:apipaw.db?mode=ro"` 查询。
  **本次未修改任何一行代码，未对任何数据库执行过写操作**（`git status` 干净，生产库 `integrity_check` 未触碰）。

---

## 〇、结论速览

| # | 隐患 | 严重度 | 现状判定 |
|---|---|---|---|
| 1 | 余额无限透支 | **P0** | **可以**。100 并发可把余额扣成任意负数，无任何兜底 |
| 2 | 单日限额并发击穿 | **P0** | **可以**。100 并发可放行约 100 倍于限额的消费 |
| 3 | 扣费失败静默吞掉 | **P0** | 买家白嫖算力；节点收到「已入账」回执但平台账上无此笔 |
| 4 | 无余额账本 | **P1** | `usage_logs` 只是**用量流水**，不是**资金账本**；无充值/退款/冲正 |
| 5 | 模拟回答仍给节点计酬 | **P1** | 平台为「空气」付了 489.25 PAW（`apipaw-cloud-sim`） |
| 6 | 创作者提现并发双花 | **P1** | `available` 检查后插入，TOCTOU |
| 7 | 闸门与扣费相隔整段推理 | **P1** | 窗口最长 90s（派单超时），是 1/2 的根因 |
| 8 | 限额口径依赖服务器 TZ | **P2** | 现在是 UTC 自然日；迁机改 TZ 会静默漂移 |
| 9 | 双余额列并存 | **P2** | `users.balance`（死列）与 `balance_usd` 并存 |
| 10 | 业务库残留历史 `node_registry` 空表 | **P2** | 0 行，但与注册表库同名，属数据模型歧义源 |

**一句话**：当前计费是「**先给算力、后扣钱**」的顺序，且扣钱语句**不带任何条件**、**没有账本**、**异常被吞**。
余额与限额这两道闸门都是**请求开始时读一次快照**的软检查，与请求结束时的实际扣费之间隔着整段推理——
并发就是这个窗口的天然放大器。

---

## 一、钱的完整流向（代码地图）

```
POST /v1/chat/completions                       server.py:1153
 ├─ 1161  鉴权  api_key = resolve_api_key(auth) or DEMO_API_KEY   ← 兜底，见 §1.4
 ├─ 1162  读用户快照（balance_usd / daily_limit_usd）
 ├─ 1166  取模型目录
 ├─ 1174  ★额度闸门①：spent_today >= daily_limit → 402 daily_limit_exceeded
 ├─ 1184  ★额度闸门②：balance_usd <= 0        → 402 insufficient_balance
 ├─ 1207  派单（DISPATCH_ENABLED=1，最长 90s）
 ├─ 1259  计价 db.settle_cost() → cost_usd / node_earn / royalty / platform_fee
 ├─ 1262  settle_node_id = dispatch_node_id or SIM_NODE_ID        ← 见 §3.4
 ├─ 1264  _record_usage_safe()  ──►  db.record_usage()  (db.py:474)
 │        ├─ 493  幂等检查 SELECT ... WHERE request_id = ?      ← 非原子，见 §2.5
 │        ├─ 503  INSERT usage_logs
 │        ├─ 511  ★★ UPDATE users SET balance_usd = balance_usd - ? WHERE api_key = ?
 │        ├─ 515  UPDATE nodes_history SET total_tokens_processed/total_earnings_paw += ...
 │        └─ 531  COMMIT（三条写在同一个事务里）
 └─ 1280  _notify_settlement()  把回执推给节点（**在 try/except 之外**）
```

### 1.1 余额扣除的精确 SQL

```sql
-- db.py:511，record_usage() 内
UPDATE users SET balance_usd = balance_usd - ? WHERE api_key = ?
-- 参数：(cost_usd, api_key)
```

配套约束现状：

- **没有** `AND balance_usd >= ?` 条件；
- `users` 表**没有** `CHECK (balance_usd >= 0)`；
- `get_db()`（db.py:152）= `sqlite3.connect(DB_PATH)`，**默认 timeout 5s**，未设 `PRAGMA busy_timeout`；
- 业务库 `journal_mode = delete`（rollback-journal）→ **同一时刻只有一个写者**；
- `record_usage` 三条写处于**同一个隐式事务**，最后一次 `conn.commit()`。

### 1.2 计价公式（db.py:455 `settle_cost`）

```
base              = prompt/1000*价 + completion/1000*价
node_earn         = base * 0.85
platform_fee      = base * 0.15
creator_royalty   = base * 0.15   （仅 CREATOR 档，叠加在 base 之上）
total(cost_usd)   = base + creator_royalty        ← 买家实际支付额
paw_earned        = node_earn / 0.00020
```

### 1.3 生产库表清单（只读 `.tables`）

```
creator_withdrawals   node_registry   usage_logs   models   nodes_history   users
```

- `usage_logs`：11 个业务列（api_key / node_id / model_id / tokens / cost_usd / timestamp /
  model_tier / node_earn_usd / creator_royalty_usd / platform_fee_usd / request_id），
  `request_id` 上有唯一索引（幂等）。
- `creator_withdrawals`：**创作者**侧提现流水（金额/钱包/状态），**不是买家余额账本**。
- **全库没有任何买家余额流水表、充值表、退款表、对账表。**

### 1.4 附带发现：无鉴权兜底会落到「演示 OWNER 账号」

```python
# server.py:1161
api_key = resolve_api_key(authorization) or DEMO_API_KEY      # DEMO_API_KEY = "paw-sk-demo1234567890"
```

生产库目前**没有**这个 key（只有 `paw_demo_key`），所以匿名请求会走到 401 —— **暂时安全**。
但 `init_db()`（db.py:349）在**空库**时会把 `paw-sk-demo1234567890` 以 `role='OWNER'`、`balance_usd=100.0`
播种进去。**任何一次全新部署/重建库，匿名推理就会自动获得一个 100 美元、OWNER 角色的账号**，
并直接命中本报告 §2 的透支漏洞。这属于计费面的一部分，一并记入。

---

## 二、隐患 1：并发击穿与负余额

### 2.1 先澄清一个常见误判：**不会丢更新（lost update）**

`balance_usd = balance_usd - ?` 是**列算术**，不是「读出来 → 减 → 写回」。
SQLite 在文件级写锁内串行执行写事务，因此 N 笔并发扣款会**依次**生效，不会互相覆盖。
所以问题不是「少扣了」，而是「**扣多了 / 扣成负数**」。

### 2.2 真正的问题：**闸门与扣费之间的 TOCTOU 窗口**

两道余额闸门都在 **server.py:1184**，读的是 **server.py:1162** 那一瞬间的用户快照；
而实际扣费发生在 **server.py:1264**，即推理**结束之后**。中间隔着：

- 派单等待 + 推理执行，最长 `DISPATCH_TIMEOUT_SEC = 90` 秒；
- SSE 流式输出的逐 token 推送（`asyncio.sleep(0.026)` × token 数）。

**这 90 秒就是击穿窗口。** 并发请求只是把这个窗口填满而已 —— 单请求也可能扣成负数，
并发只是让它变成「可被主动利用」。

### 2.3 100 并发 / 1 秒的逐帧推演

| 时刻 | 事件 | 余额 | 单日已花 |
|---|---|---|---|
| T0 | 100 个请求同时进入，**各自**在 1162 读到 `balance_usd = 10.0` | 10.00 | 0.00 |
| T0 | 100 个请求**全部**通过 1184 的 `balance_usd <= 0` 检查 | 10.00 | 0.00 |
| T0+ε | 100 个请求**全部**通过 1177 的限额检查（读到的 `spent_today` 均为 0.00） | 10.00 | 0.00 |
| T0+90s | 100 个请求陆续推理完成 | 10.00 | 0.00 |
| T0+90s+ | 100 次 `UPDATE ... balance_usd = balance_usd - ?` 串行执行 | **10 - 100×cost** | 100×cost |

结论：

- **能否把余额扣成负数？—— 能，而且没有下限。** 只要请求能进来，扣多少就是多少；
  `balance_usd` 上界只由「请求能进来多少个」决定（可达数千）。
- **能否击穿单日限额？—— 能，约 100 倍。** 限额判定读的是**已落库**的 `SUM(usage_logs)`，
  而本请求自己的消费此刻还没落库，100 个并发全部看到同一个旧值 → 全部放行。

### 2.4 并发的第二重伤害：写锁超时 → **免费推理**

业务库是 rollback-journal，**全局单写者**。`get_db()` 没有设 `PRAGMA busy_timeout`，
只有 Python `sqlite3.connect()` 默认的 **5 秒**超时。100 并发写会排队；一旦某笔等待超过 5s：

```
sqlite3.OperationalError: database is locked
```

→ `record_usage` 抛异常 → `_record_usage_safe` 的 `except` **只 print 一行日志**（server.py:1276）
→ **买家照常拿到完整答案，零扣费**。这就是 §3 的「钱与算力」裂缝在并发下的具体形态：
**并发越高，免费推理越多**（讽刺的是越拥堵越亏钱）。

另注：批次 2 的心跳回写（2s busy_timeout）也会与结算事务抢同一把写锁，
虽然它「失败不抛异常」，但会拉长结算事务的持锁时间，间接放大 2.4。

### 2.5 幂等检查本身也不是原子的

```python
# db.py:493
if request_id:
    dup = cursor.execute("SELECT id FROM usage_logs WHERE request_id = ?", (request_id,)).fetchone()
    if dup: return False
# ... 502 INSERT INTO usage_logs (... request_id ...)
```

`SELECT` 与 `INSERT` 之间没有原子性。`request_id` 由 `uuid4` 生成，正常不会撞；
但**客户端重试/重放**同一 `X-Request-ID` 语义时会撞唯一索引 → `IntegrityError` →
整个事务回滚 → 不扣钱。结果「安全」，但**靠异常兜底而非设计**，且异常发生在
`INSERT`（第一条写）上，此时尚未扣费，属于运气好而不是设计好。

### 2.6 节点侧同样受害

`nodes_history` 的收益累加与扣费**在同一事务**（db.py:515），
所以并发击穿时**节点照拿 85% 分成** → 平台同时承担「买家白嫖」+「照付节点分成」双重损失。

### 2.7 现状风险定级

| 攻击面 | 可行性 | 损失 |
|---|---|---|
| 单请求透支余额 | 极高（正常请求即可） | 余额为负，平台承担算力成本 |
| 并发放大透支 | 极高 | 余额可被压到任意负数 |
| 并发击穿单日限额 | 极高 | 限额形同虚设 |
| 并发触发免费推理 | 高（依赖写锁竞争） | 算力白送 |

---

## 三、隐患 2：无痕扣费与对账黑洞

### 3.1 有没有余额流水表？—— **没有**

`users.balance_usd` 是**余额快照（state）**，不是流水（ledger）。
唯一的「钱相关明细」是 `usage_logs`，它回答的是「**这次推理**花了多少」，
而不是「**这笔钱**去哪了」。两者不是一回事。

### 3.2 「用户的钱少了，我们能证明是哪次请求、哪个模型消耗的吗？」

**部分能，但不足以对账。** `usage_logs` 里有 `api_key / model_id / node_id / tokens /
cost_usd / request_id / timestamp / 三方分成`，所以**单笔推理的归因是有的**。
但以下问题**无解**：

| # | 问题 | 现状 |
|---|---|---|
| 1 | 余额为什么**增加**了？ | **没有任何充值/提现/赠送/退款接口**。全库只有三处写余额：建号写初值、`seed_usage_logs()` 演示脚本重置、`record_usage()` 扣费。任何非扣费导致的余额变动**不留任何记录** |
| 2 | `balance_usd` 与 `Σusage_logs` 对不对得上？ | 现在**恰好**对得上（1000 − 0.15459 = 999.84541），但**没有 `balance_before/balance_after` 快照、没有期初记录**，这个「自洽」是巧合式自洽，**不可审计、不可复现** |
| 3 | 某笔扣费**失败了**还是**根本没发生**？ | 失败只 `print` 到 stdout（journald），**库里没有任何痕迹**。对账时「少了一笔」与「没扣成」**无法区分** |
| 4 | 扣错了怎么退？ | **没有冲正/退款路径**，也没有任何能识别「这笔该退」的依据 |
| 5 | 余额变化曲线 | 无数据源。`usage_logs` 只有**出账**，没有**账本序列**，画不出「钱是怎么动的」 |
| 6 | 节点赚的 PAW 是哪几次推理赚的？ | `nodes_history` 只有两个**累计列**，**没有流水**。面板上「节点收益 489.25 PAW」无法下钻 |

### 3.3 创作者侧是同一个洞（且更糟）

`creator_royalty_usd` 只落在 `usage_logs` 里；创作者可提余额是 **SUM 出来的**：

```python
# db.py:1018 record_withdrawal()
earned   = SELECT SUM(creator_royalty_usd) FROM usage_logs WHERE model_id IN (...)
withdrawn = SELECT SUM(amount_usd) FROM creator_withdrawals WHERE status IN ('PENDING','DONE')
available = earned - withdrawn
if amount_usd > available + 1e-9: raise ValueError(...)   # ← 检查
INSERT INTO creator_withdrawals (...)                     # ← 动作（中间无事务保护）
```

**检查与动作之间没有事务**，两个并发提现请求可以**同时**通过检查 → **双花**。

### 3.4 附带发现：模拟回答也给节点计酬（平台在为「空气」付钱）

```python
# server.py:1262
settle_node_id = dispatch_node_id or SIM_NODE_ID      # SIM_NODE_ID = "apipaw-cloud-sim"
```

没有真实节点在线时（生产当前 `nodes_online = 0`），请求由**平台自己造答案**（`build_answer`），
但成本照扣、**85% 分成照记到 `apipaw-cloud-sim` 这个并不存在的算力上**。

生产现状（只读抽样）：

| node_id | tokens | earnings_paw | 来源 |
|---|---|---|---|
| `apipaw-cloud-sim` | 920 | **489.24725** | **全部来自模拟回答**（19 条 usage_logs 里 17 条 node_id = apipaw-cloud-sim） |
| `node_default_001` | 628 | 142.41325 | 真实派单 |

即：平台在「自己算」的流量上，**凭空多付了 489.25 PAW 的节点分成**，
而真节点只拿到 142.41 PAW。这是「钱与算力」口径错配，与 §4 的事务裂缝是两回事，但同样要记在账上。

---

## 四、隐患 3：事务一致性（钱与算力）

### 4.1 库内是原子的，跨系统不是

`record_usage` 的三条写（`usage_logs` INSERT / `users` 扣费 / `nodes_history` 加收益）
在**同一个隐式事务**里 `commit()`。所以在**数据库层面**，钱与算力是「同生共死」的：
要么全成功，要么全回滚。**这一层是好的。**

### 4.2 真正的裂缝在事务**之外**：异常被吞

```python
# server.py:1264
async def _record_usage_safe() -> None:
    try:
        await ... db.record_usage(...)
    except Exception as exc:
        print(f"[billing] 记录用量失败 (model={model['model_id']}): {exc}")   # ← 只记日志

    if dispatch_node_id:
        await _notify_settlement(dispatch_node_id, {...})                    # ← 在 try 之外，照发
```

**「扣费失败但节点已完成推理」的完整后果链**：

| # | 后果 | 说明 |
|---|---|---|
| 1 | **买家白嫖** | 推理已完成、答案已返回（流式甚至已吐完），扣费失败只留一行 stdout 日志。买家零成本拿走算力，且**无感知** |
| 2 | **节点回执与平台账本分歧** | DB 里 `nodes_history` 因事务回滚**没有**加收益；但 `_notify_settlement` 在 try/except **之外**，**照样**给节点推了一张「你赚到了 $X」的结算回执。节点本地账本记了收入，平台账上**查无此笔**，且**没有账本可对**（§3.2 第 6 条） |
| 3 | **回执丢失也无补偿** | 反向情况：`record_usage` 成功、`_notify_settlement` 失败（节点刚好掉线）→ DB 有收益、节点没收到回执 → 节点侧少算。**没有重投队列、没有对账任务、没有补偿机制** |

### 4.3 直接回答：「节点还会增加收益吗？」

- **扣费成功** → 节点收益**增加**（`nodes_history.total_earnings_paw`），与买家扣费同事务，**一致**。
- **扣费失败** → 节点收益**不增加**（同事务回滚），但节点**收到了一张声称已入账的回执** →
  **平台端与节点端从此对不上，且不可自动对账**。

### 4.4 更上游的一致性缺口

- 扣费发生在**推理之后**。若扣费失败，**算力已经消耗掉了**——钱与算力的因果顺序是反的。
  正确做法是「预扣 → 执行 → 结算」（见 §6.3 方案 B）。
- 派单失败回退模拟回答时，`dispatch_mode = "fallback"`，但**依然照扣钱、依然照算节点分成**（§3.4）。
- 客户端中途断开：`await _record_usage_safe()` 写在 `event_generator()` 里、`finish_reason` 帧**之前**
  （server.py:1364），设计上是「保证计费不因客户端断开而丢失」——这点是对的，
  但若 SSE 中途异常断开，`_record_usage_safe` 可能**根本没被 await**（生成器被 GC）→ 同样白嫖。

---

## 五、隐患 4：单日限额逻辑漏洞

### 5.1 计算口径：**UTC 自然日**（不是滚动 24 小时）

```python
# db.py:421 get_spend_today()
start_of_day = time.mktime(time.localtime()[:3] + (0, 0, 0, 0, 0, -1))
SELECT COALESCE(SUM(cost_usd), 0) FROM usage_logs WHERE api_key = ? AND timestamp >= ?
```

- `time.localtime()` = **服务器本地时区**；生产机实测 `date` = UTC、`time.tzname = ('UTC','UTC')`
  → 口径 = **UTC 自然日 00:00 起算**，**不是**滚动 24 小时。
- 隐患 ①：口径**依赖机器 TZ 配置**。将来迁机或改 TZ，「单日」的边界会**静默漂移**，
  且不会报错，只是账期无声改变。
- 隐患 ②：UTC 日与 HK 用户所在的 UTC+8 日差 8 小时 —— HK 用户本地早上 8 点前，
  面板上的「今日已消费」统计的还是**昨天**。

### 5.2 并发击穿：限额在并发下**完全无效**

```python
# server.py:1174
daily_limit = float(user["daily_limit_usd"] or 0.0)
spent_today = await ... db.get_spend_today(api_key)          # ← 独立的一次读
if daily_limit > 0 and spent_today >= daily_limit:            # ← 软判定
    return openai_error(..., "daily_limit_exceeded", 402, "insufficient_quota")
```

三个问题叠加：

1. **判定读的是「已落库」的求和**，本请求自己的消费此刻**还没落库**；
2. **判定与扣费之间隔着整段推理**（§2.2）；
3. **判定用的是一次独立的读**（1176），与用户快照（1162）是**两次不同的连接、两个不同的时刻**，
   中间状态可能已变。

→ 100 并发同刻进入 → 全部读到同一个 `spent_today` → **全部放行** → 限额被击穿约 **100 倍**。
单请求层面还有 `>=` 的语义（允许最后一次超出），并发下则彻底失守。

### 5.3 天然日的午夜重置

自然日口径意味着 `23:59:59.9` 与 `00:00:00.1` 的两次消费**分属两天** →
午夜前后可花**双倍**限额。若产品语义是「每天最多 $X」，这是一个可主动利用的绕过口。
若要改成滚动 24 小时，需要同时改判定与前端「今日已消费」的口径（接口契约变更，需同步前端）。

### 5.4 `daily_limit_usd = 0` 的语义歧义

`if daily_limit > 0` → **`0` 表示「不限额」**。但 `PUT /api/v1/user/limit` 校验区间是
`[MIN_DAILY_LIMIT_USD=10, MAX_DAILY_LIMIT_USD=500]`，即 `0` **只能靠直接改库产生**。
而 DB 默认值本身就不统一：DDL `50.0` / 生产表现值 `100.0` / `seed_usage_logs` 写 `500.0`。

### 5.5 性能副作用（会成为隐性故障源）

`get_spend_today` 每个请求都做一次**无索引全表 SUM**（`usage_logs` 上没有 `(api_key, timestamp)` 索引），
且位于请求关键路径。现在 19 行无所谓，量级上去后是「每请求一次全表扫描」，
再叠加 §2.4 的写锁竞争 → 延迟与锁等待互相放大。

---

## 六、对症下药：目标架构设计

### 6.1 三条不变量（Invariants）

- **I1 绝不透支** —— 任何时刻 `users.balance_usd ≥ 0`（除非显式授信）。
- **I2 限额不可击穿** —— 任意时刻，用户当日累计消费 ≤ `daily_limit_usd`，且**判定与扣费在同一写事务内**。
- **I3 账实相符** —— 每一笔余额变动都有且只有一条 `balance_ledger` 行；
  `users.balance_usd` 恒等于该 api_key 的账本净额。

### 6.2 表结构设计

#### （1）`balance_ledger` —— 账本流水表

```sql
CREATE TABLE IF NOT EXISTS balance_ledger (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    api_key           TEXT    NOT NULL,
    entry_type        TEXT    NOT NULL,   -- TOPUP / USAGE / HOLD / HOLD_RELEASE / REFUND / ADJUST / REWARD / OPENER
    direction         INTEGER NOT NULL,   -- +1 入账 / -1 出账
    amount_usd        REAL    NOT NULL,   -- 恒为正数，方向由 direction 决定（避免符号歧义）
    balance_after_usd REAL    NOT NULL,   -- 记账后的余额快照（对账锚点）
    request_id        TEXT    DEFAULT '', -- 业务请求号，与 usage_logs 关联
    idem_key          TEXT    DEFAULT NULL,-- 幂等键；唯一索引防重复入账
    model_id          TEXT    DEFAULT '',
    node_id           TEXT    DEFAULT '',
    prompt_tokens     INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    cost_usd          REAL    DEFAULT 0.0,
    day_key           TEXT    DEFAULT '', -- 'YYYY-MM-DD'（UTC），单日限额口径
    day_spent_usd     REAL    DEFAULT 0.0,-- 记账后的当日累计（冗余快照，免扫表对账）
    note              TEXT    DEFAULT '',
    created_at        REAL    NOT NULL
);

CREATE INDEX        IF NOT EXISTS idx_bl_api_time ON balance_ledger(api_key, created_at);
CREATE INDEX        IF NOT EXISTS idx_bl_req      ON balance_ledger(request_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bl_idem     ON balance_ledger(idem_key);
```

**SQLite 3.7.17 兼容要点**：

- `idem_key` 用 `NULL` 表示「不参与幂等」——SQLite 唯一索引允许多行 NULL，3.7.17 行为一致；
- **不要用 partial index**（`WHERE request_id IS NOT NULL` 需 SQLite ≥ 3.8.0，生产是 3.7.17），
  改为「幂等键单独一列 + 唯一索引」；
- `CREATE INDEX IF NOT EXISTS` 自 3.3.0 起可用 ✅；
- `ALTER TABLE ... ADD COLUMN` 沿用现有 `_ensure_column()` 平滑补齐模式。

#### （2）`daily_spend` —— 把限额判定变成一次原子累加

```sql
CREATE TABLE IF NOT EXISTS daily_spend (
    api_key   TEXT NOT NULL,
    day_key   TEXT NOT NULL,              -- UTC 'YYYY-MM-DD'，口径写死不再依赖服务器 TZ
    spent_usd REAL NOT NULL DEFAULT 0.0,
    PRIMARY KEY (api_key, day_key)
);
```

#### （3）`users` 增补

```sql
ALTER TABLE users ADD COLUMN balance_frozen_usd REAL DEFAULT 0.0;  -- 预扣占用额（方案 B）
ALTER TABLE users ADD COLUMN credit_limit_usd   REAL DEFAULT 0.0;  -- 授信额度（可为 0）
```

（`users.balance` 死列建议归档或 `DROP`，消除双余额列歧义 —— 需与批次 3 迁移一并处理。）

---

### 6.3 核心：能彻底防御并发击穿的「原子化条件式 UPDATE」伪 SQL

#### 前置条件（两条，缺一不可）

1. **写事务必须是 `BEGIN IMMEDIATE`**。
   Python `sqlite3` 默认是 deferred 事务：先读后写时，事务要从共享锁升级为写锁，
   若此时已有别的写者，会直接 `database is locked`（甚至死锁）。
   正确写法：`conn = sqlite3.connect(DB_PATH, isolation_level=None)` + `conn.execute("BEGIN IMMEDIATE")`。
2. **整段「检查 + 动作」必须在同一个写事务内**。
   SQLite 的写事务**全局串行**（同一时刻只有一个写者），
   所以只要判定被表达成**受影响行数（rowcount）**而不是「先查后写」的应用层顺序，
   TOCTOU 窗口就不存在。

#### 方案 A —— 最小改动，先止血：**后置结算永不透支**

```sql
BEGIN IMMEDIATE;

-- (0) 幂等：同一 request_id 已入账 → 不再扣费
--     唯一索引 idx_bl_idem 是最后一道防线（INSERT 撞 IntegrityError → 视为已结算）
SELECT id FROM balance_ledger WHERE idem_key = :idem_key;
-- 命中 → COMMIT 并返回 'duplicate'（不重复扣费、不重复记账）

-- (1) ★余额闸门：原子化条件式 UPDATE —— 防御透支的核心
UPDATE users
   SET balance_usd = balance_usd - :cost_usd
 WHERE api_key = :api_key
   AND balance_usd >= :cost_usd;        -- ← 关键条件：扣后仍 ≥ 0 才命中
-- rowcount = 0 → 余额不足 / 账户不存在 → ROLLBACK → 402 insufficient_balance
-- 语义上**不可能**扣成负数：只有「扣后仍非负」的行才会被命中

-- (2) ★单日限额闸门：同样是原子化条件式累加
--    3.7.17 无 ON CONFLICT → 先试 UPDATE，rowcount=0 再走「条件式 INSERT」
UPDATE daily_spend
   SET spent_usd = spent_usd + :cost_usd
 WHERE api_key = :api_key
   AND day_key  = :day_key
   AND spent_usd + :cost_usd <= :daily_limit_usd;   -- ← 关键条件
-- rowcount = 0 → 当日首次出现该 (api_key, day_key) → 尝试条件式 INSERT：
INSERT INTO daily_spend (api_key, day_key, spent_usd)
     SELECT :api_key, :day_key, :cost_usd
      WHERE (SELECT COALESCE(SUM(spent_usd), 0) FROM daily_spend
              WHERE api_key = :api_key AND day_key = :day_key) + :cost_usd <= :daily_limit_usd;
-- 仍 rowcount = 0 → 超过单日限额 → ROLLBACK → 402 daily_limit_exceeded
-- （写事务串行 ⇒ 并发 INSERT 不会撞主键；真撞了也只是主键冲突，可重试）

-- (3) 记账：唯一「钱的事实来源」
INSERT INTO balance_ledger
    (api_key, entry_type, direction, amount_usd, balance_after_usd,
     request_id, idem_key, model_id, node_id,
     prompt_tokens, completion_tokens, cost_usd, day_key, day_spent_usd, note, created_at)
VALUES
    (:api_key, 'USAGE', -1, :cost_usd,
     (SELECT balance_usd FROM users WHERE api_key = :api_key),          -- 同事务内读，安全
     :request_id, :idem_key, :model_id, :node_id,
     :prompt_tokens, :completion_tokens, :cost_usd, :day_key,
     (SELECT spent_usd FROM daily_spend WHERE api_key = :api_key AND day_key = :day_key),
     :note, :now);

-- (4) 用量日志（保留现有 usage_logs，前端分析口径不变）
INSERT INTO usage_logs (api_key, node_id, model_id, prompt_tokens, completion_tokens,
                        cost_usd, timestamp, model_tier, node_earn_usd,
                        creator_royalty_usd, platform_fee_usd, request_id)
VALUES (:api_key, :node_id, :model_id, :prompt_tokens, :completion_tokens,
        :cost_usd, :now, :model_tier, :node_earn_usd,
        :creator_royalty_usd, :platform_fee_usd, :request_id);

-- (5) 节点收益（与扣费同事务：钱与算力同生共死）
UPDATE nodes_history
   SET total_tokens_processed = total_tokens_processed + :tokens,
       total_earnings_paw    = total_earnings_paw + :paw,
       last_seen = :now
 WHERE node_id = :node_id;

COMMIT;
```

> **方案 A 的已知不足**：闸门仍在请求**开始**、扣费在请求**结束**。
> 它保证「**余额不会被扣成负数**、**账本永远自洽**」，
> 但**不能**保证「平台不为已消耗的算力收不到钱」（并发抢锁时仍可能白嫖）。
> 要根治，见方案 B。

#### 方案 B —— 正解：**预扣—结算（Hold / Settle）**，消除 90 秒窗口

结构性问题的本质是「**先给算力、后扣钱**」。要真正做到「不透支算力」，
额度占用必须**提前**到派单之前。

```sql
-- ===== T0：请求进入、派单之前 → 原子预扣 =====
BEGIN IMMEDIATE;

UPDATE users
   SET balance_usd        = balance_usd - :hold_usd,
       balance_frozen_usd = balance_frozen_usd + :hold_usd
 WHERE api_key = :api_key
   AND balance_usd >= :hold_usd;
-- rowcount = 0 → 402 insufficient_balance（此时尚未派单 → 零算力浪费）

UPDATE daily_spend
   SET spent_usd = spent_usd + :hold_usd
 WHERE api_key = :api_key
   AND day_key = :day_key
   AND spent_usd + :hold_usd <= :daily_limit_usd;
-- rowcount = 0 → 402 daily_limit_exceeded（同上，零算力浪费）

INSERT INTO balance_ledger
    (api_key, entry_type, direction, amount_usd, balance_after_usd,
     request_id, idem_key, day_key, day_spent_usd, note, created_at)
VALUES
    (:api_key, 'HOLD', -1, :hold_usd,
     (SELECT balance_usd FROM users WHERE api_key = :api_key),
     :request_id, :idem_key, :day_key,
     (SELECT spent_usd FROM daily_spend WHERE api_key = :api_key AND day_key = :day_key),
     '推理前预扣', :now);

COMMIT;

-- ===== …执行推理（派单最长 90s）… =====

-- ===== T1：推理结束 → 按实际用量结算，多退少补 =====
BEGIN IMMEDIATE;

-- 退/补差额（:delta = :hold_usd - :actual_usd，可正可负）
INSERT INTO balance_ledger
    (api_key, entry_type, direction, amount_usd, balance_after_usd,
     request_id, idem_key, model_id, node_id,
     prompt_tokens, completion_tokens, cost_usd, day_key, day_spent_usd, note, created_at)
VALUES
    (:api_key, 'SETTLE', :dir, ABS(:delta),
     (SELECT balance_usd FROM users WHERE api_key = :api_key),
     :request_id, :settle_idem_key, :model_id, :node_id,
     :prompt_tokens, :completion_tokens, :actual_usd, :day_key,
     (SELECT spent_usd FROM daily_spend WHERE api_key = :api_key AND day_key = :day_key),
     '推理后结算', :now);

UPDATE users
   SET balance_usd        = balance_usd + :delta,
       balance_frozen_usd = balance_frozen_usd - :hold_usd
 WHERE api_key = :api_key;

UPDATE daily_spend
   SET spent_usd = spent_usd + (:delta)          -- delta<0 即退还占用
 WHERE api_key = :api_key AND day_key = :day_key;

INSERT INTO usage_logs (...) VALUES (...);       -- 与今天一致

UPDATE nodes_history
   SET total_tokens_processed = total_tokens_processed + :tokens,
       total_earnings_paw    = total_earnings_paw + :paw,
       last_seen = :now
 WHERE node_id = :node_id;

COMMIT;
```

**方案 B 的四个关键设计点**：

1. **预扣上界**：`hold_usd` = `max_tokens`（请求未指定则取模型默认）× 单价 + 余量。
   预扣过松 → 长时间占额；过紧 → 真实用量超预扣 → 结算阶段余额可能不足，
   此时**记挂账（entry_type='OVERDRAFT'）而不是静默透支**。
2. **HOLD 行是证据**：即使推理阶段进程崩溃（预扣已落账、SETTLE 未落），
   靠 `HOLD` 行 + **超时补偿任务**（扫描 `HOLD` 超过 N 分钟未 `SETTLE` 的记录 → 退回冻结额）
   即可恢复，**不会凭空吞钱**。
3. **日限额的 `spent_usd` 在方案 B 里记的是「占用额」**，`SETTLE` 时回退差额 → 最终值 = 真实消费。
4. **节点收益只在 SETTLE 阶段记**，且「模拟回答不记节点收益」。

### 6.4 为什么这套能「彻底防御并发击穿」—— 三道锁

| 锁 | 机制 | 挡住了什么 |
|---|---|---|
| **锁 1：写事务全局串行** | `BEGIN IMMEDIATE` 独占写锁，整段「检查+动作」不可被穿插 | TOCTOU 窗口（「读到旧值再写回」的同时竞态） |
| **锁 2：判据写在 WHERE 里** | 余额/限额判定是 `rowcount`（受影响行数），不是「先查后写」 | 「检查通过但动作超额」类漏洞（含负余额） |
| **锁 3：唯一索引做幂等兜底** | `idem_key` 唯一索引在**数据库层**拒绝重复入账 | 重复结算 / 重放扣费 |

**配套（不可省略）**：

- `get_db()` 增加 `PRAGMA busy_timeout = 15000`（复用 db.py:38 已有的 `REGISTRY_BUSY_TIMEOUT_MS` 口径）；
- 写锁抢不到时**明确失败并重试**，或回退到「预扣失败 → 不派单」，**绝不能吞掉**；
- 扣费失败必须**落一条 `entry_type='FAILED'` 的账本行**（可对账、可补偿），不能只 `print`。

### 6.5 配套改造清单（建议顺序）

| # | 改动 | 位置 | 目的 |
|---|---|---|---|
| 1 | 建 `balance_ledger` / `daily_spend` + 索引；`users` 加 `balance_frozen_usd` / `credit_limit_usd` | db.py `init_db()` | §6.2 |
| 2 | `get_db()` 加 `PRAGMA busy_timeout=15000` | db.py:152 | §2.4 |
| 3 | 新增 `reserve_usage_atomic()`（HOLD）与 `finalize_usage_atomic()`（SETTLE）；`record_usage` 降级为兼容包装 | db.py | §6.3 方案 B |
| 4 | `get_spend_today` 改读 `daily_spend`（O(1)）；`day_key` 用固定 UTC 计算（`datetime.utcnow().strftime('%Y-%m-%d')`），**不再依赖服务器 TZ** | db.py:421 | §5.1 / §5.5 |
| 5 | 额度闸门从「读快照」改为「原子预扣」；推理后调用 `finalize_usage` | server.py:1174 / 1264 | §2.3 / §5.2 |
| 6 | 扣费失败**落 `FAILED` 账本行** + 触发补偿（退款/挂账），不再只 `print` | server.py:1276 | §4.2 |
| 7 | **模拟回答不给节点计酬**：`settle_node_id` 在无真实节点时应为空；节点收益只记真实派单 | server.py:1262 | §3.4 |
| 8 | 结算回执与落库解耦：落库成功后再发回执；回执失败进**可重投队列**（`settlement_outbox` 表） | server.py:1280 / 1619 | §4.2 |
| 9 | `record_withdrawal` 改条件式原子扣减（同一 WHERE 条件思路）+ 创作者侧 `wallet_ledger`（或复用 `balance_ledger` 按 `owner_wallet` 分账维度） | db.py:1018 | §3.3 |
| 10 | 一次性迁移脚本：把现有 `usage_logs` **回填**为 `balance_ledger` 的 `USAGE` 行（`balance_after` 逐条累计），并补一条 `OPENER` 期初行（1000.00） | 迁移脚本 | §3.2 第 2 条 |
| 11 | 每日对账任务：`Σ(direction-weighted amount_usd)` vs `users.balance_usd`，差异 > 1e-6 告警 | 运维 | §6.1 I3 |
| 12 | 明确 `daily_limit_usd = 0` 的语义（0 = 不限额 还是 不允许），统一 DDL 默认值与 API 区间 | db.py:228 / server.py:628 | §5.4 |
| 13 | 清理 `users.balance` 死列；归档/删除业务库里的历史 `node_registry` 空表（0 行） | 迁移脚本 | §〇 第 9/10 条 |

### 6.6 生产数据现状体检（只读结论，供迁移基线用）

| 项 | 值 |
|---|---|
| `users` 行数 | 1（`paw_demo_key`，role=OWNER） |
| `users.balance_usd` | **999.84541** |
| `users.balance`（死列） | 100.0 |
| `users.daily_limit_usd` | 100.0 |
| `usage_logs` 行数 / Σcost | 19 / **0.15459** |
| 账实自洽性 | 1000 − 0.15459 = **999.84541** ✅ 恰好相等（但**无账本、无期初记录**，不可审计） |
| `nodes_history` | `apipaw-cloud-sim` 920 tok / **489.24725 PAW**（全为模拟回答）｜`node_default_001` 628 tok / 142.41325 PAW |
| 真实节点 vs 模拟节点 的 usage 占比 | 2 / 19 ≈ 10.5% |
| 充值/退款/冲正接口 | **不存在** |
| 业务库 `node_registry` 遗留表 | 存在但 **0 行**（与注册表库同名，歧义源） |

---

## 七、审计声明

- 本次审计**未修改任何代码**：源站 `git status` 干净，`git log` 顶部仍是 `bae4a96`。
- 本次审计**未对任何数据库执行写操作**：仅通过 `sqlite3 "file:apipaw.db?mode=ro"`（只读 URI）查询表结构与抽样数据。
- 审计过程中产生的临时文件只落在本地 `D:\tmp\apipaw-cloud-b3-audit\`（生产源码的只读副本）。
- **下一步建议**：以 §6.3 方案 B（预扣—结算）+ §6.5 清单作为批次 3 的实施蓝本；
  其中**必须先做**的是第 1/2/5/6 项（账本 + busy_timeout + 原子预扣 + 失败落账），
  它们一次性消灭「负余额」「限额击穿」「无痕扣费」三大 P0。
