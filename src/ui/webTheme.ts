/**
 * src/ui/webTheme.ts —— Web 专属视觉增强层
 *
 * 为什么需要这一层
 * ----------------
 * APIPaw Pocket 是 Expo / React Native 应用（同一套代码同时产出 Web 静态站
 * 与原生 App）。React Native 的 StyleSheet 表达不了下面这些东西：
 *
 *   · backdrop-filter —— 玻璃拟态的磨砂
 *   · 渐变描边（双层 background + background-clip: border-box）
 *   · 渐变文字（background-clip: text）
 *   · :hover 交互反馈、呼吸灯动画、终端内阴影
 *
 * 而 react-native-web 会把 RN 的 `id` prop 原样映射到 DOM 的 `id` 属性，
 * 于是可以用 CSS 属性选择器 `[id^="前缀"]` 精确挂载样式，
 * **不需要** className（RNW 不支持该 prop）也不需要 any 断言。
 *
 * 约定：所有需要 Web 专属效果的元素，id 都以固定前缀开头，
 * 例如 `apx-glass-*`、`apx-grad-text-*`、`apx-term-*`。
 *
 * 注入策略：模块顶层直接注入（浏览器里 document 已就绪，首屏无闪烁），
 * 并在挂载后把 <style> 重新 append 到 <head> 末尾 —— RNW 的原子类样式表
 * 是运行时插入的，保证本表在源码顺序上更靠后，同优先级时本表胜出。
 * 关键属性仍统一加了 !important 做兜底。
 */

import { Platform } from 'react-native';

const STYLE_ATTR = 'data-apipaw-theme';

export const WEB_THEME_CSS = `
/* ================= 基础 ================= */
html, body, #root {
  background-color: #050509 !important;
  color-scheme: dark;
}
body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
    'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
* { box-sizing: border-box; }

::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  border: 2px solid transparent;
  background-clip: content-box;
}
::-webkit-scrollbar-thumb:hover {
  background: rgba(52, 211, 153, 0.45);
  background-clip: content-box;
}

/* ================= 页面底：极光 + 网格纹理 ================= */
[id^="apx-root"] {
  background-color: #050509 !important;
  background-image:
    radial-gradient(1100px 620px at 10% -10%, rgba(34, 211, 238, 0.17), transparent 62%),
    radial-gradient(900px 540px at 88% -4%, rgba(167, 139, 250, 0.17), transparent 64%),
    radial-gradient(1000px 640px at 50% 106%, rgba(52, 211, 153, 0.11), transparent 66%),
    linear-gradient(180deg, #06060B 0%, #030305 100%) !important;
  background-attachment: fixed !important;
}
[id^="apx-grid"] {
  position: absolute !important;
  top: 0; left: 0; right: 0; bottom: 0;
  pointer-events: none;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.035) 1px, transparent 1px) !important;
  background-size: 48px 48px !important;
  -webkit-mask-image: radial-gradient(ellipse 85% 62% at 50% 0%, #000 18%, transparent 78%);
  mask-image: radial-gradient(ellipse 85% 62% at 50% 0%, #000 18%, transparent 78%);
}

/* ================= 顶栏 ================= */
[id^="apx-header"] {
  background-color: rgba(6, 6, 11, 0.78) !important;
  backdrop-filter: blur(20px) saturate(160%);
  -webkit-backdrop-filter: blur(20px) saturate(160%);
  border-bottom-color: rgba(255, 255, 255, 0.08) !important;
  box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45);
}

/* ================= 玻璃拟态 ================= */
[id^="apx-glass"] {
  backdrop-filter: blur(18px) saturate(150%);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
}

/* 渐变描边卡片：内层实色填充 + 外层霓虹渐变描边 */
[id^="apx-grad-border"] {
  border: 1px solid transparent !important;
  background-color: transparent !important;
  background-image:
    linear-gradient(rgba(255, 255, 255, 0.045), rgba(255, 255, 255, 0.02)),
    linear-gradient(135deg, rgba(34, 211, 238, 0.85), rgba(167, 139, 250, 0.7) 45%, rgba(52, 211, 153, 0.8)) !important;
  background-origin: border-box;
  background-clip: padding-box, border-box;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(255, 255, 255, 0.02);
}

/* 渐变文字 */
[id^="apx-grad-text"] {
  background-image: linear-gradient(100deg, #67E8F9 0%, #A78BFA 48%, #34D399 100%) !important;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent !important;
  font-family: ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace !important;
  letter-spacing: -0.02em;
}
[id^="apx-grad-text"] * { color: transparent !important; }

/* ================= 终端（Playground 对话区）================= */
[id^="apx-term"] {
  background-color: #04040A !important;
  border-color: rgba(255, 255, 255, 0.08) !important;
  border-radius: 14px !important;
  box-shadow:
    inset 0 2px 24px rgba(0, 0, 0, 0.92),
    inset 0 -24px 48px rgba(0, 0, 0, 0.55),
    inset 0 0 0 1px rgba(255, 255, 255, 0.035) !important;
}

/* 终端顶部的高光条，模拟真实终端的窗沿 */
[id^="apx-term-bar"] {
  background-image: linear-gradient(90deg, rgba(34, 211, 238, 0.55), rgba(167, 139, 250, 0.55), rgba(52, 211, 153, 0.55)) !important;
}

/* ================= 按钮 ================= */
[id^="apx-send"] {
  background-color: transparent !important;
  background-image: linear-gradient(135deg, #22D3EE 0%, #34D399 55%, #A78BFA 100%) !important;
  box-shadow: 0 8px 26px rgba(34, 211, 238, 0.3);
  transition: transform 0.16s ease, box-shadow 0.16s ease, filter 0.16s ease;
}
[id^="apx-send"]:hover {
  filter: brightness(1.12);
  transform: translateY(-1px);
  box-shadow: 0 14px 38px rgba(52, 211, 153, 0.45);
}
[id^="apx-send"]:active { transform: translateY(0) scale(0.985); }
[id^="apx-send-disabled"] { filter: saturate(0.25) brightness(0.72); }

/* 悬停发光（药丸按钮 / 小卡片） */
[id^="apx-glow"] {
  transition: transform 0.18s ease, box-shadow 0.18s ease, border-color 0.18s ease, background-color 0.18s ease;
}
[id^="apx-glow"]:hover {
  transform: translateY(-1px);
  border-color: rgba(52, 211, 153, 0.55) !important;
  box-shadow: 0 0 0 1px rgba(52, 211, 153, 0.25), 0 12px 34px rgba(52, 211, 153, 0.18);
}

/* ================= 状态指示 ================= */
[id^="apx-dot-live"] {
  box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.55);
  animation: apx-breathe 2.2s ease-out infinite;
}
[id^="apx-dot-alert"] {
  box-shadow: 0 0 0 0 rgba(251, 113, 133, 0.55);
  animation: apx-breathe 1.7s ease-out infinite;
}
@keyframes apx-breathe {
  0%   { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.5); opacity: 1; }
  70%  { box-shadow: 0 0 0 8px rgba(52, 211, 153, 0); opacity: 0.7; }
  100% { box-shadow: 0 0 0 0 rgba(52, 211, 153, 0); opacity: 1; }
}
@keyframes apx-breathe-alert {
  0%   { box-shadow: 0 0 0 0 rgba(251, 113, 133, 0.55); opacity: 1; }
  70%  { box-shadow: 0 0 0 7px rgba(251, 113, 133, 0); opacity: 0.7; }
  100% { box-shadow: 0 0 0 0 rgba(251, 113, 133, 0); opacity: 1; }
}
[id^="apx-dot-alert"] { animation-name: apx-breathe-alert; }

/* ================= Toast ================= */
/* 固定在右下角：顶栏右侧是「设置密钥 / 切换视角」等全局操作按钮，
   Toast 绝不与之重叠。容器整体对鼠标事件穿透，只有卡片本体可交互。 */
[id^="apx-toast"] {
  position: fixed !important;
  top: auto !important;
  bottom: 24px;
  right: 24px;
  left: auto;
  z-index: 9999;
  max-width: min(360px, calc(100vw - 32px));
  background-color: rgba(11, 11, 17, 0.94) !important;
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  border: 1px solid rgba(251, 191, 36, 0.34) !important;
  border-radius: 14px !important;
  box-shadow: 0 22px 60px rgba(0, 0, 0, 0.65);
  pointer-events: none;
  animation: apx-toast-in 0.42s cubic-bezier(0.16, 1, 0.3, 1);
}
[id^="apx-toast"] > * { pointer-events: auto; }
@keyframes apx-toast-in {
  from { opacity: 0; transform: translateY(16px) scale(0.96); }
  to   { opacity: 1; transform: none; }
}

/* ================= 弹窗 ================= */
[id^="apx-modal"] {
  background-color: rgba(6, 6, 11, 0.86) !important;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}
[id^="apx-modal-card"] {
  background-color: rgba(13, 13, 20, 0.96) !important;
  backdrop-filter: blur(20px) saturate(150%);
  -webkit-backdrop-filter: blur(20px) saturate(150%);
  border: 1px solid rgba(255, 255, 255, 0.1) !important;
  box-shadow: 0 30px 90px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(255, 255, 255, 0.03);
}

/* ================= 细节 ================= */
[id^="apx-mono"] {
  font-family: ui-monospace, SFMono-Regular, 'JetBrains Mono', Menlo, Consolas, monospace !important;
}
[id^="apx-caps"] {
  letter-spacing: 0.16em !important;
  text-transform: uppercase;
}
[id^="apx-eyebrow"] {
  letter-spacing: 0.14em !important;
  text-transform: uppercase;
  font-size: 12px !important;
  font-weight: 700 !important;
}
/* 滚动进入时的轻微上浮 */
@keyframes apx-rise {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: none; }
}
[id^="apx-rise"] { animation: apx-rise 0.45s cubic-bezier(0.16, 1, 0.3, 1) both; }
`;

/**
 * 注入 Web 主题样式表。
 *
 * 幂等：重复调用只会把 <style> 移到 <head> 末尾，不会重复插入。
 * 非 Web 平台（iOS / Android）直接跳过 —— 那里由 RN StyleSheet 兜底。
 */
export function injectWebTheme(): void {
  if (Platform.OS !== 'web') return;
  if (typeof document === 'undefined') return;

  let el = document.querySelector<HTMLStyleElement>(`style[${STYLE_ATTR}]`);
  if (!el) {
    el = document.createElement('style');
    el.setAttribute(STYLE_ATTR, '1');
    el.textContent = WEB_THEME_CSS;
  }
  // 重新 append 会把节点移到 <head> 末尾 —— 源码顺序更靠后，同优先级时胜出
  document.head.appendChild(el);
}
