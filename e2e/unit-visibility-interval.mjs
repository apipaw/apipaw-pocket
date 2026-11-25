/**
 * 阶段二十四 P1 · 「可见性感知轮询」纯逻辑单测。
 *
 * 为什么要有这个用例
 * ------------------
 * 三个卡片（LiveSettlementFeed 20s / NodeLeaderboardCard 30s / SmartAlertCard 30s）
 * 改成"页面隐藏 ⇒ 定时器**完全停掉**、回到前台 ⇒ **立刻补刷一次**"之后，
 * 这个口径如果只写在 React hook 里就只能靠 e2e 观察"接口有没有被调用" ——
 * 而 e2e 观察不到"标签页隐藏时定时器真的停了"。
 *
 * 这里直接驱动**纯逻辑核心**（src/hooks/visibilityIntervalCore.ts），
 * 用假定时器把每一步钉死：
 *   A. 页面可见 ⇒ 定时器在跑，按间隔触发回调；
 *   B. 页面隐藏时 start ⇒ **不开表**（零请求）；
 *   C. 定时器触发瞬间页面变隐藏 ⇒ 该次**不触发**回调；
 *   D. 隐藏 ⇒ 可见 ⇒ **立刻补刷一次**，且定时器恢复；
 *   E. 可见 ⇒ 隐藏 ⇒ 定时器**停掉**（isRunning=false）；
 *   F. dispose ⇒ 定时器清空、事件监听摘除（无残留）；
 *   G. 重复 dispose / 重复 start 都幂等。
 *
 * 跑法（Git Bash / 仓库根目录）：
 *   node e2e/unit-visibility-interval.mjs
 *
 * 依赖：Node >= 22.6（原生类型剥离，可直接 import .ts）。
 */

import { createVisibilityInterval } from '../src/hooks/visibilityIntervalCore.ts';

const RESULTS = [];

function record(name, ok, detail = '') {
  RESULTS.push({ name, ok, detail });
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? ' | ' + detail : ''));
}

/** 假环境：可控可见性 + 可手动触发的定时器 + 可统计的订阅数。 */
function makeEnv() {
  const state = {
    visible: true,
    timers: [],          // 活跃定时器句柄列表
    nextId: 1,
    listeners: [],       // 可见性监听列表
    added: 0,
    removed: 0,
  };

  const deps = {
    isVisible: () => state.visible,
    setInterval: (fn, ms) => {
      const id = state.nextId++;
      state.timers.push({ id, fn, ms });
      return id;
    },
    clearInterval: (handle) => {
      state.timers = state.timers.filter((t) => t.id !== handle);
    },
    addEventListener: (fn) => {
      state.listeners.push(fn);
      state.added++;
    },
    removeEventListener: (fn) => {
      state.listeners = state.listeners.filter((f) => f !== fn);
      state.removed++;
    },
  };

  return {
    state,
    deps,
    /** 手动触发所有活跃定时器（模拟时间到点） */
    tickTimers() {
      for (const t of [...state.timers]) t.fn();
    },
    /** 模拟可见性变化 */
    setVisible(v) {
      state.visible = v;
      for (const fn of [...state.listeners]) fn();
    },
  };
}

// ---------------------------------------------------------------- A
{
  const env = makeEnv();
  let calls = 0;
  const c = createVisibilityInterval(env.deps, () => { calls += 1; }, 20000);
  c.start();
  record('A1. 可见时 start ⇒ 定时器在跑', c.isRunning() === true);
  record('A2. 定时器间隔 = 传入的 20000ms',
    env.state.timers.length === 1 && env.state.timers[0].ms === 20000,
    `ms=${env.state.timers[0] && env.state.timers[0].ms}`);
  env.tickTimers();
  record('A3. 定时器到点 ⇒ 回调被调用一次', calls === 1, `calls=${calls}`);
  env.tickTimers();
  record('A4. 再到点 ⇒ 回调累计 2 次', calls === 2, `calls=${calls}`);
}

// ---------------------------------------------------------------- B
{
  const env = makeEnv();
  env.state.visible = false;
  let calls = 0;
  const c = createVisibilityInterval(env.deps, () => { calls += 1; }, 30000);
  c.start();
  record('B1. 隐藏时 start ⇒ **不开表**（零请求）',
    c.isRunning() === false && env.state.timers.length === 0,
    `running=${c.isRunning()}`);
  env.tickTimers();
  record('B2. 隐藏时即便时间到点也不回调', calls === 0, `calls=${calls}`);
}

// ---------------------------------------------------------------- C
{
  const env = makeEnv();
  let calls = 0;
  const c = createVisibilityInterval(env.deps, () => { calls += 1; }, 20000);
  c.start();
  env.state.visible = false; // 不派发事件，只改状态（模拟"两次检查之间被隐藏"）
  env.tickTimers();
  record('C1. 定时器触发瞬间页面已隐藏 ⇒ 该次不回调',
    calls === 0, `calls=${calls}`);
  c.dispose();
}

// ---------------------------------------------------------------- D
{
  const env = makeEnv();
  let calls = 0;
  const c = createVisibilityInterval(env.deps, () => { calls += 1; }, 20000);
  c.start();
  env.setVisible(false);
  record('D1. 隐藏 ⇒ 定时器停掉', c.isRunning() === false);
  env.setVisible(true);
  record('D2. 回到前台 ⇒ **立刻补刷一次**',
    calls === 1, `calls=${calls}`);
  record('D3. 回到前台 ⇒ 定时器恢复',
    c.isRunning() === true);
  env.tickTimers();
  record('D4. 恢复后按原节奏继续回调',
    calls === 2, `calls=${calls}`);
  c.dispose();
}

// ---------------------------------------------------------------- E
{
  const env = makeEnv();
  const c = createVisibilityInterval(env.deps, () => {}, 30000);
  c.start();
  env.setVisible(false);
  record('E1. 可见 ⇒ 隐藏 ⇒ 定时器停掉（后台零轮询）',
    c.isRunning() === false && env.state.timers.length === 0,
    `timers=${env.state.timers.length}`);
  env.setVisible(true);
  record('E2. 再切回可见 ⇒ 定时器重新挂上',
    c.isRunning() === true && env.state.timers.length === 1,
    `timers=${env.state.timers.length}`);
  c.dispose();
}

// ---------------------------------------------------------------- F
{
  const env = makeEnv();
  const c = createVisibilityInterval(env.deps, () => {}, 20000);
  c.start();
  c.dispose();
  record('F1. dispose ⇒ 定时器清空', env.state.timers.length === 0);
  record('F2. dispose ⇒ 事件监听摘除（无残留）',
    env.state.listeners.length === 0 && env.state.removed === 1,
    `listeners=${env.state.listeners.length} removed=${env.state.removed}`);
  let calls = 0;
  const c2 = createVisibilityInterval(env.deps, () => { calls += 1; }, 20000);
  c2.dispose();
  env.setVisible(true);
  env.tickTimers();
  record('F3. dispose 之后不再有任何回调',
    calls === 0 && c2.isRunning() === false, `calls=${calls}`);
}

// ---------------------------------------------------------------- G
{
  const env = makeEnv();
  const c = createVisibilityInterval(env.deps, () => {}, 20000);
  c.start();
  c.start();
  record('G1. 重复 start 幂等（只有一张表）',
    env.state.timers.length === 1, `timers=${env.state.timers.length}`);
  c.dispose();
  c.dispose();
  record('G2. 重复 dispose 幂等（不报错、监听不多摘）',
    env.state.removed === 1, `removed=${env.state.removed}`);
}

// ---------------------------------------------------------------- H
{
  const env = makeEnv();
  const c = createVisibilityInterval(env.deps, () => {}, 20000);
  c.start();
  const before = env.state.added;
  c.dispose();
  record('H1. 订阅可见性事件恰好一次',
    before === 1, `added=${before}`);
}

const failed = RESULTS.filter((r) => !r.ok);
console.log('');
console.log(`[test] 用例 ${RESULTS.length} 个，通过 ${RESULTS.length - failed.length} 个，失败 ${failed.length} 个`);
process.exit(failed.length ? 1 : 0);
