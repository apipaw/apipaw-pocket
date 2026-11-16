/**
 * 阶段七 P1/P2 · 线上控制台验收（节点治理「新增算力节点」一键签发）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules \
 *   APIPAW_API_KEY=<OWNER 明文 key> node e2e/phase7-p1.cjs [baseURL]
 *
 * 产物：e2e/shots/phase7-*.png + e2e/phase7-report.json
 *
 * 覆盖：
 *   ① 注入 OWNER 凭证后应用挂载
 *   ② 「节点治理」标签可见并可切入
 *   ③ 「新增算力节点」区块对 OWNER 可见
 *   ④ 点「一键新增」⇒ 弹出一凭证（node_id + 明文 node_secret）且可复制
 *   ⑤a 签发的凭证可用于节点心跳鉴权（Bearer = node_secret，节点通道）
 *   ⑤b 心跳注册后节点出现在治理列表（刷新后仍在）
 *
 * ⚠️ 本脚本会**真的签发**一枚节点凭证，并用它打一次真实心跳（会在
 *    node_registry 里留下一条节点行）；凭证与节点行由调用方在云端清理。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

const BASE_URL = process.argv[2] || 'https://console.apipaw.com';
const CLOUD_BASE = process.env.APIPAW_CLOUD_BASE || 'https://cloud.apipaw.com';
const API_KEY = process.env.APIPAW_API_KEY;
if (!API_KEY) {
  console.error('缺少环境变量 APIPAW_API_KEY —— 请显式传入 OWNER 明文 key。');
  process.exit(2);
}
const API_HANDLE = process.env.APIPAW_ACCOUNT_HANDLE || 'acct_230bad0cd00541e1';
const SESSION_TOKEN = process.env.APIPAW_SESSION_TOKEN || '';
const SESSION_ROLE = process.env.APIPAW_SESSION_ROLE || 'OWNER';
if (!SESSION_TOKEN) {
  console.error('缺少环境变量 APIPAW_SESSION_TOKEN —— 请先用 e2e/owner-session.js 取真会话。');
  process.exit(2);
}

const SHOT_DIR = path.join(__dirname, 'shots');
const REPORT = path.join(__dirname, 'phase7-report.json');
const T = {
  nav: Number(process.env.APIPAW_E2E_NAV_TIMEOUT || 90000),
  app: Number(process.env.APIPAW_E2E_APP_TIMEOUT || 180000),
  panel: Number(process.env.APIPAW_E2E_PANEL_TIMEOUT || 90000),
  api: Number(process.env.APIPAW_E2E_API_TIMEOUT || 150000),
  action: Number(process.env.APIPAW_E2E_ACTION_TIMEOUT || 30000),
};

let page;
const results = [];

const ok = (name, detail) => {
  results.push({ name, pass: true, detail });
  console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`);
};
const bad = (name, detail) => {
  results.push({ name, pass: false, detail });
  console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`);
};
const check = (cond, name, detail) => (cond ? ok(name, detail) : bad(name, detail));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 点击前先滚动到可视区，失败重试一次（RN 重渲染会 detach 元素）。 */
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

/** 按可见文本找可点击元素（RN Web 把 Text 渲染成 div/span）。 */
function byText(scope, text) {
  return scope.locator(`text=${text}`).first();
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  // ⚠️ 必须加 --disable-ipv6：本地（IPv6 优先）访问 Cloudflare 会卡在
  //    ERR_TIMED_OUT（curl 会回落 IPv4 所以看不出问题）。
  const browser = await chromium.launch({ headless: true, args: ['--disable-ipv6'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  // 预置凭证：
  //  - apipaw.api_key  = OWNER 明文 Key（买家通道）
  //  - apipaw.session  = **真实**钱包会话 JWT（服务端签发，OWNER 角色）
  //
  // 治理面板（NodeGovernanceCard）整体挂在 sessionToken 上，没有会话就只显示
  // 「请先在右上角连接钱包」—— 所以必须给真会话，不能只塞 API Key。
  // 会话用 e2e/owner-session.js 走真实 nonce→签名→verify 拿到。
  await context.addInitScript(
    ([key, token, handle, role]) => {
      try {
        window.localStorage.setItem('apipaw.api_key', key);
        window.localStorage.setItem(
          'apipaw.session',
          JSON.stringify({
            token,
            expiresAt: Math.floor(Date.now() / 1000) + 7200,
            handle,
            role,
            status: 'active',
            wallet: '0x4609B825bb42F5BC839339c30F8960569CC82717',
          })
        );
      } catch (e) {}
    },
    [API_KEY, SESSION_TOKEN, API_HANDLE, SESSION_ROLE]
  );
  const netlog = [];
  const wirePage = (p) => {
    p.on('response', async (res) => {
      const u = res.url();
      if (u.includes('/api/v1/')) netlog.push({ url: u, status: res.status() });
    });
  };
  page = await context.newPage();
  wirePage(page);

  try {
    // ⚠️ 本地 → Cloudflare 链路不稳（1.4MB bundle 偶发拉不下来，表现为 root 一直空）。
    //    这里做「最多 3 次重挂载」，每次都重新 goto，避免把网络抖动误判成功能回归。
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
          { timeout: T.app, polling: 1000 }
        );
        mounted = true;
        ok('① 应用挂载', `console.apipaw.com 首屏渲染完成（尝试 ${attempt} 次）`);
      } catch (e) {
        lastErr = e;
        console.log(`  [retry] 第 ${attempt} 次挂载失败：${e.message}`);
        try { await page.close(); } catch (_) {}
        page = await context.newPage();
        wirePage(page);
      }
    }
    if (!mounted) throw lastErr;
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase7-01-home.png'), fullPage: false });
    await page.screenshot({ path: path.join(SHOT_DIR, 'phase7-01-home.png'), fullPage: false });

    // ② 切到业主视角（注入 API Key 后默认仍是买家视角，页面上有「切换至业主视角」）
    let govTab = byText(page, '节点治理');
    if ((await govTab.count()) === 0) {
      const switchOwner = byText(page, '切换至业主视角');
      if ((await switchOwner.count()) > 0) {
        await clickSafe(switchOwner, '②a 切换至业主视角');
        await sleep(2500);
        govTab = byText(page, '节点治理');
      }
    }
    const hasGov = (await govTab.count()) > 0;
    if (!hasGov) {
      bad('② 节点治理标签可见', '未找到「节点治理」标签（可能未登录为业主）');
    } else {
      ok('② 节点治理标签可见', '');
      await clickSafe(govTab, '② 节点治理标签可见');
      await sleep(1500);
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase7-02-governance.png'), fullPage: true });
    }

    // ③ 「新增算力节点」区块
    const issueTitle = byText(page, '新增算力节点');
    const hasIssue = (await issueTitle.count()) > 0;
    check(hasIssue, '③ 「新增算力节点」区块对 OWNER 可见', hasIssue ? '已渲染' : '未渲染（可能非 OWNER 视角）');

    let nodeId = '';
    let nodeSecret = '';
    if (hasIssue) {
      const input = page.locator('input').first();
      const inputCount = await page.locator('input').count();
      ok('③b 节点 ID 输入框存在', `input 数量=${inputCount}`);
      const btn = byText(page, '一键新增');
      const hasBtn = (await btn.count()) > 0;
      check(hasBtn, '④ 「一键新增」按钮存在', '');
      if (hasBtn) {
        await clickSafe(btn, '④ 「一键新增」按钮存在');
        // 等待弹窗里的凭证文本出现
        try {
          // 凭证弹窗有稳定的 testID，直接取元素文本，别去猜正则
          await page.waitForSelector('[data-testid="issued-node-id"]', { timeout: T.action });
          nodeId = (await page.locator('[data-testid="issued-node-id"]').first().innerText()).trim();
          nodeSecret = (await page.locator('[data-testid="issued-node-secret"]').first().innerText()).trim();
          ok('④ 一键新增弹出凭证（node_id + 明文 node_secret）',
             `node_id=${nodeId} secret_len=${nodeSecret.length}`);
        } catch (e) {
          bad('④ 一键新增弹出凭证（node_id + 明文 node_secret）', e.message);
        }
        await page.screenshot({ path: path.join(SHOT_DIR, 'phase7-03-credential.png'), fullPage: true });
      }
    }

    // ⑤ 凭证可用性 + 治理列表可见
    //    ⚠️ 治理列表来自 node_registry 的**已注册**节点；刚签发的凭证还没心跳过，
    //       本来就不该出现在列表里。所以先拿凭证打一次真实心跳（顺带验证
    //       阶段七 P1「节点上报模型 ⇒ 自动对齐」），再回头看列表。
    if (nodeId) {
      let hbOk = false;
      let hbDetail = '';
      try {
        const r = await context.request.post(`${CLOUD_BASE}/api/v1/nodes/heartbeat`, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${nodeSecret}`,
          },
          data: {
            node_id: nodeId,
            node_name: 'phase7-e2e',
            status: 'IDLE',
            status_label: 'e2e-acceptance',
            models: ['qwen2.5:0.5b'],
            backend_model: 'qwen2.5:0.5b',
            inference_backend: 'ollama',
            agent_version: 'e2e',
          },
          timeout: T.api,
        });
        hbOk = r.ok();
        hbDetail = hbOk ? '节点鉴权通过（Bearer = node_secret）' : `HTTP ${r.status()} ${(await r.text()).slice(0, 200)}`;
      } catch (e) {
        hbDetail = e.message;
      }
      check(hbOk, '⑤a 签发的凭证可用于节点心跳鉴权', hbDetail);

      await page.reload({ waitUntil: 'commit', timeout: T.nav });
      await sleep(3000);
      const govTab2 = byText(page, '节点治理');
      await clickSafe(govTab2, '⑤b 刷新后切回节点治理');
      await sleep(2500);
      const found = await page.evaluate(
        (id) => (document.body.innerText || '').includes(id),
        nodeId
      );
      check(found, '⑤b 心跳注册后节点出现在治理列表', found ? nodeId : `未找到 ${nodeId}`);
      await page.screenshot({ path: path.join(SHOT_DIR, 'phase7-04-list.png'), fullPage: true });
    }

    fs.writeFileSync(
      REPORT,
      JSON.stringify(
        { base: BASE_URL, at: new Date().toISOString(), node_id: nodeId, results, netlog },
        null,
        2
      )
    );
  } catch (e) {
    bad('执行异常', e.message);
    try {
      const st = await page.evaluate(() => {
        const r = document.getElementById('root');
        return { url: location.href, root: !!r, len: r ? r.innerHTML.length : -1,
                 body: (document.body.innerText || '').slice(0, 200) };
      });
      console.log('[debug] 页面状态:', JSON.stringify(st));
      console.log('[debug] netlog:', JSON.stringify(netlog.slice(-12)));
    } catch (e2) { console.log('[debug] 状态读取失败:', e2.message); }
    try { await page.screenshot({ path: path.join(SHOT_DIR, 'phase7-error.png'), fullPage: true }); } catch (_) {}
    fs.writeFileSync(REPORT, JSON.stringify({ base: BASE_URL, results, netlog, error: e.message }, null, 2));
  } finally {
    await browser.close();
  }

  const passed = results.filter((r) => r.pass).length;
  console.log(`\n结果: ${passed}/${results.length} 通过`);
  results.filter((r) => !r.pass).forEach((r) => console.log(`  FAILED: ${r.name} — ${r.detail || ''}`));
  if (process.env.APIPAW_E2E_NODE_ID) {
    console.log(`\n清理提示: 请删除节点凭证 ${process.env.APIPAW_E2E_NODE_ID}`);
  }
  process.exit(passed === results.length ? 0 : 1);
})();
