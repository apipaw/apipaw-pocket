import { useEffect, useRef } from 'react';

import {
  createVisibilityInterval,
  VisibilityIntervalDeps,
} from './visibilityIntervalCore';

/**
 * 阶段二十四 P1 · 可见性感知轮询 hook
 * ------------------------------------------------------------
 * 为什么需要它
 * ------------
 * 控制台里 LiveSettlementFeed(20s) / NodeLeaderboardCard(30s) / SmartAlertCard(30s)
 * 三个卡片各自 `setInterval` 轮询。此前它们**不看页面可见性**：
 *   * 用户切到别的标签页 / 把窗口最小化 ⇒ 页面还在后台按秒轮询，
 *     白白吃掉手机流量与源站带宽，还把源站 API 打满；
 *   * 每个卡片各自维护一份定时器 ⇒ 组件卸载顺序不当时可能残留。
 *
 * 这个 hook 把口径收成一处（真正的逻辑在 ``visibilityIntervalCore.ts``，
 * 那里有单测钉死每一条）：
 *   * **后台/隐藏标签页：定时器完全停掉**（不是降频，是停）；
 *   * **回到前台：立刻刷新一次**，然后恢复原有节奏；
 *   * 卸载时必定清定时器 ⇒ 无残留。
 *
 * 跨端口径
 * --------
 * RN 原生没有 `document` ⇒ 一律视为"可见"（原生 App 没有标签页概念）。
 * Web 端用 `document.hidden` + `visibilitychange` 事件。
 *
 * 用法
 * ----
 * ```ts
 * useVisibilityInterval(() => { void refresh(); }, 30000);
 * ```
 */

/** 当前页面是否可见（原生端恒为 true）。 */
function isPageVisible(): boolean {
  if (typeof document === 'undefined' || !document) return true;
  return !document.hidden;
}

function browserDeps(): VisibilityIntervalDeps {
  const hasDocument = typeof document !== 'undefined' && !!document;
  return {
    isVisible: isPageVisible,
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    addEventListener: hasDocument && document.addEventListener
      ? (fn) => document.addEventListener('visibilitychange', fn)
      : null,
    removeEventListener: hasDocument && document.removeEventListener
      ? (fn) => document.removeEventListener('visibilitychange', fn)
      : null,
  };
}

export function useVisibilityInterval(
  callback: () => void,
  delayMs: number,
  enabled = true,
): void {
  // 用 ref 持有最新回调 ⇒ 回调里的 state 变化不会重启定时器
  const cbRef = useRef<() => void>(callback);
  cbRef.current = callback;

  useEffect(() => {
    if (!enabled || delayMs <= 0) return undefined;

    const deps = browserDeps();
    const controller = createVisibilityInterval(
      deps,
      () => cbRef.current(),
      delayMs,
    );
    controller.start();

    return () => controller.dispose();
  }, [delayMs, enabled]);
}

export default useVisibilityInterval;
