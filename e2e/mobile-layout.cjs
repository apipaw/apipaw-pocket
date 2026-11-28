/**
 * APIPaw Pocket —— 手机端布局体检 / 防碰撞回归
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/mobile-layout.cjs [url]
 *
 * 本地 hermetic：拦截 cloud.apipaw.com 的全部请求返回假数据，不碰线上、不写生产。
 *
 * 检测三类问题（全部用 DOM getBoundingClientRect() 程序化判定，不靠肉眼）：
 *   ① 元素重叠碰撞 —— 兄弟文本节点互相压字
 *   ② 页面横向溢出 —— scrollWidth > clientWidth / 元素右边界越出视口
 *   ③ 文字溢出父容器 —— 子元素右边界越出父卡片内边界
 *
 * 覆盖：买家长页 + 业主 4 个 Tab + 核心弹窗。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIST = process.env.APIPAW_DIST || path.join(__dirname, '..', 'dist');
const SHOT_DIR = path.join(__dirname, 'shots');
const REPORT = path.join(__dirname, 'mobile-layout-report.json');
const EXTERNAL_URL = process.argv[2] || '';

const VIEWPORTS = [
  { name: 'iphone12', width: 390, height: 844 },
  { name: 'iphone-se', width: 375, height: 812 },
];

/** 视口宽度上限（CSS px）—— 超过它认为是桌面视口 */
const DESKTOP_WIDTH = 768;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function startStaticServer() {
  const root = path.resolve(DIST);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(root, urlPath);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(root, 'index.html');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ *
 * 假数据：让所有卡片都渲染出**有内容**的样子（空态测不出溢出）
 * ------------------------------------------------------------------ */
const NODE_ID = 'apipaw-cloud-node-01-long-identifier';
function mockResponse(pathname, method, body) {
  const json = (obj, status = 200) => ({ status, obj });
  switch (`${method} ${pathname}`) {
    case 'GET /api/v1/user/usage':
      return json({
        api_key: 'paw_layout_audit_key',
        balance_usd: 999.99,
        daily_limit_usd: 500,
        spent_today_usd: 3.25,
        usd_to_cgas: 100,
      });
    case 'GET /api/v1/network/health':
      return json({
        online_nodes: 12,
        dispatchable_nodes: 9,
        servable_models: 4,
        total_nodes: 15,
        status: 'healthy',
      });
    case 'GET /api/v1/owner/dashboard':
      return json({
        active_nodes_online: 12,
        registered_nodes_total: 15,
        nodes: [
          {
            node_id: NODE_ID,
            is_paused: false,
            total_tokens_processed: 12345678,
            total_earnings_paw: 12.3456,
            model: 'deepseek-ai/DeepSeek-V3',
          },
        ],
      });
    case 'GET /api/v1/owner/revenue':
      return json({
        nodes_total: 2,
        total_earnings_paw: 88.8888,
        total_tokens_processed: 987654321,
        nodes: [
          {
            node_id: NODE_ID,
            total_tokens_processed: 987654321,
            total_earnings_paw: 88.8888,
            is_paused: false,
          },
        ],
      });
    case 'GET /api/v1/owner/earnings/summary':
      return json({
        node_earn_usd: 25.5,
        creator_royalty_usd: 4.25,
        platform_fee_usd: 4.25,
        total_usd: 34,
        total_cgas: 3400,
      });
    case 'GET /api/v1/settlement/feed':
      return json({
        items: Array.from({ length: 6 }, (_, i) => ({
          id: `settle-${i}`,
          node_id: NODE_ID,
          model: 'deepseek-ai/DeepSeek-V3',
          total_usd: 0.0123,
          node_earn_usd: 0.0074,
          creator_royalty_usd: 0.0025,
          platform_fee_usd: 0.0025,
          created_at: '2026-11-28T00:00:00Z',
        })),
      });
    case 'GET /api/v1/user/analytics':
      return json({
        window_hours: 24,
        generated_at: Date.now(),
        hours: Array.from({ length: 24 }, (_, i) => ({
          index: i,
          start_ts: Date.now() - (24 - i) * 3600_000,
          label: `${String(i).padStart(2, '0')}:00`,
          prompt_tokens: 1000 + i * 10,
          completion_tokens: 500 + i * 5,
          cost_usd: 0.01 + i * 0.001,
          requests: 3 + i,
        })),
        tiers: [],
        models: [],
        settlement: {
          node_earn_usd: 0.25,
          creator_royalty_usd: 0.04,
          platform_fee_usd: 0.04,
          total_usd: 0.33,
          total_cgas: 33,
        },
        totals: {
          prompt_tokens: 2000,
          completion_tokens: 1000,
          total_tokens: 3000,
          cost_usd: 0.33,
          cgas: 33,
          requests: 6,
        },
      });
    case 'GET /v1/models':
      return json({ object: 'list', data: [] });
    case 'GET /api/v1/creator/models':
      return json({ object: 'list', data: [] });
    case 'GET /api/v1/creator/royalty':
      return json({
        creator_id: 'audit-creator',
        creator_name: '审计创作者',
        author_wallet: '0xaudit',
        royalty_rate: 0.15,
        window_hours: 24,
        models: [],
        totals: {
          calls: 12,
          prompt_tokens: 1000,
          completion_tokens: 500,
          total_tokens: 1500,
          royalty_usd: 1.25,
          royalty_paw: 2.5,
        },
        available_usd: 12.5,
        available_paw: 3.5,
        withdrawn_usd: 1.25,
        withdrawn_paw: 0.5,
        hours: [],
        withdrawals: [],
      });
    case 'GET /api/v1/creator/topology':
    case 'GET /api/v1/creator/topology/':
      return json({ object: 'list', data: [] });
    case 'GET /api/v1/creator/earnings':
      return json({ rows: [], total_usd: 0, wallet: '0xaudit' });
    case 'GET /api/v1/network/leaderboard':
      return json({
        rows: Array.from({ length: 5 }, (_, i) => ({
          rank: i + 1,
          node_id: NODE_ID,
          tokens: 987654321,
          earnings_paw: 88.8888,
        })),
      });
    case 'GET /api/v1/node/consensus':
      return json({ quorum: 0, accepted: 0, rejected: 0, pending: 0, receipts: [] });
    case 'GET /api/v1/ledger/state-root':
      return json({ state_root: '0x' + 'a'.repeat(64), anchor_status: 'anchored' });
    case 'GET /api/v1/pricing/default':
      return json({
        prompt_price_per_1k: 0.01,
        completion_price_per_1k: 0.02,
        min_price_per_1k: 0.001,
        max_price_per_1k: 0.1,
      });
    case 'GET /api/v1/creator/models/pricing/requests':
    case 'GET /api/v1/owner/pricing/requests':
    case 'GET /api/v1/creator/royalty/requests':
    case 'GET /api/v1/owner/royalty/requests':
      return json({ requests: [] });
    case 'GET /api/v1/earnings/summary':
      return json({
        status: 'ok',
        node: null,
        creator: null,
        note: '',
        limit: 20,
      });
    default:
      // 兜底：把常见的「列表字段」补齐，避免组件因字段缺失整页崩掉
      return json(
        {
          detail: 'mocked',
          rows: [],
          items: [],
          data: [],
          nodes: [],
          hours: [],
          tiers: [],
          models: [],
          tasks: [],
          proposals: [],
          receipts: [],
          settlements: [],
          requests: [],
          entries: [],
          records: [],
          withdrawals: [],
          manifests: [],
          invoices: [],
          deposits: [],
          totals: {
            calls: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            cost_usd: 0,
            cgas: 0,
            requests: 0,
            royalty_usd: 0,
            royalty_paw: 0,
          },
        },
        200,
      );
  }
}

/* ------------------------------------------------------------------ *
 * 页面内体检逻辑（在浏览器上下文执行）
 * ------------------------------------------------------------------ */
function auditInPage() {
  const issues = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const isVisible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return false;
    if (r.width <= 0 || r.height <= 0) return false;
    return true;
  };

  /** 最近的有 id 的祖先（RNW 把 RN 的 id prop 映射成 DOM id）——用来定位问题属于哪张卡片 */
  const ownerId = (el) => {
    let n = el;
    for (let i = 0; i < 12 && n && n.nodeType === 1; i++) {
      const id = n.getAttribute && n.getAttribute('id');
      if (id) return id;
      n = n.parentElement;
    }
    return '';
  };
  const short = (el) => {
    const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
    const id = el.getAttribute('id');
    const tid = el.getAttribute('data-testid');
    const tag = el.tagName.toLowerCase();
    const own = id ? '#' + id : tid ? '[' + tid + ']' : '';
    const chain = own ? '' : ` @${ownerId(el)}`;
    return `${tag}${own}${chain} "${t.slice(0, 40)}"`;
  };

  /** 叶子文本元素：自身有文字，且不含元素子节点 */
  const leafTexts = Array.from(document.querySelectorAll('*')).filter((el) => {
    if (!isVisible(el)) return false;
    const hasText = Array.from(el.childNodes).some(
      (n) => n.nodeType === 3 && n.textContent.trim().length > 0,
    );
    if (!hasText) return false;
    const hasElementChild = Array.from(el.children).some((c) => {
      const cs = getComputedStyle(c);
      return cs.display !== 'none' && cs.visibility !== 'hidden';
    });
    return !hasElementChild;
  });

  /* ---------- ① 文本重叠碰撞 ---------- */
  const overlapArea = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
    const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 1 && h > 1 ? w * h : 0;
  };
  /**
   * 命中测试：重叠点上**最上层**渲染的是谁？
   * 只有「最上层就是 a 或 b 本身/其子节点」才算真重叠；
   * 若最上层是别的元素（弹窗遮罩、Toast 等浮层盖住了两者），
   * 那只是正常层叠关系，不是布局 Bug。
   */
  const topmostOwns = (a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    const l = Math.max(ra.left, rb.left);
    const r2 = Math.min(ra.right, rb.right);
    const t = Math.max(ra.top, rb.top);
    const bo = Math.min(ra.bottom, rb.bottom);
    const cx = Math.round((r2 + l) / 2);
    const cy = Math.round((bo + t) / 2);
    if (!Number.isFinite(cx) || !Number.isFinite(cy)) return false;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit) return false;
    return a.contains(hit) || b.contains(hit);
  };

  /**
   * 层叠上下文：**浮层**（position:fixed 的弹窗 / Toast）与页面正文不在同一层，
   * 它们的矩形天然会相交，但那是「浮层盖住正文」的正常层叠，不是碰撞。
   */
  const layerOf = (el) => {
    let n = el;
    while (n && n !== document.body && n.nodeType === 1) {
      if (getComputedStyle(n).position === 'fixed') return n;
      n = n.parentElement;
    }
    return document.body;
  };
  for (let i = 0; i < leafTexts.length; i++) {
    for (let j = i + 1; j < leafTexts.length; j++) {
      const a = leafTexts[i];
      const b = leafTexts[j];
      if (a.contains(b) || b.contains(a)) continue;
      if (layerOf(a) !== layerOf(b)) continue; // 不同层叠上下文（浮层 vs 正文）不算碰撞
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const area = overlapArea(ra, rb);
      if (area > 6 && topmostOwns(a, b)) {
        issues.push({
          kind: 'overlap',
          a: short(a),
          b: short(b),
          detail: `重叠面积 ${Math.round(area)}px²`,
        });
      }
    }
  }

  /* ---------- ② 横向溢出 ---------- */
  const doc = document.scrollingElement || document.documentElement;
  if (doc.scrollWidth > vw + 1) {
    issues.push({
      kind: 'page-overflow',
      a: 'document',
      b: '',
      detail: `scrollWidth=${doc.scrollWidth} > viewport=${vw}`,
    });
  }
  const root = document.getElementById('root');
  if (root && root.scrollWidth > vw + 1) {
    issues.push({
      kind: 'page-overflow',
      a: '#root',
      b: '',
      detail: `scrollWidth=${root.scrollWidth} > viewport=${vw}`,
    });
  }
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (!isVisible(el)) continue;
    const cs = getComputedStyle(el);
    const ox = cs.overflowX;
    if (ox === 'auto' || ox === 'scroll') continue; // 允许横向滚动容器
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') continue; // 表单控件自带内部滚动
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      // 只报**最内层**溢出元素 —— 父容器溢出通常是子元素溢出传导的
      const hasOverflowingChild = Array.from(el.children).some(
        (c) =>
          getComputedStyle(c).overflowX !== 'auto' &&
          getComputedStyle(c).overflowX !== 'scroll' &&
          c.scrollWidth > c.clientWidth + 1 &&
          c.clientWidth > 0,
      );
      if (hasOverflowingChild) continue;
      issues.push({
        kind: 'overflow-x',
        a: short(el),
        b: '',
        detail: `scrollWidth=${el.scrollWidth} > clientWidth=${el.clientWidth}`,
      });
    }
  }

  /* ---------- ③ 越出视口右边界 ---------- */
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (!isVisible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1) {
      // 只报"最外层"越界元素，避免父子重复刷屏
      const parent = el.parentElement;
      if (parent) {
        const pr = parent.getBoundingClientRect();
        if (pr.right > vw + 1) continue;
      }
      issues.push({
        kind: 'out-of-viewport',
        a: short(el),
        b: '',
        detail: `right=${Math.round(r.right)} > viewport=${vw}`,
      });
    }
  }

  /* ---------- ④ 子元素越出父卡片内边界 ---------- */
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (!isVisible(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    const parent = el.parentElement;
    if (!parent) continue;
    const pcs = getComputedStyle(parent);
    if (pcs.overflowX === 'auto' || pcs.overflowX === 'scroll' || pcs.overflow === 'hidden') continue;
    const pr = parent.getBoundingClientRect();
    if (pr.width < 8 || pr.height < 8) continue;
    // 父卡片自身的 paddingRight 允许内容触边，只在**明显**越界时报告
    if (r.right > pr.right + 2) {
      const hasText = (el.textContent || '').trim().length > 0;
      if (!hasText) continue;
      issues.push({
        kind: 'escape-parent',
        a: short(el),
        b: short(parent),
        detail: `child.right=${Math.round(r.right)} > parent.right=${Math.round(pr.right)}`,
      });
    }
  }

  return { issues, vw, vh };
}

/* ------------------------------------------------------------------ *
 * 页面驱动
 * ------------------------------------------------------------------ */
/**
 * 稳健点击：RNW 的按钮在窄屏可能互相压住（正是本脚本要查的 Bug），
 * 普通 click 会因「被别的元素拦截」而超时 —— 这里退化为 force 点击，
 * 保证体检能继续跑完后面的段落，而不是中途崩掉。
 */
async function safeClick(locator, timeout = 8000) {
  try {
    await locator.click({ timeout });
    return true;
  } catch (e) {
    try {
      await locator.click({ timeout: 3000, force: true });
      return true;
    } catch (e2) {
      console.log(`  [warn] 点击失败（跳过）: ${String(e2.message).split('\n')[0]}`);
      return false;
    }
  }
}

async function scrollThrough(page) {
  // 触发懒挂载卡片（IntersectionObserver）
  for (let i = 0; i < 14; i++) {
    await page.mouse.wheel(0, 900);
    await sleep(180);
  }
  await page.evaluate(() => {
    const sv = Array.from(document.querySelectorAll('*')).find((el) => {
      const cs = getComputedStyle(el);
      return (
        (cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
        el.scrollHeight > el.clientHeight + 40
      );
    });
    if (sv) sv.scrollTop = 0;
  });
  await sleep(600);
}

async function auditSection(page, name, issuesOut) {
  const res = await page.evaluate(auditInPage);
  for (const it of res.issues) {
    issuesOut.push({ section: name, ...it });
  }
  return res;
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const server = EXTERNAL_URL ? null : await startStaticServer();
  const base = EXTERNAL_URL || `http://127.0.0.1:${server.address().port}/`;
  console.log(`站点: ${base}`);

  const browser = await chromium.launch({ headless: true });
  const report = { base, generated_at: new Date().toISOString(), viewports: [] };
  let total = 0;

  for (const vp of VIEWPORTS) {
    console.log(`\n================ 视口 ${vp.name} ${vp.width}x${vp.height} ================`);
    const context = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      locale: 'zh-CN',
    });
    await context.addInitScript(() => {
      try {
        window.localStorage.setItem('apipaw.api_key', 'paw_layout_audit_key');
      } catch (e) {}
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    const requests = [];
    await page.route('**://cloud.apipaw.com/**', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      let body = null;
      try {
        body = req.postDataJSON();
      } catch (e) {}
      requests.push(`${req.method()} ${u.pathname}`);
      const { status, obj } = mockResponse(u.pathname, req.method(), body);
      await route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify(obj),
      });
    });

    const issues = [];
    await page.goto(base, { waitUntil: 'commit', timeout: 90000 });
    await page.waitForSelector('text=APIPaw Pocket', { timeout: 90000 });
    await sleep(2500);

    // ---- 买家长页 ----
    await scrollThrough(page);
    await auditSection(page, 'buyer', issues);
    await page.screenshot({
      path: path.join(SHOT_DIR, `mobile-${vp.name}-buyer.png`),
      fullPage: false,
    });

    // ---- 业主 4 个 Tab ----
    await safeClick(page.locator('[data-testid="switch-role"]'));
    await sleep(1200);
    for (const tab of ['NODES', 'STUDIO', 'ROYALTY', 'GOVERNANCE']) {
      const btn = page.locator(`[data-testid="host-tab-${tab}"]`);
      if ((await btn.count()) === 0) continue;
      await btn.scrollIntoViewIfNeeded();
      await safeClick(btn);
      await sleep(1500);
      await scrollThrough(page);
      await auditSection(page, `owner-${tab}`, issues);
      await page.screenshot({
        path: path.join(SHOT_DIR, `mobile-${vp.name}-owner-${tab}.png`),
        fullPage: false,
      });
    }

    // ---- 弹窗 ----
    for (const [name, testid] of [
      ['modal-key', 'open-key-modal'],
      ['modal-passkey', 'open-passkey-modal'],
    ]) {
      const btn = page.locator(`[data-testid="${testid}"]`);
      if ((await btn.count()) === 0) continue;
      await btn.scrollIntoViewIfNeeded();
      if (!(await safeClick(btn))) continue;
      await sleep(1200);
      await auditSection(page, name, issues);
      await page.screenshot({
        path: path.join(SHOT_DIR, `mobile-${vp.name}-${name}.png`),
        fullPage: false,
      });
      // 关闭弹窗
      const closers = [
        '[data-testid="api-key-clear"]',
        '[data-testid="passkey-modal-close"]',
        '[data-testid="wallet-modal-close"]',
      ];
      for (const c of closers) {
        const el = page.locator(c);
        if ((await el.count()) > 0) {
          try {
            await el.first().click({ timeout: 3000 });
            await sleep(400);
          } catch (e) {}
        }
      }
      // 「取消」/「关闭」文本按钮兜底
      for (const t of ['取消', '关闭']) {
        const el = page.locator(`text=${t}`);
        if ((await el.count()) > 0) {
          try {
            await el.first().click({ timeout: 3000 });
            await sleep(400);
            break;
          } catch (e) {}
        }
      }
    }

    if (pageErrors.length) {
      issues.push({
        section: 'runtime',
        kind: 'js-error',
        a: 'pageerror',
        b: '',
        detail: pageErrors.join(' | '),
      });
    }
    if (process.env.APIPAW_LAYOUT_DEBUG) {
      console.log('  [req]', [...new Set(requests)].join('\n         '));
    }


    total += issues.length;
    report.viewports.push({ viewport: vp, issues, requests: [...new Set(requests)] });
    console.log(`  问题数: ${issues.length}`);
    await context.close();
  }

  await browser.close();
  if (server) server.close();

  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

  console.log('\n================ 问题清单 ================');
  for (const v of report.viewports) {
    console.log(`\n[${v.viewport.name} ${v.viewport.width}x${v.viewport.height}]`);
    if (!v.issues.length) console.log('  （无）');
    for (const it of v.issues) {
      console.log(`  - [${it.kind}] (${it.section}) ${it.a} ${it.b} — ${it.detail}`);
    }
  }
  console.log(`\n报告: ${REPORT}`);
  console.log(`总计问题: ${total}`);
  process.exit(total ? 1 : 0);
}

if (require.main === module) {
  main().catch((e) => {
    console.error('测试异常:', e);
    process.exit(2);
  });
}

module.exports = { mockResponse, auditInPage, VIEWPORTS };
