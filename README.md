<div align="center">

# APIPaw Pocket

**Web3 掌上控制台 · The Pocket Console for DePIN Networks**

[English](#english) | [中文](#中文)

[![Live](https://img.shields.io/badge/live-pocket.apipaw.com-22D3EE?style=flat-square)](https://pocket.apipaw.com)
[![Expo](https://img.shields.io/badge/Expo-SDK%2058-000000?style=flat-square&logo=expo&logoColor=white)](https://docs.expo.dev/)
[![React Native](https://img.shields.io/badge/React%20Native-0.88-20232A?style=flat-square&logo=react&logoColor=61DAFB)](https://reactnative.dev/)
[![License](https://img.shields.io/badge/license-MIT-34D399?style=flat-square)](LICENSE)

</div>

---

## 中文

### 什么是 APIPaw Pocket

APIPaw Pocket 是一款专为 **DePIN（去中心化物理基础设施网络）** 打造的 **Web3 掌上控制台**。
它把分散在云端的算力节点、账单流水与推理模型收敛进一个随身可开的仪表盘：

- **云端节点状态看板** —— 在线挂机节点、注册节点总量、单节点远控开关，一屏掌握全网算力心跳；
- **实时账单大盘** —— 账户余额、今日实时消费、单日消费上限，配 Token 额度与结算明细；
- **模型 Playground** —— 直连 APIPaw 网关的流式推理试验台，内置思考链（Chain-of-Thought）实时回显与一键代码导出。

同一套代码同时产出 **Web 静态站** 与 **原生 App**（Expo / React Native），视觉上采用强制的
**暗黑科幻 / Web3 DePIN** 语言：近纯黑底色 + 极光渐变、磨砂玻璃卡片、霓虹渐变描边、渐变数字、
呼吸状态灯，以及一台「真有内阴影」的终端式对话区。

线上地址：**https://pocket.apipaw.com**

### 极客技术栈

| 层 | 选型 |
| --- | --- |
| 应用框架 | Expo SDK 58 · React Native 0.88 · React 19.3 · TypeScript |
| Web 渲染 | react-native-web 0.21（同一套 RNX 代码编译成静态站） |
| 视觉层 | 自研 **玻璃拟态 UI 设计系统** + 运行时注入的专属 CSS 主题层 |
| 图形 | react-native-svg（自绘拓扑 / 图表）· lucide-react-native |
| 状态 | zustand 5 |
| 网络 | axios + 自研 SSE 流式客户端（`src/api/cloudClient.ts`） |
| 产物 | `expo export -p web` → 纯静态站点，可部署在任何 Nginx / 对象存储上 |

#### 为什么是「RN + 注入 CSS」而不是 Tailwind

react-native-web **不支持 `className` prop**（`className` 是从 StyleSheet 反推出来的），
也不支持 `experimental_backgroundImage`。所以本项目采用：

1. React Native 0.88 的 `View` / `Text` 自带 `id?: string` prop，RNW 会把它原样映射到 DOM 的 `id`；
2. 专属 CSS 用属性选择器 `[id^="apx-xxx"]` 挂载 —— 天然支持同前缀多元素，无需维护唯一类名；
3. 主题 CSS 以字符串形式在模块顶层注入 `<style data-apipaw-theme>`（首屏无闪烁），
   挂载后再挪到 `<head>` 末尾，保证同优先级下胜过 RNW 运行时插入的原子类。

于是 `backdrop-filter`、渐变描边、渐变文字（`background-clip: text`）、`:hover` 反馈、
呼吸灯关键帧动画、终端内阴影等纯 Web 能力，全部可用，且**不牺牲原生端的可移植性**。

### 功能特性

- **双视角切换** —— 买家视角（余额 / Playground / 大盘）与业主视角（算力节点远控面板 / 模型工作台 / 版税大盘）；
- **节点远控** —— 每个算力节点一颗拨动开关（Switch），取代臃肿的整行大按钮；
- **流式推理 Playground** —— SSE 逐字回显、TTFT / tok-s / 花费 / CGas 实时统计条；
- **思考链可视化** —— 可折叠的推理过程卡片与打字机效果；
- **单日限额调节** —— 滑块拖动即回写网关，落库到真实 `daily_limit_usd`；
- **密钥本地化** —— API Key 只存在浏览器 `localStorage`，绝不烤进 bundle；
- **响应式布局** —— 900px 断点自动降级为单列。

### 快速开始

```bash
npm install          # 安装依赖
npm run web          # 本地开发服务器（默认 http://localhost:8081）
npm run typecheck    # TypeScript 类型检查
npm run build:web    # 产出静态站点到 dist/
```

### 目录结构

```
App.tsx                     仪表盘主界面（顶栏 / 余额卡 / 看板 / 节点面板）
src/theme.ts                设计令牌：深空配色、间距、字号刻度
src/ui/webTheme.ts          Web 专属 CSS 主题层（id 前缀钩子 + 注入策略）
src/components/ui.tsx       设计系统原子件：Surface / StatTile / Toggle / StatusDot / Toast
src/components/             Playground / Analytics / ModelStudio / PipelineMesh / Royalty 卡片
src/api/cloudClient.ts      网关客户端：REST + SSE 流式推理
src/store/usePawStore.ts    zustand 全局状态
e2e/                        Playwright 验收脚本（设计 / 限额回写 / 线上巡检）
```

### 部署须知

`expo export -p web` 产出的资源路径是绝对路径 `/_expo/...`，
因此 **必须挂在域名根路径下**（子域名可以，子路径不行），并为 SPA 配置 fallback：

```nginx
location / {
    root /var/www/apipaw-pocket;
    try_files $uri $uri/ /index.html;
}
```

### 验收脚本

```bash
# 设计 / 视觉验收（自起静态服务器服务 dist/）
NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/design-check.cjs

# 限额回写回归（全链路拦截，不碰线上）
NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/limit-sync.cjs

# 线上巡检
NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/live-console.cjs https://pocket.apipaw.com
```

### 许可证

[MIT](LICENSE) © APIPaw

---

## English

### What is APIPaw Pocket

APIPaw Pocket is a **Web3 pocket console built for DePIN (Decentralized Physical
Infrastructure Networks)**. It collapses distributed compute nodes, billing ledgers and
inference models into a single portable dashboard:

- **Cloud node dashboard** — online idle nodes, total registered nodes and a per-node remote
  switch, so the whole compute heartbeat fits on one screen;
- **Real-time billing dashboard** — account balance, today's live spend and the daily spend
  cap, together with Token quota and settlement details;
- **Model Playground** — a streaming inference bench wired straight to the APIPaw gateway,
  with live Chain-of-Thought replay and one-click code export.

A single codebase ships both the **static web site** and the **native app** (Expo / React
Native), rendered in a forced **dark sci-fi / Web3 DePIN** language: near-black canvas with
aurora gradients, frosted-glass cards, neon gradient borders, gradient-filled numerals,
breathing status lights and a conversation area that behaves like a real terminal.

Live site: **https://pocket.apipaw.com**

### Geek tech stack

| Layer | Choice |
| --- | --- |
| App framework | Expo SDK 58 · React Native 0.88 · React 19.3 · TypeScript |
| Web rendering | react-native-web 0.21 (the same RNX code compiles to a static site) |
| Visual layer | In-house **glassmorphism design system** + a runtime-injected CSS theme layer |
| Graphics | react-native-svg (hand-drawn topology / charts) · lucide-react-native |
| State | zustand 5 |
| Networking | axios + a bespoke SSE streaming client (`src/api/cloudClient.ts`) |
| Output | `expo export -p web` → a pure static site, deployable to any Nginx / object storage |

#### Why "RN + injected CSS" instead of Tailwind

react-native-web does **not** support the `className` prop (`className` is derived from the
StyleSheet) nor `experimental_backgroundImage`. This project works around that:

1. React Native 0.88's `View` / `Text` accept an `id?: string` prop, which RNW maps verbatim
   to the DOM `id` attribute;
2. the theme CSS hooks onto elements via the attribute selector `[id^="apx-xxx"]` — one prefix
   may cover many elements, and no unique class names have to be maintained;
3. the theme is a CSS string injected at module top level as `<style data-apipaw-theme>`
   (no first-frame flash), then re-appended to the end of `<head>` so it wins ties against
   the atomic stylesheet RNW injects at runtime.

That unlocks `backdrop-filter`, gradient borders, gradient text (`background-clip: text`),
`:hover` feedback, breathing-light keyframes and terminal inner shadows — all pure-Web
capabilities, without giving up native portability.

### Features

- **Dual persona** — buyer view (balance / Playground / analytics) and owner view
  (node remote control / model studio / royalty dashboard);
- **Node remote control** — a refined switch per compute node, replacing the old
  full-width red buttons;
- **Streaming Playground** — SSE token-by-token output plus a live TTFT / tok-s / cost / CGAs strip;
- **Chain-of-Thought visualisation** — collapsible reasoning cards with a typewriter effect;
- **Daily cap control** — drag the slider and the new `daily_limit_usd` is written back to the gateway;
- **Local-only credentials** — the API key lives in `localStorage` and is never baked into the bundle;
- **Responsive layout** — collapses to a single column below 900px.

### Quick start

```bash
npm install          # install dependencies
npm run web          # dev server (http://localhost:8081)
npm run typecheck    # TypeScript check
npm run build:web    # static export into dist/
```

### Project layout

```
App.tsx                     dashboard shell (header / balance card / tiles / node panel)
src/theme.ts                design tokens: deep-space palette, spacing, type scale
src/ui/webTheme.ts          web-only CSS theme layer (id-prefix hooks + injection)
src/components/ui.tsx       design-system atoms: Surface / StatTile / Toggle / StatusDot / Toast
src/components/             Playground / Analytics / ModelStudio / PipelineMesh / Royalty cards
src/api/cloudClient.ts      gateway client: REST + SSE streaming inference
src/store/usePawStore.ts    zustand global state
e2e/                        Playwright acceptance scripts (design / limit write-back / live)
```

### Deployment notes

Assets emitted by `expo export -p web` use absolute paths (`/_expo/...`), so the site **must be
served from the domain root** (a subdomain is fine, a sub-path is not) with an SPA fallback:

```nginx
location / {
    root /var/www/apipaw-pocket;
    try_files $uri $uri/ /index.html;
}
```

### License

[MIT](LICENSE) © APIPaw
