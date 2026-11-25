/**
 * 阶段二十四 P1 · 可见性感知轮询的**纯逻辑核心**（无 React、无 DOM 依赖）。
 *
 * 为什么要抽出来
 * --------------
 * 口径（后台停表 / 回前台补刷一次）如果写在 React hook 里就只能靠 e2e 验证 ——
 * 而 e2e 验证不了"标签页隐藏时定时器真的停了"。
 * 这里把口径抽成**可注入依赖**的纯函数，单测可以用假定时器把每一步都钉死。
 *
 * 口径（与 UI 表现一一对应）
 * ----------------------
 *   1. 页面可见 ⇒ 定时器运行，按 ``delayMs`` 触发回调；
 *   2. 页面隐藏 ⇒ **定时器完全停掉**（不是降频，是停）；
 *   3. 从隐藏切回可见 ⇒ **立刻补刷一次**，然后恢复原节奏；
 *   4. 销毁 ⇒ 定时器必清、事件监听必摘（无残留）。
 */

export interface VisibilityIntervalDeps {
  /** 当前页面是否可见 */
  isVisible: () => boolean;
  /** 注册定时器 */
  setInterval: (fn: () => void, ms: number) => unknown;
  /** 注销定时器 */
  clearInterval: (handle: unknown) => void;
  /** 订阅可见性变化（无则传 null） */
  addEventListener: ((fn: () => void) => void) | null;
  /** 退订可见性变化 */
  removeEventListener: ((fn: () => void) => void) | null;
}

export interface VisibilityIntervalController {
  /** 启动（按当前可见性决定是否真的开表） */
  start: () => void;
  /** 停止并清理（幂等） */
  dispose: () => void;
  /** 当前是否有定时器在跑（给单测断言用） */
  isRunning: () => boolean;
}

export function createVisibilityInterval(
  deps: VisibilityIntervalDeps,
  callback: () => void,
  delayMs: number,
): VisibilityIntervalController {
  let timer: unknown = null;
  let disposed = false;
  let listening = false;

  const stop = () => {
    if (timer !== null) {
      deps.clearInterval(timer);
      timer = null;
    }
  };

  const startTimer = () => {
    if (disposed || timer !== null) return;
    timer = deps.setInterval(() => {
      // 定时器触发时再确认一次可见性（覆盖"两次检查之间标签页被隐藏"）
      if (!deps.isVisible()) return;
      callback();
    }, delayMs);
  };

  const handleVisibility = () => {
    if (disposed) return;
    if (!deps.isVisible()) {
      stop();
      return;
    }
    stop();
    startTimer();
    // 回到前台立刻补刷一次 ⇒ 用户看到的不是几十秒前的旧数据
    callback();
  };

  return {
    start: () => {
      if (disposed) return;
      // 订阅可见性变化（一次即可）
      if (deps.addEventListener && deps.removeEventListener && !listening) {
        listening = true;
        deps.addEventListener(handleVisibility);
      }
      if (deps.isVisible()) startTimer();
    },
    dispose: () => {
      disposed = true;
      stop();
      if (listening && deps.removeEventListener) {
        listening = false;
        deps.removeEventListener(handleVisibility);
      }
    },
    isRunning: () => timer !== null,
  };
}
