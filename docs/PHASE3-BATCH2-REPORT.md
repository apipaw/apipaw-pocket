# 阶段三 · 批次 2 验证报告：数据模型统一与派单调度器重构

- **日期**：2026-11-08
- **目标仓库**：`/opt/apipaw-cloud`（香港生产机）
- **服务**：`apipaw-cloud.service` → uvicorn 127.0.0.1:8000，`--workers 1`，`APIPAW_DISPATCH_ENABLED=1`
- **提交**：`bae4a96` — `feat: 🏗️ 完成批次2数据模型统一，重构节点归属与派单调度器过滤逻辑`（858+/39-，4 文件）
- **对应 TODO**：TODO-04 / 05 / 06 / 13 / 14（+ 15 部分）

---

## 一、结论

**「暂停接单」这个开关现在真的生效了。** 此前 `is_paused` 在全代码库**无人读取** ——
业主在面板上把节点切到「已暂停接单」，派单照发。现在派单器联合查询 `nodes_history.is_paused`，
已暂停节点一律不参与选点，并在下发瞬间二次校验。

**节点数据不再是两套割裂的口径。** `node_registry` 成为唯一权威节点表，
面板与节点清单接口共用同一份统一视图，「在线 N / 登记 M」两个数字永远自洽。

**节点收益第一次能归属到钱包。** `node_credentials.owner_wallet` 落地，
`owner/dashboard` 的 `my_nodes` 块给出名下节点的总收益与 token 产出。

---

## 二、验证矩阵

### 2.1 沙箱验证（SQLite 副本，源站 Python 3.6.8 + SQLite 3.7.17）

脚本：`/opt/apipaw-cloud/test_batch2_sandbox.py`（已入库）
隔离方式：`APIPAW_DB_PATH` / `APIPAW_NODE_REGISTRY_PATH` 指向 `.backup` 出来的副本，
`import server` 触发的 `init_db()` / `_init_node_registry()` 全部落在副本上，**不碰生产库**。

> 为什么必须在源站跑：本机 SQLite 比生产新（3.4x vs 3.7.17），
> 本机跑通不代表生产跑得通（UPSERT / `VACUUM INTO` 这类版本差异就是这么漏过去的）。

| # | 用例 | 结果 |
|---|---|---|
| T1 | 心跳后 `nodes_history` 出现该节点 / `last_seen` 刷新 / 产出保持 0 / 暂停位默认 0 | ✅ 4/4 |
| T2 | 新节点心跳后面板立刻显形（alive / status / channel / node_name / in_registry） | ✅ 5/5 |
| T3 | 未暂停节点可被派单选中（基线行为不回归） | ✅ |
| T4 | **暂停后不再被选中**，恢复后重新可选 | ✅ 2/2 |
| T5 | **注册表无 WS 心跳的节点被排除**（HTTP 假在线隔离） | ✅ 2/2 |
| T6 | 无 `agent_version` 的老节点被排除 | ✅ |
| T7 | **派单瞬间已被暂停 → 下发被拒**（`error=node_paused`） | ✅ 2/2 |
| T8 | 按 owner_wallet 聚合收益（1 节点 / 12.5 PAW / 100 tokens / 无关钱包为 0） | ✅ 4/4 |
| T9 | 面板节点字段类型契约（前端 `toFixed` / `toLocaleString` 依赖） | ✅ |
| T10 | 探针残留默认隐藏、`include_hidden=1` 可见、默认视图是全量的子集 | ✅ 4/4 |
| T11 | `dispatchable` / `dispatch_eligible` 把「假在线」暴露出来 | ✅ 4/4 |

**合计 32/32 通过，0 失败。**

### 2.2 生产实测

| # | 用例 | 期望 | 实测 | 结果 |
|---|---|---|---|---|
| 1 | 三个业主端点无 key | 401 | 401 / 401 / 401（P0 鉴权未回归） | ✅ |
| 2 | `owner/dashboard`（OWNER） | 200 | 200，3 个节点，字段完整 | ✅ |
| 3 | `owner/dashboard` 计数自洽 | `registered_nodes_total` == `/api/v1/nodes` 节点数 | 3 == 3 | ✅ |
| 4 | `?include_hidden=1` | 运维视图含全部残留 | 21 条（其中 `probe_*` 15 条） | ✅ |
| 5 | **真实心跳 → 面板刷新** | `last_seen` 实时刷新、面板 `alive=true` | `last_seen` 1793936070 → 1794115483；`active_nodes_online` 0 → 1 | ✅ |
| 6 | 名下节点收益聚合 | 按 owner_wallet 聚合 | `my_nodes.total_earnings_paw` = 142.41325 PAW / 628 tokens | ✅ |
| 7 | **暂停节点** | 面板显示已暂停、不可调度 | `is_paused=1`、`dispatch_eligible=false` | ✅ |
| 8 | 恢复节点 | 状态复原 | `is_paused=0` | ✅ |
| 9 | 不存在的节点 toggle | 404 且不新增行 | 404，`nodes_history` 2 → 2，`probe*` 残留 0 | ✅ |
| 10 | 推理链路冒烟 | 200 | 200（无 WS 节点 → 正常回退模拟回答） | ✅ |
| 11 | 其它接口 | 200 | `user/usage` / `creator/models` / `v1/models` / `health` 全 200 | ✅ |
| 12 | 派单器日志 | 无异常 | 无 Traceback / dispatch 错误 | ✅ |
| 13 | `PRAGMA integrity_check` 两库 | ok | ok / ok | ✅ |
| 14 | Pocket e2e | 24/24 | **24/24 通过**，节点卡片渲染 3 处 | ✅ |
| 14b | Console e2e | 24/24 | **24/24 通过**（首次跑 22/24，CF 边缘冷启动致应用渲染耗时 308s；重跑 24/24） | ✅ |

---

## 三、代码改动清单

### `db.py`（+253/-）

| 改动 | 说明 |
|---|---|
| `init_node_credentials()` | DDL 与迁移补 `owner_wallet TEXT DEFAULT ''` / `owner_id TEXT DEFAULT ''`（ADD COLUMN，3.7.17 可用） |
| `touch_node_last_seen()` | **新增** —— 心跳回写 `nodes_history.last_seen`；复用 `smooth_upsert`；15s 节流；2s 写锁超时；失败不抛异常 |
| `list_nodes_stats()` | **新增** —— 读 `nodes_history` 全量统计行 |
| `get_paused_node_ids()` | **新增** —— 一次查询取全部 `is_paused=1` 的节点（不在候选循环里逐个查） |
| `is_node_paused()` | **新增** —— 单节点暂停位（下发瞬间二次校验） |
| `get_node_owner_map()` | **新增** —— `node_credentials` 归属映射 |
| `set_node_owner()` | **新增** —— 绑定/解绑归属钱包 |
| `get_owner_nodes_revenue()` | **新增** —— 按 owner_wallet 聚合产出 |
| `list_node_credentials()` / `get_node_credential()` | 查询列追加 `owner_wallet` / `owner_id` |

### `server.py`（+314/-）

| 改动 | 说明 |
|---|---|
| `_touch_node()` | 注册表提交后回写 `nodes_history.last_seen`（TODO-05） |
| `_collect_node_view()` | **新增** —— 统一节点视图（注册表 + 统计 + 归属） |
| `_node_is_presentable()` | **新增** —— 判定节点是否值得展示（在线 / 有产出 / 有凭证且心跳过） |
| `get_owner_dashboard()` | 节点列表改用统一视图；新增 `owner_wallet` 与 `my_nodes` 收益块 |
| `list_nodes()` | 改用统一视图；新增 `?include_hidden=0/1` |
| `_registry_ws_alive_ids()` | **新增** —— 批量确认「最近有 WS 心跳」的节点 |
| `_select_dispatch_node()` | **重写** —— 加 `is_paused` 过滤 + WS 通道隔离 + fail closed |
| `dispatch_inference()` | 加下发瞬间的暂停二次校验（`error=node_paused`） |

### `manage_node.py`（+59/-）

- 新增 `bind` 子命令：绑定/解绑节点归属钱包
- `list` / `show` 输出新增 `OWNER_WALLET` 列

### 新增文件

- `test_batch2_sandbox.py` —— 批次 2 的 32 项回归测试（SQLite 副本上跑，不碰生产库）

---

## 四、关键设计决策

### 4.1 跨库不能原子提交 → 独立提交 + 节流 + 不抛异常

注册表在 `node_registry.db`（**WAL**），业务库在 `apipaw.db`（**rollback-journal**）。
SQLite 不支持跨库事务（`ATTACH` 在 WAL 下也不保证原子性），所以
「同事务更新两张表」在物理上做不到。折中方案：

- 注册表提交成功后，**独立**提交一次业务库；
- **15s 节流**：`last_seen` 还很新就不写 —— 心跳是每节点 30s 一次的高频事件，
  无节流地写会与 `/v1/chat/completions` 的结算事务抢 rollback-journal 写锁，
  **那正是 2026-11-01 把推理接口打成 500 的事故模式**；
- **失败绝不抛异常**：统计是旁路，失败只记日志，不能打断心跳与推理主链路；
- 写锁等待上限 2s，拿不到锁就跳过这一轮。

### 4.2 通道隔离判据用 `last_ws_heartbeat` 而非 `channel`

`node_registry.channel` 存的是「**最后一次**心跳来自哪条通道」，会翻转。
一个同时发 HTTP 心跳和 WS 心跳的节点，`channel` 可能变成 `http`，
但它的 WS 连接其实还活着 —— 用 `channel` 当判据会**误杀真 WS 节点**。
`last_ws_heartbeat` 直接回答「这条 WS 隧道最近还活着吗」，才是正确判据。

### 4.3 读状态失败一律 fail closed

读取暂停位 / 注册表状态失败时，**宁可不派单**（回退模拟回答），
也不把任务派给一个状态不明的节点。派单失败只影响这一次回答，
派错节点会让买家白等 90s 超时。

### 4.4 视图默认隐藏历史探针残留（数据不删）

`node_registry` 21 条里 15 条是 `probe_*` 调试残留（永不在线、无产出、无凭证）。
批次 2 **不删数据**，只让它们默认不出现在面板与清单里
（`?include_hidden=1` 可查全量）。真正的物理清理留给 TODO-15。

---

## 五、生产数据保护

| 保护措施 | 状态 |
|---|---|
| 批次 2 前 DB 快照 | `backups/apipaw_20261108-pre-b2.db`、`backups/node_registry_20261108-pre-b2.db` |
| 沙箱验证 | 全程在 `.backup` 副本上跑，**生产库零写入** |
| 生产写入 | 仅 `init_node_credentials()` 的 ADD COLUMN（2 列）、心跳回写的 `nodes_history.last_seen`、两条 owner_wallet 绑定 |
| `integrity_check` | 两库均为 `ok` |
| `nodes_history` 行数 | 2（与批次 2 前一致），无 `probe*` 残留 |
| `node_registry` 行数 | 21（与批次 2 前一致） |
| `users` 行数 | 1（`paw_demo_key`），未新增测试账号 |
| git config | **未修改**，身份用 `-c` 单次传参 |
| nginx / 3X-UI | 本轮完全未触碰 |
| GitHub 推送 | **未推送**（远端内嵌 PAT 且未获授权） |

### 运维数据变更（需知悉）

生产上把两个**已签发凭证**的节点绑定到了演示业主钱包：

```
manage_node.py bind --id node_default_001 --wallet 0x71C7656EC7ab88b098defB751B7401B5f6d8976F
manage_node.py bind --id node_user_002    --wallet 0x71C7656EC7ab88b098defB751B7401B5f6d8976F
```

`apipaw-cloud-sim`（模拟节点）**未绑定** —— 它没有凭证行，
不为其伪造凭证（那会给一个不存在的节点留下可用密钥）。

回退：`manage_node.py bind --id <node> --clear`

---

## 六、回滚方案

| 场景 | 动作 |
|---|---|
| 代码有语法/逻辑错误 | `git checkout 966ce58 -- server.py db.py manage_node.py` + `systemctl restart apipaw-cloud.service` |
| 表结构需回退 | ADD COLUMN 可空列，**不回退也不影响旧代码**（旧代码不读这两列）；如需清空归属：`manage_node.py bind --clear` |
| 节点列表异常 | `GET /api/v1/nodes?include_hidden=1` 看全量；隐藏逻辑是纯读侧过滤，无副作用 |
| 服务起不来 | `journalctl -u apipaw-cloud` → `git checkout 966ce58 -- server.py db.py` → 重启（基线 commit 必然可编译） |

---

## 七、遗留（下一阶段）

| 项 | 说明 |
|---|---|
| **TODO-06 尾巴** | 独立收益接口 `GET /api/v1/owner/nodes/revenue`（近 24h 增量时间序列）未做 |
| **TODO-13 尾巴** | 「已连接时主动下发 PAUSE 帧或断开」未做 —— 暂停目前只影响**后续选点**，已在途请求仍会跑完 |
| **TODO-14 尾巴** | HTTP 通道的「拉取式推理任务」（`/api/v1/node/tasks`）未做；多 worker 下 `connected_nodes` 进程内字典不共享（当前 `--workers 1` 掩盖） |
| **TODO-15** | 注册表残留只做了「隐藏」，物理清理（`retired_at` / 7 天退役 / `manage_node.py prune`）未做 |
| **TODO-08/09** | 余额账本与并发闸门（批次 3）未动 —— 余额仍是单列 REAL，闸门仍可击穿 |
| **实测缺口** | 生产当前**没有在线 WS 节点**（`nodes_online=0`），因此「暂停后真实推理不落到该节点」的端到端链路只在沙箱验证（用假 WS 连接 + 真注册表 + 真业务库副本）。真实 WS 节点回归需在有节点在线时补做 |

---

## 八、复现命令

```bash
# 沙箱回归（源站）
cd /opt/apipaw-cloud
mkdir -p /tmp/b2sandbox
sqlite3 apipaw.db ".backup /tmp/b2sandbox/apipaw.db"
sqlite3 node_registry.db ".backup /tmp/b2sandbox/node_registry.db"
B2_SANDBOX_DIR=/tmp/b2sandbox ./.venv/bin/python3 test_batch2_sandbox.py

# 面板与归属
curl -s -H "Authorization: Bearer paw_demo_key" http://127.0.0.1:8000/api/v1/owner/dashboard | python3 -m json.tool

# 节点清单（含全部残留）
curl -s -H "Authorization: Bearer paw_demo_key" "http://127.0.0.1:8000/api/v1/nodes?include_hidden=1" | python3 -m json.tool
```
