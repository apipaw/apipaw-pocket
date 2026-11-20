import { getAddress } from 'ethers/address';
import { keccak256, Signature, SigningKey } from 'ethers/crypto';

/**
 * 极简以太坊工具集（阶段十九 · 前端瘦身专用）。
 *
 * 为什么不用 `ethers` 根入口
 * -----------------------
 * `ethers` 根 barrel 会把 `@ethersproject/hash` 一并拉进来，而 hash 模块
 * 依赖 `@adraffy/ens-normalize`（约 45 KB 原文 / 33 KB gzip 的 Unicode
 * 归一化表）——**我们只用到 personal_sign 验签，从头到尾不需要 ENS**。
 *
 * 更糟的是 `ethers/providers` 与 `ethers/contract` 也各自间接引用 hash
 * （`provider-jsonrpc.js` 引 TypedDataEncoder、`abi/interface.js` 引 id），
 * 于是**只要碰 ethers 根入口，ENS 那张表就会被打进 bundle**。
 *
 * 本文件因此只依赖两个「干净」的子路径：
 *   · `ethers/address` → getAddress（EIP-55 校验和）
 *   · `ethers/crypto`  → keccak256 / Signature / SigningKey
 * 二者都不触达 hash ⇒ 不触达 ens-normalize。
 *
 * ⚠️ 行为等价性（逐条对齐 ethers v6 内部实现）：
 *   · `hashMessage` = keccak256("\x19Ethereum Signed Message:\n" + len + msg)
 *     —— 与 ethers `hash/index.js` 的 `hashMessage` 完全一致；
 *   · 验签 = SigningKey.recoverPublicKey(digest, sig) → keccak256(pub[1:]) 末 20 字节
 *     —— 与 ethers `verifyMessage` → `recoverAddress` 同口径；
 *   · `personal_sign` 参数顺序 [hexMessage, address] —— 与 ethers BrowserProvider
 *     的 `signer.signMessage` 发出的 JSON-RPC 完全一致。
 */

/**
 * UTF-8 编码（不依赖 TextEncoder / Buffer，RN Hermes 与浏览器都可用）。
 *
 * ⚠️ 阶段二十二 P1 · **孤立代理项（lone surrogate）口径修正**
 *
 * 旧实现把「高位代理项后面没有低位代理项」的情况落进了三字节分支，
 * 于是产出了 WTF-8 / CESU-8 编码的**非法 UTF-8**
 * （例如 `"\uD800"` → `ED A0 80`）。
 * 而 `TextEncoder` 与 `ethers.toUtf8Bytes` 的口径是：
 * **任何无法配对的代理项一律编码为 U+FFFD（`EF BF BD`）**。
 *
 * 两边不一致 ⇒ 同一段文本在浏览器与 RN 里算出的 `personal_sign` 摘要不同，
 * 签名/验签会随机失败。本次把三处偏离全部对齐到 WHATWG UTF-8：
 *   1. 孤立高位代理项（后面不是低位代理项）⇒ U+FFFD，**不吞掉下一个码元**；
 *   2. 孤立低位代理项 ⇒ U+FFFD；
 *   3. 合法代理项对 ⇒ 4 字节 UTF-8（不变）。
 */
export const utf8ToBytes = (text: string): Uint8Array => {
  const out: number[] = [];
  const pushReplacement = () => out.push(0xef, 0xbf, 0xbd);
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        const cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f),
        );
      } else {
        // 孤立高位代理项 ⇒ U+FFFD（**不**消费下一个码元）
        pushReplacement();
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      // 孤立低位代理项 ⇒ U+FFFD
      pushReplacement();
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
};

/** 字节数组 → 0x 前缀十六进制串 */
export const bytesToHex = (bytes: Uint8Array): string => {
  let hex = '';
  for (let i = 0; i < bytes.length; i += 1) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return `0x${hex}`;
};

/** 字符串 → 0x 前缀 UTF-8 十六进制串（ethers `hexlify(string)` 同口径） */
export const utf8ToHex = (text: string): string => bytesToHex(utf8ToBytes(text));

/** EIP-191 personal_sign 摘要（与 ethers `hashMessage` 逐字节一致） */
export const hashMessage = (message: string): string => {
  const msg = utf8ToBytes(message);
  const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${msg.length}`);
  const buf = new Uint8Array(prefix.length + msg.length);
  buf.set(prefix, 0);
  buf.set(msg, prefix.length);
  return keccak256(buf);
};

/**
 * 从 personal_sign 签名里恢复签名者地址（EIP-55 校验和形式）。
 *
 * 与 ethers `verifyMessage` 等价，但只依赖 `ethers/crypto`。
 * 签名非法时抛错（由调用方转成 WalletError）。
 */
export const recoverMessageAddress = (message: string, signature: string): string => {
  const sig = Signature.from(signature);
  const pubKey = SigningKey.recoverPublicKey(hashMessage(message), sig);
  const raw = pubKey.startsWith('0x') ? pubKey.slice(2) : pubKey;
  // 公钥去掉 0x04 前缀后的 64 字节 → keccak256 → 末 20 字节即地址
  const body = raw.slice(2);
  const digest = keccak256(new Uint8Array(body.match(/../g)!.map((h) => parseInt(h, 16))));
  const addr = digest.slice(-40);
  return getAddress(addr);
};

/** 十六进制串左侧补零到指定字节数（ABI 编码用） */
export const padHex = (hex: string, bytes: number): string =>
  hex.replace(/^0x/, '').toLowerCase().padStart(bytes * 2, '0');

/** 十进制整数字符串 ÷ 16 —— 纯字符串运算，不依赖 BigInt */
const divmod16 = (dec: string): { q: string; r: number } => {
  let rem = 0;
  let q = '';
  for (let i = 0; i < dec.length; i += 1) {
    const cur = rem * 10 + (dec.charCodeAt(i) - 48);
    const digit = Math.floor(cur / 16);
    rem = cur - digit * 16;
    if (q || digit > 0) q += String(digit);
  }
  return { q: q || '0', r: rem };
};

/**
 * 十进制整数字符串 → 十六进制串（无 BigInt 依赖）。
 *
 * ABI 的 uint256 槽位要的是**大端十六进制数值**，
 * 不能把十进制数字串当十六进制直接补零（否则 1.5e18 会被写成 0x15…）。
 */
export const decimalToHex = (dec: string): string => {
  let cur = dec.replace(/^0+(?=\d)/, '');
  if (cur === '0') return '0';
  let hex = '';
  while (cur !== '0') {
    const { q, r } = divmod16(cur);
    hex = '0123456789abcdef'[r] + hex;
    cur = q;
  }
  return hex;
};

/**
 * 小数金额 → 最小单位整数（字符串，不走浮点，避免精度丢失）。
 *
 * 等价于 ethers `parseUnits(value, decimals)`，但**不使用 BigInt**，
 * 以免给 RN 端引入 BigInt 兼容性问题。
 */
export const toUnits = (value: string | number, decimals = 18): string => {
  const raw = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(raw)) {
    throw new Error('金额格式非法');
  }
  const [intPart, fracPart = ''] = raw.split('.');
  const frac = (fracPart + '0'.repeat(decimals)).slice(0, decimals);
  const left = intPart.replace(/^0+(?=\d)/, '');
  const out = `${left}${frac}`.replace(/^0+(?=\d)/, '');
  return out;
};

/** ERC-20 `transfer(address,uint256)` 的 calldata（等价于 ethers Contract.transfer） */
export const encodeErc20Transfer = (to: string, amountUnits: string): string => {
  const address = to.replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(address)) {
    throw new Error('收款地址格式非法');
  }
  if (!/^\d+$/.test(amountUnits)) {
    throw new Error('金额格式非法');
  }
  const selector = 'a9059cbb';
  const toSlot = padHex(address, 32);
  const amountSlot = padHex(decimalToHex(amountUnits), 32);
  return `0x${selector}${toSlot}${amountSlot}`;
};
