/**
 * 取一个**真实**的 OWNER 钱包会话（线上）。
 *
 * 生产 OWNER 账户 acct_230bad0cd00541e1 的 owner_wallet 就是那个公开的演示钱包
 * 0x71C7656EC7ab88b098defB751B7401B5f6d8976F（Ganache 确定性账户 #0，
 * 私钥在公网上是公开的）—— 服务端 ``find_user_by_owner_wallet`` 会把它
 * 自动关联到 OWNER 账户，所以走**真实的 nonce → 签名 → verify** 就能拿到
 * 真会话 JWT（不是伪造的）。
 *
 * 跑法：
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/owner-session.js
 *
 * 输出：TOKEN=<jwt>  HANDLE=<acct_xxx>  ROLE=<OWNER>
 */
const { Wallet } = require('ethers');

const OWNER_PK = process.env.APIPAW_OWNER_PK || '0x4f3edf983ac636a65a842ce7c78d9aa706d3b113bce9c46f30d7d21715b23b1d';
const BASE = process.argv[2] || 'https://cloud.apipaw.com';

(async () => {
  const wallet = new Wallet(OWNER_PK);
  const address = wallet.address;

  const nonceRes = await fetch(BASE + '/api/v1/auth/nonce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address, chain_id: 1 }),
  });
  const nonceBody = await nonceRes.json();
  if (!nonceRes.ok) {
    console.error('nonce 失败:', nonceRes.status, JSON.stringify(nonceBody));
    process.exit(1);
  }

  const signature = await wallet.signMessage(nonceBody.message);

  const verifyRes = await fetch(BASE + '/api/v1/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      address,
      message: nonceBody.message,
      signature,
      nonce: nonceBody.nonce,
    }),
  });
  const verifyBody = await verifyRes.json();
  if (!verifyRes.ok) {
    console.error('verify 失败:', verifyRes.status, JSON.stringify(verifyBody));
    process.exit(1);
  }
  console.log('TOKEN=' + verifyBody.access_token);
  console.log('HANDLE=' + (verifyBody.user && verifyBody.user.handle));
  console.log('ROLE=' + (verifyBody.user && verifyBody.user.role));
  console.log('WALLET=' + address);
})();
