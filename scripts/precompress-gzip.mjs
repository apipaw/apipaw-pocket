#!/usr/bin/env node
/**
 * 阶段十一 P0 · 前端静态产物的 **Gzip 预压缩**。
 *
 * 背景：
 *   前端 bundle 单文件 1.5MB，Cloudflare 边缘到访客的传输是**未压缩**的
 *   （源站 nginx 只有 `gzip on`，而 `gzip on` 对已经是最小二进制的 JS
 *   收益有限，且每次都要现压）。首屏下载因此要 1.5MB。
 *
 * 做法：
 *   构建后为每个可压缩文本资产生成同名 `.gz`（level 6，与 nginx
 *   `gzip_comp_level 6` 对齐），源站 nginx 开 `gzip_static on` 后
 *   **直接命中预压缩文件** —— 省掉运行时压缩开销，且字节级可控。
 *
 * 用法：
 *   node scripts/precompress-gzip.mjs [distDir]
 *   默认 distDir = ./dist
 *
 * 退出码：0 成功；1 有文件压缩失败（不静默吞掉）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 可压缩的扩展名（与 nginx `gzip_types` 覆盖范围对齐） */
const COMPRESSIBLE = new Set([
  '.html',
  '.js',
  '.mjs',
  '.css',
  '.json',
  '.map',
  '.svg',
  '.txt',
  '.xml',
  '.webmanifest',
]);

/** 低于该大小不值得压（gzip 头 + 字典成本大于收益） */
const MIN_BYTES = 512;

/** 已压缩的二进制资产（png/jpg/webp/woff/…）一律跳过 */
const SKIP_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.zip', '.gz', '.br', '.wasm', '.mp3', '.mp4', '.webm',
]);

const GZIP_LEVEL = 6; // 与 nginx `gzip_comp_level 6` 对齐

/**
 * 递归收集文件（跳过符号链接与 node_modules）。
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      out.push(...walk(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function main() {
  const distDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'dist'));
  if (!fs.existsSync(distDir)) {
    console.error(`[gzip] 产物目录不存在：${distDir}`);
    process.exit(1);
  }

  const files = walk(distDir);
  let rawTotal = 0;
  let gzTotal = 0;
  let count = 0;
  const failures = [];
  const rows = [];

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    if (SKIP_EXT.has(ext)) continue;
    if (!COMPRESSIBLE.has(ext)) continue;

    const stat = fs.statSync(file);
    if (stat.size < MIN_BYTES) continue;

    const buf = fs.readFileSync(file);
    let gz;
    try {
      gz = zlib.gzipSync(buf, { level: GZIP_LEVEL });
    } catch (err) {
      failures.push({ file, message: String(err && err.message ? err.message : err) });
      continue;
    }

    // 收益太小的文件不落 .gz（省磁盘，且 nginx 会自行回落到动态压缩）
    if (gz.length >= buf.length) continue;

    fs.writeFileSync(`${file}.gz`, gz);
    count += 1;
    rawTotal += buf.length;
    gzTotal += gz.length;
    rows.push({
      file: path.relative(distDir, file),
      raw: buf.length,
      gz: gz.length,
      ratio: (1 - gz.length / buf.length) * 100,
    });
  }

  rows.sort((a, b) => b.raw - a.raw);
  console.log(`[gzip] 产物目录：${distDir}`);
  for (const r of rows) {
    console.log(
      `  ${r.file}  ${human(r.raw)} → ${human(r.gz)}  (-${r.ratio.toFixed(1)}%)`,
    );
  }
  if (count > 0) {
    console.log(
      `[gzip] 共 ${count} 个文件：${human(rawTotal)} → ${human(gzTotal)} ` +
        `(整体 -${((1 - gzTotal / rawTotal) * 100).toFixed(1)}%)`,
    );
  } else {
    console.log('[gzip] 没有需要预压缩的文件（全部过小或已是压缩格式）');
  }

  if (failures.length > 0) {
    console.error('[gzip] 以下文件压缩失败：');
    for (const f of failures) console.error(`  ${f.file}: ${f.message}`);
    process.exit(1);
  }
}

main();
