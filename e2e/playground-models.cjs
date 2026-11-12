/**
 * Playground 多模型切换 + 场景徽标 + 本次预计花费回归测试（本地 hermetic，不碰线上）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/playground-models.cjs
 *
 * 用 Playwright 拦截 cloud.apipaw.com 的所有请求返回假数据，然后断言：
 *   1. /v1/models 下发的 scenario / royalty_rate 被前端识别成「场景 A / 场景 B + 版税率」
 *   2. 模型下拉里每个模型都带场景标签，场景 B 额外显示版税率
 *   3. 切换模型后**会话与参数状态保留**（历史消息还在、采样参数没被重置）
 *   4. 「本次预计花费」随输入内容实时变化，且场景 B 的总价 == 算力费 × 1.15
 *
 * 回归背景：阶段五 P1 之前，Playground 只有一个模型下拉，
 * 既不显示场景/版税率，也没有任何「这次大概花多少钱」的提示。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIST = path.join(__dirname, '..', 'dist');
const API_KEY = process.env.APIPAW_API_KEY;
if (!API_KEY) {
  console.error('缺少环境变量 APIPAW_API_KEY —— 仓库内不再内置默认 Key，请显式传入。');
  process.exit(2);
}

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

/** 场景 A（开源基础模型）与场景 B（社区创作者模型 + 15% 版税）各一个 */
const modelA = {
  id: 'paw-e2e-base',
  object: 'model',
  display_name: 'E2E 基础模型',
  description: '场景 A 开源基础',
  tier: 'BASE',
  tier_label: '开源基础',
  scenario: 'A',
  royalty_rate: 0.15,
  royalty_mode: 'RATE',
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

const modelB = {
  id: 'paw-e2e-creator',
  object: 'model',
  display_name: 'E2E 创作者模型',
  description: '场景 B 社区创作者',
  tier: 'CREATOR',
  tier_label: '社区创作者',
  scenario: 'B',
  royalty_rate: 0.15,
  royalty_mode: 'RATE',
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

const sseBody = [
  'data: {"choices":[{"delta":{"content":"这是一段用于回归的模拟回答。"}}]}',
  'data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":120,"completion_tokens":80,"total_tokens":200,"cost_usd":0.0023,"cgas":0.23,"base_compute_usd":0.002,"node_earn_usd":0.0017,"creator_royalty_usd":0.0001,"platform_fee_usd":0.0002}}',
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

    const obj =
      u.pathname === '/v1/models'
        ? { object: 'list', data: [modelA, modelB] }
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

  console.log('\n[1] 打开页面，检查场景徽标与模型下拉');
  await page.goto(baseUrl, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForSelector('[data-testid="playground-card"]', { timeout: 60000 });
  await sleep(2500);

  const badge = page.locator('[data-testid="playground-scenario-badge"]');
  check(await badge.count() > 0, '场景徽标存在');
  const badgeText = await badge.innerText();
  console.log(`  [debug] 徽标: ${badgeText.replace(/\n/g, ' ')}`);
  check(/场景\s*A/.test(badgeText), '默认模型（场景 A）徽标正确', badgeText.replace(/\n/g, ' '));

  const meta = await page.locator('#apx-model-meta').innerText();
  check(meta.includes('场景 A · 开源基础模型'), '模型元信息含场景标签', meta.replace(/\n/g, ' '));

  console.log('\n[2] 打开模型下拉，检查每个模型的场景标签');
  await page.locator('[data-testid="playground-card"]').locator('text=推理模型').first().click();
  await sleep(800);
  const itemA = page.locator('[data-testid="playground-model-item-paw-e2e-base"]');
  const itemB = page.locator('[data-testid="playground-model-item-paw-e2e-creator"]');
  check(await itemA.count() > 0 && await itemB.count() > 0, '两个模型条目都在下拉里');
  const descA = await itemA.innerText();
  const descB = await itemB.innerText();
  console.log(`  [debug] A: ${descA.replace(/\n/g, ' ')} | B: ${descB.replace(/\n/g, ' ')}`);
  check(descA.includes('场景 A · 开源基础模型'), '场景 A 条目标签正确', descA.replace(/\n/g, ' '));
  check(descB.includes('场景 B · 社区创作者模型'), '场景 B 条目标签正确', descB.replace(/\n/g, ' '));
  check(/版税\s*15%/.test(descB), '场景 B 条目显示版税率 15%', descB.replace(/\n/g, ' '));

  console.log('\n[3] 切换到场景 B 模型');
  await itemB.click();
  await sleep(900);
  const badgeTextB = await badge.innerText();
  console.log(`  [debug] 徽标: ${badgeTextB.replace(/\n/g, ' ')}`);
  check(/场景\s*B/.test(badgeTextB), '切换后徽标变成场景 B', badgeTextB.replace(/\n/g, ' '));
  check(/版税\s*15%/.test(badgeTextB), '场景 B 徽标显示版税率', badgeTextB.replace(/\n/g, ' '));

  console.log('\n[4] 预计花费随输入变化');
  const preview = page.locator('[data-testid="playground-cost-preview-value"]');
  const detail = page.locator('[data-testid="playground-cost-preview-detail"]');
  check(await preview.count() > 0, '预计花费区已渲染');
  const beforeValue = await preview.innerText();
  const beforeDetail = await detail.innerText();
  console.log(`  [debug] 预估: ${beforeValue.replace(/\n/g, ' ')} | ${beforeDetail.replace(/\n/g, ' ')}`);

  const input = page.locator('#apx-playground-input');
  await input.click();
  await input.fill('解释一下 DePIN 的结算规则');
  await sleep(700);
  const afterValue = await preview.innerText();
  const afterDetail = await detail.innerText();
  console.log(`  [debug] 预估: ${afterValue.replace(/\n/g, ' ')} | ${afterDetail.replace(/\n/g, ' ')}`);
  check(beforeValue !== afterValue, '输入内容变化后预计花费随之变化', afterValue.replace(/\n/g, ' '));

  // 场景 B：总价必须等于算力费 × 1.15（决策 D1）
  const computeMatch = afterDetail.match(/算力 \$([0-9.]+)/);
  const royaltyMatch = afterDetail.match(/版税 15% \$([0-9.]+)/);
  const totalMatch = afterValue.match(/≈ \$([0-9.]+)/);
  const compute = computeMatch ? parseFloat(computeMatch[1]) : NaN;
  const royalty = royaltyMatch ? parseFloat(royaltyMatch[1]) : NaN;
  const total = totalMatch ? parseFloat(totalMatch[1]) : NaN;
  check(
    Number.isFinite(compute) && Number.isFinite(royalty) && Number.isFinite(total)
      // 界面上的金额是 6 位小数显示，容差取 1e-6（半单位舍入）
      && Math.abs(total - (compute + royalty)) < 1e-6
      && Math.abs(royalty - compute * 0.15) < 1e-6
      && Math.abs(total - compute * 1.15) < 1e-6,
    '场景 B 预计花费 = 算力费 × 1.15（版税按 15% 计）',
    JSON.stringify({ compute, royalty, total }),
  );

  console.log('\n[5] 切换模型保留会话与参数状态');
  await page.locator('[data-testid="playground-params-toggle"]').click();
  await sleep(500);
  await page.locator('[data-testid="pg-system-input"]').fill('你是一个严谨的分布式系统导师');
  await sleep(400);
  await page.locator('[data-testid="playground-send"]').click();
  await sleep(3500);
  const answers = await page.locator('text=这是一段用于回归的模拟回答。').count();
  check(answers > 0, '切换前发过一轮，对话区有回答');

  const paramsBefore = await page.locator('[data-testid="playground-params-summary"]').innerText();
  await page.locator('[data-testid="playground-card"]').locator('text=推理模型').first().click();
  await sleep(800);
  await page.locator('[data-testid="playground-model-item-paw-e2e-base"]').click();
  await sleep(900);
  const paramsAfter = await page.locator('[data-testid="playground-params-summary"]').innerText();
  const answersAfter = await page.locator('text=这是一段用于回归的模拟回答。').count();
  console.log(`  [debug] 参数前: ${paramsBefore.replace(/\n/g, ' ')} | 后: ${paramsAfter.replace(/\n/g, ' ')}`);
  check(paramsBefore === paramsAfter, '切换模型后采样参数状态保留', paramsAfter.replace(/\n/g, ' '));
  check(answersAfter === answers, '切换模型后会话历史保留', `${answers} -> ${answersAfter}`);
  const badgeTextA2 = await badge.innerText();
  check(/场景\s*A/.test(badgeTextA2), '切回后徽标回到场景 A', badgeTextA2.replace(/\n/g, ' '));
  const detailA = await page.locator('[data-testid="playground-cost-preview-detail"]').innerText();
  check(detailA.includes('无版税'), '场景 A 预计花费不含版税（网关下发的 0.15 不适用于场景 A）', detailA.replace(/\n/g, ' '));

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
