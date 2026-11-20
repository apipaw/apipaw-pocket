/**
 * 取一个**真实**的 OWNER 钱包会话（线上）。
 *
 * ⚠️ 阶段二十二 P1 · **私钥不再入库**
 *   旧版本把一把**私钥硬编码**在本文件里（``0x4f3e…b1d``），
 *   而它对应的地址 ``0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1``
 *   是公网上人手一份的公开演示钱包 —— 等于**任何人都能冒充业主**。
 *   现在私钥**只能**从环境变量 ``APIPAW_OWNER_PK`` 注入：
 *     · 缺失 ⇒ 打印错误并 ``exit(1)``，不猜、不兜底、不内置；
 *     · 本文件（以及仓库任何位置）**不再保存任何私钥**。
 *
 *   ⚠️ 旧注释里的 OWNER 钱包地址 ``0x71C7656EC7ab88b098defB751B7401B5f6d8976F``
 *      与硬编码私钥的实际地址 **对不上**（那是另一把钥匙）—— 属于误导性文档，
 *      一并修正：以 ``APIPAW_OWNER_PK`` 推导出的地址为准。
 *
 * 跑法：
 *   export APIPAW_OWNER_PK='0x…'          # 仅在本地环境变量里给，别提交
 *   NODE_PATH=D:/ClaudeCode_Installed/node_modules node e2e/owner-session.js
 *
 * 输出：TOKEN=<jwt>  HANDLE=<acct_xxx>  ROLE=<OWNER>  WALLET=<0x…>
 */
const { Wallet } = require('ethers');

const OWNER_PK = (process.env.APIPAW_OWNER_PK || '').trim();
const BASE = process.argv[2] || 'https://cloud.apipaw.com';

if (!OWNER_PK) {
  console.error('[FATAL] 缺少环境变量 APIPAW_OWNER_PK（业主钱包私钥）。');
  console.error('        私钥**不得**写进仓库；请在本地 shell 里 export 后重跑。');
  console.error('        例：APIPAW_OWNER_PK=0x… node e2e/owner-session.js');
  process.exit(1);
}

if (!/^0x[0-9a-fA-F]{64}$/.test(OWNER_PK)) {
  console.error('[FATAL] APIPAW_OWNER_PK 格式非法（应为 0x + 64 位十六进制）。');
  process.exit(1);
}

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
