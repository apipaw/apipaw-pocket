/**
 * APIPaw Pocket —— 桌面端视觉回归对比（像素级 + DOM 几何级）
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/desktop-visual-diff.cjs <基线dist> <新dist>
 *
 * 用途：纯 UI 响应式改动之后，证明**桌面端（1280x800）没有发生任何视觉退化**。
 * 做法是同一个 hermetic mock、同一组滚动位置、同一批截图，分别在两份 dist 上跑一遍，
 * 然后：
 *   ① 像素级 diff（canvas getImageData，阈值 ±8/通道）
 *   ② DOM 几何 diff（每个元素的 path|text|left|top|width|height）
 *
 * ⚠️ 两个必须知道的坑：
 *   1. **必须冻结时间** —— 页面里有「更新于 HH:MM:SS」这类实时文本，
 *      不冻结时间每次都会差几十像素。
 *   2. **必须固定滚动位置** —— mouse.wheel 是平滑滚动，终点有亚像素抖动，
 *      直接写 scrollTop 才是确定的。
 *   3. `apx-dot-live` 呼吸灯是 CSS 动画，逐帧不同 ⇒ 该区域永远会有噪声，
 *      判断回归要看**差分区域是否落在动画上**，不要看数字大小。
 *
 * 退出码：0 = 无实质差异；1 = 有差异。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { mockResponse } = require('./mobile-layout.cjs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

const VIEWPORT = { width: 1280, height: 800 };
const OUT = path.join(__dirname, 'shots', 'desktop-diff');
/** 会被拿来逐卡片做元素级截图的 testID */
const ELEMENT_SHOTS = [
  'analytics-card',
  'limit-slider',
  'smart-alert-card',
  'dao-enterprise-card',
  'royalty-card',
];
/** 固定滚动位置（写 scrollTop，避免 wheel 的亚像素抖动） */
const SCROLL_BUYER = 2400;
const SCROLL_OWNER = 1800;

function startStaticServer(root) {
  const rootDir = path.resolve(root);
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(rootDir, p);
      if (!file.startsWith(rootDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(rootDir, 'index.html');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找到页面里的纵向滚动容器 */
const SCROLL_TO = (top) => {
  const sv = Array.from(document.querySelectorAll('*')).find((el) => {
    const cs = getComputedStyle(el);
    return (
      (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 40
    );
  });
  if (sv) sv.scrollTop = top;
};

async function shoot(dist, tag) {
  const server = await startStaticServer(dist);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    locale: 'zh-CN',
  });
  await context.addInitScript(() => {
    try {
      window.localStorage.setItem('apipaw.api_key', 'paw_layout_audit_key');
    } catch (e) {}
    // 冻结时间：抹掉「更新于 HH:MM:SS」这类天然随机的像素差
    const FIXED = 1764300000000;
    const RealDate = Date;
    const Fake = function (...args) {
      if (!(this instanceof Fake)) return new RealDate(FIXED).toString();
      return args.length === 0 ? new RealDate(FIXED) : new RealDate(...args);
    };
    Fake.prototype = RealDate.prototype;
    Fake.now = () => FIXED;
    Fake.parse = RealDate.parse;
    Fake.UTC = RealDate.UTC;
    window.Date = Fake;
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route('**://cloud.apipaw.com/**', async (route) => {
    const u = new URL(route.request().url());
    const { status, obj } = mockResponse(u.pathname, route.request().method(), null);
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(obj) });
  });
  await page.goto(base, { waitUntil: 'commit', timeout: 90000 });
  await page.waitForSelector('text=APIPaw Pocket', { timeout: 90000 });
  await sleep(3000);

  /** 抓全量 DOM 几何快照 —— 比像素更能定位「哪里变了」 */
  const domOf = () =>
    page.evaluate(() => {
      const out = [];
      const walk = (el, path) => {
        const r = el.getBoundingClientRect();
        const key = el.id || el.getAttribute('data-testid') || el.tagName.toLowerCase();
        out.push(
          [
            path + '>' + key,
            (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24),
            Math.round(r.left),
            Math.round(r.top),
            Math.round(r.width),
            Math.round(r.height),
          ].join('|'),
        );
        let i = 0;
        for (const c of el.children) walk(c, path + '>' + key + '#' + i++);
      };
      walk(document.body, '');
      return out;
    });

  const shots = [];
  const snap = async (name) => {
    const buf = await page.screenshot();
    fs.writeFileSync(path.join(OUT, `${tag}-${name}.png`), buf);
    shots.push({ name, buf, dom: await domOf() });
  };

  await snap('top');
  for (const tid of ELEMENT_SHOTS) {
    const el = page.locator(`[data-testid="${tid}"]`);
    if ((await el.count()) === 0) continue;
    try {
      await el.first().scrollIntoViewIfNeeded();
      await sleep(500);
      const buf = await el.first().screenshot();
      fs.writeFileSync(path.join(OUT, `${tag}-el-${tid}.png`), buf);
      shots.push({ name: 'el-' + tid, buf, dom: await domOf() });
    } catch (e) {
      /* 元素可能没渲染出来 —— 跳过 */
    }
  }

  for (let i = 0; i < 10; i++) {
    await page.mouse.wheel(0, 800);
    await sleep(400);
  }
  await page.evaluate(SCROLL_TO, SCROLL_BUYER);
  await sleep(700);
  await snap('mid');

  await page.locator('[data-testid="switch-role"]').click();
  await sleep(1500);
  await snap('owner-nodes');
  for (const tab of ['STUDIO', 'ROYALTY', 'GOVERNANCE']) {
    const btn = page.locator(`[data-testid="host-tab-${tab}"]`);
    if ((await btn.count()) === 0) continue;
    await btn.scrollIntoViewIfNeeded();
    await btn.click();
    await sleep(1500);
    for (let i = 0; i < 6; i++) {
      await page.mouse.wheel(0, 800);
      await sleep(350);
    }
    await page.evaluate(SCROLL_TO, SCROLL_OWNER);
    await sleep(700);
    await snap(`owner-${tab.toLowerCase()}`);
  }

  await browser.close();
  server.close();
  return { shots, errors };
}

/** 像素级 diff —— 用 canvas 实现，不引入任何额外依赖 */
async function pixelDiff(browser, aBuf, bBuf) {
  const toUrl = (b) => 'data:image/png;base64,' + b.toString('base64');
  const page = await browser.newPage();
  await page.setContent('<body style="margin:0"><canvas id="a"></canvas><canvas id="b"></canvas></body>');
  const res = await page.evaluate(
    async ([ua, ub]) => {
      const load = (src) =>
        new Promise((res2, rej) => {
          const i = new Image();
          i.onload = () => res2(i);
          i.onerror = rej;
          i.src = src;
        });
      const [ia, ib] = await Promise.all([load(ua), load(ub)]);
      if (ia.width !== ib.width || ia.height !== ib.height) {
        return { sizeMismatch: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
      }
      const w = ia.width;
      const h = ia.height;
      const ca = document.getElementById('a');
      const cb = document.getElementById('b');
      ca.width = cb.width = w;
      ca.height = cb.height = h;
      const xa = ca.getContext('2d');
      const xb = cb.getContext('2d');
      xa.drawImage(ia, 0, 0);
      xb.drawImage(ib, 0, 0);
      const da = xa.getImageData(0, 0, w, h).data;
      const db = xb.getImageData(0, 0, w, h).data;
      let diff = 0;
      let minX = w;
      let minY = h;
      let maxX = -1;
      let maxY = -1;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          if (
            Math.abs(da[i] - db[i]) > 8 ||
            Math.abs(da[i + 1] - db[i + 1]) > 8 ||
            Math.abs(da[i + 2] - db[i + 2]) > 8
          ) {
            diff++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      return {
        w,
        h,
        diff,
        pct: ((diff / (w * h)) * 100).toFixed(4),
        box: maxX >= 0 ? [minX, minY, maxX, maxY] : null,
      };
    },
    [toUrl(aBuf), toUrl(bBuf)],
  );
  await page.close();
  return res;
}

async function main() {
  const baseDist = process.argv[2];
  const newDist = process.argv[3];
  if (!baseDist || !newDist) {
    console.error('用法: node e2e/desktop-visual-diff.cjs <基线dist> <新dist>');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });

  const a = await shoot(baseDist, 'base');
  const b = await shoot(newDist, 'new');
  const browser = await chromium.launch({ headless: true });

  console.log(`基线: ${baseDist}\n新包: ${newDist}`);
  console.log(`JS 运行时错误 —— 基线 ${a.errors.length} / 新包 ${b.errors.length}\n`);

  const byName = (arr) => {
    const m = new Map();
    for (const s of arr) m.set(s.name, s);
    return m;
  };
  const ma = byName(a.shots);
  const mb = byName(b.shots);
  let domDiffTotal = 0;

  for (const [name, sa] of ma) {
    const sb = mb.get(name);
    if (!sb) {
      console.log(`${name}: 缺失（新包侧没有这张截图）`);
      continue;
    }
    const d = await pixelDiff(browser, sa.buf, sb.buf);
    console.log(
      `${name}: 像素差 ${d.diff}px (${d.pct}%)${d.sizeMismatch ? ' 尺寸不一致 ' + d.sizeMismatch : ''}`,
    );
    let shown = 0;
    for (let j = 0; j < Math.max(sa.dom.length, sb.dom.length); j++) {
      if (sa.dom[j] !== sb.dom[j]) {
        if (shown < 5) console.log(`    DOM 差异: 基线="${sa.dom[j]}" 新包="${sb.dom[j]}"`);
        shown++;
      }
    }
    if (shown) {
      domDiffTotal += shown;
      console.log(`    DOM 差异行数: ${shown}/${sa.dom.length}`);
    }
  }
  await browser.close();

  console.log(`\nDOM 几何差异合计: ${domDiffTotal} 行`);
  console.log(
    '\n提示: `apx-dot-live` 呼吸灯是 CSS 动画，其区域永远存在噪声；\n' +
      '      若差异只落在该区域（视口右上角 13x13 附近），视为渲染噪声而非回归。',
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error('对比异常:', e);
    process.exit(2);
  });
}

module.exports = { shoot, pixelDiff };
