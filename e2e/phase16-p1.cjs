/**
 * 阶段十六 P0~P3 · 线上验收
 *   ① P0 乐观锁（防「后写覆盖先写」）：
 *      - API 级：用**过期**的 expected_updated_at 提交 ⇒ 409 version_conflict，
 *        且样本正文**分毫未改**；
 *      - UI 级：点「✏ 编辑」打开表单 ⇒ 期间由旁路改掉同一条 ⇒ 点「保存」
 *        ⇒ 前端必须提示「已被他人修改（并发冲突）」，**不许**静默覆盖。
 *   ② P2 进化前后 A/B 智商对比评测台：
 *      业主视角一键运行 ⇒ 看板显示 Baseline / Evolved 通过率与「+提升%」，
 *      且因为本次验收特意策展了一条**同题**黄金记忆 ⇒ Evolved 必须高于 Baseline。
 *   ③ A/B 评测**恒不写库**（跑之前/之后的语料池条数必须一致）。
 *   ④ P3 双站 Gzip < 450KB（console + pocket）。
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules \
 *   APIPAW_OWNER_PASSKEY='AP-xxxx' node e2e/phase16-p1.cjs
 *
 * ⚠️ 本机直连 cloud.apipaw.com / console.apipaw.com 被墙 ⇒ 走本地 SOCKS5
 *    （127.0.0.1:1080）：浏览器用 --proxy-server，node 侧 fetch 走 curl 代理壳。
 *
 * 产物：e2e/shots/phase16-*.png + e2e/phase16-report.json
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
const OWNER_PASSKEY = process.env.APIPAW_OWNER_PASSKEY || '';
const SOCKS = process.env.APIPAW_SOCKS || '127.0.0.1:1080';
const SHOT_DIR = path.join(__dirname, 'shots');
const REPORT = path.join(__dirname, 'phase16-report.json');
const T = {
  nav: Number(process.env.APIPAW_E2E_NAV_TIMEOUT || 120000),
  app: Number(process.env.APIPAW_E2E_APP_TIMEOUT || 180000),
  mount: Number(process.env.APIPAW_E2E_MOUNT_TIMEOUT || 150000),
  action: Number(process.env.APIPAW_E2E_ACTION_TIMEOUT || 30000),
  api: Number(process.env.APIPAW_E2E_API_TIMEOUT || 150000),
};

/* ────────────────────────── SOCKS5 fetch 壳 ────────────────────────── */
// 直连被墙 ⇒ 用 curl --socks5-hostname 出站，返回一个 Response 形状的对象。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p16curl-'));
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
    //    导致服务端 "error parsing the body" ⇒ 请求体一律落临时文件再 @file 传入
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

/** 带重试的 fetch（CF 5xx / 抖动重试） */
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

/** 取 localStorage 里的钱包会话 JWT（业主接口直连用） */
async function ownerSessionToken(page) {
  try {
    const raw = await page.evaluate(() => localStorage.getItem('apipaw.session'));
    if (!raw) return '';
    const obj = JSON.parse(raw);
    return obj && obj.token ? String(obj.token) : '';
  } catch (e) {
    return '';
  }
}

/** P3-① Gzip 实测：抓 HTML → 找 bundle → 带 Accept-Encoding: gzip 取回 */
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
      ok('① 控制台首屏挂载', `尝试 ${attempt} 次`);
    } catch (e) {
      lastErr = e;
      console.log(`  [retry] 第 ${attempt} 次挂载失败：${String(e.message).split('\n')[0]}`);
      try { await page.waitForTimeout(3000); } catch (_) {}
    }
  }
  if (!mounted) throw lastErr;
}

/** 轮询等待页面上的提示文案 */
/** 等待卡片「操作级错误」横幅（阶段十六 P0 修复后不再是顶掉主体的 load 错误） */
async function waitForActionError(page, pattern, timeoutMs) {
  const re = new RegExp(pattern);
  const limit = timeoutMs || 60000;
  let text = '';
  for (let i = 0; i < Math.ceil(limit / 1000); i++) {
    text = (await page
      .locator('[data-testid="golden-dataset-error"]')
      .first()
      .innerText()
      .catch(() => '')) || '';
    if (re.test(text)) return text;
    await sleep(1000);
  }
  return text;
}

async function waitForNotice(page, pattern, timeoutMs) {
  const re = new RegExp(pattern);
  const limit = timeoutMs || 60000;
  let text = '';
  for (let i = 0; i < Math.ceil(limit / 1000); i++) {
    text = (await page
      .locator('[data-testid="golden-dataset-notice"]')
      .first()
      .innerText()
      .catch(() => '')) || '';
    if (re.test(text)) return text;
    await sleep(1000);
  }
  return text;
}

/* 本次验收的唯一标记 */
const STAMP = `P16E2E${Date.now().toString(36).toUpperCase()}`;
// ⚠️ 策展件的**题面**必须与自定义考题的**题面**高度相似 ⇒ 黄金召回才能命中
//    （召回口径：token Jaccard 0.6 + 字符 3-gram Jaccard 0.4，Top-2）
const SHARED_PROMPT = `${STAMP}：请说明 APIPaw 的「算力节点收益提现」是怎么结算的？`;
const GOLDEN_ANSWER = `${STAMP}：算力节点收益提现按 revenue_ledger 的节点分成结算，业主审批后通过链上 PAW 通道打款到收款钱包。`;
const TASK_TITLE = `${STAMP} 提现结算探针`;
const TASK_MUST = 'revenue_ledger';

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

  let curatedRequestId = '';
  let customTaskId = '';
  let sampleId = '';
  let corpusBefore = 0;
  let corpusAfter = 0;

  try {
    if (!OWNER_PASSKEY) bad('② 管理口令解锁', '缺少环境变量 APIPAW_OWNER_PASSKEY');
    await mount(page);

    // 首屏若无 API Key 会自动弹出密钥弹窗，其遮罩会拦截所有点击 ⇒ 先关掉
    if ((await page.locator('#apx-modal').count()) > 0) {
      const cancelBtn = page.locator('#apx-modal-card').getByText('取消', { exact: true });
      if ((await cancelBtn.count()) > 0) {
        await cancelBtn.first().click({ timeout: 8000 }).catch(() => {});
      }
      await sleep(800);
      check((await page.locator('#apx-modal').count()) === 0, '①b 自动弹出的密钥弹窗已关闭', '');
    }

    // ================= 业主通道 =================
    await clickSafe(page.locator('[data-testid="open-passkey-modal"]').first(), '②a 打开口令解锁弹窗');
    await sleep(1000);
    check((await page.locator('[data-testid="owner-passkey-input"]').count()) > 0, '②a 口令弹窗已渲染', '');
    await page.locator('[data-testid="owner-passkey-input"]').first().fill(OWNER_PASSKEY);
    await clickSafe(page.locator('[data-testid="owner-passkey-btn"]').first(), '②b 提交口令');
    try {
      await page.waitForSelector('[data-testid="owner-passkey-ok"]', { timeout: T.api });
      const okText = (await page.locator('[data-testid="owner-passkey-ok"]').first().innerText()).trim();
      check(/已解锁 OWNER/.test(okText), '② 管理口令解锁成功', okText);
    } catch (e) {
      const errSel = page.locator('[data-testid="owner-passkey-error"]');
      bad('② 管理口令解锁',
        (await errSel.count()) > 0
          ? `前端报错：${(await errSel.first().innerText()).trim()}`
          : `未出现结果提示: ${e.message}`);
    }
    await sleep(1500);
    await clickSafe(page.locator('[data-testid="passkey-modal-close"]').first(), '②c 关闭口令弹窗');
    await sleep(1500);

    const toOwner = byText(page, '切换至业主视角');
    if ((await toOwner.count()) > 0) {
      await clickSafe(toOwner, '②d 切到业主视角');
      await sleep(2500);
    }
    check((await page.locator('[data-testid="host-tabs"]').count()) > 0, '②d 业主分段导航已出现', '');

    await clickSafe(page.locator('[data-testid="host-tab-STUDIO"]').first(), '③a 进入模型工作台');
    await sleep(3000);
    check((await page.locator('[data-testid="golden-dataset-card"]').count()) > 0, '③a 黄金语料工坊卡片已渲染', '');

    const token = await ownerSessionToken(page);
    check(!!token, '③b 拿到业主会话 token', token ? '已拿到' : '未拿到');

    // ---------- 语料池基线条数（A/B 评测恒不写库 的对照）----------
    if (token) {
      const res = await fetchRetry(CLOUD_URL + '/api/v1/owner/datasets/summary', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const body = await res.json().catch(() => ({}));
      corpusBefore = Number(body.total || 0);
    }

    // ---------- ④ 录入策展件（题面与考题同文 ⇒ 可被召回）----------
    await clickSafe(page.locator('[data-testid="golden-dataset-curate-toggle"]').first(), '④a 展开「手工录入黄金记忆」');
    await sleep(600);
    check((await page.locator('[data-testid="golden-dataset-curate-form"]').count()) > 0, '④a 策展表单已展开', '');
    await page.locator('[data-testid="golden-dataset-curate-prompt"]').first().fill(SHARED_PROMPT);
    await page.locator('[data-testid="golden-dataset-curate-completion"]').first().fill(GOLDEN_ANSWER);
    await page.locator('[data-testid="golden-dataset-curate-model"]').first().fill('qwen2.5:0.5b');
    await sleep(300);
    await clickSafe(page.locator('[data-testid="golden-dataset-curate-save"]').first(), '④b 保存策展件');
    const noticeText = await waitForNotice(page, '已录入黄金记忆\\s*curated:', 90000);
    check(/已录入黄金记忆\s*curated:/.test(noticeText), '④b 策展件已录入（curated: request_id）',
      noticeText.replace(/\s+/g, ' ').slice(0, 90));
    const ridMatch = noticeText.match(/curated:[0-9a-f]+/i);
    curatedRequestId = ridMatch ? ridMatch[0] : '';
    check(!!curatedRequestId, '④c 拿到策展件 request_id', curatedRequestId || '(未解析到)');

    // ---------- ⑤ 新增自定义考题（题面同文，must_contain 落在黄金答案里）----------
    await clickSafe(page.locator('[data-testid="golden-dataset-rlaif-task-toggle"]').first(), '⑤a 展开「添加自定义验算题」');
    await sleep(600);
    check((await page.locator('[data-testid="golden-dataset-rlaif-task-form"]').count()) > 0, '⑤a 自定义考题表单已展开', '');
    await page.locator('[data-testid="golden-dataset-rlaif-task-title"]').first().fill(TASK_TITLE);
    await page.locator('[data-testid="golden-dataset-rlaif-task-prompt"]').first().fill(SHARED_PROMPT);
    await page.locator('[data-testid="golden-dataset-rlaif-task-must"]').first().fill(TASK_MUST);
    await page.locator('[data-testid="golden-dataset-rlaif-task-minlength"]').first().fill('4');
    await sleep(300);
    await clickSafe(page.locator('[data-testid="golden-dataset-rlaif-task-save"]').first(), '⑤b 保存自定义考题');
    const taskNotice = await waitForNotice(page, '已新增自定义考题\\s*custom-', 90000);
    check(/已新增自定义考题\s*custom-/.test(taskNotice), '⑤b 自定义考题已入库（custom- task_id）',
      taskNotice.replace(/\s+/g, ' ').slice(0, 90));
    const tidMatch = taskNotice.match(/custom-[0-9a-f]+/i);
    customTaskId = tidMatch ? tidMatch[0] : '';
    check(!!customTaskId, '⑤c 拿到自定义考题 task_id', customTaskId || '(未解析到)');

    // 刷新题库 + 找到策展件那一行的 id（用于点「✏ 编辑」）
    await clickSafe(page.locator('[data-testid="golden-dataset-refresh"]').first(), '⑥a 刷新语料工坊');
    await sleep(3000);
    if (token && curatedRequestId) {
      const res = await fetchRetry(CLOUD_URL + '/api/v1/owner/datasets/summary', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const body = await res.json().catch(() => ({}));
      const recent = Array.isArray(body.recent) ? body.recent : [];
      const hit = recent.find((r) => String(r.request_id || '') === curatedRequestId);
      if (hit) sampleId = String(hit.id || '');
      check(!!hit && Number(hit.is_golden) === 1, '⑥b 策展件已进黄金池（is_golden=1）',
        `HTTP ${res.status} golden=${body.golden} hit=${!!hit} id=${sampleId}`);
    }

    // ---------- ⑥ 一键运行 A/B 对比评测（UI）----------
    // 基线条数必须在**跑评测之前**重采一次（④ 刚新增了一条策展件，不能计入对照）
    if (token) {
      const res = await fetchRetry(CLOUD_URL + '/api/v1/owner/datasets/summary', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const body = await res.json().catch(() => ({}));
      corpusBefore = Number(body.total || 0);
    }
    check((await page.locator('[data-testid="golden-dataset-benchmark-panel"]').count()) > 0,
      '⑥c A/B 评测面板已渲染', '');
    await clickSafe(page.locator('[data-testid="golden-dataset-benchmark-run"]').first(), '⑥d 一键运行 A/B 对比评测');
    const benchShown = await page
      .waitForSelector('[data-testid="golden-dataset-benchmark-result"]', { timeout: 240000 })
      .then(() => true)
      .catch(() => false);
    check(benchShown, '⑥d A/B 对比看板已出现', benchShown ? '已出现' : '超时');
    if (benchShown) {
      const base = (await page.locator('[data-testid="golden-dataset-benchmark-baseline"]').first().innerText().catch(() => '')) || '';
      const evo = (await page.locator('[data-testid="golden-dataset-benchmark-evolved"]').first().innerText().catch(() => '')) || '';
      const delta = (await page.locator('[data-testid="golden-dataset-benchmark-delta"]').first().innerText().catch(() => '')) || '';
      const baseN = parseFloat(base.replace('%', ''));
      const evoN = parseFloat(evo.replace('%', ''));
      const deltaN = parseFloat(String(delta).replace('+', '').replace('%', ''));
      check(/%\s*$/.test(base.trim()) && !Number.isNaN(baseN), '⑥e 看板显示 Baseline 通过率', base.trim());
      check(/%\s*$/.test(evo.trim()) && !Number.isNaN(evoN), '⑥f 看板显示 Evolved 通过率', evo.trim());
      check(String(delta).includes('%') && !Number.isNaN(deltaN), '⑥g 看板显示提升百分比', delta.trim());
      check(!Number.isNaN(evoN) && !Number.isNaN(baseN) && evoN > baseN,
        '⑥h Evolved 通过率 > Baseline（黄金记忆真的救活了题目）',
        `baseline=${base.trim()} evolved=${evo.trim()} delta=${delta.trim()}`);
      check(!Number.isNaN(deltaN) && deltaN > 0, '⑥i 提升百分比为正', delta.trim());
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase16-01-benchmark.png'), fullPage: false });
    }

    // ---------- ⑥j A/B 评测恒不写库 ----------
    if (token) {
      const res = await fetchRetry(CLOUD_URL + '/api/v1/owner/datasets/summary', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const body = await res.json().catch(() => ({}));
      corpusAfter = Number(body.total || 0);
      check(corpusAfter === corpusBefore, '⑥j A/B 评测未写库（语料池条数不变）',
        `before=${corpusBefore} after=${corpusAfter}`);
    }

    // ---------- ⑦ API 级乐观锁：过期 expected_updated_at ⇒ 409 ----------
    if (token && curatedRequestId) {
      const stale = 1.0; // 明显早于库里任何 updated_at ⇒ 必冲突
      const res = await fetchRetry(CLOUD_URL + '/api/v1/owner/datasets/golden-upsert', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          request_id: curatedRequestId,
          prompt_text: SHARED_PROMPT,
          completion_text: '【不该被写入的正文】',
          model_id: 'qwen2.5:0.5b',
          expected_updated_at: stale,
        }),
      });
      const body = await res.json().catch(() => ({}));
      const code = (body && body.detail && body.detail.code) || body.code || '';
      check(res.status === 409 && String(code).includes('version_conflict'),
        '⑦a 过期乐观锁 ⇒ 409 version_conflict', `HTTP ${res.status} ${JSON.stringify(body).slice(0, 160)}`);
      // 复核：正文没被改写
      const res2 = await fetchRetry(CLOUD_URL + '/api/v1/owner/datasets/summary', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const body2 = await res2.json().catch(() => ({}));
      const hit = (body2.recent || []).find((r) => String(r.request_id || '') === curatedRequestId);
      check(!!hit && String(hit.completion_text || '').indexOf('【不该被写入的正文】') < 0,
        '⑦b 冲突后正文未被改写', hit ? String(hit.completion_text || '').slice(0, 60) : '(未找到)');
    }

    // ---------- ⑧ UI 级乐观锁：编辑期间被人改掉 ⇒ 保存必须报冲突 ----------
    if (sampleId) {
      await clickSafe(page.locator(`[data-testid="golden-dataset-row-edit-${sampleId}"]`).first(), '⑧a 点「✏ 编辑」');
      await sleep(1200);
      check((await page.locator('[data-testid="golden-dataset-curate-editing"]').count()) > 0,
        '⑧a 编辑横幅已出现（携带乐观锁基准）', '');
      // 旁路：直接改库（走 API，正确 updated_at）⇒ 把 updated_at 顶到未来
      if (token) {
        const res0 = await fetchRetry(CLOUD_URL + '/api/v1/owner/datasets/summary', {
          headers: { Authorization: 'Bearer ' + token },
        });
        const b0 = await res0.json().catch(() => ({}));
        const hit0 = (b0.recent || []).find((r) => String(r.request_id || '') === curatedRequestId);
        const curUpdated = Number((hit0 && hit0.updated_at) || 0);
        const res1 = await fetchRetry(CLOUD_URL + '/api/v1/owner/datasets/golden-upsert', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            request_id: curatedRequestId,
            prompt_text: SHARED_PROMPT,
            completion_text: GOLDEN_ANSWER + '（旁路改动）',
            model_id: 'qwen2.5:0.5b',
            expected_updated_at: curUpdated,
          }),
        });
        check(res1.status === 200, '⑧b 旁路改动成功（updated_at 前进）', `HTTP ${res1.status}`);
      }
      // UI 保存 ⇒ 必须报冲突
      await page.locator('[data-testid="golden-dataset-curate-completion"]').first().fill(GOLDEN_ANSWER + '（我的编辑）');
      await sleep(300);
      await clickSafe(page.locator('[data-testid="golden-dataset-curate-save"]').first(), '⑧c 点保存（应冲突）');
      const errText = await waitForActionError(page, '并发冲突', 30000);
      check(/并发冲突/.test(errText),
        '⑧d UI 提示「已被他人修改（并发冲突）」',
        (errText || '(无提示)').replace(/\s+/g, ' ').slice(0, 90));
      // 冲突时卡片主体（表单 + 列表）必须仍在，用户才能「刷新后重试」
      check((await page.locator('[data-testid="golden-dataset-curate-form"]').count()) > 0,
        '⑧d-2 冲突后卡片主体未被错误文案顶掉（可继续编辑）', '');
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase16-02-conflict.png'), fullPage: false });

      // ⑧e 取消编辑 → 重新编辑（拿到新的 updated_at）⇒ 正常保存成功
      await clickSafe(page.locator('[data-testid="golden-dataset-curate-cancel-edit"]').first(), '⑧e 取消编辑');
      await sleep(800);
      // 列表里的 updated_at 是「加载时」的快照 ⇒ 必须先刷新列表，再重新编辑
      await clickSafe(page.locator('[data-testid="golden-dataset-refresh"]').first(), '⑧f-0 刷新列表（取最新 updated_at）');
      await sleep(3000);
      await clickSafe(page.locator(`[data-testid="golden-dataset-row-edit-${sampleId}"]`).first(), '⑧f 重新点「✏ 编辑」');
      await sleep(1200);
      await page.locator('[data-testid="golden-dataset-curate-completion"]').first().fill(GOLDEN_ANSWER + '（正常编辑）');
      await sleep(300);
      await clickSafe(page.locator('[data-testid="golden-dataset-curate-save"]').first(), '⑧g 点保存（应成功）');
      const okNotice = await waitForNotice(page, '已录入黄金记忆|已更新|成功', 60000);
      check(/已录入黄金记忆|已更新|成功/.test(okNotice) && !/并发冲突/.test(okNotice),
        '⑧h 用最新 updated_at 保存 ⇒ 成功放行', okNotice.replace(/\s+/g, ' ').slice(0, 90));
    } else {
      warn('⑧ UI 级乐观锁', '没拿到策展件行 id（summary 未命中）');
    }

    // ---------- ⑨ 自定义考题的乐观锁（API 级）----------
    if (token && customTaskId) {
      const res = await fetchRetry(CLOUD_URL + '/api/v1/owner/rlaif/tasks', {
        headers: { Authorization: 'Bearer ' + token },
      });
      const body = await res.json().catch(() => ({}));
      const tasks = Array.isArray(body.tasks) ? body.tasks : [];
      const mine = tasks.find((t) => String(t.id || '') === customTaskId);
      check(!!mine && typeof mine.updated_at === 'number' && mine.updated_at > 0,
        '⑨a 自定义考题带 updated_at（乐观锁基准）',
        mine ? `updated_at=${mine.updated_at}` : '(未找到)');
      if (mine) {
        const res2 = await fetchRetry(CLOUD_URL + '/api/v1/owner/rlaif/tasks', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task_id: customTaskId,
            title: TASK_TITLE,
            prompt: '【不该被写入的题面】',
            must_contain: ['ZZZ_不可能命中'],
            min_length: 4,
            expected_updated_at: 1.0,
          }),
        });
        const b2 = await res2.json().catch(() => ({}));
        const code = (b2 && b2.detail && b2.detail.code) || b2.code || '';
        check(res2.status === 409 && String(code).includes('version_conflict'),
          '⑨b 过期乐观锁改考题 ⇒ 409 version_conflict',
          `HTTP ${res2.status} ${JSON.stringify(b2).slice(0, 160)}`);
        const res3 = await fetchRetry(CLOUD_URL + '/api/v1/owner/rlaif/tasks', {
          headers: { Authorization: 'Bearer ' + token },
        });
        const b3 = await res3.json().catch(() => ({}));
        const mine2 = (b3.tasks || []).find((t) => String(t.id || '') === customTaskId);
        check(!!mine2 && String(mine2.prompt_text || '').indexOf('【不该被写入的题面】') < 0,
          '⑨c 冲突后题面未被改写', mine2 ? String(mine2.prompt_text || '').slice(0, 50) : '(未找到)');
        // 正确值 ⇒ 放行
        const res4 = await fetchRetry(CLOUD_URL + '/api/v1/owner/rlaif/tasks', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            task_id: customTaskId,
            title: TASK_TITLE,
            prompt: SHARED_PROMPT,
            must_contain: [TASK_MUST],
            min_length: 4,
            expected_updated_at: mine.updated_at,
          }),
        });
        check(res4.status === 200, '⑨d 正确 updated_at ⇒ 改考题放行（修掉 UPDATE 绑定 bug）',
          `HTTP ${res4.status}`);
      }
    }

    // ---------- ⑩ 双站 Gzip ----------
    await checkGzip(BASE_URL, 'console');
    await checkGzip(POCKET_URL, 'pocket');
  } catch (e) {
    bad('阶段十六 E2E', e && e.message ? e.message : String(e));
  } finally {
    const passed = results.filter((r) => r.pass && !r.soft).length;
    const soft = results.filter((r) => r.soft).length;
    const report = {
      stamp: STAMP,
      curatedRequestId,
      customTaskId,
      corpusBefore,
      corpusAfter,
      passed,
      total: results.length,
      soft,
      results: redactDeep(results),
      pageErrors,
    };
    fs.writeFileSync(REPORT, JSON.stringify(report, null, 2), 'utf8');
    console.log('');
    console.log(`===== 阶段十六 P0~P3 · 线上 E2E：${passed}/${results.length} 通过（软告警 ${soft}）=====`);
    console.log(`报告：${REPORT}`);
    await browser.close();
    process.exit(passed === results.length ? 0 : 1);
  }
})();
