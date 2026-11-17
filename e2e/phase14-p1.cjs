/**
 * 阶段十四 P0~P3 · 线上验收
 *   ① P1 黄金记忆增强：Playground「✨ 开启黄金记忆增强」开关（默认 ON）+ 回答徽标
 *      + **注入不额外多收买家输入费**（两次同参请求的 usage/cost 完全一致）
 *   ② P2 RLAIF：业主视角「🤖 运行 RLAIF 自动验算合成」一键跑批 + 通过率 + chosen/rejected 预览
 *      + 产物能被 `format=dpo` 导出成偏好对
 *   ③ P3 前端 Gzip 体积 < 450KB（console + pocket）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules \
 *   APIPAW_OWNER_PASSKEY='AP-xxxx' node e2e/phase14-p1.cjs
 *
 * 产物：e2e/shots/phase14-*.png + e2e/phase14-report.json
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
const REPORT = path.join(__dirname, 'phase14-report.json');
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

/**
 * 确保买家账户余额足够。
 *
 * ⚠️ Playground 默认模型可能是 deepseek-r1（输出 $2.19/1K）⇒ max_tokens=1024 的
 *    **预扣**就超过 $2 ⇒ $0.50 体验金必然 402（这是网关的正确行为，不是缺陷）。
 *    所以验收前把余额补足，并**重试**（本地 → cloud.apipaw.com 的直连偶发超时）。
 */
async function ensureBalance(apiKey, targetUsd) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const rid = `phase14-recharge-${Date.now()}-${attempt}`;
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

/** 带重试的 fetch（本地 → cloud.apipaw.com 偶发连接超时） */
async function fetchRetry(url, init, tries = 3) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      await sleep(1200);
    }
  }
  throw lastErr || new Error('fetch failed');
}

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

/** 与黄金语料池里的 depin-001 题目同文 ⇒ RLAIF 跑批后必能召回黄金范例 */
const GOLDEN_PROBE = 'APIPaw 场景 B（社区创作者模型）的默认版税率是多少？请给出小数形式（例如 0.15）并说明它作用在谁身上。';

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
  const reqLog = [];
  page.on('request', (r) => {
    if (r.url().includes('chat/completions')) reqLog.push(`${r.method()} ${r.url()}`);
  });

  let issuedKey = '';

  try {
    if (!OWNER_PASSKEY) bad('④ 管理口令解锁', '缺少环境变量 APIPAW_OWNER_PASSKEY');
    await mount(page);

    // ================= 买家通道 =================
    // ---------- 签发买家 Key ----------
    let modalOpen = (await page.locator('#apx-modal').count()) > 0;
    if (!modalOpen) {
      await clickSafe(byText(page, '设置密钥'), '②a 打开密钥弹窗');
      await sleep(1200);
      modalOpen = (await page.locator('#apx-modal').count()) > 0;
    }
    // ⚠️ 签发台按 **IP 限流**（5 把/小时）—— 验收脚本连跑会把自己打满（429）。
    //    所以：优先用环境变量给的既有 Key；没有才去签发。
    const presetKey = (process.env.APIPAW_E2E_BUYER_KEY || '').trim();
    if (presetKey) {
      // ⚠️ 上面可能已经把密钥弹窗打开了（#apx-modal 遮罩会拦截指针事件），
      //    所以只有「输入框还不在」时才去点开密钥弹窗。
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
      await clickSafe(page.locator('[data-testid="issue-key-save"]').first(), '②c 保存并使用此密钥');
      await sleep(3500);
    }

    // 领一次性体验金（余额 $0 ⇒ 网关按设计返回 402）
    {
      const fbtn = page.locator('[data-testid="balance-faucet-btn"]').first();
      if ((await fbtn.count()) > 0) {
        await clickSafe(fbtn, '②d 领取一次性体验金');
        const fok = await page
          .waitForSelector('[data-testid="balance-faucet-ok"]', { timeout: T.api })
          .then(() => true)
          .catch(() => false);
        const fmsg = fok
          ? (await page.locator('[data-testid="balance-faucet-ok"]').first().innerText()).trim()
          : '';
        check(/到账|已/.test(fmsg), '②d 体验金领取成功', fmsg);
      } else {
        warn('②d 领取一次性体验金', '没找到领取按钮（可能已被领过）');
      }
    }

    let balance = 0;
    let accountHandle = '';
    try {
      const ures = await fetch(CLOUD_URL + '/api/v1/user/usage', {
        headers: { Authorization: 'Bearer ' + issuedKey },
      });
      const ubody = await ures.json().catch(() => ({}));
      balance = Number(ubody.balance_usd || 0);
      accountHandle = String(ubody.account_handle || '');
    } catch (e) {
      bad('②e 查询账户余额', e.message);
    }
    if (balance <= 0) {
      const rid = `phase14-e2e-${Date.now()}`;
      try {
        const rres = await fetch(CLOUD_URL + '/api/v1/user/recharge', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + issuedKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ amount_usd: 1.0, request_id: rid }),
        });
        const rbody = await rres.json().catch(() => ({}));
        balance = Number(rbody.balance_usd || 0);
        check(rres.status === 200 && balance > 0, '②e 演示充值补足余额（体验金限流兜底）',
          `HTTP ${rres.status} balance=${balance}`);
      } catch (e) {
        bad('②e 演示充值', e.message);
      }
    } else {
      ok('②e 账户余额可用', `balance=$${balance}`);
    }
    // Playground 默认模型可能是 deepseek-r1（输出 $2.19/1K）⇒ 预扣就顶穿 $0.50 ⇒ 402。
    // 这里把余额补到 $3，保证任何默认模型的 max_tokens 预扣都能过。
    {
      const before = balance;
      const after = await ensureBalance(issuedKey, 3.0);
      check(after >= 1.0, '②e-2 余额补足到可覆盖默认模型预扣', `balance=${before}→${after}`);
      balance = after;
    }
    try {
      const outFile =
        process.env.APIPAW_E2E_KEYS_OUT ||
        path.join(require('os').tmpdir(), 'apipaw-phase14-keys.json');
      fs.writeFileSync(
        outFile,
        JSON.stringify(
          [{ api_key: issuedKey, account_handle: accountHandle, at: Date.now() }],
          null,
          2
        )
      );
    } catch (e) {
      warn('②f 记录测试 Key 供事后清理', e.message);
    }

    // ================= 业主通道（先跑 RLAIF，把黄金池撑起来） =================
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

    // ---------- ② P2：RLAIF 自动验算与 DPO 自进化跑批 ----------
    await clickSafe(page.locator('[data-testid="host-tab-STUDIO"]').first(), '②a 进入模型工作台');
    await sleep(3000);
    const dsCard = page.locator('[data-testid="golden-dataset-card"]').first();
    const dsShown = (await dsCard.count()) > 0;
    check(dsShown, '②a 黄金语料工坊卡片已渲染', dsShown ? '已渲染' : '未找到');

    const rlaifPanel = page.locator('[data-testid="golden-dataset-rlaif-panel"]').first();
    const rlaifPanelShown = (await rlaifPanel.count()) > 0;
    check(rlaifPanelShown, '②b RLAIF 跑批区已渲染', rlaifPanelShown ? '已渲染' : '未找到');

    const rlaifTasksText =
      (await page.locator('[data-testid="golden-dataset-rlaif-tasks"]').first().innerText().catch(() => '')) || '';
    check(/题库\s*\d+\s*道/.test(rlaifTasksText) && !/题库\s*0\s*道/.test(rlaifTasksText),
      '②c 题库非空（题库条数已显示）', rlaifTasksText.replace(/\s+/g, ' ').slice(0, 80));

    if (rlaifPanelShown) {
      const runBtn = page.locator('[data-testid="golden-dataset-rlaif-run"]').first();
      check((await runBtn.count()) > 0, '②d 「🤖 运行 RLAIF 自动验算合成」按钮已渲染', '');
      await clickSafe(runBtn, '②e 点「运行 RLAIF 自动验算合成」');
      const resultShown = await page
        .waitForSelector('[data-testid="golden-dataset-rlaif-result"]', { timeout: T.api })
        .then(() => true)
        .catch(() => false);
      check(resultShown, '②e 跑批结果面板已出现', resultShown ? '已出现' : '超时');
      if (resultShown) {
        const pairs = (await page
          .locator('[data-testid="golden-dataset-rlaif-pairs"]')
          .first()
          .innerText()
          .catch(() => '')) || '';
        const rate = (await page
          .locator('[data-testid="golden-dataset-rlaif-passrate"]')
          .first()
          .innerText()
          .catch(() => '')) || '';
        check(Number(pairs) >= 1, '②f 自动生成偏好对数量 ≥ 1', `pairs=${pairs}`);
        check(/%\s*$/.test(rate) && parseFloat(rate) >= 0, '②g 通过率已显示', `pass_rate=${rate}`);
        const previewShown = (await page.locator('[data-testid="golden-dataset-rlaif-pair-depin-001"]').count()) > 0;
        check(previewShown, '②h chosen/rejected 预览已渲染（含 depin-001）', previewShown ? '已渲染' : '未找到');
        await page.screenshot({ path: path.join(SHOT_DIR, 'phase14-01-rlaif.png'), fullPage: false });
      }
    }

    // ---------- ②i 直连接口复核：RLAIF 题库 + 跑批 + DPO 导出 ----------
    const token = await ownerSessionToken(page);
    if (token) {
      try {
        const res = await fetchRetry(CLOUD_URL + '/api/v1/owner/rlaif/tasks', {
          headers: { Authorization: 'Bearer ' + token },
        });
        const body = await res.json().catch(() => ({}));
        const tasks = Array.isArray(body.tasks) ? body.tasks : [];
        const leaked = tasks.filter((t) => t.answer || t.correct_text || t.noisy_text);
        check(res.status === 200 && tasks.length >= 5 && leaked.length === 0,
          '②i GET /api/v1/owner/rlaif/tasks 返回题库且不泄露答案',
          `HTTP ${res.status} tasks=${tasks.length} leaked=${leaked.length}`);
      } catch (e) {
        bad('②i RLAIF 题库接口', e.message);
      }
      try {
        const res = await fetchRetry(CLOUD_URL + '/api/v1/owner/rlaif/run', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ task_ids: [], max_tasks: 0, dry_run: true }),
        });
        const body = await res.json().catch(() => ({}));
        check(res.status === 200 && Number(body.pass_rate) >= 0 && Array.isArray(body.pairs),
          '②j POST /api/v1/owner/rlaif/run（dry_run）返回确定性验算统计',
          `HTTP ${res.status} pass_rate=${body.pass_rate} pairs=${(body.pairs || []).length}`);
      } catch (e) {
        bad('②j RLAIF 跑批接口', e.message);
      }
      try {
        const res = await fetchRetry(CLOUD_URL + '/api/v1/owner/datasets/export?format=dpo', {
          headers: { Authorization: 'Bearer ' + token },
        });
        const text = await res.text();
        const lines = text.split('\n').filter((l) => l.trim());
        let rlaifPairs = 0;
        let valid = res.status === 200;
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (!obj.prompt || !obj.chosen || !obj.rejected) valid = false;
            if (String((obj.meta || {}).request_id || '').startsWith('rlaif:')) rlaifPairs += 1;
          } catch (e) {
            valid = false;
          }
        }
        check(valid, '②k 导出 dpo 返回合法偏好对 JSONL', `HTTP ${res.status} lines=${lines.length}`);
        check(rlaifPairs >= 1, '②l DPO 导出池含 RLAIF 自动合成的偏好对', `rlaif_pairs=${rlaifPairs}`);
      } catch (e) {
        bad('②k DPO 导出', e.message);
      }
    } else {
      warn('② 直连接口复核', '没拿到业主会话 token（localStorage 里没有 apipaw.session）');
    }

    // ================= 买家通道：P1 黄金记忆增强 =================
    // 回到买家视角（顶部「切换至买家视角」按钮 ⇒ testID=switch-role）
    const roleBtn = page.locator('[data-testid="switch-role"]').first();
    const roleText = (await roleBtn.innerText().catch(() => '')) || '';
    if (/买家视角/.test(roleText)) {
      await clickSafe(roleBtn, '①a 切回买家视角');
      await sleep(2500);
    }
    const inputVisible = await page
      .locator('#apx-playground-input')
      .first()
      .isVisible()
      .catch(() => false);
    check(inputVisible, '①a 买家视角 Playground 已渲染', inputVisible ? '可见' : '不可见');

    const gbToggle = page.locator('[data-testid="playground-golden-boost-toggle"]').first();
    const gbShown = (await gbToggle.count()) > 0;
    check(gbShown, '①b 「✨ 开启黄金记忆增强（Golden Boost）」开关已渲染', gbShown ? '已渲染' : '未找到');
    if (gbShown) {
      const state = (await page
        .locator('[data-testid="playground-golden-boost-state"]')
        .first()
        .innerText()
        .catch(() => '')) || '';
      check(state.includes('✓'), '①c 开关默认 ON', `state="${state.trim()}"`);
      const label = (await gbToggle.innerText().catch(() => '')) || '';
      check(/Golden Boost|黄金记忆/.test(label), '①d 开关文案正确', label.replace(/\s+/g, ' ').slice(0, 70));
    }

    // 选一个便宜的模型（默认可能是 deepseek-r1，预扣高）⇒ 回答能稳定渲染
    try {
      await clickSafe(page.locator('#apx-model-selector-value').first(), '①e-0 打开模型下拉');
      await sleep(1200);
      const cheap = page.locator('[data-testid="playground-model-item-qwen2.5:0.5b"]').first();
      if ((await cheap.count()) > 0) {
        await clickSafe(cheap, '①e-0 选中 qwen2.5:0.5b');
        await sleep(1200);
        const sel = (await page.locator('#apx-model-selector-value').first().innerText().catch(() => '')) || '';
        check(/qwen/i.test(sel), '①e-0 已切换到便宜模型', sel.replace(/\s+/g, ' ').slice(0, 50));
      } else {
        warn('①e-0 切换便宜模型', '模型下拉里没找到 qwen2.5:0.5b（保持默认）');
      }
    } catch (e) {
      warn('①e-0 切换便宜模型', e.message);
    }

    // 提问与黄金池同文 ⇒ 应召回范例并亮出徽标
    const answered = await sendChat(page, GOLDEN_PROBE);
    const bad4xx = apiLog.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url}`);
    const domTail = (await page.evaluate(() => document.body.innerText || '').catch(() => '')) || '';
    check(
      answered,
      '①e 提问后回答已渲染',
      answered
        ? '已渲染'
        : '超时' +
            `｜失败请求=[${bad4xx.slice(-4).join(' ; ') || '（无）'}]` +
            `｜发出的推理请求=[${reqLog.join(' ; ') || '（无）'}]` +
            `｜页面片段=${domTail.replace(/\s+/g, ' ').slice(-220)}` +
            (pageErrors.length ? `｜页面错误=${pageErrors.slice(0, 2).join(' | ')}` : '')
    );
    await sleep(1200);
    const badge = page.locator('[data-testid="playground-golden-boost-badge"]').first();
    const badgeShown = (await badge.count()) > 0;
    const badgeText = badgeShown ? ((await badge.innerText().catch(() => '')) || '') : '';
    check(badgeShown && /已注入\s*\d+\s*条黄金记忆/.test(badgeText),
      '①f 回答上出现「✨ 已注入 N 条黄金记忆」徽标', badgeText.replace(/\s+/g, ' ').slice(0, 60) || '未出现');
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase14-02-golden-boost.png'), fullPage: false });

    // 直连接口复核：注入**不额外多收**买家输入费
    try {
      const body = {
        model: 'apipaw-auto',
        messages: [{ role: 'user', content: GOLDEN_PROBE }],
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
      const offCount = off.headers.get('x-apipaw-golden-boost-count');
      const onCount = on.headers.get('x-apipaw-golden-boost-count');
      check(offCount !== null && offCount === '0',
        '①g golden_boost=false ⇒ 注入条数为 0', `header=${offCount}`);
      check(onCount !== null && Number(onCount) >= 1,
        '①h golden_boost=true ⇒ 注入条数 ≥ 1', `header=${onCount}`);
      const offTok = Number((offBody.usage || {}).prompt_tokens || 0);
      const onTok = Number((onBody.usage || {}).prompt_tokens || 0);
      const offCost = Number((offBody.usage || {}).cost_usd || 0);
      const onCost = Number((onBody.usage || {}).cost_usd || 0);
      check(offTok === onTok && offCost === onCost,
        '①i 注入的 Few-Shot token **不向买家额外收费**（输入 token 与费用完全一致）',
        `prompt_tokens ${offTok}→${onTok} / cost ${offCost}→${onCost}`);
    } catch (e) {
      bad('①g~①i 直连接口复核（注入计费不变）', e.message);
    }

    // ---------- ③ P3：前端 Gzip 体积 ----------
    await checkGzip(BASE_URL, 'console');
    await checkGzip(POCKET_URL, 'pocket');

    console.log(`  [issued-key] ${maskKey(issuedKey)}`);
  } catch (e) {
    bad('阶段十四线上验收', e.message);
    try {
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase14-error.png'), fullPage: true });
    } catch (_) {}
  } finally {
    await context.close();
    await browser.close();
  }

  const passed = results.filter((r) => r.pass).length;
  const soft = results.filter((r) => r.soft).length;
  console.log('');
  console.log(
    `===== 阶段十四 P0~P3 线上验收：${passed}/${results.length} 通过（其中 ${soft} 条 WARN）=====`
  );
  fs.writeFileSync(
    REPORT,
    JSON.stringify(
      {
        results: redactDeep(results),
        passed,
        total: results.length,
        soft,
        issuedKeyMasked: maskKey(issuedKey),
        pageErrors,
      },
      null,
      2
    )
  );
  process.exit(passed === results.length ? 0 : 1);
})();
