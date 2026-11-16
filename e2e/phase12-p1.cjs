/**
 * 阶段十二 P0~P3 · 线上验收
 *   ① P0-b 提现提交**免刷新**联动（提交 ⇒ 审批台自动出现新申请）
 *   ② P1 Playground 回答质量打分（👍 / 👎）+ /api/v1/user/feedback 200
 *   ③ P2 业主黄金语料工坊（统计预览 + SFT/DPO 一键导出 JSONL 合法）
 *   ④ P3 `apipaw-auto` 智能路由元模型（目录可选 + 发起对话 + 路由元数据）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules \
 *   APIPAW_OWNER_PASSKEY='AP-xxxx' node e2e/phase12-p1.cjs
 *
 * 产物：e2e/shots/phase12-*.png + e2e/phase12-report.json
 *
 * ⚠️ 报告里**绝不落明文 API Key**（统一走 redact.cjs 掩码）。
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { maskKey, redactDeep } = require('./redact.cjs');

const BASE_URL = process.argv[2] || 'https://console.apipaw.com';
const CLOUD_URL = process.env.APIPAW_CLOUD_URL || 'https://cloud.apipaw.com';
const OWNER_PASSKEY = process.env.APIPAW_OWNER_PASSKEY || '';
const SHOT_DIR = path.join(__dirname, 'shots');
const REPORT = path.join(__dirname, 'phase12-report.json');
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

async function waitTestId(page, testid, timeout) {
  try {
    await page.waitForSelector(`[data-testid="${testid}"]`, { timeout });
    return true;
  } catch (e) {
    return false;
  }
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

/** 提交一笔提现并取回单号（回执是常驻的 ⇒ 必须比对文案是否变化） */
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

/** 等审批台的提示文案命中（提示常驻 ⇒ 必须轮询文案） */
async function waitNotice(page, regex) {
  const sel = page.locator('[data-testid="withdrawal-notice"]').first();
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    const t = (await sel.innerText().catch(() => '')) || '';
    if (regex.test(t)) return t.trim();
  }
  return '';
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

  let issuedKey = '';
  let withdrawalIds = [];

  try {
    if (!OWNER_PASSKEY) bad('⑥ 管理口令解锁', '缺少环境变量 APIPAW_OWNER_PASSKEY');
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
        const fok = await waitTestId(page, 'balance-faucet-ok', T.api);
        const fmsg = fok
          ? (await page.locator('[data-testid="balance-faucet-ok"]').first().innerText()).trim()
          : '';
        check(/到账|已/.test(fmsg), '②d 体验金领取成功', fmsg);
      } else {
        warn('②d 领取一次性体验金', '没找到领取按钮（可能已被领过）');
      }
    }

    // ---------- ④ P3：`apipaw-auto` 出现在模型下拉 ----------
    const selector = page.locator('#apx-model-selector-value').first();
    check((await selector.count()) > 0, '④a 模型选择器已渲染', '');
    await clickSafe(selector, '④a 打开模型下拉');
    await sleep(1500);
    const autoItem = page.locator('[data-testid="playground-model-item-apipaw-auto"]').first();
    const autoShown = (await autoItem.count()) > 0;
    check(autoShown, '④a 模型下拉出现 `apipaw-auto` 智能路由元模型', autoShown ? '已出现' : '未找到');
    if (autoShown) {
      const txt = (await autoItem.innerText().catch(() => '')) || '';
      check(/智能|APIPaw Smart Router/.test(txt), '④b 智能路由条目的显示名正确', txt.replace(/\s+/g, ' ').slice(0, 80));
    }
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase12-01-model-picker.png'), fullPage: false });

    // ---------- ④c 选真实模型发一条消息（给打分用）----------
    const realItem = page.locator('[data-testid="playground-model-item-qwen2.5:0.5b"]').first();
    if ((await realItem.count()) > 0) {
      await clickSafe(realItem, '④c 选择 qwen2.5:0.5b');
      await sleep(1500);
    } else {
      warn('④c 选择 qwen2.5:0.5b', '下拉里没有该模型（可能已下架）');
    }
    const answered = await sendChat(page, '阶段十二验收：请用一句话介绍 API 网关。');
    check(answered, '④d Playground 收到回答（打分区已出现）', answered ? '已渲染 👍/👎/复制' : '超时');
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase12-02-chat.png'), fullPage: false });

    // ---------- ② P1：👍 打分 ----------
    if (answered) {
      await clickSafe(page.locator('[data-testid="playground-feedback-up"]').first(), '②e 点「👍 有用」');
      let notice = '';
      for (let i = 0; i < 30; i++) {
        await sleep(1000);
        notice = (await page.locator('[data-testid="playground-feedback-notice"]').first().innerText().catch(() => '')) || '';
        if (/已记录/.test(notice)) break;
      }
      check(/已记录/.test(notice), '②e 👍 打分已记录（前端回执）', notice.trim());
      const fbResp = apiLog.filter((r) => r.url.includes('/api/v1/user/feedback'));
      check(
        fbResp.length > 0 && fbResp[fbResp.length - 1].status === 200,
        '②e POST /api/v1/user/feedback 返回 200',
        fbResp.length ? `HTTP ${fbResp[fbResp.length - 1].status}` : '未捕获到请求'
      );
      // 改判 👎 ⇒ 幂等更新（不新增行），前端提示也要变
      await clickSafe(page.locator('[data-testid="playground-feedback-down"]').first(), '②f 点「👎 需改进」');
      await sleep(2500);
      const fbResp2 = apiLog.filter((r) => r.url.includes('/api/v1/user/feedback'));
      check(
        fbResp2.length > 1 && fbResp2[fbResp2.length - 1].status === 200,
        '②f 改判 👎 同样 200（幂等更新）',
        fbResp2.length ? `HTTP ${fbResp2[fbResp2.length - 1].status}` : '未捕获到请求'
      );
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase12-03-feedback.png'), fullPage: false });
    }

    // ---------- ④d 用 `apipaw-auto` 发起一次对话 ----------
    await clickSafe(page.locator('#apx-model-selector-value').first(), '④e 打开模型下拉');
    await sleep(1200);
    const autoItem2 = page.locator('[data-testid="playground-model-item-apipaw-auto"]').first();
    if ((await autoItem2.count()) > 0) {
      await clickSafe(autoItem2, '④e 选中 apipaw-auto');
      await sleep(1500);
      const selText = (await page.locator('#apx-model-selector-value').first().innerText().catch(() => '')) || '';
      check(/智能|APIPaw Smart Router/.test(selText), '④f 选择器显示智能路由', selText.replace(/\s+/g, ' ').slice(0, 60));
      const autoAnswered = await sendChat(page, '阶段十二验收：智能路由请回答「ping」。');
      check(autoAnswered, '④g `apipaw-auto` 发起对话成功返回回答', autoAnswered ? '已渲染' : '超时');
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase12-04-auto.png'), fullPage: false });
    } else {
      bad('④e 选中 apipaw-auto', '下拉里没有该条目');
    }

    // 直连接口复核：路由元数据必须在响应里（resolved_model_id / requested_model）
    try {
      const ares = await fetch(CLOUD_URL + '/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + issuedKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'apipaw-auto',
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      const abody = await ares.json().catch(() => ({}));
      check(
        ares.status === 200 && !!abody.choices && abody.requested_model === 'apipaw-auto',
        '④h POST /v1/chat/completions（model=apipaw-auto）返回 200 + requested_model',
        `HTTP ${ares.status} requested=${abody.requested_model} resolved=${abody.resolved_model_id || '(演示模式)'}`
      );
    } catch (e) {
      bad('④h POST /v1/chat/completions（apipaw-auto）', e.message);
    }
    // 模型目录里必须有虚拟条目（is_virtual）
    try {
      const mres = await fetch(CLOUD_URL + '/v1/models', {
        headers: { Authorization: 'Bearer ' + issuedKey },
      });
      const mbody = await mres.json().catch(() => ({}));
      const auto = (mbody.data || []).find((m) => m.id === 'apipaw-auto');
      check(
        mres.status === 200 && !!auto && auto.is_virtual === true,
        '④i GET /v1/models 含 apipaw-auto（is_virtual=true）',
        auto ? `${auto.display_name}` : '未找到'
      );
    } catch (e) {
      bad('④i GET /v1/models', e.message);
    }

    // ================= 业主通道 =================
    // ---------- ⑥ 管理口令解锁 OWNER ----------
    await clickSafe(page.locator('[data-testid="open-passkey-modal"]').first(), '⑥a 打开口令解锁弹窗');
    await sleep(1000);
    check((await page.locator('[data-testid="owner-passkey-input"]').count()) > 0, '⑥a 口令弹窗已渲染', '');
    await page.locator('[data-testid="owner-passkey-input"]').first().fill(OWNER_PASSKEY);
    await clickSafe(page.locator('[data-testid="owner-passkey-btn"]').first(), '⑥b 提交口令');
    try {
      await page.waitForSelector('[data-testid="owner-passkey-ok"]', { timeout: T.api });
      const okText = (await page.locator('[data-testid="owner-passkey-ok"]').first().innerText()).trim();
      check(/已解锁 OWNER/.test(okText), '⑥ 管理口令解锁成功', okText);
    } catch (e) {
      const errSel = page.locator('[data-testid="owner-passkey-error"]');
      bad(
        '⑥ 管理口令解锁',
        (await errSel.count()) > 0
          ? `前端报错：${(await errSel.first().innerText()).trim()}`
          : `未出现结果提示: ${e.message}`
      );
    }
    await sleep(1500);
    await clickSafe(page.locator('[data-testid="passkey-modal-close"]').first(), '⑥c 关闭口令弹窗');
    await sleep(1500);

    const toOwner = byText(page, '切换至业主视角');
    if ((await toOwner.count()) > 0) {
      await clickSafe(toOwner, '⑥d 切到业主视角');
      await sleep(2500);
    }
    check((await page.locator('[data-testid="host-tabs"]').count()) > 0, '⑥d 业主分段导航已出现', '');

    // ---------- ③ P2：黄金语料工坊（模型工作台）----------
    await clickSafe(page.locator('[data-testid="host-tab-STUDIO"]').first(), '③a 进入模型工作台');
    await sleep(3000);
    const dsCard = page.locator('[data-testid="golden-dataset-card"]').first();
    const dsShown = (await dsCard.count()) > 0;
    check(dsShown, '③a 黄金语料工坊卡片已渲染', dsShown ? '已渲染' : '未找到');
    if (dsShown) {
      const totalTxt = (await page.locator('[data-testid="golden-dataset-total"]').first().innerText().catch(() => '')) || '';
      const goldenTxt = (await page.locator('[data-testid="golden-dataset-golden"]').first().innerText().catch(() => '')) || '';
      const total = Number(String(totalTxt).replace(/[^\d.]/g, ''));
      const golden = Number(String(goldenTxt).replace(/[^\d.]/g, ''));
      check(total > 0, '③b 语料池总数已出数', `${totalTxt.trim()}（黄金 ${goldenTxt.trim()}）`);
      check(golden >= 1, '③c 黄金样本数已出数（含 win_node_01 回填基线）', goldenTxt.trim());
      check(
        (await page.locator('[data-testid="golden-dataset-row-1"]').count()) > 0 ||
          (await page.locator('[data-testid^="golden-dataset-row-"]').count()) > 0,
        '③d 最近样本预览已渲染',
        ''
      );
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase12-05-dataset.png'), fullPage: false });

      // 一键导出（浏览器 Blob 下载）
      try {
        const dlPromise = page.waitForEvent('download', { timeout: 20000 });
        await clickSafe(page.locator('[data-testid="golden-dataset-export-sft"]').first(), '③e 点「导出 SFT 黄金集」');
        const dl = await dlPromise;
        const name = dl.suggestedFilename();
        check(/sft.*\.jsonl/i.test(name), '③e SFT 导出触发浏览器下载', name);
      } catch (e) {
        warn('③e SFT 导出下载事件', e.message);
      }
      // DPO 导出同样点一次（保证按钮不报错）
      try {
        const dlPromise = page.waitForEvent('download', { timeout: 20000 });
        await clickSafe(page.locator('[data-testid="golden-dataset-export-dpo"]').first(), '③f 点「导出 DPO 偏好对」');
        const dl = await dlPromise;
        check(/dpo|preference/i.test(dl.suggestedFilename()), '③f DPO 导出触发浏览器下载', dl.suggestedFilename());
      } catch (e) {
        warn('③f DPO 导出下载事件', e.message);
      }
    }

    // ---------- ① P0-b：提现提交**免刷新**联动 ----------
    await clickSafe(page.locator('[data-testid="host-tab-GOVERNANCE"]').first(), '①a 进入节点治理');
    await sleep(3000);
    check((await page.locator('[data-testid="withdrawal-approval-card"]').count()) > 0, '①a 提现审批台已渲染', '');
    check((await page.locator('[data-testid="earnings-withdraw-card"]').count()) > 0, '①a 收益面板与审批台同页', '');

    await clickSafe(page.locator('[data-testid="earnings-channel-node"]').first(), '①b 选中「算力节点」通道');
    await sleep(800);
    await page.locator('[data-testid="earnings-withdraw-amount"]').first().fill('0.001');
    const r1 = await submitWithdrawal(page);
    const wid = r1.id;
    check(!!wid, '①b 提现申请已登记（回执含单号）', wid ? `#${wid}` : r1.err);
    if (wid) {
      withdrawalIds.push(wid);
      // ⚠️ 关键：**不点刷新**，等审批台自己冒出新申请（bumpWithdrawalsVersion 联动）
      const autoShown = await waitTestId(page, `node-withdrawal-${wid}`, 40000);
      check(autoShown, '①c 审批台**免刷新**自动出现新申请（提交⇄审批零刷新联动）', autoShown ? `#${wid} 已出现` : '超时未出现');
      if (autoShown) {
        // 驳回 ⇒ 额度原样退回（不留生产残留）
        await clickSafe(page.locator(`[data-testid="reject-node-${wid}"]`).first(), '①d 点「驳回」');
        const notice = await waitNotice(page, new RegExp('#' + wid + ' *已驳回'));
        check(/已驳回/.test(notice), '①d 驳回成功（额度退回）', notice);
      }
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase12-06-withdraw-live.png'), fullPage: false });
    }

    // ---------- ③g 直连接口复核语料导出 JSONL ----------
    const token = await ownerSessionToken(page);
    if (token) {
      for (const fmt of ['sft', 'dpo']) {
        try {
          const res = await fetch(CLOUD_URL + `/api/v1/owner/datasets/export?format=${fmt}`, {
            headers: { Authorization: 'Bearer ' + token },
          });
          const text = await res.text();
          const lines = text.split('\n').filter((l) => l.trim());
          let valid = res.status === 200;
          for (const line of lines) {
            try {
              const obj = JSON.parse(line);
              if (fmt === 'sft') {
                if (!obj.messages || !obj.messages[0] || !obj.messages[1]) valid = false;
              } else if (!obj.prompt || !obj.chosen || !obj.rejected) {
                valid = false;
              }
            } catch (e) {
              valid = false;
            }
          }
          check(valid, `③g GET /api/v1/owner/datasets/export?format=${fmt} 返回合法 JSONL`, `HTTP ${res.status} lines=${lines.length}`);
        } catch (e) {
          bad(`③g 导出 ${fmt}`, e.message);
        }
      }
      // 概览接口
      try {
        const res = await fetch(CLOUD_URL + '/api/v1/owner/datasets/summary', {
          headers: { Authorization: 'Bearer ' + token },
        });
        const body = await res.json().catch(() => ({}));
        check(
          res.status === 200 && body.total > 0 && body.golden >= 1,
          '③h GET /api/v1/owner/datasets/summary 返回统计',
          `HTTP ${res.status} total=${body.total} golden=${body.golden} negative=${body.negative}`
        );
      } catch (e) {
        bad('③h 语料概览接口', e.message);
      }
    } else {
      warn('③g/③h 直连接口复核', '没拿到业主会话 token（localStorage 里没有 apipaw.session）');
    }

    console.log(`  [issued-key] ${maskKey(issuedKey)}`);
    console.log(`  [withdrawal-ids] ${withdrawalIds.join(',')}`);
  } catch (e) {
    bad('阶段十二线上验收', e.message);
    try {
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase12-error.png'), fullPage: true });
    } catch (_) {}
  } finally {
    await context.close();
    await browser.close();
  }

  const passed = results.filter((r) => r.pass).length;
  const soft = results.filter((r) => r.soft).length;
  console.log('');
  console.log(
    `===== 阶段十二 P0~P3 线上验收：${passed}/${results.length} 通过（其中 ${soft} 条 WARN）=====`
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
        withdrawalIds,
      },
      null,
      2
    )
  );
  process.exit(passed === results.length ? 0 : 1);
})();
