/**
 * 阶段二十四 P1 · 「前端轮询风暴 / 120ms 重渲染」的**源码级回归闸门**。
 *
 * 为什么要有这个用例
 * ------------------
 * 这轮改造把两件事钉死了：
 *   ① PlaygroundCard 的**父组件**不再持有 120ms 定时器
 *      （计时与性能读数下沉到 ReasoningCard / LiveRunStats 两个微组件）；
 *   ② 三个轮询卡片（LiveSettlementFeed 20s / NodeLeaderboardCard 30s /
 *      SmartAlertCard 30s）统一改用 `useVisibilityInterval`
 *      （页面隐藏 ⇒ 定时器完全停掉；回到前台 ⇒ 立刻补刷一次）。
 *
 * 这两条都是**很容易被后来的改动悄悄改回去**的（"顺手加个 setInterval 刷新一下"
 * 是最常见的回退方式），所以用单测把源码形态钉死 —— 比截图断言可靠得多。
 *
 * 跑法（Git Bash / 仓库根目录）：
 *   node e2e/unit-playground-timer.mjs
 *
 * 依赖：Node >= 22.6（仅读文件 + 正则，不需要类型剥离；但仓库 CI 用 Node 22）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const RESULTS = [];
function record(name, ok, detail = '') {
  RESULTS.push({ name, ok, detail });
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? ' | ' + detail : ''));
}

const playground = read('src/components/PlaygroundCard.tsx');

/** 去掉注释后再做源码形态断言 —— 注释里提到旧代码（教学价值）不应被误判。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

const playgroundCode = stripComments(playground);

// ---------------------------------------------------------------- ①
record('①1. PlaygroundCard 里不再有父级 tick state（setTick）',
  !/setTick/.test(playgroundCode),
  /setTick/.test(playgroundCode) ? '仍存在 setTick' : '');

record('①2. PlaygroundCard 里不再有 [tick, streaming, ...] 依赖',
  !/\[\s*tick\s*,/.test(playgroundCode));

// 120ms 定时器只允许出现在两个微组件里（各自局部 state）
const intervalLines = playgroundCode
  .split('\n')
  .map((line, idx) => ({ line, idx }))
  .filter(({ line }) => /setInterval\(/.test(line));

/** 字符偏移 → 行号（1 起） */
const lineOf = (src, offset) => src.slice(0, offset).split('\n').length;

const reasoningIdx = lineOf(playgroundCode, playgroundCode.indexOf('const ReasoningCard'));
const liveStatsIdx = lineOf(playgroundCode, playgroundCode.indexOf('const LiveRunStats'));
const mainIdx = lineOf(playgroundCode, playgroundCode.indexOf('const PlaygroundCard: React.FC'));

const inMicro = ({ idx }) =>
  (reasoningIdx >= 0 && idx > reasoningIdx && idx < liveStatsIdx) ||
  (liveStatsIdx >= 0 && idx > liveStatsIdx && idx < mainIdx);

record('①3. 120ms 定时器只剩微组件内部那两处',
  intervalLines.length === 2 && intervalLines.every(inMicro),
  `共 ${intervalLines.length} 处，位置 ${intervalLines.map((x) => x.idx + 1).join(',')}`);

record('①4. 实时性能读数已下沉到 LiveRunStats 微组件',
  liveStatsIdx > 0 && /const LiveRunStats: React\.FC/.test(playground));

record('①5. 流式实时读数走微组件（不再往 messages 里写 partial stats）',
  /isLive && runRef\.current/.test(playground)
  && !/stats: \{[\s\S]{0,400}?partial: true,[\s\S]{0,200}?\},\s*\n\s*:\s*m,/.test(playground));

// ---------------------------------------------------------------- ②
const pollingCards = [
  ['src/components/LiveSettlementFeed.tsx', 'REFRESH_MS'],
  ['src/components/NodeLeaderboardCard.tsx', 'REFRESH_MS'],
  ['src/components/SmartAlertCard.tsx', 'REFRESH_INTERVAL_MS'],
];

for (const [rel, constName] of pollingCards) {
  const src = read(rel);
  const name = rel.split('/').pop();
  record(`②${name} 不再有裸 setInterval`,
    !/setInterval\(/.test(src), /setInterval\(/.test(src) ? '仍有 setInterval' : '');
  record(`②${name} 改用 useVisibilityInterval`,
    /useVisibilityInterval\(/.test(src));
  record(`②${name} 轮询间隔常量 ${constName} 保持不变`,
    new RegExp(`const ${constName} = \\d+;`).test(src),
    (src.match(new RegExp(`const ${constName} = \\d+;`)) || [''])[0]);
}

// 三个卡片的间隔必须还是 20s / 30s / 30s（口径不能被顺手改掉）
const settle = read('src/components/LiveSettlementFeed.tsx');
const board = read('src/components/NodeLeaderboardCard.tsx');
const alert = read('src/components/SmartAlertCard.tsx');
record('②轮询节奏 = 20s / 30s / 30s',
  /const REFRESH_MS = 20000;/.test(settle)
  && /const REFRESH_MS = 30000;/.test(board)
  && /const REFRESH_INTERVAL_MS = 30000;/.test(alert));

// ---------------------------------------------------------------- ③
const hook = read('src/hooks/useVisibilityInterval.ts');
const core = read('src/hooks/visibilityIntervalCore.ts');
record('③1. 可见性轮询核心逻辑已独立成可单测模块',
  /createVisibilityInterval/.test(core));
record('③2. 核心模块不依赖 React（纯逻辑）',
  !/from 'react'/.test(core));
record('③3. hook 只做 React 适配',
  /useEffect/.test(hook) && /createVisibilityInterval/.test(hook));

const app = read('App.tsx');
record('③4. App.tsx 首屏重卡片使用懒挂载容器',
  /LazyMount/.test(app) && /from '\.\/src\/components\/LazyMount'/.test(app));

const failed = RESULTS.filter((r) => !r.ok);
console.log('');
console.log(`[test] 用例 ${RESULTS.length} 个，通过 ${RESULTS.length - failed.length} 个，失败 ${failed.length} 个`);
process.exit(failed.length ? 1 : 0);
