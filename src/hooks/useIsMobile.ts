import { useWindowDimensions } from 'react-native';

/**
 * 手机端断点（阶段二十七 P0）—— 全站响应式布局的**单一真源**。
 *
 * 窄于此宽度即进入「单列 + 允许换行 + 去掉固定尺寸」的窄屏布局；
 * 宽于此宽度沿用原桌面多列视觉（保证零视觉退化）。
 */
export const MOBILE_BREAKPOINT = 768;

/**
 * 判断当前是否处于手机窄屏布局。
 *
 * ⚠️ 必须在**渲染期**调用（不要在 useEffect 里读），否则首帧会按桌面布局渲染再跳变。
 */
export function useIsMobile(): boolean {
  const { width } = useWindowDimensions();
  return width < MOBILE_BREAKPOINT;
}
