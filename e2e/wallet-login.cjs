/**
 * 钱包签名登录 —— 全链路验收（阶段四 P4）
 *
 * 跑法（Git Bash）：
 *   # 1) 离线（hermetic）：本地静态站 + 拦截 cloud.apipaw.com，验签在 Node 侧真做
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/wallet-login.cjs
 *
 *   # 2) 线上（live）：打真实 cloud.apipaw.com，服务端真验签、真签发 JWT
 *   APIPAW_WALLET_E2E_LIVE=1 \
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/wallet-login.cjs https://console.apipaw.com
 *
 * 覆盖断言：
 *   1. 前端真的向 /api/v1/auth/nonce 讨挑战，且带上地址与 chain_id
 *   2. 前端用钱包扩展的 personal_sign 产出**真实的 EIP-191 签名**（Node 侧 recover 校验）
 *   3. /api/v1/auth/verify 的 message 与挑战逐字节一致（服务端同款校验口径）
 *   4. 签发下来的 JWT 被写进 SecureStore/web localStorage
 *   5. **业主端点**带的是 **JWT**（P5 起含 owner/dashboard），**非业主端点**带的是 **API Key**
 *      （双通道鉴权不串味）
 *   6. 收益端点 401 → 前端立刻清会话（废令牌不再重试）
 *
 * ⚠️ 本脚本**不内置任何真实密钥**：钱包私钥运行时随机生成，API Key 是随机占位串。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { Wallet, verifyMessage } = require('ethers');

const DIST = path.join(__dirname, '..', 'dist');
const LIVE = process.env.APIPAW_WALLET_E2E_LIVE === '1';
const TARGET_URL = process.argv[2] || '';
const TIMEOUT = Number(process.env.APIPAW_E2E_TIMEOUT || 90000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

let passed = 0;
let failed = 0;
const results = [];
const check = (cond, name, detail = '') => {
  results.push({ name, pass: !!cond, detail });
  if (cond) passed++;
  else failed++;
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个只服务 dist/ 的静态服务器（SPA 回退到 index.html） */
function startStaticServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let file = path.join(DIST, urlPath);
      if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(DIST, 'index.html');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** 注入一个「假钱包扩展」：把 personal_sign 转发给 Node 侧用测试私钥真签名 */
const installMockWallet = async (context, address, wallet) => {
  await context.exposeBinding('__e2eSignMessage', async (_source, message) => {
    // ethers v6 的 signMessage 走 EIP-191 personal_sign
    return wallet.signMessage(String(message));
  });

  await context.addInitScript(([addr]) => {
    const hexToUtf8 = (hex) => {
      const body = hex.startsWith('0x') ? hex.slice(2) : hex;
      const bytes = new Uint8Array(body.length / 2);
      for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(body.substr(i * 2, 2), 16);
      return new TextDecoder().decode(bytes);
    };
    const listeners = {};
    const provider = {
      isMetaMask: true,
      async request(args) {
        const method = args && args.method;
        const params = (args && args.params) || [];
        switch (method) {
          case 'eth_requestAccounts':
          case 'eth_accounts':
            return [addr];
          case 'eth_chainId':
            return '0x1';
          case 'net_version':
            return '1';
          case 'eth_blockNumber':
            return '0x1';
          case 'personal_sign': {
            const raw = String(params[0] || '');
            const message = raw.startsWith('0x') ? hexToUtf8(raw) : raw;
            return window.__e2eSignMessage(message);
          }
          default: {
            const err = new Error(`mock provider: unsupported method ${method}`);
            err.code = 4200;
            throw err;
          }
        }
      },
      on(ev, cb) {
        (listeners[ev] = listeners[ev] || []).push(cb);
      },
      removeListener(ev, cb) {
        listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb);
      },
      addListener(ev, cb) {
        this.on(ev, cb);
      },
      removeAllListeners(ev) {
        delete listeners[ev];
      },
    };
    Object.defineProperty(window, 'ethereum', {
      value: provider,
      configurable: true,
      writable: true,
    });
  }, [address]);
};

async function main() {
  const wallet = Wallet.createRandom(); // 运行时随机生成，仓库里不留任何私钥
  const address = wallet.address;
  const dummyApiKey = `e2e-${crypto.randomBytes(10).toString('hex')}`;
  console.log(`模式: ${LIVE ? '线上（真后端）' : '离线（拦截 mock）'}`);
  console.log(`测试钱包: ${address}`);

  // ---- 请求日志（所有打到网关的请求）----
  const netlog = [];
  const record = (req) => {
    const u = new URL(req.url());
    if (!u.hostname.endsWith('apipaw.com')) return;
    let body = null;
    try {
      body = req.postDataJSON();
    } catch (e) {
      /* 无 body */
    }
    netlog.push({
      method: req.method(),
      path: u.pathname,
      auth: req.headers()['authorization'] || '',
      body,
    });
  };

  // ---- 离线模式的挑战消息（与后端 SIWE 风格一致）----
  const nonce = `e2e${crypto.randomBytes(12).toString('hex')}`;
  const issuedAt = new Date().toISOString();
  const challengeMessage = [
    'console.apipaw.com wants you to sign in with your Ethereum account:',
    address,
    '',
    'URI: https://console.apipaw.com',
    'Version: 1',
    'Chain ID: 1',
    `Nonce: ${nonce}`,
    `Issued At: ${issuedAt}`,
  ].join('\n');
  const fakeJwt = [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(
      JSON.stringify({
        sub: 'acct_e2e_wallet',
        role: 'BUYER',
        wallet: address,
        jti: 'e2e',
        exp: Math.floor(Date.now() / 1000) + 7200,
      }),
    ).toString('base64url'),
    'e2e-signature',
  ].join('.');

  let revenueStatus = 200;
  // 未指定 URL 时本地起静态站（产物）；指定了就直接打那个地址
  const server = TARGET_URL ? null : await startStaticServer();
  const baseUrl = TARGET_URL || `http://127.0.0.1:${server.address().port}/`;
  console.log(`被测站点: ${baseUrl}${LIVE ? '（后端：真实生产 cloud.apipaw.com）' : ''}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
  });

  // 预置一个占位 API Key —— 只为让首屏不再自动弹「设置密钥」，不参与钱包链路
  await context.addInitScript(
    ([key]) => {
      try {
        window.localStorage.setItem('apipaw.api_key', key);
      } catch (e) {
        /* ignore */
      }
    },
    [dummyApiKey],
  );
  await installMockWallet(context, address, wallet);

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('request', record);

  if (!LIVE) {
    await page.route('**://cloud.apipaw.com/**', async (route) => {
      const req = route.request();
      const u = new URL(req.url());
      const method = req.method();
      let body = null;
      try {
        body = req.postDataJSON();
      } catch (e) {
        /* ignore */
      }
      const auth = req.headers()['authorization'] || '';
      console.log(`  [req] ${method} ${u.pathname}`);

      const json = (obj, status = 200) =>
        route.fulfill({
          status,
          contentType: 'application/json',
          body: JSON.stringify(obj),
        });

      if (method === 'POST' && u.pathname === '/api/v1/auth/nonce') {
        return json({
          nonce,
          message: challengeMessage,
          domain: 'console.apipaw.com',
          uri: 'https://console.apipaw.com',
          chain_id: 1,
          expires_at: Date.now() / 1000 + 300,
        });
      }
      if (method === 'POST' && u.pathname === '/api/v1/auth/verify') {
        // ★ 服务端同款校验：message 逐字节一致 + EIP-191 签名可恢复出同一地址
        const okMessage = body && body.message === challengeMessage;
        let okSig = false;
        if (okMessage && body.signature) {
          try {
            okSig =
              verifyMessage(body.message, body.signature).toLowerCase() === address.toLowerCase();
          } catch (e) {
            okSig = false;
          }
        }
        if (!okMessage || !okSig) {
          return json({ detail: '签名消息与服务端下发的不一致' }, 400);
        }
        return json({
          access_token: fakeJwt,
          token_type: 'Bearer',
          expires_in: 7200,
          user: {
            handle: 'acct_e2e_wallet',
            role: 'BUYER',
            wallet: address,
            status: 'pending',
            account_type: 'WALLET',
          },
        });
      }
      if (method === 'GET' && u.pathname === '/api/v1/owner/nodes/revenue') {
        return json(
          {
            owner_wallet: address,
            nodes_total: 1,
            total_earnings_paw: 12.5,
            total_tokens_processed: 1000,
            nodes: [],
          },
          revenueStatus,
        );
      }
      if (method === 'GET' && u.pathname === '/api/v1/user/usage') {
        return json({
          api_key: dummyApiKey,
          balance_usd: 10,
          daily_limit_usd: 100,
          spent_today_usd: 1,
          usd_to_cgas: 100,
        });
      }
      if (method === 'GET' && u.pathname === '/api/v1/owner/dashboard') {
        return json({ active_nodes_online: 0, registered_nodes_total: 0, nodes: [] });
      }
      return json({ object: 'list', data: [] });
    });
  }

  const find = (pathname) => netlog.filter((r) => r.path === pathname);

  console.log('\n[1] 打开站点并唤起钱包面板');
  await page.goto(baseUrl, { waitUntil: 'commit', timeout: TIMEOUT });
  await page.waitForSelector('[data-testid="open-wallet-modal"]', { timeout: TIMEOUT });
  await page.locator('[data-testid="open-wallet-modal"]').click();
  await page.waitForSelector('[data-testid="wallet-connect"]', { timeout: TIMEOUT });
  check(true, '钱包面板可打开');

  console.log('\n[2] 点击「连接钱包」→ 走完 挑战/签名/验签 全链路');
  await page.locator('[data-testid="wallet-connect"]').click();
  // 等会话真正建好（顶栏 chip 出现钱包地址）——不使用固定 sleep
  await page.waitForFunction(
    (addr) => {
      const el = document.querySelector('[data-testid="wallet-chip"]');
      return !!el && el.textContent.toLowerCase().includes(String(addr).slice(0, 6).toLowerCase());
    },
    address,
    { timeout: TIMEOUT },
  );
  await page.waitForTimeout(2500);

  const nonceReqs = find('/api/v1/auth/nonce');
  const verifyReqs = find('/api/v1/auth/verify');
  check(nonceReqs.length === 1, '向 /api/v1/auth/nonce 讨了一次挑战', `实际 ${nonceReqs.length} 次`);
  check(
    !!nonceReqs[0] && String(nonceReqs[0].body?.address || '').toLowerCase() === address.toLowerCase(),
    '挑战请求带上钱包地址',
    nonceReqs[0]?.body?.address || '无',
  );
  check(
    !!nonceReqs[0] && Number(nonceReqs[0].body?.chain_id) === 1,
    '挑战请求带上 chain_id=1',
    String(nonceReqs[0]?.body?.chain_id),
  );
  check(verifyReqs.length === 1, '向 /api/v1/auth/verify 提交了一次验签', `实际 ${verifyReqs.length} 次`);

  const verifyBody = verifyReqs[0]?.body;
  if (LIVE) {
    // 线上：挑战消息由服务端下发，只能校验「包含地址与 nonce」这一层
    check(
      !!verifyBody &&
        String(verifyBody.message || '').toLowerCase().includes(address.toLowerCase()) &&
        /Nonce:\s*\S+/i.test(String(verifyBody.message || '')),
      '验签回传的是服务端下发的 SIWE 挑战消息（含地址与 nonce）',
      verifyBody ? String(verifyBody.message || '').split('\n')[0] : '无 body',
    );
  } else {
    check(
      !!verifyBody && verifyBody.message === challengeMessage,
      '验签回传的 message 与挑战逐字节一致',
      verifyBody ? `长度 ${String(verifyBody.message || '').length}` : '无 body',
    );
  }
  let recovered = '';
  if (verifyBody?.signature) {
    try {
      recovered = verifyMessage(verifyBody.message, verifyBody.signature);
    } catch (e) {
      recovered = `ERR:${e.message}`;
    }
  }
  check(
    recovered.toLowerCase() === address.toLowerCase(),
    '签名是真实 EIP-191 personal_sign（可恢复出钱包地址）',
    recovered,
  );

  console.log('\n[3] 会话落盘（SecureStore / web localStorage）');
  const stored = await page.evaluate(() => window.localStorage.getItem('apipaw.session'));
  const parsed = stored ? JSON.parse(stored) : null;
  check(!!parsed && !!parsed.token, '会话已写入本地存储', stored ? `handle=${parsed.handle}` : '未写入');
  check(
    !!parsed && parsed.token && parsed.token.split('.').length === 3,
    '落盘的是 JWT（三段式）',
    parsed?.token ? `${parsed.token.slice(0, 12)}…` : '无',
  );

  console.log('\n[4] 双通道鉴权：业主端点用 JWT，其余端点用 API Key');
  const revenueReqs = find('/api/v1/owner/nodes/revenue');
  check(revenueReqs.length >= 1, '拉取了本人节点收益', `实际 ${revenueReqs.length} 次`);
  const revenueAuth = revenueReqs[revenueReqs.length - 1]?.auth || '';
  check(
    revenueAuth === `Bearer ${parsed?.token}`,
    '收益端点带的是钱包会话 JWT',
    revenueAuth.slice(0, 24) + '…',
  );
  // 阶段四 P5 · 行动 b: 其余**业主端点**（owner/dashboard 等）也优先用会话 JWT ——
  // 后端 require_owner 两种凭证都收, 前端「有会话用会话、没会话回落 API Key」。
  const dashboardReqs = find('/api/v1/owner/dashboard');
  const dashboardAuth = dashboardReqs[dashboardReqs.length - 1]?.auth || '';
  check(
    dashboardAuth === `Bearer ${parsed?.token}`,
    '业主看板端点带的是钱包会话 JWT（P5 新增能力）',
    dashboardAuth.slice(0, 24) + '…',
  );
  const usageReqs = find('/api/v1/user/usage');
  const usageAuth = usageReqs[usageReqs.length - 1]?.auth || '';
  check(usageAuth === `Bearer ${dummyApiKey}`, '普通端点带的是 API Key（未被 JWT 污染）', usageAuth.slice(0, 20) + '…');
  // ⚠️ 泄漏边界随 P5 一起改了: JWT 出现在**业主端点**是设计内的,
  //    但绝不能出现在非业主端点（买家推理 / 账务 / 分析…）。
  const leak = netlog.filter(
    (r) => !r.path.startsWith('/api/v1/owner/') && r.auth === `Bearer ${parsed?.token}`,
  );
  check(leak.length === 0, 'JWT 没有泄漏到非业主端点', `泄漏 ${leak.length} 处`);

  console.log('\n[5] 会话失效 / 权限不足的处理');
  if (LIVE) {
    // 线上：测试钱包不是业主 → 收益端点 403（权限问题，**不是**凭证失效）
    // 403 不应清会话；只有 401（令牌失效）才清。
    await page.reload({ waitUntil: 'commit', timeout: TIMEOUT });
    await page.waitForSelector('[data-testid="open-wallet-modal"]', { timeout: TIMEOUT });
    await page.waitForTimeout(4000);
    const afterLive = await page.evaluate(() => window.localStorage.getItem('apipaw.session'));
    check(!!afterLive, '403（无业主权限）不清会话', afterLive ? '会话保留' : '被误清');
    const revLive = find('/api/v1/owner/nodes/revenue');
    check(
      revLive.length >= 1,
      '线上收益端点被真实后端拒绝（非业主 → 403）',
      `请求 ${revLive.length} 次`,
    );
  } else {
    revenueStatus = 401;
    await page.reload({ waitUntil: 'commit', timeout: TIMEOUT });
    await page.waitForSelector('[data-testid="open-wallet-modal"]', { timeout: TIMEOUT });
    await page.waitForTimeout(4000);
    const after = await page.evaluate(() => window.localStorage.getItem('apipaw.session'));
    check(!after, '会话已被清空（要求重新签名）', after ? '仍在' : '已清');
    const chip = await page.locator('[data-testid="wallet-chip"]').innerText().catch(() => '');
    check(chip.includes('连接钱包'), '顶栏回到「未连接」态', chip.replace(/\n/g, ' '));
  }

  check(pageErrors.length === 0, '无未捕获的前端异常', pageErrors.slice(0, 2).join(' | '));

  await browser.close();
  if (server) server.close();

  console.log(`\n结果: ${passed} PASS / ${failed} FAIL`);
  const report = path.join(__dirname, 'wallet-report.json');
  fs.writeFileSync(report, JSON.stringify({ mode: LIVE ? 'live' : 'hermetic', passed, failed, results }, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('e2e 异常:', e);
  process.exit(1);
});
