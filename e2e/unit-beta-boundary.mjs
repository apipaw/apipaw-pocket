/**
 * 阶段二十六 P2 · 封闭公测边界声明的**静态**闸门（CI 硬门）
 *
 * 任务书 B3/B6/B7 要求：在用户**看得见**的地方声明公测边界 ——
 *   「封闭公测期：单户储值上限 $100 · 不提供商用 SLA 承诺」
 *
 * 为什么要有这个闸门：边界声明是**产品承诺**，不是运营口径。
 * 一旦有人改文案 / 删掉这一行，没有任何测试会报警 ⇒ 承诺静默失效。
 * 这里把「声明存在 + 文案口径正确 + 带可断言的 testID」锁死。
 *
 * 运行：node e2e/unit-beta-boundary.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const APP = path.join(ROOT, 'App.tsx');

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' | ' + detail : ''}`);
}

if (!fs.existsSync(APP)) {
  console.error(`[FATAL] 缺少 ${APP}`);
  process.exit(1);
}
const src = fs.readFileSync(APP, 'utf8');

// 任务书给定的文案（逐字口径：· 两侧各一个空格）
const NOTICE = '封闭公测期：单户储值上限 $100 · 不提供商用 SLA 承诺';

check('App.tsx 声明了封闭公测边界文案', src.includes(NOTICE),
  src.includes(NOTICE) ? NOTICE : '未找到：' + NOTICE);
check('边界声明带 testID=beta-boundary-notice（e2e 可断言）',
  src.includes('beta-boundary-notice'));
check('边界声明同时覆盖「单户 $100 上限」与「不提供商用 SLA」',
  src.includes('单户储值上限 $100') && src.includes('不提供商用 SLA 承诺'));
// 体量纪律：声明必须是静态文案，不得引入网络请求 / 额外依赖
check('边界声明未引入新的网络请求调用',
  !/betaNotice[\s\S]{0,400}?await\s+fetch/.test(src));

const failed = results.filter((r) => !r.ok);
console.log('');
console.log(`== 阶段二十六 P2 · 封闭公测边界声明闸门：${results.length - failed.length}/${results.length} 通过 ==`);
if (failed.length) {
  failed.forEach((r) => console.log(`  [FAIL] ${r.name} | ${r.detail}`));
  process.exit(1);
}
