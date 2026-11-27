// 阶段二十六 P2 · 公测边界提示条线上验收（双站）
// 断言：页面 DOM 里存在 testID=beta-boundary-notice 的元素，且其文本包含两条边界声明。
const { chromium } = require('playwright');

const SITES = [
  { name: 'console', url: 'https://console.apipaw.com/' },
  { name: 'pocket', url: 'https://pocket.apipaw.com/' },
];

(async () => {
  const browser = await chromium.launch({
    args: ['--proxy-server=socks5://127.0.0.1:1080', '--no-sandbox'],
  });
  let pass = 0;
  let total = 0;
  for (const site of SITES) {
    const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await ctx.newPage();
    try {
      await page.goto(site.url, { waitUntil: 'commit', timeout: 90000 });
      // ⚠️ 用 state:'attached' 而不是默认的 'visible'：提示条位于 ScrollView 内，
      //    匿名首屏（未配 API Key）时它可能已渲染在 DOM 里但滚出视口/被密钥门挡住，
      //    'visible' 会误报成"没渲染"。我们要验的是**文案是否上线**。
      await page.waitForSelector('[data-testid="beta-boundary-notice"]',
        { state: 'attached', timeout: 90000 });
      const text = await page.locator('[data-testid="beta-boundary-notice"]').first()
        .evaluate(el => (el.textContent || '').trim());
      total += 2;
      if (text.includes('封闭公测期')) { console.log(`[PASS] ${site.name} 提示条存在且含「封闭公测期」 | ${text.trim()}`); pass += 1; }
      else { console.log(`[FAIL] ${site.name} 提示条文案不符 | ${text}`); }
      if (text.includes('单户储值上限 $100') && text.includes('不提供商用 SLA 承诺')) {
        console.log(`[PASS] ${site.name} 两条边界声明完整`); pass += 1;
      } else {
        console.log(`[FAIL] ${site.name} 边界声明缺失 | ${text}`);
      }
    } catch (e) {
      total += 2;
      console.log(`[FAIL] ${site.name} 未找到公测提示条 | ${String(e.message || e).slice(0, 200)}`);
    } finally {
      await ctx.close();
    }
  }
  await browser.close();
  console.log(`\n== 阶段二十六 P2 · 公测边界提示条线上验收：${pass}/${total} 通过 ==`);
  process.exit(pass === total ? 0 : 1);
})();
