# 阶段三 · 第一阶段验证报告：基线固化 + P0 安全修复

- **日期**：2026-11-08
- **目标仓库**：`/opt/apipaw-cloud`（香港生产机，103.142.190.251:21201）
- **服务**：`apipaw-cloud.service` → uvicorn 127.0.0.1:8000，workers=1
- **提交**：
  - `721c485` — `chore: 📦 备份 DAY11-DAY15 未提交基线代码`
  - `966ce58` — `feat: 🔒 修复 P0 级端点零鉴权漏洞，新增 OWNER 角色鉴权与严格 Toggle 逻辑`
- **对应 TODO**：TODO-16 / TODO-01 / TODO-02 / TODO-03

---

## 一、结论

**三个业主端点的零鉴权敞口已彻底关闭。** 修复前公网不带任何凭据即可读写节点数据并改写节点状态；
修复后缺 key → 401，无效 key → 401，有效但非 OWNER → 403，OWNER → 200。
Toggle 的 INSERT 副作用已消除，不存在的节点一律 404 且**不产生任何新行**。
生产库全程受保护，修复前后 `PRAGMA integrity_check` 均为 `ok`。

---

## 二、验证矩阵（全部实测生产）

| # | 用例 | 期望 | 实测 | 结果 |
|---|---|---|---|---|
| 1 | `GET /api/v1/owner/dashboard` 无 Authorization | 401 | 401 `缺少 API Key` | ✅ |
| 2 | 同上，`Bearer wrong_key_xxx` | 401 | 401 `无效的 API Key` | ✅ |
| 3 | 同上，`Bearer <临时 BUYER key>` | 403 | 403 `该账号不是 OWNER，无权访问业主接口` | ✅ |
| 4 | 同上，`Bearer paw_demo_key` | 200 | 200，payload 与修复前一致 | ✅ |
| 5a | `GET /api/v1/nodes` 无 key | 401 | 401 | ✅ |
| 5b | `GET /api/v1/nodes` BUYER key | 403 | 403 | ✅ |
| 5c | `GET /api/v1/nodes` OWNER key | 200 | 200 | ✅ |
| 6 | `POST .../probe-nonexistent-9f3a/toggle` 无 key | 401 | 401 | ✅ |
| 7 | 同上，OWNER key | 404 | 404 `节点不存在: probe-nonexistent-9f3a` | ✅ |
| 8 | 验证 7 未产生新行 | 行数不变 | `nodes_history` 2→2；`probe*` 残留 0 行；`node_registry` 20→20 | ✅ |
| 9 | `POST .../apipaw-cloud-sim/toggle` OWNER ×2 | 200，0→1→0 | 200 PAUSED → 200 ACTIVE，`is_paused` 复原为 0 | ✅ |
| 10 | `GET /api/v1/user/usage` `paw_demo_key` | 200 且含 `role` | 200 `{"role":"OWNER", ...}` | ✅ |
| 11 | `GET /api/v1/creator/models` | 200 | 200（创作者链路未受影响） | ✅ |
| 12 | `GET /v1/models` | 200 | 200（推理入口未受影响） | ✅ |
| 13 | `GET /health` | 仍公开 | 200 `{"status":"ok","nodes_online":0}` | ✅ |
| 14 | Pocket e2e `live-console.cjs` | 24/24 | **24/24 通过，0 失败** | ✅ |
| 14b | Console e2e `live-console.cjs` | 24/24 | **24/24 通过，0 失败** | ✅ |
| 15 | `PRAGMA integrity_check` apipaw.db | ok | ok | ✅ |
| 15b | `PRAGMA integrity_check` node_registry.db | ok | ok | ✅ |

**临时 BUYER key**（`paw-sk-<redacted-deleted-test-key>`）仅用于用例 3，**测完已从生产库删除**，
复核后 `users` 表仅剩 `paw_demo_key` 一行（role=OWNER）。

---

## 三、代码改动清单

### `db.py`

| 改动 | 说明 |
|---|---|
| `_ensure_column()` 返回 `bool` | 现有调用方全部忽略返回值，向后兼容；新增的布尔值用于「一次性迁移」判定 |
| `users` 建表 DDL 加 `role` / `owner_wallet` | 默认 `BUYER` / `''` |
| `init_db` 一次性迁移 | **仅在本次真的加了列时**把 `paw_demo_key` 提为 OWNER 并绑定 `owner_wallet`；之后运维可手工改角色，不会被启动流程改回去 |
| `init_db` 补 `_ensure_column(users, created_at)` | 见下方「顺带修复」 |
| 新增 `NodeNotFoundError` | 节点不可操作时抛出 |
| 新增 `node_is_known(node_id)` | 存在性口径：`node_registry ∪ nodes_history` |
| `toggle_node_pause()` 重写 | **只 UPDATE**，绝不 INSERT；节点不存在 → `NodeNotFoundError` → HTTP 404 |

### `server.py`

| 改动 | 说明 |
|---|---|
| 新增 `require_owner(authorization)` | 缺 key/无效 key → 401；有效但非 OWNER → 403 |
| `get_owner_dashboard()` | 接入 `require_owner` |
| `list_nodes()` | 接入 `require_owner` |
| `toggle_node()` | 接入 `require_owner` + 捕获 `db.NodeNotFoundError` → 404 |
| `get_user_usage()` | 响应追加 `role` 字段（向后兼容） |

### 工程卫生

- `.gitignore` 补 `*.bak*` / `backups/` / `*.log`（`*.db` 早已忽略）
- 16 个散落的 `.bak` 归档到 `backups/legacy-bak/`
- `cloud.log` 从版本库跟踪中移除
- `manage_node.py` 纳入版本管理（此前一直是未跟踪状态）

---

## 四、顺带修复（超出原 TODO 范围，但必须做）

**`POST /api/v1/auth/apikey` 自 v1.0.0 起在生产上一直是坏的。**

- 根因：`users` 建表 DDL 里有 `created_at`，但**历史库从未被 `_ensure_column` 补齐过**；
  `create_api_key()` 的 INSERT 带 `created_at` → `sqlite3.OperationalError: table users has no column named created_at`
- 该缺陷**存在于基线 commit `ffd443a`**，与本次改动无关，是摸底时为了造 BUYER key 撞出来的
- 修法：`init_db` 补一行 `_ensure_column(conn, "users", "created_at", "REAL DEFAULT 0")`
- 旧行创建时间用 0 占位（该列目前只写不读，不影响任何业务逻辑）
- 修复后接口正常返回 `{"status":"success","api_key":"paw-sk-...","balance_usd":1.0}`

---

## 五、生产数据保护

| 保护措施 | 状态 |
|---|---|
| 修复前 DB 快照 | `backups/apipaw_20261108-pre-p0.db`、`backups/node_registry_20261108-pre-p0.db` |
| `integrity_check` | 两库修复前后均为 `ok` |
| `users` 行数 | 1（`paw_demo_key`），临时 key 已删 |
| `nodes_history` 行数 | 2（`apipaw-cloud-sim`、`node_default_001`），与修复前一致 |
| `node_registry` 行数 | 20，与修复前一致，无 `probe-nonexistent-*` 残留 |
| 生产库入库 | `*.db` + `backups/` 双保险，均不在版本库 |
| git config | **未修改**，提交身份用 `-c user.name=... -c user.email=...` 单次传参 |
| 远端推送 | **未推送**（远端 URL 内嵌 PAT 且未获授权） |
| nginx / 3X-UI | 本轮完全未触碰 |

---

## 六、回滚方案

| 场景 | 动作 |
|---|---|
| 代码有语法/逻辑错误 | `git checkout 721c485 -- server.py db.py` + `systemctl restart apipaw-cloud.service` |
| 加列后数据异常 | `sqlite3 .backup` 快照已留 → 覆盖恢复 + 重启 |
| 服务起不来 | `systemctl status` + `journalctl` → `git checkout 721c485 -- server.py db.py` → 重启（基线 commit 必然可编译） |

---

## 七、遗留

- **`role` 目前只有 OWNER / BUYER 两档**，TODO-02 提到的 `CREATOR` 档尚未落库；
  现有创作者链路仍走 `creator_wallet` 判定（`require_creator`），未受影响。
- **`is_paused` 仍然装饰品** —— 见 TODO-13：`_select_dispatch_node` 根本不读它，
  「暂停接单」开关在派单侧依然无效。本次只保证了 toggle 端点不再能伪造节点。
- **双库割裂未解决** —— 见 TODO-04/05：`node_registry`(20) 与 `nodes_history`(2) 仍不相交，
  `active_nodes_online` 与 `registered_nodes_total` 口径矛盾。
- **`node_registry` 20 条里 15 条是历史调试探针**（`probe_*`），见 TODO-15。
