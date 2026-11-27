/**
 * 阶段二十六 P1 · 双站 CSP 响应头**线上**快检（无浏览器，可在 CI 跑）
 *
 * 与 `e2e/phase26-csp.cjs`（Playwright 全量：含 CSP 拦截报错与 JS 异常）的分工：
 *   · 本脚本：**只要响应头**，无浏览器依赖 ⇒ 可以进 CI 做**线上**巡检；
 *   · phase26-csp.cjs：需要浏览器，只在本地/发布前跑。
 *
 * ⚠️ 诚实口径：线上巡检依赖网络可达性，GitHub runner 抖动会导致**假红**。
 *    因此 CI 里本脚本以 **advisory（continue-on-error）** 方式运行 ——
 *    真正的**硬闸**是 `e2e/unit-csp-policy.mjs`（静态校验仓库真源）。
 *
 * 运行：node e2e/csp-header-check.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const SITES = [
  { name: 'console', url: process.env.APIPAW_CONSOLE_URL || 'https://console.apipaw.com/' },
  { name: 'pocket', url: process.env.APIPAW_POCKET_URL || 'https://pocket.apipaw.com/' },
];

function expectedDirectives() {
  const src = fs.readFileSync(path.join(ROOT, 'deploy', 'nginx', 'apipaw-csp.conf'), 'utf8');
  const m = src.match(/add_header\s+Content-Security-Policy\s+"([^"]+)"/);
  if (!m) throw new Error('仓库真源里找不到 CSP 指令');
  return m[1].split(';').map((s) => s.trim()).filter(Boolean).sort();
}

const expected = expectedDirectives();
let failed = 0;
const report = [];

for (const site of SITES) {
  let status = 0;
  let csp = '';
  let err = '';
  try {
    const resp = await fetch(site.url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'apipaw-csp-check/1.0' },
      signal: AbortSignal.timeout(30000),
    });
    status = resp.status;
    csp = resp.headers.get('content-security-policy') || '';
  } catch (e) {
    err = String(e && e.message ? e.message : e);
  }
  const online = csp.split(';').map((s) => s.trim()).filter(Boolean).sort();
  const missing = expected.filter((d) => !online.includes(d));
  const ok = status === 200 && csp.length > 0 && missing.length === 0;
  if (!ok) failed += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${site.name} ${site.url} · HTTP ${status} · CSP ${csp ? `${online.length} 条` : '(缺失)'}${missing.length ? ` · 缺: ${missing.join(' | ')}` : ''}${err ? ` · ${err}` : ''}`);
  report.push({ site: site.name, url: site.url, status, csp_present: csp.length > 0, missing, error: err });
}

console.log('');
console.log(`== 双站 CSP 响应头线上快检：${SITES.length - failed}/${SITES.length} 通过 ==`);
try {
  fs.writeFileSync(path.join(__dirname, 'csp-header-check.json'),
    JSON.stringify({ checked_at: new Date().toISOString(), report }, null, 2), 'utf8');
} catch (_) { /* 产物写不出来不影响判定 */ }
process.exit(failed === 0 ? 0 : 1);
