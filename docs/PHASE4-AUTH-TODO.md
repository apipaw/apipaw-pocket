# APIPaw Cloud 阶段四蓝图：账户与通行证系统

> **模块**：Web3 钱包签名登录（业主侧） + API Key 自助签发台（买家侧）
> **文档定位**：架构蓝图 + 落地清单。本轮**只出图，不改任何业务代码**。
> **前置状态**：阶段三（基线固化 / P0 安全 / 数据模型统一 / 计费改造 / 充值 / 实时性 / 探针清理）已收官并全量同步 GitHub。
> **撰写日期**：2026-11-09
>
> **实施进度（2026-11-09/10）**：**P0 / P1 / P2 已全部上线生产** ——
> P0 `28cbd31`（关匿名兜底 / 额度归零 / 日志脱敏）、
> P1 `ad5660e`（句柄化迁移 M1–M5 + 双读回落 + 签发台限流）、
> P2 `64a2e6a` / `f2dc862`（真实客户端 IP 限流 + 新账户不落明文 + 签发台 UI）。
> 下一步 **P3 业主钱包签名登录**。清单索引见 `docs/BACKEND-REFACTOR-TODO.md`
> 「阶段四 · 账户与通行证系统（TODO-19 ~ TODO-24）」。

---

## 0. 一句话结论

当前系统**没有任何人能在没有 Key 的情况下拿到 Key**——`paw_demo_key` 是写死在代码里的；
而唯一存在的"签发接口" `POST /api/v1/auth/apikey` **完全无需鉴权、且白送 $10 余额**，
既是"无法自助获取"的原因，也是"可被无限刷"的洞。阶段四要做的**不是加一个登录页**，
而是把**「账户（account）」与「秘密凭证（secret）」与「会话令牌（session）」三层彻底解耦**，
再在它们之上开出两条自助通道：业主走**钱包签名**，买家走**签发台**。

核心设计决策一句话：**JWT 只当"凭证"，不当"授权源"**——
任何一次请求的最终角色/归属，一律以数据库现状为准（可撤销、可改绑、可封禁即时生效）。

---

## 1. 现状摸底（事实，均带出处）

### 1.1 后端鉴权现状

| 事实 | 出处 | 含义 |
|---|---|---|
| 所有鉴权都走同一个头：`Authorization: Bearer <key>` | `server.py:846` `resolve_api_key()` | **没有 scheme 区分**，无法天然区分「JWT」与「API Key」 |
| `resolve_api_key()` 只做 `replace("Bearer ", "")` | `server.py:850` | 会替换**所有**出现处，且不做前缀校验 |
| 三层鉴权函数：`require_api_key` / `require_creator` / `require_owner` | `server.py:854` / `:973` / `:982` | 全部以 `api_key` 字符串为**唯一主体标识** |
| `require_owner` 判 `role == 'OWNER'` | `server.py:1000` | 角色字段已就位（阶段三 TODO-02） |
| 业主面板按 `users.owner_wallet` 聚合收益 | `server.py:1145` → `db.get_owner_nodes_revenue()` `db.py:2061` | **收益归属链已经通了**，缺的是"怎么登录成业主" |
| 节点归属存在 `node_credentials.owner_wallet` | `db.py:2160` | 业主钱包 → 节点的映射**已存在** |
| `/v1/chat/completions` 有匿名兜底 | `server.py:1372` `resolve_api_key(...) or DEMO_API_KEY` | **无 Key 也能打推理**（生产库若无该用户则 401，属"侥幸安全"） |
| `POST /api/v1/auth/apikey` 无任何鉴权、默认送 `$10` | `server.py:1008` → `db.create_api_key()` `db.py:503` | **可被无限刷额度** |
| 生产依赖只有 3 个 | `requirements.txt`：`fastapi` / `uvicorn[standard]` / `websockets` | **没有任何 JWT 库、没有任何加密库** |

### 1.2 账户数据模型现状

`users` 表（`db.py:275`）：

```
id INTEGER PRIMARY KEY AUTOINCREMENT
api_key TEXT UNIQUE NOT NULL      ← 明文存储，且是全库的事实主键
balance_usd / daily_limit_usd / balance_frozen_usd
created_at / role / owner_wallet
```

**`api_key` 是横跨 4 张表的关联标识**（这是本次架构设计的最大约束）：

| 表 | 用途 | 出处 |
|---|---|---|
| `users.api_key` | 账户本体（明文秘密 + 唯一标识，二合一） | `db.py:279` |
| `usage_logs.api_key` | 推理流水（NOT NULL） | `db.py:302` |
| `balance_ledger.api_key` | 余额账本 | `db.py:378` |
| `daily_spend.api_key` | 当日消费原子表 | `db.py:417` |

→ **直接把 `api_key` 改成哈希是不可行的**：会同时打断流水/账本/限额的关联。
→ 必须引入一个**与秘密解耦的稳定账户句柄（account_handle）**，让"秘密"可轮换而"关联"不动。

### 1.3 前端现状（Pocket，React Native + Expo）

| 事实 | 出处 | 含义 |
|---|---|---|
| 单一 axios 实例 + 请求拦截器统一注入 `Bearer <apiKey>` | `src/api/cloudClient.ts:24-35` | 换凭证**只改拦截器一处** |
| API Key 存 `localStorage['apipaw.api_key']`，兜底 `EXPO_PUBLIC_API_KEY` | `src/store/usePawStore.ts:9-20` | **localStorage 无加密、无过期**，且仓库里**没有 .env** |
| **没有** `persist` / AsyncStorage / Keychain | `usePawStore.ts:36-64` | 凭证裸存 |
| **没有** 登录态概念；`roleMode: 'BUYER' \| 'HOST'` 是本地 UI 开关 | `usePawStore.ts:37, 65` | 角色**非服务端权威** |
| **没有** 路由/登录页/引导页，整个 App 是单屏 `App.tsx`（626 行） | `App.tsx` | 需新增"账户"入口 |
| **零** web3 依赖：无 `ethers` / `wagmi` / `viem` / `signMessage` | `package.json` | 签名能力要从零引入 |
| 唯一"钱包"是硬编码常量 `0x71C765...` 当创作者身份用 | `usePawStore.ts:73` | 与真实钱包**无关**，需区分"创作者钱包"与"登录钱包" |
| e2e 三个脚本硬编码 `paw_demo_key` | `e2e/live-console.cjs:26`、`e2e/design-check.cjs:21`、`e2e/limit-sync.cjs:19`（**后者连 env 覆盖都没有**） | 凭证一旦轮换，e2e 全红 |
| 前端**从不**调用 `/api/v1/auth/apikey` | 全局 grep 无命中 | **买家签发台目前没有前端入口** |
| 业主收益取自 `GET /api/v1/owner/dashboard` 的 `my_nodes` 块，但前端类型里**没有**这些字段 | `App.tsx:177` vs `server.py:1170` | 前端未消费已存在的数据 |

### 1.4 运行环境硬约束（决定技术选型）

| 约束 | 事实 | 影响 |
|---|---|---|
| 源站 Python | **3.6.8**（2019 年版本，已 EOL） | 新库版本往往已弃用 3.6 |
| 源站 SQLite | **3.7.17** | ❌ 无 UPSERT / ON CONFLICT / **partial index** / `VACUUM INTO` |
| venv 依赖 | fastapi 0.83 / starlette 0.19 / pydantic 1.9 / uvicorn 0.16 | **零** JWT 库、**零** 加密库、**无 requests**（`TestClient` 不可用） |
| 服务形态 | systemd 单 worker | 任何 CPU 密集操作（如纯 Python 验签）会**阻塞事件循环** → 必须 `run_in_executor` |
| 磁盘 | Python 3.6.8 的 `sqlite3` 模块**无 `Connection.backup()`**（Python 3.7 才引入）；SQLite 3.7.17 无 `VACUUM INTO` | 热备只能用 `sqlite3` CLI 的 `.backup`（阶段三已验证） |

### 1.5 摸底发现的 5 个"阶段四必须先修"的洞

| # | 洞 | 严重度 | 说明 |
|---|---|---|---|
| H1 | API Key **明文落库** | 🔴 高 | 库一旦泄露，所有买家/业主 Key 直接失守；`users.api_key` 还是关联主键，不能直接改 |
| H2 | `/api/v1/auth/apikey` **无鉴权 + 送 $10** | 🔴 高 | 可无限注册刷额度（配合 H1 即为资金/算力盗刷入口） |
| H3 | `/v1/chat/completions` **匿名兜底** `DEMO_API_KEY` | 🟠 中高 | "没 Key 也能推理"的口子，阶段四的通行证语义不允许匿名推理 |
| H4 | `DEMO_API_KEY`（`paw-sk-demo1234567890`）在 `server.py:729` **硬编码兜底** | 🟠 中高 | 与 `db.DEMO_OWNER_API_KEY`（`paw_demo_key`）两套 demo 概念并存，极易误用 |
| H5 | Key **不可见、不可吊销、不可轮换** | 🟠 中高 | 用户丢了 Key 只能找人工；泄漏了也无法止损 |

---

## 2. 总体架构

### 2.1 三层凭据模型（阶段四的骨架）

```
┌─ 账户 Account ──────────────────────────────────────────────┐
│  users 表：account_handle（内部句柄, 如 acct_9f3a…）          │
│             role(BUYER/OWNER) / status / owner_wallet / email  │
│             balance_usd / daily_limit_usd                     │
└───────────────┬──────────────────────────────┬───────────────┘
                │ 1:N                          │ 1:1
                ▼                              ▼
┌─ 凭证 Secret ──────────────┐   ┌─ 会话 Session ─────────────────┐
│ api_keys 表（可多把/账号）  │   │ auth_sessions 表                │
│  key_hash = sha256(secret) │   │  jti / user_id / expires /     │
│  key_prefix / key_last4    │   │  revoked_at                    │
│  scopes / status / 限额     │   │        ▼                        │
│  永不存明文（除签发那一刻）  │   │  JWT (HS256, 2h)               │
└────────────────────────────┘   │  sub=account_handle            │
                                 └───────────────────────────────┘
```

**三种东西，三种生命周期**：

- **账户** 长期存在，可封禁（`status`）、可改绑钱包。
- **凭证（API Key）** 长期存在，可多把、可吊销、可轮换；**秘密只在签发那一刻返回一次**。
- **会话（JWT）** 短期存在（建议 2 小时），可撤销；持有者只需钱包，不持有长期秘密。

### 2.2 双通道鉴权：同一个 `Authorization` 头，两种凭证

现有全部客户端（含 e2e）都用 `Authorization: Bearer <key>`，**不能破坏**。
因此采用**载荷形态判别**而非 scheme 判别：

```
token = Authorization 去掉 "Bearer " 前缀
if token 由 3 段 base64url 组成（以 "." 分隔，恰好 2 个点） → 视为 JWT
else                                                        → 视为 API Key 明文
```

> 未来的正式演进：引入 `Authorization: PawKey <key>` 明确 scheme，把 `Bearer` 留给 JWT。
> 本轮为兼容期，允许两种并存；判定逻辑必须**收敛到唯一一处** `resolve_credential()`，
> 禁止各端点自行判断。

**解析结果统一归一为一个「账户句柄」**：

```
resolve_credential(authorization) -> Credential
    kind: 'apikey' | 'jwt'
    handle: users.account_handle      ← 后续所有业务逻辑只认它
    user:  users 行（role/owner_wallet/status/balance…）
    scopes / expires_at / jti …
```

**关键收益**：`usage_logs` / `balance_ledger` / `daily_spend` 全部改记 `account_handle`，
**计费、额度、账本三条链路一行代码都不用改**（阶段三刚做完的账实相符不变式因此得以保全）。

### 2.3 关键设计决策（含被否方案）

| # | 决策 | 选择 | 否决方案与理由 |
|---|---|---|---|
| D1 | JWT 载荷主体 | `sub = account_handle`（**不含 api_key**） | ❌ 把 api_key 塞进 JWT：JWT 一旦泄漏即等于长期凭证失守。改为**每次请求回查 DB**（本来就要查 user 行） |
| D2 | JWT 授权来源 | **一律以 DB 为准**，JWT 只证明"你是谁" | ❌ 信任 JWT 里的 `role`：角色被降级/钱包被改绑后，旧 JWT 仍能提权，最长 2h 窗口 |
| D3 | 验签依赖 | **零新依赖**：纯 Python `secp256k1` 恢复 + 纯 Python `keccak256` | ❌ 装 `eth-account`/`pysha3`：源站 Python 3.6.8 上新版本多半不支持；`eth-keys` 纯 Python 但引入供应链面；生产 venv 已被刻意保持精简。✅ 零依赖 + 公开测试向量可验证（见 4.3） |
| D4 | 账户句柄 | 新增 `users.account_handle`（`acct_` + 随机），**迁移** 4 张表的 `api_key` 引用 | ❌ 保持 `api_key` 为明文关联主键：H1 无法根治，Key 永远不可轮换 |
| D5 | Key 存储 | `api_keys.key_hash = sha256(secret)` + `key_prefix` + `key_last4` | ❌ 明文存 Key：H1；❌ bcrypt/argon2：需新依赖且**每次请求验一次哈希**成本高（scrypt 约 100ms/次会打爆单 worker），sha256 + 32 字节随机密钥熵足够 |
| D6 | JWT 算法 | **仅 HS256**，密钥来自环境/文件（0600），支持双密钥轮换 | ❌ RS256/ES256：需要非对称密钥管理；❌ `alg=none`/算法混淆：必须**显式白名单校验** |
| D7 | 买家签发台的身份核验 | **钱包签名复用**（与模块 A 同一套验签）+ 可选邮箱 | ❌ 邮箱验证码为唯一门槛：需要 SMTP 与邮件域名，冷启动成本高；❌ 无核验直接发 Key：等于现状 H2 |
| D8 | 新用户初始额度 | **$0**（或 $0.5 且需核验 + 每日签发上限） | ❌ 沿用 $10：H2 刷额度。注：阶段三充值接口 `demo:true` 未接真实支付通道，阶段四更不能凭空增发信用 |
| D9 | 推理匿名兜底 | **移除** `or DEMO_API_KEY`，无 Key 一律 401 | ❌ 保留：为"方便试用"留后门 = H3；改为在控制台提供**显式试用 Key 申请**（走签发台，带独立限额） |
| D10 | Owner 身份 | `users.owner_wallet` 与**登录钱包**解耦 | ⚠️ 创作者身份（`creator_wallet`）与登录钱包（`owner_wallet`）**是两件事**，不要合并；阶段三已分列，本轮保持 |
| D11 | 会话续期 | 钱包**重新签名**换新 JWT（SIWE 原生语义），**不发 refresh token** | ❌ refresh token：钱包登录的核心价值就是"不持有长期秘密"，发 refresh token 等于绕回 API Key 模型 |
| D12 | 前端凭证存储 | `expo-secure-store`（Keychain/Keystore）替代 `localStorage` | ❌ 继续 localStorage：移动端 root/备份/日志场景下易泄漏 |

---

## 3. 数据模型设计

> 全部 DDL 遵守生产约束：**SQLite 3.7.17**（无 partial index、无 UPSERT）、**Python 3.6.8**。
> 新表一律用 `CREATE TABLE IF NOT EXISTS` + 显式 `_ensure_column` 补列（沿用阶段三 `db.py:253` 的模式）。

### 3.1 `users` 新增列

```sql
-- 全部通过 _ensure_column 追加（SQLite 无 ADD COLUMN IF NOT EXISTS）
account_handle  TEXT DEFAULT ''      -- 内部句柄 acct_xxxx, 迁移后回填并建唯一索引
status          TEXT DEFAULT 'active' -- active | suspended | closed
email           TEXT DEFAULT ''
display_name    TEXT DEFAULT ''
account_type    TEXT DEFAULT 'APIKEY'  -- APIKEY | WALLET
last_login_at   REAL DEFAULT 0
login_ip        TEXT DEFAULT ''
```

> ⚠️ **`account_handle` 不能用 partial unique index**（SQLite 3.7.17 不支持，3.8.0 才有）。
> 方案：**唯一性靠"回填时生成随机串 + 应用层保证唯一"**，并额外建一张
> `auth_wallets(wallet_address TEXT PRIMARY KEY, ...)` 表——钱包地址用**主键**天然唯一，
> 绕开 partial index 限制。

### 3.2 `api_keys`（买家凭证，多把/账号）

```sql
CREATE TABLE IF NOT EXISTS api_keys (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    account_handle  TEXT NOT NULL,
    key_hash        TEXT NOT NULL UNIQUE,   -- sha256(明文).hex()
    key_prefix      TEXT NOT NULL,          -- 'paw-sk-1a2b3c' 展示用
    key_last4       TEXT NOT NULL,
    label           TEXT DEFAULT '',
    scopes          TEXT DEFAULT 'chat,usage,analytics',
    daily_limit_usd REAL DEFAULT 0,          -- 0 = 继承账号级限额
    status          TEXT NOT NULL DEFAULT 'active',  -- active | revoked
    created_at      REAL NOT NULL,
    last_used_at    REAL DEFAULT 0,
    revoked_at      REAL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_api_keys_handle ON api_keys(account_handle);
CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);
```

### 3.3 `auth_nonces`（签名挑战，一次性）

```sql
CREATE TABLE IF NOT EXISTS auth_nonces (
    nonce        TEXT PRIMARY KEY,     -- 32 字节随机, base64url
    address      TEXT NOT NULL,        -- 0x + 40 hex, 统一小写
    domain       TEXT NOT NULL,        -- 绑定 Host, 防跨域重放
    chain_id     INTEGER NOT NULL,
    message      TEXT NOT NULL,        -- 服务端自己拼装的那一份（签名前下发）
    issued_at    REAL NOT NULL,
    expires_at   REAL NOT NULL,        -- 默认 +600s
    used_at      REAL DEFAULT 0,
    created_ip   TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_nonces_exp ON auth_nonces(expires_at);
```

### 3.4 `auth_sessions`（JWT 会话，可撤销）

```sql
CREATE TABLE IF NOT EXISTS auth_sessions (
    jti          TEXT PRIMARY KEY,
    account_handle TEXT NOT NULL,
    wallet       TEXT DEFAULT '',
    issued_at    REAL NOT NULL,
    expires_at   REAL NOT NULL,
    revoked_at   REAL DEFAULT 0,
    user_agent   TEXT DEFAULT '',
    ip           TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sessions_handle ON auth_sessions(account_handle);
```

### 3.5 `auth_wallets`（钱包 → 账户 绑定）

```sql
CREATE TABLE IF NOT EXISTS auth_wallets (
    wallet_address TEXT PRIMARY KEY,    -- 0x + 40 hex, 小写
    account_handle TEXT NOT NULL,
    first_seen_at  REAL NOT NULL,
    last_seen_at   REAL NOT NULL,
    sign_count     INTEGER DEFAULT 0,
    is_owner       INTEGER DEFAULT 0
);
```

### 3.6 迁移顺序（一次性、可回滚）

> **原则：先加列 → 再回填 → 最后切读 → 最后才清明文**。任一步失败都能停在"新旧并存"的可用态。

| 步 | 动作 | 回滚方式 |
|---|---|---|
| M1 | `users` 加 5 列 + 建 `api_keys`/`auth_nonces`/`auth_sessions`/`auth_wallets` | `DROP TABLE` + `_ensure_column` 反向不可 → 用备份库还原 |
| M2 | **回填句柄**：每行 `account_handle = 'acct_' + token_hex(8)` | 幂等，可重跑 |
| M3 | **迁移引用**：`usage_logs` / `balance_ledger` / `daily_spend` 的 `api_key` → `account_handle`（一条关联子查询 UPDATE，三张表各一条） | 需备份库还原（**执行前必做 `.backup` 快照**） |
| M4 | **建 api_keys 影子行**：`key_hash = sha256(users.api_key)`（此时明文还在，只是多了一份哈希索引） | 直接 DELETE 影子行 |
| M5 | **切读**：`get_user_by_key()` → 先查 `api_keys.key_hash`，未命中再回落旧明文查询（双读） | 保留回落分支 |
| M6 | **清明文**：`users.api_key` 置空（历史 Key 全部作废，需重新签发；**唯一有用户感知的一步**） | 需备份库还原 |

> ⚠️ **M3 是唯一有"数据形状"变更的一步**，必须：先 `sqlite3 .backup` 双库快照 → 在沙箱库上跑通 → 生产再执行 → 执行后 `PRAGMA integrity_check` + 账实相符校验（`账本净额 == users.balance_usd` 必须仍成立）。
> ⚠️ **M6 意味着 `paw_demo_key` 会失效**——这正是阶段四的目标（"不再依赖硬编码 Key"），但必须**在买家签发台上线之后**再做，且 e2e 脚本要同步改造（见 4.7 / 5.6）。

---

## 4. 模块 A · 业主侧：Web3 钱包签名登录（EIP-4361 / SIWE 思想）

### 4.1 端到端时序

```
业主                        Pocket App                        APIPaw Cloud
 │                             │                                   │
 │  点"连接钱包"                │                                   │
 ├────────────────────────────▶│ ① POST /api/v1/auth/nonce          │
 │                             │    {address, chain_id}            │
 │                             ├──────────────────────────────────▶│ 存 auth_nonces
 │                             │◀─────────────────────────────────┤ 返回 {nonce, message}
 │                             │                                   │
 │  MetaMask 弹窗 personal_sign│                                   │
 │◀────────────────────────────┤                                   │
 │                             │ ② POST /api/v1/auth/verify         │
 │                             │    {address, message, signature}   │
 │                             ├──────────────────────────────────▶│ ① 查 nonce（未用/未过期）
 │                             │                                    │ ② **服务端重算 message** 并比对
 │                             │                                    │ ③ ecrecover → pubkey → keccak → address
 │                             │                                    │ ④ 比对地址 == nonce.address
 │                             │                                    │ ⑤ 标记 nonce 已用（原子 UPDATE）
 │                             │                                    │ ⑥ 绑定/查找 auth_wallets → 账户
 │                             │                                    │ ⑦ 建 auth_sessions(jti) + 签 JWT
 │                             │◀─────────────────────────────────┤ {access_token, expires_in, user}
 │                             │ 存 SecureStore（JWT + 钱包地址）    │
 │                             │ 后续请求带 Bearer <JWT>             │
```

### 4.2 签名消息格式（SIWE 风格，EIP-4361）

服务端**拼装并下发** `message`，客户端**原样签名**：

```
apipaw.com wants you to sign in with your Ethereum account:
0x71C7656EC7ab88b098defB751B7401B5f6d8976F

Sign in to the APIPaw Cloud owner console. This request does not trigger a blockchain transaction or cost any gas.

URI: https://cloud.apipaw.com
Version: 1
Chain ID: 1
Nonce: 8sJk2nQ7…
Issued At: 2026-11-09T02:14:33Z
```

**约束**：

| 字段 | 规则 | 防的是 |
|---|---|---|
| `domain` | 必须等于请求的 `Host`（生产 `cloud.apipaw.com`） | 跨站签名重放 |
| `URI` | 必须等于服务的对外 origin | 同上 |
| `Chain ID` | 白名单（`1` 主网 / `11155111` Sepolia 测试）；不匹配 → 400 | 用户切链导致语义漂移 |
| `Nonce` | 服务端下发、一次性、10 分钟过期 | 重放 |
| `Issued At` | 服务端时间 | 伪造时效 |
| `Statement` | 固定文案 | —— |

> ⚠️ **服务端必须用自己存的 nonce 重新拼装 message 并逐字节比对**，绝不能信任客户端回传的 `message`。
> 否则攻击者可以拿"任意一条历史合法签名"配一个自己的 message 复用到别的 nonce/domain。

### 4.3 服务端验签实现（零依赖）

**(a) 签名语义**：`personal_sign` = EIP-191 `0x45` 版本：

```
digest = keccak256(b"\x19Ethereum Signed Message:\n" + len(message_bytes).to_bytes(1,'big') + message_bytes)
```

**(b) 需要两个纯 Python 原语**：

| 原语 | 作用 | 实现要点 | 公开测试向量 |
|---|---|---|---|
| `keccak256` | 地址推导 | Keccak-f[1600]，**填充用 0x01（原始 Keccak）**，⚠️ **不是** `hashlib.sha3_256`（那是 NIST SHA3，填充 0x06，结果不同） | `keccak256(b"") = c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470` |
| `secp256k1` 公钥恢复 | 验签 | `ecrecover(digest, v, r, s)`：解 `y² = x³+7`，选奇偶，`Q = r⁻¹(sR − eG)` | 可用 RFC6979 / 以太坊官方测试向量交叉验证 |

**secp256k1 常量**：

```
p  = 2**256 - 2**32 - 977
n  = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798
Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8
```

**必须做的 4 项安全校验**（缺一即留后门）：

1. `v ∈ {0,1,27,28}`，且 `27/28` 归一为 `0/1`。
2. `1 ≤ r < n`、`1 ≤ s < n`。
3. **低 s 强制**：`s ≤ n/2`（EIP-2），否则拒绝 —— 否则签名可被"改写成另一把有效私钥的签名"。
4. 恢复出的 `Q` 非无穷远，且 `n·Q = O`。

**(c) 性能与阻塞**：纯 Python 点运算约 5–15ms/次，**必须放 `run_in_executor`**（与阶段三 `_collect_node_view` 同一套路），绝不能阻塞事件循环。

**(d) 依赖问题的备选方案对比**：

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| **纯 Python 自研**（推荐） | 生产零新增依赖；改动可控；可审计 | 需自测（公开向量 + 与参考实现交叉验证）；约 250 行 | ✅ 采用 |
| `eth-account` + `eth-keys` | 官方实现，语义无误 | 需新依赖；`eth-keys` 依赖 `pysha3`（C 扩展）；源站 3.6.8 上版本受限 | ⚠️ 备选（若能升 Python 再议） |
| `pycryptodome` | 提供 Keccak 与 ECC | 需新依赖、C 扩展、版本绑定 | ⚠️ 备选 |
| 前端验签 | 零服务端成本 | ❌ **安全反模式**：信任客户端传来的"已验证"结论 | ❌ 否决 |
| 第三方验签 API | 简单 | ❌ 外部依赖 + 延迟 + 暴露用户地址与签名 | ❌ 否决 |

### 4.4 JWT 签发（HS256，纯标准库）

**载荷**：

```json
{
  "iss": "apipaw-cloud",
  "aud": "apipaw-pocket",
  "sub": "acct_9f3ac21b",
  "role": "OWNER",
  "wallet": "0x71c7656ec7ab88b098defb751b7401b5f6d8976f",
  "jti": "0d1f…",
  "iat": 1762640073,
  "nbf": 1762640073,
  "exp": 1762647273
}
```

**签发/校验**（标准库即可，约 40 行）：

```
header  = {"alg":"HS256","typ":"JWT"}
b64u(x) = base64url(x).rstrip("=")
signing_input = b64u(json.dumps(header)) + "." + b64u(json.dumps(payload))
signature = HMAC-SHA256(secret, signing_input)
token = signing_input + "." + b64u(signature)
```

**校验清单（缺一不可）**：

1. `alg` **严格等于** `HS256`（白名单，杜绝 `none` 与 `alg` 混淆攻击）。
2. `hmac.compare_digest` 比对签名（**常量时间**）。
3. `exp > now`（容忍 ±60s 时钟偏移）、`nbf ≤ now`。
4. `iss` / `aud` 匹配。
5. `jti` 在 `auth_sessions` 中**未撤销**且 `expires_at > now`。
6. **回查 `users` 行**：`status == 'active'`，并以 DB 的 `role` / `owner_wallet` 为准（**不信任载荷里的 role**，见 D2）。

**密钥管理**：

| 项 | 方案 |
|---|---|
| 存放 | 环境变量 `JWT_SECRET`（systemd `EnvironmentFile`），或 `/opt/apipaw-cloud/.secrets/jwt_secret`（`chmod 600`, root-only, **不入 git**） |
| 强度 | ≥ 32 字节随机（`secrets.token_urlsafe(48)`） |
| 轮换 | 支持 `JWT_SECRET` + `JWT_SECRET_PREV` 双密钥：**用新的签发、用旧的验签**，实现零中断轮换 |
| 泄漏应急 | 立即撤销全部 `auth_sessions`（`UPDATE auth_sessions SET revoked_at=?`）+ 换密钥 |

### 4.5 钱包 → 账户的绑定规则（业主身份从哪来）

首次签名登录时：

| 情形 | 处理 |
|---|---|
| 钱包**未绑定**任何账户 | 新建账户：`role='OWNER'`、`account_type='WALLET'`、`owner_wallet=<地址>`、`status='active'`、**初始余额 $0**；`account_handle='acct_…'` |
| 钱包**已绑定** | 直接登录，返回 JWT；**每次登录都刷新 `last_seen_at` / `sign_count`** |
| 地址**大小写/格式异常** | 统一 `0x` + 40 hex **小写**后再比对（EIP-55 校验和只用于显示） |

> ⚠️ **"签名即可成为 OWNER"是一把双刃剑**：任何人都能签一个钱包直接拿到业主权限。
> 因此必须配套：**① 首次登录进"待审核"（`status='pending'`）**，或 **② 与已有节点归属自动关联**：
> 若该钱包在 `node_credentials.owner_wallet` 里**已有节点**，则自动判定为 OWNER（**这是最优解**，
> 因为"有节点"本身就是业主资格）；否则按待审核流程走（后续可接人工审核或链上凭证）。

> **推荐落地**：自动关联优先 + 待审核兜底。现有生产数据的 `node_credentials.owner_wallet` 已就位，
> 迁移时把 `paw_demo_key` 账户的 `owner_wallet` 与之对齐，业主登录后**立即**能看到自己的节点与收益。

### 4.6 用 JWT 替换 `paw_demo_key` 去拉节点收益（完整链路）

**目标**：业主用钱包登录 → 拿 JWT → 拉到"我在 `node_credentials` 里的节点的收益"。

```
① POST /api/v1/auth/verify  → {access_token: "<JWT>"}
② GET  /api/v1/owner/nodes/revenue
       Authorization: Bearer <JWT>
       │
       ├─ resolve_credential()  → 形态判别=JWT → HS256 校验 → jti 未撤销
       ├─ 回查 users 行 → role='OWNER'、status='active'、owner_wallet='0x71c7…'
       ├─ db.get_owner_nodes_revenue(owner_wallet)
       │     ├─ get_node_owner_map()  → node_credentials:{node_id→{owner_wallet}}
       │     ├─ 筛出 owner_wallet 匹配的所有 node_id
       │     └─ list_nodes_stats()  → nodes_history 里的产出/收益，汇总
       └─ 返回 {owner_wallet, nodes_total, total_earnings_paw, nodes:[…]}
```

**要点**：

- **收益归属链阶段三已经打通**（`db.py:2061`），本模块**不需要改任何计费/收益表结构**，
  只需让"登录钱包 == `users.owner_wallet` == `node_credentials.owner_wallet`"三者对齐。
- **`account_handle` 化之后**，`usage_logs` / `balance_ledger` / `daily_spend` 记的是句柄，
  业主想看"自己的节点赚了多少美元"时，需要一个 **`node_id → 账户句柄`** 的映射：
  `nodes_history` 目前**没有 owner 字段**（`db.py:289` 只有 node_id/产出/收益/is_paused/last_seen）。
  → **本阶段新增 `nodes_history.owner_handle` 列**（`_ensure_column` 补齐即可），
  在结算/心跳回写时写入当前句柄；否则跨账户的"节点收益 vs 账户流水"无法对账。
  （阶段三 `TODO-06` 只做了 `node_credentials.owner_wallet`，未落到流水表 —— 这是本阶段必须补的最后一环。）

**接口契约**：

| 方法 | 路径 | 鉴权 | 返回 |
|---|---|---|---|
| POST | `/api/v1/auth/nonce` | 无（但按 IP 限流） | `{nonce, message, domain, chain_id, expires_at}` |
| POST | `/api/v1/auth/verify` | 无（靠 nonce 自证） | `{access_token, token_type:"Bearer", expires_in, user:{handle, role, wallet, status}}` |
| POST | `/api/v1/auth/logout` | JWT | 撤销当前 `jti` |
| GET | `/api/v1/owner/nodes/revenue` | OWNER | `{owner_wallet, nodes_total, total_earnings_paw, total_tokens_processed, nodes:[{node_id, total_earnings_paw, total_tokens_processed, is_paused}]}` |

> 新增 `GET /api/v1/owner/nodes/revenue` 的原因：阶段三已经把 `my_nodes` 塞进了
> `/api/v1/owner/dashboard` 的响应里，但**前端 `OwnerDashboard` 类型里根本没有这些字段**
> （`App.tsx:177`）—— 前后端契约没对齐，业主在 UI 上看不到"我的节点收益"。独立端点更干净。

### 4.7 前端改造（Pocket）

**依赖新增**（需用户批准，因为阶段四首次给 App 加第三方依赖）：

| 包 | 用途 | 备注 |
|---|---|---|
| `ethers@6` | `personal_sign` / 地址工具 | 纯 JS，RN 可用；需 `react-native-get-random-values` 补 `crypto.getRandomValues` |
| `expo-web-browser` + `expo-linking` | 跳钱包 App / 回跳 | MetaMask Mobile deep link：`metamask://` |
| `expo-secure-store` | Keychain/Keystore 存 JWT | **替换 localStorage** |
| （可选）`@walletconnect/…` | 扫码连接 | 若要支持多钱包则需要 |

**流程**：

1. 「连接钱包」→ `eth_requestAccounts`（EIP-1193；若在 App 内则用 deep link 拉起 MetaMask）。
2. 取 `chainId`，白名单校验（不匹配 → 提示切到主网）。
3. `POST /api/v1/auth/nonce` → 拿到 `message`。
4. `signer.signMessage(message)` → `personal_sign`。
5. `POST /api/v1/auth/verify` → 存 JWT 到 SecureStore。
6. `cloudClient` 拦截器改为：**有 JWT 用 JWT，没有则用 API Key**；JWT 过期（401 + `token_expired`）→ 触发重新签名。

**必须同步改的存量**：

| 位置 | 现状 | 改法 |
|---|---|---|
| `usePawStore.ts:9-20` | `localStorage['apipaw.api_key']` | 改为 SecureStore；新增 `sessionToken` / `sessionExpiresAt` / `walletAddress` |
| `usePawStore.ts:37,65` | `roleMode` 本地开关 | 改为**服务端返回的 `role` 驱动**（本地开关降级为"视图偏好"，不再是权限来源） |
| `usePawStore.ts:73` | 硬编码 `creatorWallet` | 保留（创作者身份 ≠ 登录钱包），但 UI 上要区分清楚 |
| `App.tsx:376-423` | 只有"设置密钥"弹窗 | 增加「连接钱包」入口 + 账户页（Key 列表、吊销、轮换） |
| `App.tsx:177` `OwnerDashboard` | 缺 `my_nodes` 字段 | 补类型并渲染"我的节点收益" |
| `cloudClient.ts:31-35` | 只注 `Bearer <apiKey>` | 改为按会话状态选择凭证 |

**e2e 改造**（**不要用后门开关**，见红线）：

- `e2e/live-console.cjs:26`、`e2e/design-check.cjs:21`：已有 `process.env.APIPAW_API_KEY` 覆盖 → 改为读 env（**不再硬编码兜底**）。
- `e2e/limit-sync.cjs:19`：**连 env 覆盖都没有** → 补齐。
- 业主钱包登录的 e2e：在 CI 里放一个**专用测试钱包私钥**（仅测试网/测试账户），
  用 `ethers` 真实生成签名走完整流程 —— **不引入任何"跳过验签"的生产开关**。
  测试钱包地址需**事先**在 `node_credentials` 里登记对应节点，或走"待审核"分支。

---

## 5. 模块 B · 买家侧：API Key 自助签发台

### 5.1 目标用户旅程

```
开发者访问 cloud.apipaw.com（或 App 内「获取 API Key」）
  → 选择：① 用钱包快速签发（无邮箱，30 秒）  ② 用邮箱申请（可后续核验）
  → （如需）钱包签名证明身份 / 邮箱验证码
  → 系统创建 BUYER 账户 + 一把新 Key
  → **明文 Key 只在这一次返回**（页面上明确提示："请立即保存，关闭后无法再次查看"）
  → 进入密钥台：查看 Key 列表（前缀 + 后 4 位）、新建、轮换、吊销
  → 用 Key 调 /v1/chat/completions，余额从 $0 起，充值走阶段三的充值接口
```

### 5.2 数据库操作（新建条目并赋予 BUYER 角色）

**核心写入（一个事务内完成，遵循阶段三 `BEGIN IMMEDIATE` 的做法）**：

```sql
BEGIN IMMEDIATE;
  INSERT INTO users (api_key, account_handle, balance_usd, daily_limit_usd,
                     created_at, role, status, email, display_name, account_type)
  VALUES ('', 'acct_<hex>', 0.0, 5.0, ?, 'BUYER', 'active', ?, ?, 'APIKEY');
  -- ↑ role 显式写 'BUYER'；balance 初始 0（D8）；daily_limit 建议 $5
  INSERT INTO api_keys (account_handle, key_hash, key_prefix, key_last4,
                        scopes, daily_limit_usd, status, created_at)
  VALUES ('acct_<hex>', sha256(明文), 'paw-sk-1a2b3c', 'c3f9', 'chat,usage,analytics', 0, 'active', ?);
COMMIT;
```

> ⚠️ **`users.api_key` 有 `NOT NULL UNIQUE` 约束**（`db.py:279`）→ 账户句柄化后该列必须允许为空或写入占位值。
> 二选一：① 放宽为可空（`ALTER` 改不了 NOT NULL，需重建表 → **有风险**）；
> ② **保留 NOT NULL，写入一个非秘密占位符**（推荐：`api_key = account_handle`，即 `acct_xxx`）。
> ② 改动最小、且天然保证"新账户的 api_key 列里没有秘密"。

**明文 Key 的生成与展示**：

```
secret   = "paw-sk-" + secrets.token_hex(16)      # 32 字节熵, 与阶段三现状一致
key_hash = sha256(secret).hex()
key_prefix = secret[:11]      # 'paw-sk-1a2b3c'
key_last4  = secret[-4:]
```

**账户句柄**：

```
account_handle = "acct_" + secrets.token_hex(8)
```

### 5.3 密钥存储与展示策略

| 场景 | 允许看到 | 禁止看到 |
|---|---|---|
| 签发瞬间（响应体） | 完整明文一次 | —— |
| 密钥列表 / 账户页 | `key_prefix` + `key_last4` + 标签 + 创建时间 + 最后使用时间 + 状态 | 完整明文、哈希 |
| 日志 / 错误信息 / 审计 | `key_prefix` | **完整明文**（阶段三已把 PAT 回显到终端的教训必须推广到 Key） |
| 数据库 | **只有哈希** | 明文（历史账户迁移后清空） |

### 5.4 密钥生命周期

| 动作 | 端点 | 语义 |
|---|---|---|
| 签发 | `POST /api/v1/user/keys` | 新建一把，可指定 `label` / `scopes` / `daily_limit_usd` |
| 列表 | `GET /api/v1/user/keys` | 只回 prefix/last4/状态/时间/scopes |
| 轮换 | `POST /api/v1/user/keys/{id}/rotate` | **作废旧 Key + 立即签发新 Key**，旧 Key 立即失效（`status='revoked'`） |
| 吊销 | `POST /api/v1/user/keys/{id}/revoke` | 不可恢复；吊销后该 Key 的请求立即 401 |
| 自助限额 | `PUT /api/v1/user/limit` | 阶段三已有 `daily_limit_usd`，扩展为"账号级 + Key 级"（Key 级为 0 时继承账号级） |

### 5.5 滥用防护（H2 的正面解决）

| 维度 | 规则（建议起值） | 落地位置 |
|---|---|---|
| 单 IP 签发频率 | ≤ 3 把 / 小时 | `auth_nonces`/新表 `rate_limit`（内存 + DB 落盘） |
| 单 IP / 日 | ≤ 10 把 | 同上 |
| 单邮箱 / 日 | ≤ 2 把 | 同上 |
| 全局 / 日 | 阈值告警 | 运维面板 |
| 初始额度 | **$0**；核验用户可给 $0.5（且 `daily_limit_usd = 1`） | `users.balance_usd` |
| 试探性刷号检测 | 同 IP 批量注册 → `status='suspended'` | 风控任务 |
| 推理匿名兜底 | **移除** `or DEMO_API_KEY` | `server.py:1372` |

> **限流实现注意**：单 worker + systemd，`in-memory` 限流重启即失效；
> 建议**内存计数 + SQLite 落盘**（或直接用 `auth_rate_limits` 表做原子 `INSERT ... ON CONFLICT`——
> ⚠️ 但生产 SQLite 3.7.17 **无 UPSERT**，需沿用阶段三 `smooth_upsert` 的兼容写法）。

### 5.6 前端改造（买家侧）

- 新增「开发者控制台 / 密钥台」入口：
  - 签发新 Key（钱包签名或邮箱）
  - Key 列表（前缀 + 后4 + 状态 + 最后使用时间）
  - 轮换 / 吊销（**吊销要二次确认**，并提示"该 Key 的调用将立即失败"）
  - 明文展示页（**一次性 + 复制按钮 + "我已保存"确认后关闭**，避免误关导致丢失）
- 现有 `App.tsx:376-423`「设置密钥」弹窗：保留（允许手填已有 Key），
  但引导文案改为"没有 Key？去签发台自助获取"，并**移除硬编码兜底**。
- 顶部余额卡：`balance_usd` 从 `$100.0` 的本地常量改为**服务端真值**（阶段三已做，
  阶段四再把 `role` 一并由服务端驱动）。

---

## 6. 实施路线图

> 每个阶段独立可交付、独立可回滚；**不合并大爆炸**。

| 阶段 | 内容 | 出口标准 | 预估风险 |
|---|---|---|---|
| **P0 前置修补** | 移除 `or DEMO_API_KEY` 匿名兜底；`/api/v1/auth/apikey` 加限流 + **初始额度降到 $0**；密钥日志脱敏 | 无 Key 推理 401；签发台仍可用但不再白送 | 🟢 低（改 2–3 行 + 限流表） |
| **P1 账户基础层** | `users` 加列；`api_keys` / `auth_nonces` / `auth_sessions` / `auth_wallets` 建表；**句柄化迁移 M2–M5**；`resolve_credential()` 统一化；`get_user_by_key` 双读回落 | 沙箱全量账实相符不变；生产 M2–M5 后 `integrity_check ok` | 🟠 中（M3 数据形状变更） |
| **P2 买家签发台** | 注册/签发/列表/轮换/吊销端点；哈希存储；限流；**测试邮箱/钱包**；密钥台前端 | 新买家能自助拿 Key 并成功推理；旧 Key 仍可用 | 🟢 低 |
| **P3 业主签名登录** | `keccak256` + `secp256k1` 纯 Python 实现 + **公开向量测试**；nonce/verify 端点；JWT 签发校验；`auth_sessions` 撤销；`GET /api/v1/owner/nodes/revenue`；`nodes_history.owner_handle` 补列 | 测试钱包可登录并**只看到自己的**节点收益 | 🟠 中（自研密码学 → 必须交叉验证） |
| **P4 前端切换** | Pocket：钱包连接、SecureStore、会话自动续期、密钥台、移除硬编码；e2e 三脚本改造 | e2e 24/24（改造后）；真实钱包登录手工验收通过 | 🟡 中（RN 依赖新增） |
| **P5 收尾** | **M6 清明文**（作废历史 Key，含 `paw_demo_key`）；`paw_demo_key` 从代码与 e2e 中彻底移除；`DEMO_API_KEY` 常量删除 | 全库无明文秘密；`grep -R "paw_demo_key"` 生产代码 **0 命中** | 🟠 中（**用户感知点**：旧 Key 需重新签发） |

**关键顺序约束**：

1. **P5 必须在 P2/P3 之后** —— 否则买家拿不到新 Key、业主登不上，系统直接不可用。
2. **P3 的"自研密码学"必须有独立验证关口**：CI 中用 `eth-account`（仅开发机，**不进生产 venv**）
   生成向量，与纯 Python 实现逐字节比对；并跑 RFC6979 / 以太坊官方用例。**比对不过不得上线**。
3. **P0 与主线可并行**，但 P0 的"初始额度降到 $0"会改变现有演示体验 → 需同步更新
   `docs/BACKEND-REFACTOR-TODO.md` 与相关 e2e 假设。

---

## 7. 验证矩阵

### 7.1 模块 A（钱包登录）

| # | 用例 | 期望 |
|---|---|---|
| A1 | `POST /api/v1/auth/nonce` 合法地址 | 200，返回 nonce + 完整 SIWE message |
| A2 | 同上，IP 高频 | 429（限流） |
| A3 | `verify` 用**别家域名**的 message | 400（message 与服务端重算不符） |
| A4 | `verify` 用**别的 nonce** 的签名 | 400（nonce 不匹配） |
| A5 | 同 nonce **重放** | 400（nonce 已用，原子 UPDATE 判定） |
| A6 | nonce 过期（>10min） | 400 |
| A7 | 签名被改 1 bit | 400（验签失败） |
| A8 | `s` 为高值（> n/2） | 400（EIP-2 低 s 校验） |
| A9 | `v` 为 29/30 | 400 |
| A10 | 合法签名 | 200 + JWT，`exp` = iat + 7200 |
| A11 | 用 JWT 访问 `/api/v1/owner/nodes/revenue` | 200，**只含该钱包名下节点** |
| A12 | 用 A 钱包的 JWT 访问 B 钱包的节点 | 200 但 `nodes` 为空（**不越权**） |
| A13 | JWT 过期后调用 | 401 + `token_expired` |
| A14 | 手动撤销 session 后调用 | 401 |
| A15 | 该账户 `status='suspended'` 后调用 | 401（**以 DB 为准**，忽略载荷里的 role） |
| A16 | 篡改 JWT 载荷里的 `role='OWNER'` 但签名不符 | 401（签名校验先失败） |
| A17 | 篡改载荷 `role` 并**重签**（拿得到密钥的情况） | 仍按 DB role 判定 → 403（**D2 生效**） |
| A18 | keccak/secp256k1 与参考实现交叉验证 | 全部向量一致 |
| A19 | 验签耗时 | 单次 < 50ms，且不阻塞事件循环 |

### 7.2 模块 B（签发台）

| # | 用例 | 期望 |
|---|---|---|
| B1 | `POST /api/v1/user/keys` 无任何凭证 | 401（**必须已登录**） |
| B2 | 已登录买家签发 | 200，明文 Key **仅此一次** |
| B3 | 再调列表 | **看不到**明文，只有 prefix + last4 |
| B4 | 直接查 `users.api_key` / `api_keys` | 无明文（仅哈希） |
| B5 | 新 Key 调 `/v1/chat/completions` | 200，扣费记到**新账户** |
| B6 | 无 Key 调 `/v1/chat/completions` | **401**（H3 已修） |
| B7 | 同一 IP 连续签发 > 3 把/小时 | 429 |
| B8 | 吊销 Key 后再调用 | 401 |
| B9 | 轮换后旧 Key 调用 | 401，新 Key 200 |
| B10 | 新账户初始余额 | **$0**（非 $10） |
| B11 | `role` | `BUYER`，无法访问 owner 端点（403） |
| B12 | 买家试图自助升 role | 403（role 不可由客户端写入） |
| B13 | 存量 Key（迁移前签发）继续可用 | 200（M5 双读回落生效） |
| B14 | 迁移后账实相符 | `账本净额 == users.balance_usd`（M3 后仍成立） |
| B15 | `PRAGMA integrity_check` | ok |

### 7.3 全局回归

| # | 用例 | 期望 |
|---|---|---|
| G1 | 阶段三 21 项生产矩阵 | 全部仍通过 |
| G2 | 阶段三沙箱 56 项 | 全部仍通过 |
| G3 | 阶段三批次 2/3 沙箱（32/74 项） | 全部仍通过 |
| G4 | Pocket e2e（改造后） | 24/24 |
| G5 | `grep -R "paw_demo_key" /opt/apipaw-cloud` | P5 后 **0 命中** |
| G6 | 两库 `integrity_check` | ok |

---

## 8. 迁移与回滚

| 场景 | 动作 | 恢复目标 |
|---|---|---|
| M3 迁移出错 | 用 `backups/apipaw_YYYYMMDD-pre-phase4-migrate.db` 覆盖恢复 | 迁移前快照 |
| P1 上线后 `resolve_credential` 异常 | `git checkout -- server.py db.py` + 重启 | P0 状态 |
| P3 验签实现有 bug | **功能开关** `AUTH_WALLET_ENABLED=0` 关闭钱包登录（保留签发台），JWT 路径保留但拒新签发 | 回到 P2 |
| P5 后用户反馈旧 Key 失效 | 从 `backups/` 恢复旧库 → 重新执行 M2–M5 但保留 M6 | 迁移后未清明文态 |
| JWT 密钥泄漏 | 撤销全部 `auth_sessions` + 换 `JWT_SECRET`（双密钥轮换） | 用户重新签名 |
| 数据库损坏 | `.backup` 快照覆盖 | 最近快照 |

> **红线上线纪律（沿用阶段三）**：任何写操作前必做 `.backup` 双库快照；
> 沙箱（源站 Python 3.6.8 + SQLite 3.7.17 的副本库）先跑通 → 生产再执行 → 矩阵复核 → 提交。

---

## 9. 红线与边界

| 红线 | 内容 |
|---|---|
| 🚫 **不新增生产依赖**（未经批准） | 阶段四默认**零新依赖**；若要装 `eth-account` 等，必须先在开发机验证 3.6.8 兼容性并单独评审 |
| 🚫 **不引入"跳过验签"开关** | e2e 用**真实测试钱包私钥**签名，不开后门 |
| 🚫 **不修改 `git config`** | 身份用 `-c` 单次传参；提交用 `git commit -F <UTF-8 文件>` |
| 🚫 **不动 `3X-UI`（2053 / 39821）与 `/opt/apipaw-cloud` 之外的任何服务** | —— |
| 🚫 **不改计费语义** | 预扣—结算、账实相符、`daily_spend` 原子计数一律不动；句柄化只换**标识**，不改**算法** |
| 🚫 **生产库不进 git** | `*.db` + `backups/` 双保险（阶段三已就位） |
| 🚫 **不在日志/响应里回显完整 Key 或 JWT** | 统一 `key_prefix` + `key_last4` |
| 🚫 **不在公网暴露 `paw_demo_key` / 新签发的真实 Key** | e2e 一律走 env |
| ⚠️ **不改 `node_credentials` 表结构** | 归属链阶段三已定型；本阶段只加 `nodes_history.owner_handle` |

---

## 10. 遗留与风险

| # | 风险/遗留 | 影响 | 缓解 |
|---|---|---|---|
| R1 | **自研密码学实现错误** | 验签被绕过 = 业主权限沦陷 | 公开向量 + 与 `eth-account` 交叉验证 + 代码审查 + A18 关口卡上线 |
| R2 | **源站 Python 3.6.8 已 EOL** | 新库装不上；安全补丁缺失 | 阶段四零依赖；**中期应规划 Python 升级**（独立议题，不夹带） |
| R3 | **纯 Python 验签耗时** | 单 worker 下并发签名可能成为瓶颈 | `run_in_executor` + 验签结果缓存（nonce 一次性，天然防重放）+ 必要时加限流 |
| R4 | **"签钱包即 OWNER"** | 任何人可自封业主 | 自动关联 `node_credentials.owner_wallet` 优先；否则进待审核 |
| R5 | **无 refresh token → 业主每 2h 要重新签名** | 体验摩擦 | 可选：把过期时间调到 24h（安全与体验的权衡），或引入"钱包+设备绑定"的长期会话（**需重新评审**） |
| R6 | **Key 哈希用 sha256 而非慢哈希** | 若 Key 熵不足则可爆破 | Key 熵 32 字节随机（`token_hex(16)`）→ 暴力不可行；**不要缩短熵** |
| R7 | **句柄化迁移 M3 触碰 4 张表** | 数据错位 = 账实不符 | 快照 + 沙箱先行 + 迁移后账实相符校验 + 索引重建确认 |
| R8 | **P5 清明文 = 旧 Key 全失效** | 老用户/脚本中断 | 提前公告 + 提供自助重签 + 保留 30 天宽限期（宽限期内双读回落） |
| R9 | **钱包支持面** | 小众钱包不兼容 | 只认 EIP-1193 / `personal_sign`（EIP-191），覆盖 MetaMask/OKX/Phantom 等主流 |
| R10 | **`paw_demo_key` 已在 public 仓库**（阶段三遗留） | 攻击者可冒用业主 | **与 R8 一并处理**：P5 轮换该 Key；并推动 `e2e` 改 env + 轮换 GitHub PAT |

---

## 11. 附录 · 接口契约速查

### 11.1 业主侧（钱包）

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| POST | `/api/v1/auth/nonce` | `{address, chain_id}` | `{nonce, message, domain, uri, chain_id, expires_at}` |
| POST | `/api/v1/auth/verify` | `{address, message, signature}` | `{access_token, token_type, expires_in, user:{handle, role, wallet, status}}` |
| POST | `/api/v1/auth/logout` | — | `{status:"success"}`（撤销 jti） |
| GET | `/api/v1/owner/nodes/revenue` | — | `{owner_wallet, nodes_total, nodes_online, total_earnings_paw, total_tokens_processed, nodes[]}` |

### 11.2 买家侧（签发台）

| 方法 | 路径 | 入参 | 出参 |
|---|---|---|---|
| POST | `/api/v1/auth/register` | `{email?, display_name?, wallet?}` | `{api_key(仅此一次), account_handle, key_prefix, key_last4, role:"BUYER", balance_usd:0.0}` |
| GET | `/api/v1/user/keys` | — | `[{id, key_prefix, key_last4, label, scopes, status, created_at, last_used_at}]` |
| POST | `/api/v1/user/keys` | `{label?, scopes?, daily_limit_usd?}` | `{api_key(仅此一次), id, key_prefix, key_last4, …}` |
| POST | `/api/v1/user/keys/{id}/rotate` | — | `{api_key(仅此一次), revoked_key_prefix}` |
| POST | `/api/v1/user/keys/{id}/revoke` | — | `{status:"success"}` |

### 11.3 统一错误语义

| 状态码 | 含义 | 典型 `detail` |
|---|---|---|
| 400 | 签名/消息/nonce 校验失败 | `签名验证失败` / `nonce 已使用` / `domain 不匹配` |
| 401 | 凭证缺失/无效/过期/已吊销 | `无效的 API Key` / `token_expired` / `账号已停用` |
| 403 | 身份有效但无权限 | `该账号不是 OWNER，无权访问业主接口` |
| 404 | 资源不存在 | `节点不存在: xxx` |
| 429 | 限流 | `请求过于频繁，请稍后再试` |

> 所有错误响应**不得回显完整 Key / JWT / 签名原文**。

### 11.4 预计改动文件清单（供排期用）

| 文件 | 改动性质 |
|---|---|
| `/opt/apipaw-cloud/db.py` | 新增 4 张表 + `users` 补列 + 句柄化迁移 + `api_keys` CRUD + `auth_*` CRUD + `get_user_by_handle` |
| `/opt/apipaw-cloud/server.py` | `resolve_credential()` 统一化 + 8 个新端点 + 移除匿名兜底 |
| `/opt/apipaw-cloud/auth_wallet.py`（**新**） | keccak256 + secp256k1 + SIWE 消息拼装 + JWT 签发/校验 |
| `/opt/apipaw-cloud/requirements.txt` | **不变**（零新依赖，需复核 `python-dotenv` 已随 venv 存在） |
| `D:\APIPawPocket\src/api/cloudClient.ts` | 凭证注入策略（JWT 优先） |
| `D:\APIPawPocket\src/store/usePawStore.ts` | 会话状态 + SecureStore + 服务端角色 |
| `D:\APIPawPocket\App.tsx` | 钱包连接入口 + 密钥台 + `my_nodes` 渲染 |
| `D:\APIPawPocket/e2e/*.cjs` | 三脚本去硬编码 + 真实签名流程 |
| `D:\APIPawPocket\docs/BACKEND-REFACTOR-TODO.md` | 追加阶段四 TODO 条目（TODO-19 ~ TODO-2x） |

---

## 12. 下一步

1. 本蓝图评审 → 确认 §2.3 的 12 条决策，尤其是 **D2（授权以 DB 为准）**、**D3（零依赖自研密码学）**、**D8（初始额度 $0）**、**R8（旧 Key 失效的用户沟通）**。
2. 用户确认后：先做 **P0 前置修补**（小、可独立上线、立刻堵住 H2/H3）。
3. 再做 **P1 账户基础层**（含 M2–M5 句柄化迁移，**需单独授权数据迁移**）。
4. P3 的密码学实现建议**单开一个评审关口**：先交"实现 + 测试向量 + 交叉验证报告"，评审通过再接端点。

> **2026-11-10 更新**：1~3 已完成（P0/P1/P2 已上线生产，见文首「实施进度」）。
> 当前第 4 条生效：**P3（业主钱包签名登录）** 是下一步 —— 先交"实现 + 测试向量 +
> 交叉验证报告"（用 `eth-account` 在**开发机**生成向量与纯 Python 实现逐字节比对，
> `eth-account` **绝不进生产 venv**），评审通过再接 nonce/verify 端点。
> P3 之后依次是 P4（Pocket 前端切钱包会话）与 P5（M6 清明文、作废历史 Key）。
