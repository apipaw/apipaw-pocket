/**
 * APIPaw Pocket —— 移动端 Playground 体验精修验收（阶段二十八 P0）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/mobile-playground-ux.cjs
 *
 * 覆盖 4 处缺陷（全部为**纯前端展示层**修复）：
 *   ① 模型选择弹层**不透明** —— 底层文字不再透上来与模型条目混读
 *   ② 默认落在**在线可推理**的模型；离线模型收进可折叠分组
 *   ③ 窄屏次要配置折叠成一行摘要 + 对话区显著变大 + 账单小票折叠
 *   ④ 三块 KPI 指标卡**零省略号**（375 / 390 两档宽度）
 *
 * 口径：
 *   - **hermetic mock**：模型目录 / 推荐列表（online_nodes）/ 用量 / SSE 全部本地伪造，
 *     不打生产后端、不碰账本；
 *   - 静态服务器固定用 **8081**（生产 CORS 白名单只放行 8081 / 19006），
 *     否则浏览器预检被拒 ⇒ 断言全部退化成「未发出请求」的假绿。
 *
 * 退出码：0 = 全部通过；1 = 有失败项。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIST = process.env.APIPAW_DIST || path.join(__dirname, '..', 'dist');
const PORT = Number(process.env.APIPAW_UX_PORT || 8081);
const VIEWPORTS = [
  { name: 'iPhone12', width: 390, height: 844 },
  { name: 'iPhoneSE', width: 375, height: 812 },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ----------------- hermetic mock 数据 -----------------

const mkModel = (id, display, tier, price, opts = {}) => ({
  id,
  object: 'model',
  display_name: display,
  description: opts.description || 'DePIN 算力测试模型',
  tier,
  tier_label: tier === 'CREATOR' ? '场景 B · 社区创作者模型' : '场景 A · 开源基础模型',
  scenario: tier === 'CREATOR' ? 'B' : 'A',
  royalty_rate: tier === 'CREATOR' ? 0.15 : 0,
  royalty_mode: 'RATE',
  context_window: 4096,
  reasoning: false,
  is_virtual: !!opts.virtual,
  moa: !!opts.moa,
  pricing: {
    prompt_per_1k_usd: price,
    completion_per_1k_usd: price * 2,
    prompt_per_1k_cgas: price * 100,
    completion_per_1k_cgas: price * 200,
    usd_to_cgas: 100,
  },
});

const MODELS = [
  mkModel('apipaw-moa', 'APIPaw MoA · 多节点协同深度思考', 'MOA', 0, { virtual: true, moa: true }),
  mkModel('apipaw-auto', 'APIPaw Smart Router · 智能优选路由', 'AUTO', 0, { virtual: true }),
  mkModel('qwen2.5:0.5b', 'Qwen 2.5 0.5B (A电脑实测模型)', 'CREATOR', 0.1),
  mkModel('apipaw-gpt2-small', 'APIPaw GPT-2 Small Demo', 'BASE', 0.001),
  mkModel('deepseek-r1', 'DeepSeek-R1', 'BASE', 0.55, { description: '深度思考推理模型，输出完整 CoT 推导链' }),
  mkModel('llama-3.3-70b', 'Llama 3.3 70B', 'BASE', 0.26),
];

/** 在线可服务节点数（与生产 `/api/v1/network/recommended-models` 同构） */
const RECOMMENDED = {
  models: [
    { model_id: 'qwen2.5:0.5b', online_nodes: 1, recommended: true, tier: 'CREATOR' },
    { model_id: 'apipaw-gpt2-small', online_nodes: 1, recommended: true, tier: 'BASE' },
    { model_id: 'deepseek-r1', online_nodes: 0, recommended: false, tier: 'BASE' },
    { model_id: 'llama-3.3-70b', online_nodes: 0, recommended: false, tier: 'BASE' },
  ],
};

const SSE_BODY = [
  'data: ' + JSON.stringify({ choices: [{ delta: { content: 'DePIN 的结算规则：' } }] }),
  '',
  'data: ' + JSON.stringify({ choices: [{ delta: { content: '买家实付 = 算力基价 × (1 + 版税率)。' } }] }),
  '',
  'data: ' +
    JSON.stringify({
      usage: {
        prompt_tokens: 219,
        completion_tokens: 21,
        total_tokens: 240,
        cost_usd: 0.025875,
        cgas: 2.59,
        base_compute_usd: 0.0225,
        creator_royalty_usd: 0.003375,
        platform_total_usd: 0.0,
        royalty_rate: 0.15,
        answer_source: 'node',
        ttft_ms: 942,
        throughput_tps: 3.4,
        perf_source: 'node',
        node_tier: 'C1',
        model_capability_class: 'C0',
      },
    }),
  '',
  'data: [DONE]',
  '',
  '',
].join('\n');

function mockFor(pathname, method) {
  if (method === 'GET' && pathname === '/v1/models') {
    return { object: 'list', data: MODELS };
  }
  if (method === 'GET' && pathname === '/api/v1/network/recommended-models') {
    return RECOMMENDED;
  }
  if (method === 'GET' && pathname === '/api/v1/network/health') {
    return {
      status: 'ok',
      online_nodes: 1,
      dispatchable_nodes: 1,
      busy_nodes: 0,
      servable_models: 2,
      catalog_models: MODELS.length,
      saturated: false,
      queue_wait_sec: 0,
      strict_mode: false,
      dispatch_enabled: true,
      real_stream: true,
      checked_at: 1764300000000,
    };
  }
  if (method === 'GET' && pathname === '/api/v1/user/usage') {
    return {
      api_key: 'paw_ux_key',
      balance_usd: 99.99,
      daily_limit_usd: 100,
      spent_today_usd: 1.5,
      usd_to_cgas: 100,
    };
  }
  return { object: 'list', data: [], rows: [], tiers: [], models: [] };
}

function startStaticServer(root) {
  const rootDir = path.resolve(root);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(rootDir, p);
      if (!file.startsWith(rootDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(rootDir, 'index.html');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

// ----------------- 断言 -----------------

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, pass: !!ok, detail: String(detail || '') });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —— ' + detail : ''}`);
}

/** 元素的背景色 alpha（1 = 完全不透明） */
async function bgAlpha(locator) {
  return locator.evaluate((el) => {
    const cs = getComputedStyle(el);
    const m = /rgba?\(([^)]+)\)/.exec(cs.backgroundColor);
    if (!m) return 1;
    const parts = m[1].split(',').map((x) => parseFloat(x.trim()));
    return parts.length >= 4 ? parts[3] : 1;
  });
}

/** 文本是否被省略号截断（scrollWidth > clientWidth 即溢出） */
async function isTruncated(locator) {
  return locator.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
}

// ----------------- 主流程 -----------------

async function runViewport(browser, vp) {
  console.log(`\n[${vp.name} ${vp.width}x${vp.height}]`);
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('apipaw.api_key', 'paw_ux_key');
    } catch (e) {}
    const FIXED = 1764300000000;
    const RealDate = Date;
    const Fake = function (...args) {
      if (!(this instanceof Fake)) return new RealDate(FIXED).toString();
      return args.length === 0 ? new RealDate(FIXED) : new RealDate(...args);
    };
    Fake.prototype = RealDate.prototype;
    Fake.now = () => FIXED;
    Fake.parse = RealDate.parse;
    Fake.UTC = RealDate.UTC;
    window.Date = Fake;
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.route('**://cloud.apipaw.com/**', async (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/v1/chat/completions') {
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        headers: { 'X-APIPaw-Dispatch': 'node', 'X-Request-ID': 'ux-req-1' },
        body: SSE_BODY,
      });
      return;
    }
    const obj = mockFor(u.pathname, route.request().method());
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
  });

  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'commit', timeout: 90000 });
  await page.waitForSelector('[data-testid="playground-card"]', { timeout: 90000 });
  await sleep(2500);

  // ---- ② 默认模型必须是**在线**的 ----
  const selValue = (await page.locator('#apx-model-selector-value').first().innerText().catch(() => '')) || '';
  check(
    '② 默认模型落在在线可推理模型（不是 DeepSeek-R1）',
    !/DeepSeek/i.test(selValue) && /Qwen|APIPaw/i.test(selValue),
    selValue.replace(/\n/g, ' '),
  );

  // ---- ① 模型弹层不透明 ----
  await page.locator('[data-testid="playground-card"]').locator('text=推理模型').first().click();
  await sleep(900);
  const sheet = page.locator('[data-testid="playground-model-item-apipaw-auto"]').first();
  const sheetBox = sheet.locator('xpath=ancestor::*[contains(@style,"border-radius")][1]').first();
  // 卡片体：用弹层内第一个带背景的元素来判定不透明度
  const sheetAlpha = await page.evaluate(() => {
    const item = document.querySelector('[data-testid="playground-model-item-apipaw-auto"]');
    if (!item) return null;
    let el = item;
    while (el && el !== document.body) {
      const bg = getComputedStyle(el).backgroundColor;
      const m = /rgba?\(([^)]+)\)/.exec(bg);
      if (m) {
        const p = m[1].split(',').map((x) => parseFloat(x.trim()));
        const a = p.length >= 4 ? p[3] : 1;
        if (a >= 0.99) return { alpha: a, bg };
      }
      el = el.parentElement;
    }
    return { alpha: 0, bg: 'none' };
  });
  check(
    '① 弹层卡片体完全不透明（alpha = 1）',
    !!sheetAlpha && sheetAlpha.alpha >= 0.99,
    sheetAlpha ? `${sheetAlpha.bg}` : '未找到弹层',
  );
  const backdropAlpha = await page.evaluate(() => {
    const item = document.querySelector('[data-testid="playground-model-item-apipaw-auto"]');
    let el = item ? item.parentElement : null;
    while (el && el !== document.body) {
      const bg = getComputedStyle(el).backgroundColor;
      const m = /rgba?\(([^)]+)\)/.exec(bg);
      if (m) {
        const p = m[1].split(',').map((x) => parseFloat(x.trim()));
        const a = p.length >= 4 ? p[3] : 1;
        if (a > 0.5 && a < 0.99) return a;
      }
      el = el.parentElement;
    }
    return null;
  });
  check('① 弹层遮罩为半透明深色（0.5 < alpha < 0.99）', backdropAlpha !== null, String(backdropAlpha));

  // ---- ① 弹层打开时**底层不得滚动穿透** ----
  const scrollBefore = await page.evaluate(() => {
    const sv = Array.from(document.querySelectorAll('*')).find((el) => {
      const cs = getComputedStyle(el);
      return (
        (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 40
      );
    });
    return { inner: sv ? sv.scrollTop : -1, win: window.scrollY };
  });
  await page.mouse.move(vp.width / 2, vp.height / 2);
  await page.mouse.wheel(0, 600);
  await sleep(700);
  const scrollAfter = await page.evaluate(() => {
    const sv = Array.from(document.querySelectorAll('*')).find((el) => {
      const cs = getComputedStyle(el);
      return (
        (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 40
      );
    });
    return { inner: sv ? sv.scrollTop : -1, win: window.scrollY };
  });
  check(
    '① 弹层打开时底层不滚动穿透',
    scrollBefore.inner === scrollAfter.inner && scrollBefore.win === scrollAfter.win,
    `before=${JSON.stringify(scrollBefore)} after=${JSON.stringify(scrollAfter)}`,
  );

  // ---- ② 离线模型折叠分组 ----
  const offlineToggle = page.locator('[data-testid="playground-offline-models-toggle"]');
  check('② 离线模型折叠分组存在', (await offlineToggle.count()) > 0);
  const toggleText = (await offlineToggle.innerText().catch(() => '')) || '';
  check('② 折叠分组标题含数量', /离线模型\s*\(\s*2\s*\)/.test(toggleText), toggleText.replace(/\n/g, ' '));
  const offlineBefore = await page.locator('[data-testid="playground-model-item-deepseek-r1"]').count();
  check('② 收起时离线模型不在列表里', offlineBefore === 0, `count=${offlineBefore}`);
  const onlineItem = page.locator('[data-testid="playground-model-item-qwen2.5:0.5b"]');
  check('② 在线模型在主列表且可见', (await onlineItem.count()) > 0 && (await onlineItem.isVisible()));
  if (await offlineToggle.count()) {
    await offlineToggle.click();
    await sleep(700);
  }
  const offlineAfter = page.locator('[data-testid="playground-model-item-deepseek-r1"]');
  check(
    '② 展开后可点选离线模型',
    (await offlineAfter.count()) > 0 && (await offlineAfter.isVisible()),
  );

  // 关闭弹层（点遮罩）
  await page.keyboard.press('Escape');
  await sleep(400);
  const stillOpen = await page.locator('[data-testid="playground-model-item-qwen2.5:0.5b"]').isVisible().catch(() => false);
  if (stillOpen) {
    await page.mouse.click(4, 4);
    await sleep(600);
  }

  // ---- ③ 窄屏配置折叠 + 对话区变大 ----
  const cfgToggle = page.locator('[data-testid="playground-mobile-config-toggle"]');
  check('③ 窄屏出现一行配置摘要', (await cfgToggle.count()) > 0 && (await cfgToggle.isVisible()));
  const cfgText = (await cfgToggle.innerText().catch(() => '')) || '';
  check('③ 摘要含预估花费与黄金增强状态', /预估/.test(cfgText) && /黄金增强/.test(cfgText), cfgText.replace(/\n/g, ' '));
  const costPreview = page.locator('[data-testid="playground-cost-preview"]');
  const hiddenBefore = await costPreview.isVisible().catch(() => false);
  check('③ 收起时「本次预计花费」不可见', hiddenBefore === false);
  await cfgToggle.click();
  await sleep(600);
  check('③ 展开后原控件可见', await costPreview.isVisible().catch(() => false));
  await cfgToggle.click();
  await sleep(400);

  const termBox = await page.locator('#apx-term').boundingBox();
  const scrollBox = await page.locator('#apx-term > *').last().boundingBox().catch(() => null);
  const termH = termBox ? termBox.height : 0;
  const scrollH = scrollBox ? scrollBox.height : 0;
  check(
    '③ 对话区高度显著变大（≥ 340px 且 ≤ 55vh）',
    termH >= 340 && termH <= vp.height * 0.58 + 2,
    `term=${Math.round(termH)}px, scroll=${Math.round(scrollH)}px, vh=${vp.height}`,
  );

  // ---- ③/④ 发一条消息，产出指标卡与账单小票 ----
  const input = page.locator('#apx-playground-input');
  await input.fill('解释一下 DePIN 的结算规则');
  await sleep(300);
  const inputBox = await input.boundingBox();
  check('③ 输入框支持多行（≥ 72px）', inputBox && inputBox.height >= 72, inputBox ? `${Math.round(inputBox.height)}px` : 'n/a');
  await page.locator('[data-testid="playground-send"]').click();
  await page.waitForSelector('[data-testid="playground-stat-ttft"]', { timeout: 30000 });
  await sleep(2500);

  // ---- ④ 三块指标卡零省略号 ----
  for (const tid of ['playground-stat-ttft', 'playground-stat-tps', 'playground-stat-tokens']) {
    const tile = page.locator(`[data-testid="${tid}"]`);
    const texts = tile.locator('div').locator('span');
    const n = await texts.count();
    let truncated = [];
    for (let i = 0; i < n; i++) {
      const t = texts.nth(i);
      if (!(await t.isVisible().catch(() => false))) continue;
      if (await isTruncated(t)) truncated.push((await t.innerText()).slice(0, 24));
    }
    check(`④ ${tid} 文本零省略号`, truncated.length === 0, truncated.join(' | '));
  }

  // ---- ③ 账单小票折叠为一行 ----
  const receiptSummary = page.locator('[data-testid="playground-cost-summary-mobile"]');
  const hasSummary = (await receiptSummary.count()) > 0 && (await receiptSummary.isVisible().catch(() => false));
  check('③ 账单小票折叠为一行摘要', hasSummary);
  if (hasSummary) {
    const t = (await receiptSummary.innerText()) || '';
    check('③ 摘要含实付金额', /实付\s*\$/.test(t), t.replace(/\n/g, ' '));
    const receiptVisible = await page
      .locator('[data-testid="playground-cost-breakdown"]')
      .isVisible()
      .catch(() => false);
    check('③ 收起时明细不可见', receiptVisible === false);
    await receiptSummary.click();
    await sleep(500);
    check(
      '③ 展开后明细可见',
      await page.locator('[data-testid="playground-cost-breakdown"]').isVisible().catch(() => false),
    );
  }

  check('无 JS 运行时错误', errors.length === 0, errors.slice(0, 2).join(' | '));

  await context.close();
}

async function main() {
  if (!fs.existsSync(DIST)) {
    console.error(`[FATAL] 没有 dist 产物（${DIST}）—— 先 npm run build:web`);
    process.exit(2);
  }
  const server = await startStaticServer(DIST);
  const browser = await chromium.launch({ headless: true });
  try {
    for (const vp of VIEWPORTS) {
      await runViewport(browser, vp);
    }
  } finally {
    await browser.close();
    server.close();
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n总计：${passed}/${results.length} 通过`);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  ✗ ${f.name}  ${f.detail}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('验收异常:', e);
    process.exit(2);
  });
}
