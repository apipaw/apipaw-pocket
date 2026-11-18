/**
 * 阶段十九 P0~P3 · 线上验收
 *   ① P0 PAWMODEL 清单哈希锁：
 *      - `GET  /api/v1/network/model-manifests` ⇒ 每个模型带 manifest_sha256 / system_prompt_sha256；
 *      - `POST /api/v1/owner/models/import-pawmodel`（OWNER）⇒ 落库并返回两个哈希；
 *      - `/v1/chat/completions` 响应头 `X-APIPaw-Manifest-Hash` 与库里一致。
 *   ② P1 Model DAO 治理机：
 *      - `GET  /api/v1/network/dao/proposals` ⇒ 公开台账 + 阈值 0.66；
 *      - `POST /api/v1/owner/dao/propose` + `POST /api/v1/owner/dao/vote` ⇒ 投票权重口径；
 *      - 买家调业主端点 ⇒ 403。
 *   ③ P2 企业级 SLA + B2B 发票 + USDT 储值：
 *      - `GET /api/v1/network/sla-pool` ⇒ 金牌池门槛 0.95；
 *      - 带 `X-APIPaw-SLA-Tier: enterprise` 推理 ⇒ 响应头 `X-APIPaw-SLA-Routed`；
 *      - `GET /api/v1/user/invoice?format=json|csv|html` ⇒ 三种导出 + State Root 存证；
 *      - `POST /api/v1/user/deposit/declare` ⇒ 只登记不加钱；重复 ⇒ 409；
 *      - `POST /api/v1/owner/deposit/{id}/decide` ⇒ 批准入账（走唯一入账内核）。
 *   ④ UI：🏛️ Model DAO 治理锁 · B2B 发票 / USDT 储值（买家视角 + 业主视角）。
 *   ⑤ P3：双站 Gzip < 450KB。
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/tmp/pwrun/node_modules \
 *   APIPAW_OWNER_TOKEN='<ops_ctl issue-owner-token 的输出>' \
 *   node e2e/phase19-p1.cjs
 *
 * ⚠️ 本机直连 cloud.apipaw.com / console.apipaw.com 被墙 ⇒ 走本地 SOCKS5
 *    （127.0.0.1:1080）：浏览器用 --proxy-server，node 侧走 curl 代理壳。
 *
 * 产物：e2e/shots/phase19-*.png + e2e/phase19-report.json（**只落掩码**）
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
const REPORT = path.join(__dirname, 'phase19-report.json');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p19curl-'));
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
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

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

const STAMP = `P19E2E${Date.now().toString(36).toUpperCase()}`;
const MODEL = 'qwen2.5:0.5b';
const IMPORT_MODEL = 'p19-e2e-imported-model';
const TX_HASH = '0x' + crypto.randomBytes(32).toString('hex');

const PAWMODEL_CONTENT = [
  '---',
  `model_id: ${IMPORT_MODEL}`,
  'display_name: P19 E2E Imported Model',
  'tier: CREATOR',
  'min_vram_gb: 4',
  'prompt_price_per_1k: 0.0001',
  'completion_price_per_1k: 0.0002',
  'royalty_rate: 0.15',
  'author_wallet: "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"',
  '---',
  '',
  `# System Prompt`,
  '',
  `You are the phase-nineteen e2e model. ${STAMP}`,
].join('\n');

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
  let depositId = 0;
  let manifestCount = 0;

  try {
    /* ═════════════ ① 买家 Key ═════════════ */
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

    /* ═════════════ ② P0 · 模型清单指纹（公开） ═════════════ */
    const mfRes = await fetchRetry(CLOUD_URL + '/api/v1/network/model-manifests');
    const mf = await mfRes.json().catch(() => ({}));
    const manifests = Array.isArray(mf.manifests) ? mf.manifests : [];
    manifestCount = manifests.length;
    check(mfRes.status === 200 && manifestCount > 0,
      '②a GET /network/model-manifests ⇒ 清单可读', `HTTP ${mfRes.status} count=${manifestCount}`);
    const withHash = manifests.filter((m) => isHex64(String(m.manifest_sha256 || ''))
      && isHex64(String(m.system_prompt_sha256 || '')));
    check(withHash.length === manifestCount,
      '②b 每个模型都带两个 64 位哈希锁',
      `${withHash.length}/${manifestCount}`);
    const sample = manifests[0] || {};
    check(String(sample.display_name || '') !== '' || String(sample.model_id || '') !== '',
      '②c 清单含 model_id / display_name',
      `${String(sample.model_id || '').slice(0, 28)}`);

    /* 清单哈希可独立复算：sha256(model_id:tier:p:c:r:system_prompt_sha256) */
    const recomputed = sha256(
      `${sample.model_id}:${sample.tier}:${sample.prompt_price_per_1k}:` +
      `${sample.completion_price_per_1k}:${sample.royalty_rate}:${sample.system_prompt_sha256}`);
    check(recomputed === String(sample.manifest_sha256 || ''),
      '②d 清单哈希可由公开字段独立复算', `computed=${recomputed.slice(0, 16)}…`);

    /* ═════════════ ③ P0 · 推理响应头带清单哈希 ═════════════ */
    const chat = await fetchRetry(CLOUD_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + buyerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: `${STAMP}：阶段十九造行` }] }),
    });
    check(chat.status === 200, '③a 一次真实推理', `HTTP ${chat.status}`);
    const hdrHash = String(chat.header('x-apipaw-manifest-hash') || '');
    check(isHex64(hdrHash), '③b 响应头 X-APIPaw-Manifest-Hash 存在', `${hdrHash.slice(0, 16)}…`);

    /* ═════════════ ④ P2 · 企业 SLA 路由头 ═════════════ */
    const slaRes = await fetchRetry(CLOUD_URL + '/api/v1/network/sla-pool');
    const sla = await slaRes.json().catch(() => ({}));
    check(slaRes.status === 200 && Number(sla.min_reliability) === 0.95,
      '④a GET /network/sla-pool ⇒ 金牌池门槛 0.95',
      `HTTP ${slaRes.status} min_rel=${sla.min_reliability} gold=${sla.gold_count}`);

    const slaChat = await fetchRetry(CLOUD_URL + '/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + buyerKey,
        'Content-Type': 'application/json',
        'X-APIPaw-SLA-Tier': 'enterprise',
      },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: `${STAMP}：企业档` }] }),
    });
    const slaRouted = String(slaChat.header('x-apipaw-sla-routed') || '');
    check(slaChat.status === 200 && /enterprise_(gold|simulated)/.test(slaRouted),
      '④b 企业档请求返回 SLA 路由头', `X-APIPaw-SLA-Routed=${slaRouted}`);

    /* ═════════════ ⑤ P0 · OWNER 上架 + 导入 PAWMODEL（哈希锁） ═════════════
       ⚠️ 顺序不能换：PAWMODEL 导入绑定的是**已上架模型**
          （「模型 %s 尚未上架，请先走 /owner/models/upsert」），
          所以必须先 upsert 再 import。 */
    let importedManifestHash = '';
    if (OWNER_TOKEN) {
      const upsert = await fetchRetry(CLOUD_URL + '/api/v1/owner/models/upsert', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OWNER_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model_id: IMPORT_MODEL,
          display_name: 'P19 E2E Imported Model',
          tier: 'CREATOR',
          prompt_price_per_1k: 0.0001,
          completion_price_per_1k: 0.0002,
          min_vram_gb: 4,
          royalty_rate: 0.15,
          royalty_mode: 'RATE',
          author_wallet: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
        }),
      });
      check(upsert.status === 200, '⑤a OWNER 上架测试模型', `HTTP ${upsert.status}`);

      const imp = await fetchRetry(CLOUD_URL + '/api/v1/owner/models/import-pawmodel', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OWNER_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: PAWMODEL_CONTENT }),
      });
      const ibody = await imp.json().catch(() => ({}));
      importedManifestHash = String(ibody.manifest?.manifest_sha256 || '');
      check(imp.status === 200 && isHex64(importedManifestHash),
        '⑤b OWNER 导入 PAWMODEL ⇒ 返回清单哈希',
        `HTTP ${imp.status} ${importedManifestHash.slice(0, 16)}…`);

      const mf2 = await fetchRetry(CLOUD_URL + '/api/v1/network/model-manifests');
      const mf2body = await mf2.json().catch(() => ({}));
      const imported = (mf2body.manifests || []).find((m) => m.model_id === IMPORT_MODEL);
      check(!!imported && imported.manifest_sha256 === importedManifestHash,
        '⑤c 导入后的模型出现在公开清单且哈希一致',
        String(imported?.manifest_sha256 || '').slice(0, 16));

      const impDenied = await fetchRetry(CLOUD_URL + '/api/v1/owner/models/import-pawmodel', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + buyerKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: PAWMODEL_CONTENT }),
      });
      check(impDenied.status === 401 || impDenied.status === 403,
        '⑤d 买家调导入端点 ⇒ 被拒', `HTTP ${impDenied.status}`);
    } else {
      warn('⑤a OWNER 上架测试模型', '缺少 APIPAW_OWNER_TOKEN，跳过');
      warn('⑤b OWNER 导入 PAWMODEL ⇒ 返回清单哈希', '缺少 APIPAW_OWNER_TOKEN，跳过');
      warn('⑤c 导入后的模型出现在公开清单且哈希一致', '缺少 APIPAW_OWNER_TOKEN，跳过');
      warn('⑤d 买家调导入端点 ⇒ 被拒', '缺少 APIPAW_OWNER_TOKEN，跳过');
    }

    /* ═════════════ ⑥ P1 · DAO 治理台（公开 + 业主） ═════════════ */
    const daoRes = await fetchRetry(CLOUD_URL + '/api/v1/network/dao/proposals');
    const dao = await daoRes.json().catch(() => ({}));
    check(daoRes.status === 200 && Number(dao.threshold) === 0.66,
      '⑥a GET /network/dao/proposals ⇒ 阈值 0.66',
      `HTTP ${daoRes.status} threshold=${dao.threshold} count=${dao.count}`);

    const daoDenied = await fetchRetry(CLOUD_URL + '/api/v1/owner/dao/propose', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + buyerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '买家越权提案', action_type: 'UPDATE_MODEL_PROMPT', target_id: MODEL }),
    });
    check(daoDenied.status === 401 || daoDenied.status === 403,
      '⑥b 买家调业主提案端点 ⇒ 被拒', `HTTP ${daoDenied.status}`);

    if (OWNER_TOKEN) {
      const propose = await fetchRetry(CLOUD_URL + '/api/v1/owner/dao/propose', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OWNER_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `${STAMP} 阶段十九 E2E 提案`,
          action_type: 'UPDATE_MODEL_PROMPT',
          target_id: IMPORT_MODEL,
          payload: { system_prompt: `DAO 决定的新提示词 ${STAMP}` },
        }),
      });
      const pbody = await propose.json().catch(() => ({}));
      check(propose.status === 200 && !!pbody.proposal_id,
        '⑥c 业主发起提案', `HTTP ${propose.status} ${String(pbody.proposal_id || '')}`);

      const vote = await fetchRetry(CLOUD_URL + '/api/v1/owner/dao/vote', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OWNER_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposal_id: pbody.proposal_id, approve: true }),
      });
      const vbody = await vote.json().catch(() => ({}));
      check(vote.status === 200 && typeof vbody.yes_ratio === 'number',
        '⑥d 业主投票返回赞成率',
        `HTTP ${vote.status} ratio=${vbody.yes_ratio} executed=${vbody.executed}`);
      if (vbody.executed) {
        check(isHex64(String(vbody.execution_hash || '')),
          '⑥e 已执行提案带不可变执行哈希', String(vbody.execution_hash || '').slice(0, 16));
        // 哈希锁跟着治理决定走：执行后清单哈希应当**变了**
        const mf3 = await fetchRetry(CLOUD_URL + '/api/v1/network/model-manifests');
        const mf3body = await mf3.json().catch(() => ({}));
        const after = (mf3body.manifests || []).find((m) => m.model_id === IMPORT_MODEL);
        check(!!after && after.manifest_sha256 !== importedManifestHash,
          '⑥f 治理执行后清单哈希同步更新（哈希锁跟随）',
          `${String(importedManifestHash || '').slice(0, 12)}… → ${String(after?.manifest_sha256 || '').slice(0, 12)}…`);
      } else {
        warn('⑥e 已执行提案带不可变执行哈希', `赞成率 ${vbody.yes_ratio} 未达阈值，未执行`);
        warn('⑥f 治理执行后清单哈希同步更新（哈希锁跟随）', '未执行，跳过');
      }
    } else {
      warn('⑥c 业主发起提案', '缺少 APIPAW_OWNER_TOKEN，跳过');
      warn('⑥d 业主投票返回赞成率', '缺少 APIPAW_OWNER_TOKEN，跳过');
    }

    /* ═════════════ ⑦ P2 · B2B 发票三态 ═════════════ */
    const invJson = await fetchRetry(CLOUD_URL + '/api/v1/user/invoice?format=json', {
      headers: { Authorization: 'Bearer ' + buyerKey },
    });
    const inv = await invJson.json().catch(() => ({}));
    check(invJson.status === 200 && typeof inv.total_recharged_usd === 'number',
      '⑦a 发票 JSON 含充值/消费/余额口径',
      `HTTP ${invJson.status} recharge=$${inv.total_recharged_usd} balance=$${inv.balance_usd}`);
    check(isHex64(String(inv.attestation?.state_root || '')),
      '⑦b 发票带默克尔 State Root 存证',
      String(inv.attestation?.state_root || '').slice(0, 16));

    const invCsv = await fetchRetry(CLOUD_URL + '/api/v1/user/invoice?format=csv', {
      headers: { Authorization: 'Bearer ' + buyerKey },
    });
    const csvText = await invCsv.text();
    check(invCsv.status === 200 && csvText.includes(','),
      '⑦c 发票 CSV 可下载', `HTTP ${invCsv.status} len=${csvText.length}`);

    const invHtml = await fetchRetry(CLOUD_URL + '/api/v1/user/invoice?format=html', {
      headers: { Authorization: 'Bearer ' + buyerKey },
    });
    const htmlText = await invHtml.text();
    check(invHtml.status === 200 && /<html|<!doctype/i.test(htmlText),
      '⑦d 发票 HTML 可打印', `HTTP ${invHtml.status} len=${htmlText.length}`);

    const invDenied = await fetchRetry(CLOUD_URL + '/api/v1/user/invoice?format=json');
    check(invDenied.status === 401, '⑦e 无凭证取发票 ⇒ 401', `HTTP ${invDenied.status}`);

    /* ═════════════ ⑧ P2 · USDT 储值申报 → 审批入账 ═════════════ */
    const declare = await fetchRetry(CLOUD_URL + '/api/v1/user/deposit/declare', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + buyerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: TX_HASH, network: 'TRC20', amount_usd: 12.5 }),
    });
    const dbody = await declare.json().catch(() => ({}));
    depositId = Number(dbody.deposit_id || 0);
    check(declare.status === 200 && depositId > 0,
      '⑧a 买家申报 USDT 储值成功', `HTTP ${declare.status} id=${depositId}`);

    const dupe = await fetchRetry(CLOUD_URL + '/api/v1/user/deposit/declare', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + buyerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: TX_HASH, network: 'TRC20', amount_usd: 12.5 }),
    });
    check(dupe.status === 409, '⑧b 同一 tx_hash 重复申报 ⇒ 409', `HTTP ${dupe.status}`);

    const badTx = await fetchRetry(CLOUD_URL + '/api/v1/user/deposit/declare', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + buyerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tx_hash: '0xdeadbeef', network: 'TRC20', amount_usd: 1 }),
    });
    check(badTx.status === 400, '⑧c 非法 tx_hash ⇒ 400', `HTTP ${badTx.status}`);

    const decideDenied = await fetchRetry(CLOUD_URL + `/api/v1/owner/deposit/${depositId}/decide`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + buyerKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve: true }),
    });
    check(decideDenied.status === 401 || decideDenied.status === 403,
      '⑧d 买家调审批端点 ⇒ 被拒', `HTTP ${decideDenied.status}`);

    if (OWNER_TOKEN && depositId > 0) {
      const decide = await fetchRetry(CLOUD_URL + `/api/v1/owner/deposit/${depositId}/decide`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + OWNER_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ approve: true }),
      });
      const jbody = await decide.json().catch(() => ({}));
      check(decide.status === 200 && String(jbody.status || '') === 'APPROVED',
        '⑧e 业主批准 ⇒ 申报入账', `HTTP ${decide.status} status=${jbody.status} $${jbody.amount_usd}`);
    } else {
      warn('⑧e 业主批准 ⇒ 申报入账', '缺少 APIPAW_OWNER_TOKEN，跳过');
    }

    /* ═════════════ ⑨ UI · 买家视角 ═════════════ */
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

    check((await page.locator('[data-testid="dao-enterprise-card"]').count()) > 0,
      '⑨a 🏛️ DAO / 企业卡已渲染', '');
    const invText = await waitForText(page, 'invoice-summary', '累计充值|推理消费', 60000);
    check(/累计充值|推理消费/.test(invText), '⑨b 发票 KPI 已渲染',
      invText.replace(/\s+/g, ' ').slice(0, 80));
    const rootText = await waitForText(page, 'invoice-state-root', '[0-9a-f]{8}', 45000);
    check(/root\s+[0-9a-f]{8}/i.test(rootText), '⑨c 发票 State Root 已渲染',
      rootText.replace(/\s+/g, ' ').slice(0, 60));
    check((await page.locator('[data-testid="manifest-row-qwen2.5:0.5b"]').count()) > 0
      || (await page.locator('[data-testid^="manifest-row-"]').count()) > 0,
      '⑨d 模型清单指纹行已渲染', '');
    check((await page.locator('[data-testid="invoice-csv-btn"]').count()) > 0
      && (await page.locator('[data-testid="invoice-html-btn"]').count()) > 0,
      '⑨e CSV / HTML 导出按钮已渲染', '');
    check((await page.locator('[data-testid="deposit-declare-btn"]').count()) > 0,
      '⑨f USDT 申报入口已渲染', '');
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase19-dao-card.png'), fullPage: false })
      .catch(() => {});

    /* ═════════════ ⑩ UI · 业主视角（治理台 + 审批台） ═════════════ */
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
      await clickSafe(toOwner, '⑩a 切到业主视角');
      await sleep(2500);
    }
    const govTab = page.locator('[data-testid="host-tab-GOVERNANCE"]');
    if ((await govTab.count()) > 0) {
      await clickSafe(govTab.first(), '⑩b 进入节点治理页');
      await sleep(4000);
    }
    check((await page.locator('[data-testid="pawmodel-input"]').count()) > 0,
      '⑩c 业主侧 PAWMODEL 导入框已渲染', '');
    check((await page.locator('[data-testid="dao-propose-btn"]').count()) > 0,
      '⑩d 业主侧提案入口已渲染', '');
    check((await page.locator('[data-testid="dao-enterprise-card"]').count()) > 0,
      '⑩e 业主侧治理卡已渲染', '');
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase19-governance.png'), fullPage: false })
      .catch(() => {});

    /* ═════════════ ⑪ 双站 Gzip ═════════════ */
    await checkGzip(BASE_URL, 'console');
    await checkGzip(POCKET_URL, 'pocket');
  } catch (e) {
    bad('阶段十九 E2E', e && e.message ? e.message : String(e));
  } finally {
    const passed = results.filter((r) => r.pass && !r.soft).length;
    const soft = results.filter((r) => r.soft).length;
    const report = {
      stamp: STAMP,
      buyerHandle,
      buyerKeyMasked: maskKey(buyerKey),
      deposit_id: depositId,
      manifest_count: manifestCount,
      imported_model: IMPORT_MODEL,
      tx_hash: TX_HASH,
      passed,
      total: results.length,
      soft,
      results: redactDeep(results),
      pageErrors,
    };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
    console.log('');
    console.log(`===== 阶段十九 P0~P3 · 线上 E2E：${passed}/${results.length} 通过（软告警 ${soft}）=====`);
    console.log(`报告：${REPORT}`);
    console.log(`清理请用：ops_ctl.py cleanup --account ${buyerHandle} --deposit-since <ts> --dao-since <ts> --model-id ${IMPORT_MODEL}`);
    await browser.close();
    process.exit(passed === results.length ? 0 : 1);
  }
})();
