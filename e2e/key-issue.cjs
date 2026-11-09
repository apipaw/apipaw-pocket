/**
 * 买家签发台回归测试（本地 hermetic，不碰线上）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/key-issue.cjs
 *
 * 用 Playwright 拦截 cloud.apipaw.com 的全部请求返回假数据，然后断言签发台的
 * 三条**契约**在界面上都成立：
 *   1. 明文只显示一次（警示文案 + 明文可见）
 *   2. 余额 $0 + 必须充值才能推理（引导文案）
 *   3. 限流 429 有明确提示（而不是一个裸的 "请求失败"）
 * 以及保存路径：勾选「我已保存」前不能写入 localStorage，勾选后写入并带上新 Key。
 *
 * 背景：阶段四 P2 把签发台开成了公开自助入口 —— 密钥只在此刻返回一次，
 * 界面上一旦没把"只显示一次 / 余额为 0 / 429"说清楚，用户就会丢密钥或撞墙。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIST = path.join(__dirname, '..', 'dist');
const ISSUED_KEY = 'paw-sk-0123456789abcdef0123456789abcdef';
const ISSUED_HANDLE = 'acct_e2e0123456789abcd';

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

/** 起一个只服务 dist/ 的静态服务器（SPA 回退到 index.html） */
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

const usageFixture = {
  api_key: '',
  balance_usd: 0,
  daily_limit_usd: 50,
  spent_today_usd: 0,
  usd_to_cgas: 100,
  role: 'BUYER',
  account_handle: ISSUED_HANDLE,
};

// ⚠️ analytics / royalty 的 fixture 必须**字段齐全** —— AnalyticsCard 直接对
// totals.cost_usd 等做 .toFixed(), 缺字段会让整个应用白屏（PAGEERROR），
// 表现为"签发台面板永远不出现"。这里照抄 limit-sync.cjs 里已验证的 fixture。
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
  settlement: {
    node_earn_usd: 0.25,
    creator_royalty_usd: 0.04,
    platform_fee_usd: 0.04,
    total_usd: 0.3,
    total_cgas: 30,
  },
  totals: {
    prompt_tokens: 2000,
    completion_tokens: 1000,
    total_tokens: 3000,
    cost_usd: 0.3,
    cgas: 30,
    requests: 6,
  },
};

const royaltyFixture = {
  creator_id: 'c1',
  creator_name: 'test',
  author_wallet: '0x0000000000000000000000000000000000000000',
  royalty_rate: 0.15,
  window_hours: 24,
  models: [],
  totals: {
    calls: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    royalty_usd: 0,
    royalty_paw: 0,
  },
  available_usd: 0,
  available_paw: 0,
  withdrawn_usd: 0,
  withdrawn_paw: 0,
  hours: [],
  withdrawals: [],
};

const issueFixture = {
  status: 'success',
  api_key: ISSUED_KEY,
  balance_usd: 0,
  account_handle: ISSUED_HANDLE,
  key_prefix: 'paw-sk-012345',
  key_last4: 'cdef',
  role: 'BUYER',
  daily_limit_usd: 50,
};

function mockResponse(pathname, method, mode) {
  const json = (obj, status = 200) => ({ status, obj });
  switch (`${method} ${pathname}`) {
    case 'POST /api/v1/auth/apikey':
      // mode=429 模拟限流（后端按真实客户端 IP 限流 5 把/小时）
      if (mode === '429') return json({ detail: '请求过于频繁，请稍后再试' }, 429);
      return json(issueFixture);
    case 'GET /api/v1/user/usage':
      return json(usageFixture);
    case 'GET /api/v1/user/analytics':
      return json(analyticsFixture);
    case 'GET /v1/models':
      return json({ object: 'list', data: [] });
    case 'GET /api/v1/owner/dashboard':
      return json({ active_nodes_online: 1, registered_nodes_total: 1, nodes: [] });
    case 'GET /api/v1/creator/models':
      return json({ object: 'list', data: [] });
    case 'GET /api/v1/creator/topology':
    case 'GET /api/v1/creator/topology/':
      return json({ object: 'list', data: [] });
    case 'GET /api/v1/creator/royalty':
      return json(royaltyFixture);
    default:
      return json({ detail: 'mocked' }, 200);
  }
}

/** 拦截云端全部请求；mode 控制签发端点是 200 还是 429 */
async function mockCloud(page, mode) {
  const seen = [];
  await page.route('**://cloud.apipaw.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    seen.push({ method: req.method(), path: u.pathname, auth: req.headers().authorization || '' });
    const { status, obj } = mockResponse(u.pathname, req.method(), mode);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
  });
  return seen;
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
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    hasTouch: true,
  });
  const pageErrors = [];
  context.on('weberror', (e) => pageErrors.push(String(e.error())));

  // ---------------- 场景 1: 签发 → 展示 → 保存 ----------------
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const seen = await mockCloud(page, '200');

  console.log('\n[1] 无密钥访问 —— 密钥弹窗自动打开，签发台可见');
  await page.goto(baseUrl, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForSelector('[data-testid="key-issue-panel"]', { timeout: 60000 });
  check(true, '签发台面板渲染');
  check((await page.locator('[data-testid="issue-key-btn"]').count()) > 0, '「签发新 Key」入口存在');

  console.log('\n[2] 点击签发 —— 明文一次性展示 + $0 余额引导');
  await page.locator('[data-testid="issue-key-btn"]').click({ timeout: 20000 });
  await page.waitForSelector('[data-testid="issue-key-plaintext"]', { timeout: 20000 });
  const plain = (await page.locator('[data-testid="issue-key-plaintext"]').innerText()).trim();
  check(plain === ISSUED_KEY, '明文 Key 完整展示', plain);
  const warn = await page.locator('[data-testid="issue-key-once-warning"]').innerText();
  check(warn.includes('只显示这一次'), '明示「明文只显示这一次」', warn.replace(/\n/g, ' '));
  const meta = await page.locator('[data-testid="issue-key-meta"]').innerText();
  check(meta.includes(ISSUED_HANDLE), '展示账户句柄', meta.replace(/\n/g, ' '));
  const note = await page.locator('[data-testid="issue-key-balance-note"]').innerText();
  check(note.includes('$0.00'), '明示初始余额为 $0', note.replace(/\n/g, ' '));
  check(note.includes('充值'), '明示需充值后才能推理', note.replace(/\n/g, ' '));
  const issueReq = seen.find((s) => s.path === '/api/v1/auth/apikey');
  check(!!issueReq && issueReq.method === 'POST', '签发走 POST /api/v1/auth/apikey');

  console.log('\n[3] 复制按钮');
  await page.locator('[data-testid="issue-key-copy"]').click({ timeout: 20000 });
  await sleep(600);
  const copyText = await page.locator('[data-testid="issue-key-copy"]').innerText();
  check(copyText.includes('已复制'), '复制后按钮反馈「已复制」', copyText.replace(/\n/g, ' '));

  console.log('\n[4] 未勾选「我已保存」时不得写入 localStorage');
  await page.locator('[data-testid="issue-key-save"]').click({ timeout: 20000, force: true });
  await sleep(800);
  const storedEarly = await page.evaluate(() => window.localStorage.getItem('apipaw.api_key'));
  check(!storedEarly, '未确认保存 → localStorage 未被写入', String(storedEarly));

  console.log('\n[5] 勾选确认 → 保存并使用 → 写入 localStorage 并关闭弹窗');
  await page.locator('[data-testid="issue-key-confirm"]').click({ timeout: 20000 });
  await page.locator('[data-testid="issue-key-save"]').click({ timeout: 20000 });
  await sleep(1500);
  const stored = await page.evaluate(() => window.localStorage.getItem('apipaw.api_key'));
  check(stored === ISSUED_KEY, '新 Key 已写入 localStorage', String(stored));
  const modalGone = (await page.locator('[data-testid="key-issue-panel"]').count()) === 0;
  check(modalGone, '保存后弹窗关闭');
  const usageReq = seen.filter((s) => s.path === '/api/v1/user/usage').pop();
  check(
    !!usageReq && usageReq.auth === `Bearer ${ISSUED_KEY}`,
    '后续请求带上新 Key 的 Authorization',
    usageReq ? usageReq.auth : '未发出请求',
  );

  // ---------------- 场景 2: 429 限流提示 ----------------
  console.log('\n[6] 限流 429 —— 必须给出明确提示');
  // 必须用**独立的 context**：场景 1 已经把 Key 写进了 localStorage，
  // 同一个 context 里的新页面会带着密钥访问 → 弹窗不再自动打开。
  const context2 = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    hasTouch: true,
  });
  const page2 = await context2.newPage();
  page2.on('pageerror', (e) => pageErrors.push(String(e)));
  await mockCloud(page2, '429');
  await page2.goto(baseUrl, { waitUntil: 'commit', timeout: 60000 });
  await page2.waitForSelector('[data-testid="issue-key-btn"]', { timeout: 60000 });
  await page2.locator('[data-testid="issue-key-btn"]').click({ timeout: 20000 });
  await page2.waitForSelector('[data-testid="issue-key-error"]', { timeout: 20000 });
  const errText = await page2.locator('[data-testid="issue-key-error"]').innerText();
  check(errText.includes('频繁'), '429 显示「过于频繁」提示', errText.replace(/\n/g, ' '));
  check(errText.includes('5'), '429 提示里给出具体配额（每小时 5 次）', errText.replace(/\n/g, ' '));
  const resultGone = (await page2.locator('[data-testid="issue-key-result"]').count()) === 0;
  check(resultGone, '429 时不展示明文结果区');

  check(pageErrors.length === 0, '无 JS 运行时错误', pageErrors.slice(0, 2).join(' | '));

  await browser.close();
  server.close();

  console.log(`\n===== 结果 ${passed}/${passed + failed} 通过，${failed} 失败 =====`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(2);
});
