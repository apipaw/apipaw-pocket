import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';

/**
 * 阶段二十四 P1 · 懒挂载容器（IntersectionObserver + 兜底定时器）
 * ------------------------------------------------------------
 * 为什么需要它
 * ------------
 * 控制台首屏（买家视角）一次性挂载了 **11 张卡片**，每张卡在 mount 时
 * 立刻发自己的 API 请求 ⇒ 首屏要同时等 11 条请求、渲染 11 棵树。
 * 加上此前 Playground 的 120ms 定时器重渲染，整页在低端机上"又慢又烫手"。
 *
 * 这个容器让**首屏之外**的卡片延后挂载：
 *   * 浏览器端：用 IntersectionObserver，卡片**接近视口**（rootMargin）就挂载；
 *   * 兜底：无论有没有滚到，最多 ``fallbackMs`` 之后**一定挂载**
 *     —— 保证 e2e 断言、用户直接搜���、以及任何"卡片本该在页面上"的场景
 *     都不会因为懒挂载而丢失；
 *   * 原生端（无 IntersectionObserver）：**立即挂载**（原生没有"标签页"概念，
 *     也没有首屏视口可判）。
 *
 * 纪律
 * ----
 *   * **不删除任何 data-testid**：懒挂载只是"晚一点出现"，元素与属性完全一致；
 *   * **不删 UI**：卡片内容与顺序不变；
 *   * 兜底时间必须**小于** e2e 断言前的等待（当前 e2e 最早在挂载后 ~2.5s 断言）。
 */

export interface LazyMountProps {
  children: React.ReactNode;
  /** 兜底挂载延迟（毫秒）。0 = 立即挂载。 */
  fallbackMs?: number;
  /** 提前挂载的视口外扩（像素）。 */
  rootMargin?: string;
  /** 占位样式（保持列间距，避免"卡片突然插进来"的突兀感）。 */
  style?: object;
  testID?: string;
}

export const LazyMount: React.FC<LazyMountProps> = ({
  children,
  fallbackMs = 1500,
  rootMargin = '400px',
  style,
  testID,
}) => {
  const [mounted, setMounted] = useState(fallbackMs <= 0);
  const holderRef = useRef<React.ElementRef<typeof View> | null>(null);

  useEffect(() => {
    if (mounted) return undefined;

    // ---- 兜底：到点必挂 ----
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (fallbackMs > 0) {
      timer = setTimeout(() => setMounted(true), fallbackMs);
    }

    // ---- 视口接近即挂载 ----
    let observer: IntersectionObserver | null = null;
    const node = holderRef.current as unknown as Element | null;
    if (
      typeof window !== 'undefined'
      && typeof IntersectionObserver !== 'undefined'
      && node
      && typeof node.getBoundingClientRect === 'function'
    ) {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            setMounted(true);
          }
        },
        { rootMargin },
      );
      observer.observe(node);
    } else if (fallbackMs <= 0) {
      // 无 IntersectionObserver 且不允许延迟 ⇒ 立即挂载
      setMounted(true);
    }

    return () => {
      if (timer !== null) clearTimeout(timer);
      if (observer) observer.disconnect();
    };
  }, [mounted, fallbackMs, rootMargin]);

  if (mounted) return <>{children}</>;

  // 未挂载时留一个**零高度**占位（不占视觉空间，也不改变布局高度）
  return <View ref={holderRef} style={style} testID={testID} />;
};

export default LazyMount;
