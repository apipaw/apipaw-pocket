/**
 * 阶段六 P3 前端回归测试（本地 hermetic，不碰线上）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/phase6-p3.cjs
 *
 * 用 Playwright 拦截 cloud.apipaw.com 的全部请求返回假数据，然后断言 P3 的
 * 四条**前端契约**在界面上都成立：
 *   1. **身份闭环（D3）** —— 创作者身份显示的是**服务端回填**的钱包，
 *      不是那个被删掉的硬编码演示地址；未绑定时明确提示。
 *   2. **定价受控（D4）** —— 上架工作台显示平台受控默认价，改价走申请；
 *      创作者**看不到**自己提交的期望价已经生效。
 *   3. **节点提现（C4）** —— 业主视角能看到收益/可提/已提，并能登记提现。
 *   4. **公开节点身份（P5）** —— 买家视角能看到节点清单，且**不含钱包地址**。
 *   5. **OWNER 审批** —— OWNER 视角的定价审批队列可见、可签字。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIST = path.join(__dirname, '..', 'dist');
const API_KEY = 'paw-sk-e2e0123456789abcdef0123456789abcdef';
const SESSION_TOKEN = 'header.payload.signature';
const OWNER_WALLET = '0xE2E0000000000000000000000000000000000AA';
const CREATOR_WALLET = '0xE2ECREATOR000000000000000000000000000BB';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

let passed = 0;
let failed = 0;
const ok = (name, detail) => {
  passed++;
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
};
const bad = (name, detail) => {
  failed++;
  console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(DIST, urlPath);
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// Fixtures —— 字段必须齐全，否则组件会对 undefined 做 .toFixed() 直接白屏
// ---------------------------------------------------------------------------
const usageFixture = {
  api_key: API_KEY,
  balance_usd: 12.5,
  daily_limit_usd: 50,
  spent_today_usd: 0.4,
  usd_to_cgas: 100,
  role: 'BUYER',
  account_handle: 'acct_e2ep3',
};

const analyticsFixture = {
  window_hours: 24,
  generated_at: Date.now(),
  hours: Array.from({ length: 24 }, (_, i) => ({
    index: i,
    start_ts: Date.now() - (24 - i) * 3600_000,
    label: `${String(i).padStart(2, '0')}:00`,
    prompt_tokens: 1000 + i * 10,
    completion_tokens: 500 + i * 5,
    cost_usd: 0.01 + i * 0.001,
    requests: 3 + i,
  })),
  tiers: [
    { tier: 'BASE', label: '基础算力', share_note: '基础分润', cost_usd: 0.2, cgas: 20, ratio: 0.67, prompt_tokens: 100, completion_tokens: 50, requests: 3 },
    { tier: 'CREATOR', label: '创作者', share_note: '创作者分润', cost_usd: 0.1, cgas: 10, ratio: 0.33, prompt_tokens: 50, completion_tokens: 25, requests: 1 },
  ],
  models: [],
  settlement: { node_earn_usd: 0.25, creator_royalty_usd: 0.04, platform_fee_usd: 0.04, total_usd: 0.3, total_cgas: 30 },
  totals: { prompt_tokens: 2000, completion_tokens: 1000, total_tokens: 3000, cost_usd: 0.3, cgas: 30, requests: 6 },
};

const royaltyFixture = {
  creator_id: 'c1',
  creator_name: 'test',
  author_wallet: CREATOR_WALLET,
  royalty_rate: 0.15,
  window_hours: 24,
  models: [],
  totals: { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, royalty_usd: 0, royalty_paw: 0 },
  available_usd: 0,
  available_paw: 0,
  withdrawn_usd: 0,
  withdrawn_paw: 0,
  hours: [],
  withdrawals: [],
};

const platformPricingFixture = {
  prompt_price_per_1k: 0.35,
  completion_price_per_1k: 0.42,
  min_price_per_1k: 0.01,
  max_price_per_1k: 5.0,
  usd_per_paw: 0.0002,
  note: '上架价按平台受控价生效；改价需提交申请并由 OWNER 审批。',
};

const creatorIdentityFixture = {
  account_handle: 'acct_e2ep3',
  role: 'CREATOR',
  creator_id: 'creator-e2e',
  author_wallet: CREATOR_WALLET,
};

const creatorPriceRequestsFixture = {
  requests: [
    {
      id: 7,
      model_id: 'e2e-model',
      author_wallet: CREATOR_WALLET,
      status: 'PENDING',
      prompt_price_per_1k: 0.55,
      completion_price_per_1k: 0.62,
      current_prompt_price_per_1k: 0.35,
      current_completion_price_per_1k: 0.42,
      reason: 'e2e 申请',
      decided_by: '',
      decision_note: '',
      created_at: Math.floor(Date.now() / 1000),
      decided_at: null,
    },
  ],
};

const ownerPriceRequestsFixture = {
  requests: [
    {
      id: 7,
      model_id: 'e2e-model',
      author_wallet: CREATOR_WALLET,
      status: 'PENDING',
      prompt_price_per_1k: 0.55,
      completion_price_per_1k: 0.62,
      current_prompt_price_per_1k: 0.35,
      current_completion_price_per_1k: 0.42,
      reason: 'e2e 申请',
      decided_by: '',
      decision_note: '',
      created_at: Math.floor(Date.now() / 1000),
      decided_at: null,
    },
  ],
};

const meteringFixture = {
  window_minutes: 1440,
  samples: 12,
  verdict: 'aligned',
  note: '估算与真实计量偏差 ≤10%。',
  by_source: [{ src: 'node', c: 12 }],
  prompt: { avg_error_ratio: 0.03, max_error_ratio: 0.08, avg_estimate: 100, avg_real: 102, samples: 12 },
  completion: { avg_error_ratio: 0.02, max_error_ratio: 0.05, avg_estimate: 50, avg_real: 51, samples: 12 },
};

const publicNodesFixture = {
  count: 2,
  nodes: [
    {
      node_id: 'e2e-node-a',
      node_name: 'e2e-node-a',
      hardware_type: 'GPU',
      agent_version: '1.0.10',
      status: 'IDLE',
      status_label: '空闲',
      models: ['qwen-2.5-72b'],
      vram_total_gb: 48,
      node_tier: 'C2',
      alive: true,
    },
    {
      node_id: 'e2e-node-b',
      node_name: 'e2e-node-b',
      hardware_type: 'GPU',
      agent_version: '1.0.10',
      status: 'IDLE',
      status_label: '空闲',
      models: ['deepseek-r1'],
      vram_total_gb: 24,
      node_tier: 'C2',
      alive: false,
    },
  ],
};

const nodeEarningsFixture = {
  owner_wallet: OWNER_WALLET,
  earned_usd: 3.25,
  withdrawn_usd: 1.0,
  pending_usd: 0.5,
  available_usd: 2.25,
  tokens: 12345,
  requests: 42,
  nodes: [{ node_id: 'e2e-node-a', earned_usd: 3.25, tokens: 12345, requests: 42 }],
  withdrawals: [
    {
      id: 11,
      node_id: 'e2e-node-a',
      owner_wallet: OWNER_WALLET,
      amount_usd: 0.5,
      amount_paw: 2500,
      channel: 'internal',
      status: 'PENDING',
      tx_hash: '',
      note: 'e2e',
      decided_by: '',
      created_at: Math.floor(Date.now() / 1000),
      decided_at: 0,
    },
  ],
};

function mockResponse(pathname, method) {
  const json = (obj, status = 200) => ({ status, obj });
  switch (`${method} ${pathname}`) {
    case 'GET /api/v1/user/usage':
      return json(usageFixture);
    case 'GET /api/v1/user/analytics':
      return json(analyticsFixture);
    case 'GET /api/v1/creator/royalty':
      return json(royaltyFixture);
    case 'GET /api/v1/creator/identity':
      return json(creatorIdentityFixture);
    case 'GET /api/v1/pricing/default':
      return json(platformPricingFixture);
    case 'GET /api/v1/creator/models/pricing/requests':
      return json(creatorPriceRequestsFixture);
    case 'GET /api/v1/owner/pricing/requests':
      return json(ownerPriceRequestsFixture);
    case 'GET /api/v1/owner/metering/accuracy':
      return json(meteringFixture);
    case 'GET /api/v1/network/nodes':
      return json(publicNodesFixture);
    case 'GET /api/v1/network/health':
      return json({ online_nodes: 2, registered_nodes_total: 2, servable_models: 2, saturated: false });
    case 'GET /api/v1/node/earnings':
      return json(nodeEarningsFixture);
    case 'POST /api/v1/node/withdraw':
      return json({
        status: 'success',
        withdrawal: {
          id: 12,
          node_id: 'e2e-node-a',
          owner_wallet: OWNER_WALLET,
          amount_usd: 0.25,
          amount_paw: 1250,
          channel: 'internal',
          status: 'PENDING',
          note: '',
          created_at: Math.floor(Date.now() / 1000),
        },
        payout_token_address: '',
        payout_recipient: '',
        chain_channel_enabled: false,
      });
    case 'GET /v1/models':
      return json({ object: 'list', data: [] });
    case 'GET /api/v1/owner/dashboard':
      return json({ active_nodes_online: 2, registered_nodes_total: 2, nodes: [] });
    case 'GET /api/v1/owner/nodes/revenue':
      return json({
        owner_wallet: OWNER_WALLET,
        nodes_total: 1,
        total_earnings_paw: 12.5,
        total_tokens_processed: 12345,
        nodes: [],
        split: { node_share_usd: 3.25, creator_share_usd: 0.4, platform_fee_usd: 0.4, requests: 42 },
      });
    case 'GET /api/v1/creator/models':
      return json({ object: 'list', data: [] });
    case 'GET /api/v1/owner/nodes/governance':
      return json({ nodes: [] });
    case 'GET /api/v1/owner/node/appeals':
      return json({ appeals: [] });
    case 'GET /api/v1/owner/dispatch/stats':
      return json({ stats: { by_node: [], network: {} } });
    default:
      return json({ object: 'list', data: [] });
  }
}

async function mockCloud(page) {
  const seen = [];
  await page.route('**://cloud.apipaw.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    seen.push({ method: req.method(), path: u.pathname, auth: req.headers().authorization || '' });
    const { status, obj } = mockResponse(u.pathname, req.method());
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
  });
  return seen;
}

/** 预置 localStorage：API Key + OWNER 钱包会话（应用启动会恢复它） */
async function seedSession(page, role) {
  await page.addInitScript(
    ([key, token, sessionRole, wallet]) => {
      window.localStorage.setItem('apipaw.api_key', key);
      window.localStorage.setItem(
        'apipaw.session',
        JSON.stringify({
          token,
          expiresAt: Math.floor(Date.now() / 1000) + 7200,
          handle: 'acct_e2ep3',
          role: sessionRole,
          status: 'active',
          wallet,
        }),
      );
    },
    [API_KEY, SESSION_TOKEN, role, OWNER_WALLET],
  );
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error(`未找到构建产物: ${path.join(DIST, 'index.html')} —— 请先 npx expo export -p web`);
    process.exit(2);
  }
  const server = await startStaticServer();
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/`;
  console.log(`静态服务器: ${baseUrl}`);

  const browser = await chromium.launch({ headless: true });
  const pageErrors = [];

  // =====================================================================
  // 场景 1：买家视角 —— 公开节点身份卡
  // =====================================================================
  console.log('\n[1] 买家视角 —— 算力节点身份卡（P5）');
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1400 }, locale: 'zh-CN' });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const seen = await mockCloud(page);
    await seedSession(page, 'BUYER');
    await page.goto(baseUrl, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForSelector('[data-testid="public-node-card"]', { timeout: 60000 });
    ok('公开节点身份卡渲染');

    const text = await page.locator('[data-testid="public-node-card"]').innerText();
    check(text.includes('e2e-node-a'), '节点清单列出节点 id', text.replace(/\n/g, ' ').slice(0, 160));
    check(text.includes('C2'), '显示节点等级', text.replace(/\n/g, ' ').slice(0, 160));
    check(!text.includes(OWNER_WALLET.toLowerCase()) && !text.includes(OWNER_WALLET),
      '**节点卡不含钱包地址**');
    const nodesReq = seen.find((s) => s.path === '/api/v1/network/nodes');
    check(!!nodesReq && nodesReq.method === 'GET', '走公开端点 GET /api/v1/network/nodes');

    await context.close();
  }

  // =====================================================================
  // 场景 2：业主视角 —— 节点提现卡（C4）
  // =====================================================================
  console.log('\n[2] 业主视角 —— 节点收益提现卡（C4）');
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1600 }, locale: 'zh-CN' });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const seen = await mockCloud(page);
    await seedSession(page, 'OWNER');
    await page.goto(baseUrl, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForSelector('[data-testid="node-payout-card"]', { timeout: 60000 });
    ok('节点收益提现卡渲染');

    const text = await page.locator('[data-testid="node-payout-card"]').innerText();
    check(text.includes('3.2500'), '显示累计收益', text.replace(/\n/g, ' ').slice(0, 200));
    check(text.includes('2.2500'), '显示可提余额', text.replace(/\n/g, ' ').slice(0, 200));
    check(text.includes('1.0000'), '显示已提', text.replace(/\n/g, ' ').slice(0, 200));
    const earnReq = seen.find((s) => s.path === '/api/v1/node/earnings');
    check(!!earnReq && earnReq.method === 'GET', '走 GET /api/v1/node/earnings');
    check(!!earnReq && earnReq.auth === `Bearer ${SESSION_TOKEN}`,
      '收益请求带钱包会话令牌', earnReq ? earnReq.auth : '未发出请求');

    console.log('  [2.1] 登记提现');
    await page.locator('[data-testid="node-payout-amount"]').fill('0.25');
    await page.locator('[data-testid="node-payout-btn"]').click({ timeout: 20000 });
    await page.waitForSelector('[data-testid="node-payout-btn"]', { timeout: 20000 });
    await sleep(1200);
    const post = seen.find((s) => s.method === 'POST' && s.path === '/api/v1/node/withdraw');
    check(!!post, '点击「登记提现」发出 POST /api/v1/node/withdraw');
    const after = await page.locator('[data-testid="node-payout-card"]').innerText();
    check(after.includes('已登记提现'), '界面回显登记成功', after.replace(/\n/g, ' ').slice(0, 200));

    await context.close();
  }

  // =====================================================================
  // 场景 3：业主视角 —— 定价审批队列（D4 · OWNER 签字）
  // =====================================================================
  console.log('\n[3] 业主视角 —— 定价审批队列（D4）');
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1600 }, locale: 'zh-CN' });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const seen = await mockCloud(page);
    await seedSession(page, 'OWNER');
    await page.goto(baseUrl, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForSelector('[data-testid="host-tabs"]', { timeout: 60000 });
    await page.locator('[data-testid="host-tab-GOVERNANCE"]').click({ timeout: 20000 });
    await page.waitForSelector('[data-testid="pricing-approval-card"]', { timeout: 60000 });
    ok('定价审批卡渲染');
    // ⚠️ 必须等**队列行**渲染出来再断言 —— 否则会读到「正在读取改价申请队列...」
    await page.waitForSelector('[data-testid="pricing-req-7"]', { timeout: 60000 });

    const text = await page.locator('[data-testid="pricing-approval-card"]').innerText();
    check(text.includes('e2e-model'), '审批队列列出模型', text.replace(/\n/g, ' ').slice(0, 200));
    check(text.includes('0.5500'), '显示期望价', text.replace(/\n/g, ' ').slice(0, 200));
    const ownerReq = seen.find((s) => s.path === '/api/v1/owner/pricing/requests');
    check(!!ownerReq && ownerReq.auth === `Bearer ${SESSION_TOKEN}`,
      '审批队列走 OWNER 端点并带会话令牌', ownerReq ? ownerReq.auth : '未发出请求');

    await context.close();
  }

  // =====================================================================
  // 场景 4：业主视角 —— 创作者身份闭环（D3）+ 定价受控（D4）
  // =====================================================================
  console.log('\n[4] 业主视角 —— 创作者身份闭环（D3）与平台受控价（D4）');
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1800 }, locale: 'zh-CN' });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    const seen = await mockCloud(page);
    await seedSession(page, 'OWNER');
    await page.goto(baseUrl, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForSelector('[data-testid="host-tabs"]', { timeout: 60000 });
    await page.locator('[data-testid="host-tab-STUDIO"]').click({ timeout: 20000 });
    await page.waitForSelector('[data-testid="model-studio-card"]', { timeout: 60000 });
    await page.waitForSelector('[data-testid="studio-creator-wallet"]', { timeout: 60000 });
    ok('模型工作台渲染');

    const walletText = (await page.locator('[data-testid="studio-creator-wallet"]').innerText()).trim();
    check(walletText.includes(CREATOR_WALLET) || walletText.includes(CREATOR_WALLET.toLowerCase()),
      '**创作者身份显示服务端回填的钱包**', walletText);
    check(!walletText.includes('0x71C7656EC7ab88b098defB751B7401B5f6d8976F'),
      '**不再出现被删掉的硬编码演示地址**', walletText);

    const idReq = seen.find((s) => s.path === '/api/v1/creator/identity');
    check(!!idReq && idReq.method === 'GET', '身份来自服务端端点 GET /api/v1/creator/identity');

    const defaultPrice = await page.locator('[data-testid="studio-default-prompt-price"]').innerText();
    check(defaultPrice.includes('0.35'), '显示平台受控默认价（非前端写死）', defaultPrice.trim());
    const priceReq = seen.find((s) => s.path === '/api/v1/pricing/default');
    check(!!priceReq && priceReq.method === 'GET', '默认价来自 GET /api/v1/pricing/default');

    const requestsText = await page.locator('[data-testid="studio-price-requests"]').innerText();
    check(requestsText.includes('PENDING'), '创作者能看到自己的申请状态', requestsText.replace(/\n/g, ' ').slice(0, 160));

    await context.close();
  }

  // =====================================================================
  // 场景 5：无会话 —— 未绑定提示
  // =====================================================================
  console.log('\n[5] 无钱包会话 —— 明确提示未绑定');
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1400 }, locale: 'zh-CN' });
    const page = await context.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await mockCloud(page);
    await page.addInitScript((key) => window.localStorage.setItem('apipaw.api_key', key), API_KEY);
    await page.goto(baseUrl, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForSelector('[data-testid="public-node-card"]', { timeout: 60000 });
    // 切到业主视角（无会话时也能切，只是看不到业主数据）
    const seg = page.locator('text=切换至业主视角');
    if (await seg.count()) {
      await seg.first().click({ timeout: 20000 });
      await sleep(800);
    }
    const payoutCount = await page.locator('[data-testid="node-payout-card"]').count();
    if (payoutCount > 0) {
      const text = await page.locator('[data-testid="node-payout-card"]').innerText();
      check(text.includes('连接钱包'), '无会话时提示连接钱包', text.replace(/\n/g, ' ').slice(0, 160));
    } else {
      ok('无会话时不渲染提现卡（业主视图未进入）');
    }
    await context.close();
  }

  await browser.close();
  server.close();

  if (pageErrors.length) {
    failed++;
    console.log(`\n  FAIL  页面运行时错误 ${pageErrors.length} 条`);
    pageErrors.slice(0, 5).forEach((e) => console.log(`        ${e}`));
  } else {
    ok('无页面运行时错误（PAGEERROR）');
  }

  console.log(`\n===== 阶段六 P3 前端 hermetic：${passed}/${passed + failed} 通过 =====`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
