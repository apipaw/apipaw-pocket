/**
 * 阶段二十六 P1/P3 · 双站 CSP 线上验收（R-15 + R-02 回归）
 *
 * 判据（任务书原文口径）：
 *   ① 双站首页响应**必须**带 `Content-Security-Policy`；
 *   ② 双站**不得**出现任何 CSP 拦截报错（"Refused to ..." / Content Security Policy）；
 *   ③ CSP 指令与仓库真源 `deploy/nginx/apipaw-csp.conf` 保持一致（防止线上漂移）；
 *   ④ 顺带回归 R-02：直连源站 IP + 伪造 Host ⇒ **403**（源站白名单生效）。
 *
 * 跑法（Git Bash）：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules \
 *   node e2e/phase26-csp.cjs
 *
 * 产物：e2e/phase26-report.json（只落响应头摘要，不含任何凭据）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const SOCKS = process.env.APIPAW_SOCKS || '127.0.0.1:1080';
const ORIGIN_IP = process.env.APIPAW_ORIGIN_IP || '103.142.190.251';
const REPORT = path.join(__dirname, 'phase26-report.json');
const TIMEOUT = Number(process.env.APIPAW_E2E_NAV_TIMEOUT || 90000);

const SITES = [
  { name: 'console', url: 'https://console.apipaw.com/' },
  { name: 'pocket', url: 'https://pocket.apipaw.com/' },
];

/** 从仓库真源里解析出 CSP 的指令集合（用于比对线上是否漂移）。 */
function expectedDirectives() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'deploy', 'nginx', 'apipaw-csp.conf'), 'utf8');
  const m = src.match(/add_header\s+Content-Security-Policy\s+"([^"]+)"/);
  if (!m) throw new Error('仓库真源里找不到 CSP 指令');
  return m[1]
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' | ' + detail : ''}`);
}

(async () => {
  const expected = expectedDirectives();
  const launchArgs = ['--disable-ipv6', `--proxy-server=socks5://${SOCKS}`];
  const browser = await chromium.launch({ headless: true, args: launchArgs });
  const siteReports = [];

  for (const site of SITES) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await ctx.newPage();
    const cspViolations = [];
    const pageErrors = [];
    const consoleErrors = [];

    page.on('console', (msg) => {
      const text = String(msg.text() || '');
      if (/Content Security Policy|Refused to/i.test(text)) {
        cspViolations.push(text.slice(0, 300));
      } else if (msg.type() === 'error' && !/status of (401|403)/i.test(text)) {
        // 匿名首屏的后端 401/403 是**预期行为**（未配 Key），不算故障
        consoleErrors.push(text.slice(0, 300));
      }
    });
    page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err).slice(0, 300)));
    page.on('requestfailed', (req) => {
      const why = String((req.failure() && req.failure().errorText) || '');
      if (/csp|content security/i.test(why)) cspViolations.push(`requestfailed: ${req.url()} :: ${why}`);
    });

    let status = 0;
    let csp = '';
    try {
      const resp = await page.goto(site.url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
      status = resp ? resp.status() : 0;
      csp = resp ? String(resp.headers()['content-security-policy'] || '') : '';
      await page.waitForTimeout(3000);
    } catch (e) {
      consoleErrors.push('导航失败: ' + String(e && e.message ? e.message : e));
    }

    check(`${site.name} 首页返回 200`, status === 200, `HTTP ${status}`);
    check(`${site.name} 响应带 Content-Security-Policy`, csp.length > 0,
      csp ? `${csp.length} 字节` : '(缺失)');

    const online = csp.split(';').map((s) => s.trim()).filter(Boolean).sort();
    const missing = expected.filter((d) => !online.includes(d));
    check(`${site.name} CSP 指令与仓库真源一致（无漂移）`, missing.length === 0,
      missing.length ? `线上缺: ${missing.join(' | ')}` : `${online.length} 条一致`);

    check(`${site.name} 无 CSP 拦截报错`, cspViolations.length === 0,
      cspViolations.length ? cspViolations[0] : '0 条');
    check(`${site.name} 无 JS 运行时异常`, pageErrors.length === 0,
      pageErrors.length ? pageErrors[0] : '0 条');
    check(`${site.name} 无其它 console error`, consoleErrors.length === 0,
      consoleErrors.length ? consoleErrors[0] : '0 条');

    siteReports.push({
      site: site.name,
      url: site.url,
      status,
      csp_present: csp.length > 0,
      csp_directives: online,
      csp_violations: cspViolations,
      page_errors: pageErrors,
      console_errors: consoleErrors,
    });
    await ctx.close();
  }

  await browser.close();

  // ---- R-02 回归：直连源站（伪造 Host）必须 403 ----
  let directStatus = 0;
  let directDetail = '';
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'p26direct-'));
    const args = ['-s', '-m', '30', '-o', path.join(dir, 'b'), '-w', '%{http_code}',
      '--socks5-hostname', SOCKS,
      '-H', 'Host: console.apipaw.com',
      `https://${ORIGIN_IP}/`];
    try {
      directStatus = Number(String(execFileSync('curl', args, { encoding: 'utf8' })).trim());
    } catch (e) {
      const m = String((e.stdout || '')).match(/(\d{3})\s*$/);
      directStatus = m ? Number(m[1]) : 0;
      directDetail = String(e.message || '').slice(0, 200);
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  } catch (e) {
    directDetail = String(e && e.message ? e.message : e);
  }
  check('直连源站 IP + 伪造 Host ⇒ 403（源站白名单生效）', directStatus === 403,
    directStatus ? `HTTP ${directStatus}` : directDetail || '(未取得状态码)');

  fs.writeFileSync(REPORT, JSON.stringify({
    phase: 'phase26',
    checked_at: new Date().toISOString(),
    sites: siteReports,
    direct_origin_status: directStatus,
    results,
  }, null, 2), 'utf8');

  const failed = results.filter((r) => !r.ok);
  console.log('');
  console.log(`== 阶段二十六 P1 · 双站 CSP 线上验收：${results.length - failed.length}/${results.length} 通过 ==`);
  if (failed.length) {
    failed.forEach((r) => console.log(`  [FAIL] ${r.name} | ${r.detail}`));
    process.exit(1);
  }
})().catch((e) => {
  console.error('[FATAL] ' + String(e && e.stack ? e.stack : e));
  process.exit(1);
});
