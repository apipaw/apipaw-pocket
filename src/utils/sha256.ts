/**
 * 极简 SHA-256（纯 TypeScript · 零依赖）。
 *
 * 阶段十八 P2 的「默克尔状态根**浏览器端验真**」需要它：
 * 客户端拿到网关给的 ``leaf_hash`` 与 ``siblings`` 后，
 * 在本地按 ``sha256(left + right)`` 逐层重算默克尔根，
 * 与网关公示的 ``ledger_root`` 比对 —— 一致即证明「这一笔账确实在账本里」。
 *
 * 为什么不用 ``crypto.subtle``：
 *   - RN（Android/iOS）**没有** WebCrypto；
 *   - Web 端也只在**安全上下文**（https/localhost）才有；
 *   - 而控制台既要能在 App 里跑，又要能在浏览器里跑 ⇒ 自带一份最省事。
 *
 * 只处理 UTF-8 文本（默克尔叶子是 ASCII 的规范化串，够用）。
 */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr = (x: number, n: number): number =>
  ((x >>> n) | (x << (32 - n))) >>> 0;

/** UTF-8 编码（手动处理代理对，避免依赖 TextEncoder —— RN 上不一定有）。 */
const utf8Bytes = (input: string): number[] => {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    if (c < 0x80) {
      out.push(c);
    } else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
      const c2 = input.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        i += 1;
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 63),
          0x80 | ((cp >> 6) & 63),
          0x80 | (cp & 63),
        );
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      }
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
  }
  return out;
};

/** 返回 64 位小写十六进制摘要。 */
export const sha256Hex = (input: string): string => {
  const bytes = utf8Bytes(input);
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  const hi = Math.floor(bitLen / 0x100000000);
  const lo = bitLen >>> 0;
  bytes.push(
    (hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
    (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255,
  );

  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array<number>(64);

  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i += 1) {
      const p = off + i * 4;
      w[i] = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) >>> 0;
      const s1 = (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h[0], b = h[1], c = h[2], d = h[3];
    let e = h[4], f = h[5], g = h[6], hh = h[7];

    for (let i = 0; i < 64; i += 1) {
      const s1 = (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const t1 = (hh + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const t2 = (s0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }

    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }

  let out = '';
  for (let i = 0; i < 8; i += 1) out += h[i].toString(16).padStart(8, '0');
  return out;
};

/**
 * 默克尔根本地重算：``siblings`` 是自底向上的兄弟链。
 *
 * ⚠️ ``sides`` 给出每层兄弟的**方位**（``"L"`` 在左 / ``"R"`` 在右）：
 * 父节点 = ``sha256(left + right)``，当前节点在右边时必须算
 * ``sha256(sibling + current)`` —— 顺序反了就永远验不过。
 * ``sides`` 缺省按「兄弟恒在右」（旧口径，仅对全偶下标成立）。
 */
export const merkleRootFrom = (
  leafHash: string,
  siblings: string[],
  sides?: string[],
): string => {
  let current = String(leafHash || '');
  (siblings || []).forEach((sibling, i) => {
    const side = sides && sides[i] === 'L' ? 'L' : 'R';
    current = side === 'L'
      ? sha256Hex(String(sibling || '') + current)
      : sha256Hex(current + String(sibling || ''));
  });
  return current;
};
