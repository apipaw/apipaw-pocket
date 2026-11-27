/**
 * 阶段二十六 P1 · CSP 与源站白名单的**静态**策略闸门（CI 硬门）
 *
 * 为什么是静态检查而不是线上检查：
 *   线上 CSP 是否生效，取决于**源站 nginx 的实际配置**；
 *   本仓 `deploy/nginx/` 存的就是那份配置的**版本库真源**（部署时由运维
 *   scp 到 `/etc/nginx/`）。若真源里漏挂 CSP / 漏挂源站白名单，
 *   线上就会退化成"没有 CSP"或"可直连源站"—— 这两种都必须**在合入前**拦住。
 *
 * 覆盖：
 *   ① CSP 指令齐套（含 Cloudflare RUM beacon 与后端出口，避免线上控制台报错）；
 *   ② **每个 location 都挂 CSP**（nginx 的 add_header 是「就近覆盖」语义 ——
 *      location 里只要出现任意一条 add_header，server 级继承的 add_header 全部作废）；
 *   ③ 两个 server 块都挂源站来源白名单（443 直连绕过 Cloudflare 的封堵）。
 *
 * 运行：node e2e/unit-csp-policy.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const CSP_FILE = path.join(ROOT, 'deploy', 'nginx', 'apipaw-csp.conf');
const CONF_FILE = path.join(ROOT, 'deploy', 'nginx', 'apipaw-console.conf');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' | ' + detail : ''}`);
}

for (const f of [CSP_FILE, CONF_FILE]) {
  if (!fs.existsSync(f)) {
    console.error(`[FATAL] 缺少配置文件: ${f}`);
    process.exit(1);
  }
}

const csp = fs.readFileSync(CSP_FILE, 'utf8');
const conf = fs.readFileSync(CONF_FILE, 'utf8');

// ---- ① CSP 指令齐套 ----
check('CSP 片段含 add_header Content-Security-Policy',
  /add_header\s+Content-Security-Policy\s+"/.test(csp));

const requiredDirectives = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "manifest-src 'self'",
];
for (const d of requiredDirectives) {
  check(`CSP 含指令 ${d}`, csp.includes(d));
}

// Cloudflare 边缘注入的 Web Analytics（RUM beacon）—— 不放行会在浏览器控制台
// 留下 "Refused to load ... static.cloudflareinsights.com" 的 CSP 拦截报错。
check('CSP script-src 放行 Cloudflare RUM beacon',
  /script-src[^;]*https:\/\/static\.cloudflareinsights\.com/.test(csp));
check('CSP connect-src 放行 Cloudflare RUM beacon',
  /connect-src[^;]*https:\/\/static\.cloudflareinsights\.com/.test(csp));
// 前端唯一后端出口（src/api/cloudClient.ts 的 FALLBACK_BASE_URL）
check('CSP connect-src 放行后端网关 cloud.apipaw.com',
  /connect-src[^;]*https:\/\/cloud\.apipaw\.com/.test(csp));

// ---- ② 每个 location 都挂 CSP ----
const locationBlocks = conf.split(/\n\s*location\s/).slice(1);
check('nginx 配置里至少有 2 个 location', locationBlocks.length >= 2,
  `实际 ${locationBlocks.length} 个`);
let missing = 0;
for (const block of locationBlocks) {
  if (!block.includes('include /etc/nginx/apipaw-csp.conf;')) missing += 1;
}
check('每个 location 都 include 了 CSP 片段（add_header 就近覆盖语义）',
  missing === 0, `漏挂 ${missing} 个`);
check('CSP include 出现次数与 location 数量一致',
  (conf.match(/include \/etc\/nginx\/apipaw-csp\.conf;/g) || []).length === locationBlocks.length,
  `include ${(conf.match(/include \/etc\/nginx\/apipaw-csp\.conf;/g) || []).length} 处 / location ${locationBlocks.length} 个`);

// ---- ③ 两个 server 块都挂源站白名单 ----
const serverBlocks = conf.split(/\nserver\s*\{/).slice(1);
check('nginx 配置里至少有 2 个 server 块', serverBlocks.length >= 2,
  `实际 ${serverBlocks.length} 个`);
let missingAllow = 0;
for (const block of serverBlocks) {
  const hasAllow = block.includes('include /etc/nginx/cf-origins.allow;');
  const hasLocal = /allow\s+127\.0\.0\.1;/.test(block);
  const hasDeny = /deny\s+all;/.test(block);
  if (!(hasAllow && hasLocal && hasDeny)) missingAllow += 1;
}
check('每个 server 块都挂源站来源白名单（CF 回源 + 127.0.0.1，其余 deny）',
  missingAllow === 0, `漏挂 ${missingAllow} 个`);

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`== 阶段二十六 P1 · CSP/源站白名单静态策略闸门：${results.length - failed.length}/${results.length} 通过 ==`);
if (failed.length) {
  failed.forEach((r) => console.log(`  [FAIL] ${r.name} | ${r.detail}`));
  process.exit(1);
}
