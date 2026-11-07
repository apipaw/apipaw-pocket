/**
 * APIPaw Pocket 控制台 —— 线上全链路验收
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/live-console.cjs [baseURL]
 *
 * 默认 baseURL = https://console.apipaw.com
 * 产物：e2e/shots/*.png + 终端 JSON 报告
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const BASE_URL = process.argv[2] || 'https://console.apipaw.com';
const API_KEY = process.env.APIPAW_API_KEY || 'paw_demo_key';
const SHOT_DIR = path.join(__dirname, 'shots');
const REPORT = path.join(__dirname, 'report.json');

let page;
const results = [];
const netlog = [];

const ok = (name, detail) => {
  results.push({ name, pass: true, detail });
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
};
const bad = (name, detail) => {
  results.push({ name, pass: false, detail });
  console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 统计某个后端路径的最近一次响应 */
function lastResp(pathFragment) {
  for (let i = netlog.length - 1; i >= 0; i--) {
    if (netlog[i].path.includes(pathFragment)) return netlog[i];
  }
  return null;
}

/**
 * 轮询等待某个后端路径出现响应。
 * 网关走 Cloudflare 回源，聚合接口冷路径可达 100s+，因此不能只看「渲染出来了就断言」。
 */
async function waitResp(pathFragment, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = lastResp(pathFragment);
    if (r) return r;
    await sleep(500);
  }
  return null;
}

/**
 * 截图：RN 的 ScrollView 用 overflow 滚动，fullPage 无效。
 * 这里找出可滚动容器并滚到底，再截元素全高。
 */
async function snap(name) {
  const file = path.join(SHOT_DIR, name);
  try {
    const scroller = page.locator('div').filter({ has: page.locator('[data-testid="playground-card"], [data-testid="analytics-card"], [data-testid="host-tabs"]') }).last();
    if (await scroller.count()) {
      await scroller.evaluate((el) => {
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
      }).catch(() => {});
      await page.waitForTimeout(800);
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

  page.on('response', async (res) => {
    const url = res.url();
    if (!url.includes('cloud.apipaw.com')) return;
    const u = new URL(url);
    netlog.push({
      method: res.request().method(),
      path: u.pathname + u.search,
      status: res.status(),
      t: Date.now(),
    });
  });
  page.on('pageerror', (e) => {
    netlog.push({ method: 'PAGEERROR', path: String(e).slice(0, 300), status: 0, t: Date.now() });
  });

  // ---- 1. 首屏加载（网络抖动时重试） ----
  console.log(`\n[1] 打开 ${BASE_URL}`);
  let loaded = false;
  let lastErr = '';
  for (let attempt = 1; attempt <= 4 && !loaded; attempt++) {
    try {
      // 注意：domcontentloaded 会被 Cloudflare 的 RUM beacon 拖到超时，改用 commit + 选择器等待
      await page.goto(BASE_URL, { waitUntil: 'commit', timeout: 60000 });
      loaded = true;
      ok('首屏加载', `第 ${attempt} 次尝试成功`);
    } catch (e) {
      lastErr = String(e).split('\n')[0];
      console.log(`  ...第 ${attempt} 次失败: ${lastErr}`);
      await sleep(2000);
    }
  }
  if (!loaded) {
    bad('首屏加载', lastErr);
    await browser.close();
    return;
  }

  await page.waitForTimeout(1500);

  // 应用就绪 = 品牌标题渲染出来（bundle 774KB，CF 回源偶发慢）
  let appReady = false;
  for (let attempt = 1; attempt <= 3 && !appReady; attempt++) {
    appReady = await page
      .waitForSelector('text=APIPaw Pocket', { timeout: 45000 })
      .then(() => true)
      .catch(() => false);
    if (!appReady) {
      console.log(`  ...应用未渲染，第 ${attempt} 次尝试，重载`);
      await page.reload({ waitUntil: 'commit', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
  }
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
  await page.waitForSelector('text=API 账户余额与 Token 额度', { timeout: 90000 }).catch(() => {});
  check((await page.locator('text=API 账户余额与 Token 额度').count()) > 0, '余额卡片渲染');
  check((await page.locator('[data-testid="playground-card"]').count()) > 0, 'Playground 卡片渲染');
  check((await page.locator('[data-testid="analytics-card"]').count()) > 0, 'Analytics 卡片渲染');

  const usage = await waitResp('/api/v1/user/usage');
  check(usage && usage.status === 200, 'GET /api/v1/user/usage', usage ? `HTTP ${usage.status}` : '未发出请求');
  const models = await waitResp('/v1/models');
  check(models && models.status === 200, 'GET /v1/models', models ? `HTTP ${models.status}` : '未发出请求');
  const analytics = await waitResp('/api/v1/user/analytics', 150000);
  check(analytics && analytics.status === 200, 'GET /api/v1/user/analytics', analytics ? `HTTP ${analytics.status}` : '未发出请求');

  await snap('01-buyer.png');

  // ---- 3. 业主视角 · 算力节点 ----
  console.log('\n[3] 业主视角 → 算力节点');
  await page.locator('text=切换至业主视角').first().click({ timeout: 20000 });
  await page.waitForTimeout(1200);
  check((await page.locator('[data-testid="host-tab-NODES"]').count()) > 0, 'HOST 分段切换器出现');
  check((await page.locator('text=算力节点远控面板').count()) > 0, '算力节点面板渲染');

  const dash = await waitResp('/api/v1/owner/dashboard');
  check(dash && dash.status === 200, 'GET /api/v1/owner/dashboard', dash ? `HTTP ${dash.status}` : '未发出请求');
  await page.waitForFunction(
    () => /节点:\s*\S/.test(document.body.innerText),
    undefined,
    { timeout: 30000 },
  ).catch(() => {});
  const nodeTxt = await page.innerText('body');
  const nodeCount = (nodeTxt.match(/节点: /g) || []).length;
  check(nodeCount > 0, '节点卡片渲染', `匹配 ${nodeCount} 处「节点: 」`);
  await snap('02-host-nodes.png');

  // ---- 4. 模型工作台 ----
  console.log('\n[4] 业主视角 → 模型工作台');
  await page.locator('[data-testid="host-tab-STUDIO"]').first().click({ timeout: 20000 });
  await page.waitForTimeout(1500);
  check((await page.locator('[data-testid="model-studio-card"]').count()) > 0, '模型工作台卡片渲染');
  check((await page.locator('[data-testid="pipeline-mesh-card"]').count()) > 0, '节点切片拓扑卡片渲染');
  const cmodels = await waitResp('/api/v1/creator/models');
  check(cmodels && cmodels.status === 200, 'GET /api/v1/creator/models', cmodels ? `HTTP ${cmodels.status}` : '未发出请求');
  const topo = await waitResp('/api/v1/creator/topology/');
  check(topo && topo.status === 200, 'GET /api/v1/creator/topology/{id}', topo ? `HTTP ${topo.status}` : '未发出请求');
  await snap('03-host-studio.png');

  // ---- 5. 版税大盘 ----
  console.log('\n[5] 业主视角 → 版税大盘');
  await page.locator('[data-testid="host-tab-ROYALTY"]').first().click({ timeout: 20000 });
  await page.waitForTimeout(1500);
  check((await page.locator('[data-testid="royalty-card"]').count()) > 0, '版税大盘卡片渲染');
  const royalty = await waitResp('/api/v1/creator/royalty');
  check(royalty && royalty.status === 200, 'GET /api/v1/creator/royalty', royalty ? `HTTP ${royalty.status}` : '未发出请求');
  await snap('04-host-royalty.png');

  // ---- 6. 密钥输入框交互 ----
  console.log('\n[6] 设置密钥弹窗');
  await page.locator('text=设置密钥').first().click({ timeout: 20000 });
  await page.waitForTimeout(800);
  const modalInput = page.locator('[data-testid="api-key-input"]');
  check((await modalInput.count()) > 0, '密钥输入框出现');
  if (await modalInput.count()) {
    await modalInput.fill(API_KEY);
    const val = await modalInput.inputValue();
    check(val === API_KEY, '密钥可输入', val ? `长度 ${val.length}` : '');
    await page.locator('[data-testid="api-key-save"]').click({ timeout: 10000 });
    await page.waitForTimeout(1000);
    check((await page.locator('[data-testid="api-key-input"]').count()) === 0, '保存后弹窗关闭');
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
    JSON.stringify({ baseUrl: BASE_URL, ts: new Date().toISOString(), results, netlog }, null, 2),
  );
  console.log(`\n报告: ${REPORT}\n截图: ${SHOT_DIR}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('验收脚本异常:', e);
  process.exit(2);
});
