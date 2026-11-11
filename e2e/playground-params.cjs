/**
 * Playground 采样参数回归测试（本地 hermetic，不碰线上）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/playground-params.cjs
 *
 * 用 Playwright 拦截 cloud.apipaw.com 的所有请求返回假数据，然后断言：
 *   1. 参数面板可展开，三个滑块 + System Prompt 输入框都在
 *   2. 拖动滑块后参数摘要随之变化（滑块真的可拖，不是摆设）
 *   3. 发出请求时 body 里带上了 temperature / top_p / max_tokens，
 *      且 system 提示词以 role=system 的消息出现在最前
 *   4. 费用拆解三行（算力费 / 创作者版税 / 平台管理费）渲染的是后端下发的值
 *
 * 回归背景：阶段五 P0 之前，Playground 只能选模型，采样参数一概不可调 ——
 * 即便前端传了 top_p，后端也不接收、不下发，等于调了个寂寞。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIST = path.join(__dirname, '..', 'dist');
/**
 * 测试凭证**只从环境变量读**——仓库里不保留任何硬编码 Key。
 * 跑法：APIPAW_API_KEY=<你的测试 key> node e2e/playground-params.cjs
 */
const API_KEY = process.env.APIPAW_API_KEY;
if (!API_KEY) {
  console.error('缺少环境变量 APIPAW_API_KEY —— 仓库内不再内置默认 Key，请显式传入。');
  process.exit(2);
}

/** 后端下发的固定费用拆解 —— 前端必须原样展示，不能自己算 */
const USAGE_FIXTURE = {
  prompt_tokens: 120,
  completion_tokens: 80,
  total_tokens: 200,
  cost_usd: 0.0023,
  cgas: 0.23,
  base_compute_usd: 0.002,
  node_earn_usd: 0.0017,
  creator_royalty_usd: 0.0001,
  platform_fee_usd: 0.0002,
};

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

const modelFixture = {
  id: 'paw-e2e-model',
  object: 'model',
  display_name: 'E2E 测试模型',
  description: 'Playground 参数回归专用',
  tier: 'CREATOR',
  tier_label: '社区创作者',
  context_window: 8192,
  reasoning: true,
  pricing: {
    prompt_per_1k_usd: 0.001,
    completion_per_1k_usd: 0.002,
    prompt_per_1k_cgas: 0.1,
    completion_per_1k_cgas: 0.2,
    usd_to_cgas: 100,
  },
};

/** SSE 响应体：一个内容分片 + 一个带 usage 的分片 + [DONE] */
const sseBody = [
  'data: {"choices":[{"delta":{"content":"这是一段用于回归的模拟回答。"}}]}',
  `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: USAGE_FIXTURE })}`,
  'data: [DONE]',
  '',
  '',
].join('\n');

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
  const chatBodies = [];
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.route('**://cloud.apipaw.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    let body = null;
    try {
      body = req.postDataJSON();
    } catch (e) {}

    if (u.pathname === '/v1/chat/completions') {
      chatBodies.push(body);
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        body: sseBody,
      });
      return;
    }

    console.log(`  [req] ${req.method()} ${u.pathname}`);
    const obj =
      u.pathname === '/v1/models'
        ? { object: 'list', data: [modelFixture] }
        : u.pathname === '/api/v1/user/usage'
          ? {
              api_key: API_KEY,
              balance_usd: 99.99,
              daily_limit_usd: 100,
              spent_today_usd: 1.5,
              usd_to_cgas: 100,
            }
          : { object: 'list', data: [], rows: [], tiers: [], models: [] };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(obj),
    });
  });

  console.log('\n[1] 打开页面并展开采样参数面板');
  await page.goto(baseUrl, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForSelector('[data-testid="playground-card"]', { timeout: 60000 });
  await sleep(2500);

  const toggle = page.locator('[data-testid="playground-params-toggle"]');
  check(await toggle.count() > 0, '参数面板开关存在');

  await toggle.click();
  await sleep(600);
  const panel = page.locator('[data-testid="playground-params-panel"]');
  check(await panel.count() > 0, '点击后面板展开');

  for (const id of ['pg-temp-slider', 'pg-topp-slider', 'pg-maxtokens-slider', 'pg-system-input']) {
    check(await page.locator(`[data-testid="${id}"]`).count() > 0, `控件存在: ${id}`);
  }

  console.log('\n[2] 拖动 Temperature 滑块');
  const summaryBefore = await page.locator('[data-testid="playground-params-summary"]').innerText();
  const track = await page.locator('[data-testid="pg-temp-track"]').boundingBox();
  const thumb = await page.locator('[data-testid="pg-temp-thumb"]').boundingBox();
  check(!!track && !!thumb, '温度滑块可定位', track ? `track ${Math.round(track.width)}px` : '');

  if (track && thumb) {
    const startX = thumb.x + thumb.width / 2;
    const startY = thumb.y + thumb.height / 2;
    const usable = Math.max(1, track.width - 22);
    // 往右拖约 50% 轨道：默认 0.7，range [0,2] → 期望 ≈ 1.7
    const endX = startX + usable * 0.5;

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
    await sleep(500);

    const summaryAfter = await page.locator('[data-testid="playground-params-summary"]').innerText();
    console.log(`  [debug] 拖动前摘要: ${summaryBefore.replace(/\n/g, ' ')}`);
    console.log(`  [debug] 拖动后摘要: ${summaryAfter.replace(/\n/g, ' ')}`);
    check(summaryBefore !== summaryAfter, '拖动后参数摘要变化', summaryAfter.replace(/\n/g, ' '));
    check(/T=1\.[6-8]/.test(summaryAfter), '温度落在拖动预期的 1.6~1.8 区间', summaryAfter.replace(/\n/g, ' '));
  }

  console.log('\n[3] 填写 System Prompt 并发送');
  const systemText = '你是一个严谨的分布式系统导师';
  await page.locator('[data-testid="pg-system-input"]').fill(systemText);
  await sleep(300);

  const input = page.locator('#apx-playground-input');
  await input.click();
  await input.fill('解释一下 DePIN 的结算规则');
  await sleep(300);

  await page.locator('[data-testid="playground-send"]').click();
  await sleep(4000);

  check(chatBodies.length === 1, '恰好发出一次推理请求', `实际 ${chatBodies.length} 次`);
  if (chatBodies.length === 1) {
    const body = chatBodies[0];
    console.log(`  [debug] 请求体: ${JSON.stringify(body)}`);
    check(typeof body.temperature === 'number', '请求体带 temperature', String(body.temperature));
    check(typeof body.top_p === 'number', '请求体带 top_p', String(body.top_p));
    check(typeof body.max_tokens === 'number', '请求体带 max_tokens', String(body.max_tokens));
    check(body.temperature > 1 && body.temperature < 2, 'temperature 是拖动后的新值', String(body.temperature));
    check(Array.isArray(body.messages) && body.messages.length >= 2, '消息数组含 system + user', JSON.stringify(body.messages?.map((m) => m.role)));
    if (Array.isArray(body.messages) && body.messages.length >= 2) {
      check(body.messages[0].role === 'system', 'system 消息在最前', body.messages[0].role);
      check(body.messages[0].content === systemText, 'system 内容与输入框一致', body.messages[0].content);
      check(body.messages[body.messages.length - 1].role === 'user', 'user 消息在最后', body.messages[body.messages.length - 1].role);
    }
  }

  console.log('\n[4] 费用拆解渲染');
  const breakdown = page.locator('[data-testid="playground-cost-breakdown"]');
  check(await breakdown.count() > 0, '费用拆解区已渲染');
  if (await breakdown.count() > 0) {
    const compute = await page.locator('[data-testid="playground-cost-compute"]').innerText();
    const royalty = await page.locator('[data-testid="playground-cost-royalty"]').innerText();
    const platform = await page.locator('[data-testid="playground-cost-platform"]').innerText();
    console.log(`  [debug] ${compute} | ${royalty} | ${platform}`);
    check(compute.includes('0.002000'), '算力费用后端下发的 base_compute_usd', compute.replace(/\n/g, ' '));
    check(royalty.includes('0.000100'), '版税用后端下发的 creator_royalty_usd', royalty.replace(/\n/g, ' '));
    check(platform.includes('0.000200'), '平台管理费用后端下发的 platform_fee_usd', platform.replace(/\n/g, ' '));
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
