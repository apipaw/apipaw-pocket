/**
 * 阶段九 P0~P3 · 线上验收（实时分账公示 / 网页自助上架 / 充值卡密闭环）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/phase9-p1.cjs
 *
 * 产物：e2e/shots/phase9-*.png + e2e/phase9-report.json
 *
 * 全程走**线上真接口**（https://console.apipaw.com + https://cloud.apipaw.com）：
 *   ① 首屏挂载（访客态，无密钥）
 *   ② 签发一把买家 API Key（真实账户）
 *   ③ 注入 OWNER 钱包会话（真实 nonce → 签名 → verify，不是伪造令牌）
 *   ④ 实时分账公示面板渲染出 win_node_01 的真实三方分账
 *   ⑤ 网页自助上架模型 ⇒ Playground 模型列表**当场**出现该模型
 *   ⑥ 签发充值卡密（明文只此一次）
 *   ⑦ 买家核销充值码 ⇒ 余额到账（真实 POST /api/v1/user/redeem）
 *
 * ⚠️ 本脚本会**真的**建账户 / 签模型 / 签卡密 —— 脚本末尾打印清理凭据，
 *    由云端清理脚本删除（账户、模型、卡密）以把基线还原到 1026.501342。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Wallet } = require('ethers');

const BASE_URL = process.argv[2] || 'https://console.apipaw.com';
const CLOUD_URL = process.env.APIPAW_CLOUD_URL || 'https://cloud.apipaw.com';
const OWNER_PK = (process.env.APIPAW_OWNER_PK || '').trim();
if (!/^0x[0-9a-fA-F]{64}$/.test(OWNER_PK)) {
  // ⚠️ 阶段二十二 P1：私钥**只**从环境变量注入。
  //   旧版本硬编码了一把公网上公开的演示私钥（对应地址
  //   0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1）⇒ 任何人都能冒充业主。
  //   现在缺失即退出，绝不兜底、绝不内置。
  console.error('[FATAL] 缺少或非法环境变量 APIPAW_OWNER_PK（业主钱包私钥）。');
  console.error('        私钥**不得**写进仓库；请在本地 shell 里 export 后重跑。');
  process.exit(1);
}
const MODEL_ID = process.env.APIPAW_E2E_MODEL_ID || 'p9:e2e-model';
const DIST = path.join(__dirname, '..', 'dist');
const SHOT_DIR = path.join(__dirname, 'shots');
const REPORT = path.join(__dirname, 'phase9-report.json');
const T = {
  nav: Number(process.env.APIPAW_E2E_NAV_TIMEOUT || 90000),
  app: Number(process.env.APIPAW_E2E_APP_TIMEOUT || 180000),
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

const byText = (scope, text) => scope.locator(`text=${text}`).first();

/** 最多 3 次重挂载 —— 本地 → Cloudflare 链路偶发拉不下 bundle */
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
      //    "Target page, context or browser has been closed"。
    }
  }
  if (!mounted) throw lastErr;
}

/** 取一个**真实**的 OWNER 钱包会话（nonce → 签名 → verify） */
async function fetchOwnerSession() {
  // 优先用服务端签发的 OWNER 会话（真实业主钱包的私钥我们没有、也不该有 ——
  // 钱包签名流程只能拿到 BUYER 会话，而阶段九的面板都是 OWNER 专属）。
  if (process.env.APIPAW_OWNER_TOKEN) {
    return {
      token: process.env.APIPAW_OWNER_TOKEN,
      handle: process.env.APIPAW_OWNER_HANDLE || '',
      role: 'OWNER',
      wallet: process.env.APIPAW_OWNER_WALLET || '',
    };
  }
  const wallet = new Wallet(OWNER_PK);
  const address = wallet.address;
  const nonceRes = await fetch(CLOUD_URL + '/api/v1/auth/nonce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, chain_id: 1 }),
  });
  if (!nonceRes.ok) throw new Error(`nonce 失败 ${nonceRes.status}`);
  const nonceBody = await nonceRes.json();
  const signature = await wallet.signMessage(nonceBody.message);
  const verifyRes = await fetch(CLOUD_URL + '/api/v1/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      message: nonceBody.message,
      signature,
      nonce: nonceBody.nonce,
    }),
  });
  if (!verifyRes.ok) throw new Error(`verify 失败 ${verifyRes.status}`);
  const body = await verifyRes.json();
  return {
    token: body.access_token,
    handle: body.user && body.user.handle,
    role: body.user && body.user.role,
    wallet: address,
  };
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: ['--disable-ipv6'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const apiLog = [];
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/v1/')) apiLog.push({ url: u, status: res.status() });
  });

  let issuedKey = '';
  let voucherCode = '';
  let ownerHandle = '';

  try {
    // ---- ③ 先取真实 OWNER 会话 ----
    let session = null;
    try {
      session = await fetchOwnerSession();
      ownerHandle = session.handle || '';
      ok('③ 取得真实 OWNER 钱包会话', `handle=${ownerHandle} role=${session.role}`);
    } catch (e) {
      bad('③ 取得真实 OWNER 钱包会话', e.message);
      throw e;
    }

    await mount(page);

    // ---- ② 签发一把买家 API Key（真实账户）----
    let modalOpen = (await page.locator('#apx-modal').count()) > 0;
    if (!modalOpen) {
      const alt = byText(page, '设置密钥');
      await clickSafe(alt, '②a 打开密钥弹窗');
      await sleep(1200);
      modalOpen = (await page.locator('#apx-modal').count()) > 0;
    }
    check(modalOpen, '②a 打开密钥弹窗', modalOpen ? '弹窗已开' : '弹窗未打开');

    const issueBtn = byText(page, '签发新 Key');
    if ((await issueBtn.count()) === 0) {
      bad('② 签发新 Key', '未找到「签发新 Key」按钮');
      throw new Error('issue button missing');
    }
    await clickSafe(issueBtn, '② 签发新 Key');
    try {
      await page.waitForSelector('[data-testid="issue-key-plaintext"]', { timeout: T.api });
      issuedKey = (await page.locator('[data-testid="issue-key-plaintext"]').first().innerText()).trim();
    } catch (e) {
      bad('② 签发新 Key', `未拿到明文: ${e.message}`);
      throw e;
    }
    check(!!issuedKey && issuedKey.length > 10, '② 签发新 Key ⇒ 拿到明文', issuedKey.slice(0, 12) + '…');

    const confirm = page.locator('[data-testid="issue-key-confirm"]').first();
    await clickSafe(confirm, '②b 勾选「我已保存」');
    await sleep(400);
    const save = page.locator('[data-testid="issue-key-save"]').first();
    await clickSafe(save, '②c 保存并使用此密钥');
    await sleep(3000);

    // ---- ③ 注入 OWNER 会话（真实钱包会话）----
    await context.addInitScript((s) => {
      try {
        window.localStorage.setItem('apipaw.session', JSON.stringify(s));
      } catch (e) {}
    }, {
      token: session.token,
      expiresAt: Math.floor(Date.now() / 1000) + 7200,
      handle: session.handle,
      role: session.role,
      status: 'active',
      wallet: session.wallet,
    });
    await mount(page);
    await sleep(2500);

    // ---- ④ 实时分账公示：owner 视角也能看到（GOVERNANCE 分段）----
    const govTab = byText(page, '节点治理');
    if ((await govTab.count()) > 0) {
      await clickSafe(govTab, '④a 进入节点治理分段');
      await sleep(2000);
    }
    const feedCard = page.locator('[data-testid="live-settle-card"]').first();
    check((await feedCard.count()) > 0, '④ 实时分账公示面板已渲染', '');
    const feedText = (await page
      .locator('[data-testid="live-settle-card"]')
      .first()
      .innerText()
      .catch(() => '')) || '';
    check(
      feedText.includes('win_node_01') && feedText.includes('三方'),
      '④ 公示面板含 win_node_01 真实分账',
      feedText.replace(/\s+/g, ' ').slice(0, 120)
    );
    check(
      feedText.includes('节点分成') && feedText.includes('创作者版税') && feedText.includes('平台管理费'),
      '④ 公示面板给出三方金额口径',
      ''
    );
    // request_id 必须已脱敏（不得出现 chatcmpl- 全文）
    const rawId = await page
      .locator('[data-testid="live-settle-row-0"]')
      .first()
      .innerText()
      .catch(() => '');
    check(!rawId.includes('chatcmpl-'), '④ request_id 已脱敏（不出现原文）', rawId.replace(/\s+/g, ' ').slice(0, 80));
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase9-01-live-feed.png'), fullPage: false });

    // ---- ⑤ 网页自助上架模型 ----
    const studioTab = byText(page, '模型工作台');
    if ((await studioTab.count()) === 0) {
      bad('⑤ 进入模型工作台', '未找到「模型工作台」标签');
    } else {
      await clickSafe(studioTab, '⑤ 进入模型工作台');
      await sleep(1500);
      const upsertCard = page.locator('[data-testid="model-upsert-card"]').first();
      check((await upsertCard.count()) > 0, '⑤ 上架表单已渲染', '');
      await page.locator('[data-testid="model-upsert-model-id"]').first().fill(MODEL_ID);
      await page.locator('[data-testid="model-upsert-display-name"]').first().fill('P9 E2E 演示模型');
      await page.locator('[data-testid="model-upsert-tier-CREATOR"]').first().click();
      await sleep(300);
      await page.locator('[data-testid="model-upsert-royalty-rate"]').first().fill('0.15');
      await page.locator('[data-testid="model-upsert-creator-id"]').first().fill('creator_e2e_p9');
      await page
        .locator('[data-testid="model-upsert-author-wallet"]')
        .first()
        .fill('0x4609B825bb42F5BC839339c30F8960569CC82717');
      await clickSafe(
        page.locator('[data-testid="model-upsert-submit"]').first(),
        '⑤b 提交上架',
      );
      let upsertNotice = '';
      try {
        await page.waitForSelector('[data-testid="model-upsert-result"]', { timeout: T.api });
        upsertNotice = (await page.locator('[data-testid="model-upsert-result"]').first().innerText()).trim();
      } catch (e) {
        const errSel = page.locator('[data-testid="model-upsert-error"]');
        if ((await errSel.count()) > 0) {
          bad('⑤ 上架模型', `前端报错：${(await errSel.first().innerText()).trim()}`);
        } else {
          bad('⑤ 上架模型', `未出现结果提示: ${e.message}`);
        }
      }
      check(
        /已上架|已更新/.test(upsertNotice) && upsertNotice.includes(MODEL_ID),
        '⑤ 网页上架成功并回显',
        upsertNotice
      );
      const upsertResp = apiLog.find((r) => r.url.includes('/api/v1/owner/models/upsert'));
      check(
        !!upsertResp && upsertResp.status === 200,
        '⑤ POST /api/v1/owner/models/upsert 返回 200',
        upsertResp ? `HTTP ${upsertResp.status}` : '未捕获到请求'
      );
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase9-02-model-upsert.png'), fullPage: false });

      // ---- ⑤b Playground 模型列表当场出现新模型 ----
      const toBuyer = byText(page, '切换至买家视角');
      if ((await toBuyer.count()) > 0) {
        await clickSafe(toBuyer, '⑤c 切到买家视角');
        await sleep(2500);
      }
      const selector = page.locator('#apx-model-selector-value').first();
      if ((await selector.count()) > 0) {
        await clickSafe(selector, '⑤d 打开模型选择器');
        await sleep(1200);
      }
      const modelItem = page.locator(`[data-testid="playground-model-item-${MODEL_ID}"]`).first();
      check(
        (await modelItem.count()) > 0,
        '⑤ Playground 模型列表出现新上架模型',
        MODEL_ID
      );
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase9-03-playground-model.png'), fullPage: false });
      // 关掉选择器
      await page.keyboard.press('Escape');
      await sleep(500);
    }

    // ---- ⑥ 签发充值卡密（OWNER）----
    const toOwner = byText(page, '切换至业主视角');
    if ((await toOwner.count()) > 0) {
      await clickSafe(toOwner, '⑥a 切回业主视角');
      await sleep(2000);
    }
    const govTab2 = byText(page, '节点治理');
    if ((await govTab2.count()) > 0) {
      await clickSafe(govTab2, '⑥b 进入节点治理分段');
      await sleep(2000);
    }
    check(
      (await page.locator('[data-testid="voucher-issue-card"]').count()) > 0,
      '⑥ 签发充值卡密工具已渲染',
      ''
    );
    await page.locator('[data-testid="voucher-issue-amount"]').first().fill('1');
    await page.locator('[data-testid="voucher-issue-count"]').first().fill('1');
    await clickSafe(page.locator('[data-testid="voucher-issue-btn"]').first(), '⑥c 签发卡密');
    try {
      await page.waitForSelector('[data-testid="voucher-issue-plaintext"]', { timeout: T.api });
      const plain = (await page.locator('[data-testid="voucher-issue-plaintext"]').first().innerText()).trim();
      voucherCode = (plain.split(/\s+/).find((w) => w.startsWith('paw-topup-')) || '').trim();
      check(!!voucherCode, '⑥ 签发出明文充值码（只此一次可见）', voucherCode.slice(0, 18) + '…');
    } catch (e) {
      bad('⑥ 签发充值卡密', `未拿到明文: ${e.message}`);
    }
    const issueResp = apiLog.find((r) => r.url.includes('/api/v1/owner/vouchers/issue'));
    check(
      !!issueResp && issueResp.status === 200,
      '⑥ POST /api/v1/owner/vouchers/issue 返回 200',
      issueResp ? `HTTP ${issueResp.status}` : '未捕获到请求'
    );
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase9-04-voucher-issue.png'), fullPage: false });

    // ---- ⑦ 买家核销充值码 ----
    if (voucherCode) {
      const toBuyer2 = byText(page, '切换至买家视角');
      if ((await toBuyer2.count()) > 0) {
        await clickSafe(toBuyer2, '⑦a 切到买家视角');
        await sleep(2500);
      }
      check(
        (await page.locator('[data-testid="voucher-redeem-box"]').count()) > 0,
        '⑦ 余额区出现「兑换充值码」输入框',
        ''
      );
      await page.locator('[data-testid="voucher-redeem-input"]').first().fill(voucherCode);
      await clickSafe(page.locator('[data-testid="voucher-redeem-btn"]').first(), '⑦b 点兑换');
      let redeemOk = '';
      try {
        await page.waitForSelector('[data-testid="voucher-redeem-ok"]', { timeout: T.api });
        redeemOk = (await page.locator('[data-testid="voucher-redeem-ok"]').first().innerText()).trim();
      } catch (e) {
        const errSel = page.locator('[data-testid="voucher-redeem-error"]');
        if ((await errSel.count()) > 0) {
          bad('⑦ 核销充值码', `前端报错：${(await errSel.first().innerText()).trim()}`);
        } else {
          bad('⑦ 核销充值码', `未出现到账提示: ${e.message}`);
        }
      }
      check(/到账/.test(redeemOk), '⑦ 核销成功并提示到账', redeemOk);
      const redeemResp = apiLog.find((r) => r.url.includes('/api/v1/user/redeem'));
      check(
        !!redeemResp && redeemResp.status === 200,
        '⑦ POST /api/v1/user/redeem 返回 200',
        redeemResp ? `HTTP ${redeemResp.status}` : '未捕获到请求'
      );
      await sleep(1500);
      const balanceText = await page
        .locator('[id="apx-grad-text-balance"]')
        .first()
        .innerText()
        .catch(() => '');
      check(balanceText.includes('1.00'), '⑦ 余额卡显示 $1.00', `balance=${balanceText.trim()}`);
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase9-05-redeem.png'), fullPage: false });
    }

    console.log(`  [issued-key] ${issuedKey}`);
    console.log(`  [voucher-code] ${voucherCode}`);
    console.log(`  [model-id] ${MODEL_ID}`);
    console.log(`  [owner-handle] ${ownerHandle}`);
  } catch (e) {
    bad('阶段九线上验收', e.message);
    try {
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase9-error.png'), fullPage: true });
    } catch (_) {}
  } finally {
    await context.close();
    await browser.close();
  }

  const passed = results.filter((r) => r.pass).length;
  console.log('');
  console.log(`===== 阶段九 P0~P3 线上验收：${passed}/${results.length} 通过 =====`);
  fs.writeFileSync(
    REPORT,
    JSON.stringify({ results, passed, total: results.length, issuedKey, voucherCode, modelId: MODEL_ID }, null, 2),
  );
  process.exit(passed === results.length ? 0 : 1);
})();
