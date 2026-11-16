/**
 * 阶段十三 P0~P3 · 线上验收
 *   ① P0 `apipaw-moa` 出现在模型下拉 + 可发起对话 + 路由元数据（X-APIPaw-MoA-Mode）
 *   ② P1 业主视角「一键生成 Ollama Modelfile」/「导出 LoRA 微调脚本」+ 预览弹窗
 *   ③ P3 前端 Gzip 体积 < 450KB（console + pocket）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules \
 *   APIPAW_OWNER_PASSKEY='AP-xxxx' node e2e/phase13-p1.cjs
 *
 * 产物：e2e/shots/phase13-*.png + e2e/phase13-report.json
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
const REPORT = path.join(__dirname, 'phase13-report.json');
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

/** Playground 发送一条消息并等回答出现（回答区最后一屏） */
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

/** 读预览弹窗正文 */
async function previewBody(page) {
  const sel = page.locator('[data-testid="golden-dataset-preview-body"]').first();
  return (await sel.innerText().catch(() => '')) || '';
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
  // ⚠️ 前端渲染期异常（React 整树卸载）会让"等回答出现"永远超时 ⇒ 必须留痕
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') pageErrors.push('console.error: ' + String(m.text()).slice(0, 300));
  });
  // 请求事件（响应可能一直挂着 ⇒ 只看 request 才能判断"有没有发出去"）
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
    check(!!issuedKey && issuedKey.length > 10, '② 签发新 Key ⇒ 拿到明文', maskKey(issuedKey));
    await clickSafe(page.locator('[data-testid="issue-key-confirm"]').first(), '②b 勾选「我已保存」');
    await sleep(400);
    await clickSafe(page.locator('[data-testid="issue-key-save"]').first(), '②c 保存并使用此密钥');
    await sleep(3500);

    // 领一次性体验金（余额 $0 ⇒ 网关按设计返回 402，发不出消息）
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

    // ⚠️ 体验金是**按 IP 限流**的（5 次/小时）—— 验收脚本连跑会把自己打满，
    //    表现为「前端显示已到账、实际余额仍是 $0 ⇒ 网关按设计返回 402」。
    //    所以这里**以服务端余额为准**：不够就用演示充值补一点（幂等键唯一）。
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
      const rid = `phase13-e2e-${Date.now()}`;
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
    // 明文 Key 落到本地临时文件（**不入仓**）：验收后要精确清理这些测试账户
    try {
      const outFile =
        process.env.APIPAW_E2E_KEYS_OUT ||
        path.join(require('os').tmpdir(), 'apipaw-phase13-keys.json');
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

    // ---------- ① P0：`apipaw-moa` 出现在模型下拉 ----------
    const selector = page.locator('#apx-model-selector-value').first();
    check((await selector.count()) > 0, '①a 模型选择器已渲染', '');
    await clickSafe(selector, '①a 打开模型下拉');
    await sleep(1500);
    const moaItem = page.locator('[data-testid="playground-model-item-apipaw-moa"]').first();
    const moaShown = (await moaItem.count()) > 0;
    check(moaShown, '①b 模型下拉出现 `apipaw-moa` 协同元模型', moaShown ? '已出现' : '未找到');
    if (moaShown) {
      const txt = (await moaItem.innerText().catch(() => '')) || '';
      check(/MoA|协同/.test(txt), '①c 协同条目的显示名正确', txt.replace(/\s+/g, ' ').slice(0, 80));
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase13-01-model-picker.png'), fullPage: false });

    // ---------- ①d 选中 `apipaw-moa` 并发起一次对话 ----------
    if (moaShown) {
      await clickSafe(moaItem, '①d 选中 apipaw-moa');
      await sleep(1500);
      const selText = (await page.locator('#apx-model-selector-value').first().innerText().catch(() => '')) || '';
      check(/MoA|协同/.test(selText), '①e 选择器显示协同路由', selText.replace(/\s+/g, ' ').slice(0, 60));
      const metaText = (await page.locator('#apx-model-meta').first().innerText().catch(() => '')) || '';
      check(/协同|聚合/.test(metaText), '①f 模型说明体现「多节点协同 / 聚合」', metaText.replace(/\s+/g, ' ').slice(0, 90));
      const moaAnswered = await sendChat(page, '阶段十三验收：多节点协同请回答「ping」。');
      const bad4xx = apiLog.filter((r) => r.status >= 400).map((r) => `${r.status} ${r.url}`);
      const inputVal = (await page.locator('#apx-playground-input').first().inputValue().catch(() => '')) || '';
      const domText = (await page.evaluate(() => document.body.innerText || '').catch(() => '')) || '';
      const feedbackRows = await page.locator('[data-testid="playground-feedback-row"]').count();
      check(
        moaAnswered,
        '①g `apipaw-moa` 发起对话成功返回回答',
        moaAnswered
          ? '已渲染'
          : '超时' +
              `｜输入框残留="${inputVal.slice(0, 40)}"` +
              `｜回答已渲染=${/演示模式|协同深度思考/.test(domText)}` +
              `｜反馈行=${feedbackRows}` +
              `｜发出的推理请求=[${reqLog.join(' ; ') || '（一个都没有！）'}]` +
              `｜页面片段=${domText.replace(/\s+/g, ' ').slice(-260)}` +
              (bad4xx.length ? `｜失败请求: ${bad4xx.slice(0, 4).join(' ; ')}` : '') +
              (pageErrors.length ? `｜页面错误: ${pageErrors.slice(0, 3).join(' | ')}` : '')
      );
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase13-02-moa-chat.png'), fullPage: false });
    }

    // ---------- ①h 直连接口复核：MoA 模式头 + 只结算一次 ----------
    try {
      const ares = await fetch(CLOUD_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + issuedKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'apipaw-moa',
          messages: [{ role: 'user', content: '阶段十三直连接口验收：ping' }],
        }),
      });
      const abody = await ares.json().catch(() => ({}));
      const mode = ares.headers.get('x-apipaw-moa-mode') || '';
      check(
        ares.status === 200 && !!abody.choices && !!mode,
        '①h POST /v1/chat/completions（model=apipaw-moa）返回 200 + MoA 模式头',
        `HTTP ${ares.status} mode=${mode || '(none)'} resolved=${abody.resolved_model_id || '(演示模式)'}`
      );
      check(
        ['multi_node', 'self_refine', 'simulated'].includes(mode),
        '①i MoA 模式取值合法（multi_node / self_refine / simulated）',
        mode
      );
    } catch (e) {
      bad('①h POST /v1/chat/completions（apipaw-moa）', e.message);
    }

    // ---------- ①j 模型目录里必须有虚拟条目 ----------
    try {
      const mres = await fetch(CLOUD_URL + '/v1/models', {
        headers: { Authorization: 'Bearer ' + issuedKey },
      });
      const mbody = await mres.json().catch(() => ({}));
      const moa = (mbody.data || []).find((m) => m.id === 'apipaw-moa');
      check(
        mres.status === 200 && !!moa && moa.is_virtual === true,
        '①j GET /v1/models 含 apipaw-moa（is_virtual=true）',
        moa ? `${moa.display_name}` : '未找到'
      );
    } catch (e) {
      bad('①j GET /v1/models', e.message);
    }

    // ---------- ①k 云端推荐模型列表（阶段十三 P2 依赖的上游） ----------
    try {
      const rres = await fetch(CLOUD_URL + '/api/v1/network/recommended-models');
      const rbody = await rres.json().catch(() => ({}));
      const list = Array.isArray(rbody.models) ? rbody.models : [];
      const first = list[0] || {};
      const fields = ['model_id', 'display_name', 'min_vram_gb', 'prompt_price_per_1k',
        'completion_price_per_1k', 'royalty_rate', 'online_nodes'];
      const missing = fields.filter((f) => !(f in first));
      check(
        rres.status === 200 && list.length > 0 && missing.length === 0,
        '①k GET /api/v1/network/recommended-models 返回完整推荐列表',
        `HTTP ${rres.status} count=${list.length} missing=${missing.join(',') || '(无)'}`
      );
    } catch (e) {
      bad('①k 推荐模型列表', e.message);
    }

    // ================= 业主通道 =================
    // ---------- ④ 管理口令解锁 OWNER ----------
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

    // ---------- ③ P1：模型工作台里的「一键生成进化版模型物料」 ----------
    await clickSafe(page.locator('[data-testid="host-tab-STUDIO"]').first(), '③a 进入模型工作台');
    await sleep(3000);
    const dsCard = page.locator('[data-testid="golden-dataset-card"]').first();
    const dsShown = (await dsCard.count()) > 0;
    check(dsShown, '③a 黄金语料工坊卡片已渲染', dsShown ? '已渲染' : '未找到');
    if (dsShown) {
      const mfBtn = page.locator('[data-testid="golden-dataset-export-modelfile"]').first();
      const loraBtn = page.locator('[data-testid="golden-dataset-export-lora"]').first();
      check((await mfBtn.count()) > 0, '③b 「一键生成 Ollama Modelfile」按钮已渲染', '');
      check((await loraBtn.count()) > 0, '③c 「导出 LoRA 微调脚本」按钮已渲染', '');
      const baseInput = page.locator('[data-testid="golden-dataset-base-model"]').first();
      if ((await baseInput.count()) > 0) {
        await baseInput.fill('qwen2.5:0.5b');
        await sleep(300);
      }

      // ③d 生成 Modelfile ⇒ 预览弹窗
      await clickSafe(mfBtn, '③d 点「生成 Ollama Modelfile」');
      const modalShown = await page
        .waitForSelector('[data-testid="golden-dataset-preview-modal"]', { timeout: T.api })
        .then(() => true)
        .catch(() => false);
      check(modalShown, '③d Modelfile 预览弹窗已打开', modalShown ? '已打开' : '超时');
      if (modalShown) {
        const body = await previewBody(page);
        check(/FROM\s+qwen2\.5:0\.5b/.test(body), '③e 预览里含 `FROM qwen2.5:0.5b`', body.split('\n')[0] || '');
        check(/PARAMETER/.test(body) && /SYSTEM/.test(body) && /MESSAGE/.test(body),
          '③f 预览里含 PARAMETER / SYSTEM / MESSAGE',
          body.replace(/\s+/g, ' ').slice(0, 90));
        await page.screenshot({ path: path.join(SHOT_DIR, 'phase13-03-modelfile.png'), fullPage: false });
        // 下载按钮 ⇒ 浏览器下载事件
        try {
          const dlPromise = page.waitForEvent('download', { timeout: 20000 });
          await clickSafe(page.locator('[data-testid="golden-dataset-preview-download"]').first(), '③g 点「下载文件」');
          const dl = await dlPromise;
          check(/Modelfile/i.test(dl.suggestedFilename()), '③g Modelfile 下载事件触发', dl.suggestedFilename());
        } catch (e) {
          warn('③g Modelfile 下载事件', e.message);
        }
        // ⚠️ 点「下载文件」成功后弹窗会**自动关闭** ⇒ 只在仍存在时才点关闭
        const stillOpen = (await page.locator('[data-testid="golden-dataset-preview-close"]').count()) > 0;
        if (stillOpen) {
          const closed = await page
            .locator('[data-testid="golden-dataset-preview-close"]')
            .first()
            .click({ force: true, timeout: T.action })
            .then(() => true)
            .catch(() => false);
          check(closed, '③h 关闭预览', closed ? '已关闭' : '强制点击失败');
        } else {
          ok('③h 下载后预览弹窗自动关闭', '已关闭');
        }
        await sleep(800);
      }

      // ③i 生成 LoRA 脚本 ⇒ 预览弹窗
      await clickSafe(loraBtn, '③i 点「导出 LoRA 微调脚本」');
      const modal2 = await page
        .waitForSelector('[data-testid="golden-dataset-preview-modal"]', { timeout: T.api })
        .then(() => true)
        .catch(() => false);
      check(modal2, '③i LoRA 脚本预览弹窗已打开', modal2 ? '已打开' : '超时');
      if (modal2) {
        const body = await previewBody(page);
        check(/qwen2\.5:0\.5b/.test(body), '③j LoRA 脚本里嵌入基准模型', body.replace(/\s+/g, ' ').slice(0, 90));
        check(/SFTTrainer|Trainer|trl|unsloth/i.test(body), '③k LoRA 脚本含训练器实现', '');
        await page.screenshot({ path: path.join(SHOT_DIR, 'phase13-04-lora.png'), fullPage: false });
        const stillOpen2 = (await page.locator('[data-testid="golden-dataset-preview-close"]').count()) > 0;
        if (stillOpen2) {
          await clickSafe(page.locator('[data-testid="golden-dataset-preview-close"]').first(), '③l 关闭预览');
        }
        await sleep(800);
      }
    }

    // ---------- ② 直连接口复核导出（OWNER 会话） ----------
    const token = await ownerSessionToken(page);
    if (token) {
      try {
        const res = await fetch(
          CLOUD_URL + '/api/v1/owner/datasets/export?format=modelfile&base_model=qwen2.5:0.5b',
          { headers: { Authorization: 'Bearer ' + token } }
        );
        const text = await res.text();
        check(
          res.status === 200 && /FROM\s+qwen2\.5:0\.5b/.test(text) && /MESSAGE/.test(text),
          '②a 导出 modelfile 返回标准 Modelfile 文本',
          `HTTP ${res.status} len=${text.length}`
        );
      } catch (e) {
        bad('②a 导出 modelfile', e.message);
      }
      try {
        const res = await fetch(
          CLOUD_URL + '/api/v1/owner/datasets/export?format=lora_script&base_model=qwen2.5:0.5b',
          { headers: { Authorization: 'Bearer ' + token } }
        );
        const text = await res.text();
        check(
          res.status === 200 && /qwen2\.5:0\.5b/.test(text) && /SFTTrainer|Trainer/i.test(text),
          '②b 导出 lora_script 返回单卡微调脚本',
          `HTTP ${res.status} len=${text.length}`
        );
      } catch (e) {
        bad('②b 导出 lora_script', e.message);
      }
      try {
        const res = await fetch(
          CLOUD_URL + '/api/v1/owner/datasets/export?format=dpo',
          { headers: { Authorization: 'Bearer ' + token } }
        );
        const text = await res.text();
        const lines = text.split('\n').filter((l) => l.trim());
        let valid = res.status === 200;
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (!obj.prompt || !obj.chosen || !obj.rejected) valid = false;
          } catch (e) {
            valid = false;
          }
        }
        check(valid, '②c 导出 dpo 返回合法偏好对 JSONL', `HTTP ${res.status} lines=${lines.length}`);
      } catch (e) {
        bad('②c 导出 dpo', e.message);
      }
    } else {
      warn('② 直连接口复核', '没拿到业主会话 token（localStorage 里没有 apipaw.session）');
    }

    // ---------- ③ P3：前端 Gzip 体积 ----------
    await checkGzip(BASE_URL, 'console');
    await checkGzip(POCKET_URL, 'pocket');

    console.log(`  [issued-key] ${maskKey(issuedKey)}`);
  } catch (e) {
    bad('阶段十三线上验收', e.message);
    try {
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase13-error.png'), fullPage: true });
    } catch (_) {}
  } finally {
    await context.close();
    await browser.close();
  }

  const passed = results.filter((r) => r.pass).length;
  const soft = results.filter((r) => r.soft).length;
  console.log('');
  console.log(
    `===== 阶段十三 P0~P3 线上验收：${passed}/${results.length} 通过（其中 ${soft} 条 WARN）=====`
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
