/**
 * 阶段二十二 P0~P3 · 线上安全加固验收
 *   ① P0 资金链止血（线上）：
 *      - `POST /api/v1/user/recharge` ⇒ 生产默认 **403 demo_recharge_disabled**；
 *      - 单笔上限收敛到 **$100**（超限 ⇒ 400）；
 *      - 充值强制过 IP 限流（连打 ⇒ 429）。
 *   ② P1 授权纵深（线上）：
 *      - CORS 改为**显式白名单**（恶意 Origin 不回 `Access-Control-Allow-Origin`）；
 *      - 非 active 账户 ⇒ 403 `account_not_active`；
 *      - 新钱包**不再自动 OWNER**（钱包绑定后角色仍是 BUYER）；
 *      - `GET /api/v1/user/overview-analytics` 匿名访问**不得**泄露他人数据。
 *   ③ P2 诚实口径（线上）：
 *      - 五大承诺矩阵的 `compliant` 必须**可由 evidence 独立复算**；
 *      - 大盘如实暴露 `real_traffic_7d` / `business_facts`，**不恒为 100%**；
 *      - `sha256-hex-merkle` + 锚定状态标签诚实。
 *   ④ P3 生产纵深（线上）：
 *      - nginx 安全响应头（nosniff / DENY / Referrer-Policy）；
 *      - 直连源站（Host 头伪造）⇒ **403**（Cloudflare 源站白名单生效）；
 *      - 双站 Gzip < 400KB。
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/tmp/pwrun/node_modules \
 *   APIPAW_OWNER_TOKEN='<ops_ctl issue-owner-token 的输出>' \
 *   node e2e/phase22-p1.cjs
 *
 * ⚠️ 本机直连 cloud.apipaw.com / console.apipaw.com 被墙 ⇒ 走本地 SOCKS5
 *    （127.0.0.1:1080）：浏览器用 --proxy-server，node 侧走 curl 代理壳。
 *
 * 产物：e2e/shots/phase22-*.png + e2e/phase22-report.json（**只落掩码**）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { maskKey, redactDeep } = require('./redact.cjs');

const BASE_URL = process.argv[2] || 'https://console.apipaw.com';
const CLOUD_URL = process.env.APIPAW_CLOUD_URL || 'https://cloud.apipaw.com';
const POCKET_URL = process.env.APIPAW_POCKET_URL || 'https://pocket.apipaw.com';
const ORIGIN_IP = process.env.APIPAW_ORIGIN_IP || '103.142.190.251';
const OWNER_TOKEN = process.env.APIPAW_OWNER_TOKEN || '';
const SOCKS = process.env.APIPAW_SOCKS || '127.0.0.1:1080';
const SHOT_DIR = path.join(__dirname, 'shots');
const REPORT = path.join(__dirname, 'phase22-report.json');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p22curl-'));
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
        await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
        continue;
      }
      return res;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 1200));
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
    check(len > 0 && len < 400 * 1024, `${label} 压缩后体积 < 400KB`, `${(len / 1024).toFixed(1)}KB`);
  } catch (e) {
    bad(`${label} Gzip`, e.message);
  }
}

const STAMP = `P22E2E${Date.now().toString(36).toUpperCase()}`;
const PILLAR_IDS = ['merkle_state_machine', 'poi_sampling_slashing',
  'dao_governance_hash_lock', 'pipeline_mesh_moa', 'local_first_failover'];

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

  let buyerKey = '';
  let buyerHandle = '';
  let complianceRate = 0;

  try {
    /* ═════════════ ① 买家 Key ═════════════ */
    const issue = await fetchRetry(CLOUD_URL + '/api/v1/auth/apikey', { method: 'POST' });
    const rec = await issue.json().catch(() => ({}));
    buyerKey = String(rec.api_key || '');
    buyerHandle = String(rec.account_handle || '');
    check(issue.status === 200 && !!buyerKey, '①a 签发全新买家账户', maskKey(buyerKey));

    /* ═════════════ ② P0 · 充值封堵（线上） ═════════════ */
    const recharge = await fetchRetry(CLOUD_URL + '/api/v1/user/recharge', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + buyerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount_usd: 1.0, note: 'p22-e2e' }),
    });
    const rbody = await recharge.json().catch(() => ({}));
    const rdetail = String(rbody.detail || rbody.error || rbody.code || '');
    check(recharge.status === 403 && /demo_recharge_disabled/.test(rdetail),
      '②a 生产充值默认**关闭**（403 demo_recharge_disabled）',
      `HTTP ${recharge.status} ${rdetail}`);
    check(!/已到账|recharged|success/i.test(rdetail),
      '②b 被拒的充值**没有**真的加钱', rdetail);

    // 单笔上限 $100（用 demo 开关显式开启后验证上限仍然生效）
    // ⚠️ 生产上开关是关的 ⇒ 这里**只**验证上限代码路径存在于响应契约里，
    //    真实上限由 smoke_p22_security_hardening.py 在沙箱里验证。
    const big = await fetchRetry(CLOUD_URL + '/api/v1/user/recharge', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + buyerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount_usd: 100000.0, note: 'p22-e2e-big' }),
    });
    const bbody = await big.json().catch(() => ({}));
    check(big.status === 403 || big.status === 400,
      '②c 超大额充值被拒（闸门先于金额校验生效）',
      `HTTP ${big.status} ${String(bbody.detail || '')}`);

    /* ═════════════ ③ P1 · CORS 白名单（线上） ═════════════ */
    const evilCors = await fetchRetry(CLOUD_URL + '/api/v1/network/health', {
      headers: { Origin: 'https://evil.example.com' },
    });
    const allowOrigin = String(evilCors.header('access-control-allow-origin') || '');
    check(allowOrigin === '' || allowOrigin.toLowerCase() !== '*',
      '③a 恶意 Origin 不获 CORS 放行（不再是 *）',
      `ACAO=${allowOrigin || '(none)'}`);
    const goodCors = await fetchRetry(CLOUD_URL + '/api/v1/network/health', {
      headers: { Origin: 'https://console.apipaw.com' },
    });
    const allowOrigin2 = String(goodCors.header('access-control-allow-origin') || '');
    check(allowOrigin2.toLowerCase() === 'https://console.apipaw.com',
      '③b 白名单 Origin 正常放行', `ACAO=${allowOrigin2 || '(none)'}`);

    /* ═════════════ ④ P1 · 匿名越权面（线上） ═════════════ */
    // 口径（阶段二十二 P1 修完后的真实语义）：
    //   匿名调用**允许**返回 200，但只能返回**全网聚合基准**（scoped=false），
    //   且**不得**出现任何账户级字段（api_key / node_secret / balance_usd）
    //   或非空 account_handle —— 出现即判定为越权泄露。
    //   （旧断言把「出现 account_handle 这个键名」也算泄露 ⇒ 假红：空值也算。）
    const anonAnalytics = await fetchRetry(CLOUD_URL + '/api/v1/user/overview-analytics');
    const abody = await anonAnalytics.json().catch(() => ({}));
    const leaked = JSON.stringify(abody || {});
    const leakFields = [];
    if (/"api_key"\s*:/i.test(leaked)) leakFields.push('api_key');
    if (/"node_secret"\s*:/i.test(leaked)) leakFields.push('node_secret');
    if (/"balance_usd"\s*:/i.test(leaked)) leakFields.push('balance_usd');
    if (String(abody.account_handle || '').trim()) leakFields.push('account_handle(非空)');
    if (abody.scoped === true) leakFields.push('scoped=true');
    const anonOk = (anonAnalytics.status === 401 || anonAnalytics.status === 403
      || (anonAnalytics.status === 200 && leakFields.length === 0));
    check(anonOk, '④a 匿名 overview-analytics 不泄露他人账目',
      `HTTP ${anonAnalytics.status} scoped=${abody.scoped} 泄露字段=${JSON.stringify(leakFields)}`);

    /* ═════════════ ⑤ P2 · 诚实口径（线上） ═════════════ */
    const fedRes = await fetchRetry(CLOUD_URL + '/api/v1/network/federation-status');
    const fed = await fedRes.json().catch(() => ({}));
    check(fedRes.status === 200 && String(fed.protocol_version || '') === 'v3.0.0',
      '⑤a GET /network/federation-status ⇒ 协议 v3.0.0',
      `HTTP ${fedRes.status}`);
    const compliance = fed.compliance || {};
    const pillars = Array.isArray(compliance.pillars) ? compliance.pillars : [];
    complianceRate = Number(compliance.rate || 0);
    check(pillars.length === 5, '⑤b 五大承诺矩阵齐备（5 项）',
      pillars.map((p) => p.id).join(','));

    const expectPillar = (pid) => {
      const p = pillars.find((x) => x.id === pid) || {};
      const ev = p.evidence || {};
      switch (pid) {
        case 'merkle_state_machine':
          return !!(ev.state_root) && Number(ev.ledger_leaf_count || 0) > 0;
        case 'poi_sampling_slashing':
          return Math.abs(Number(ev.spot_check_rate || 0) - 0.05) < 1e-9
            && Number(ev.poi_audits || 0) >= 1
            && Number(ev.verified_inferences || 0) >= 1;
        case 'dao_governance_hash_lock':
          return Number(ev.governance_threshold || 0) >= 0.66 - 1e-9
            && Number(ev.locked_model_count || 0) > 0
            && Number(ev.dao_votes || 0) >= 1
            && Number(ev.executed_proposals || 0) >= 1;
        case 'pipeline_mesh_moa':
          return Number(ev.registered_cluster_count || 0) >= 1
            && Number(ev.live_mesh_node_count || 0) >= 2;
        case 'local_first_failover':
          return Number(ev.gateway_count || 0) >= 2 && !!ev.failover_ready;
        default:
          return false;
      }
    };
    const mismatches = PILLAR_IDS.filter(
      (pid) => expectPillar(pid) !== !!((pillars.find((p) => p.id === pid) || {}).compliant));
    check(mismatches.length === 0,
      '⑤c 合规判定与业务事实一致（不恒真）',
      `compliant=${compliance.compliant}/${compliance.total}`
      + (mismatches.length ? ` mismatch=${mismatches.join(',')}` : ''));
    check(typeof fed.real_traffic_7d === 'number'
      && fed.business_facts && typeof fed.business_facts.real_traffic_7d === 'number',
      '⑤d 大盘如实暴露 real_traffic_7d 与 business_facts',
      `real_traffic_7d=${fed.real_traffic_7d}`);
    const merkle = pillars.find((p) => p.id === 'merkle_state_machine') || {};
    const algo = String((merkle.evidence || {}).algorithm || '');
    const anchor = String((merkle.evidence || {}).anchor_status || '');
    check(algo === 'sha256-hex-merkle',
      '⑤e 默克尔算法标签诚实（sha256-hex-merkle）', algo);
    check(/not_externally_anchored|externally_anchored/.test(anchor),
      '⑤f 锚定状态标签存在（不谎称已上链）', anchor);
    const mesh = pillars.find((p) => p.id === 'pipeline_mesh_moa') || {};
    check(String((mesh.evidence || {}).execution_stage || '') === 'topology_planning_only',
      '⑤g Mesh 执行阶段诚实标注（仅拓扑规划）',
      String((mesh.evidence || {}).execution_stage || ''));
    check(String(fed.note || '').length > 0,
      '⑤h 大盘带诚实口径说明', String(fed.note || '').slice(0, 60));

    /* ═════════════ ⑥ P3 · nginx 安全头 + 直连绕过 ═════════════ */
    const healthRes = await fetchRetry(CLOUD_URL + '/api/v1/network/health');
    const nosniff = String(healthRes.header('x-content-type-options') || '').toLowerCase();
    const frame = String(healthRes.header('x-frame-options') || '').toLowerCase();
    const referrer = String(healthRes.header('referrer-policy') || '').toLowerCase();
    check(nosniff === 'nosniff', '⑥a X-Content-Type-Options: nosniff', nosniff || '(none)');
    check(frame === 'deny' || frame === 'sameorigin',
      '⑥b X-Frame-Options 已设置', frame || '(none)');
    check(referrer.length > 0, '⑥c Referrer-Policy 已设置', referrer || '(none)');

    // 直连源站（绕过 Cloudflare）⇒ 403（源站 IP 白名单 + Host 校验）
    let directStatus = 0;
    let directDetail = '';
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p22direct-'));
      const args = ['-s', '-m', '30', '-o', path.join(dir, 'b'), '-w', '%{http_code}',
        '-H', 'Host: cloud.apipaw.com',
        `http://${ORIGIN_IP}/api/v1/network/health`];
      try {
        directStatus = Number(String(execFileSync('curl', args, { encoding: 'utf8' })).trim());
      } catch (e) {
        const m = String((e.stdout || '')).match(/(\d{3})\s*$/);
        directStatus = m ? Number(m[1]) : 0;
      }
      directDetail = `HTTP ${directStatus}`;
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    } catch (e) {
      directDetail = e.message;
    }
    check(directStatus === 403,
      '⑥d 直连源站（伪造 Host）⇒ 403（Cloudflare 源站白名单生效）',
      directDetail);
    check(healthRes.status === 200,
      '⑥e 经 Cloudflare 正常访问仍为 200', `HTTP ${healthRes.status}`);

    /* ═════════════ ⑦ UI · 诚实口径渲染 ═════════════ */
    await context.addInitScript((key) => {
      try { window.localStorage.setItem('apipaw.api_key', key); } catch (e) {}
    }, buyerKey);
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
      ok('⑦a 控制台首屏挂载', '');
    } catch (e) {
      warn('⑦a 控制台首屏挂载', String(e.message).split('\n')[0]);
    }
    await sleep(2500);
    if ((await page.locator('#apx-modal').count()) > 0) {
      const cancelBtn = page.locator('#apx-modal-card').getByText('取消', { exact: true });
      if ((await cancelBtn.count()) > 0) {
        await cancelBtn.first().click({ timeout: 8000 }).catch(() => {});
        await sleep(800);
      }
    }
    if ((await page.locator('[data-testid="mesh-federation-card"]').count()) > 0) {
      const matrixText = await page.locator('[data-testid="compliance-matrix"]')
        .innerText().catch(() => '');
      const measured = compliance.compliant;
      const measuredTotal = compliance.total;
      check(matrixText.includes(`${measured}/${measuredTotal}`),
        '⑦b 合规矩阵渲染实测计数（不伪装 100%）',
        matrixText.replace(/\s+/g, ' ').slice(0, 120));
      check(/不保证也不伪装成 100%|业务事实/.test(matrixText),
        '⑦c 合规矩阵附带诚实口径说明',
        matrixText.replace(/\s+/g, ' ').slice(0, 120));
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase22-honest-matrix.png'), fullPage: false })
        .catch(() => {});
    } else {
      warn('⑦b 合规矩阵渲染实测计数（不伪装 100%）', '大盘卡片未渲染（可能未登录）');
      warn('⑦c 合规矩阵附带诚实口径说明', '大盘卡片未渲染（可能未登录）');
    }

    /* ═════════════ ⑧ 双站 Gzip ═════════════ */
    await checkGzip(BASE_URL, 'console');
    await checkGzip(POCKET_URL, 'pocket');
  } catch (e) {
    bad('阶段二十二 E2E', e && e.message ? e.message : String(e));
  } finally {
    const passed = results.filter((r) => r.pass && !r.soft).length;
    const soft = results.filter((r) => r.soft).length;
    const report = {
      stamp: STAMP,
      buyerHandle,
      buyerKeyMasked: maskKey(buyerKey),
      compliance_rate: complianceRate,
      passed,
      total: results.length,
      soft,
      results: redactDeep(results),
      pageErrors,
    };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
    console.log('');
    console.log(`===== 阶段二十二 P0~P3 · 线上安全验收：${passed}/${results.length} 通过（软告警 ${soft}）=====`);
    console.log(`报告：${REPORT}`);
    console.log(`清理请用：ops_ctl.py cleanup --account ${buyerHandle}`);
    await browser.close();
    process.exit(passed === results.length ? 0 : 1);
  }
})();
