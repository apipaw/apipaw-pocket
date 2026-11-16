/**
 * 阶段八 P1/P2 · 线上验收（新手体验金水龙头 + 凭证弹窗「一键填入本机 Agent」）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/phase8-p1.cjs
 *
 * 产物：e2e/shots/phase8-*.png + e2e/phase8-report.json
 *
 * A 段（**线上真接口**）：自助签发 → 领 $0.50 体验金 → 保存密钥 → 余额刷新
 *   ① 控制台首屏挂载（访客态，未配置密钥）
 *   ② 打开密钥弹窗 → 「签发新 Key」拿到明文
 *   ③ 点「免费领取 $0.50 新手体验金」⇒ 真实 POST /api/v1/user/faucet 返回 200
 *   ④ 弹窗内提示到账金额
 *   ⑤ 勾选「我已保存」→ 保存 ⇒ 余额卡显示 $0.50，且 $0 状态区的领取按钮消失
 *
 * B 段（**本地 hermetic**，接口全部打桩）：凭证弹窗里的「一键填入本机 Agent」
 *   ⑥ 注入 OWNER 会话 + 桩接口 ⇒ 「新增算力节点」区块可用
 *   ⑦ 点「一键新增」⇒ 弹窗出现「一键填入本机 Agent」按钮
 *   ⑧ 该按钮旁的链接形如 http://127.0.0.1:52415/ui?node_id=…&node_secret=…
 *
 * ⚠️ A 段会**真的签发**一把 API Key 并**真的领取**一次体验金
 *    （该账户终身一次）。密钥与账户由调用方在云端清理。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE_URL = process.argv[2] || 'https://console.apipaw.com';
const DIST = path.join(__dirname, '..', 'dist');
const SHOT_DIR = path.join(__dirname, 'shots');
const REPORT = path.join(__dirname, 'phase8-report.json');
const T = {
  nav: Number(process.env.APIPAW_E2E_NAV_TIMEOUT || 90000),
  app: Number(process.env.APIPAW_E2E_APP_TIMEOUT || 180000),
  /** 单次挂载等待上限（CF 拉不下 bundle 时快速失败重试，别干等 3 分钟） */
  mount: Number(process.env.APIPAW_E2E_MOUNT_TIMEOUT || 45000),
  action: Number(process.env.APIPAW_E2E_ACTION_TIMEOUT || 30000),
  api: Number(process.env.APIPAW_E2E_API_TIMEOUT || 150000),
};

const results = [];
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

async function clickSafe(locator, name) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: T.action });
    await locator.click({ timeout: T.action });
    return true;
  } catch (e) {
    await sleep(800);
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: T.action });
      await locator.click({ timeout: T.action });
      return true;
    } catch (e2) {
      bad(name, `点击失败: ${e2.message}`);
      return false;
    }
  }
}

function byText(scope, text) {
  return scope.locator(`text=${text}`).first();
}

/** 最多 3 次重挂载 —— 本地 → Cloudflare 链路偶发拉不下 1.4MB bundle */
async function mount(page) {
  let mounted = false;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3 && !mounted; attempt++) {
    try {
      await page.goto(BASE_URL, { waitUntil: 'commit', timeout: T.nav });
      await page.waitForFunction(
        () => {
          const root = document.getElementById('root');
          return !!(root && root.innerHTML && root.innerHTML.length > 200);
        },
        null,
        { timeout: T.mount, polling: 1000 }
      );
      mounted = true;
      ok('① 控制台首屏挂载', `尝试 ${attempt} 次`);
    } catch (e) {
      lastErr = e;
      console.log(`  [retry] 第 ${attempt} 次挂载失败：${e.message}`);
      // ⚠️ 不能 page.close() —— 页面对象会失效，后续 goto 直接报
      //    "Target page, context or browser has been closed"。改用同页重走。
    }
  }
  if (!mounted) throw lastErr;
}

/** 本地静态服务器（serve dist/，SPA 回退） */
function startStaticServer() {
  return new Promise((resolve) => {
    const MIME = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.ico': 'image/x-icon',
      '.json': 'application/json; charset=utf-8',
    };
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

/** ===================== A 段：线上真接口 ===================== */
async function runOnline(browser) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const apiLog = [];
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/v1/')) apiLog.push({ url: u, status: res.status() });
  });

  try {
    await mount(page);

    // ② 打开密钥弹窗并签发
    //    首屏没有密钥时应用会自动弹出「设置 API Key」弹窗 ⇒ 先看弹窗是否已开
    let modalOpen = (await page.locator('#apx-modal').count()) > 0;
    if (!modalOpen) {
      const keyBtn = byText(page, '未设置密钥');
      if ((await keyBtn.count()) === 0) {
        const alt = byText(page, '设置密钥');
        await clickSafe(alt, '②a 打开密钥弹窗');
      } else {
        await clickSafe(keyBtn, '②a 打开密钥弹窗');
      }
      await sleep(1200);
      modalOpen = (await page.locator('#apx-modal').count()) > 0;
    }
    check(modalOpen, '②a 打开密钥弹窗', modalOpen ? '弹窗已开' : '弹窗未打开');
    const issueBtn = byText(page, '签发新 Key');
    if ((await issueBtn.count()) === 0) {
      bad('② 打开密钥弹窗并签发', '未找到「签发新 Key」按钮');
      return;
    }
    await clickSafe(issueBtn, '② 打开密钥弹窗并签发');
    let issued = '';
    try {
      await page.waitForSelector('[data-testid="issue-key-plaintext"]', { timeout: T.api });
      issued = (await page.locator('[data-testid="issue-key-plaintext"]').first().innerText()).trim();
    } catch (e) {
      bad('② 打开密钥弹窗并签发', `未拿到明文: ${e.message}`);
      return;
    }
    check(!!issued && issued.length > 10, '② 签发新 Key ⇒ 拿到明文', issued.slice(0, 12) + '…');
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase8-01-issued.png'), fullPage: false });

    // ③ 领取体验金
    const faucetBtn = page.locator('[data-testid="issue-key-faucet-btn"]').first();
    const hasFaucet = (await faucetBtn.count()) > 0;
    check(hasFaucet, '③ 签发弹窗内出现「免费领取 $0.50 新手体验金」按钮', hasFaucet ? '已渲染' : '未渲染');
    if (!hasFaucet) return;

    await clickSafe(faucetBtn, '③ 领取体验金');
    let faucetStatus = 0;
    try {
      await page.waitForSelector('[data-testid="issue-key-faucet-ok"]', { timeout: T.api });
      faucetStatus = 200;
    } catch (e) {
      const errSel = page.locator('[data-testid="issue-key-faucet-error"]');
      if ((await errSel.count()) > 0) {
        faucetStatus = 409;
        bad('③ 领取体验金', `前端报错：${(await errSel.first().innerText()).trim()}`);
        return;
      }
      bad('③ 领取体验金', `未出现到账提示: ${e.message}`);
      return;
    }
    const faucetResp = apiLog.find((r) => r.url.includes('/api/v1/user/faucet'));
    check(
      faucetStatus === 200 && !!faucetResp && faucetResp.status === 200,
      '③ 领取体验金 ⇒ POST /api/v1/user/faucet 返回 200',
      faucetResp ? `HTTP ${faucetResp.status}` : '未捕获到请求'
    );

    // ④ 到账提示
    const okText = (await page.locator('[data-testid="issue-key-faucet-ok"]').first().innerText()).trim();
    check(okText.includes('0.50'), '④ 弹窗内提示已到账 $0.50', okText);
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase8-02-faucet.png'), fullPage: false });

    // ⑤ 保存 ⇒ 余额刷新
    const confirm = page.locator('[data-testid="issue-key-confirm"]').first();
    await clickSafe(confirm, '⑤a 勾选「我已保存」');
    await sleep(400);
    const save = page.locator('[data-testid="issue-key-save"]').first();
    await clickSafe(save, '⑤b 保存并使用此密钥');
    await sleep(3500);
    const balanceText = await page
      .locator('[id="apx-grad-text-balance"]')
      .first()
      .innerText()
      .catch(() => '');
    check(
      balanceText.includes('0.50'),
      '⑤ 保存后余额卡显示 $0.50',
      `balance=${balanceText.trim()}`
    );
    const stillThere = await page.locator('[data-testid="balance-faucet-btn"]').count();
    check(stillThere === 0, '⑤ 余额 > 0 后 $0 状态区的领取按钮消失', `count=${stillThere}`);
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase8-03-balance.png'), fullPage: false });

    // 清理：把签发的明文 Key 交回给调用方（脚本末尾打印）
    console.log(`  [issued-key] ${issued}`);
    await context.close();
  } catch (e) {
    bad('A 段线上验收', e.message);
    try {
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase8-error.png'), fullPage: true });
    } catch (_) {}
    await context.close();
  }
}

/** ===================== B 段：本地 hermetic（凭证弹窗） ===================== */
async function runHermetic(browser) {
  const server = await startStaticServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem(
        'apipaw.session',
        JSON.stringify({
          token: 'mock-owner-session',
          expiresAt: Math.floor(Date.now() / 1000) + 7200,
          handle: 'acct_mockowner',
          role: 'OWNER',
          status: 'active',
          wallet: '0x4609B825bb42F5BC839339c30F8960569CC82717',
        })
      );
      // 有 Key ⇒ 首屏不会自动弹出「设置 API Key」弹窗（否则遮罩挡住所有点击）
      window.localStorage.setItem('apipaw.api_key', 'paw-sk-e2e-mock-key');
    } catch (e) {}
  });

  const FAKE = {
    node_id: 'node_e2e_phase8',
    node_secret: 'secret_e2e_phase8_0123456789',
    secret_fingerprint: 'ab12cd34',
    status: 'success',
    message: '凭证已签发',
    rotated: false,
  };

  await context.route('**/api/v1/**', async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    const json = (body) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(body),
      });
    if (url.includes('/owner/nodes/governance')) return json({ nodes: [] });
    if (url.includes('/owner/nodes/issue-credential')) {
      if (method === 'POST') return json(FAKE);
    }
    if (url.includes('/owner/node/appeals') || url.includes('/owner/nodes/appeals')) {
      return json({ appeals: [] });
    }
    if (url.includes('/owner/dispatch/stats')) return json({});
    // ⚠️ 桩必须给足字段：前端对 total_earnings_paw 等直接 .toFixed()，
    //    缺字段 ⇒ 渲染期抛错 ⇒ React 整棵树被卸载 ⇒ root 为空 ⇒ 挂载超时。
    if (url.includes('/owner/nodes/revenue')) {
      return json({
        owner_wallet: '0x4609B825bb42F5BC839339c30F8960569CC82717',
        nodes_total: 0,
        total_earnings_paw: 0,
        total_tokens_processed: 0,
        nodes: [],
      });
    }
    if (url.includes('/owner/dashboard')) {
      return json({ active_nodes_online: 0, registered_nodes_total: 0, nodes: [] });
    }
    if (url.includes('/network/nodes')) return json({ nodes: [], count: 0 });
    if (url.includes('/creator/identity')) {
      return json({ author_wallet: '', creator_id: '' });
    }
    if (url.includes('/node/earnings')) {
      return json({
        owner_wallet: '0x4609B825bb42F5BC839339c30F8960569CC82717',
        earned_usd: 0,
        withdrawn_usd: 0,
        pending_usd: 0,
        available_usd: 0,
        tokens: 0,
        requests: 0,
        nodes: [],
        withdrawals: [],
      });
    }
    if (url.includes('/user/analytics')) {
      return json({
        window_hours: 24,
        generated_at: Math.floor(Date.now() / 1000),
        hours: [],
        tiers: [],
        models: [],
        settlement: {
          node_earn_usd: 0,
          creator_royalty_usd: 0,
          platform_fee_usd: 0,
          total_usd: 0,
          total_cgas: 0,
        },
        totals: { cost_usd: 0, cgas: 0, requests: 0, tokens: 0 },
      });
    }
    if (url.includes('/user/usage')) {
      return json({
        api_key: 'acct_mock',
        balance_usd: 0.5,
        daily_limit_usd: 50,
        spent_today_usd: 0,
        balance_frozen_usd: 0,
        role: 'BUYER',
        account_handle: 'acct_mock',
      });
    }
    if (url.includes('/network/health')) {
      return json({
        status: 'ok',
        online_nodes: 1,
        dispatchable_nodes: 1,
        busy_nodes: 0,
        servable_models: 1,
        catalog_models: 1,
        saturated: false,
        queue_wait_sec: 0,
        strict_mode: false,
        dispatch_enabled: true,
        real_stream: true,
      });
    }
    return json({});
  });

  const page = await context.newPage();
  try {
    await page.goto(base, { waitUntil: 'commit', timeout: T.nav });
    await page.waitForFunction(
      () => {
        const root = document.getElementById('root');
        return !!(root && root.innerHTML && root.innerHTML.length > 200);
      },
      null,
      { timeout: T.app, polling: 500 }
    );

    // OWNER 会话 ⇒ 自动切业主视角；找不到就手动切
    let govTab = byText(page, '节点治理');
    if ((await govTab.count()) === 0) {
      const sw = byText(page, '切换至业主视角');
      if ((await sw.count()) > 0) {
        await clickSafe(sw, '⑥a 切换至业主视角');
        await sleep(1500);
        govTab = byText(page, '节点治理');
      }
    }
    if ((await govTab.count()) === 0) {
      bad('⑥ 业主视角 · 节点治理可进入', '未找到「节点治理」标签');
      return;
    }
    await clickSafe(govTab, '⑥ 业主视角 · 节点治理可进入');
    await sleep(1500);
    const issueTitle = byText(page, '新增算力节点');
    check((await issueTitle.count()) > 0, '⑥ 「新增算力节点」区块可见', '');

    const btn = byText(page, '一键新增');
    if ((await btn.count()) === 0) {
      bad('⑦ 点「一键新增」⇒ 凭证弹窗', '未找到「一键新增」按钮');
      return;
    }
    await clickSafe(btn, '⑦ 点「一键新增」⇒ 凭证弹窗');
    await page.waitForSelector('[data-testid="issued-node-secret"]', { timeout: T.action });
    ok('⑦ 点「一键新增」⇒ 凭证弹窗（含明文 secret）', '');

    const linkBtn = page.locator('[data-testid="issued-open-agent"]').first();
    const hasLink = (await linkBtn.count()) > 0;
    check(hasLink, '⑦ 凭证弹窗内出现「一键填入本机 Agent」按钮', hasLink ? '已渲染' : '未渲染');
    if (!hasLink) return;

    const urlText = (await page.locator('[data-testid="issued-agent-url"]').first().innerText()).trim();
    const expectPrefix = 'http://127.0.0.1:52415/ui?node_id=';
    check(
      urlText.startsWith(expectPrefix) && urlText.includes('node_secret='),
      '⑧ 「一键填入本机 Agent」链接带 node_id + node_secret',
      urlText
    );
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase8-04-agent-link.png'), fullPage: false });
    await context.close();
  } catch (e) {
    bad('B 段 hermetic 验收', e.message);
    try {
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase8-b-error.png'), fullPage: true });
    } catch (_) {}
    await context.close();
  } finally {
    server.close();
  }
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--disable-ipv6'] });
  try {
    await runOnline(browser);
    await runHermetic(browser);
  } finally {
    await browser.close();
  }
  const passed = results.filter((r) => r.pass).length;
  console.log('');
  console.log(`===== 阶段八 P1/P2 线上验收：${passed}/${results.length} 通过 =====`);
  fs.writeFileSync(REPORT, JSON.stringify({ results, passed, total: results.length }, null, 2));
  process.exit(passed === results.length ? 0 : 1);
})();
