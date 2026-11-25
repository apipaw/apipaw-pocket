/**
 * 极简 QR 码编码器 —— **零依赖、纯前端**。
 *
 * 为什么自己写：控制台要支持「扫码导入 API Key」（二维码里带网关地址 + Key），
 * 而 RN/Expo 的运行环境里塞一个二维码库既增加包体、又要在 web 端单独适配。
 * 这里只实现**字节模式（UTF-8）· 版本 1~6 · 四档纠错**，足够承载
 * `apipaw://key?...` 这种几十字节的载荷。
 *
 * 算法依据 ISO/IEC 18004（实现思路与业界公开参考实现一致）：
 *   1. 比特流：模式指示(0100) + 字符计数(8 bit) + 字节 + 终止符 + 填充
 *   2. 分块 + Reed-Solomon 纠错 + 交织
 *   3. 功能图形（定位/校正/定时/格式信息/暗模块）
 *   4. 之字形布点 + 8 种掩码 + 惩罚分选优
 *
 * ⚠️ 正确性由 `e2e/unit-qrcode.mjs` 校验（阶段二十五 P2 补齐）：
 *    本文件与 Python `qrcode` 库（**独立实现**）逐模块比对，基准数据在
 *    `e2e/fixtures/qrcode-reference.json`；该用例已接入 CI
 *    （`.github/workflows/ci.yml` 跑全部 `e2e/unit-*.mjs`），改动后必须重跑。
 */

export type ECCLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrResult {
  /** 行 × 列矩阵；true = 深色模块 */
  matrix: boolean[][];
  size: number;
  version: number;
  mask: number;
  ecc: ECCLevel;
}

interface BlockGroup {
  /** 块数 */
  count: number;
  /** 每块的总码字数（含纠错） */
  total: number;
  /** 每块的数据码字数 */
  data: number;
}

interface VersionSpec {
  blocks: BlockGroup[];
  /** 校正图形中心坐标（升序） */
  alignment: number[];
}

const ECC_ORDER: ECCLevel[] = ['L', 'M', 'Q', 'H'];

/** 格式信息里的纠错级别位（L=01 / M=00 / Q=11 / H=10） */
const ECC_FORMAT_BITS: Record<ECCLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

/** 版本 1~6 的分块表（count, total, data）——来自 ISO/IEC 18004 表 13~22 */
const VERSIONS: Record<number, VersionSpec> = {
  1: {
    blocks: [
      { count: 1, total: 26, data: 19 },
      { count: 1, total: 26, data: 16 },
      { count: 1, total: 26, data: 13 },
      { count: 1, total: 26, data: 9 },
    ],
    alignment: [],
  },
  2: {
    blocks: [
      { count: 1, total: 44, data: 34 },
      { count: 1, total: 44, data: 28 },
      { count: 1, total: 44, data: 22 },
      { count: 1, total: 44, data: 16 },
    ],
    alignment: [6, 18],
  },
  3: {
    blocks: [
      { count: 1, total: 70, data: 55 },
      { count: 1, total: 70, data: 44 },
      { count: 2, total: 35, data: 17 },
      { count: 2, total: 35, data: 13 },
    ],
    alignment: [6, 22],
  },
  4: {
    blocks: [
      { count: 1, total: 100, data: 80 },
      { count: 2, total: 50, data: 32 },
      { count: 2, total: 50, data: 24 },
      { count: 4, total: 25, data: 9 },
    ],
    alignment: [6, 26],
  },
  5: {
    blocks: [
      { count: 1, total: 134, data: 108 },
      { count: 2, total: 67, data: 43 },
      { count: 2, total: 33, data: 15 },
      { count: 2, total: 34, data: 16 },
    ],
    alignment: [6, 30],
  },
  6: {
    blocks: [
      { count: 2, total: 86, data: 68 },
      { count: 4, total: 43, data: 27 },
      { count: 4, total: 43, data: 19 },
      { count: 4, total: 43, data: 15 },
    ],
    alignment: [6, 34],
  },
};

/** 某些版本的表是「两组混合」，需要特殊处理（v5 的 Q/H）。 */
const MIXED_VERSIONS: Record<number, Record<ECCLevel, BlockGroup[]>> = {
  5: {
    L: [{ count: 1, total: 134, data: 108 }],
    M: [{ count: 2, total: 67, data: 43 }],
    Q: [
      { count: 2, total: 33, data: 15 },
      { count: 2, total: 34, data: 16 },
    ],
    H: [
      { count: 2, total: 33, data: 11 },
      { count: 2, total: 34, data: 12 },
    ],
  },
};

/* ------------------------------------------------------------------ GF(256) */
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);

(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** 生成 RS 生成多项式（不含最高位的 1），长度 = degree */
function rsDivisor(degree: number): Uint8Array {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

/** 计算数据码字的 RS 纠错码字 */
function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const result = new Uint8Array(divisor.length);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let j = 0; j < divisor.length; j += 1) {
      result[j] ^= gfMul(divisor[j], factor);
    }
  }
  return result;
}

/* ------------------------------------------------------------- 工具函数 */
function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i += 1;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(out);
}

function groupsFor(version: number, ecc: ECCLevel): BlockGroup[] {
  const mixed = MIXED_VERSIONS[version];
  if (mixed && mixed[ecc]) return mixed[ecc];
  const spec = VERSIONS[version];
  const group = spec.blocks[ECC_ORDER.indexOf(ecc)];
  return [group];
}

function dataCodewordsOf(version: number, ecc: ECCLevel): number {
  return groupsFor(version, ecc).reduce((sum, g) => sum + g.count * g.data, 0);
}

/** 字节模式容量（版本 1~9 的字符计数是 8 bit ⇒ 容量 = 数据码字数 - 2） */
export function byteCapacity(version: number, ecc: ECCLevel): number {
  return dataCodewordsOf(version, ecc) - 2;
}

/* --------------------------------------------------------- 矩阵构造 */
class QrMatrix {
  size: number;

  modules: boolean[][];

  isFunction: boolean[][];

  constructor(size: number) {
    this.size = size;
    this.modules = [];
    this.isFunction = [];
    for (let i = 0; i < size; i += 1) {
      this.modules.push(new Array<boolean>(size).fill(false));
      this.isFunction.push(new Array<boolean>(size).fill(false));
    }
  }

  get(x: number, y: number): boolean {
    return this.modules[y][x];
  }

  setFunction(x: number, y: number, dark: boolean): void {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    this.modules[y][x] = dark;
    this.isFunction[y][x] = true;
  }

  drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = cx + dx;
        const yy = cy + dy;
        if (xx >= 0 && yy >= 0 && xx < this.size && yy < this.size) {
          this.setFunction(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  drawAlignment(cx: number, cy: number): void {
    for (let dy = -2; dy <= 2; dy += 1) {
      for (let dx = -2; dx <= 2; dx += 1) {
        this.setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  drawFormatBits(ecc: ECCLevel, mask: number): void {
    const data = (ECC_FORMAT_BITS[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i += 1) {
      rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    }
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;

    // 第一份
    for (let i = 0; i <= 5; i += 1) this.setFunction(8, i, bit(i));
    this.setFunction(8, 7, bit(6));
    this.setFunction(8, 8, bit(7));
    this.setFunction(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) this.setFunction(14 - i, 8, bit(i));

    // 第二份
    for (let i = 0; i < 8; i += 1) this.setFunction(this.size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) this.setFunction(8, this.size - 15 + i, bit(i));
    // 永远是深色的暗模块
    this.setFunction(8, this.size - 8, true);
  }

  drawFunctionPatterns(version: number, ecc: ECCLevel): void {
    const size = this.size;
    // ⚠️ **顺序很重要**：定时图形必须**先画**，定位图形**后画** ——
    //    否则定时图形会覆盖定位图形第 6 行/第 6 列（那几格属于定位图形本身，
    //    被打成"浅色"就会让扫码器认不出来）。
    for (let i = 0; i < size; i += 1) {
      this.setFunction(6, i, i % 2 === 0);
      this.setFunction(i, 6, i % 2 === 0);
    }
    // 定位图形 + 分隔符
    this.drawFinder(3, 3);
    this.drawFinder(size - 4, 3);
    this.drawFinder(3, size - 4);
    // 校正图形（与定位图形重叠的位置跳过）
    const centers = VERSIONS[version].alignment;
    const last = centers.length - 1;
    for (let i = 0; i < centers.length; i += 1) {
      for (let j = 0; j < centers.length; j += 1) {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) {
          continue;
        }
        this.drawAlignment(centers[i], centers[j]);
      }
    }
    // 先占位格式信息区域（真正写入在选完掩码之后）
    this.drawFormatBits(ecc, 0);
  }

  drawCodewords(data: Uint8Array): void {
    let i = 0;
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < this.size; vert += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = ((data[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
            i += 1;
          }
          // eslint-disable-next-line no-plusplus
          i += 0;
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (this.isFunction[y][x]) continue;
        let invert = false;
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break;
          case 1: invert = y % 2 === 0; break;
          case 2: invert = x % 3 === 0; break;
          case 3: invert = (x + y) % 3 === 0; break;
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
          case 7: invert = ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0; break;
          default: break;
        }
        if (invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  penalty(): number {
    const size = this.size;
    let result = 0;

    // 规则 1：同色连续 5 个以上，每 5 个加 3 分
    for (let y = 0; y < size; y += 1) {
      let runColor = false;
      let runX = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x += 1) {
        if (this.modules[y][x] === runColor) {
          runX += 1;
          if (runX === 5) result += 3;
          else if (runX > 5) result += 1;
        } else {
          this._finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this._finderPenaltyCountPatterns(runHistory) * 40;
          runColor = this.modules[y][x];
          runX = 1;
        }
      }
      result += this._finderPenaltyTerminateAndCount(runColor, runX, runHistory) * 40;
    }
    for (let x = 0; x < size; x += 1) {
      let runColor = false;
      let runY = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y += 1) {
        if (this.modules[y][x] === runColor) {
          runY += 1;
          if (runY === 5) result += 3;
          else if (runY > 5) result += 1;
        } else {
          this._finderPenaltyAddHistory(runY, runHistory);
          if (!runColor) result += this._finderPenaltyCountPatterns(runHistory) * 40;
          runColor = this.modules[y][x];
          runY = 1;
        }
      }
      result += this._finderPenaltyTerminateAndCount(runColor, runY, runHistory) * 40;
    }

    // 规则 2：2×2 同色块，每块 +3
    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const c = this.modules[y][x];
        if (c === this.modules[y][x + 1] && c === this.modules[y + 1][x] && c === this.modules[y + 1][x + 1]) {
          result += 3;
        }
      }
    }

    // 规则 3：1:1:3:1:1 图案（前后各留 4 个浅色），每处 +40
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (this._hasFinderPatternAt(x, y)) result += 40;
      }
    }

    // 规则 4：深色比例偏离 50%
    let dark = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (this.modules[y][x]) dark += 1;
      }
    }
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * 10;
    return result;
  }

  private _finderPenaltyAddHistory(currentRunLength: number, runHistory: number[]): void {
    if (runHistory[0] === 0) currentRunLength += this.size; // 隐形的浅色边缘
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  }

  private _finderPenaltyCountPatterns(runHistory: number[]): number {
    const n = runHistory[1];
    const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3
      && runHistory[4] === n && runHistory[5] === n;
    return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
      + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
  }

  private _finderPenaltyTerminateAndCount(
    runColor: boolean, runLength: number, runHistory: number[],
  ): number {
    if (runColor) {
      this._finderPenaltyAddHistory(runLength, runHistory);
      runLength = 0;
    }
    runLength += this.size;
    this._finderPenaltyAddHistory(runLength, runHistory);
    return this._finderPenaltyCountPatterns(runHistory);
  }

  private _hasFinderPatternAt(x: number, y: number): boolean {
    const size = this.size;
    const get = (xx: number, yy: number) => {
      if (xx < 0 || yy < 0 || xx >= size || yy >= size) return false;
      return this.modules[yy][xx];
    };
    const core = (ox: number, oy: number) => (
      get(x + ox, y + oy)
      && !get(x + ox + 1, y + oy)
      && get(x + ox + 2, y + oy)
      && get(x + ox + 3, y + oy)
      && get(x + ox + 4, y + oy)
      && !get(x + ox + 5, y + oy)
      && get(x + ox + 6, y + oy)
      && !get(x + ox, y + oy + 1)
      && get(x + ox + 2, y + oy + 1)
      && get(x + ox + 4, y + oy + 1)
      && get(x + ox + 6, y + oy + 1)
      && !get(x + ox, y + oy + 2)
      && get(x + ox + 2, y + oy + 2)
      && get(x + ox + 4, y + oy + 2)
      && get(x + ox + 6, y + oy + 2)
      && !get(x + ox, y + oy + 3)
      && get(x + ox + 2, y + oy + 3)
      && get(x + ox + 4, y + oy + 3)
      && get(x + ox + 6, y + oy + 3)
      && !get(x + ox, y + oy + 4)
      && get(x + ox + 2, y + oy + 4)
      && get(x + ox + 4, y + oy + 4)
      && get(x + ox + 6, y + oy + 4)
      && !get(x + ox, y + oy + 5)
      && get(x + ox + 2, y + oy + 5)
      && get(x + ox + 4, y + oy + 5)
      && get(x + ox + 6, y + oy + 5)
      && !get(x + ox, y + oy + 6)
      && get(x + ox + 2, y + oy + 6)
      && get(x + ox + 4, y + oy + 6)
      && get(x + ox + 6, y + oy + 6)
    );
    // 1:1:3:1:1 比率（前 4 个浅色）+ 中心 3 深 3 浅 1 深
    const ratio = (ox: number, oy: number) => {
      const pattern = [true, false, true, true, true, false, true];
      for (let i = 0; i < 7; i += 1) {
        if (get(x + ox + i, y + oy) !== pattern[i]) return false;
      }
      return true;
    };
    const light = (ox: number, oy: number) => {
      for (let i = 0; i < 4; i += 1) {
        if (get(x + ox + i, y + oy)) return false;
      }
      return true;
    };
    return (
      (light(-4, 0) && ratio(0, 0))
      || (light(0, -4) && ratio(0, 0))
      || (light(0, 0) && ratio(0, 4))
      || (light(0, 0) && ratio(4, 0))
    ) || (core(0, 0) && false);
  }
}

/** 分块 + 纠错 + 交织 */
function buildCodewords(
  data: Uint8Array, version: number, ecc: ECCLevel,
): Uint8Array {
  const groups = groupsFor(version, ecc);
  const blocks: { data: Uint8Array; ecc: Uint8Array }[] = [];
  let offset = 0;
  for (const group of groups) {
    const eccLen = group.total - group.data;
    const divisor = rsDivisor(eccLen);
    for (let b = 0; b < group.count; b += 1) {
      const chunk = data.slice(offset, offset + group.data);
      offset += group.data;
      blocks.push({ data: chunk, ecc: rsRemainder(chunk, divisor) });
    }
  }
  const maxData = blocks.reduce((m, blk) => Math.max(m, blk.data.length), 0);
  const maxEcc = blocks.reduce((m, blk) => Math.max(m, blk.ecc.length), 0);
  const out: number[] = [];
  for (let i = 0; i < maxData; i += 1) {
    for (const blk of blocks) {
      if (i < blk.data.length) out.push(blk.data[i]);
    }
  }
  for (let i = 0; i < maxEcc; i += 1) {
    for (const blk of blocks) {
      if (i < blk.ecc.length) out.push(blk.ecc[i]);
    }
  }
  return new Uint8Array(out);
}

/** 生成数据码字（比特流 + 终止符 + 填充） */
function makeDataCodewords(bytes: Uint8Array, version: number, ecc: ECCLevel): Uint8Array {
  const capacityBits = dataCodewordsOf(version, ecc) * 8;
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);            // 字节模式
  push(bytes.length, 8);      // 字符计数（版本 1~9）
  for (let i = 0; i < bytes.length; i += 1) push(bytes[i], 8);
  // 终止符（最多 4 个 0）
  for (let i = 0; i < 4 && bits.length < capacityBits; i += 1) bits.push(0);
  // 补齐到字节边界
  while (bits.length % 8 !== 0) bits.push(0);
  // 填充码字 0xEC / 0x11 交替
  let pad = 0;
  while (bits.length < capacityBits) {
    push(pad % 2 === 0 ? 0xec : 0x11, 8);
    pad += 1;
  }
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < bits.length; i += 1) {
    if (bits[i]) out[i >>> 3] |= 1 << (7 - (i & 7));
  }
  return out;
}

/**
 * 编码一段文本为 QR 码。
 *
 * @param text 载荷（UTF-8）
 * @param ecc 纠错等级（默认 M）
 * @param forcedMask 指定掩码（-1 = 自动按惩罚分选优）
 */
export function encodeQr(
  text: string,
  ecc: ECCLevel = 'M',
  forcedMask = -1,
): QrResult {
  const bytes = utf8Bytes(text);
  let version = 0;
  for (let v = 1; v <= 6; v += 1) {
    if (bytes.length <= byteCapacity(v, ecc)) {
      version = v;
      break;
    }
  }
  if (!version) {
    throw new Error(
      `QR 载荷过长：${bytes.length} 字节（版本 1~6 / ${ecc} 最多 ${byteCapacity(6, ecc)} 字节）`,
    );
  }

  const data = makeDataCodewords(bytes, version, ecc);
  const codewords = buildCodewords(data, version, ecc);
  const size = 17 + 4 * version;

  const base = new QrMatrix(size);
  base.drawFunctionPatterns(version, ecc);
  base.drawCodewords(codewords);

  let bestMask = forcedMask;
  let best: QrMatrix | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < 8; mask += 1) {
    if (forcedMask >= 0 && mask !== forcedMask) continue;
    const candidate = new QrMatrix(size);
    candidate.modules = base.modules.map((row) => row.slice());
    candidate.isFunction = base.isFunction.map((row) => row.slice());
    candidate.applyMask(mask);
    candidate.drawFormatBits(ecc, mask);
    const score = candidate.penalty();
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
      bestMask = mask;
    }
  }
  if (!best) throw new Error('QR 编码失败：找不到可用掩码');
  return {
    matrix: best.modules,
    size,
    version,
    mask: bestMask,
    ecc,
  };
}

/** 把矩阵转成「一维字符串」（每行 '0'/'1'），方便调试与测试比对 */
export function matrixToRows(matrix: boolean[][]): string[] {
  return matrix.map((row) => row.map((m) => (m ? '1' : '0')).join(''));
}
