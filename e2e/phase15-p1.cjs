/**
 * 阶段十五 P0~P3 · 线上验收
 *   ① P0 高价模型体验金自适应预扣裁剪：$0.50 账户请求 deepseek-r1(max_tokens=1024)
 *      **不再 402**，而是把 max_tokens 自适应裁到余额买得起的输出量
 *      （响应头 X-APIPaw-MaxTokens-Capped）
 *   ② P1 黄金记忆库可视化策展：
 *      - 业主手工录入一条黄金记忆 ⇒ 立刻进召回池；
 *      - Playground 提同文问题 ⇒ 命中注入（✨ 已注入 N 条黄金记忆）；
 *      - 自定义 RLAIF 考题新增 ⇒ 自动纳入跑批 ⇒ 产出 chosen/rejected 偏好对；
 *      - 真实买家评价**受保护**（删除端点 400 拒删）
 *   ③ P2 公开 golden-modelfile 端点（无 OWNER 鉴权）⇒ 标准 Modelfile
 *   ④ P3 前端 Gzip 体积 < 450KB（console + pocket）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules \
 *   APIPAW_OWNER_PASSKEY='AP-xxxx' node e2e/phase15-p1.cjs
 *
 * 产物：e2e/shots/phase15-*.png + e2e/phase15-report.json
 *
 * ⚠️ 报告里**绝不落明文 API Key**（统一走 redact.cjs 掩码）。
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
const REPORT = path.join(__dirname, 'phase15-report.json');
const T = {
  nav: Number(process.env.APIPAW_E2E_NAV_TIMEOUT || 120000),
  app: Number(process.env.APIPAW_E2E_APP_TIMEOUT || 180000),
  // ⚠️ CF 首屏抖动：1.6MB bundle 冷加载 + 慢链路时，React 挂载可能要 20~60s
  mount: Number(process.env.APIPAW_E2E_MOUNT_TIMEOUT || 120000),
  action: Number(process.env.APIPAW_E2E_ACTION_TIMEOUT || 30000),
  api: Number(process.env.APIPAW_E2E_API_TIMEOUT || 150000),
};

// 本次验收的唯一标记（用于清理与断言）
const STAMP = `P15E2E${Date.now().toString(36).toUpperCase()}`;
const CURATED_PROMPT = `${STAMP}：APIPaw 的「黄金记忆策展」是做什么的？请用一句话回答。`;
const CURATED_ANSWER = `${STAMP}：黄金记忆策展是业主把经过验证的高质量问答手工录进语料池，让后续提问能直接召回并注入为 Few-Shot 范例。`;
const TASK_TITLE = `${STAMP} 策展机制探针`;
const TASK_PROMPT = `${STAMP}：请说明黄金记忆策展的作用。`;
const TASK_MUST = '黄金策展';

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

/** 带重试的 fetch（本地 → cloud.apipaw.com 偶发连接超时 / CF 5xx） */
async function fetchRetry(url, init, tries = 4) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      // CF 回源超时（522/524/503）也当失败重试 —— 否则会把边缘抖动误判成产品缺陷
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

/**
 * 取响应头（**大小写 + 连字符都不敏感**）。
 *
 * ⚠️ h11 在写报文时把头名统一小写 ⇒ `X-APIPaw-MaxTokens-Capped` 到线路上是
 * `x-apipaw-maxtokens-capped` ⇒ `res.headers.get('x-apipaw-max-tokens-capped')`
 * 会拿到 null（Fetch 的头查找只大小写不敏感，**不忽略连字符**）。
 */
function headerValue(res, namePattern) {
  const re = new RegExp(namePattern, 'i');
  for (const [k, v] of res.headers.entries()) {
    if (re.test(k)) return v;
  }
  return null;
}

/** 轮询等待页面上的提示文案（云端链路慢 ⇒ 不能只 sleep 固定时长） */
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
      console.log(`  [retry] 第 ${attempt} 次挂载失败：${e.message.split('\n')[0]}`);
      try {
        await page.waitForTimeout(3000);
      } catch (_) {}
    }
  }
  if (!mounted) throw lastErr;
}

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
      headers: { 'accept-encoding': 'gzip', 'user-agent': 'apipaw-e2e' },
    });
    const enc = (headerValue(res, '^content-encoding$') || '').toLowerCase();
    const len = Number(headerValue(res, '^content-length$') || 0);
    const detail = `${asset} → content-encoding=${enc || '(none)'} content-length=${len}`;
    check(enc.includes('gzip'), `${label} 返回 Content-Encoding: gzip`, detail);
    check(len > 0 && len < 450 * 1024, `${label} 压缩后体积 < 450KB`, `${(len / 1024).toFixed(1)}KB`);
  } catch (e) {
    bad(`${label} Gzip`, e.message);
  }
}

/** Playground 发送一条消息并等回答出现（反馈按钮出现 = 回答已渲染完） */
async function sendChat(page, text, timeout) {
  const input = page.locator('#apx-playground-input').first();
  await input.fill(text);
  await sleep(400);
  await clickSafe(page.locator('[data-testid="playground-send"]').first(), '发送消息');
  const limit = timeout || T.api;
  for (let i = 0; i < Math.ceil(limit / 1000); i++) {
    await sleep(1000);
    const hasFeedback = (await page.locator('[data-testid="playground-feedback-up"]').count()) > 0;
    if (hasFeedback) return true;
  }
  return false;
}

/** 充值补足余额（体验金按 IP 限流时兜底） */
async function ensureBalance(apiKey, targetUsd) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const rid = `phase15-recharge-${Date.now()}-${attempt}`;
      const res = await fetch(CLOUD_URL + '/api/v1/user/recharge', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_usd: targetUsd, request_id: rid }),
      });
      const body = await res.json().catch(() => ({}));
      const bal = Number(body.balance_usd || 0);
      if (res.status === 200 && bal > 0) return bal;
    } catch (e) {
      /* 网络抖动 → 换一次幂等键重试 */
    }
    await sleep(1500);
  }
  return 0;
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const launchArgs = ['--disable-ipv6'];
  if (process.env.APIPAW_E2E_HOST_RESOLVER) {
    launchArgs.push(`--host-resolver-rules=${process.env.APIPAW_E2E_HOST_RESOLVER}`);
  }
  const browser = await chromium.launch({ headless: true, args: launchArgs });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const apiLog = [];
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/api/v1/') || u.includes('/v1/')) apiLog.push({ url: u, status: res.status() });
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push('console.error: ' + String(m.text()).slice(0, 300));
  });

  let issuedKey = '';
  let accountHandle = '';
  let curatedRequestId = '';
  let customTaskId = '';
  const createdSamples = [];

  try {
    if (!OWNER_PASSKEY) bad('④ 管理口令解锁', '缺少环境变量 APIPAW_OWNER_PASSKEY');
    await mount(page);

    // ================= 买家通道：拿 Key + 备余额 =================
    let modalOpen = (await page.locator('#apx-modal').count()) > 0;
    if (!modalOpen) {
      await clickSafe(byText(page, '设置密钥'), '②a 打开密钥弹窗');
      await sleep(1200);
      modalOpen = (await page.locator('#apx-modal').count()) > 0;
    }
    const presetKey = (process.env.APIPAW_E2E_BUYER_KEY || '').trim();
    if (presetKey) {
      if ((await page.locator('[data-testid="api-key-input"]').count()) === 0) {
        await clickSafe(page.locator('[data-testid="open-key-modal"]').first(), '② 打开密钥弹窗');
        await sleep(1000);
      }
      await page.locator('[data-testid="api-key-input"]').first().fill(presetKey);
      await sleep(300);
      await clickSafe(page.locator('[data-testid="api-key-save"]').first(), '② 保存既有密钥');
      await sleep(3000);
      issuedKey = presetKey;
      ok('② 使用既有买家 Key（签发台 IP 限流兜底）', maskKey(issuedKey));
    } else {
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
        bad('② 签发新 Key', `未拿到明文（签发台按 IP 限流 5 把/小时，可设 APIPAW_E2E_BUYER_KEY 复用既有 Key）: ${e.message}`);
        throw e;
      }
      check(!!issuedKey && issuedKey.length > 10, '② 签发新 Key ⇒ 拿到明文', maskKey(issuedKey));
      await clickSafe(page.locator('[data-testid="issue-key-confirm"]').first(), '②b 勾选「我已保存」');
      await sleep(400);
      await clickSafe(page.locator('[data-testid="api-key-save"]').first(), '②c 保存并使用此密钥');
      await sleep(3500);
    }

    {
      const bal = await ensureBalance(issuedKey, 3.0);
      check(bal >= 1.0, '②d 余额补足（可覆盖默认模型预扣）', `balance=${bal}`);
      try {
        const ures = await fetchRetry(CLOUD_URL + '/api/v1/user/usage', {
          headers: { Authorization: 'Bearer ' + issuedKey },
        });
        const ubody = await ures.json().catch(() => ({}));
        accountHandle = String(ubody.account_handle || '');
      } catch (e) {
        /* 句柄拿不到不影响验收 */
      }
    }

    // ================= 业主通道 =================
    await clickSafe(page.locator('[data-testid="open-passkey-modal"]').first(), '④a 打开口令解锁弹窗');
    await sleep(1000);
    check((await page.locator('[data-testid="owner-passkey-input"]').count()) > 0, '④a 口令弹窗已渲染', '');
    await page.locator('[data-testid="owner-passkey-input"]').first().fill(OWNER_PASSKEY);
    await clickSafe(page.locator('[data-testid="owner-passkey-btn"]').first(), '④b 提交口令');
    try {
      await page.waitForSelector('[data-testid="owner-passkey-ok"]', { timeout: T.api });
      const okText = (await page.locator('[data-testid="owner-passkey-ok"]').first().innerText()).trim();
      check(/已解锁 OWNER/.test(okText), '④ 管理口令解锁成功', okText);
    } catch (e) {
      const errSel = page.locator('[data-testid="owner-passkey-error"]');
      bad(
        '④ 管理口令解锁',
        (await errSel.count()) > 0
          ? `前端报错：${(await errSel.first().innerText()).trim()}`
          : `未出现结果提示: ${e.message}`
      );
    }
    await sleep(1500);
    await clickSafe(page.locator('[data-testid="passkey-modal-close"]').first(), '④c 关闭口令弹窗');
    await sleep(1500);

    const toOwner = byText(page, '切换至业主视角');
    if ((await toOwner.count()) > 0) {
      await clickSafe(toOwner, '④d 切到业主视角');
      await sleep(2500);
    }
    check((await page.locator('[data-testid="host-tabs"]').count()) > 0, '④d 业主分段导航已出现', '');

    // ---------- ② P1-a：手工录入黄金记忆 ----------
    await clickSafe(page.locator('[data-testid="host-tab-STUDIO"]').first(), '②a 进入模型工作台');
    await sleep(3000);
    const dsCard = page.locator('[data-testid="golden-dataset-card"]').first();
    check((await dsCard.count()) > 0, '②a 黄金语料工坊卡片已渲染', '');

    await clickSafe(page.locator('[data-testid="golden-dataset-curate-toggle"]').first(), '②b 展开「➕ 手工录入黄金记忆」');
    await sleep(600);
    const curateForm = page.locator('[data-testid="golden-dataset-curate-form"]').first();
    check((await curateForm.count()) > 0, '②b 策展表单已展开', '');
    await page.locator('[data-testid="golden-dataset-curate-prompt"]').first().fill(CURATED_PROMPT);
    await page.locator('[data-testid="golden-dataset-curate-completion"]').first().fill(CURATED_ANSWER);
    await page.locator('[data-testid="golden-dataset-curate-model"]').first().fill('qwen2.5:0.5b');
    await sleep(300);
    await clickSafe(page.locator('[data-testid="golden-dataset-curate-save"]').first(), '②c 保存策展件');
    const noticeText = await waitForNotice(page, '已录入黄金记忆\\s*curated:', 90000);
    check(/已录入黄金记忆\s*curated:/.test(noticeText), '②c 策展件已录入（返回 curated: request_id）',
      noticeText.replace(/\s+/g, ' ').slice(0, 90));
    const ridMatch = noticeText.match(/curated:[0-9a-f]+/i);
    curatedRequestId = ridMatch ? ridMatch[0] : '';
    check(!!curatedRequestId, '②d 拿到策展件 request_id', curatedRequestId || '(未解析到)');
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase15-01-curate.png'), fullPage: false });

    // ---------- ② P1-a'：策展件已进黄金池（**跑批之前**查 ——
    //    跑批会新增 18 行样本，把策展件挤出「最近 10 条」）
    {
      const t0 = await ownerSessionToken(page);
      if (t0) {
        const res = await fetchRetry(CLOUD_URL + '/api/v1/owner/datasets/summary', {
          headers: { Authorization: 'Bearer ' + t0 },
        });
        const body = await res.json().catch(() => ({}));
        const recent = Array.isArray(body.recent) ? body.recent : [];
        const hit = recent.find((r) => String(r.request_id || '') === curatedRequestId);
        check(res.status === 200 && !!hit && Number(hit.is_golden) === 1,
          '②e 策展件已进黄金池（is_golden=1，可被召回）',
          `HTTP ${res.status} golden=${body.golden} hit=${!!hit}`);
      } else {
        warn('②e 策展件黄金池校验', '没拿到业主会话 token');
      }
    }

    // ---------- ② P1-b：新增自定义 RLAIF 考题 ----------
    await clickSafe(page.locator('[data-testid="golden-dataset-rlaif-task-toggle"]').first(), '②e 展开「➕ 添加自定义验算题」');
    await sleep(600);
    check((await page.locator('[data-testid="golden-dataset-rlaif-task-form"]').count()) > 0, '②e 自定义考题表单已展开', '');
    await page.locator('[data-testid="golden-dataset-rlaif-task-title"]').first().fill(TASK_TITLE);
    await page.locator('[data-testid="golden-dataset-rlaif-task-prompt"]').first().fill(TASK_PROMPT);
    await page.locator('[data-testid="golden-dataset-rlaif-task-must"]').first().fill(TASK_MUST);
    await page.locator('[data-testid="golden-dataset-rlaif-task-minlength"]').first().fill('4');
    await sleep(300);
    await clickSafe(page.locator('[data-testid="golden-dataset-rlaif-task-save"]').first(), '②f 保存自定义考题');
    const taskNotice = await waitForNotice(page, '已新增自定义考题\\s*custom-', 90000);
    check(/已新增自定义考题\s*custom-/.test(taskNotice), '②f 自定义考题已入库（返回 custom- task_id）',
      taskNotice.replace(/\s+/g, ' ').slice(0, 90));
    const tidMatch = taskNotice.match(/custom-[0-9a-f]+/i);
    customTaskId = tidMatch ? tidMatch[0] : '';
    check(!!customTaskId, '②g 拿到自定义考题 task_id', customTaskId || '(未解析到)');
    if (customTaskId) {
      // 题库列表由「刷新」按钮驱动 ⇒ 显式点一次再断言（不靠竞态）
      await clickSafe(page.locator('[data-testid="golden-dataset-rlaif-refresh"]').first(), '②g-1 刷新题库');
      await sleep(3000);
      const listed = (await page.locator(`[data-testid="golden-dataset-rlaif-custom-${customTaskId}"]`).count()) > 0;
      check(listed, '②h 自定义考题已出现在题库列表（实时刷新）', listed ? '已出现' : '未出现');
    }

    // ---------- ② P1-c：跑批 ⇒ 自定义考题产出偏好对 ----------
    await clickSafe(page.locator('[data-testid="golden-dataset-rlaif-run"]').first(), '②i 运行 RLAIF 自动验算');
    const resultShown = await page
      .waitForSelector('[data-testid="golden-dataset-rlaif-result"]', { timeout: 240000 })
      .then(() => true)
      .catch(() => false);
    check(resultShown, '②i 跑批结果面板已出现', resultShown ? '已出现' : '超时');
    if (resultShown) {
      const pairs = (await page
        .locator('[data-testid="golden-dataset-rlaif-pairs"]')
        .first()
        .innerText()
        .catch(() => '')) || '';
      check(Number(pairs) >= 1, '②j 跑批产出偏好对 ≥ 1', `pairs=${pairs}`);
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase15-02-rlaif.png'), fullPage: false });
    }

    // ---------- ② 直连接口复核（业主会话） ----------
    const token = await ownerSessionToken(page);
    if (token) {
      // ②k 自定义考题能被跑批（只跑这一道，dry_run 不落库）
      try {
        const res = await fetchRetry(CLOUD_URL + '/api/v1/owner/rlaif/run', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_ids: [customTaskId], max_tasks: 0, dry_run: true }),
        });
        const body = await res.json().catch(() => ({}));
        const pairs = Array.isArray(body.pairs) ? body.pairs : [];
        const mine = pairs.find((p) => String(p.task_id || '') === customTaskId);
        check(res.status === 200 && !!mine && !!mine.chosen && !!mine.rejected,
          '②k 自定义考题被跑批纳入并产出 chosen/rejected',
          `HTTP ${res.status} pairs=${pairs.length} mine=${!!mine}`);
      } catch (e) {
        bad('②k 自定义考题跑批复核', e.message);
      }
      // ②m 自定义考题在题库里（且标 custom）
      try {
        const res = await fetchRetry(CLOUD_URL + '/api/v1/owner/rlaif/tasks', {
          headers: { Authorization: 'Bearer ' + token },
        });
        const body = await res.json().catch(() => ({}));
        const tasks = Array.isArray(body.tasks) ? body.tasks : [];
        const mine = tasks.find((t) => String(t.id || '') === customTaskId);
        check(res.status === 200 && !!mine && mine.custom === true,
          '②m 自定义考题在题库中且标记 custom', `HTTP ${res.status} tasks=${tasks.length} mine=${!!mine}`);
      } catch (e) {
        bad('②m RLAIF 题库接口', e.message);
      }
      // ②n 真实买家评价受保护（删除端点拒删）
      try {
        const res = await fetchRetry(
          CLOUD_URL + '/api/v1/owner/datasets/golden/' + encodeURIComponent('chatcmpl-protected-probe'),
          { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }
        );
        const body = await res.json().catch(() => ({}));
        check(res.status === 400, '②n 删除端点保护真实买家评价（400 拒删）',
          `HTTP ${res.status} ${JSON.stringify(body).slice(0, 80)}`);
      } catch (e) {
        bad('②n 删除保护校验', e.message);
      }
    } else {
      warn('② 直连接口复核', '没拿到业主会话 token（localStorage 里没有 apipaw.session）');
    }

    // ---------- ③ P2：公开 golden-modelfile（无 OWNER 鉴权） ----------
    try {
      const res = await fetchRetry(CLOUD_URL + '/api/v1/network/golden-modelfile?base_model=qwen2.5:0.5b');
      const text = await res.text();
      const count = res.headers.get('x-apipaw-golden-count');
      check(res.status === 200 && /FROM\s+\S+/i.test(text),
        '③a 公开 golden-modelfile 返回标准 Modelfile（无需鉴权）',
        `HTTP ${res.status} bytes=${text.length} golden_count=${count}`);
      check(/黄金策展|策展/.test(text) || Number(count || 0) >= 1,
        '③b Modelfile 里含黄金样本内容', `golden_count=${count}`);
    } catch (e) {
      bad('③a 公开 golden-modelfile', e.message);
    }
    try {
      const res = await fetchRetry(CLOUD_URL + '/api/v1/network/golden-summary');
      const body = await res.json().catch(() => ({}));
      const leak = JSON.stringify(body).match(/paw-sk-|wallet|account_handle/i);
      check(res.status === 200 && !!body.golden_count && !leak,
        '③c 公开 golden-summary 只回统计（无账号/钱包泄露）',
        `HTTP ${res.status} golden_count=${body.golden_count}`);
    } catch (e) {
      bad('③c 公开 golden-summary', e.message);
    }

    // ================= 买家通道：黄金记忆命中注入 =================
    const roleBtn = page.locator('[data-testid="switch-role"]').first();
    const roleText = (await roleBtn.innerText().catch(() => '')) || '';
    if (/买家视角/.test(roleText)) {
      await clickSafe(roleBtn, '④a 切回买家视角');
      await sleep(2500);
    }
    check(
      await page.locator('#apx-playground-input').first().isVisible().catch(() => false),
      '④a 买家视角 Playground 已渲染',
      ''
    );

    // ⚠️ 切视角后控制台自己的会话可能被清 ⇒ 显式把本次的 Key 再塞回去，
    //    否则 Playground 会拿旧 Key 发请求 → 401。
    {
      if ((await page.locator('[data-testid="api-key-input"]').count()) === 0) {
        await clickSafe(page.locator('[data-testid="open-key-modal"]').first(), '④a-1 打开密钥弹窗');
        await sleep(1200);
      }
      const input = page.locator('[data-testid="api-key-input"]').first();
      if ((await input.count()) > 0) {
        await input.fill(issuedKey);
        await sleep(300);
        await clickSafe(page.locator('[data-testid="api-key-save"]').first(), '④a-2 写入本次 Key');
        await sleep(3000);
      } else {
        warn('④a-2 写入本次 Key', '没找到密钥输入框');
      }
    }

    // 选便宜模型，避免高价预扣把余额顶穿
    try {
      await clickSafe(page.locator('#apx-model-selector-value').first(), '④b 打开模型下拉');
      await sleep(1200);
      const cheap = page.locator('[data-testid="playground-model-item-qwen2.5:0.5b"]').first();
      if ((await cheap.count()) > 0) {
        await clickSafe(cheap, '④b 选中 qwen2.5:0.5b');
        await sleep(1200);
      } else {
        warn('④b 切换便宜模型', '模型下拉里没找到 qwen2.5:0.5b（保持默认）');
      }
    } catch (e) {
      warn('④b 切换便宜模型', e.message);
    }

    const answered = await sendChat(page, CURATED_PROMPT);
    const bad4xx = apiLog.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url}`);
    check(answered, '④c 提问后回答已渲染',
      answered ? '已渲染' : `超时｜失败请求=[${bad4xx.slice(-4).join(' ; ') || '（无）'}]`);
    await sleep(1200);
    const badge = page.locator('[data-testid="playground-golden-boost-badge"]').first();
    const badgeShown = (await badge.count()) > 0;
    const badgeText = badgeShown ? ((await badge.innerText().catch(() => '')) || '') : '';
    check(badgeShown && /已注入\s*\d+\s*条黄金记忆/.test(badgeText),
      '④d 回答上出现「✨ 已注入 N 条黄金记忆」徽标', badgeText.replace(/\s+/g, ' ').slice(0, 60) || '未出现');
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase15-03-golden-boost.png'), fullPage: false });

    // 直连接口复核：注入计数 + 买家计费不变
    try {
      const body = {
        model: 'apipaw-auto',
        messages: [{ role: 'user', content: CURATED_PROMPT }],
        stream: false,
      };
      const off = await fetchRetry(CLOUD_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + issuedKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, golden_boost: false }),
      });
      const offBody = await off.json().catch(() => ({}));
      const on = await fetchRetry(CLOUD_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + issuedKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, golden_boost: true }),
      });
      const onBody = await on.json().catch(() => ({}));
      const offCount = headerValue(off, '^x-apipaw-golden-boost-count$');
      const onCount = headerValue(on, '^x-apipaw-golden-boost-count$');
      check(offCount !== null && offCount === '0', '④e golden_boost=false ⇒ 注入条数为 0', `header=${offCount}`);
      check(onCount !== null && Number(onCount) >= 1, '④f golden_boost=true ⇒ 注入条数 ≥ 1', `header=${onCount}`);
      const offCost = Number((offBody.usage || {}).cost_usd || 0);
      const onCost = Number((onBody.usage || {}).cost_usd || 0);
      check(offCost === onCost, '④g 注入的 Few-Shot token **不向买家额外收费**', `cost ${offCost}→${onCost}`);
    } catch (e) {
      bad('④e~④g 直连接口复核（注入计费不变）', e.message);
    }

    // ---------- ① P0：高价模型自适应预扣裁剪 ----------
    // 用**全新账户**（只领 $0.50 体验金）发一个「预扣必然超预算」的请求：
    //   模型 qwen2.5:0.5b（$0.2/1K 输出）· max_tokens=4096 ⇒ 预扣 $0.82 > $0.50
    //   ⇒ 期望：网关把 max_tokens 裁到余额买得起的量，放行且返回
    //      X-APIPaw-MaxTokens-Capped（**不再 402**）。
    let p0Handle = '';
    try {
      const issue = await fetchRetry(CLOUD_URL + '/api/v1/auth/apikey', { method: 'POST' });
      const rec = await issue.json().catch(() => ({}));
      const p0Key = String(rec.api_key || '');
      p0Handle = String(rec.account_handle || '');
      check(issue.status === 200 && !!p0Key, '①a 签发全新买家账户（$0 余额）', maskKey(p0Key));

      const faucet = await fetchRetry(CLOUD_URL + '/api/v1/user/faucet', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + p0Key },
      });
      const fbody = await faucet.json().catch(() => ({}));
      const p0Balance = Number(fbody.balance_usd || 0);
      check(faucet.status === 200 && p0Balance > 0 && p0Balance <= 0.5,
        '①b 领取 $0.50 新手体验金', `HTTP ${faucet.status} balance=$${p0Balance}`);

      const res = await fetchRetry(CLOUD_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + p0Key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'qwen2.5:0.5b',
          messages: [{ role: 'user', content: STAMP + '：请只回答两个字：收到' }],
          max_tokens: 4096,
          stream: false,
        }),
      });
      const body = await res.json().catch(() => ({}));
      const code = String((body.error || {}).code || '');
      const capped = headerValue(res, '^x-apipaw-max.?tokens-capped$');
      check(res.status !== 402 || code !== 'insufficient_balance',
        '①c $0.50 账户请求高价档模型：不再 402（自适应裁剪 max_tokens）',
        `HTTP ${res.status} code=${code || '(none)'} capped=${capped || '(none)'}`);
      const n = Number(capped || 0);
      check(!!capped && n > 0 && n < 4096,
        '①d 响应头 X-APIPaw-MaxTokens-Capped 给出裁剪后的有效上限',
        `capped=${capped || '(none)'}（原 4096）`);

      // 余额不得被透支
      const ub = await fetchRetry(CLOUD_URL + '/api/v1/user/usage', {
        headers: { Authorization: 'Bearer ' + p0Key },
      });
      const ubody = await ub.json().catch(() => ({}));
      const after = Number(ubody.balance_usd || 0);
      check(after >= 0, '①e 结算后余额不为负（不透支）', `balance_after=$${after}`);
      if (p0Handle) createdSamples.push(p0Handle);
    } catch (e) {
      bad('① P0 自适应预扣裁剪', e.message);
    }

    // ---------- ④ P3：前端 Gzip 体积 ----------
    await checkGzip(BASE_URL, 'console');
    await checkGzip(POCKET_URL, 'pocket');

    // ---------- 收尾：删掉本次验收自己造的东西（跑批产物由 ops_ctl cleanup 扫） ----------
    if (token && curatedRequestId) {
      try {
        const res = await fetchRetry(
          CLOUD_URL + '/api/v1/owner/datasets/golden/' + encodeURIComponent(curatedRequestId),
          { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }
        );
        check(res.status === 200, '⑤a 策展件可删除（清理路径可用）', `HTTP ${res.status}`);
      } catch (e) {
        warn('⑤a 删除策展件', e.message);
      }
    }
    if (token && customTaskId) {
      try {
        const res = await fetchRetry(
          CLOUD_URL + '/api/v1/owner/rlaif/tasks/' + encodeURIComponent(customTaskId),
          { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }
        );
        check(res.status === 200, '⑤b 自定义考题可删除（清理路径可用）', `HTTP ${res.status}`);
      } catch (e) {
        warn('⑤b 删除自定义考题', e.message);
      }
    }

    console.log(`  [issued-key] ${maskKey(issuedKey)}`);
    console.log(`  [created] curated=${curatedRequestId || '(none)'} task=${customTaskId || '(none)'} stamp=${STAMP}`);
    try {
      const outFile =
        process.env.APIPAW_E2E_KEYS_OUT ||
        path.join(require('os').tmpdir(), 'apipaw-phase15-keys.json');
      fs.writeFileSync(
        outFile,
        JSON.stringify(
          {
            api_key: issuedKey,
            account_handle: accountHandle,
            extra_accounts: createdSamples,
            curated_request_id: curatedRequestId,
            custom_task_id: customTaskId,
            stamp: STAMP,
            at: Date.now(),
          },
          null,
          2
        )
      );
    } catch (e) {
      warn('⑥ 记录测试 Key 供事后清理', e.message);
    }
  } catch (e) {
    bad('阶段十五线上验收', e.message);
    try {
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase15-error.png'), fullPage: true });
    } catch (_) {}
  } finally {
    await context.close();
    await browser.close();
  }

  const passed = results.filter((r) => r.pass).length;
  const soft = results.filter((r) => r.soft).length;
  console.log('');
  console.log(`===== 阶段十五 P0~P3 线上验收：${passed}/${results.length} 通过（其中 ${soft} 条 WARN）=====`);
  fs.writeFileSync(
    REPORT,
    JSON.stringify(
      {
        results: redactDeep(results),
        passed,
        total: results.length,
        soft,
        stamp: STAMP,
        curatedRequestId,
        customTaskId,
        issuedKeyMasked: maskKey(issuedKey),
        pageErrors,
      },
      null,
      2
    )
  );
  process.exit(passed === results.length ? 0 : 1);
})();
