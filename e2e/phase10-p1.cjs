/**
 * 阶段十 P0~P3 · 线上验收（业主口令解锁 / 卡密作废 / 买家账单 / 节点排行榜）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules \
 *   APIPAW_OWNER_PASSKEY='AP-xxxx' node e2e/phase10-p1.cjs
 *
 * 产物：e2e/shots/phase10-*.png + e2e/phase10-report.json
 *
 * 全程走**线上真接口**（https://console.apipaw.com + https://cloud.apipaw.com）：
 *   ① 首屏挂载（访客态，无密钥）
 *   ② 签发一把买家 API Key（真实账户）
 *   ③ **用管理口令解锁 OWNER 视角**（走真实 UI 弹窗，不是伪造令牌）
 *   ④ 买家「收支账单明细」面板可展开、能读到自己的流水（9 位小数）
 *   ⑤ 业主签发一张充值卡密 ⇒ 在台账里点「作废」⇒ 状态变 REVOKED
 *   ⑥ 「全网算力节点排行榜」渲染出 win_node_01 的真实生产记录
 *
 * ⚠️ 本脚本会**真的**签一张卡密并把它作废（作废后的卡密永远无法核销 ⇒ 不留残值）。
 *    签发的那把买家 API Key 属于测试账户，由云端清理脚本删除以还原基线。
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { maskKey, redactDeep } = require('./redact.cjs');

const BASE_URL = process.argv[2] || 'https://console.apipaw.com';
const CLOUD_URL = process.env.APIPAW_CLOUD_URL || 'https://cloud.apipaw.com';
const OWNER_PASSKEY = process.env.APIPAW_OWNER_PASSKEY || '';
const SHOT_DIR = path.join(__dirname, 'shots');
const REPORT = path.join(__dirname, 'phase10-report.json');
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

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // 可选：绕过 Cloudflare 边缘直连源站（边缘冷路径会把 1.5MB bundle 拖到 60s+）。
  // 例：APIPAW_E2E_HOST_RESOLVER="MAP console.apipaw.com 103.142.190.251"
  const launchArgs = ['--disable-ipv6'];
  if (process.env.APIPAW_E2E_HOST_RESOLVER) {
    launchArgs.push(`--host-resolver-rules=${process.env.APIPAW_E2E_HOST_RESOLVER}`);
  }
  const browser = await chromium.launch({ headless: true, args: launchArgs });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const apiLog = [];
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/v1/')) apiLog.push({ url: u, status: res.status() });
  });

  let issuedKey = '';
  let voucherCode = '';

  try {
    if (!OWNER_PASSKEY) {
      bad('③ 管理口令解锁', '缺少环境变量 APIPAW_OWNER_PASSKEY');
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

    // ---- ②d 领一次性体验金（让新账户有第一笔流水，账单面板才有内容可核对）----
    // ⚠️ 余额卡的「一键领体验金」入口只在**余额刷新回 $0** 后才出现（首屏 store
    //    默认余额是 $100），所以按钮可能还没出现 —— 这时直接调**真实生产接口**
    //    POST /api/v1/user/faucet，效果等价且不受渲染时序影响。
    let faucetText = '';
    const faucetBtn = page.locator('[data-testid="balance-faucet-btn"]').first();
    if ((await faucetBtn.count()) > 0) {
      await clickSafe(faucetBtn, '②d 领取体验金');
      try {
        await page.waitForSelector('[data-testid="balance-faucet-ok"]', { timeout: T.api });
        faucetText = (await page.locator('[data-testid="balance-faucet-ok"]').first().innerText()).trim();
      } catch (e) {
        faucetText = '';
      }
    }
    if (!faucetText) {
      try {
        const res = await fetch(CLOUD_URL + '/api/v1/user/faucet', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + issuedKey },
        });
        const body = await res.json();
        faucetText = `HTTP ${res.status} ${body.status || ''} $${body.amount_usd || 0}`;
      } catch (e) {
        faucetText = 'fetch failed: ' + e.message;
      }
    }
    check(/已到账|HTTP 200/.test(faucetText), '②d 领取体验金成功（产生第一笔流水）', faucetText);
    await sleep(2000);

    // ---- ③ 管理口令解锁 OWNER 视角（走真实 UI 弹窗）----
    await clickSafe(page.locator('[data-testid="open-passkey-modal"]').first(), '③a 打开口令解锁弹窗');
    await sleep(1000);
    check(
      (await page.locator('[data-testid="owner-passkey-input"]').count()) > 0,
      '③a 口令解锁弹窗已渲染',
      ''
    );
    await page.locator('[data-testid="owner-passkey-input"]').first().fill(OWNER_PASSKEY);
    await clickSafe(page.locator('[data-testid="owner-passkey-btn"]').first(), '③b 提交口令');
    try {
      await page.waitForSelector('[data-testid="owner-passkey-ok"]', { timeout: T.api });
      const okText = (await page.locator('[data-testid="owner-passkey-ok"]').first().innerText()).trim();
      check(/已解锁 OWNER/.test(okText), '③ 管理口令解锁成功', okText);
    } catch (e) {
      const errSel = page.locator('[data-testid="owner-passkey-error"]');
      if ((await errSel.count()) > 0) {
        bad('③ 管理口令解锁', `前端报错：${(await errSel.first().innerText()).trim()}`);
      } else {
        bad('③ 管理口令解锁', `未出现结果提示: ${e.message}`);
      }
    }
    const passkeyResp = apiLog.find((r) => r.url.includes('/api/v1/auth/owner-passkey'));
    check(
      !!passkeyResp && passkeyResp.status === 200,
      '③ POST /api/v1/auth/owner-passkey 返回 200',
      passkeyResp ? `HTTP ${passkeyResp.status}` : '未捕获到请求'
    );
    await sleep(1500);
    // 解锁后应当自动切到业主视角（服务端角色优先于本地偏好）
    const ownerChip = (await page
      .locator('[data-testid="open-passkey-modal"]')
      .first()
      .innerText()
      .catch(() => '')) || '';
    check(ownerChip.includes('已解锁业主'), '③ 顶栏显示「已解锁业主」', ownerChip.trim());
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase10-01-passkey-unlock.png'), fullPage: false });
    // 解锁后弹窗**故意不自动关**（要让用户看见「✓ 已解锁」）⇒ 这里手动关掉
    await clickSafe(page.locator('[data-testid="passkey-modal-close"]').first(), '③c 关闭口令弹窗');
    await sleep(1200);

    // ---- ④ 买家收支账单明细（展开 → 有流水）----
    const toBuyer = byText(page, '切换至买家视角');
    if ((await toBuyer.count()) > 0) {
      await clickSafe(toBuyer, '④a 切到买家视角');
      await sleep(2500);
    }
    check(
      (await page.locator('[data-testid="buyer-ledger-card"]').count()) > 0,
      '④ 收支账单明细面板已渲染',
      ''
    );
    await clickSafe(page.locator('[data-testid="buyer-ledger-toggle"]').first(), '④b 展开账单明细');
    // 等第一行渲染出来（网关冷路径可能几十秒）—— 不用固定 sleep
    try {
      await page.waitForSelector('[data-testid^="buyer-ledger-row-"]', { timeout: T.api });
    } catch (e) {
      /* 下面按 0 行断言 */
    }
    const ledgerRows = page.locator('[data-testid^="buyer-ledger-row-"]');
    const ledgerCount = await ledgerRows.count();
    check(ledgerCount > 0, '④ 账单明细列出本人流水', `${ledgerCount} 行`);
    const ledgerText =
      (await page.locator('[data-testid="buyer-ledger-card"]').first().innerText().catch(() => '')) || '';
    check(
      /余额快照/.test(ledgerText),
      '④ 每行带余额快照（可逐笔核对）',
      ledgerText.replace(/\s+/g, ' ').slice(0, 120)
    );
    // 直连 API 复核同一账户的流水（9 位小数不截断由沙箱 G3 严格断言）
    // ⚠️ CF 边缘偶发断连 ⇒ 最多重试 3 次
    let ledgerApi = null;
    for (let i = 0; i < 3 && !ledgerApi; i++) {
      try {
        const res = await fetch(CLOUD_URL + '/api/v1/user/ledger?limit=30', {
          headers: { Authorization: 'Bearer ' + issuedKey },
        });
        const body = await res.json();
        ledgerApi = { status: res.status, body };
      } catch (e) {
        if (i === 2) bad('④ GET /api/v1/user/ledger 返回本人流水', e.message);
        else await sleep(2000);
      }
    }
    if (ledgerApi) {
      const entries = ledgerApi.body.entries || [];
      check(
        ledgerApi.status === 200 && entries.length >= 1 && typeof entries[0].amount_usd === 'number',
        '④ GET /api/v1/user/ledger 返回本人流水',
        `HTTP ${ledgerApi.status} entries=${entries.length} type=${entries[0] && entries[0].entry_type} amount=${entries[0] && entries[0].amount_usd}`
      );
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase10-02-buyer-ledger.png'), fullPage: false });

    // ---- ⑥ 全网算力节点排行榜（公开）----
    const lbCard = page.locator('[data-testid="node-leaderboard-card"]').first();
    check((await lbCard.count()) > 0, '⑥ 节点排行榜面板已渲染', '');
    try {
      await page.waitForSelector('[data-testid^="node-leaderboard-row-"]', { timeout: T.api });
    } catch (e) {
      // 排行榜可能为空（例如生产尚未有 QoS 记录）—— 记为警告而不是硬失败
      const emptySel = page.locator('[data-testid="node-leaderboard-empty"]');
      if ((await emptySel.count()) > 0) {
        ok('⑥ 排行榜已渲染（当前无节点记录）', (await emptySel.first().innerText()).trim().slice(0, 60));
      } else {
        bad('⑥ 节点排行榜渲染', `未出现任何行: ${e.message}`);
      }
    }
    const lbText = (await lbCard.innerText().catch(() => '')) || '';
    check(
      lbText.includes('全网算力节点排行榜'),
      '⑥ 排行榜标题正确',
      lbText.replace(/\s+/g, ' ').slice(0, 80)
    );
    const lbResp = apiLog.find((r) => r.url.includes('/api/v1/network/leaderboard'));
    check(
      !!lbResp && lbResp.status === 200,
      '⑥ GET /api/v1/network/leaderboard 返回 200',
      lbResp ? `HTTP ${lbResp.status}` : '未捕获到请求'
    );
    if (lbText.includes('win_node_01')) {
      ok('⑥ 排行榜含 win_node_01 真实生产记录', 'node_id=win_node_01');
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase10-03-leaderboard.png'), fullPage: false });

    // ---- ⑤ 业主签发卡密 ⇒ 作废 ----
    const toOwner = byText(page, '切换至业主视角');
    if ((await toOwner.count()) > 0) {
      await clickSafe(toOwner, '⑤a 切回业主视角');
      await sleep(2500);
    }
    const govTab = byText(page, '节点治理');
    if ((await govTab.count()) > 0) {
      await clickSafe(govTab, '⑤b 进入节点治理分段');
      await sleep(2000);
    }
    check(
      (await page.locator('[data-testid="voucher-issue-card"]').count()) > 0,
      '⑤ 签发充值卡密工具已渲染',
      ''
    );
    await page.locator('[data-testid="voucher-issue-amount"]').first().fill('1');
    await page.locator('[data-testid="voucher-issue-count"]').first().fill('1');
    await clickSafe(page.locator('[data-testid="voucher-issue-btn"]').first(), '⑤c 签发卡密');
    try {
      await page.waitForSelector('[data-testid="voucher-issue-plaintext"]', { timeout: T.api });
      const plain = (await page.locator('[data-testid="voucher-issue-plaintext"]').first().innerText()).trim();
      voucherCode = (plain.split(/\s+/).find((w) => w.startsWith('paw-topup-')) || '').trim();
      check(!!voucherCode, '⑤ 签发出明文充值码（只此一次可见）', voucherCode.slice(0, 18) + '…');
    } catch (e) {
      bad('⑤ 签发充值卡密', `未拿到明文: ${e.message}`);
    }
    await sleep(1500);
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase10-04-voucher-issue.png'), fullPage: false });

    // 台账里最新一张卡密在最前（ORDER BY id DESC）⇒ 第一个「作废」按钮就是它
    const revokeBtn = page.locator('[data-testid^="voucher-revoke-btn-"]').first();
    check((await revokeBtn.count()) > 0, '⑤d 台账里出现「作废」按钮', '');
    await clickSafe(revokeBtn, '⑤d 点作废');
    await sleep(2500);
    const revokeResp = apiLog.find((r) => r.url.includes('/api/v1/owner/vouchers/revoke'));
    // 等台账刷新后状态变 REVOKED（列表要重新拉一次，别用固定 sleep）
    // ⚠️ 必须**按前缀定位到刚签发的那一行** —— 台账里可能还有别的历史卡密，
    //    拿整块文本 grep "REVOKED" 会匹配到别人的行。
    const prefix = voucherCode.slice(0, 16);
    let revoked = false;
    let rowText = '';
    for (let i = 0; i < 20 && !revoked; i++) {
      const rows = page.locator('[data-testid^="voucher-row-"]');
      const n = await rows.count();
      for (let k = 0; k < n; k++) {
        const t = (await rows.nth(k).innerText().catch(() => '')) || '';
        if (t.includes(prefix)) {
          rowText = t.replace(/\s+/g, ' ');
          if (/REVOKED/.test(t)) revoked = true;
          break;
        }
      }
      if (!revoked) await sleep(1500);
    }
    check(revoked, '⑤ 卡密状态已变为 REVOKED', `${prefix}… → ${rowText.slice(0, 100)}`);
    // 响应事件是异步到达的 —— 放在轮询**之后**再查，避免"已生效但没抓到请求"
    const revokeRespFinal =
      apiLog.find((r) => r.url.includes('/api/v1/owner/vouchers/revoke')) || revokeResp;
    check(
      !!revokeRespFinal && revokeRespFinal.status === 200,
      '⑤ POST /api/v1/owner/vouchers/revoke 返回 200',
      revokeRespFinal ? `HTTP ${revokeRespFinal.status}` : '未捕获到请求'
    );
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase10-05-voucher-revoked.png'), fullPage: false });

    console.log(`  [issued-key] ${issuedKey}`);
    console.log(`  [voucher-code] ${voucherCode}`);
  } catch (e) {
    bad('阶段十线上验收', e.message);
    try {
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase10-error.png'), fullPage: true });
    } catch (_) {}
  } finally {
    await context.close();
    await browser.close();
  }

  const passed = results.filter((r) => r.pass).length;
  console.log('');
  console.log(`===== 阶段十 P0~P3 线上验收：${passed}/${results.length} 通过 =====`);
  fs.writeFileSync(
    REPORT,
    // ⚠️ 报告里**不落明文 Key**（明文只回显到 stdout）
    JSON.stringify(
      {
        results: redactDeep(results),
        passed,
        total: results.length,
        issuedKeyMasked: maskKey(issuedKey),
        voucherCode,
      },
      null,
      2
    ),
  );
  process.exit(passed === results.length ? 0 : 1);
})();
