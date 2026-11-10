/**
 * 限额滑块回写回归测试（本地 hermetic，不碰线上）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/limit-sync.cjs
 *
 * 用 Playwright 拦截 cloud.apipaw.com 的所有请求返回假数据，然后断言：
 *   1. 打开页面（服务端回填 daily_limit_usd=137.5）不得发出 PUT /api/v1/user/limit
 *   2. 用户拖动滑块后必须发出且只发出一次 PUT，且值是 10 的整数倍
 *
 * 回归背景：外部回填的限额曾被当成"用户拖动"回写，把服务端限额静默改写。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIST = path.join(__dirname, '..', 'dist');
/**
 * 测试凭证**只从环境变量读**——仓库里不再留任何硬编码 Key。
 * 跑法：APIPAW_API_KEY=<你的测试 key> node e2e/limit-sync.cjs
 */
const API_KEY = process.env.APIPAW_API_KEY;
if (!API_KEY) {
  console.error('缺少环境变量 APIPAW_API_KEY —— 仓库内不再内置默认 Key，请显式传入。');
  process.exit(2);
}
const SERVER_LIMIT = 137.5; // 刻意用非 10 整倍数的值，验证不被取整也不被回写

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

function mockResponse(pathname, method, body) {
  const json = (obj, status = 200) => ({ status, obj });
  switch (`${method} ${pathname}`) {
    case 'GET /api/v1/user/usage':
      return json({ api_key: API_KEY, balance_usd: 999.99, daily_limit_usd: SERVER_LIMIT, spent_today_usd: 3.25, usd_to_cgas: 100 });
    case 'GET /api/v1/user/analytics':
      return json(analyticsFixture);
    case 'GET /v1/models':
      return json({ object: 'list', data: [] });
    case 'GET /api/v1/owner/dashboard':
      return json({ active_nodes_online: 1, registered_nodes_total: 1, nodes: [] });
    case 'GET /api/v1/creator/models':
      return json({ object: 'list', data: [] });
    case 'GET /api/v1/creator/topology/':
    case 'GET /api/v1/creator/topology':
      return json({ object: 'list', data: [] });
    case 'GET /api/v1/creator/royalty':
      return json({ rows: [] });
    case 'PUT /api/v1/user/limit': {
      const v = Number(body?.daily_limit_usd ?? 0);
      return json({ status: 'success', api_key: API_KEY, daily_limit_usd: v, spent_today_usd: 3.25 });
    }
    default:
      return json({ detail: 'mocked' }, 200);
  }
}

async function main() {
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
  await context.addInitScript(
    ([key]) => {
      try {
        window.localStorage.setItem('apipaw.api_key', key);
      } catch (e) {}
    },
    [API_KEY],
  );

  const page = await context.newPage();
  const puts = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.route('**://cloud.apipaw.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    let body = null;
    try {
      body = req.postDataJSON();
    } catch (e) {}
    console.log(`  [req] ${req.method()} ${u.pathname}${body ? ' ' + JSON.stringify(body) : ''}`);
    if (req.method() === 'PUT' && u.pathname === '/api/v1/user/limit') {
      puts.push(body);
    }
    const { status, obj } = mockResponse(u.pathname, req.method(), body);
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(obj),
    });
  });

  console.log('\n[1] 打开页面（服务端回填 daily_limit_usd=137.5）');
  await page.goto(baseUrl, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForSelector('[data-testid="limit-slider"]', { timeout: 60000 });
  // 等 usage / analytics 都回填完，并留出防抖窗口
  await sleep(4000);

  check(puts.length === 0, '打开页面不触发 PUT /api/v1/user/limit', puts.length ? `发出 ${puts.length} 次：${JSON.stringify(puts)}` : '');

  const shown = await page.locator('[data-testid="limit-slider"]').innerText();
  check(shown.includes('137.5'), '滑块显示服务端原值（未被取整）', shown.replace(/\n/g, ' '));

  console.log('\n[2] 用户拖动滑块');
  // 滑块在首屏之下 —— 必须先滚进视口，否则触摸事件落在视口外，PanResponder 收不到
  await page.locator('[data-testid="limit-slider"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  const track = await page.locator('[data-testid="limit-slider-track"]').boundingBox();
  const thumb = await page.locator('[data-testid="limit-slider-thumb"]').boundingBox();
  check(!!track && !!thumb, '滑块可定位', track ? `track ${Math.round(track.width)}px` : '');

  if (track && thumb) {
    const startX = thumb.x + thumb.width / 2;
    const startY = thumb.y + thumb.height / 2;
    const usable = Math.max(1, track.width - 22);
    // 往右拖约 40% 轨道 → 期望值 ≈ 137.5 + 0.4*(500-10) = 317.5 → 步进到 320
    const endX = startX + usable * 0.4;

    // RNW 的 responder 系统走 touch 事件，Playwright 的 mouse API 不会驱动 PanResponder
    const cdp = await context.newCDPSession(page);
    const touch = (type, x, y) =>
      cdp.send('Input.dispatchTouchEvent', {
        type,
        touchPoints: type === 'touchEnd' ? [] : [{ x, y, radiusX: 5, radiusY: 5, force: 1 }],
      });

    await touch('touchStart', startX, startY);
    await sleep(60);
    for (let i = 1; i <= 12; i++) {
      await touch('touchMove', startX + ((endX - startX) * i) / 12, startY);
      await sleep(30);
    }
    await touch('touchEnd', endX, startY);
    await sleep(2500); // 等 450ms 防抖 + 请求

    const after = await page.locator('[data-testid="limit-slider"]').innerText();
    console.log(`  [debug] 拖动后滑块文本: ${after.replace(/\n/g, ' ')}`);

    check(puts.length === 1, '拖动后恰好发出一次 PUT', `实际 ${puts.length} 次`);
    if (puts.length === 1) {
      const v = Number(puts[0].daily_limit_usd);
      check(Number.isFinite(v), 'PUT 携带 daily_limit_usd', JSON.stringify(puts[0]));
      check(v % 10 === 0 && v >= 10 && v <= 500, 'PUT 值在 [10,500] 且为 10 的整数倍', String(v));
      check(v !== SERVER_LIMIT, 'PUT 值与回填原值不同', `${v} vs ${SERVER_LIMIT}`);
    }
  }

  check(pageErrors.length === 0, '无 JS 运行时错误', pageErrors.join(' | '));

  await browser.close();
  server.close();

  console.log(`\n===== 结果 ${passed}/${passed + failed} 通过，${failed} 失败 =====`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(2);
});
