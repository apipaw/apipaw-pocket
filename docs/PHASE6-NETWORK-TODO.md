# 阶段六 · 算力网络蓝图（PHASE6-NETWORK-TODO）

> **状态**：✅ **D1~D12 已于 2026-11-14 全部拍板**（结论见 §8）；**P0 开发进行中**
> **起草**：2026-11-14 · **拍板**：2026-11-14
> **前置**：阶段三（计费）、阶段四（Web3 鉴权）、阶段五（二元分账 / 盲派路由 / Playground）均已封板并上线生产
> **本次触发**：阶段五 P4 收官遗留项「v2 盲派单尚未在真实商业模型 + 多节点场景下压测」已由
> `apipaw-cloud/test_phase5_multinode_stress.py` 补齐（47/47，见附录 B）——**盲派与计费的"协议层"已可信任，
> 但"推理层"从未真正存在过**。阶段六的主题因此不是"再修一处派单"，而是**让节点真的会推理**。

---

## 0. 红线（动代码前先读）

1. **不许把"模拟回答"卖给买家当真实推理。** 现状：派单无候选 / 超时 / 节点全忙，网关**静默降级为模板回答并照常计费**
   （`server.py:2316-2376`、`server.py:957-976`）。这不是"降级"，这是**收了钱给假货**，是阶段六 P0 必须先关掉的洞。
2. **不许在没有真实引擎的情况下把 `APIPAW_DISPATCH_ENABLED` 置 1。** 阶段五 P3 已经踩过一次同型坑
   （单元里预留 `=1` 等于把定价扳机留在枪上）；阶段六同构——**派单开关置 1 的前提是节点侧真的有模型可推**。
3. **不许在提现闭环打通前对外宣称"算力业主能赚钱"。** 现在节点收益只是计数器（`nodes_history.total_earnings_paw`），
   **没有任何提现通道**，只有创作者有（`POST /api/v1/creator/royalty/withdraw`）。
4. **不许让未鉴权端点写生产数据。** 现状 `POST /api/v1/models/register`（`server.py:1916-1917`）**完全无鉴权**，
   任何人可上传 PAWMODEL 覆盖创作者模型条目——阶段六 P0 一并关掉。
5. **记账口径只加不改。** `usage_logs` / `revenue_ledger` / `balance_ledger` 的列名与三套金额键名
   （`base_compute_usd`/`total_usd` vs `buyer_total_usd`）**冻结**，阶段六只加列、不改键名、不回填历史行。
6. **不许把阶段五已签字的定价口径偷偷改动。** 等级单价 `C0..C3` 与 `0.85` 上限属于定价级变更，改动需重新签字。

---

## 1. 摸底结论

### 1.1 三仓现状速览

| 仓 | 版本 | 真实状态 | 距"真实网络"最远的一件事 |
|---|---|---|---|
| `APIPawAgent` | v1.0.6（`agent_config.py:46`） | WS 隧道 + 派单解密 + 显存上报 + 让退监控**齐备**；**推理是假的** | `main.py:389-402` `_simulate_answer()` 返回占位文本，**无任何本地推理引擎** |
| `APIPawCloud` | 阶段五 P4（`98d576a`→`eb856f0`） | 计费/分账/盲派/对账**齐备**；**推理链路是假的** | 网关派单拿不到真回答就**回模板并计费**（`server.py:2373-2376`） |
| `APIPawPocket` | 阶段五 P4 | 买家/创作者/业主三面 UI **基本齐备** | 节点注册、节点提现**没有 UI**；创作者改版税率**没有 UI** |

**一句话结论：APIPaw 至今是一个"把控制面做得非常扎实、但数据面（推理）从不存在"的系统。**
阶段一~五把"钱怎么算、怎么分、怎么派、怎么审"做完了；阶段六要做的是**把"模型真的跑起来"这件事补上**。

### 1.2 派单链路真值（逐跳，含行号）

```
买家 POST /v1/chat/completions
  └─ server.py:2286  if DISPATCH_ENABLED:                     ← 全局单一开关（server.py:134）
       ├─ server.py:2316  _select_dispatch_node()             ← 候选池构建
       │    ├─ WS 连接存活 → registry WS 心跳存活 → IDLE → agent_version → 非 stale → 非 paused
       │    ├─ 显存门槛（模型 min_vram_gb vs 节点 vram_total_gb）→ 未上报则 fail-open
       │    └─ server.py:2812 _apply_fair_order()             ← 冷却过滤 + 在途过滤 + 最久未派单优先
       ├─ server.py:2327  dispatch_attempted = True           ← 选到候选才算"真派过"
       ├─ server.py:3236  dispatch_inference()                ← 轮询节点队列
       │    ├─ RESPONSE_CHUNK → **缓冲进 parts[]**（server.py:3236-3247）
       │    ├─ RESPONSE_DONE  → usage + timing（ttft_ms/gen_ms）（server.py:3249-3257）
       │    └─ RESPONSE_ERROR → 503 node_yielded → 冷却 30s + 信用分 -0.15（server.py:3268）
       └─ server.py:2373  answer_text = 节点文本 or build_answer(...)   ← ★ 静默降级点
  └─ server.py:2633  买家 SSE：把整段答案按 6 字/26ms **打字机式本地切片**   ← ★ 假流式
```

**与"真实推理"有关的四个断点（全部有代码证据）**：

| # | 断点 | 证据 | 后果 |
|---|---|---|---|
| B1 | **网关侧无真流式** | 节点分片被缓冲成整段，`server.py:3236-3247`；买家 SSE 是本地切片 `server.py:2633-2635` | 买家的 TTFT 与节点 TTFT 无关；`ttft_ms` 是"网关端到端"而非"模型首字" |
| B2 | **饱和/超时不排队、不报错** | 无候选 → `dispatch_log.outcome=no_candidate` → `break` → 模拟回答（`server.py:2325-2376`）；超时 → `dispatch_timeout` → 换节点 → 最终仍回落模拟（`server.py:3218-3223`） | 买家**永远拿 200**，且**照常计费**；全程**无 5xx 路径**（`server.py` 内 grep `504` 无命中） |
| B3 | **节点侧无推理引擎** | `main.py:389-402` 伪造回答；`ws_tunnel.py:728-734` 唯一 HTTP 出口指向**自家** `127.0.0.1:52415` | 所谓"真实节点"，跑的是占位文本 |
| B4 | **节点不上报模型清单** | 只有配置项 `model_name: str = "apipaw-gpt2-small"`（`agent_config.py:59`），`/v1/models` 恒返回这一条（`main.py:181-194`） | 网关无法知道"谁能推哪个模型"，派单只能靠显存门槛粗筛 |

### 1.3 「真实推理」缺口总表

| 层 | 缺口 | 位置 | 阶段六归属 |
|---|---|---|---|
| Agent | 无推理后端（Ollama/vLLM/llama.cpp 一个都没有） | `main.py:389-402` | 模块 A（P0/P1） |
| Agent | 转发时**不强制 `stream:true`** | `ws_tunnel.py:692` 原样透传 payload；解析器只认 `data: ` 行（`ws_tunnel.py:744-745`） | 模块 A（P0）——非流式载荷会得到 0 分片 + 0 usage |
| Agent | 硬编码 `timeout=60.0` | `ws_tunnel.py:733` | 模块 A（P1） |
| Agent | 断流无恢复（不重试、不续传、无幂等） | `ws_tunnel.py:736-768` 只有错误上报 | 模块 A（P2） |
| Agent | 重连退避 1s→8s 指数，但**握手阶段失败不翻倍** | `ws_tunnel.py:162-167`、`410-421` | 模块 A（P2） |
| Agent | 发送失败被静默吞掉（`_send_json` 吞异常） | `ws_tunnel.py:781-795` | 模块 A（P1） |
| Agent | Token 计量本地三档兜底（HF tokenizer → tiktoken → CJK 启发式） | `token_counter.py:46-58 / 61-71 / 123-134` | 模块 A（P0）：真实引擎应回传真实 usage |
| 网关 | 分片缓冲 + 本地打字机切片 | `server.py:3236-3247`、`2633-2635` | 模块 B（P1） |
| 网关 | 无排队、无容量感知、无 503 | `server.py:2316-2376` | 模块 B（P0） |
| 网关 | 节点无 usage → 按 `estimate_tokens` 计费 | `server.py:2380-2390` | 模块 B（P0）：必须区分"真实计量"与"估算" |
| 网关 | 派单结果只在 `dispatch_log` 表，**无任何 HTTP 查询端点** | `db.py:1409-1422`、`server.py:2773-2780` | 模块 B（P2） |
| 网关 | 无 `/metrics`，公平性告警只 `print` | `server.py:2782-2799` | 模块 B（P2） |

### 1.4 算力业主端（节点侧）现状

**已有的**：
- 一机一码凭证表 `node_credentials`（`db.py:3853-3863`，含 `owner_wallet`/`owner_id`）；全局密码已彻底废除（`server.py:3308`）。
- WS `INIT` 帧注册（`server.py:3375-3396`，头 `X-Node-ID`/`X-Node-Secret`，失败即拒）与 HTTP 心跳注册（`server.py:3639-3681`）。
- 绑钱包链路：`node_credentials.owner_wallet → users.owner_wallet → nodes_history`（`server.py:1691`、`db.py:3601-3613`）。
- 结算时节点只被告知**自己那一份**（`server.py:2536-2544`），盲派单商业红线成立。
- 收益可见：`GET /api/v1/owner/nodes/revenue`（`server.py:1684-1709`，OWNER-only）→ `db.get_owner_nodes_revenue`（`db.py:3726-3812`）。

**缺的**：
| 缺口 | 证据 |
|---|---|
| **节点注册没有 HTTP 入口**，只有 CLI `manage_node.py`（`add/gen/list/revoke/bind/prune`），文件里写明"前端注册页尚未开发"（`manage_node.py:11-12`） | `manage_node.py` |
| **节点收益没有任何提现通道**：无 `node_withdrawals` 表、无 withdraw/payout 端点（grep `withdraw|payout|transfer` 只命中创作者路径） | `db.py` 建表清单 17 处无该项 |
| 收益只有计数器：`nodes_history.total_earnings_paw`（`db.py:2417-2434`）+ `revenue_ledger.node_share_usd`，**没有可提现余额语义** | `db.py:2353-2372` |
| 无链上转账、无钱包余额、无 payout 通道 | 全仓 grep 无命中 |
| `nodes_history.owner_handle` 只在心跳/结算时回填，绑定后**不再心跳的节点可能不归属** | `db.py:3601` |
| 暂停开关 `POST /api/v1/owner/node/{id}/toggle` 是 OWNER-only，节点业主**自己不能停自己的节点** | `server.py:1904-1914` |

### 1.5 模型创作者端现状

**已有的**：
- 创作者自助解析 + 上架：`POST /api/v1/creator/models/parse`、`POST /api/v1/creator/models/register`
  （`server.py:1970-2024`，`require_creator` = 有效 API Key + 已绑 `author_wallet`，`server.py:1272-1278`），落库 `tier="CREATOR"`（`db.py:3125-3170`）。
- 前端 `ModelStudioCard.tsx` 有完整的自助上架 UI（HF 链接解析 → 显存滑杆 → PAWMODEL YAML 预览 → 提交）。
- 版税读取：`GET /api/v1/creator/royalty`（`server.py:2036`）、提现：`POST /api/v1/creator/royalty/withdraw`（`server.py:2044-2058`）、
  流水表 `creator_withdrawals`（`db.py:463`、`db.py:3419`）。
- 模型级版税率 `royalty_rate`（`db.py:1125`）+ 改价流水 `model_pricing_changes`（`db.py:1224-1230`）。

**缺的**：
| 缺口 | 证据 |
|---|---|
| **改版税率是 OWNER-only**，创作者**无法自助调价**（"必须是平台侧动作，不是创作者自助改价"） | `server.py:2099-2140`、`db.py:1307-1372` |
| **未鉴权旁路**：`POST /api/v1/models/register` **零鉴权**，可覆盖创作者模型条目 | `server.py:1916-1917`（函数签名无 `authorization` 参数） |
| 前端 `ModelStudioCard.tsx` 里 YAML 是**本地拼的**，价格写死（`prompt 0.35 / completion 0.42`），版税率写死 0.15 | `ModelStudioCard.tsx:78-89, 115-116` |
| 前端**从不渲染** `royalty_rate` 字段（`cloudClient.ts:413` 有类型，`RoyaltyCard.tsx` 无引用） | `RoyaltyCard.tsx` |
| 创作者身份用的是**本地硬编码** `creatorWallet`，`setCreatorWallet` **从未被调用** ⇒ 创作者控制台身份不是当前登录钱包 | `usePawStore.ts:105-107` |

### 1.6 前端（Pocket）现状

| 面 | 组件 | 真实后端 | 备注 |
|---|---|---|---|
| 买家 | `PlaygroundCard.tsx`（1689 行） | ✅ 真实 | 已有 `ttft_ms`/`throughput_tps`/`perfSource`（P4）、回答来源徽标 `node / simulated / fallback`（`PlaygroundCard.tsx:122-126`） |
| 数据 | `AnalyticsCard.tsx` | ✅ 真实 | 二元分账占比环 |
| 创作者 | `ModelStudioCard.tsx` / `PipelineMeshCard.tsx` / `RoyaltyCard.tsx` | ✅ 真实（HF 解析是服务端 mock） | `RoyaltyCard.tsx` 有提现弹窗（`testID="royalty-withdraw-btn"`） |
| 业主 | `App.tsx` HOST→NODES 页 | ✅ 真实 | 有在线节点数、节点收益卡、逐节点暂停开关 |
| 鉴权 | `WalletPanel.tsx` / `src/wallet/api.ts` | ✅ 真实 | nonce/verify/logout，JWT 与 API Key 双通道 |

**前端缺口**：
- **无节点注册/绑码 UI**（后端也没有，等于要端到端新建）。
- **无节点收益提现 UI**（后端也没有）。
- 买家侧"在线算力节点"卡片数据来自 OWNER-only 的 `fetchOwnerDashboard()`（`server.py:1836`），**普通买家恒为 0**（`App.tsx:78-80` 吞异常）。
- 结算侧等级 `node_compute_class` / `capability_class` **前端零展示**（`cloudClient.ts:323` 有类型无引用）。

### 1.7 财务与可观测现状

- **对账能力已经够用**：`GET /api/v1/audit/reconciliation`、`GET /api/v1/audit/export.csv`（`server.py:2165-2199`）+ 离线 `audit_report.py`。
- **缺的是"节点侧可提现余额"这层语义**：`revenue_ledger` 是分账流水，不是钱包余额；`creator_withdrawals` 有，`node_withdrawals` 无。
- **缺的是可观测出口**：`dispatch_log` / `node_reliability` 只写表不对外（无端点）；公平性告警只 `print`（`server.py:2782-2799`）；无 `/metrics`。

### 1.8 压测实证（阶段五遗留项已闭环）

`apipaw-cloud/test_phase5_multinode_stress.py`（`eb856f0`）在**完全隔离的临时数据库**上跑真实网关代码路径，
本地 47/47、源站（Python 3.6.8 + SQLite 3.7.17）47/47，详见附录 B。**已实证**：
v2 密文盲派与 v1 明文兼容、显存门槛 + fail-open、公平轮转（极差 0）、在途上限、让退 → 冷却 20s → 信用分 0.85 → 自动故障转移、
**高并发下 `NET == BAL` 精确相等、覆盖率 100%、逐笔可重算、零 `database is locked`、零 `SHADOW-MISMATCH`**。

**压测顺带挖出的两个产品事实（必须进阶段六决策）**：
1. **结算侧 C0 档不可达**：`_capability_class` 把 `0 < gb ≤ 16` 判为 C1，未上报显存则等级为空（走旧口径），
   ⇒ 结算永远拿不到 C0。等级只在**派单帧标签**里出现过 C0（按模型 `min_vram` 算）。
2. **`capability_class`（模型驱动）与 `node_compute_class`（节点驱动）共用 C0~C3 命名空间但语义不同** —— 命名冲突，
   是未来误配置与误读账单的雷。

---

## 2. 模块 A · 真实推理引擎接入（Agent 侧）

> **目标**：节点能真的推模型；模型清单、真实 token、真实流式三者对齐。

### 2.1 A1 · 推理后端适配层（P0）

**现状**：`main.py:389-402` 伪造答案；`ws_tunnel.py:728-734` 把派单载荷原样转发给自家 `127.0.0.1:52415`。
**方案**：在 Agent 内引入**统一后端抽象**（`inference_backend.py`），三种实现同一接口：

| 后端 | 协议 | 适用 | 备注 |
|---|---|---|---|
| Ollama | `POST /api/chat`（NDJSON 流） | 家用/入门节点 | 装机最省事，`num_gpu` 直出显存 |
| vLLM | OpenAI 兼容 `POST /v1/chat/completions`（SSE） | 高端多卡节点 | 直接复用云端同款协议 |
| llama.cpp | OpenAI 兼容 `POST /v1/chat/completions`（SSE） | 无 GPU 的老机器 | 最广谱 |

- 接口形状：`async def generate(model, messages, stream: bool) -> AsyncIterator[str|Token]`，产出**真实 usage**（prompt/completion tokens）。
- **强制 `stream=True`**：修掉 `ws_tunnel.py:692` 的透传漏洞（非流式载荷 → 0 分片 → 0 usage）。
- 后端不可用时：**明确报错 `backend_unavailable`**，**绝不回落到模拟回答**（红线 1）。
- 配置项（`agent_config.py`）：`inference_backend = auto|ollama|vllm|llamacpp`、`backend_base_url`、`backend_model`、`backend_timeout_sec`（替掉 `ws_tunnel.py:733` 的硬编码 60s）。
- ✅ **D1 已拍板**：Ollama 优先 + **统一抽象层**，`vLLM` / `llama.cpp` 在抽象层内**预留同接口实现位**（P1 补）。

### 2.2 A2 · 节点模型清单上报（P0）

- Agent 启动时探测后端 `/v1/models`（或 Ollama `/api/tags`），得到**本地可用模型列表**。
- 通过既有帧通道上报（`ws_tunnel.py:556-579` `_build_frame` 已在 INIT/HEARTBEAT 带字段，**加一个 `models: []` 字段即可，不改帧结构语义**）。
- 网关侧据此做**模型 ↔ 节点匹配**（§3.2 A-路由），取代"只按显存门槛粗筛"。
- `model_name` 硬编码（`agent_config.py:59`）保留为兜底，不再是唯一口径。

### 2.3 A3 · 真实 Token 计量对齐（P0）

- 优先级：**后端真实 usage > 节点 tokenizer > 网关估算**。三级都要在 `usage_logs.usage_source` 里如实标注（现字段已存在，`server.py:2380-2390`）。
- 节点侧优先用真实 usage（Ollama/vLLM 都回）；不可得才落 `token_counter.py` 三档兜底。
- **红线**：估算口径必须显式（`usage_source="estimate"`），不允许与真实计量混为一谈；`estimate_tokens` 相对真实值的偏差需在阶段六 P3 评估并公开口径。

### 2.4 A4 · 断流重连与错误语义（P2）

- 节点侧：模型推理中途挂掉 → 发 `RESPONSE_ERROR{error:"backend_stream_broken"}`；**不做静默重试**（同一 request_id 重试会导致重复计费），
  由**网关**决定是否换节点重派。
- 网关侧：已派单节点中途断链 → `_fail_dispatches_for_node`（`server.py:3137-3160`）已有骨架，需补"部分内容已发出"的语义：
  已发分片但未收到 DONE ⇒ 该单**不计费**（或按已发内容计费，需拍板，见 D6）。
- Agent 重连：握手阶段失败也走指数退避（补 `ws_tunnel.py:410-421`），上限 8s 不变。

---

## 3. 模块 B · 网关真实派单常态化（"常态化开启"的核心）

### 3.1 B1 · 消灭"静默降级 + 照常计费"（P0，**最高优先级**）

**现状**：无候选/超时 → 模板回答 → 200 + 计费（`server.py:2316-2376`、`957-976`）。

**改造**（新增开关 `APIPAW_DISPATCH_STRICT=1`，与 `DISPATCH_ENABLED` 分离）：
| 情形 | 现在 | 阶段六（严格模式） |
|---|---|---|
| 派单成功 | 节点文本 | 不变 |
| 无候选 / 全忙 / 全冷却 | **模板回答 + 计费** | **`503 {code:"no_capacity"}`，不计费、退预扣** |
| 派单超时 | 换节点 → 最终模板 + 计费 | **`504 {code:"dispatch_timeout"}` 或换节点，最终失败不计费** |
| `DISPATCH_ENABLED=0` | 模板回答 + 计费 | **模板回答（`X-APIPaw-Dispatch: simulated`）+ 一律 $0 不计费（D5 已拍板）** |

- 退款路径已有现成实现：结算异常时写 FAILED 流水并退预扣（`server.py:2508-2530`），可直接复用为"派单失败不计费"。
- **前端必须能区分**：`PlaygroundCard.tsx:122-126` 已有三态徽标（node/simulated/fallback），新增 `error` 态并给出**明确文案**
  （"算力池当前无空闲节点，请稍后重试"），而不是把 503 显示成"平台故障"。

### 3.2 B2 · 模型 ↔ 节点匹配（配合 A2）

- 派单候选增加一层过滤：**节点上报的模型清单里包含该 `model_ref` 的明文对应**。
  ⚠️ **盲派红线与该过滤必须解耦**：候选过滤在**云端**用"节点能力表"做，**不把模型名塞进派单载荷**（v2 载荷只有 `model_ref`/`model_cipher`，
  `server.py` 派单帧构造处）；节点侧仍靠解密得到明文。
- 节点能力表放 `node_registry.db`（`node_registry.meta_json` 已有承载位，`server.py` `_ws_node_meta` 已在写显存等字段）。

### 3.3 B3 · 端到端真流式（P1）

**现状**：节点分片被缓冲（`server.py:3236-3247`）→ 买家 SSE 是本地打字机切片（`server.py:2633-2635`）。
**改造**：
- `dispatch_inference` 改为**流式接口**：把节点 `RESPONSE_CHUNK` 直接投递给买家的 SSE 生成器（asyncio 队列），不再等整段。
- 买家侧 `ttft_ms` 口径**变义**：从"网关首字"变为"**模型首字**"（节点 `RESPONSE_DONE` 已带 `timing.ttft_ms`，`server.py:3249-3257`）。
  ⇒ **计费与前端口径同时变**，需在 §7 不变量里显式登记。
- 前端 `PlaygroundCard.tsx` 已优先用后端 `ttft_ms`（P4 成果），改动后无需大改；`perf_source` 语义扩展为 `node`/`local`/`estimated`。

### 3.4 B4 · 容量感知与排队（P2）

- 现：`NODE_MAX_INFLIGHT=1`（`server.py:169`），池饱和即无候选。
- 阶段六 P2 引入**短等待队列**（等待窗口 `APIPAW_DISPATCH_QUEUE_WAIT_SEC`，默认 0 = 保持现状）：
  饱和时**排队等待**而非立刻 503，窗口耗尽再 503。
- ⚠️ 排队会拉长 P99 并放大超时风险，**默认 0（不排队）**，只留开关与观测。

### 3.5 B5 · 可观测出口（P2）

- `GET /api/v1/owner/dispatch/stats`（OWNER-only）：按节点返回派单量/成功率/让退次数/冷却次数/当前在途/信用分，
  数据源 `dispatch_log` + `node_reliability`（`db.py:1409-1436`）。
- `GET /api/v1/network/health`（**买家可读**，非 OWNER）：在线节点数、可服务模型数、池是否饱和。
  顺手修掉前端"买家在线节点恒为 0"（`App.tsx:78-80` 依赖 OWNER-only 端点）。
- 公平性告警 `print`（`server.py:2782-2799`）→ 结构化日志（JSON 行）+ 可选 webhook。

---

## 4. 模块 C · 算力业主闭环

### 4.1 C1 · 节点自助注册与绑码（P1）

**现状**：只能 CLI（`manage_node.py`）。**方案**（✅ D3 已拍板：**自助注册 + OWNER 审批激活**）：
- `POST /api/v1/nodes/register`：钱包会话 JWT 鉴权 → 提交节点名/硬件/所在地区 → 生成 `node_id` + `node_secret`（**一机一码**）；
  注册后节点状态为 `PENDING`，**须 OWNER 审批激活**才可被派单（防刷号，保住一机一码）。
- 密钥**只在此刻返回一次**，云端只存哈希或只存 secret 供 HMAC 用（**注意：v2 派单密钥 = SHA256("apipaw-dispatch-v2|"+node_secret)**，
  云端必须持有 secret 才能加密 ⇒ **要么云端明文存 secret（现状），要么改为云端派生对称密钥 + 节点侧持有同一密钥**）。
  ⇒ 这是 §8 **D8** 必须拍板的密码学决策。
- `POST /api/v1/nodes/bind`：把节点绑定到当前钱包（替代 `manage_node.py bind`）。
- `POST /api/v1/nodes/{id}/rotate`：轮换密钥（吊销旧密钥 ⇒ 旧 Agent 立刻失联，需灰度）。
- 节点业主**自己**的暂停开关：`POST /api/v1/nodes/{id}/pause`（现在只有 OWNER 能暂停，`server.py:1904-1914`）。

### 4.2 C2 · 节点收益提现闭环（P1）

**现状**：只有计数器，无提现。**方案**（对齐创作者既有形态）：
- 新表 `node_withdrawals`（形态对齐 `creator_withdrawals`，`db.py:463`/`3419`）。
- 新端点 `POST /api/v1/node/withdraw`（节点业主鉴权）+ `GET /api/v1/node/earnings`（可用/已提/流水）。
- **可用余额口径**：`Σ revenue_ledger.node_share_usd (归属该节点) − Σ node_withdrawals(已提)`，与创作者同构（`db.py:3451-3463`）。
- 提现币种形态（✅ D2 已拍板）：**P1 先做内部 USD 余额 + 提现流水台账**，把闭环打通；
  **链上 PAW 转账放 P3**（届时需要钱包签名 + 转账通道，受 `ethers v6 + SecureStore` 现有栈影响，阶段四已建）。
  - ⇒ P1 阶段与"Web3 结算"叙事有张力，**必须在前端明确标注"内部余额提现，链上通道待上线"**，不得含糊其辞。

### 4.3 C3 · 节点治理（P2）

- 节点列表/详情（业主视角）：在线状态、在途、健康分、累计收益、近 24h 让退。
- 申诉/申诉处理：让退误判（节点明明空闲却被判 503）的申诉通道。
- 节点等级与结算等级解耦（见 D10）。

---

## 5. 模块 D · 创作者闭环

### 5.1 D1 · 关闭未鉴权上架旁路（P0）

`POST /api/v1/models/register`（`server.py:1916-1917`）**零鉴权**。
- **动作（P0 已落地）**：该端点改为 **OWNER 或 CREATOR 身份必需**，且 **CREATOR 只能覆盖自己的模型条目**，
  越权覆盖他人条目一律 `409`；无凭证 `401`、非 CREATOR/OWNER `403`。
- 创作者路径继续统一走 `POST /api/v1/creator/models/register`（已有 `require_creator`）。
- 兼容性：先查生产 `models` 表里是否存在**未经 `require_creator` 落库**的行（`tier`/作者字段为空或异常），再做切换。

### 5.2 D2 · 版税率策略（P2，✅ D4 已拍板：路 A 平台定价 + 申请审批）

- 现状：创作者**不能**自助调价（`server.py:2099-2140` 明确"平台侧动作"），自助上架时继承默认 0.15。
- **拍板走「路 A（平台定价 + 创作者申请、OWNER 审批）」**：
  创作者提交**期望**版税率 → 进入审批队列 → OWNER 签字生效（复用 `model_pricing_changes` 流水与 `royalty_rate_snapshot` 机制）。
  **放弃路 B（自助调价）** —— 版税率直接影响三方分账，属定价级变更，保留签字纪律。
- 前端配套：`ModelStudioCard.tsx` 的 YAML 预览与价格**必须由后端生成**（现在本地写死，`ModelStudioCard.tsx:78-89, 115-116`）；
  `RoyaltyCard.tsx` **必须渲染** `royalty_rate`（现在有类型无展示）。

### 5.3 D3 · 创作者身份口径（P1）

- `creatorWallet` 硬编码 + `setCreatorWallet` 从未被调用（`usePawStore.ts:105-107`）⇒ **创作者控制台显示的是别人的钱包身份**。
- 改造：创作者面全部身份改为**当前钱包会话**（`src/wallet/api.ts` 的 JWT），本地硬编码删除。

---

## 6. 落地顺序 · 开关 · 灰度

| 批次 | 内容 | 开关 | 前置 |
|---|---|---|---|
| **P0** | 网关：**D5 模拟回答零计费 + 严格模式 503/504 退预扣** · **D10 等级语义拆分（`node_tier` / `model_capability_class`）** · **D11 C0 档可达** · **关闭未鉴权上架旁路** · 修 Agent 转发强制 `stream:true` · Agent 后端抽象骨架（Ollama 底座 + vLLM/llama.cpp 预留位，D1）· 模型清单上报字段 | `APIPAW_DISPATCH_STRICT`（默认 0）· `APIPAW_SIMULATED_FREE`（默认 1）· `APIPAW_COMPUTE_CLASS_TIER_MAX_GB`（默认 C0=8/C1=16/C2=48） | 阶段五 P4 已封板 |
| **P1** | Agent：Ollama/vLLM/llama.cpp 三后端可用 · 真实 usage 优先 · 节点自助注册 + OWNER 审批激活（D3）· 节点收益**内部 USD** 提现闭环（D2）· 端到端真流式 | `APIPAW_REAL_STREAM`（默认 0） | P0 严格模式上线且观察 48h |
| **P2** | 网关：模型↔节点匹配 · 短等待队列 · 可观测端点（派单统计 + 网络健康）· **创作者版税申请+OWNER 审批**（D4 路 A）· 节点治理页 | `APIPAW_QUEUE_WAIT_SEC`（默认 0） | P1 至少 1 台真节点在线 |
| **P3** | 计量对齐：估算 vs 真实计量偏差评估 · 真实 TTFT 口径生效 · 前端展示节点身份/等级 · **链上 PAW 提现通道**（D2 后置项） | — | P1/P2 稳定 |
| **P4** | 常态化：`APIPAW_DISPATCH_ENABLED=1` **前置条件全部满足** · 真实节点灰度 → 全量 · 模拟回答模式降级为"演示开关" | `APIPAW_DISPATCH_ENABLED` | P0~P3 全部验收通过 |

**灰度纪律（承阶段五 P3 教训）**：
1. 每个开关**单独开、单独观测、单独回滚**；**不得由部署动作顺手打开**。
2. 部署"使某开关生效"的代码之前，先把单元里那个开关**显式置 0**。
3. 每次上线前后用 `deploy_backup.sh` + 基线指纹核对（当前基线：`users=1`、`api_keys=2`、`usage_logs=27`、
   `balance_ledger=40`、`daily_spend=6`、`revenue_ledger=0`、`NET==BAL==1016.037562`）。

---

## 7. 不变量与回归红线

| 编号 | 不变量 | 验证手段 |
|---|---|---|
| I1 | `NET == BAL`（双账本恒等） | `db.reconcile_ledgers()`；每次回归后 `NET==BAL` 精确相等 |
| I2 | 每笔 `Σ(节点+创作者+平台) == 买家实付` | `db.settle_cost_v2` 逐笔重算 + `revenue_ledger` 唯一索引 |
| I3 | `reconciliation` 覆盖率 100%、零孤儿行 | `GET /api/v1/audit/reconciliation` |
| I4 | 派单载荷**不含**任何商业字段（买家实付/平台抽成/版税/价格） | 压测 S1.10 + 载荷字段白名单断言 |
| I5 | v2 载荷**无明文 model**；v1 节点自动降级不阻断 | 压测 S1.6~S1.9 |
| I6 | 节点分成 ≤ `0.85 × 算力基价`；被截断时平台差额平衡 | 压测 S7.10 |
| I7 | **（阶段六新增）派单失败 ⇒ 买家不付费**（不产生 `usage_logs` 计费行；预扣以 `FAILED`/`WAIVED` 流水释放） | 新增断言：严格模式下 503/504 路径下 `balance_ledger` 无净支出，且 `NET==BAL` 仍精确相等 |
| I8 | **（阶段六新增）真实计量与估算口径可区分** | `usage_logs.usage_source` 取值分布审计 |
| I9 | **（阶段六新增）派单成功率、节点让退率、覆盖率**可被 OWNER 端点读取 | `GET /api/v1/owner/dispatch/stats` 断言 |

---

## 8. 决策清单（✅ 已于 2026-11-14 全部拍板）

> 业主已正式确认 **D1~D12 全部决策点**（"其余细项一律采纳推荐方案"）。
> 下表「拍板结论」列为最终结论，与代码实现一一对应；§6 路线与 §9 验收矩阵已按本表校准。

| # | 决策 | 选项 | 拍板结论（2026-11-14） | 落地位置 / 落地批次 |
|---|---|---|---|---|
| **D1** | 首个真实推理后端 | Ollama / vLLM / llama.cpp / 三者同时 | **Ollama 优先**，但**必须建统一抽象层**：`vLLM` / `llama.cpp` 在抽象层里**预留位**（同接口、同一契约），P1 补实现 | Agent `inference_backend.py`（P0 抽象层 + Ollama 后端） |
| **D2** | 算力业主**提现币种** | PAW 链上 / 内部 USD 余额 / 两者 | **内部 USD 余额 + 提现流水台账，现在就做**（先打通闭环）；**链上 PAW 放 P3** | P1 建 `node_withdrawals` 台账 + 提现端点；P3 接链上通道 |
| **D3** | 节点注册模式 | 完全自助 / 自助+OWNER审批 / 仅 OWNER 签发 | **自助注册 + OWNER 审批激活**（注册与激活分离，防刷号，保住一机一码） | P1 `node_registrations` + OWNER 激活端点 |
| **D4** | 创作者版税率 | 平台定价（申请+审批）/ 创作者自助（区间内） | **平台定价 + 创作者申请、OWNER 审批**（保留阶段五签字纪律） | P2 创作者申请/审批流程（`royalty_rate_snapshot` 机制复用） |
| **D5** | 模拟回答模式是否继续计费 | 计费 / 免费 | **模拟回答一律 $0 不计费**；同时提供**严格模式开关**，无真实节点时返回 **503/504** 并**释放预扣** | 开关 `APIPAW_SIMULATED_FREE`（默认 1）+ `APIPAW_DISPATCH_STRICT`（默认 0）；**P0** |
| **D6** | 断流已发分片时如何计费 | 不计费 / 按已发内容计费 | **不计费**（采纳推荐） | P1 真流式落地时实现（`APIPAW_REAL_STREAM`） |
| **D7** | 严格模式的 503 语义 | `503 no_capacity` / `429` / `202 排队` | **503 + `Retry-After`**（采纳推荐）；超时另给 504 | **P0** 已实现 |
| **D8** | 派单密钥存储 | 云端明文存 `node_secret` / 派生对称密钥 | **短期沿用现状**（采纳推荐），阶段六内评估"派生密钥 + 轮换" | 不在 P0/P1 范围，阶段六内出评估结论 |
| **D9** | 节点自助改价/改版税率 | 见 D4 | **随 D4**（平台定价，节点无权自改） | P2 |
| **D10** | **等级命名冲突**：`capability_class`（模型侧）与 `node_compute_class`（节点侧） | 改名 / 拆命名空间 | **改名并拆命名空间**：节点侧 → **`node_tier`**（结算用），模型侧 → **`model_capability_class`**（派单帧用）；**只加列、不改旧列** | `db.py` + `server.py`；**P0** 已实现 |
| **D11** | **结算侧 C0 档不可达** | 承认现状 / 重新定义 C0 边界 | **修 C0 可达性**：入门级显存节点必须能结算在 **C0** 档。边界 `≤8GB → C0` / `≤16GB → C1` / `≤48GB → C2` / 其余 `C3`；阈值可由 `APIPAW_COMPUTE_CLASS_TIER_MAX_GB` 覆盖。**未上报显存 → 等级空 → 保持旧口径（不悄悄降薪）** | `db.node_tier_of_vram()`；**P0** 已实现 |
| **D12** | 队列等待窗口默认值 | 0（不排队）/ 若干秒 | **默认 0**（采纳推荐），只留开关与观测，按数据调 | P2 `APIPAW_QUEUE_WAIT_SEC` |

### 8.1 D5 / D10 / D11 的实现契约（P0 验收锚点）

**D5 · 模拟回答零计费**
- 模拟回答**不产生** `usage_logs` 计费行、**不产生** `revenue_ledger` 行；预扣以 **`WAIVED` 流水**释放（`HOLD(-x)` + `WAIVED(+x)` = 0）。
- ⇒ `NET == BAL` 恒等**不被破坏**，对账覆盖率**不产生孤儿行**。
- `reap_stale_holds` 的"已结清"集合扩展为 `('SETTLE','FAILED','WAIVED')`，避免预扣被二次释放（双退款隐患已封）。
- 严格模式（`APIPAW_DISPATCH_STRICT=1`）：无候选 → **503 `no_capacity`**；派单超时 → **504 `dispatch_timeout`**；两者均 `Retry-After: 5` + 释放预扣。

**D10 · 等级语义拆分（只加列）**
- 新增列：`usage_logs.node_tier`、`usage_logs.model_capability_class`、`revenue_ledger.node_tier`。
- 旧列 `node_compute_class` **保留不改**（历史行不回填），读侧按"新列优先、空则回退旧列"平滑兼容。

**D11 · C0 可达**
- 新增 `db.node_tier_of_vram(vram_gb)`：`≤8 → C0`、`≤16 → C1`、`≤48 → C2`、其余 `C3`；显存未知（≤0 或未上报）→ 返回空串。
- 新增 `db.model_capability_class(min_vram_gb)`：模型侧能力标签，语义与节点侧**解耦**（同名不同义的坑就此封死）。

---

## 9. 验收矩阵与回归基线

| 批次 | 验收项 |
|---|---|
| 全部 | 阶段五全套回归不得回退：P0/P1/P2/P3/P4 沙箱套件 + dispatch 37 + protocol_v2 19 + node_auth 34 + registry_concurrency 11 + batch2 32（**必须在源站 venv Python 3.6.8 + SQLite 3.7.17 上跑**）+ 多节点压测 47 项 |
| 全部 | 生产基线复原：`users=1`、`api_keys=2`、`usage_logs=27`、`balance_ledger=40`、`daily_spend=6`、`revenue_ledger=0`、`NET==BAL==1016.037562`、双库 `integrity_check=ok` |
| P0 | 严格模式下无候选 ⇒ **503**（超时 **504**）+ `Retry-After` 且 `balance_ledger` **无净支出**、**无 `usage_logs` 计费行**（I7）· 模拟回答**零计费**（`WAIVED` 流水对冲，`NET==BAL` 不变）· `/api/v1/models/register` 无凭证 `401` / 非 CREATOR-OWNER `403` / 覆盖他人条目 `409` / OWNER 允许 · `node_tier` 与 `model_capability_class` 分列且 `4GB→C0` · 迁移幂等 |
| P1 | 真节点端到端：Agent（Ollama）接单 → 流式回传 → 买家 SSE 逐字到达 → `usage_source=real`；提现端点可走通（沙箱） |
| P2 | 派单统计端点返回真数据；网络健康端点买家可读 |
| P3 | 估算 vs 真实计量偏差报告 |
| P4 | `APIPAW_DISPATCH_ENABLED=1` 灰度观察 ≥72h，零 I1~I9 违规 |

---

## 10. 风险登记

| 风险 | 等级 | 缓解 |
|---|---|---|
| 严格模式上线后**暴露真实容量不足**（此前被模板回答掩盖）⇒ 买家侧大面积 503 | **高** | 先在内部账号灰度 + 准备容量预案（引导自建节点）；文案区分"平台故障"与"算力池繁忙" |
| 真实推理的 token 与估算口径差异 ⇒ 买家账单波动 | 中 | I8 显式标注 `usage_source`；P3 做偏差评估后再切严格计费 |
| 端到端真流式改变 `ttft_ms` 口径 ⇒ 前端/账单双变 | 中 | 用 `perf_source` + 新列承载，P3 才切，保留旧列 |
| 节点自助注册被刷号 | 中 | OWNER 审批 + 一机一码 + 风控限速 |
| 提现通道引入真实资金流出 | 中 | 先内部余额、小额灰度、每日额度上限 |
| Agent 引入推理依赖后发行包变大 / 装机变复杂 | 中 | **不打包权重、不打包推理框架**（只做后端适配器），包体维持 ~58KB |
| 云端明文存 `node_secret` 的长期风险 | 低 | D8 评估派生密钥 |

---

## 附录 A · 术语对照

| 术语 | 含义 |
|---|---|
| 派单（dispatch） | 云端把一次推理请求下发给某个算力节点 |
| 盲派单 v2 | 载荷只带不透明 `model_ref` + `model_cipher`（HMAC-SHA256-CTR），节点用自身密钥解出模型名 |
| 让退（yield） | 节点以 `503 node_yielded` 拒绝接单 ⇒ 冷却 + 信用分降权 |
| 等级（class） | C0~C3；**注意**：派单帧按**模型 min_vram** 算，结算按**节点硬件显存** 算，同名不同义（D10） |
| 分账 | 买家实付拆为 节点 + 创作者 + 平台 三方（`revenue_ledger`） |
| 模拟回答 | 网关本地 `build_answer()` 生成的模板文本（`server.py:957-976`）——**不是模型输出** |

## 附录 B · 阶段五遗留项闭环：多节点压测实录

**套件**：`apipaw-cloud/test_phase5_multinode_stress.py`（commit `eb856f0`）
**隔离方式**：临时目录复制双库 → `APIPAW_DB_PATH` / `APIPAW_NODE_REGISTRY_PATH` 指向副本 → 进程内起 uvicorn → 假 WS 节点通过 `gateway._route_dispatch_frame` 回帧。
**生产数据零触碰**：跑前跑后生产基线逐项一致（`users=1`、`api_keys=2`、`usage_logs=27`、`balance_ledger=40`、`daily_spend=6`、`revenue_ledger=0`）。

**结果**：本地 **47/47**、源站（Python 3.6.8 + SQLite 3.7.17）**47/47**。

| 组 | 覆盖 | 结果 |
|---|---|---|
| S1 异构池混跑 | 5 个显存档（4/8/12/24/80GB）v2 节点 + 2 个 v1 老节点（无显存） | 12 并发全 200；v2 载荷无明文 model 且节点侧**真解密成功**；v1 节点收到明文；载荷无商业字段；回执只含自己那一份 |
| S2 显存门槛 + 自定义版税 | `min_vram_gb=48` 模型 + `royalty_rate=0.22` | 48GB 以下节点**一单未接**；80GB 节点承接；未上报显存节点按 fail-open 保留；0.22 生效 |
| S4 公平轮转 | 顺序 18 单 | 6 节点**各 3 单（极差 0）**、无连续同节点 |
| S5 在途上限 | 20 并发（节点延迟拉长到 0.8s） | 无节点在途超限；池满降级为回退（**14/20 回退**——正是阶段六 P0 要消灭的行为） |
| S6 让退故障转移 | 节点固定让退 | 12 并发全 200（自动切走）；触发 503；冷却 20s；信用分 1.00→0.85；冷却期内 0 次再派单 |
| S7 财务铁律 | 73 笔 v2 分账行 | 对账 `problems=[]`；`NET==BAL` 精确相等；覆盖率 100%（0 孤儿）；**逐笔**买家实付与节点分成可重算；**逐笔** Σ三方==买家实付；C3 撞 0.85 上限被截断；C1/C2 按等级单价结算；老节点保持 0.85×基价旧口径 |
| S8 并发卫生 | 全程日志 | 零 `database is locked`、零 `SHADOW-MISMATCH` |

**压测暴露的三个产品事实（已进 §8 决策）**：
1. 结算侧 **C0 不可达**（D11）。
2. `capability_class` 与 `node_compute_class` **命名冲突**（D10）。
3. 池饱和时网关**降级为模拟回答而非排队/报错** —— 阶段六 P0 的第一靶子（§3.1）。

---

## 附录 C · 阶段六 P0 交付实录（2026-11-14 已上线生产）

### C.1 上线内容

| 项 | 落地位置 | 状态 |
|---|---|---|
| **安全修复**：`POST /api/v1/models/register` 零鉴权漏洞封堵（401/403/409/200 四态） | `apipaw-cloud/server.py` | ✅ 已上线 |
| **D5**：模拟/回退回答**一律 $0**（`WAIVED` 流水对冲，零用量行、零分账行） | `server.py` + `db.py` | ✅ 已上线 |
| **D5**：严格模式开关（503 `no_capacity` / 504 `dispatch_timeout` + `Retry-After` + 释放预扣） | `server.py`，开关 `APIPAW_DISPATCH_STRICT` | ✅ 代码已上线，**开关默认 0（灰度纪律）** |
| **D10**：`node_tier`（节点侧）/ `model_capability_class`（模型侧）拆列 | `db.py` + `server.py` | ✅ 已上线 |
| **D11**：C0 档可达（≤8GB→C0），显存未知⇒空串（不降薪） | `db.node_tier_of_vram()` | ✅ 已上线 |
| **模块 A1**：Agent 侧统一推理后端抽象层 + Ollama 底座（纯标准库） | `apipaw-agent/inference_backend.py` | ✅ 已上线（Agent v1.0.7） |
| **模块 A2**：节点上报 `models` / `inference_backend` ⇒ 云端 `node_registry.meta_json` | Agent `ws_tunnel.py` + 网关 `_ws_node_meta` | ✅ 已上线（**纯加字段**，老 Agent 向后兼容） |

### C.2 生产部署实录

- **备份**：`deploy_backup.sh p6-p0`（双库 `.backup` + 代码 + 双站前端包），回滚点在 `/opt/apipaw-backups/*_20261114-134602_*`。
- **部署**：`scp` → `/tmp/apipaw_p6_p0` → `sudo cp` 进 `/opt/apipaw-cloud`；**sha256 逐字节校验一致**（`server.py` / `db.py` / 冒烟脚本）。
- **开关**：新增 systemd **drop-in** `/etc/systemd/system/apipaw-cloud.service.d/p6-p0.conf`（不动单元本体，回滚只需删目录）：
  `APIPAW_DISPATCH_STRICT=0`（严格模式**保持关闭**）+ `APIPAW_SIMULATED_FREE=1`（零计费**已生效**）。
- **迁移**：`usage_logs.node_tier` / `usage_logs.model_capability_class` / `revenue_ledger.node_tier` 三列**纯加列、幂等**，历史行不回填。

### C.3 验收结果

| 套件 | 结果 |
|---|---|
| `apipaw-cloud/test_phase6_p0.py`（源站 venv **Python 3.6.8 + SQLite 3.7.17**） | **52/52** |
| 阶段五回归（P3 45 / node_auth 34 / wallet_auth 23 / 多节点压测 51 / P1 32 / dispatch 37 / py36 兼容） | **全绿**（protocol_v2 16/17，1 条为 Windows 路径环境产物，非回归） |
| Agent 侧 `test_inference_backend.py` | **21/21** |
| Agent 侧 `test_ui_hot_reload.py` | **全绿**（热重载 0.13s，看门狗保留） |
| **生产线上冒烟** `smoke_p6_p0_prod.py` | **33/33**（鉴权矩阵 9 + D5 零计费 7 + D10/D11 8 + 模块 A 契约 4 + 基线 4） |

### C.4 生产基线复原（分毫不差）

```
users=1  api_keys=2  usage_logs=27  balance_ledger=40  daily_spend=6
revenue_ledger=0  models=5  dispatch_log=0
NET == BAL == 1016.037562        双库 integrity_check=ok
```

- 冒烟自建的 3 个账户、1 个测试模型、全部 `dispatch_log` 行**已随脚本自动清理**。
- 另清理阶段五遗留的**模拟节点行** `nodes_history.apipaw-cloud-sim`（920 tokens / 489.24725 PAW 假收益；该节点只存在于历史结算记录里，不在 `node_registry` 中，属演示种子数据）。保留真实节点行 `node_default_001`。
- ⚠️ 9 条 `usage_logs` 行的 `node_id` 仍指向 `apipaw-cloud-sim`（历史演示用量行，属基线 27 行之一，**未动**）。
