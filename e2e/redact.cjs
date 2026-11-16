/**
 * E2E 报告落盘前的敏感信息脱敏工具。
 *
 * 背景：历史报告曾落过完整明文 API Key（`paw-sk-...` / `sk-...`），即使该 Key 已作废，
 * 也属于不应进版本库的卫生问题。所有写报告的脚本都必须先过一遍 redact。
 */

/** 把完整明文 Key 变成 `paw-sk-****` 形式的掩码 */
function maskKey(key) {
  if (!key || typeof key !== 'string') return '';
  const m = key.match(/^((?:paw-)?sk-)(.+)$/);
  if (!m) return key.slice(0, 8) + '****';
  return `${m[1]}****`;
}

/** 把任意文本里的明文 Key 片段替换成掩码（用于 report 结果字符串） */
function redactText(text) {
  if (!text || typeof text !== 'string') return text;
  return text.replace(/\b((?:paw-)?sk-)[a-zA-Z0-9]{8,}/g, '$1****');
}

/** 深度遍历对象，把字符串里的明文 Key 全部替换掉 */
function redactDeep(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      if (/^(issuedKey|apiKey|api_key|secret|token)$/i.test(k) && typeof value[k] === 'string') {
        out[k] = maskKey(value[k]);
      } else {
        out[k] = redactDeep(value[k]);
      }
    }
    return out;
  }
  return value;
}

module.exports = { maskKey, redactText, redactDeep };
