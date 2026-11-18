/**
 * 阶段十八 P0~P3 · 线上验收
 *   ① P0/P2 网关公开端点：
 *      - `GET /api/v1/network/state-root`  ⇒ 状态根 / 账本根 / 分账根 / 叶子数；
 *      - `GET /api/v1/network/merkle-proof` ⇒ 包含性证明（公开口径 + 买家口径）；
 *      - `GET /api/v1/network/poi-summary`  ⇒ 全网 PoI 抽检统计。
 *   ② **默克尔数学自洽**：用 Node 原生 crypto 在本地重算根
 *      （与浏览器端 `src/utils/sha256.ts` 同一算法）⇒ 必须等于网关公示的 ledger_root。
 *   ③ P1 业主接口：
 *      - `POST /api/v1/owner/poi/audit` 模拟欺诈演练 ⇒ SLASHED + 扣信用分；
 *      - 买家 Key 调业主端点 ⇒ 403。
 *   ④ UI：🔗 PoI 共识 · 默克尔状态根看板（状态根读数 + 浏览器端一键验真 + 业主演练）。
 *   ⑤ P3：双站 Gzip < 450KB。
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules \
 *   APIPAW_OWNER_TOKEN='<ops_ctl issue-owner-token 的输出>' \
 *   node e2e/phase18-p1.cjs
 *
 * ⚠️ 本机直连 cloud.apipaw.com / console.apipaw.com 被墙 ⇒ 走本地 SOCKS5
 *    （127.0.0.1:1080）：浏览器用 --proxy-server，node 侧走 curl 代理壳。
 *
 * 产物：e2e/shots/phase18-*.png + e2e/phase18-report.json（**只落掩码**）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { maskKey, redactDeep } = require('./redact.cjs');

const BASE_URL = process.argv[2] || 'https://console.apipaw.com';
const CLOUD_URL = process.env.APIPAW_CLOUD_URL || 'https://cloud.apipaw.com';
const POCKET_URL = process.env.APIPAW_POCKET_URL || 'https://pocket.apipaw.com';
const OWNER_TOKEN = process.env.APIPAW_OWNER_TOKEN || '';
const SOCKS = process.env.APIPAW_SOCKS || '127.0.0.1:1080';
const SHOT_DIR = path.join(__dirname, 'shots');
const REPORT = path.join(__dirname, 'phase18-report.json');
const T = {
  nav: Number(process.env.APIPAW_E2E_NAV_TIMEOUT || 120000),
  app: Number(process.env.APIPAW_E2E_APP_TIMEOUT || 180000),
  mount: Number(process.env.APIPAW_E2E_MOUNT_TIMEOUT || 150000),
  action: Number(process.env.APIPAW_E2E_ACTION_TIMEOUT || 30000),
  api: Number(process.env.APIPAW_E2E_API_TIMEOUT || 150000),
};

/* ────────────────────────── SOCKS5 fetch 壳 ────────────────────────── */
class SocksResponse {
  constructor(status, headers, bodyBuf) {
    this.status = status;
    this.headers = headers;
    this._buf = bodyBuf;
  }
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
  header(name) {
    const key = String(name).toLowerCase();
    return this.headers[key] === undefined ? null : this.headers[key];
  }
  async text() {
    return this._buf.toString('utf8');
  }
  async json() {
    return JSON.parse(this._buf.toString('utf8') || '{}');
  }
}

function socksFetch(url, init = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p18curl-'));
  const hdrFile = path.join(dir, 'h');
  const bodyFile = path.join(dir, 'b');
  const raw = !!init.raw;
  const args = ['-s', '--socks5-hostname', SOCKS, '-m', '120',
                '-D', hdrFile, '-o', bodyFile, '-w', '%{http_code}'];
  if (!raw) args.push('--compressed');
  args.push('-X', String(init.method || 'GET').toUpperCase());
  const headers = init.headers || {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    args.push('-H', `${k}: ${v}`);
  }
  if (init.body) {
    // ⚠️ Windows 下 MSYS 会把命令行参数按 ANSI 代码页转码 ⇒ 中文 JSON 会被打乱
    //    ⇒ 请求体一律落临时文件再 @file 传入
    const payloadFile = path.join(dir, 'p');
    fs.writeFileSync(payloadFile, Buffer.from(String(init.body), 'utf8'));
    args.push('--data-binary', '@' + payloadFile);
    args.push('-H', 'Content-Type: application/json');
  }
  args.push(url);
  let status = 0;
  try {
    status = Number(String(execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })).trim());
  } catch (e) {
    const out = (e.stdout || '').toString();
    const m = out.match(/(\d{3})\s*$/);
    if (!m) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
      throw new Error(`curl 失败: ${e.message}`);
    }
    status = Number(m[1]);
  }
  const rawHead = fs.existsSync(hdrFile) ? fs.readFileSync(hdrFile, 'utf8') : '';
  const headers2 = {};
  rawHead.split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) headers2[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  });
  const body = fs.existsSync(bodyFile) ? fs.readFileSync(bodyFile) : Buffer.alloc(0);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  return new SocksResponse(status, headers2, body);
}

async function fetchRetry(url, init, tries = 4) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = socksFetch(url, init);
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(1500 * (i + 1));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      await sleep(1200);
    }
  }
  throw lastErr || new Error('fetch failed');
}

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

/** 64 位小写十六进制？ */
const isHex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/** 本地重算默克尔根（与浏览器端 src/utils/sha256.ts 同一算法） */
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
/**
 * ⚠️ 兄弟链必须带**方位**：父节点 = sha256(left + right)，
 *    当前节点在右边时要算 sha256(sibling + current)。
 *    sides 缺省按「兄弟恒在右」（旧口径，仅对全偶下标成立）。
 */
const merkleRootFrom = (leafHash, siblings, sides) =>
  (siblings || []).reduce((cur, s, i) => (
    sides && sides[i] === 'L' ? sha256(String(s) + cur) : sha256(cur + String(s))
  ), String(leafHash || ''));

async function checkGzip(host, label) {
  try {
    const htmlRes = await fetchRetry(host + '/', { headers: { 'user-agent': 'apipaw-e2e' } });
    const html = await htmlRes.text();
    const m = html.match(/src="([^"]+\.js)"/);
    if (!m) {
      bad(`${label} Gzip`, 'HTML 里没找到 bundle 脚本');
      return;
    }
    const asset = m[1];
    const res = await fetchRetry(host + asset, {
      raw: true,
      headers: { 'accept-encoding': 'gzip', 'user-agent': 'apipaw-e2e' },
    });
    const enc = String(res.header('content-encoding') || '').toLowerCase();
    const len = Number(res.header('content-length') || 0);
    const detail = `${asset} → content-encoding=${enc || '(none)'} content-length=${len}`;
    check(enc.includes('gzip'), `${label} 返回 Content-Encoding: gzip`, detail);
    check(len > 0 && len < 450 * 1024, `${label} 压缩后体积 < 450KB`, `${(len / 1024).toFixed(1)}KB`);
  } catch (e) {
    bad(`${label} Gzip`, e.message);
  }
}

async function mount(page) {
  let mounted = false;
  let lastErr = null;
  for (let attempt = 1; attempt <= 5 && !mounted; attempt++) {
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
      ok('④a 控制台首屏挂载', `尝试 ${attempt} 次`);
    } catch (e) {
      lastErr = e;
      console.log(`  [retry] 第 ${attempt} 次挂载失败：${String(e.message).split('\n')[0]}`);
      try { await page.waitForTimeout(3000); } catch (_) {}
    }
  }
  if (!mounted) throw lastErr;
}

async function waitForText(page, testid, pattern, timeoutMs) {
  const re = new RegExp(pattern);
  const limit = timeoutMs || 45000;
  let text = '';
  for (let i = 0; i < Math.ceil(limit / 1000); i++) {
    text = (await page
      .locator(`[data-testid="${testid}"]`)
      .first()
      .innerText()
      .catch(() => '')) || '';
    if (re.test(text)) return text;
    await sleep(1000);
  }
  return text;
}

const STAMP = `P18E2E${Date.now().toString(36).toUpperCase()}`;
const MODEL = 'qwen2.5:0.5b';

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const launchArgs = ['--disable-ipv6', `--proxy-server=socks5://${SOCKS}`];
  if (process.env.APIPAW_E2E_HOST_RESOLVER) {
    launchArgs.push(`--host-resolver-rules=${process.env.APIPAW_E2E_HOST_RESOLVER}`);
  }
  const browser = await chromium.launch({ headless: true, args: launchArgs });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push('console.error: ' + String(m.text()).slice(0, 300));
  });

  let buyerKey = '';
  let buyerHandle = '';
  let stateRoot = null;
  let proofPublic = null;

  try {
    /* ═════════════ ① 买家 Key + 一次真实推理（造一条账本行） ═════════════ */
    const issue = await fetchRetry(CLOUD_URL + '/api/v1/auth/apikey', { method: 'POST' });
    const rec = await issue.json().catch(() => ({}));
    buyerKey = String(rec.api_key || '');
    buyerHandle = String(rec.account_handle || '');
    check(issue.status === 200 && !!buyerKey, '①a 签发全新买家账户', maskKey(buyerKey));

    const faucet = await fetchRetry(CLOUD_URL + '/api/v1/user/faucet', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + buyerKey },
    });
    const fbody = await faucet.json().catch(() => ({}));
    check(faucet.status === 200 && Number(fbody.balance_usd || 0) > 0,
      '①b 领取新手体验金', `HTTP ${faucet.status} balance=$${fbody.balance_usd}`);

    const chat = await fetchRetry(CLOUD_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + buyerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: `${STAMP}：阶段十八账本造行` }] }),
    });
    check(chat.status === 200, '①c 一次真实推理（生成账本流水行）', `HTTP ${chat.status}`);

    /* ═════════════ ② P2 · 状态根 + 默克尔包含性证明（公开口径） ═════════════ */
    const srRes = await fetchRetry(CLOUD_URL + '/api/v1/network/state-root');
    stateRoot = await srRes.json().catch(() => ({}));
    check(srRes.status === 200 && isHex64(stateRoot.state_root),
      '②a GET /network/state-root ⇒ 状态根可读',
      `HTTP ${srRes.status} state_root=${String(stateRoot.state_root || '').slice(0, 16)}…`);
    check(isHex64(stateRoot.ledger_root) && isHex64(stateRoot.revenue_root),
      '②b 账本根 / 分账根均为 64 位摘要',
      `ledger=${String(stateRoot.ledger_root || '').slice(0, 12)}… revenue=${String(stateRoot.revenue_root || '').slice(0, 12)}…`);
    check(Number(stateRoot.ledger_leaf_count || 0) > 0,
      '②c 账本叶子数 > 0', `ledger=${stateRoot.ledger_leaf_count} revenue=${stateRoot.revenue_leaf_count}`);

    // 状态根派生式本地复算：sha256("ledger:"+ledger_root+"|revenue:"+revenue_root)
    const stateComputed = sha256(`ledger:${stateRoot.ledger_root}|revenue:${stateRoot.revenue_root}`);
    check(stateComputed === stateRoot.state_root,
      '②d 状态根派生式本地复算一致', `computed=${stateComputed.slice(0, 16)}…`);

    const mpRes = await fetchRetry(CLOUD_URL + '/api/v1/network/merkle-proof?ledger=balance&leaf_index=0');
    proofPublic = await mpRes.json().catch(() => ({}));
    check(mpRes.status === 200 && proofPublic.ok === true,
      '②e GET /network/merkle-proof（公开口径）可取证明',
      `HTTP ${mpRes.status} ok=${proofPublic.ok}`);
    check(Array.isArray(proofPublic.siblings) && proofPublic.siblings.length > 0,
      '②f 兄弟链非空', `siblings=${(proofPublic.siblings || []).length}`);
    const computedPublic = merkleRootFrom(
      proofPublic.leaf_hash, proofPublic.siblings || [], proofPublic.sibling_sides || []);
    check(computedPublic === proofPublic.root_hash,
      '②g 本地重算根 == 证明根', `computed=${computedPublic.slice(0, 16)}…`);
    check(computedPublic === stateRoot.ledger_root,
      '②h 本地重算根 == 公示 ledger_root（默克尔自洽）',
      `${computedPublic.slice(0, 16)}…`);

    /* ⚠️ 右孩子叶子回归：父节点 = sha256(left + right)，
       当前节点在右时要算 sha256(sibling + current) —— 顺序写反只有全偶下标能过。 */
    const oddIdx = Math.max(0, Number(stateRoot.ledger_leaf_count || 1) - 1);
    const mpOdd = await fetchRetry(
      CLOUD_URL + `/api/v1/network/merkle-proof?ledger=balance&leaf_index=${oddIdx}`);
    const oddBody = await mpOdd.json().catch(() => ({}));
    const computedOdd = merkleRootFrom(
      oddBody.leaf_hash, oddBody.siblings || [], oddBody.sibling_sides || []);
    check(mpOdd.status === 200 && computedOdd === stateRoot.ledger_root,
      '②i 右孩子叶子（#' + oddIdx + '）证明也能重算回全网 ledger_root',
      `computed=${computedOdd.slice(0, 16)}… sides=${(oddBody.sibling_sides || []).join('')}`);

    /* ═════════════ ③ 买家口径（本人最后一行）+ PoI 汇总 + 业主演练 ═════════════ */
    const mpScoped = await fetchRetry(CLOUD_URL + '/api/v1/network/merkle-proof?ledger=balance', {
      headers: { Authorization: 'Bearer ' + buyerKey },
    });
    const scopedBody = await mpScoped.json().catch(() => ({}));
    check(mpScoped.status === 200 && scopedBody.ok === true && scopedBody.scoped === true,
      '③a 带买家 Key ⇒ 返回本人账本行的证明',
      `HTTP ${mpScoped.status} scoped=${scopedBody.scoped} leaf_index=${scopedBody.leaf_index}`);
    const computedScoped = merkleRootFrom(
      scopedBody.leaf_hash, scopedBody.siblings || [], scopedBody.sibling_sides || []);
    check(computedScoped === stateRoot.ledger_root,
      '③b 本人行的证明也能重算回全网 ledger_root',
      `${computedScoped.slice(0, 16)}…`);

    const sumRes = await fetchRetry(CLOUD_URL + '/api/v1/network/poi-summary?limit=10');
    const sum = await sumRes.json().catch(() => ({}));
    check(sumRes.status === 200 && Number(sum.spot_check_rate) === 5,
      '③c GET /network/poi-summary ⇒ 抽检率 5%',
      `HTTP ${sumRes.status} verified=${sum.verified_inferences} spot=${sum.spot_check_hits}`);
    check(Number(sum.total_usage_rows || 0) > 0,
      '③d PoI 汇总含推理流水计数', `total=${sum.total_usage_rows}`);

    // 业主演练（需要 OWNER 凭证）
    if (OWNER_TOKEN) {
      const drill = await fetchRetry(CLOUD_URL + '/api/v1/owner/poi/audit', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OWNER_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ simulate_fraud_type: 'token_inflation' }),
      });
      const dbody = await drill.json().catch(() => ({}));
      check(drill.status === 200 && dbody.ok === true,
        '③e 业主模拟欺诈演练 ⇒ SLASHED',
        `HTTP ${drill.status} node=${dbody.node_id} score=${dbody.score}`);
    } else {
      warn('③e 业主模拟欺诈演练 ⇒ SLASHED', '缺少 APIPAW_OWNER_TOKEN，跳过');
    }

    // 非业主不得调用业主端点
    const denied = await fetchRetry(CLOUD_URL + '/api/v1/owner/poi/audit', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + buyerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ simulate_fraud_type: 'token_inflation' }),
    });
    check(denied.status === 401 || denied.status === 403,
      '③f 买家 Key 调业主端点 ⇒ 被拒', `HTTP ${denied.status}`);

    /* ═════════════ ④ UI ═════════════ */
    await context.addInitScript((key) => {
      try { window.localStorage.setItem('apipaw.api_key', key); } catch (e) {}
    }, buyerKey);
    await mount(page);
    await sleep(3000);

    if ((await page.locator('#apx-modal').count()) > 0) {
      const cancelBtn = page.locator('#apx-modal-card').getByText('取消', { exact: true });
      if ((await cancelBtn.count()) > 0) {
        await cancelBtn.first().click({ timeout: 8000 }).catch(() => {});
        await sleep(800);
      }
    }

    check((await page.locator('[data-testid="poi-consensus-card"]').count()) > 0,
      '④b 🔗 PoI 共识看板已渲染', '');
    const rootText = await waitForText(page, 'poi-state-root', '[0-9a-f]{16}', 45000);
    check(/[0-9a-f]{16}/.test(rootText), '④c 状态根读数已渲染', rootText.replace(/\s+/g, ' ').slice(0, 40));
    const verifiedText = await page
      .locator('[data-testid="poi-verified"]').first().innerText().catch(() => '');
    check(String(verifiedText).trim().length > 0, '④d PoI 统计读数可读', `已验真=${String(verifiedText).trim()}`);

    // 浏览器端一键默克尔验真（走前端自带 SHA-256）
    await clickSafe(page.locator('[data-testid="poi-verify-balance"]').first(), '④e 点「本地验真我的账」');
    const verdictText = await waitForText(page, 'poi-verdict', '复验通过|未通过', 60000);
    check(/复验通过/.test(verdictText), '④f 浏览器端默克尔验真通过',
      verdictText.replace(/\s+/g, ' ').slice(0, 90));
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase18-poi.png'), fullPage: false })
      .catch(() => {});

    // 业主视角 → 节点治理 → 模拟欺诈演练按钮
    if (OWNER_TOKEN) {
      const payload = JSON.parse(
        Buffer.from(OWNER_TOKEN.split('.')[1], 'base64').toString('utf8'));
      const session = {
        token: OWNER_TOKEN,
        expiresAt: Number(payload.exp || 0),
        handle: String(payload.sub || ''),
        role: 'OWNER',
        status: 'active',
        wallet: String(payload.wallet || ''),
      };
      await page.evaluate((s) => {
        window.localStorage.setItem('apipaw.session', JSON.stringify(s));
      }, session);
      await page.reload({ waitUntil: 'commit', timeout: T.nav });
      await page.waitForFunction(
        () => {
          const root = document.getElementById('root');
          return !!(root && root.innerHTML && root.innerHTML.length > 200);
        },
        null,
        { timeout: T.mount, polling: 1000 }
      );
      await sleep(3000);
    }
    const toOwner = byText(page, '切换至业主视角');
    if ((await toOwner.count()) > 0) {
      await clickSafe(toOwner, '④g 切到业主视角');
      await sleep(2500);
    }
    const govTab = page.locator('[data-testid="host-tab-GOVERNANCE"]');
    if ((await govTab.count()) > 0) {
      await clickSafe(govTab.first(), '④h 进入节点治理页');
      await sleep(4000);
    }
    check((await page.locator('[data-testid="poi-drill"]').count()) > 0,
      '④i 业主侧「模拟欺诈演练」按钮已渲染', '');
    await clickSafe(page.locator('[data-testid="poi-drill"]').first(), '④j 点模拟欺诈演练');
    const drillText = await waitForText(page, 'poi-drill-result', '演练完成|失败', 60000);
    check(/演练完成/.test(drillText), '④k 演练结果已回显',
      drillText.replace(/\s+/g, ' ').slice(0, 90));
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase18-governance.png'), fullPage: false })
      .catch(() => {});

    /* ═════════════ ⑤ 双站 Gzip ═════════════ */
    await checkGzip(BASE_URL, 'console');
    await checkGzip(POCKET_URL, 'pocket');
  } catch (e) {
    bad('阶段十八 E2E', e && e.message ? e.message : String(e));
  } finally {
    const passed = results.filter((r) => r.pass && !r.soft).length;
    const soft = results.filter((r) => r.soft).length;
    const report = {
      stamp: STAMP,
      buyerHandle,
      buyerKeyMasked: maskKey(buyerKey),
      state_root: stateRoot ? String(stateRoot.state_root || '') : '',
      ledger_root: stateRoot ? String(stateRoot.ledger_root || '') : '',
      revenue_root: stateRoot ? String(stateRoot.revenue_root || '') : '',
      ledger_leaf_count: stateRoot ? Number(stateRoot.ledger_leaf_count || 0) : 0,
      proof_public_ok: proofPublic ? !!proofPublic.ok : false,
      passed,
      total: results.length,
      soft,
      results: redactDeep(results),
      pageErrors,
    };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
    console.log('');
    console.log(`===== 阶段十八 P0~P3 · 线上 E2E：${passed}/${results.length} 通过（软告警 ${soft}）=====`);
    console.log(`报告：${REPORT}`);
    console.log(`清理请用：ops_ctl.py cleanup --account ${buyerHandle} --poi-since <ts>`);
    await browser.close();
    process.exit(passed === results.length ? 0 : 1);
  }
})();
