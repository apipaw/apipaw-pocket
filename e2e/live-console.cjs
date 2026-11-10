/**
 * APIPaw Pocket 控制台 —— 线上全链路验收（动态等待加固版）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/live-console.cjs [baseURL]
 *
 * 默认 baseURL = https://console.apipaw.com
 * 产物：e2e/shots/*.png + e2e/report.json
 *
 * ── 等待策略（2026-11-08 加固）────────────────────────────
 * 1. 全程**不使用固定 sleep 等渲染**，一律用 waitForSelector / waitForFunction；
 *    唯一保留的 sleep 只用于重试退避（backoff），不参与任何断言时序。
 * 2. Cloudflare 边缘冷启动 30~90s、网关聚合冷路径可达 100s+，
 *    因此把超时按语义分级（nav / app / panel / api / action），
 *    可用环境变量 APIPAW_E2E_*_TIMEOUT 覆盖。
 * 3. 接口断言优先等待 HTTP 200 的响应；超时后回退到「最近一条任意状态的匹配记录」，
 *    以便报告真实状态码而不是笼统的「未发出请求」。
 * 4. 交互统一走 clickSafe()：先 scrollIntoViewIfNeeded 再点，失败自动重试，
 *    规避 RN 重渲染导致的 element detached。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const BASE_URL = process.argv[2] || 'https://console.apipaw.com';
/**
 * 测试凭证**只从环境变量读**——仓库里不再留任何硬编码 Key。
 * 跑法：APIPAW_API_KEY=<你的测试 key> node e2e/live-console.cjs [baseURL]
 */
const API_KEY = process.env.APIPAW_API_KEY;
if (!API_KEY) {
  console.error('缺少环境变量 APIPAW_API_KEY —— 仓库内不再内置默认 Key，请显式传入。');
  process.exit(2);
}
const SHOT_DIR = path.join(__dirname, 'shots');
const REPORT = path.join(__dirname, 'report.json');

// 超时分级（毫秒）—— 线上 CF 边缘 / 网关冷路径的真实耗时上限
const T = {
  nav: Number(process.env.APIPAW_E2E_NAV_TIMEOUT || 90000), // 导航提交
  app: Number(process.env.APIPAW_E2E_APP_TIMEOUT || 90000), // 应用挂载 / 品牌标题
  panel: Number(process.env.APIPAW_E2E_PANEL_TIMEOUT || 90000), // 面板 / 卡片渲染
  api: Number(process.env.APIPAW_E2E_API_TIMEOUT || 150000), // 网关聚合接口
  action: Number(process.env.APIPAW_E2E_ACTION_TIMEOUT || 30000), // 单次交互
};

let page;
const results = [];
const netlog = [];
const timings = [];

const ok = (name, detail) => {
  results.push({ name, pass: true, detail });
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
};
const bad = (name, detail) => {
  results.push({ name, pass: false, detail });
  console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

/** 仅用于重试退避，绝不用于「等渲染」 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 记录阶段耗时，便于定位线上抖动发生在哪一段 */
function mark(label, ms) {
  timings.push({ label, ms });
  console.log(`  · ${label} 用时 ${(ms / 1000).toFixed(1)}s`);
}

/** 统计某个后端路径最近一次响应（忽略 JS 错误条目） */
function lastResp(pathFragment) {
  for (let i = netlog.length - 1; i >= 0; i--) {
    const n = netlog[i];
    if (n.method !== 'PAGEERROR' && n.path.includes(pathFragment)) return n;
  }
  return null;
}

/**
 * 轮询等待某个后端路径出现「成功」响应。
 * 网关走 Cloudflare 回源，聚合接口冷路径可达 100s+，因此不能只看「渲染出来了就断言」。
 *
 * 语义：优先返回 HTTP 200 的记录；等待窗口内没有 200 则回退到最近一条任意状态的记录，
 * 让断言能报告真实状态码（如 HTTP 500）而不是「未发出请求」。
 */
async function waitResp(pathFragment, timeoutMs = T.api) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  while (Date.now() < deadline) {
    for (let i = netlog.length - 1; i >= 0; i--) {
      const n = netlog[i];
      if (n.method !== 'PAGEERROR' && n.path.includes(pathFragment) && n.status === 200) {
        return n;
      }
    }
    await sleep(500);
  }
  return lastResp(pathFragment);
}

/** 等某个选择器出现（attached），返回是否命中；不抛错 */
async function waitFor(selector, timeoutMs = T.panel) {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs, state: 'attached' });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 稳健点击：先滚动到可视区再点，失败自动重试。
 * RN 重渲染会替换 DOM 节点，裸 click 容易撞上 element detached。
 */
async function clickSafe(locator, { timeout = T.action, label = '' } = {}) {
  const deadline = Date.now() + timeout;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await locator.click({ timeout: 8000 });
      return true;
    } catch (e) {
      lastErr = e;
      await page.waitForTimeout(300); // 退避重试
    }
  }
  console.log(`  ...点击失败${label ? `（${label}）` : ''}: ${String(lastErr).split('\n')[0]}`);
  return false;
}

/**
 * 截图：RN 的 ScrollView 用 overflow 滚动，fullPage 无效。
 * 这里找出可滚动容器并滚到底，等两帧渲染完成后截元素全高。
 */
async function snap(name, expectSelector) {
  const file = path.join(SHOT_DIR, name);
  try {
    if (expectSelector) await waitFor(expectSelector, T.panel);
    const scroller = page
      .locator('div')
      .filter({ has: page.locator('[data-testid="playground-card"], [data-testid="analytics-card"], [data-testid="host-tabs"]') })
      .last();
    if (await scroller.count()) {
      await scroller
        .evaluate((el) => {
          const find = (n) => {
            for (const c of n.children) {
              if (c.scrollHeight > c.clientHeight + 20) return c;
              const r = find(c);
              if (r) return r;
            }
            return null;
          };
          const t = find(el) || el;
          t.scrollTop = t.scrollHeight;
        })
        .catch(() => {});
      // 双 rAF + 一个宏任务 = 布局与绘制已完成，替代原先固定 sleep(800)
      await page
        .evaluate(
          () =>
            new Promise((r) =>
              requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 0))),
            ),
        )
        .catch(() => {});
    }
    await page.screenshot({ path: file, fullPage: false });
  } catch (e) {
    await page.screenshot({ path: file }).catch(() => {});
  }
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });

  // 密钥预置 —— 必须先于任何页面脚本执行
  await context.addInitScript(
    ([key]) => {
      try {
        window.localStorage.setItem('apipaw.api_key', key);
      } catch (e) {}
    },
    [API_KEY],
  );

  page = await context.newPage();
  page.setDefaultTimeout(T.action);
  page.setDefaultNavigationTimeout(T.nav);

  page.on('response', (res) => {
    const url = res.url();
    if (!url.includes('cloud.apipaw.com')) return;
    let path = '';
    try {
      const u = new URL(url);
      path = u.pathname + u.search;
    } catch (e) {
      path = url;
    }
    netlog.push({
      method: res.request().method(),
      path,
      status: res.status(),
      t: Date.now(),
    });
  });
  page.on('pageerror', (e) => {
    netlog.push({ method: 'PAGEERROR', path: String(e).slice(0, 300), status: 0, t: Date.now() });
  });

  // ---- 1. 首屏加载（网络抖动时重试） ----
  console.log(`\n[1] 打开 ${BASE_URL}`);
  const navT0 = Date.now();
  let loaded = false;
  let lastErr = '';
  for (let attempt = 1; attempt <= 4 && !loaded; attempt++) {
    try {
      // 注意：domcontentloaded 会被 Cloudflare 的 RUM beacon 拖到超时，改用 commit + 选择器等待
      await page.goto(BASE_URL, { waitUntil: 'commit', timeout: T.nav });
      loaded = true;
      ok('首屏加载', `第 ${attempt} 次尝试成功`);
    } catch (e) {
      lastErr = String(e).split('\n')[0];
      console.log(`  ...第 ${attempt} 次失败: ${lastErr}`);
      await sleep(2000); // 仅作重试退避
    }
  }
  if (!loaded) {
    bad('首屏加载', lastErr);
    await browser.close();
    return;
  }
  mark('导航提交', Date.now() - navT0);

  // 应用就绪 = 品牌标题渲染出来（bundle 774KB，CF 回源偶发慢）
  const appT0 = Date.now();
  let appReady = false;
  for (let attempt = 1; attempt <= 3 && !appReady; attempt++) {
    appReady = await waitFor('text=APIPaw Pocket', T.app);
    if (!appReady) {
      console.log(`  ...应用未渲染，第 ${attempt} 次尝试，重载`);
      await page.reload({ waitUntil: 'commit', timeout: T.nav }).catch(() => {});
    }
  }
  mark('应用渲染', Date.now() - appT0);
  check(appReady, '应用渲染就绪', appReady ? '' : '3 次尝试后仍未渲染');

  // 断言标题与品牌
  const bodyText = await page.innerText('body');
  check(/APIPaw Pocket/.test(bodyText), '品牌标题渲染', bodyText.includes('APIPaw Pocket') ? '' : '未找到 APIPaw Pocket');
  check(
    !(await page.locator('text=尚未设置 API Key').count()),
    '密钥已生效（无未设置横幅）',
  );

  // ---- 2. 买家视角 ----
  console.log('\n[2] 买家视角');
  // 余额卡片依赖 usage 接口回填（冷路径可达 100s+），等元素而不是等时间
  await waitFor('text=API 账户余额与 Token 额度', T.panel);
  check((await page.locator('text=API 账户余额与 Token 额度').count()) > 0, '余额卡片渲染');
  check((await page.locator('[data-testid="playground-card"]').count()) > 0, 'Playground 卡片渲染');
  check((await page.locator('[data-testid="analytics-card"]').count()) > 0, 'Analytics 卡片渲染');

  const usage = await waitResp('/api/v1/user/usage');
  check(usage && usage.status === 200, 'GET /api/v1/user/usage', usage ? `HTTP ${usage.status}` : '未发出请求');
  const models = await waitResp('/v1/models');
  check(models && models.status === 200, 'GET /v1/models', models ? `HTTP ${models.status}` : '未发出请求');
  const analytics = await waitResp('/api/v1/user/analytics');
  check(analytics && analytics.status === 200, 'GET /api/v1/user/analytics', analytics ? `HTTP ${analytics.status}` : '未发出请求');

  await snap('01-buyer.png', '[data-testid="analytics-card"]');

  // ---- 3. 业主视角 · 算力节点 ----
  console.log('\n[3] 业主视角 → 算力节点');
  await clickSafe(page.locator('text=切换至业主视角').first(), { label: '切换至业主视角' });
  // 等 HOST 分段器出现 —— 取代固定 sleep(1200)
  await waitFor('[data-testid="host-tab-NODES"]', T.panel);
  check((await page.locator('[data-testid="host-tab-NODES"]').count()) > 0, 'HOST 分段切换器出现');
  check((await page.locator('text=算力节点远控面板').count()) > 0, '算力节点面板渲染');

  const dash = await waitResp('/api/v1/owner/dashboard');
  check(dash && dash.status === 200, 'GET /api/v1/owner/dashboard', dash ? `HTTP ${dash.status}` : '未发出请求');
  await page
    .waitForFunction(() => /节点:\s*\S/.test(document.body.innerText), undefined, { timeout: T.api })
    .catch(() => {});
  const nodeTxt = await page.innerText('body');
  const nodeCount = (nodeTxt.match(/节点: /g) || []).length;
  check(nodeCount > 0, '节点卡片渲染', `匹配 ${nodeCount} 处「节点: 」`);
  await snap('02-host-nodes.png', 'text=算力节点远控面板');

  // ---- 4. 模型工作台 ----
  console.log('\n[4] 业主视角 → 模型工作台');
  await clickSafe(page.locator('[data-testid="host-tab-STUDIO"]').first(), { label: 'host-tab-STUDIO' });
  await waitFor('[data-testid="model-studio-card"]', T.panel);
  check((await page.locator('[data-testid="model-studio-card"]').count()) > 0, '模型工作台卡片渲染');
  check((await page.locator('[data-testid="pipeline-mesh-card"]').count()) > 0, '节点切片拓扑卡片渲染');
  const cmodels = await waitResp('/api/v1/creator/models');
  check(cmodels && cmodels.status === 200, 'GET /api/v1/creator/models', cmodels ? `HTTP ${cmodels.status}` : '未发出请求');
  const topo = await waitResp('/api/v1/creator/topology/');
  check(topo && topo.status === 200, 'GET /api/v1/creator/topology/{id}', topo ? `HTTP ${topo.status}` : '未发出请求');
  await snap('03-host-studio.png', '[data-testid="model-studio-card"]');

  // ---- 5. 版税大盘 ----
  console.log('\n[5] 业主视角 → 版税大盘');
  await clickSafe(page.locator('[data-testid="host-tab-ROYALTY"]').first(), { label: 'host-tab-ROYALTY' });
  await waitFor('[data-testid="royalty-card"]', T.panel);
  check((await page.locator('[data-testid="royalty-card"]').count()) > 0, '版税大盘卡片渲染');
  const royalty = await waitResp('/api/v1/creator/royalty');
  check(royalty && royalty.status === 200, 'GET /api/v1/creator/royalty', royalty ? `HTTP ${royalty.status}` : '未发出请求');
  await snap('04-host-royalty.png', '[data-testid="royalty-card"]');

  // ---- 6. 密钥输入框交互 ----
  console.log('\n[6] 设置密钥弹窗');
  await clickSafe(page.locator('text=设置密钥').first(), { label: '设置密钥' });
  const modalInput = page.locator('[data-testid="api-key-input"]');
  await waitFor('[data-testid="api-key-input"]', T.action); // 取代固定 sleep(800)
  check((await modalInput.count()) > 0, '密钥输入框出现');
  if (await modalInput.count()) {
    await modalInput.fill(API_KEY);
    const val = await modalInput.inputValue();
    check(val === API_KEY, '密钥可输入', val ? `长度 ${val.length}` : '');
    await clickSafe(page.locator('[data-testid="api-key-save"]'), { label: 'api-key-save' });
    // 等输入框从 DOM 消失 —— 取代固定 sleep(1000)
    const closed = await page
      .waitForSelector('[data-testid="api-key-input"]', { state: 'detached', timeout: T.action })
      .then(() => true)
      .catch(() => false);
    check(closed, '保存后弹窗关闭');
  }
  await snap('05-key-modal.png');

  // ---- 7. 无脚本错误 ----
  const errs = netlog.filter((n) => n.method === 'PAGEERROR');
  check(errs.length === 0, '无 JS 运行时错误', errs.length ? errs.map((e) => e.path).join(' | ') : '');

  await browser.close();

  // ---- 报告 ----
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\n===== 验收结果 ${passed}/${results.length} 通过，${failed} 失败 =====`);
  console.log('\n后端请求流水:');
  netlog
    .filter((n) => n.method !== 'PAGEERROR')
    .forEach((n) => console.log(`  ${n.method} ${n.path} -> ${n.status}`));

  fs.writeFileSync(
    REPORT,
    JSON.stringify({ baseUrl: BASE_URL, ts: new Date().toISOString(), timings, results, netlog }, null, 2),
  );
  console.log(`\n报告: ${REPORT}\n截图: ${SHOT_DIR}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('验收脚本异常:', e);
  process.exit(2);
});
