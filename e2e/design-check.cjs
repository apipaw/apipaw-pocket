/**
 * APIPaw Pocket —— 暗黑科幻主题层验收
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/design-check.cjs
 *
 * 本地起静态服务器服务 dist/，用 Playwright 打开页面，断言：
 *   1. Web 专属 CSS 层已注入（style[data-apipaw-theme]）
 *   2. 关键 Web 钩子元素存在（id 前缀：apx-root / apx-glass / apx-grad-text / apx-term）
 *   3. 计算样式确实生效（backdrop-filter / 渐变背景 / 渐变文字）
 *   4. 旧的通栏警告条与整行红色大按钮已消失，改为 Toast + Toggle
 * 产物：e2e/shots/design-*.png + 终端 JSON 报告
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const DIST = path.join(__dirname, '..', 'dist');
const SHOT_DIR = path.join(__dirname, 'shots');
const API_KEY = process.env.APIPAW_API_KEY || 'paw_demo_key';
// 可选：直接对已启动的地址做验收（开发服务器 / 线上站点），跳过本地静态服务器
const EXTERNAL_URL = process.argv[2] || '';

const results = [];
const check = (cond, name, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

function serve(root) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent((req.url || '/').split('?')[0]);
      let file = path.join(root, url === '/' ? 'index.html' : url);
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(root, 'index.html'); // SPA fallback
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function main() {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const server = EXTERNAL_URL ? null : await serve(DIST);
  const port = server ? server.address().port : 0;
  const base = EXTERNAL_URL || `http://127.0.0.1:${port}`;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' });
  await context.addInitScript(
    ([key]) => {
      try {
        window.localStorage.setItem('apipaw.api_key', key);
      } catch (e) {}
    },
    [API_KEY],
  );
  const page = await context.newPage();
  const pageErrors = [];
  const netlog = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('response', (res) => {
    const u = res.url();
    if (!u.includes('cloud.apipaw.com')) return;
    try {
      netlog.push({ path: new URL(u).pathname, status: res.status() });
    } catch (e) {}
  });

  console.log(`\n[1] 打开 ${base}`);
  await page.goto(base, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForSelector('text=APIPaw Pocket', { timeout: 45000 });
  await page.waitForTimeout(2500);

  // ---- 1. Web 主题层注入 ----
  console.log('\n[2] Web 主题层');
  const hasTheme = await page.locator('style[data-apipaw-theme]').count();
  check(hasTheme === 1, 'style[data-apipaw-theme] 已注入', `count=${hasTheme}`);

  // ---- 2. 关键钩子元素 ----
  console.log('\n[3] Web 钩子元素');
  const hooks = {
    'apx-root': '#apx-root',
    'apx-grid': '#apx-grid',
    'apx-header': '#apx-header',
    'apx-grad-border-balance': '#apx-grad-border-balance',
    'apx-grad-text-balance': '#apx-grad-text-balance',
    'apx-term': '#apx-term',
    'apx-glass-playground': '#apx-glass-playground',
  };
  for (const [name, sel] of Object.entries(hooks)) {
    const n = await page.locator(sel).count();
    check(n >= 1, `钩子 ${name} 存在`, `count=${n}`);
  }

  // ---- 3. 计算样式生效 ----
  console.log('\n[4] 计算样式');
  const balance = await page.evaluate(() => {
    const el = document.querySelector('#apx-grad-border-balance');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { bgImage: cs.backgroundImage, border: cs.borderTopColor };
  });
  check(
    !!balance && balance.bgImage.includes('linear-gradient'),
    '余额卡渐变描边生效',
    balance ? balance.bgImage.slice(0, 60) : '元素缺失',
  );

  const value = await page.evaluate(() => {
    const el = document.querySelector('#apx-grad-text-balance');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { clip: cs.webkitBackgroundClip || cs.backgroundClip, color: cs.color };
  });
  check(
    !!value && String(value.clip).includes('text'),
    '余额数字渐变文字生效',
    value ? `clip=${value.clip}` : '元素缺失',
  );

  const term = await page.evaluate(() => {
    const el = document.querySelector('#apx-term');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { shadow: cs.boxShadow, bg: cs.backgroundColor };
  });
  check(
    !!term && term.shadow.includes('inset'),
    '终端内阴影生效',
    term ? term.shadow.slice(0, 70) : '元素缺失',
  );

  const glass = await page.evaluate(() => {
    const el = document.querySelector('#apx-glass-playground');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return cs.backdropFilter || cs.webkitBackdropFilter || 'none';
  });
  check(
    glass && glass !== 'none',
    '玻璃拟态 backdrop-filter 生效',
    String(glass),
  );

  // ---- 4. 交互元素改造 ----
  console.log('\n[5] 交互改造');
  const bannerGone = await page.locator('text=尚未设置 API Key').count();
  check(bannerGone === 0, '通栏橘红警告条已移除');
  const toastCount = await page.locator('#apx-toast').count();
  check(toastCount === 0, '已配置密钥时不显示 Toast', `count=${toastCount}`);

  await page.screenshot({ path: path.join(SHOT_DIR, 'design-01-buyer.png') });

  // 业主视角 → 算力节点，检查 Toggle 取代了大红按钮
  await page.locator('text=切换至业主视角').first().click({ timeout: 20000 });
  // 网关冷路径可达 100s+，必须等 owner/dashboard 真正回填
  const dashDeadline = Date.now() + 120000;
  while (Date.now() < dashDeadline) {
    if (netlog.some((n) => n.path.includes('/owner/dashboard') && n.status === 200)) break;
    await page.waitForTimeout(1000);
  }
  await page.waitForTimeout(1500);
  const dashResp = netlog.filter((n) => n.path.includes('/owner/dashboard')).pop();
  check(
    !!dashResp && dashResp.status === 200,
    'GET /api/v1/owner/dashboard',
    dashResp ? `HTTP ${dashResp.status}` : '未发出请求',
  );
  const toggleCount = await page.locator('[role="switch"]').count();
  check(toggleCount > 0, '节点卡片使用 Toggle 开关', `count=${toggleCount}`);
  const bigRedBtn = await page.locator('text=远程指令: 一键暂停接单').count();
  check(bigRedBtn === 0, '整行红色大按钮已移除', `count=${bigRedBtn}`);
  await page.screenshot({ path: path.join(SHOT_DIR, 'design-02-host-nodes.png') });

  // 无密钥时的 Toast + 呼吸灯
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' });
  const p2 = await ctx2.newPage();
  await p2.goto(base, { waitUntil: 'commit', timeout: 60000 });
  await p2.waitForTimeout(2500);
  const toast2 = await p2.locator('#apx-toast').count();
  check(toast2 === 1, '未配置密钥时显示 Toast', `count=${toast2}`);

  // Toast 绝不能遮挡顶栏右侧的全局操作按钮 —— 几何断言
  const overlap = await p2.evaluate(() => {
    const rectOf = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    };
    const toast = rectOf('#apx-toast');
    const targets = {
      keyBtn: rectOf('#apx-glow-key'),
      roleBtn: rectOf('#apx-glow-role'),
    };
    const hit = (a, b) =>
      !!a && !!b && a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    return {
      toast,
      targets,
      overlaps: Object.keys(targets).filter((k) => hit(toast, targets[k])),
      // Toast 底部点击穿透：容器 pointer-events 必须是 none
      pointerEvents: toast ? getComputedStyle(document.querySelector('#apx-toast')).pointerEvents : null,
      viewportH: window.innerHeight,
    };
  });
  check(
    overlap.toast !== null && overlap.overlaps.length === 0,
    'Toast 不遮挡顶栏操作按钮',
    `overlaps=${JSON.stringify(overlap.overlaps)}`,
  );
  check(
    overlap.pointerEvents === 'none',
    'Toast 容器对鼠标事件穿透',
    `pointer-events=${overlap.pointerEvents}`,
  );
  check(
    !!overlap.toast && overlap.toast.y + overlap.toast.h <= overlap.viewportH + 1,
    'Toast 完全位于视口内',
    `bottom=${overlap.toast ? Math.round(overlap.toast.y + overlap.toast.h) : 'n/a'} / vh=${overlap.viewportH}`,
  );
  await p2.screenshot({ path: path.join(SHOT_DIR, 'design-03-toast.png') });

  // 功能验证：Toast 存在时，顶栏按钮依然可点（未被遮挡/未被吞掉事件）
  // 首次访问无密钥会自动弹出密钥设置框（这是有意的模态层），先关掉它，
  // 剩下的唯一浮层就是 Toast —— 这才是本次要验证的遮挡源。
  await p2.locator('text=取消').first().click({ timeout: 15000 });
  await p2.waitForTimeout(800);
  const toastStill = await p2.locator('#apx-toast').count();
  check(toastStill === 1, '关闭密钥弹窗后 Toast 仍然提示未配置凭证', `count=${toastStill}`);

  await p2.locator('#apx-glow-role').click({ timeout: 15000 });
  await p2.waitForTimeout(1200);
  const switched = await p2.locator('[data-testid="host-tabs"]').count();
  check(switched === 1, 'Toast 存在时仍可点击「切换视角」按钮', `host-tabs=${switched}`);

  // ---- 5. 无运行时错误 ----
  console.log('\n[6] 运行时');
  check(pageErrors.length === 0, '无 JS 运行时错误', pageErrors.slice(0, 2).join(' | '));

  fs.writeFileSync(
    path.join(__dirname, 'design-report.json'),
    JSON.stringify({ results, pageErrors }, null, 2),
  );

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  await browser.close();
  if (server) server.close();
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
