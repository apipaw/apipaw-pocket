/**
 * 阶段二十 P0~P3 · 线上验收
 *   ① P0 Pipeline Mesh 合体：
 *      - `GET  /api/v1/network/mesh-topology` ⇒ 公开拓扑（集群 / 聚合显存 / 分片表）；
 *      - `POST /api/v1/owner/mesh/register-cluster`（OWNER）⇒ 登记 2×6GB ⇒ 12GB / 2 分片；
 *      - 买家调业主端点 ⇒ 401/403。
 *   ② P2 多网关容灾 + 白皮书 v3.0 合规大盘：
 *      - `GET  /api/v1/network/federation-status` ⇒ 协议 v3.0.0 / 主备网关 / State Root /
 *        PoI 验真率 / DAO 锁模型数 / **五大承诺实时合规矩阵（业务事实口径）**；
 *      - 合规矩阵五项 `compliant` 必须与业务事实**独立复算一致**，
 *        且大盘如实暴露 `real_traffic_7d` / `business_facts`（**不恒为 100%**）。
 *   ③ UI：🌐 Pipeline Mesh 异构算力网格 · 多网关容灾联邦与白皮书 v3.0 合规大盘
 *      （买家视角 + 业主视角「组建局域网 Pipeline Mesh 合体集群」演练）。
 *   ④ P3：双站 Gzip < 400KB。
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/tmp/pwrun/node_modules \
 *   APIPAW_OWNER_TOKEN='<ops_ctl issue-owner-token 的输出>' \
 *   node e2e/phase20-p1.cjs
 *
 * ⚠️ 本机直连 cloud.apipaw.com / console.apipaw.com 被墙 ⇒ 走本地 SOCKS5
 *    （127.0.0.1:1080）：浏览器用 --proxy-server，node 侧走 curl 代理壳。
 *
 * 产物：e2e/shots/phase20-*.png + e2e/phase20-report.json（**只落掩码**）
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
const REPORT = path.join(__dirname, 'phase20-report.json');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p20curl-'));
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
const isHex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

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
      ok('⓪ 控制台首屏挂载', `尝试 ${attempt} 次`);
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

const STAMP = `P20E2E${Date.now().toString(36).toUpperCase()}`;
const CLUSTER_ID = `p20-e2e-${Date.now().toString(36)}`;
const PILLARS = [
  'merkle_state_machine',
  'poi_sampling_slashing',
  'dao_governance_hash_lock',
  'pipeline_mesh_moa',
  'local_first_failover',
];

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
  let clusterId = '';
  let complianceRate = 0;

  try {
    /* ═════════════ ① 买家 Key ═════════════ */
    const issue = await fetchRetry(CLOUD_URL + '/api/v1/auth/apikey', { method: 'POST' });
    const rec = await issue.json().catch(() => ({}));
    buyerKey = String(rec.api_key || '');
    buyerHandle = String(rec.account_handle || '');
    check(issue.status === 200 && !!buyerKey, '①a 签发全新买家账户', maskKey(buyerKey));

    /* ═════════════ ② P0 · 公开 Mesh 拓扑 ═════════════ */
    const topoRes = await fetchRetry(CLOUD_URL + '/api/v1/network/mesh-topology');
    const topo = await topoRes.json().catch(() => ({}));
    check(topoRes.status === 200 && topo.status === 'success',
      '②a GET /network/mesh-topology ⇒ 公开拓扑可读',
      `HTTP ${topoRes.status} clusters=${topo.registered_cluster_count}`);
    check(String(topo.protocol_version || '').startsWith('v3.'),
      '②b 拓扑自带联邦协议版本 v3.x', String(topo.protocol_version || ''));

    /* ═════════════ ③ P2 · 白皮书 v3.0 合规大盘 ═════════════ */
    const fedRes = await fetchRetry(CLOUD_URL + '/api/v1/network/federation-status');
    const fed = await fedRes.json().catch(() => ({}));
    check(fedRes.status === 200 && String(fed.protocol_version || '') === 'v3.0.0',
      '③a GET /network/federation-status ⇒ 协议 v3.0.0',
      `HTTP ${fedRes.status} ${fed.protocol_version}`);
    const compliance = fed.compliance || {};
    const pillars = Array.isArray(compliance.pillars) ? compliance.pillars : [];
    complianceRate = Number(compliance.rate || 0);
    check(pillars.length === 5, '③b 五大承诺矩阵齐备（5 项）',
      pillars.map((p) => p.id).join(','));
    /* 阶段二十二 P2：不再断言「恒 100%」。
       旧断言 `allCompliant && rate === 1` 就是那个 bug 的镜像 ——
       它把「常量校验恒真」当成「能力已兑现」。
       现在改为断言：**服务端的合规结论 == 用 evidence 独立复算的结论**，
       并且真实流量/业务事实被如实暴露。 */
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
    const PILLAR_IDS = ['merkle_state_machine', 'poi_sampling_slashing',
      'dao_governance_hash_lock', 'pipeline_mesh_moa', 'local_first_failover'];
    const mismatches = PILLAR_IDS.filter(
      (pid) => expectPillar(pid) !== !!((pillars.find((p) => p.id === pid) || {}).compliant));
    check(mismatches.length === 0,
      '③c 五大承诺合规判定与业务事实一致（不恒真）',
      `rate=${complianceRate} compliant=${compliance.compliant}/${compliance.total}`
      + (mismatches.length ? ` mismatch=${mismatches.join(',')}` : ''));
    check(typeof fed.real_traffic_7d === 'number'
      && fed.business_facts && typeof fed.business_facts.real_traffic_7d === 'number',
      '③c2 大盘如实暴露 real_traffic_7d 与 business_facts',
      `real_traffic_7d=${fed.real_traffic_7d}`);
    check(isHex64(String(fed.state_root?.state_root || '')),
      '③d 大盘锚定全局账本 State Root',
      String(fed.state_root?.state_root || '').slice(0, 16));
    const gw = fed.federation || {};
    check(Number(gw.gateway_count || 0) >= 1 && typeof gw.all_healthy !== 'undefined',
      '③e 多网关主备健康度可见',
      `gateways=${gw.gateway_count} healthy=${gw.healthy_count} all_healthy=${gw.all_healthy}`);
    check(typeof fed.poi?.verification_rate === 'number'
      && typeof fed.dao?.locked_model_count === 'number',
      '③f PoI 验真率 + DAO 锁模型数已聚合',
      `poi=${fed.poi?.verification_rate} dao_locked=${fed.dao?.locked_model_count}`);

    /* ═════════════ ④ P0 · OWNER 组建 Mesh 集群（演练） ═════════════ */
    const drillPayload = {
      cluster_id: CLUSTER_ID,
      leader_node_id: 'win_node_01',
      member_node_ids: ['win_node_01', 'p20_e2e_peer_b'],
      cluster_vram_gb: 12.0,
      mesh_shards: 2,
      mesh_rtt_ms: 3.2,
      mode: 'Pipeline Shards',
      layer_splits: [
        { index: 0, node: 'win_node_01', label: 'win_node_01', vram_gb: 6.0,
          layers: 'L0-39', layer_start: 0, layer_end: 39, layer_count: 40, share: 0.5 },
        { index: 1, node: 'p20_e2e_peer_b', label: 'p20_e2e_peer_b', vram_gb: 6.0,
          layers: 'L40-79', layer_start: 40, layer_end: 79, layer_count: 40, share: 0.5 },
      ],
    };

    const drillDenied = await fetchRetry(CLOUD_URL + '/api/v1/owner/mesh/register-cluster', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + buyerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(drillPayload),
    });
    check(drillDenied.status === 401 || drillDenied.status === 403,
      '④a 买家调业主组网端点 ⇒ 被拒', `HTTP ${drillDenied.status}`);

    if (OWNER_TOKEN) {
      const drill = await fetchRetry(CLOUD_URL + '/api/v1/owner/mesh/register-cluster', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OWNER_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(drillPayload),
      });
      const dbody = await drill.json().catch(() => ({}));
      clusterId = String(dbody.cluster?.cluster_id || '');
      check(drill.status === 200 && !!clusterId && dbody.ok === true,
        '④b 业主组建 2×6GB ⇒ 12GB 合体集群登记成功',
        `HTTP ${drill.status} ${clusterId}`);
      check(Number(dbody.cluster?.mesh_shards || 0) === 2
        && Math.abs(Number(dbody.cluster?.cluster_vram_gb || 0) - 12.0) < 1e-9,
        '④c 登记结果：2 分片 / 聚合显存 12GB',
        `shards=${dbody.cluster?.mesh_shards} vram=${dbody.cluster?.cluster_vram_gb}`);

      const topo2Res = await fetchRetry(CLOUD_URL + '/api/v1/network/mesh-topology');
      const topo2 = await topo2Res.json().catch(() => ({}));
      const found = (topo2.clusters || []).find((c) => c.cluster_id === CLUSTER_ID);
      check(!!found, '④d 新集群出现在公开拓扑大盘', String(found?.cluster_id || ''));
      const splits = (found?.layer_splits || []);
      check(splits.length === 2
        && Number(splits[0].layer_start) === 0 && Number(splits[0].layer_end) === 39
        && Number(splits[1].layer_start) === 40 && Number(splits[1].layer_end) === 79,
        '④e 分层切表 L0-39 / L40-79（不重不漏）',
        splits.map((s) => s.layers).join(' · '));
    } else {
      warn('④b 业主组建 2×6GB ⇒ 12GB 合体集群登记成功', '缺少 APIPAW_OWNER_TOKEN，跳过');
      warn('④c 登记结果：2 分片 / 聚合显存 12GB', '缺少 APIPAW_OWNER_TOKEN，跳过');
      warn('④d 新集群出现在公开拓扑大盘', '缺少 APIPAW_OWNER_TOKEN，跳过');
      warn('④e 分层切表 L0-39 / L40-79（不重不漏）', '缺少 APIPAW_OWNER_TOKEN，跳过');
    }

    /* ═════════════ ⑤ UI · 买家视角 ═════════════ */
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

    check((await page.locator('[data-testid="mesh-federation-card"]').count()) > 0,
      '⑤a 🌐 Mesh / 联邦合规大盘已渲染', '');
    const kpiText = await waitForText(page, 'federation-kpis', 'v3\\.0\\.0|State Root|PoI', 60000);
    check(/v3\.0\.0|State Root|PoI/.test(kpiText), '⑤b 联邦 KPI 已渲染',
      kpiText.replace(/\s+/g, ' ').slice(0, 90));
    const rootText = await waitForText(page, 'federation-state-root', '[0-9a-f]{8}', 45000);
    check(/[0-9a-f]{8}/i.test(rootText), '⑤c 全局 State Root 已渲染',
      rootText.replace(/\s+/g, ' ').slice(0, 60));
    check((await page.locator('[data-testid="compliance-matrix"]').count()) > 0,
      '⑤d 五大承诺合规矩阵已渲染', '');
    const pillarSeen = [];
    for (const pid of PILLARS) {
      const n = await page.locator(`[data-testid="compliance-${pid}"]`).count();
      if (n > 0) pillarSeen.push(pid);
    }
    check(pillarSeen.length === PILLARS.length,
      '⑤e 五大承诺逐项渲染', `${pillarSeen.length}/${PILLARS.length}`);
    /* 阶段二十二 P2：前端必须渲染**实测**计数与诚实口径文案，不得伪装 100% */
    const matrixText = await page.locator('[data-testid="compliance-matrix"]')
      .innerText().catch(() => '');
    const measured = compliance.compliant;
    const measuredTotal = compliance.total;
    check(matrixText.includes(`${measured}/${measuredTotal}`),
      '⑤e2 合规矩阵标题渲染实测计数（不伪装 100%）',
      matrixText.replace(/\s+/g, ' ').slice(0, 120));
    check(/不保证也不伪装成 100%|业务事实/.test(matrixText),
      '⑤e3 合规矩阵附带诚实口径说明', matrixText.replace(/\s+/g, ' ').slice(0, 120));
    check((await page.locator('[data-testid="gateway-status"]').count()) > 0,
      '⑤f 多网关容灾状态条已渲染', '');
    check((await page.locator('[data-testid="mesh-shard-topology"]').count()) > 0,
      '⑤g Mesh 分片拓扑区已渲染', '');
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase20-mesh-federation.png'), fullPage: false })
      .catch(() => {});

    /* ═════════════ ⑥ UI · 业主视角（组网演练） ═════════════ */
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
      await clickSafe(toOwner, '⑥a 切到业主视角');
      await sleep(2500);
    }
    const govTab = page.locator('[data-testid="host-tab-GOVERNANCE"]');
    if ((await govTab.count()) > 0) {
      await clickSafe(govTab.first(), '⑥b 进入节点治理页');
      await sleep(4000);
    }
    check((await page.locator('[data-testid="mesh-federation-card"]').count()) > 0,
      '⑥c 业主侧 Mesh / 联邦大盘已渲染', '');

    const drillBtn = page.locator('[data-testid="mesh-drill-button"]');
    if ((await drillBtn.count()) > 0) {
      await clickSafe(drillBtn.first(), '⑥d 点击「组建局域网 Pipeline Mesh 合体集群」');
      const drillText = await waitForText(page, 'mesh-drill-status', '.+', 60000);
      const drillOk = /成功|已登记|12\s*GB|2\s*片|L0-39|L40-79/.test(drillText);
      check(drillOk, '⑥e 组网演练返回 12GB / 2 分片结论',
        drillText.replace(/\s+/g, ' ').slice(0, 110));
    } else {
      warn('⑥d 点击「组建局域网 Pipeline Mesh 合体集群」', '业主视角下按钮未渲染');
      warn('⑥e 组网演练返回 12GB / 2 分片结论', '按钮未渲染，跳过');
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase20-mesh-drill.png'), fullPage: false })
      .catch(() => {});

    /* ═════════════ ⑦ 双站 Gzip ═════════════ */
    await checkGzip(BASE_URL, 'console');
    await checkGzip(POCKET_URL, 'pocket');
  } catch (e) {
    bad('阶段二十 E2E', e && e.message ? e.message : String(e));
  } finally {
    const passed = results.filter((r) => r.pass && !r.soft).length;
    const soft = results.filter((r) => r.soft).length;
    const report = {
      stamp: STAMP,
      buyerHandle,
      buyerKeyMasked: maskKey(buyerKey),
      cluster_id: clusterId,
      compliance_rate: complianceRate,
      passed,
      total: results.length,
      soft,
      results: redactDeep(results),
      pageErrors,
    };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
    console.log('');
    console.log(`===== 阶段二十 P0~P3 · 线上 E2E：${passed}/${results.length} 通过（软告警 ${soft}）=====`);
    console.log(`报告：${REPORT}`);
    console.log(`清理请用：ops_ctl.py cleanup --account ${buyerHandle} --mesh-since <ts>`);
    await browser.close();
    process.exit(passed === results.length ? 0 : 1);
  }
})();
