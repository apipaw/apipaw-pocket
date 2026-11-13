/**
 * Playground P3 回归测试（本地 hermetic，不碰线上）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/playground-export.cjs
 *
 * 用 Playwright 拦截 cloud.apipaw.com 的所有请求返回假数据，然后断言 P3 两个交付：
 *   ① 代码导出**状态化**：cURL / Python / JS 三个 tab 都从**当前实时状态**生成
 *      （当前 model、temperature、top_p、max_tokens、System Prompt、流式开关），
 *      并且点「一键复制」有"已复制"反馈、切换 tab 会清掉反馈。
 *   ② 账单区**二元占比环**：AnalyticsCard 基于后端下发的 split 聚合
 *      手绘 SVG 环 + 占比条，直观展示「基础算力费 vs 版税池（创作者+平台）」。
 *
 * 回归背景：阶段五 P3 之前，导出代码里的参数是写死的、复制没有反馈，
 * 账单区也只有"场景占比"环，看不出「算力费 vs 版税」的二元结构。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIST = path.join(__dirname, '..', 'dist');
/** 测试凭证**只从环境变量读**——仓库里不保留任何硬编码 Key。 */
const API_KEY = process.env.APIPAW_API_KEY;
if (!API_KEY) {
  console.error('缺少环境变量 APIPAW_API_KEY —— 仓库内不再内置默认 Key，请显式传入。');
  process.exit(2);
}

/** 后端下发的 split 聚合（阶段五 P3）：基础算力费 0.72 / 版税池 0.08 / 总额 0.80 */
const SPLIT = {
  base_compute_usd: 0.72,
  royalty_pool_usd: 0.08,
  creator_share_usd: 0.068,
  node_share_usd: 0.612,
  platform_total_usd: 0.12,
  total_usd: 0.8,
  total_cgas: 80,
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
  id: 'paw-e2e-export-model',
  object: 'model',
  display_name: 'E2E 导出回归模型',
  description: 'Playground P3 代码导出回归专用',
  tier: 'CREATOR',
  tier_label: '社区创作者',
  scenario: 'B',
  royalty_rate: 0.15,
  context_window: 8192,
  reasoning: false,
  pricing: {
    prompt_per_1k_usd: 0.001,
    completion_per_1k_usd: 0.002,
    prompt_per_1k_cgas: 0.1,
    completion_per_1k_cgas: 0.2,
    usd_to_cgas: 100,
  },
};

const usageFixture = {
  prompt_tokens: 120,
  completion_tokens: 80,
  total_tokens: 200,
  cost_usd: 0.0023,
  cgas: 0.23,
  answer_source: 'node',
  p_compute_usd: 0.002,
  p_royalty_usd: 0.0003,
  node_share_usd: 0.0017,
  creator_share_usd: 0.000255,
  platform_compute_fee_usd: 0.0003,
  platform_royalty_fee_usd: 0.000045,
  platform_total_usd: 0.000345,
  royalty_rate: 0.15,
};

const sseBody = [
  'data: {"choices":[{"delta":{"content":"模拟回答。"}}]}',
  `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: usageFixture })}`,
  'data: [DONE]',
  '',
  '',
].join('\n');

async function main() {
  const live = process.argv[2] || null;
  const server = live ? null : await startStaticServer();
  const port = server ? server.address().port : 0;
  const baseUrl = live || `http://127.0.0.1:${port}/`;
  console.log(`目标站点: ${baseUrl}${live ? '（线上探针）' : ''}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
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
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  let lastChatBody = null;
  await page.route('**://cloud.apipaw.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());

    if (u.pathname === '/v1/chat/completions') {
      lastChatBody = req.postData();
      const body = JSON.parse(req.postData() || '{}');
      if (body.stream === false) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          headers: { 'X-APIPaw-Dispatch': 'node' },
          body: JSON.stringify({
            id: 'chatcmpl-e2e-export',
            object: 'chat.completion',
            model: body.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: '非流式回答。' },
                finish_reason: 'stop',
              },
            ],
            usage: usageFixture,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        headers: {
          'X-APIPaw-Dispatch': 'node',
          'Access-Control-Expose-Headers': 'X-APIPaw-Dispatch',
          'Access-Control-Allow-Origin': '*',
        },
        body: sseBody,
      });
      return;
    }

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
          : u.pathname === '/api/v1/user/analytics'
            ? {
                window_hours: 24,
                generated_at: Math.floor(Date.now() / 1000),
                hours: [],
                tiers: [],
                models: [],
                settlement: {
                  node_earn_usd: 0.612,
                  creator_royalty_usd: 0.068,
                  platform_fee_usd: 0.12,
                  total_usd: 0.8,
                  total_cgas: 80,
                },
                split: SPLIT,
                totals: {
                  prompt_tokens: 100,
                  completion_tokens: 50,
                  total_tokens: 150,
                  cost_usd: 0.8,
                  cgas: 80,
                  requests: 3,
                },
              }
            : { object: 'list', data: [], rows: [], tiers: [], models: [] };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(obj),
    });
  });

  console.log('\n[1] 打开页面');
  await page.goto(baseUrl, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForSelector('[data-testid="playground-card"]', { timeout: 60000 });
  await sleep(3000);

  // ---------------------------------------------------------------
  console.log('\n[2] 账单区二元占比环（基础算力费 vs 版税池）');
  const ring = page.locator('[data-testid="analytics-split-ring"]');
  check((await ring.count()) > 0, '占比环已渲染');
  const baseText = await page.locator('[data-testid="analytics-split-base"]').innerText().catch(() => '');
  const royaltyText = await page
    .locator('[data-testid="analytics-split-royalty"]')
    .innerText()
    .catch(() => '');
  console.log(`  [debug] 基础算力费: ${baseText.replace(/\n/g, ' ')}`);
  console.log(`  [debug] 版税池: ${royaltyText.replace(/\n/g, ' ')}`);
  check(baseText.includes('0.7200'), '基础算力费取后端 split.base_compute_usd', baseText);
  check(baseText.includes('90.0%'), '基础算力费占比 90.0%', baseText);
  check(royaltyText.includes('0.0800'), '版税池取后端 split.royalty_pool_usd', royaltyText);
  check(royaltyText.includes('10.0%'), '版税池占比 10.0%', royaltyText);
  const barBase = page.locator('[data-testid="analytics-split-bar-base"]');
  const barRoyalty = page.locator('[data-testid="analytics-split-bar-royalty"]');
  check((await barBase.count()) > 0 && (await barRoyalty.count()) > 0, '占比条两段都在');
  const nodeText = await page.locator('[data-testid="analytics-split-node"]').innerText().catch(() => '');
  const creatorText = await page.locator('[data-testid="analytics-split-creator"]').innerText().catch(() => '');
  const platformText = await page.locator('[data-testid="analytics-split-platform"]').innerText().catch(() => '');
  check(
    nodeText.includes('0.6120') && creatorText.includes('0.0680') && platformText.includes('0.1200'),
    '三方分账取后端 split 聚合',
    `${nodeText} | ${creatorText} | ${platformText}`,
  );

  // ---------------------------------------------------------------
  console.log('\n[3] 代码导出 · 状态化');
  // 先改参数：System Prompt + 流式开关
  await page.locator('[data-testid="playground-params-toggle"]').click();
  await sleep(600);
  const sysInput = page.locator('[data-testid="pg-system-input"]');
  check((await sysInput.count()) > 0, '参数面板可展开');
  if ((await sysInput.count()) > 0) {
    await sysInput.click();
    await sysInput.fill('你是一个严谨的分布式系统导师');
    await sleep(400);
  }

  await page.locator('[data-testid="playground-export-open"]').click();
  await sleep(800);
  const code = page.locator('[data-testid="playground-export-code"]');
  check((await code.count()) > 0, '导出代码块存在');
  const curlText = (await code.innerText()).replace(/\n/g, ' ');
  console.log(`  [debug] cURL: ${curlText.slice(0, 220)}`);
  check(curlText.includes(modelFixture.id), 'cURL 注入当前 model');
  check(curlText.includes('"temperature"'), 'cURL 注入 temperature');
  check(curlText.includes('"top_p"'), 'cURL 注入 top_p');
  check(curlText.includes('"max_tokens"'), 'cURL 注入 max_tokens');
  check(curlText.includes('你是一个严谨的分布式系统导师'), 'cURL 注入当前 System Prompt');
  check(curlText.includes('"stream": true'), 'cURL 注入流式开关（当前为开）');

  // 切到 Python tab
  await page.locator('[data-testid="playground-export-tab-python"]').click();
  await sleep(500);
  const pyText = (await code.innerText()).replace(/\n/g, ' ');
  check(pyText.includes('stream=True'), 'Python tab 用流式写法');
  check(pyText.includes(modelFixture.id), 'Python tab 注入当前 model');
  check(pyText.includes('你是一个严谨的分布式系统导师'), 'Python tab 注入 System Prompt');

  // 切到 JS tab
  await page.locator('[data-testid="playground-export-tab-javascript"]').click();
  await sleep(500);
  const jsText = (await code.innerText()).replace(/\n/g, ' ');
  check(jsText.includes('stream: true'), 'JavaScript tab 用流式写法');
  check(jsText.includes(modelFixture.id), 'JavaScript tab 注入当前 model');

  console.log('\n[4] 复制成功反馈');
  const copyState = page.locator('[data-testid="playground-export-copy-state"]');
  const before = (await copyState.innerText()).replace(/\n/g, ' ').trim();
  check(!/已复制/.test(before), '复制前没有"已复制"提示', before);
  await page.locator('[data-testid="playground-export-copy"]').click();
  await sleep(700);
  const after = (await copyState.innerText()).replace(/\n/g, ' ').trim();
  console.log(`  [debug] 复制后文案: ${after}`);
  check(/已复制/.test(after), '点复制后出现"已复制"反馈', after);

  // 切 tab 应清掉反馈（否则会把上一段代码的复制反馈错认成当前这段）
  await page.locator('[data-testid="playground-export-tab-curl"]').click();
  await sleep(500);
  const afterSwitch = (await copyState.innerText()).replace(/\n/g, ' ').trim();
  check(!/已复制/.test(afterSwitch), '切换 tab 会清掉"已复制"提示', afterSwitch);

  console.log('\n[5] 关掉流式开关 → 导出代码同步变成非流式');
  // 先关掉导出 Modal（它是全屏浮层，不关掉会挡住下面的参数面板）
  await page.locator('[data-testid="playground-export-close"]').click();
  await sleep(500);
  const streamToggle = page.locator('[data-testid="pg-stream-toggle"]');
  check((await streamToggle.count()) > 0, '流式开关存在');
  if ((await streamToggle.count()) > 0) {
    await streamToggle.click();
    await sleep(500);
    await page.locator('[data-testid="playground-export-open"]').click();
    await sleep(700);
    const curlOff = (await code.innerText()).replace(/\n/g, ' ');
    console.log(`  [debug] 非流式 cURL: ${curlOff.slice(0, 220)}`);
    check(/"stream": false/.test(curlOff), 'cURL 注入 stream=false', curlOff.slice(0, 200));
    await page.locator('[data-testid="playground-export-tab-python"]').click();
    await sleep(500);
    const pyOff = (await code.innerText()).replace(/\n/g, ' ');
    check(pyOff.includes('stream=False'), 'Python tab 同步为非流式写法');
  }

  console.log('\n[6] 非流式请求真的走 stream=false');
  // 同样先关掉导出 Modal，否则浮层会挡住输入框
  await page.locator('[data-testid="playground-export-close"]').click();
  await sleep(500);
  const input = page.locator('#apx-playground-input');
  await input.click();
  await input.fill('非流式回归');
  await sleep(300);
  await page.locator('[data-testid="playground-send"]').click();
  await sleep(2500);
  console.log(`  [debug] 请求体: ${String(lastChatBody).slice(0, 220)}`);
  check(lastChatBody && JSON.parse(lastChatBody).stream === false, '请求体 stream=false');

  check(pageErrors.length === 0, '无 JS 运行时错误', pageErrors.join(' | '));

  await browser.close();
  if (server) server.close();

  console.log(`\n===== 结果 ${passed}/${passed + failed} 通过，${failed} 失败 =====`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('测试异常:', e);
  process.exit(2);
});
