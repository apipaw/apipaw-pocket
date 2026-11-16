# 阶段七 · 授信入账口径与账本自愈（PHASE7-CREDIT-LEDGER）

> 立项日期：2026-11-16
> 上一个阶段：阶段六（算力网络，P0~P4 已封板，见 `PHASE6-NETWORK-TODO.md`）
> 状态：**P0 已上线生产并封板**（2026-11-16）

---

## §0 红线（先读这一节）

1. **生产零新依赖** —— 本阶段只用标准库（`sqlite3`/`os`/`time`），不引入任何包。
2. **`deploy_backup.sh` 先备份** —— 动生产库/生产代码前必跑。
3. **沙箱 + 线上验证全绿才上生产** —— 沙箱用 `APIPAW_DB_PATH` 指向临时目录。
4. **开关显式声明、默认关闭** —— 部署「使某开关生效」的代码之前，先把 systemd 单元里
   那个开关**显式置 0**（阶段五 P3 教训：单元里预留 =1 的开关等于把扳机留在枪上）。
5. **不改余额补账** —— 补账只补**流水**，余额始终以 `users.balance_usd` 为准。
6. **负差额永不自动修** —— 余额少于账本 = 疑似重复扣费/数据损坏，自动填平会**掩盖真实缺陷**，
   必须人工介入。

---

## §1 起因：一次生产核对揪出的"账实不符"

2026-11-16 例行核对生产账本时，`audit_report.py` 判 **FAIL**：

```
差额 (BAL-NET)  : 10.000000   => **FAIL**
```

追查（`acct_a8c3a2eac22cba78`，2026-11-15 14:16 UTC 通过
`POST /api/v1/auth/apikey` 自助注册）：

| 证据 | 结论 |
|---|---|
| journal 里**从未出现** `POST /api/v1/user/recharge` | 没走过唯一入账入口 |
| 部署代码（`214307f` 与源站快照 `e8c4c3c`）里**三处** `INSERT INTO users` 全都显式写 `balance_usd`（0 或 100） | 注册不会白送 $10 |
| `db.add_balance()` 在同一个 `BEGIN IMMEDIATE` 事务里写余额 + `RECHARGE` 流水 | 走它必然有流水 |
| 账本里该账户只有 HOLD/SETTLE/WAIVED，**没有 +10 的入账行** | 这 $10 是**直改 DB 手工发放**的 |

⇒ **有余额、无流水背书** —— 违反不变式 A（`Σ账本净额 == Σ账户余额`）。

---

## §2 为什么既有机制救不了（机制盲区）

`db._backfill_opener_rows()`（阶段五 P4 · 模块 A）本该给「有余额但账本为空」的账户补一条
`OPENER` 期初行。但它的判定是：

> **只处理「账本里一行都没有」的账户**（幂等，重复执行不会重复补）

该账户已有 HOLD/SETTLE 流水 ⇒ 期初行**永远不会被补** ⇒ 账实**永久**不符。
更糟的是：机制只会补「零行账户」，而**恰恰是已经产生消费的账户**最容易在重启后被漏掉。

这不是"漏了一次"，是"**没有自愈路径**"。

---

## §3 方案比对

| 方案 | 思路 | 优点 | 缺点 / 瓶颈 | 结论 |
|---|---|---|---|---|
| **A · 只补这一次数据** | 手工插一条 `RECHARGE +10` | 立刻恢复 OK，改动最小 | 机制盲区原样保留 —— 下一次手工授信仍然账实不符 | ❌ 治标 |
| **B · 启动时全量差额自愈** | 启动时对每个账户算 `NET vs BAL`，差额一律补平 | 任何来源的漏记都能自愈 | **会把真实缺陷也填平**（扣费漏记流水 → 审计再也报不出来，红线失守） | ❌ 太危险 |
| **C · 分层：只补正差额 + 静态门禁 + 账户级告警** | ① 正差额（余额>账本 ⇒ 钱进了没记账）可自动补流水；② 负差额（余额<账本 ⇒ 疑似重复扣费）**永不自动补**，只报告；③ 把"每笔余额变动必须有流水"做成**可执行门禁**；④ 审计报表按**账户**维度定位差异 | 自愈只发生在"如实还原"的方向；真实缺陷仍会 FAIL；门禁把口头约定变成 CI 可跑的规则 | 实现量比 B 大（多一个门禁脚本 + 账户维度对账） | ✅ **采用** |

C 的核心洞见：**"补账"和"掩盖缺陷"必须按差额方向分开对待**。
正差额补的是**事实**（钱确实到账了，只是没记账）；负差额填的是**谎言**（账本比余额多，
说明钱被多扣了）。

---

## §4 阶段七 P0 · 交付内容

| 项 | 落地 | 关键点 |
|---|---|---|
| **账户维度差异检测** | `db.reconcile_account_gaps()` | 只读；返回每个差异账户的 `balance_usd` / `ledger_net_usd` / `diff_usd` / `kind` |
| **账本自愈** | `db.heal_ledger_gaps(dry_run=True)` | **只补正差额**；写一条 `RECONCILE` 流水；**余额分毫不动**；幂等（补完差额为 0，再跑不写） |
| **启动自愈开关** | `APIPAW_RECONCILE_ON_BOOT`（`p7-p0.conf`，**当前 =0**） | =0 只在启动日志打 `[db][reconcile][WARN]`；=1 才自动补录正差额 |
| **审计账户级明细** | `audit_report.py` 新增 `[账户 D]` 段；`reconcile_ledgers()` 新增 `account_gaps` 字段；`problems` 里点名到账户 | 汇总差额只说"差多少"，账户维度才说"**是谁的钱**" |
| **授信入口静态门禁** | `check_credit_paths.py` | 扫描 `db.py`/`server.py` 里所有 `UPDATE users SET balance_usd`，回溯所属函数；不在白名单 ⇒ 退出码非 0 |
| **沙箱自检** | `smoke_p7_p0_sandbox.py` | 9 项断言，见 §5 |

### 门禁白名单（每一处余额写入都必须自带流水）

```
reserve_usage_atomic       预扣 HOLD      —— 与流水同事务
finalize_usage_atomic      结算/退款      —— 与流水同事务
release_failed_reservation 释放预扣       —— 与流水同事务
reap_stale_holds           回收僵尸预扣   —— 与流水同事务
add_balance                充值 RECHARGE  —— **唯一入账入口**
seed_usage_logs            演示数据播种（仅演示库）
```

---

## §5 交付实录（2026-11-16）

### 5.1 数据修复（生产）

- 备份：`deploy_backup.sh p7-p0-fix` → `/opt/apipaw-backups/db/apipaw_p7-p0-fix_20261115-235928.db`
- 补录：给 `acct_a8c3a2eac22cba78` 插一条 `RECHARGE` 入账行
  （`idem_key = RECHARGE:manual-credit-20261116-a8c3a2ea`，`balance_after_usd = 10.0`，
  `created_at = 1794752200.0`，与既有 HOLD/SETTLE 的 `balance_after` 链首尾相接）
- 修复后：`NET == BAL == 1026.022962`，`总判定 OK`，`integrity_check = ok`

> ⚠️ **基线口径变更**：旧基线 `1016.037562` 已作废。
> 现基线 `1026.022962` = 旧基线 + $10（真实手工授信）+ $0.0146（真实推理消费）。
> **这是真实业务，不是测试污染** —— 核对基线时不要再按"必须回到 1016.037562"判断。

### 5.2 代码上线（生产）

- 备份：`deploy_backup.sh p7-p0-deploy` → `.../20261116-001240`
- 同步：`db.py` / `audit_report.py` / `check_credit_paths.py` / `smoke_p7_p0_sandbox.py`
  （scp 后 `tr -d '\r'` 去 CRLF；`md5sum` 与本地去 CRLF 后一致）
- 编译校验：源站 **Python 3.6.8** 下 `py_compile` 四个文件全过
  （`cfile=/tmp/...` 绕开 root 拥有的 `__pycache__` 写权限）
- 开关：新增 `/etc/systemd/system/apipaw-cloud.service.d/p7-p0.conf`
  → `APIPAW_RECONCILE_ON_BOOT=0`（**显式置 0**）
- 重启后：`audit_report` 总判定 **OK**、`[账户 D] 差异账户数 = 0`、启动日志 **0 条 reconcile 告警**
- `systemctl is-active` = `active`，无 error/traceback

### 5.3 验证矩阵

| 环境 | 套件 | 结果 |
|---|---|---|
| 本地 Windows | `smoke_p7_p0_sandbox.py` | **9/9** |
| 源站 Python 3.6.8 | `smoke_p7_p0_sandbox.py` | **9/9** |
| 本地 | `test_py36_compat` / `test_db_compat` | 6/6 · 8/8 |
| 本地 | 阶段五 P0/P1/P2/P3/P4 | 25/25 · 32/32 · 34/34 · 45/45 · 45/45 |
| 本地 | 阶段六 P0/P1/P1-stream/P2/P3 | 52/52 · 20/20 · 16/16 · 90/90 · 81/81 |
| 本地 | `test_dispatch` / `test_dispatch_protocol_v2` / `test_batch2_sandbox` / `test_wallet_auth` / `test_registry_concurrency` | 37/37 · 19/19 · 32/32 · 23/23 · 11/11 |
| 源站 | `check_credit_paths.py` | 总判定 **OK**（8 处写入点全在白名单） |

沙箱 9 项断言：

```
S1 新建库账实相符
S2 新签发账户 $0 且无流水 ⇒ 无差异
S3 正规充值 add_balance ⇒ 写 RECHARGE 流水 ⇒ 仍相符
S4 手工授信（裸 UPDATE）⇒ 审计报 FAIL 且定位到账户
S5 自愈 dry-run 只报告、不写库
S6 自愈落库 ⇒ 补 RECONCILE ⇒ 恢复相符且余额分毫未动
S7 自愈幂等：再跑一次不再写行
S8 负差额（疑似重复扣费）⇒ 不自动补、只报告
S9 静态门禁通过
```

---

## §6 遗留 TODO（下一阶段候选）

| 编号 | 内容 | 备注 |
|---|---|---|
| P1-a | 账户级差异对外可观测：OWNER 端点暴露 `account_gaps` 计数 + 前端"账实健康"卡 | P0 只做了 CLI/报表与 OWNER API 字段 |
| P1-b | 授信入口**彻底收敛为 HTTP API**（`POST /api/v1/user/recharge` 已存在，但运维仍能直改 DB）—— 需要一条"只允许 add_balance 改余额"的**运行时**约束（如 DB 触发器或独立写路径） | SQLite 触发器在 3.7.17 上受限，方案待评估 |
| P1-c | `users.balance`（legacy 列，恒 100）与 `balance_usd` 脱节 | 当前代码**不读**该列（仅 `server.py:1986` 的 dict key），无害；但历史包袱建议清理 |
| P2 | 把 `check_credit_paths.py` 接进 CI / 部署前置检查 | 阶段六/七尚无 cloud 仓 CI（CI 目前只在 Agent 仓） |

---

## §7 踩坑记录

1. 🔴 **`_backfill_opener_rows` 的盲区**：只补"账本零行"的账户 ⇒ 已有消费的账户永远补不上期初行。
   这就是"机制只在最好情况下工作"的典型反例。
2. 🔴 **源站 `__pycache__` 是 root 所有**：`python3 -m py_compile` 会因写 `.pyc` 失败而**看起来像语法错误**。
   正解：`py_compile.compile(f, cfile="/tmp/x.pyc", doraise=True)`。
3. ⚠️ **审计基线会因真实业务漂移**：`1016.037562` 这种"分毫不差"的基线只在使用量=0 时成立。
   有真实用户充值/消费后，基线必须重新锚定，**不能把真实业务当污染清掉**。
4. ⚠️ **`balance_after_usd` 是链式锚点**：补录行必须落在正确的时间位置上，
   否则账本快照链会断（本次补录取 `created_at = 1794752200`，与既有 HOLD/SETTLE 首尾相接）。
5. ⚠️ **源站 Python 是 3.6.8**：`db.py` 新代码必须 3.6 兼容（无 f-string、无 `model_dump()`、
   无 `asyncio.to_thread`）。本次已用 `py_compile` 在源站实机校验。
