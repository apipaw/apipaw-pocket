/**
 * Playground P2 回归测试（本地 hermetic，不碰线上）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/playground-perf.cjs
 *
 * 用 Playwright 拦截 cloud.apipaw.com 的所有请求返回假数据，然后断言 D8/D9：
 *   D8 · 来源徽标：回答区与 CoT 折叠卡上都有「真实节点 / 模拟回答」徽标
 *        · CoT 折叠时显示 token 数、且带一键复制按钮
 *   D9 · 性能仪表盘：TTFT（本地计时）、吐字速度 tok/s、总 token 三块 StatTile
 *        · 流结束后渲染「账单小票」—— 四项费用取 v2 权威口径
 *
 * 回归背景：阶段五 P2 之前，Playground 只能看到一坨费用拆解文本，
 * 既不知道这答案是真节点跑的还是平台模拟的，也看不到延迟与吞吐。
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

/** 阶段五 P2 · v2 权威口径的 usage（场景 B：算力基价 + 15% 版税池）
 *  0.0017(节点) + 0.000255(创作者) + 0.000345(平台) = 0.0023(买家实付) */
const USAGE_FIXTURE = {
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
  id: 'paw-e2e-perf-model',
  object: 'model',
  display_name: 'E2E 性能回归模型',
  description: 'Playground P2 性能与来源徽标回归专用',
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

/** SSE 响应体：思考链 → 正文分片 → 带 usage 的分片 → [DONE] */
const sseBody = [
  'data: {"choices":[{"delta":{"reasoning_content":"先拆解问题，再给结论。"}}]}',
  'data: {"choices":[{"delta":{"content":"这是第一段用于回归的模拟回答。"}}]}',
  'data: {"choices":[{"delta":{"content":"这是第二段用于回归的模拟回答。"}}]}',
  `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: USAGE_FIXTURE })}`,
  'data: [DONE]',
  '',
  '',
].join('\n');

async function main() {
  // 传入站点地址即跑**线上**探针（仍用 mock 拦截 API，不碰真实账务）：
  //   node e2e/playground-perf.cjs https://console.apipaw.com
  const live = process.argv[2] || null;
  const server = live ? null : await startStaticServer();
  const port = server ? server.address().port : 0;
  const baseUrl = live || `http://127.0.0.1:${port}/`;
  console.log(`目标站点: ${baseUrl}${live ? '（线上探针）' : ''}`);

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
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  await page.route('**://cloud.apipaw.com/**', async (route) => {
    const req = route.request();
    const u = new URL(req.url());

    if (u.pathname === '/v1/chat/completions') {
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

  console.log('\n[1] 打开页面并发送一次推理请求');
  await page.goto(baseUrl, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForSelector('[data-testid="playground-card"]', { timeout: 60000 });
  await sleep(2500);

  const input = page.locator('#apx-playground-input');
  await input.click();
  await input.fill('讲讲去中心化算力的结算规则');
  await sleep(300);
  await page.locator('[data-testid="playground-send"]').click();
  await sleep(4000);

  console.log('\n[2] D8 · 来源徽标');
  const srcBadge = page.locator('[data-testid="playground-answer-source"]');
  check((await srcBadge.count()) > 0, '回答区来源徽标存在');
  if ((await srcBadge.count()) > 0) {
    const txt = (await srcBadge.innerText()).replace(/\n/g, ' ').trim();
    console.log(`  [debug] 回答来源徽标: ${txt}`);
    check(txt.includes('真实节点'), '来源徽标显示「真实节点」', txt);
  }

  const cotSrc = page.locator('[data-testid="playground-cot-source"]');
  check((await cotSrc.count()) > 0, 'CoT 卡片来源徽标存在');
  if ((await cotSrc.count()) > 0) {
    const txt = (await cotSrc.innerText()).replace(/\n/g, ' ').trim();
    console.log(`  [debug] CoT 来源徽标: ${txt}`);
    check(txt.includes('真实节点'), 'CoT 徽标显示「真实节点」', txt);
  }

  console.log('\n[3] D8 · CoT 折叠态 token 数 + 复制按钮');
  const cotTitle = page.locator('[data-testid="playground-cot-source"]').locator('xpath=ancestor::*[1]');
  const reasonText = await page
    .locator('text=/思考完成|深度思考中/')
    .first()
    .innerText()
    .catch(() => '');
  console.log(`  [debug] CoT 标题: ${reasonText.replace(/\n/g, ' ')}`);
  check(/Tokens/.test(reasonText), 'CoT 标题带 token 数', reasonText.replace(/\n/g, ' '));

  const copyBtn = page.locator('[data-testid="playground-cot-copy"]');
  check((await copyBtn.count()) > 0, 'CoT 复制按钮存在');
  if ((await copyBtn.count()) > 0) {
    await copyBtn.click();
    await sleep(500);
    const label = (await copyBtn.innerText()).replace(/\n/g, ' ').trim();
    console.log(`  [debug] 复制按钮文案: ${label}`);
    check(/复制/.test(label), '复制按钮文案为「复制 / 已复制」', label);
  }
  void cotTitle;

  console.log('\n[4] D9 · TTFT / 吐字速度 / 总 token 三块 StatTile');
  const ttft = page.locator('[data-testid="playground-stat-ttft"]');
  const tps = page.locator('[data-testid="playground-stat-tps"]');
  const tokens = page.locator('[data-testid="playground-stat-tokens"]');
  check((await ttft.count()) > 0, 'TTFT StatTile 存在');
  check((await tps.count()) > 0, '吐字速度 StatTile 存在');
  check((await tokens.count()) > 0, '总 token StatTile 存在');

  const ttftText = await ttft.innerText().catch(() => '');
  const tpsText = await tps.innerText().catch(() => '');
  const tokensText = await tokens.innerText().catch(() => '');
  console.log(`  [debug] TTFT: ${ttftText.replace(/\n/g, ' ')}`);
  console.log(`  [debug] TPS : ${tpsText.replace(/\n/g, ' ')}`);
  console.log(`  [debug] TOK : ${tokensText.replace(/\n/g, ' ')}`);

  const ttftNum = Number((ttftText.match(/([\d.]+)\s*(ms|s)/) || [])[1]);
  check(Number.isFinite(ttftNum) && ttftNum >= 0, 'TTFT 是本地计时的数值', `${ttftNum}`);
  const tpsNum = Number((tpsText.match(/([\d.]+)/) || [])[1]);
  check(Number.isFinite(tpsNum) && tpsNum > 0, '吐字速度为正数', `${tpsNum}`);
  check(tokensText.includes('200'), '总 token 取后端 usage.total_tokens', tokensText.replace(/\n/g, ' '));

  console.log('\n[5] D9 · 账单小票（四项费用，v2 权威口径）');
  const receipt = page.locator('[data-testid="playground-cost-breakdown"]');
  check((await receipt.count()) > 0, '账单小票已渲染');
  const compute = await page.locator('[data-testid="playground-cost-compute"]').innerText();
  const royalty = await page.locator('[data-testid="playground-cost-royalty"]').innerText();
  const platform = await page.locator('[data-testid="playground-cost-platform"]').innerText();
  const total = await page.locator('[data-testid="playground-receipt-total"]').innerText();
  console.log(`  [debug] ${compute} | ${royalty} | ${platform} | ${total}`);
  check(compute.includes('0.002000'), '算力费用 v2 的 p_compute_usd', compute.replace(/\n/g, ' '));
  check(royalty.includes('0.000255'), '创作者版税用 v2 的 creator_share_usd', royalty.replace(/\n/g, ' '));
  check(platform.includes('0.000345'), '平台管理费用 v2 的 platform_total_usd', platform.replace(/\n/g, ' '));
  check(total.includes('0.002300'), '买家实付总额等于 cost_usd', total.replace(/\n/g, ' '));

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
