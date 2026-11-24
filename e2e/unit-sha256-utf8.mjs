/**
 * 阶段二十二 P1 复核加固 · `src/utils/sha256.ts` UTF-8 编码口径单测。
 *
 * 为什么要有这个用例：
 *   `sha256.ts` 是**默克尔状态根浏览器端验真**用的自研 SHA-256。
 *   它的 `utf8Bytes` 原来把**孤立代理项（lone surrogate）**当普通 3 字节字符
 *   （`"\uD800"` → `ED A0 80`，即 WTF-8 / CESU-8 的**非法 UTF-8**），
 *   而 WHATWG `TextEncoder`（浏览器 / RN / Node 全一致）的口径是
 *   **任何无法配对的代理项一律编码为 U+FFFD（`EF BF BD`）**。
 *
 *   两边不一致 ⇒ 同一段文本在浏览器与 RN 里算出的摘要不同
 *   ⇒ 默克尔根两套实现对不上 ⇒ **验真随机失败**（且不抛异常，
 *   只在真实用户的中文/emoji 内容上炸）。
 *
 *   本用例与 `e2e/unit-eth-utf8.mjs`（钱包签名口径）**互为对照**：
 *   钱包与默克尔两条链路必须产出**同一套** UTF-8 字节。
 *
 * 断言口径（摘要级，逐位对齐 Node `crypto`）：
 *   A. ASCII / 中文 / 合法代理项对 ⇒ 与 `crypto.createHash('sha256')` 一致；
 *   B. 孤立高位 / 低位代理项 ⇒ 等价于 U+FFFD（`EF BF BD`），且**不吞掉**
 *      后一个码元；
 *   C. 连续孤立代理项 ⇒ 逐个 U+FFFD；
 *   D. 与 `src/wallet/eth.ts` 的 `utf8ToBytes` **同口径**（同一份字节）；
 *   E. 默克尔根重算口径未受影响（左右顺序 + sides）。
 *
 * 跑法（Git Bash / 仓库根目录）：
 *   node e2e/unit-sha256-utf8.mjs
 *
 * 依赖：Node >= 22.6（原生类型剥离，可直接 import .ts）。
 */

import { createHash } from 'node:crypto';
import { sha256Hex, merkleRootFrom } from '../src/utils/sha256.ts';
import { utf8ToBytes } from '../src/wallet/eth.ts';

const RESULTS = [];

function record(name, ok, detail = '') {
  RESULTS.push({ name, ok, detail });
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? ' | ' + detail : ''));
}

const toHex = (bytes) =>
  '0x' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');

/** 权威参照：Node 的 SHA-256（输入 = WHATWG TextEncoder 的字节）。 */
const refSha256 = (text) =>
  createHash('sha256').update(Buffer.from(new TextEncoder().encode(text))).digest('hex');

function main() {
  /* ---------- A. 常规文本 ---------- */
  const normal = [
    ['', '空串'],
    ['hello apipaw', '纯 ASCII'],
    ['业主免插件口令', '中文（3 字节）'],
    ['é', '拉丁扩展（2 字节）'],
    ['😀', 'emoji（合法代理项对 → 4 字节）'],
    ['a😀中', '混合 ASCII + emoji + 中文'],
    ['\u0000\u007f\u0080\u07ff\u0800', '编码边界样例'],
  ];
  for (const [text, label] of normal) {
    const mine = sha256Hex(text);
    const ref = refSha256(text);
    record(`A. ${label} 摘要与 Node crypto 一致`, mine === ref,
      `mine=${mine.slice(0, 16)}… ref=${ref.slice(0, 16)}…`);
  }

  /* ---------- B. 孤立代理项 ⇒ U+FFFD ---------- */
  //
  // 直接断言「等价于把孤立代理项换成 U+FFFD 后再哈希」——
  // 这比断言字节更贴近真实语义（U+FFFD 编码出来就是 EF BF BD）。
  const loneHigh = '\uD800';
  record('B. 孤立高位代理项 ⇒ 与 U+FFFD 同摘要（即 EF BF BD）',
    sha256Hex(loneHigh) === sha256Hex('\uFFFD'),
    `mine=${sha256Hex(loneHigh).slice(0, 16)}… ufffd=${sha256Hex('\uFFFD').slice(0, 16)}…`);

  const loneLow = '\uDC00';
  record('B2. 孤立低位代理项 ⇒ 与 U+FFFD 同摘要',
    sha256Hex(loneLow) === sha256Hex('\uFFFD'),
    `mine=${sha256Hex(loneLow).slice(0, 16)}…`);

  // 孤立高位代理项后面跟一个普通字符 ⇒ 不得吞掉那个字符
  const highThenAscii = '\uD800A';
  record('B3. 孤立高位代理项**不吞掉**后一个 ASCII 码元',
    sha256Hex(highThenAscii) === refSha256(highThenAscii),
    `mine=${sha256Hex(highThenAscii).slice(0, 16)}… ref=${refSha256(highThenAscii).slice(0, 16)}…`);

  // 连续两个孤立高位代理项 ⇒ 两个都是 U+FFFD（不是 6 字节 WTF-8）
  const twoHigh = '\uD800\uD801';
  record('B4. 连续两个孤立高位代理项 ⇒ 两个 U+FFFD',
    sha256Hex(twoHigh) === sha256Hex('\uFFFD\uFFFD'),
    `mine=${sha256Hex(twoHigh).slice(0, 16)}…`);

  // 高位 + 低位顺序颠倒（先低位后高位）⇒ 两个 U+FFFD
  const lowThenHigh = '\uDC00\uD800';
  record('B5. 低位在前 ⇒ 两个 U+FFFD',
    sha256Hex(lowThenHigh) === sha256Hex('\uFFFD\uFFFD'),
    `mine=${sha256Hex(lowThenHigh).slice(0, 16)}…`);

  /* ---------- C. 全部孤立代理项样例与 TextEncoder 对齐 ---------- */
  const loneSamples = ['\uD800', '\uDBFF', '\uDC00', '\uDFFF', '\uD800A', '\uDE00\uD800'];
  let mismatch = '';
  for (const text of loneSamples) {
    if (sha256Hex(text) !== refSha256(text)) {
      mismatch += `[${JSON.stringify(text)}] mine=${sha256Hex(text).slice(0, 12)}… `
        + `ref=${refSha256(text).slice(0, 12)}… `;
    }
  }
  record('C. 孤立代理项样例与 WHATWG TextEncoder 摘要全等',
    mismatch === '', mismatch || `${loneSamples.length} 个样例全等`);

  /* ---------- D. 与钱包签名口径（eth.ts）同源 ---------- */
  //
  // 钱包链路算 personal_sign 摘要、默克尔链路算叶子摘要 ——
  // 两者若用**不同的 UTF-8 口径**，同一段文本在两个功能里会得到不同的字节，
  // 表现为「钱包能签、默克尔验不过」这种极难定位的问题。
  const crossSamples = [
    '', 'hello', '中文口令', '😀', '\uD800', '\uDC00', 'a\uD800b\uDC00c',
  ];
  const shaBytes = (text) => Buffer.from(sha256Hex(text), 'hex');
  // 用「同一份字节」验证：sha256(utf8Bytes(x)) 必须等于 eth.ts 口径的 sha256
  let crossMismatch = '';
  for (const text of crossSamples) {
    const ethBytes = utf8ToBytes(text);
    const ethSha = createHash('sha256').update(Buffer.from(ethBytes)).digest('hex');
    if (shaBytes(text).toString('hex') !== ethSha) {
      crossMismatch += `[${JSON.stringify(text)}] mine=${shaBytes(text).toString('hex').slice(0, 12)}… `
        + `eth=${ethSha.slice(0, 12)}… `;
    }
  }
  record('D. 与 eth.ts 的 UTF-8 口径逐样例同源（摘要一致）',
    crossMismatch === '', crossMismatch || `${crossSamples.length} 个样例全等`);

  /* ---------- E. 默克尔根重算未受影响 ---------- */
  //
  // ⚠️ 本项目的默克尔口径是 **sha256-hex-merkle**：父节点 =
  // ``sha256(left_hex + right_hex)`` —— 对**十六进制串**再哈希，
  // **不是** RFC 6962 的 0x01/0x02 二进制域，也不是对原始字节再哈希。
  // 服务端 `merkle_state.py` 与客户端必须完全一致，否则根对不上。
  const leaf = sha256Hex('leaf-1');
  const sib = sha256Hex('leaf-2');
  const hexSha = (text) =>
    createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

  const rootRight = merkleRootFrom(leaf, [sib]);
  record('E1. 默克尔根：兄弟恒在右（默认口径）',
    rootRight === hexSha(leaf + sib), `got=${rootRight.slice(0, 16)}…`);

  const rootLeft = merkleRootFrom(leaf, [sib], ['L']);
  record('E2. 默克尔根：兄弟在左（sides=L）',
    rootLeft === hexSha(sib + leaf), `got=${rootLeft.slice(0, 16)}…`);

  // 多层：兄弟链逐层重算（顺序不可颠倒）
  const leaf3 = sha256Hex('leaf-3');
  const root3 = merkleRootFrom(leaf3, [sib, rootRight], ['R', 'R']);
  const expected3 = hexSha(hexSha(leaf3 + sib) + rootRight);
  record('E3. 默克尔根：多层兄弟链逐层重算',
    root3 === expected3, `got=${root3.slice(0, 16)}…`);

  const failed = RESULTS.filter((r) => !r.ok);
  console.log(`\n[test] 用例 ${RESULTS.length} 个，通过 ${RESULTS.length - failed.length} 个，失败 ${failed.length} 个`);
  return failed.length === 0 ? 0 : 1;
}

process.exit(main());
