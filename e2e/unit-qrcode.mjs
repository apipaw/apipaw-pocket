/**
 * 阶段二十五 P2 · `src/utils/qrcode.ts`（644 行手写二维码编码器）**协议级**校验单测。
 *
 * 为什么要有这个用例
 * ------------------
 * `src/utils/qrcode.ts` 是控制台「扫码导入 API Key」的关键路径：
 * 它把 `paw-sk-...` 明文 Key 塞进二维码，由用户手机扫码。
 * **一旦编码出错，用户扫出来的是一串垃圾 ⇒ 静默地把 Key 暴露给错误的一方**，
 * 而且控制台**没有任何报错**（二维码只是"看起来正常"）。
 *
 * 更糟的是：文件头写着「正确性由 `scripts/verify_qrcode.mjs` 校验」，
 * **而那个脚本从来不存在** ⇒ 正确性从未被任何自动化验证过。
 * 本用例就是那个缺失的护栏（落在 CI 已有的 `e2e/unit-*.mjs` 通道里）。
 *
 * 校验思路：**三方互证**，互不共享代码
 * ------------------------------------
 *   ① 被测：`src/utils/qrcode.ts`（手写实现）
 *   ② 标准：本文件里**按 ISO/IEC 18004 重新实现**一份独立的功能图形位图 /
 *      数据区提取器 / 格式信息 BCH 解码器（不复用被测代码的任何一行）
 *   ③ 参照：`e2e/fixtures/qrcode-reference.json` —— 由**独立实现**
 *      Python `qrcode` 库（libqrencode 血统）离线生成并提交进仓
 *
 * 断言分组
 * --------
 *   A. 结构：矩阵尺寸 / 定位符 / 分隔符 / 定时图形 / 校正图形 / 暗模块
 *   B. 格式信息：15 位 BCH(15,5) 校验、纠错等级位、掩码编号
 *   C. 参考一致性：反掩码后**数据区比特流**与参照实现逐位相同
 *      （掩码差异用"试 8 种掩码唯一命中"消解 ⇒ 比对的是码字本身）
 *   D. 容量：ISO 标准字节容量表逐格核对 + 边界（正好装满 / 超 1 字节）
 *   E. 载荷覆盖：短 ASCII / 长 URL / `paw-sk-...` API Key / UTF-8 中文
 *
 * 跑法（Git Bash / 仓库根目录）：
 *   node e2e/unit-qrcode.mjs
 *
 * 依赖：Node >= 22.6（原生类型剥离，可直接 import .ts）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeQr, byteCapacity, matrixToRows } from '../src/utils/qrcode.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(HERE, 'fixtures', 'qrcode-reference.json'), 'utf8'),
);

const RESULTS = [];

function record(name, ok, detail = '') {
  RESULTS.push({ name, ok, detail });
  console.log((ok ? '[PASS] ' : '[FAIL] ') + name + (detail ? ' | ' + detail : ''));
}

function check(name, cond, detail = '') {
  record(name, Boolean(cond), detail);
}

/* ==================================================================
 * ② 标准侧：按 ISO/IEC 18004 独立实现（**不复用**被测代码）
 * ================================================================== */

/** 版本 1~6 的校正图形中心坐标（ISO/IEC 18004 表 E.1）。 */
const ALIGN_CENTERS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
};

/** 纠错等级 → 格式信息里的 2 位等级位（L=01 / M=00 / Q=11 / H=10）。 */
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };
const ECC_FROM_BITS = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

/**
 * 功能图形位图：true = 功能模块（定位符/分隔符/定时/校正/格式信息/暗模块）。
 * 这是"哪些模块承载数据"的唯一判据，数据区提取必须依赖它。
 */
function functionMap(version) {
  const size = 17 + 4 * version;
  const map = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => {
    if (r >= 0 && c >= 0 && r < size && c < size) map[r][c] = true;
  };

  // 定位符 + 分隔符（三个角）
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let r = r0 - 1; r <= r0 + 7; r += 1) {
      for (let c = c0 - 1; c <= c0 + 7; c += 1) mark(r, c);
    }
  }
  // 定时图形（行 6 / 列 6，跳过定位符区）
  for (let i = 8; i <= size - 9; i += 1) {
    mark(6, i);
    mark(i, 6);
  }
  // 校正图形（与三个定位符重叠的位置跳过）
  const centers = ALIGN_CENTERS[version];
  const last = centers.length - 1;
  for (let i = 0; i < centers.length; i += 1) {
    for (let j = 0; j < centers.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) mark(centers[i] + dr, centers[j] + dc);
      }
    }
  }
  // 格式信息（两份）+ 暗模块
  for (let i = 0; i <= 5; i += 1) mark(i, 8);
  mark(7, 8);
  mark(8, 8);
  mark(8, 7);
  for (let i = 9; i < 15; i += 1) mark(8, 14 - i);
  for (let i = 0; i < 8; i += 1) mark(8, size - 1 - i);
  for (let i = 8; i < 15; i += 1) mark(size - 15 + i, 8);
  mark(size - 8, 8);
  return map;
}

/** 8 种掩码的标准判定式（ISO/IEC 18004 表 24）。 */
function maskHits(mask, row, col) {
  switch (mask) {
    case 0: return (row + col) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return col % 3 === 0;
    case 3: return (row + col) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5: return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6: return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    case 7: return ((((row + col) % 2) + ((row * col) % 3)) % 2) === 0;
    default: return false;
  }
}

/**
 * 按标准的之字形布点顺序提取数据区比特，并**反掩码**。
 * 返回 '0'/'1' 串 —— 它就是码字本身的比特流（与掩码无关）。
 */
function extractDataBits(matrix, funcMap, mask) {
  const size = matrix.length;
  const bits = [];
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // 跳过垂直定时图形列
    const upward = ((right + 1) & 2) === 0;
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const col = right - j;
        const row = upward ? size - 1 - vert : vert;
        if (funcMap[row][col]) continue;
        let bit = matrix[row][col];
        if (maskHits(mask, row, col)) bit = !bit;
        bits.push(bit ? '1' : '0');
      }
    }
  }
  return bits.join('');
}

/** GF(2)[x] 多项式取余（格式信息生成多项式 0x537）。 */
function bchRemainder15(value) {
  let rem = value & 0x7fff;
  for (let i = 14; i >= 10; i -= 1) {
    if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
  }
  return rem;
}

/** 从矩阵里读出 15 位格式信息码并解码（纠错等级 + 掩码编号）。 */
function readFormatInfo(matrix) {
  const size = matrix.length;
  const at = (r, c) => (matrix[r][c] ? 1 : 0);
  let bits = 0;
  for (let i = 0; i <= 5; i += 1) if (at(i, 8)) bits |= 1 << i;
  if (at(7, 8)) bits |= 1 << 6;
  if (at(8, 8)) bits |= 1 << 7;
  if (at(8, 7)) bits |= 1 << 8;
  for (let i = 9; i < 15; i += 1) if (at(8, 14 - i)) bits |= 1 << i;
  const unmasked = bits ^ 0x5412;
  const data = unmasked >> 10; // 高 5 位 = 纠错等级(2) + 掩码(3)
  return {
    bits,
    bchValid: bchRemainder15(unmasked) === 0,
    ecc: ECC_FROM_BITS[(data >> 3) & 0x3],
    mask: data & 0x7,
  };
}

/** '0101...' 字符串 → 布尔矩阵。 */
function toMatrix(rows) {
  return rows.map((row) => row.split('').map((ch) => ch === '1'));
}

/* ==================================================================
 * 断言
 * ================================================================== */

/** ISO/IEC 18004 字节模式容量表（版本 → 纠错等级 → 字节数）。 */
const ISO_CAPACITY = {
  1: { L: 17, M: 14, Q: 11, H: 7 },
  2: { L: 32, M: 26, Q: 20, H: 14 },
  3: { L: 53, M: 42, Q: 32, H: 24 },
  4: { L: 78, M: 62, Q: 46, H: 34 },
  5: { L: 106, M: 84, Q: 60, H: 44 },
  6: { L: 134, M: 106, Q: 74, H: 58 },
};

function checkFinder(matrix, cx, cy, label) {
  // 7×7 定位符：外环暗、次环亮、内 3×3 暗
  let ok = true;
  for (let dy = -3; dy <= 3; dy += 1) {
    for (let dx = -3; dx <= 3; dx += 1) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy));
      const want = dist !== 2;
      if (Boolean(matrix[cy + dy][cx + dx]) !== want) ok = false;
    }
  }
  check(`A2 定位符 ${label}（7×7 外暗/次亮/内暗）`, ok);
}

function main() {
  /* ---------- A/B/C：逐个参考用例三方互证 ---------- */
  for (const c of FIXTURE.cases) {
    const tag = c.name;
    let ours;
    try {
      ours = encodeQr(c.payload, c.ecc);
    } catch (err) {
      check(`C0 ${tag} 编码不抛异常`, false, String(err && err.message));
      continue;
    }

    /* ---- A. 结构 ---- */
    check(
      `A1 ${tag} 矩阵尺寸 = 17+4×版本`,
      ours.size === 17 + 4 * ours.version && ours.size === c.size,
      `ours=${ours.size} ref=${c.size} v=${ours.version}`,
    );
    check(
      `A1b ${tag} 选版与参照实现一致`,
      ours.version === c.version,
      `ours=v${ours.version} ref=v${c.version}`,
    );
    check(
      `A1c ${tag} matrixToRows 与 matrix 一致`,
      matrixToRows(ours.matrix).length === ours.size
        && matrixToRows(ours.matrix).every((row, i) => row.length === ours.size
          && row.split('').every((ch, j) => (ch === '1') === Boolean(ours.matrix[i][j]))),
    );

    checkFinder(ours.matrix, 3, 3, '左上');
    checkFinder(ours.matrix, ours.size - 4, 3, '右上');
    checkFinder(ours.matrix, 3, ours.size - 4, '左下');

    // 分隔符：定位符外圈必须是浅色
    const sep = [];
    for (let i = 0; i <= 7; i += 1) {
      sep.push(ours.matrix[7][i], ours.matrix[i][7]);
      sep.push(ours.matrix[7][ours.size - 1 - i], ours.matrix[i][ours.size - 8]);
      sep.push(ours.matrix[ours.size - 8][i], ours.matrix[ours.size - 1 - i][7]);
    }
    check(`A3 ${tag} 分隔符全浅色`, sep.every((v) => v === false));

    // 定时图形：行 6 / 列 6 交替（起点为暗）
    let timingOk = true;
    for (let i = 8; i <= ours.size - 9; i += 1) {
      if (ours.matrix[6][i] !== (i % 2 === 0)) timingOk = false;
      if (ours.matrix[i][6] !== (i % 2 === 0)) timingOk = false;
    }
    check(`A4 ${tag} 定时图形行/列交替`, timingOk);

    // 校正图形（5×5 环）落在 ISO 规定的位置
    let alignOk = true;
    const centers = ALIGN_CENTERS[ours.version];
    if (centers.length > 1) {
      const cr = centers[centers.length - 1];
      const cc = centers[centers.length - 1];
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const want = dist !== 1;
          if (Boolean(ours.matrix[cr + dy][cc + dx]) !== want) alignOk = false;
        }
      }
    }
    check(`A5 ${tag} 校正图形 5×5 环位`, alignOk);

    // 暗模块（固定深色）
    check(
      `A6 ${tag} 暗模块 (4v+9, 8) 为深色`,
      ours.matrix[ours.size - 8][8] === true,
    );

    /* ---- B. 格式信息 ---- */
    const fmt = readFormatInfo(ours.matrix);
    check(`B1 ${tag} 格式信息 BCH(15,5) 校验通过`, fmt.bchValid, `bits=${fmt.bits}`);
    check(
      `B2 ${tag} 格式信息里的纠错等级 = ${c.ecc}`,
      fmt.ecc === c.ecc,
      `read=${fmt.ecc}`,
    );
    check(
      `B3 ${tag} 格式信息里的掩码 = 编码返回值`,
      fmt.mask === ours.mask,
      `read=${fmt.mask} ours=${ours.mask}`,
    );

    /* ---- C. 参考一致性（反掩码后的数据区比特流） ---- */
    const ourMap = functionMap(ours.version);
    const ourBits = extractDataBits(ours.matrix, ourMap, ours.mask);
    const refMap = toMatrix(FIXTURE.function_maps[String(c.version)]);
    const refMatrix = toMatrix(c.rows);
    const hits = [];
    for (let m = 0; m < 8; m += 1) {
      if (extractDataBits(refMatrix, refMap, m) === ourBits) hits.push(m);
    }
    check(
      `C1 ${tag} 数据区码字与参照实现逐位一致`,
      hits.length === 1,
      `命中掩码=${JSON.stringify(hits)} 参照掩码=${c.ref_mask}`,
    );
    check(
      `C2 ${tag} 唯一命中的掩码就是参照实现的掩码`,
      hits.length === 1 && hits[0] === c.ref_mask,
      `hits=${JSON.stringify(hits)} ref=${c.ref_mask}`,
    );

    /* ---- 功能图形位图：标准侧独立实现 vs 参照实现 ---- */
    let mapDiff = 0;
    for (let r = 0; r < ours.size; r += 1) {
      for (let cc2 = 0; cc2 < ours.size; cc2 += 1) {
        if (ourMap[r][cc2] !== refMap[r][cc2]) mapDiff += 1;
      }
    }
    check(
      `C3 ${tag} 功能图形位图 = 参照实现（标准侧独立实现）`,
      mapDiff === 0,
      `差异格数=${mapDiff}`,
    );
  }

  /* ---------- D. 容量 ---------- */
  let capOk = true;
  const capDetail = [];
  for (const v of [1, 2, 3, 4, 5, 6]) {
    for (const ecc of ['L', 'M', 'Q', 'H']) {
      const got = byteCapacity(v, ecc);
      const want = ISO_CAPACITY[v][ecc];
      if (got !== want) {
        capOk = false;
        capDetail.push(`v${v}${ecc}: got=${got} want=${want}`);
      }
    }
  }
  check('D1 字节容量逐格等于 ISO/IEC 18004 标准表', capOk, capDetail.join('; '));

  let monoOk = true;
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    for (let v = 2; v <= 6; v += 1) {
      if (byteCapacity(v, ecc) <= byteCapacity(v - 1, ecc)) monoOk = false;
    }
  }
  check('D2 容量随版本严格递增', monoOk);

  // 边界：正好装满 v6/M
  const cap6 = byteCapacity(6, 'M');
  const exact = 'A'.repeat(cap6);
  let exactVersion = -1;
  try {
    exactVersion = encodeQr(exact, 'M').version;
  } catch (err) {
    exactVersion = -1;
  }
  check(
    'D3 载荷正好等于上限时落在版本 6',
    exactVersion === 6,
    `cap=${cap6} version=${exactVersion}`,
  );

  let overThrew = false;
  let overMsg = '';
  try {
    encodeQr('A'.repeat(cap6 + 1), 'M');
  } catch (err) {
    overThrew = true;
    overMsg = String(err && err.message);
  }
  check('D4 超容量 1 字节时抛错并给出明确文案', overThrew && overMsg.includes('载荷过长'), overMsg);

  /* ---------- E. 载荷覆盖 ---------- */
  const kinds = [
    ['短 ASCII', (s) => /^[\x20-\x7e]+$/.test(s)],
    ['长 URL', (s) => s.startsWith('https://') && s.length > 60],
    ['paw-sk API Key', (s) => /^paw-sk-[0-9a-f]{32}$/.test(s)],
    ['UTF-8 中文', (s) => /[一-鿿]/.test(s)],
  ];
  for (const [label, match] of kinds) {
    const found = FIXTURE.cases.filter((c) => match(c.payload));
    check(`E1 ${label} 载荷已被参考用例覆盖`, found.length > 0, `命中 ${found.length} 个`);
  }

  // 中文载荷按 **UTF-8 字节数** 选版（不是字符数）
  const cn = FIXTURE.cases.find((c) => c.name === 'utf8_cn');
  const cnBytes = Buffer.from(cn.payload, 'utf8').length;
  const cnChars = cn.payload.length;
  check(
    'E2 中文载荷的 UTF-8 字节数 > 字符数（选版必须按字节）',
    cnBytes > cnChars && byteCapacity(cn.version, cn.ecc) >= cnBytes,
    `bytes=${cnBytes} chars=${cnChars} v=${cn.version}`,
  );

  /* ---------- 汇总 ---------- */
  const failed = RESULTS.filter((r) => !r.ok);
  console.log('');
  console.log('==============================================================');
  console.log(`[test] 用例 ${RESULTS.length} 个，通过 ${RESULTS.length - failed.length} 个，失败 ${failed.length} 个`);
  if (failed.length) {
    for (const f of failed) console.log(`  FAIL: ${f.name} | ${f.detail}`);
  }
  console.log('==============================================================');
  if (failed.length) process.exit(1);
}

main();
