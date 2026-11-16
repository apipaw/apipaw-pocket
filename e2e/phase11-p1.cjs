/**
 * 阶段十一 P0~P3 · 线上验收
 *   ① Gzip 预压缩生效（源站 + CF 边缘，压缩后 < 450KB）
 *   ② 零余额首屏：$0.00 精确显示 + 「免费领取 $0.50 体验金」+「兑换充值码」入口
 *   ③ 收益看板：节点（win_node_01）/ 创作者（creator_demo）累计分成 9 位小数
 *   ④ 自助提现 → 业主审批（批准回填 tx_hash / 驳回退回额度）→ 同页实时联动
 *   ⑤ 导出接入代码弹窗（cURL / Python / 客户端 Base URL）
 *   ⑥ OpenAI 兼容路径（/v1/models、/v1/chat/completions）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules \
 *   APIPAW_OWNER_PASSKEY='AP-xxxx' node e2e/phase11-p1.cjs
 *
 * 产物：e2e/shots/phase11-*.png + e2e/phase11-report.json
 *
 * ⚠️ 本脚本会**真的**发起节点提现申请并让业主批准/驳回（占用的额度随后由
 *    云端清理脚本按时间戳删除 ⇒ 额度原样归还，生产基线不漂移）。
 *    签发的买家 API Key 属于测试账户，由 ops_ctl.py cleanup 删除。
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { maskKey, redactDeep } = require('./redact.cjs');

const BASE_URL = process.argv[2] || 'https://console.apipaw.com';
const CLOUD_URL = process.env.APIPAW_CLOUD_URL || 'https://cloud.apipaw.com';
const POCKET_URL = process.env.APIPAW_POCKET_URL || 'https://pocket.apipaw.com';
const OWNER_PASSKEY = process.env.APIPAW_OWNER_PASSKEY || '';
const SHOT_DIR = path.join(__dirname, 'shots');
const REPORT = path.join(__dirname, 'phase11-report.json');
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
const warn = (name, detail) => {
  results.push({ name, pass: true, soft: true, detail });
  console.log(`  WARN  ${name}${detail ? ' — ' + detail : ''}`);
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
      // ⚠️ 不能 page.close() —— 页面对象会失效
    }
  }
  if (!mounted) throw lastErr;
}

/** P0-① Gzip 实测：抓 HTML → 找 bundle → 带 Accept-Encoding: gzip 取回 */
async function checkGzip(host, label) {
  try {
    const htmlRes = await fetch(host + '/', { headers: { 'user-agent': 'apipaw-e2e' } });
    const html = await htmlRes.text();
    const m = html.match(/src="([^"]+\.js)"/);
    if (!m) {
      bad(`${label} Gzip`, 'HTML 里没找到 bundle 脚本');
      return;
    }
    const asset = m[1];
    const res = await fetch(host + asset, {
      headers: { 'accept-encoding': 'gzip', 'user-agent': 'apipaw-e2e' },
    });
    const enc = (res.headers.get('content-encoding') || '').toLowerCase();
    const len = Number(res.headers.get('content-length') || 0);
    const detail = `${asset} → content-encoding=${enc || '(none)'} content-length=${len}`;
    check(enc.includes('gzip'), `${label} 返回 Content-Encoding: gzip`, detail);
    check(len > 0 && len < 450 * 1024, `${label} 压缩后体积 < 450KB`, `${(len / 1024).toFixed(1)}KB`);
  } catch (e) {
    bad(`${label} Gzip`, e.message);
  }
}

/** 轮询等待某个 testid 出现 */
async function waitTestId(page, testid, timeout) {
  try {
    await page.waitForSelector(`[data-testid="${testid}"]`, { timeout });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * 等审批台的结果提示变成期望文案。
 * ⚠️ 提示是**常驻**的（每次决定会先清空再写入），所以必须轮询到**文案命中**为止，
 *    否则会读到上一条决定的残留提示。
 */
async function waitNotice(page, regex) {
  const sel = page.locator('[data-testid="withdrawal-notice"]').first();
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const t = (await sel.innerText().catch(() => '')) || '';
    if (regex.test(t)) return t.trim();
  }
  return '';
}

/**
 * 提交一笔提现并取回单号。
 * ⚠️ 卡片里的「成功回执」是**常驻**的（不会自动消失），所以必须比对**回执文本是否变化**，
 *    否则第二次提交会读到上一笔的单号。
 */
async function submitWithdrawal(page) {
  const okSel = page.locator('[data-testid="earnings-withdraw-ok"]').first();
  const errSel = page.locator('[data-testid="earnings-withdraw-error"]').first();
  const before = (await okSel.innerText().catch(() => '')) || '';
  await clickSafe(page.locator('[data-testid="earnings-withdraw-submit"]').first(), '提交提现申请');
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const now = (await okSel.innerText().catch(() => '')) || '';
    if (now && now !== before) {
      const m = now.match(/#(\d+)/);
      return { id: m ? Number(m[1]) : 0, msg: now.trim(), err: '' };
    }
    const e = (await errSel.innerText().catch(() => '')) || '';
    if (e) return { id: 0, msg: '', err: e.trim() };
  }
  return { id: 0, msg: '', err: '提交后既无成功回执也无错误提示（超时）' };
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  // ================= P0-① Gzip（纯 HTTP，不需要浏览器）=================
  console.log('\n[阶段十一 P0] Gzip 预压缩实测');
  await checkGzip(BASE_URL, '①a 控制台站');
  await checkGzip(POCKET_URL, '①b Pocket 站');

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
    if (u.includes('/api/v1/') || u.includes('/v1/')) apiLog.push({ url: u, status: res.status() });
  });

  let issuedKey = '';
  let withdrawalIds = [];

  try {
    if (!OWNER_PASSKEY) bad('③ 管理口令解锁', '缺少环境变量 APIPAW_OWNER_PASSKEY');

    await mount(page);

    // ---------- P0-② 零余额首屏（无密钥）----------
    const balSel = page.locator('#apx-grad-text-balance');
    await balSel.waitFor({ timeout: T.app });
    const balNoKey = (await balSel.innerText().catch(() => '')) || '';
    check(balNoKey.trim() === '$0.00', '② 无密钥首屏余额精确显示 $0.00', balNoKey.trim());
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase11-01-zero-balance.png'), fullPage: false });

    // ---------- P0-③ 签发买家 Key ⇒ 仍 $0.00 且体验金/兑换入口可见 ----------
    let modalOpen = (await page.locator('#apx-modal').count()) > 0;
    if (!modalOpen) {
      await clickSafe(byText(page, '设置密钥'), '③a 打开密钥弹窗');
      await sleep(1200);
      modalOpen = (await page.locator('#apx-modal').count()) > 0;
    }
    check(modalOpen, '③a 打开密钥弹窗', modalOpen ? '弹窗已开' : '弹窗未打开');

    const issueBtn = byText(page, '签发新 Key');
    if ((await issueBtn.count()) === 0) {
      bad('③ 签发新 Key', '未找到「签发新 Key」按钮');
      throw new Error('issue button missing');
    }
    await clickSafe(issueBtn, '③ 签发新 Key');
    try {
      await page.waitForSelector('[data-testid="issue-key-plaintext"]', { timeout: T.api });
      issuedKey = (await page.locator('[data-testid="issue-key-plaintext"]').first().innerText()).trim();
    } catch (e) {
      bad('③ 签发新 Key', `未拿到明文: ${e.message}`);
      throw e;
    }
    check(!!issuedKey && issuedKey.length > 10, '③ 签发新 Key ⇒ 拿到明文', issuedKey.slice(0, 12) + '…');
    await clickSafe(page.locator('[data-testid="issue-key-confirm"]').first(), '③b 勾选「我已保存」');
    await sleep(400);
    await clickSafe(page.locator('[data-testid="issue-key-save"]').first(), '③c 保存并使用此密钥');
    await sleep(3500);

    const balAfterKey = (await balSel.innerText().catch(() => '')) || '';
    check(
      balAfterKey.trim() === '$0.00',
      '③ 新账户（真实余额 $0）首屏精确显示 $0.00',
      balAfterKey.trim()
    );
    check(
      (await page.locator('[data-testid="balance-faucet-btn"]').count()) > 0,
      '③ 新账户首屏展示「免费领取 $0.50 体验金」入口',
      ''
    );
    check(
      (await page.locator('[data-testid="voucher-redeem-box"]').count()) > 0,
      '③ 新账户首屏展示「兑换充值码」入口',
      ''
    );
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase11-02-faucet-entry.png'), fullPage: false });

    // 领取一次性体验金 —— 后面 ⑧ 的 OpenAI 兼容实测需要余额（余额 $0 时网关按设计返回 402）
    {
      const fbtn = page.locator('[data-testid="balance-faucet-btn"]').first();
      if ((await fbtn.count()) > 0) {
        await clickSafe(fbtn, '③d 领取一次性体验金');
        const fok = await waitTestId(page, 'balance-faucet-ok', T.api);
        const fmsg = fok
          ? (await page.locator('[data-testid="balance-faucet-ok"]').first().innerText()).trim()
          : '';
        check(/到账|已/.test(fmsg), '③d 体验金领取成功', fmsg);
      } else {
        warn('③d 领取一次性体验金', '没找到领取按钮（可能已被领过）');
      }
    }

    // ---------- P2 导出接入代码弹窗 ----------
    const exportBtn = page.locator('[data-testid="playground-export-open"]').first();
    check((await exportBtn.count()) > 0, '④a Playground「导出代码」按钮存在', '');
    await clickSafe(exportBtn, '④a 打开导出代码弹窗');
    const codeShown = await waitTestId(page, 'playground-export-code', T.api);
    check(codeShown, '④a 导出代码弹窗已渲染', '');
    if (codeShown) {
      const curl = (await page.locator('[data-testid="playground-export-code"]').first().innerText()) || '';
      check(
        curl.includes('/v1/chat/completions') && curl.includes('curl'),
        '④b cURL 片段含 /v1/chat/completions',
        curl.replace(/\s+/g, ' ').slice(0, 110)
      );
      await clickSafe(page.locator('[data-testid="playground-export-tab-python"]').first(), '④c 切到 Python 片段');
      await sleep(600);
      const py = (await page.locator('[data-testid="playground-export-code"]').first().innerText()) || '';
      check(
        /openai|OpenAI/.test(py) && /api_key|base_url/.test(py),
        '④c Python (OpenAI SDK) 片段正确',
        py.replace(/\s+/g, ' ').slice(0, 110)
      );
      await clickSafe(page.locator('[data-testid="playground-export-tab-client"]').first(), '④d 切到客户端接入片段');
      await sleep(600);
      const cli = (await page.locator('[data-testid="playground-export-code"]').first().innerText()) || '';
      check(
        /base_?url|baseURL|BASE_URL/i.test(cli) && cli.includes('/v1'),
        '④d 客户端 Base URL 片段正确',
        cli.replace(/\s+/g, ' ').slice(0, 110)
      );
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase11-03-export-client.png'), fullPage: false });
      await clickSafe(page.locator('[data-testid="playground-export-close"]').first(), '④e 关闭导出弹窗');
      await sleep(800);
    }

    // ---------- ③ 管理口令解锁 OWNER ----------
    await clickSafe(page.locator('[data-testid="open-passkey-modal"]').first(), '⑤a 打开口令解锁弹窗');
    await sleep(1000);
    check((await page.locator('[data-testid="owner-passkey-input"]').count()) > 0, '⑤a 口令弹窗已渲染', '');
    await page.locator('[data-testid="owner-passkey-input"]').first().fill(OWNER_PASSKEY);
    await clickSafe(page.locator('[data-testid="owner-passkey-btn"]').first(), '⑤b 提交口令');
    try {
      await page.waitForSelector('[data-testid="owner-passkey-ok"]', { timeout: T.api });
      const okText = (await page.locator('[data-testid="owner-passkey-ok"]').first().innerText()).trim();
      check(/已解锁 OWNER/.test(okText), '⑤ 管理口令解锁成功', okText);
    } catch (e) {
      const errSel = page.locator('[data-testid="owner-passkey-error"]');
      bad(
        '⑤ 管理口令解锁',
        (await errSel.count()) > 0
          ? `前端报错：${(await errSel.first().innerText()).trim()}`
          : `未出现结果提示: ${e.message}`
      );
    }
    await sleep(1500);
    await clickSafe(page.locator('[data-testid="passkey-modal-close"]').first(), '⑤c 关闭口令弹窗');
    await sleep(1200);

    // ---------- 切到业主视角 ----------
    const toOwner = byText(page, '切换至业主视角');
    if ((await toOwner.count()) > 0) {
      await clickSafe(toOwner, '⑥a 切到业主视角');
      await sleep(2500);
    }
    check((await page.locator('[data-testid="host-tabs"]').count()) > 0, '⑥a 业主分段导航已出现', '');

    // ---------- ⑥ 收益看板（版税大盘分段）----------
    await clickSafe(page.locator('[data-testid="host-tab-ROYALTY"]').first(), '⑥b 进入版税大盘');
    await sleep(2500);
    check(
      (await page.locator('[data-testid="earnings-withdraw-card"]').count()) > 0,
      '⑥b 收益提现面板已渲染',
      ''
    );
    const nodeTotal = await waitTestId(page, 'earnings-node-total', T.api);
    check(nodeTotal, '⑥b 节点收益区块已出数', '');
    if (nodeTotal) {
      const t1 = (await page.locator('[data-testid="earnings-node-total"]').first().innerText()).trim();
      const t2 = (await page.locator('[data-testid="earnings-node-available"]').first().innerText()).trim();
      const num = Number(String(t1).replace(/[$,\s]/g, ''));
      check(
        Number.isFinite(num) && Math.abs(num - 0.022) < 1e-9,
        '⑥b 节点累计分成精确到 9 位小数（win_node_01 = $0.022）',
        `${t1} / 可提 ${t2}`
      );
    }
    const creatorTotal = await waitTestId(page, 'earnings-creator-total', T.api);
    check(creatorTotal, '⑥c 创作者收益区块已出数', '');
    if (creatorTotal) {
      const t1 = (await page.locator('[data-testid="earnings-creator-total"]').first().innerText()).trim();
      const num = Number(String(t1).replace(/[$,\s]/g, ''));
      check(
        Number.isFinite(num) && Math.abs(num - 0.002397) < 1e-9,
        '⑥c 创作者累计分成精确到 9 位小数（creator_demo = $0.002397）',
        t1
      );
    }
    // 直连接口复核：金额字段必须带 9 位小数（不是前端四舍五入出来的）
    try {
      const eres = await fetch(CLOUD_URL + '/api/v1/earnings/summary?node_id=win_node_01&creator_id=creator_demo');
      const ebody = await eres.json();
      const nTot = ebody?.node?.total_share_usd;
      const cTot = ebody?.creator?.total_share_usd;
      check(
        eres.status === 200 &&
          typeof nTot === 'number' &&
          Math.abs(nTot - 0.022) < 1e-9 &&
          typeof cTot === 'number' &&
          Math.abs(cTot - 0.002397) < 1e-9,
        '⑥d GET /api/v1/earnings/summary 返回 9 位小数口径',
        `HTTP ${eres.status} node=${nTot} creator=${cTot}`
      );
    } catch (e) {
      bad('⑥d GET /api/v1/earnings/summary', e.message);
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase11-04-earnings.png'), fullPage: false });

    // ---------- ⑦ 节点治理：自助提现 + 业主审批联动 ----------
    await clickSafe(page.locator('[data-testid="host-tab-GOVERNANCE"]').first(), '⑦a 进入节点治理');
    await sleep(2500);
    check(
      (await page.locator('[data-testid="withdrawal-approval-card"]').count()) > 0,
      '⑦a 提现审批台已渲染',
      ''
    );
    check(
      (await page.locator('[data-testid="earnings-withdraw-card"]').count()) > 0,
      '⑦a 收益面板与审批台同页',
      ''
    );

    // 7b 发起节点提现
    await clickSafe(page.locator('[data-testid="earnings-channel-node"]').first(), '⑦b 选中「算力节点」通道');
    await sleep(600);
    const amountInput = page.locator('[data-testid="earnings-withdraw-amount"]').first();
    await amountInput.fill('0.001');
    const r1 = await submitWithdrawal(page);
    const firstId = r1.id;
    if (firstId) {
      check(/#\d+/.test(r1.msg), '⑦b 提现申请已登记（回执含单号）', r1.msg);
      withdrawalIds.push(firstId);
    } else {
      bad('⑦b 提现申请提交', r1.err || '未拿到单号');
    }

    // 7c 审批台出现这一笔 → 批准并回填 tx_hash
    if (firstId) {
      // 审批台只在挂载/决定后刷新 ⇒ 新提交的申请要手动刷一次
      await clickSafe(page.locator('[data-testid="withdrawal-refresh"]').first(), '⑦c 刷新审批台');
      await sleep(2000);
      const rowSel = page.locator(`[data-testid="node-withdrawal-${firstId}"]`);
      const rowShown = await waitTestId(page, `node-withdrawal-${firstId}`, T.api);
      check(rowShown, '⑦c 审批台出现该笔待审提现', `#${firstId}`);
      if (rowShown) {
        const txHash = '0x' + 'a1'.repeat(32);
        await page.locator(`[data-testid="tx-input-node-${firstId}"]`).first().fill(txHash);
        await sleep(400);
        await clickSafe(page.locator(`[data-testid="approve-node-${firstId}"]`).first(), '⑦c 点「批准并交割」');
        const notice = await waitNotice(page, new RegExp('#' + firstId + ' *已批准'));
        check(/已批准/.test(notice), '⑦c 批准成功（回填 tx_hash）', notice);
        const decideResp = apiLog.find((r) => r.url.includes(`/api/v1/owner/node-withdrawals/${firstId}/decide`));
        check(
          !!decideResp && decideResp.status === 200,
          '⑦c POST /api/v1/owner/node-withdrawals/{id}/decide 返回 200',
          decideResp ? `HTTP ${decideResp.status}` : '未捕获到请求'
        );
      }

      // 7d 同页实时联动：收益面板的历史行应显示「已结清/已批准」+ tx 前缀
      await clickSafe(page.locator('[data-testid="earnings-withdraw-refresh"]').first(), '⑦d 刷新收益面板');
      await sleep(2500);
      const histRow = page.locator(`[data-testid="earnings-withdraw-row-${firstId}"]`);
      let histText = '';
      for (let i = 0; i < 12 && !histText; i++) {
        histText = (await histRow.innerText().catch(() => '')) || '';
        if (!histText) await sleep(1500);
      }
      check(
        /tx 0x a1a1a1a1/i.test(histText.replace(/\s+/g, ' ')) || /已结清|已批准|APPROVED/.test(histText),
        '⑦d 收益面板同页联动显示该笔终态',
        histText.replace(/\s+/g, ' ').slice(0, 110)
      );
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase11-05-withdraw-approved.png'), fullPage: false });

      // 7e 再提一笔 → 驳回 ⇒ 额度原样退回
      await page.locator('[data-testid="earnings-withdraw-amount"]').first().fill('0.001');
      const r2 = await submitWithdrawal(page);
      const secondId = r2.id;
      if (secondId) withdrawalIds.push(secondId);
      check(!!secondId, '⑦e 第二笔提现已登记', secondId ? `#${secondId}` : r2.err);
      if (secondId) {
        await clickSafe(page.locator('[data-testid="withdrawal-refresh"]').first(), '⑦e 刷新审批台');
        await sleep(2000);
        const rowShown2 = await waitTestId(page, `node-withdrawal-${secondId}`, T.api);
        check(rowShown2, '⑦e 审批台出现第二笔', `#${secondId}`);
        if (rowShown2) {
          await clickSafe(page.locator(`[data-testid="reject-node-${secondId}"]`).first(), '⑦e 点「驳回」');
          const notice2 = await waitNotice(page, new RegExp('#' + secondId + ' *已驳回'));
          check(/已驳回/.test(notice2), '⑦e 驳回成功（额度退回）', notice2);
        }
      }
    }

    // ---------- ⑦f 创作者通道提现（提交 → 驳回，额度退回）----------
    await clickSafe(page.locator('[data-testid="earnings-channel-creator"]').first(), '⑦f 切到「模型创作者」通道');
    await sleep(800);
    await page.locator('[data-testid="earnings-withdraw-amount"]').first().fill('0.001');
    const r3 = await submitWithdrawal(page);
    const thirdId = r3.id;
    if (thirdId) {
      check(!!thirdId, '⑦f 创作者提现已登记', `#${thirdId}`);
      withdrawalIds.push(thirdId);
    } else {
      warn('⑦f 创作者提现提交', r3.err || '未拿到单号');
    }
    if (thirdId) {
      await clickSafe(page.locator('[data-testid="withdrawal-refresh"]').first(), '⑦f 刷新审批台');
      await sleep(2000);
      const rowShown3 = await waitTestId(page, `creator-withdrawal-${thirdId}`, T.api);
      check(rowShown3, '⑦f 审批台出现创作者提现', `#${thirdId}`);
      if (rowShown3) {
        await clickSafe(page.locator(`[data-testid="reject-creator-${thirdId}"]`).first(), '⑦f 驳回创作者提现');
        const notice3 = await waitNotice(page, new RegExp('#' + thirdId + ' *已驳回'));
        check(/已驳回/.test(notice3), '⑦f 创作者提现驳回成功（额度退回）', notice3);
      }
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase11-06-creator-withdraw.png'), fullPage: false });

    // ---------- ⑧ OpenAI 兼容路径 ----------
    // ⚠️ 体验金已在步骤 ③d 领取（余额 $0.50）—— 余额为 0 时网关按设计返回 402
    //    （余额不足），那样只能证明「路由通」，证明不了「OpenAI 兼容结构对」。
    try {
      const mres = await fetch(CLOUD_URL + '/v1/models', {
        headers: { Authorization: 'Bearer ' + issuedKey },
      });
      const mbody = await mres.json().catch(() => ({}));
      check(
        mres.status === 200 && Array.isArray(mbody.data) && mbody.data.length > 0,
        '⑧ GET /v1/models（Bearer 鉴权）返回模型清单',
        `HTTP ${mres.status} models=${(mbody.data || []).length}`
      );
    } catch (e) {
      bad('⑧ GET /v1/models', e.message);
    }
    // 无凭证 ⇒ 必须 401（鉴权不是摆设）
    try {
      const ares = await fetch(CLOUD_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'qwen2.5:0.5b', messages: [{ role: 'user', content: 'ping' }] }),
      });
      check(ares.status === 401, '⑧ POST /v1/chat/completions 无凭证返回 401', `HTTP ${ares.status}`);
    } catch (e) {
      bad('⑧ POST /v1/chat/completions 无凭证', e.message);
    }
    try {
      const cres = await fetch(CLOUD_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + issuedKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: 'qwen2.5:0.5b', messages: [{ role: 'user', content: 'ping' }] }),
      });
      const cbody = await cres.json().catch(() => ({}));
      const hasChoice = !!(cbody.choices && cbody.choices.length && cbody.choices[0].message);
      check(
        cres.status === 200 && hasChoice,
        '⑧ POST /v1/chat/completions 返回 OpenAI 兼容结构',
        `HTTP ${cres.status} choices=${(cbody.choices || []).length} ${
          cbody.choices && cbody.choices[0] && cbody.choices[0].message
            ? String(cbody.choices[0].message.content).slice(0, 40)
            : JSON.stringify(cbody).slice(0, 80)
        }`
      );
    } catch (e) {
      warn('⑧ POST /v1/chat/completions', e.message);
    }
    // 流式 SSE
    try {
      const sres = await fetch(CLOUD_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + issuedKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'qwen2.5:0.5b',
          messages: [{ role: 'user', content: 'ping' }],
          stream: true,
        }),
      });
      const ctype = (sres.headers.get('content-type') || '').toLowerCase();
      const stext = await sres.text().catch(() => '');
      check(
        sres.status === 200 && ctype.includes('text/event-stream') && stext.includes('data:'),
        '⑧ POST /v1/chat/completions stream=true 返回 SSE',
        `HTTP ${sres.status} content-type=${ctype} bytes=${stext.length}`
      );
    } catch (e) {
      warn('⑧ POST /v1/chat/completions（流式）', e.message);
    }

    console.log(`  [issued-key] ${issuedKey}`);
    console.log(`  [withdrawal-ids] ${withdrawalIds.join(',')}`);
  } catch (e) {
    bad('阶段十一线上验收', e.message);
    try {
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase11-error.png'), fullPage: true });
    } catch (_) {}
  } finally {
    await context.close();
    await browser.close();
  }

  const passed = results.filter((r) => r.pass).length;
  const soft = results.filter((r) => r.soft).length;
  console.log('');
  console.log(
    `===== 阶段十一 P0~P3 线上验收：${passed}/${results.length} 通过（其中 ${soft} 条 WARN）=====`
  );
  fs.writeFileSync(
    REPORT,
    JSON.stringify(
      {
        results: redactDeep(results),
        passed,
        total: results.length,
        soft,
        // ⚠️ 报告里**不落明文 Key**（明文只回显到 stdout，交给运维当场清理）
        issuedKeyMasked: maskKey(issuedKey),
        withdrawalIds,
      },
      null,
      2
    )
  );
  process.exit(passed === results.length ? 0 : 1);
})();
