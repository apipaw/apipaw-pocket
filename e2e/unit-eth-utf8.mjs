/**
 * 阶段二十二 P1 · `src/wallet/eth.ts` UTF-8 编码口径单测。
 *
 * 为什么要有这个用例（审计 §5A.2 实锤）：
 *   旧的 `utf8ToBytes` 把**孤立代理项（lone surrogate）**落进了三字节分支，
 *   产出 WTF-8 / CESU-8 的**非法 UTF-8**（`"\uD800"` → `ED A0 80`）。
 *   而 `TextEncoder` 与 `ethers.toUtf8Bytes` 的口径是
 *   **任何无法配对的代理项一律编码为 U+FFFD（`EF BF BD`）**。
 *
 *   两边不一致 ⇒ 同一段文本在浏览器（TextEncoder）与 RN（自研实现）里
 *   算出的 `personal_sign` 摘要不同 ⇒ 验签随机失败。
 *   这类 bug **不会抛异常**，只会在真实用户的中文/emoji 签名上炸。
 *
 * 断言口径（逐字节）：
 *   A. ASCII / 多字节中文 / emoji（合法代理项对）与 `TextEncoder` **完全一致**；
 *   B. 孤立高位代理项 ⇒ `EF BF BD`（U+FFFD），且**不吞掉后一个码元**；
 *   C. 孤立低位代理项 ⇒ `EF BF BD`；
 *   D. 与 `ethers.toUtf8Bytes` **逐字节一致**（含所有边界样例）。
 *
 * 跑法（Git Bash / 仓库根目录）：
 *   node e2e/unit-eth-utf8.mjs
 *
 * 依赖：Node >= 22.6（原生类型剥离，可直接 import .ts）。
 */

import { utf8ToBytes, utf8ToHex } from '../src/wallet/eth.ts';
import { toUtf8Bytes } from 'ethers/utils';

const RESULTS = [];

function record(name, ok, detail = '') {
  RESULTS.push({ name, ok, detail });
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? ' | ' + detail : ''));
}

const toHex = (bytes) =>
  '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

/** 与浏览器/RN 通用的 TextEncoder 逐字节比对。 */
const sameAsTextEncoder = (text) => {
  const mine = utf8ToBytes(text);
  const ref = new TextEncoder().encode(text);
  if (mine.length !== ref.length) return false;
  for (let i = 0; i < ref.length; i += 1) {
    if (mine[i] !== ref[i]) return false;
  }
  return true;
};

function main() {
  /* ---------- A. 常规文本与合法代理项对 ---------- */
  const normal = [
    ['', '空串'],
    ['hello apipaw', '纯 ASCII'],
    ['业主免插件口令', '中文（3 字节）'],
    ['é', '拉丁扩展（2 字节）'],
    ['😀', 'emoji（合法代理项对 → 4 字节）'],
    ['a😀中', '混合 ASCII + emoji + 中文'],
    ['👨‍👩‍👧‍👦', 'ZWJ 组合 emoji'],
  ];
  for (const [text, label] of normal) {
    record(`A. ${label} 与 TextEncoder 逐字节一致`,
      sameAsTextEncoder(text),
      `mine=${toHex(utf8ToBytes(text))}`);
  }

  /* ---------- B. 孤立高位代理项 ---------- */
  const loneHigh = '\uD800';
  record('B. 孤立高位代理项 ⇒ U+FFFD（EF BF BD）',
    toHex(utf8ToBytes(loneHigh)) === '0xefbfbd',
    `got=${toHex(utf8ToBytes(loneHigh))}`);

  // 高位代理项后面跟一个**普通**字符 ⇒ 不得吞掉那个字符
  const highThenAscii = '\uD800A';
  const expectedHighThenAscii = toHex(new TextEncoder().encode(highThenAscii));
  record('B2. 孤立高位代理项**不吞掉**后一个 ASCII 码元',
    toHex(utf8ToBytes(highThenAscii)) === expectedHighThenAscii,
    `mine=${toHex(utf8ToBytes(highThenAscii))} ref=${expectedHighThenAscii}`);

  // 高位代理项后面跟**另一个高位代理项** ⇒ 两个都是 U+FFFD
  const twoHigh = '\uD800\uD801';
  record('B3. 连续两个孤立高位代理项 ⇒ 两个 U+FFFD',
    toHex(utf8ToBytes(twoHigh)) === '0xefbfbdefbfbd',
    `got=${toHex(utf8ToBytes(twoHigh))}`);

  /* ---------- C. 孤立低位代理项 ---------- */
  const loneLow = '\uDC00';
  record('C. 孤立低位代理项 ⇒ U+FFFD（EF BF BD）',
    toHex(utf8ToBytes(loneLow)) === '0xefbfbd',
    `got=${toHex(utf8ToBytes(loneLow))}`);

  /* ---------- D. 与 ethers.toUtf8Bytes 逐字节一致（ethers 接受的那部分） ---------- */
  //
  // ⚠️ 实测发现（ethers v6.17.0 · utils/utf8.js:176）：
  //   `ethers.toUtf8Bytes` 遇到**孤立高位代理项**会**直接抛错**
  //   （`invalid surrogate pair`），而不是编码成 U+FFFD；
  //   遇到**孤立低位代理项**则走 else 分支，产出 WTF-8（`ED B0 80`）——
  //   同样**不是** U+FFFD。
  //
  //   ⇒ 「逐字节对齐 ethers」在孤立代理项上**做不到**，因为 ethers 自己
  //   压根没有 U+FFFD 这条路径。唯一权威口径是 **WHATWG TextEncoder**
  //   （浏览器 / RN / Node 全一致），本次实现即对齐它。
  //
  //   所以：D 只对「ethers 不会抛错的样例」要求逐字节相等；
  //      D2 单独记录 ethers 的分歧（供审计留痕）。
  const ethersSafe = [
    '', 'A', '\u0000', '\u007f', '\u0080', '\u07ff', '\u0800',
    '中', '￿', '\uD83D\uDE00', '\uD800\uDE00',
    'a\uD800b\uDC00c'.replace('\uD800', 'X').replace('\uDC00', 'Y'),
  ];
  let mismatch = '';
  for (const text of ethersSafe) {
    const mine = toHex(utf8ToBytes(text));
    const ref = toHex(toUtf8Bytes(text));
    if (mine !== ref) {
      mismatch += `[${JSON.stringify(text)}] mine=${mine} ref=${ref} `;
    }
  }
  record('D. 与 ethers.toUtf8Bytes 逐字节一致（ethers 可接受样例）',
    mismatch === '', mismatch || `${ethersSafe.length} 个样例全等`);

  /* ---------- D2. 孤立代理项：与 WHATWG TextEncoder 一致（ethers 抛错/产 WTF-8） ---------- */
  const loneSamples = ['\uD800', '\uDBFF', '\uDC00', '\uDFFF', '\uD800A', '\uDE00\uD800'];
  let teMismatch = '';
  for (const text of loneSamples) {
    if (!sameAsTextEncoder(text)) {
      teMismatch += `[${JSON.stringify(text)}] mine=${toHex(utf8ToBytes(text))} `
        + `ref=${toHex(new TextEncoder().encode(text))} `;
    }
  }
  record('D2. 孤立代理项与 WHATWG TextEncoder 逐字节一致（U+FFFD 口径）',
    teMismatch === '', teMismatch || `${loneSamples.length} 个样例全等`);

  // 留痕：ethers 对孤立代理项的行为（本实现刻意**不**跟随，见上面的说明）
  let ethersThrows = false;
  try {
    toUtf8Bytes('\uD800');
  } catch (e) {
    ethersThrows = true;
  }
  record('D3. 留痕：ethers.toUtf8Bytes 对孤立高位代理项抛错（本实现改为 U+FFFD）',
    ethersThrows, ethersThrows ? 'ethers 抛错 · 本实现返回 EF BF BD' : 'ethers 未抛错');

  /* ---------- E. utf8ToHex 与 bytesToHex 同口径 ---------- */
  record('E. utf8ToHex 与 bytesToHex 一致',
    utf8ToHex('\uD800') === '0xefbfbd',
    `got=${utf8ToHex('\uD800')}`);

  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n[test] 用例 ${RESULTS.length} 个，通过 ${RESULTS.length - failed.length} 个，失败 ${failed.length} 个`);
  return failed.length === 0 ? 0 : 1;
}

process.exit(main());
