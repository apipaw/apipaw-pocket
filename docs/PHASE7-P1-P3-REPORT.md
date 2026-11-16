# 阶段七 P1–P3 交付实录
## 节点模型自动对齐 · 自助挂机 · 三方版税全闭环

> 立项来源：阶段七 P0 验收通过后，用户拍板「立项【阶段七 P1-P3：节点模型自动对齐、自助挂机与三方版税全闭环】」，
> 并要求**全自动执行、不停顿提问**。
>
> 本文是**交付实录**：既写「做了什么」，也写**为什么这么做**与**踩了哪些坑**。

---

## 0. 背景：三个真实痛点

| # | 痛点 | 老办法 | 新办法 |
|---|---|---|---|
| P1 | 节点连上了，云端却显示 `servable_models=0` | 手工跑脚本把模型绑进 `node_registry.meta_json` | 节点**自己上报**模型清单，云端**自动合并** |
| P2 | 给新机器签发节点凭证 | SSH 上服务器敲 `manage_node.py` | 控制台「一键新增算力节点」 |
| P2 | 想让机器全天候接单 | 改 `start.bat` 加 `APIPAW_FORCE_IDLE=1` | 面板勾选「强制待命模式」，保存即生效 |
| P2 | 想指定本机推理模型 | 手改 `agent.config.json` | 面板输入框「本地推理模型」 |

---

## 1. P1：节点模型自动对齐（云端 `server.py`）

### 1.1 方案取舍

| 方案 | 做法 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| A | 心跳/WS 上报 `model_name` 单值 | 改动最小 | 一个节点一个模型；Ollama tag 与对外模型名常不一致 | ❌ 不够用 |
| B | **上报模型清单 + 引擎 tag，云端自动合并** | 多模型可用；老节点零改动；天然覆盖 HTTP/WS 两条通道 | 需定义"没上报"与"上报空"的语义差异 | ✅ **采纳** |
| C | 云端主动探测节点 | 云端最"真" | 要给每个节点开端口、走内网，跨网段不可行 | ❌ 不可行 |

### 1.2 三态语义（关键设计）

节点对"我有什么模型"的回答有三种可能，必须区分，否则会误伤存量节点：

| 节点上报 | 云端判定 | 行为 |
|---|---|---|
| `models: ["a","b"]` | 有模型 | 参与匹配派单 |
| `models: []`（**显式空数组**） | **确认没有推理引擎** | 硬排除（不再承接推理派单） |
| **完全不上报**该字段 | 未知 | **fail-open**（维持老行为，照常接单） |

> ⚠️ 这里的坑：`extra="ignore"` 曾让 `models` 被**静默丢弃** ⇒ 只发 HTTP 心跳的节点永远 `servable_models=0`。
> 现在 `NodeHeartbeatReq` 显式声明 `models` / `backend_model` / `inference_backend`。

### 1.3 双向模型匹配

派单时买家点名的 `model_id` 同时匹配节点的 **`model_name`（对外声明）** 与
**`backend_model`（本地引擎 tag）**，并支持 `MODEL_ALIAS_REVERSE` 反查
（模型名 ↔ 别名双向命中）。

### 1.4 线上证据

生产库 `node_registry.db` 实测（`win_node_01`，Agent v1.0.10）：

```json
{"models": ["qwen2.5:0.5b"], "inference_backend": "ollama"}
```

`win_node_02` 上报 `"models": []` ⇒ 被判定为"确认无引擎"，符合预期。
阶段七 e2e 新签发节点心跳后，注册表里自动出现：

```json
{"models": ["qwen2.5:0.5b"], "models_reported": true,
 "backend_model": "qwen2.5:0.5b", "inference_backend": "ollama"}
```

⇒ **没有任何手工绑模型的脚本**，模型绑定由节点自己声明。

### 1.5 创作者版税（qwen2.5:0.5b）

生产 `models` 行已配置为创作者档：`tier=CREATOR`、`royalty_rate=0.15`、
`royalty_mode=RATE`、`creator_id=creator_demo`、`author_wallet` 已绑。
结算侧 `db.settle_cost_v2` 据此拆三方：节点 0.85×算力、创作者 0.15×版税×0.85、
平台 0.15×算力 + 0.15×版税。

---

## 2. P2：一键签发 + 强制待命

### 2.1 云端自助签发端点

`POST /api/v1/owner/nodes/issue-credential`

- 鉴权：`require_owner`（钱包会话 JWT 或 OWNER 角色 API Key）
- `node_id` 可指定，**留空自动生成** `node_<12位hex>`
- 明文 `node_secret` **只回吐一次**，库内只存哈希
- 滑动窗口限流：600 秒内最多 20 次
- 复用 `manage_node.py` 的合规注册 + 哈希存储逻辑

### 2.2 控制台 UI（Pocket/console）

`NodeGovernanceCard` 新增「新增算力节点」区块：Node ID 输入框（可留空）+
「一键新增」按钮 ⇒ 弹出 `node_id` + 明文 `node_secret`（含复制按钮）。

> 🔧 **本轮修掉的一个真缺陷**：该区块原先被写在
> `loading ? … : error ? … : (节点列表)` 三元表达式**里面** ⇒ 节点列表接口慢或报错时，
> 业主**没法自助签发**，"SSH 手工签发"这个痛点等于又回来了。
> 已把该区块提到加载/错误分支**之外**，签发与列表加载彻底解耦。

### 2.3 Agent 侧（v1.0.11）

- `agent_config`：新增持久化配置项 `force_idle`（默认 False）
- `yield_monitor.is_force_idle_enabled()`：
  `APIPAW_FORCE_IDLE=1` **或** 配置 `force_idle=true` ⇒ 强制 IDLE；
  配置读取异常**一律回落为"不强制"**（绝不因配置问题让节点起不来）
- `main.py`：新增 `POST /api/prefs`（保存 `backend_model` / `force_idle`，
  **即刻生效**：换模型会重置推理后端缓存，省略重启）
- `web_ui.py`：面板新增「运行偏好」区（本地推理模型输入 + 强制待命勾选）
- `telemetry` / `ws_tunnel`：心跳与 WS 帧上报 `models` / `backend_model`

---

## 3. 验收

### 3.1 沙箱

| 套件 | 结果 |
|---|---|
| `smoke_p7_p1_p3_sandbox.py`（源站 venv 实跑） | **9/9 通过** |
| `test_phase7_p2_prefs.py`（Agent） | **10/10 通过** |
| 阶段五/六/P7-P0 回归套件 | 全绿 |
| `check_credit_paths.py`（生产） | **exit 0** |
| `audit_report.py`（生产） | **总判定 OK**，`NET == BAL == 1026.022962`，差异账户数 0 |

### 3.2 线上控制台 e2e（`e2e/phase7-p1.cjs`）

```
PASS ① 应用挂载（console.apipaw.com 首屏渲染完成）
PASS ② 节点治理标签可见
PASS ③ 「新增算力节点」区块对 OWNER 可见
PASS ③b 节点 ID 输入框存在
PASS ④ 「一键新增」按钮存在
PASS ④ 一键新增弹出凭证（node_id + 明文 node_secret）
PASS ⑤a 签发的凭证可用于节点心跳鉴权（Bearer = node_secret）
PASS ⑤b 心跳注册后节点出现在治理列表
结果: 8/8 通过
```

### 3.3 残留清痕（红线：生产必须回到验收前基线）

本次线上验收在生产留下了这些东西，**已全部删除**并复核对账：
节点注册表 1 行 + 节点凭证 2 枚、临时 OWNER API Key 1 把、
`auth_sessions` 2 行 / `auth_wallets` 1 行 / `auth_nonces` 2 行。
清理后 `audit_report.py` 仍是 `NET == BAL == 1026.022962`、总判定 OK。

---

## 4. 坑（本次新增）

1. **鉴权只有 API Key 是不够的** —— `NodeGovernanceCard` 整体挂在 `sessionToken` 上，
   没有钱包会话只显示「请先连接钱包」。前端 `sessionRole` **只**来自钱包会话，
   绝不从 API Key 推导 ⇒ 线上验收必须先取**真会话**（`e2e/owner-session.js` 走真实
   nonce→签名→verify）。
2. **Chromium 必须 `--disable-ipv6`** —— 本机 IPv6 优先路由到 Cloudflare 会
   `ERR_TIMED_OUT`，而 curl 会回落 IPv4 所以看不出问题。
3. **首屏空 root 别误判成回归** —— 1.4MB bundle 偶发拉不下来，表现为 `root` 一直空；
   e2e 要做「最多 3 次重挂载」再判定。
4. **`AgentConfig` 是单例** —— 测试里 `AgentConfig(config_path=...)` 会被单例吞掉，
   仍然指向**用户真实的 `agent.config.json`** ⇒ 测试会改写用户线上配置。
   正确做法是 `object.__new__` 绕过单例 + 换掉模块级 `_config_instance`。
5. **治理列表只装"已注册"的节点** —— 刚签发的凭证还没心跳，本来就不该出现在列表里；
   e2e 断言 ⑤ 因此拆成「⑤a 凭证可用于心跳鉴权」+「⑤b 心跳后列表可见」。
6. **`ws_tunnel` 建帧取配置字段要用 `getattr`** —— 直接 `self._cfg.model_name`
   会让使用精简配置桩的测试（和任何缺字段配置）直接炸掉。

---

## 5. 交付物

| 仓库 | 提交 | 内容 |
|---|---|---|
| APIPawCloud | `1eadd8e` | P1 自动对齐 + P2 签发端点 + 沙箱冒烟 + 生产探针 |
| APIPawPocket | 本次提交 | 一键新增算力节点 UI + e2e 验收脚本 + 本文档 |
| APIPawAgent | `31f82b1` / tag `v1.0.11` | 模型上报 + 强制待命 + 面板运行偏好 + P2 自检 |
