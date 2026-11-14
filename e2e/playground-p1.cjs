/**
 * 阶段六 P1 · Playground 前端回归（本地 hermetic，不碰线上）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/playground-p1.cjs
 *
 * 用 Playwright 拦截 cloud.apipaw.com 的所有请求返回假数据，然后断言 P1 三件事：
 *   1. 档位展示：**节点硬件档位**（node_tier）与**模型需求档位**
 *      （model_capability_class）拆开显示 —— 两者不是一回事；
 *      节点没上报显存时明确写「未上报」，不许瞎猜。
 *   2. 免单小票：模拟回答 / 断流（WAIVED）⇒ 本次 $0，
 *      小票必须写清楚「为什么是 0」，而不是显示一个光秃秃的 0。
 *   3. 严格模式容量错误：503 no_capacity / 504 dispatch_timeout
 *      （带 Retry-After）⇒ 友好提示视图 + 「建议 N 秒后重试」，不是一坨 HTTP 码。
 *
 * 回归背景：阶段六 P1 之前，Playground 既看不到档位，也分不清「$0 是免单还是没跑」，
 * 严格模式报错只会甩一句「推理请求失败 (HTTP 503)」。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIST = path.join(__dirname, '..', 'dist');
/** 测试凭证**只从环境变量读**——仓库里不保留任何硬编码 Key。
 *  （本用例的所有请求都被 Playwright 拦截，Key 只是占位，不会打到任何真实服务。） */
const API_KEY = process.env.APIPAW_API_KEY || 'e2e-local-placeholder-key';

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
  id: 'paw-e2e-p1-model',
  object: 'model',
  display_name: 'E2E 阶段六 P1 模型',
  description: 'Playground 阶段六 P1 回归专用',
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

/** 场景 A：真实节点正常回答 —— 带**节点档位**与**模型需求档位** */
const USAGE_NODE = {
  prompt_tokens: 120,
  completion_tokens: 80,
  total_tokens: 200,
  cost_usd: 0.0023,
  cgas: 0.23,
  answer_source: 'node',
  usage_source: 'node',
  node_tier: 'C2',
  model_capability_class: 'C2',
  p_compute_usd: 0.002,
  p_royalty_usd: 0.0003,
  node_share_usd: 0.0017,
  creator_share_usd: 0.000255,
  platform_compute_fee_usd: 0.0003,
  platform_royalty_fee_usd: 0.000045,
  platform_total_usd: 0.000345,
  royalty_rate: 0.15,
};

/** 场景 B：模拟回答 ⇒ 免单 $0 */
const USAGE_WAIVED_SIM = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cost_usd: 0,
  cgas: 0,
  answer_source: 'simulated',
  usage_source: 'estimate',
  waived: true,
  waive_reason: '模拟回答，未产生可计费服务',
  p_compute_usd: 0,
  p_royalty_usd: 0,
  node_share_usd: 0,
  creator_share_usd: 0,
  platform_compute_fee_usd: 0,
  platform_royalty_fee_usd: 0,
  platform_total_usd: 0,
};

/** 场景 C：断流（已发分片但没跑完）⇒ 决策 D6 免单 $0 */
const USAGE_WAIVED_BREAK = {
  prompt_tokens: 12,
  completion_tokens: 6,
  total_tokens: 18,
  cost_usd: 0,
  cgas: 0,
  answer_source: 'interrupted',
  usage_source: 'estimate',
  waived: true,
  waive_reason: '流未完成（断流），按决策 D6 不计费',
  stream_error: 'backend_unavailable',
  p_compute_usd: 0,
  p_royalty_usd: 0,
  node_share_usd: 0,
  creator_share_usd: 0,
  platform_compute_fee_usd: 0,
  platform_royalty_fee_usd: 0,
  platform_total_usd: 0,
};

const sseBody = (usage) =>
  [
    'data: {"choices":[{"delta":{"content":"这是阶段六 P1 回归用的模拟回答。"}}]}',
    `data: ${JSON.stringify({ choices: [{ delta: {} }], usage })}`,
    'data: [DONE]',
    '',
    '',
  ].join('\n');

/** 严格模式容量错误响应体（网关 503/504 的形状） */
const capacityBody = (code) => ({
  error: {
    message:
      code === 'dispatch_timeout'
        ? '算力节点响应超时，本次请求未产生服务、未产生费用，请稍后重试'
        : '算力池当前没有可用节点，本次请求未产生服务、未产生费用，请稍后重试',
    type: 'apipaw_capacity_error',
    code,
  },
});

/** 当前场景（由每个用例切换） */
let mode = 'node';

async function sendOne(page) {
  const input = page.locator('#apx-playground-input');
  await input.click();
  await input.fill('阶段六 P1 前端回归');
  await sleep(300);
  await page.locator('[data-testid="playground-send"]').click();
  await sleep(2500);
}

async function main() {
  const server = await startStaticServer();
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}/`;
  console.log(`目标站点: ${baseUrl}`);

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
      if (mode === 'no_capacity') {
        await route.fulfill({
          status: 503,
          contentType: 'application/json; charset=utf-8',
          headers: {
            'Retry-After': '5',
            'Access-Control-Expose-Headers': 'Retry-After',
            'Access-Control-Allow-Origin': '*',
          },
          body: JSON.stringify(capacityBody('no_capacity')),
        });
        return;
      }
      if (mode === 'dispatch_timeout') {
        await route.fulfill({
          status: 504,
          contentType: 'application/json; charset=utf-8',
          headers: {
            'Retry-After': '5',
            'Access-Control-Expose-Headers': 'Retry-After',
            'Access-Control-Allow-Origin': '*',
          },
          body: JSON.stringify(capacityBody('dispatch_timeout')),
        });
        return;
      }
      const usage =
        mode === 'waived_sim'
          ? USAGE_WAIVED_SIM
          : mode === 'waived_break'
            ? USAGE_WAIVED_BREAK
            : USAGE_NODE;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream; charset=utf-8',
        headers: {
          'X-APIPaw-Dispatch': mode === 'waived_sim' ? 'simulated' : 'node',
          'Access-Control-Expose-Headers': 'X-APIPaw-Dispatch',
          'Access-Control-Allow-Origin': '*',
        },
        body: sseBody(usage),
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
          : { object: 'list', data: [], rows: [], tiers: [], models: [] };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(obj),
    });
  });

  const openPage = async () => {
    await page.goto(baseUrl, { waitUntil: 'commit', timeout: 60000 });
    await page.waitForSelector('[data-testid="playground-card"]', { timeout: 60000 });
    await sleep(2500);
  };

  // ---------- 1. 档位展示 ----------
  console.log('\n[1] D10 · 节点硬件档位 / 模型需求档位拆开展示');
  mode = 'node';
  await openPage();
  await sendOne(page);

  const nodeTier = page.locator('[data-testid="playground-tier-node"]');
  const modelTier = page.locator('[data-testid="playground-tier-model"]');
  check((await nodeTier.count()) > 0, '节点档位芯片存在');
  check((await modelTier.count()) > 0, '模型需求档位芯片存在');
  const nodeTierText = await nodeTier.innerText().catch(() => '');
  const modelTierText = await modelTier.innerText().catch(() => '');
  console.log(`  [debug] 节点档位: ${nodeTierText.replace(/\n/g, ' ')}`);
  console.log(`  [debug] 模型需求: ${modelTierText.replace(/\n/g, ' ')}`);
  check(nodeTierText.includes('C2') && nodeTierText.includes('进阶'), '节点档位显示 C2 进阶', nodeTierText.replace(/\n/g, ' '));
  check(modelTierText.includes('C2'), '模型需求档位显示 C2', modelTierText.replace(/\n/g, ' '));
  check(nodeTierText.includes('节点档位'), '节点档位有独立标签（不与模型档位混为一谈）');
  check(modelTierText.includes('模型需求档位'), '模型需求档位有独立标签');

  // ---------- 2. 免单小票（模拟回答） ----------
  console.log('\n[2] D5 · 模拟回答 ⇒ 免单 $0');
  mode = 'waived_sim';
  await openPage();
  await sendOne(page);

  const waived = page.locator('[data-testid="playground-receipt-waived"]');
  check((await waived.count()) > 0, '免单提示存在');
  const waivedText = await waived.innerText().catch(() => '');
  console.log(`  [debug] 免单提示: ${waivedText.replace(/\n/g, ' ')}`);
  check(waivedText.includes('免单'), '免单提示写明「免单」', waivedText.replace(/\n/g, ' '));
  check(waivedText.includes('模拟回答'), '免单提示给出原因（模拟回答）', waivedText.replace(/\n/g, ' '));
  const waivedTotal = await page.locator('[data-testid="playground-receipt-total"]').innerText();
  console.log(`  [debug] 总额: ${waivedTotal.replace(/\n/g, ' ')}`);
  check(waivedTotal.includes('0.000000'), '免单时买家实付为 0', waivedTotal.replace(/\n/g, ' '));
  check(waivedTotal.includes('已免单'), '总额行标注「已免单」', waivedTotal.replace(/\n/g, ' '));

  // ---------- 3. 免单小票（断流） ----------
  console.log('\n[3] D6 · 断流 ⇒ 免单 $0（原因不同）');
  mode = 'waived_break';
  await openPage();
  await sendOne(page);

  const breakWaived = page.locator('[data-testid="playground-receipt-waived"]');
  check((await breakWaived.count()) > 0, '断流免单提示存在');
  const breakText = await breakWaived.innerText().catch(() => '');
  console.log(`  [debug] 断流免单: ${breakText.replace(/\n/g, ' ')}`);
  check(breakText.includes('断流'), '断流免单提示写明「断流」', breakText.replace(/\n/g, ' '));
  const breakTotal = await page.locator('[data-testid="playground-receipt-total"]').innerText();
  check(breakTotal.includes('0.000000'), '断流时买家实付为 0', breakTotal.replace(/\n/g, ' '));

  // ---------- 4. 严格模式 503 no_capacity ----------
  console.log('\n[4] D5 · 严格模式 503 no_capacity → 友好提示视图');
  mode = 'no_capacity';
  await openPage();
  await sendOne(page);

  const cap = page.locator('[data-testid="playground-capacity-error"]');
  check((await cap.count()) > 0, '容量错误视图存在');
  const capText = await cap.innerText().catch(() => '');
  console.log(`  [debug] 容量视图: ${capText.replace(/\n/g, ' ')}`);
  check(capText.includes('没有可用节点'), '503 视图说明「没有可用节点」', capText.replace(/\n/g, ' '));
  check(capText.includes('未产生服务'), '503 视图说明未产生服务', capText.replace(/\n/g, ' '));
  check(capText.includes('5 秒'), '503 视图按 Retry-After 提示 5 秒后重试', capText.replace(/\n/g, ' '));
  check(capText.includes('未计费'), '503 视图说明本次未计费', capText.replace(/\n/g, ' '));
  const capCode = await page.locator('[data-testid="playground-capacity-code"]').innerText();
  check(capCode.includes('no_capacity'), '容量错误带上错误码 no_capacity', capCode.trim());
  const rawErr = await page.locator('text=/推理请求失败 \\(HTTP/').count();
  check(rawErr === 0, '不再直接甩「推理请求失败 (HTTP 503)」');

  // ---------- 5. 严格模式 504 dispatch_timeout ----------
  console.log('\n[5] D5 · 严格模式 504 dispatch_timeout → 友好提示视图');
  mode = 'dispatch_timeout';
  await openPage();
  await sendOne(page);

  const cap2 = page.locator('[data-testid="playground-capacity-error"]');
  check((await cap2.count()) > 0, '容量错误视图存在（504）');
  const capText2 = await cap2.innerText().catch(() => '');
  console.log(`  [debug] 容量视图: ${capText2.replace(/\n/g, ' ')}`);
  check(capText2.includes('超时'), '504 视图说明「超时」', capText2.replace(/\n/g, ' '));
  check(capText2.includes('5 秒'), '504 视图按 Retry-After 提示 5 秒后重试', capText2.replace(/\n/g, ' '));
  const capCode2 = await page.locator('[data-testid="playground-capacity-code"]').innerText();
  check(capCode2.includes('dispatch_timeout'), '容量错误带上错误码 dispatch_timeout', capCode2.trim());

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
