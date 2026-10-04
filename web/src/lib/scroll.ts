/**
 * 对话滚动语义 —— **纯函数**,不碰 DOM(可单测,见 tests/web/scroll.test.ts)
 *
 * 只要三条行为:
 *   ① 贴底时新内容自动跟随;
 *   ② 用户上滚后不再自动滚(并显示「回到底部」),用户自己滚回底部后恢复跟随;
 *   ③ 滚到顶加载历史 —— **未做**:后端 `GET /api/projects/:id/messages` 没有
 *      分页/游标参数(见 transport/http.ts:189 + transport/views.ts 的
 *      `listProjectMessages(db, id, limit = 200)`),它一次返回全部消息。
 *      14 条消息的会话里为它改契约不划算,所以这条明确记为未做,而不是硬造一个
 *      「加载更多」按钮去点一个不存在的接口。
 *
 * ── 为什么不用 react-virtuoso(2026-10-04 实测后删掉)───────────────
 *
 * 它自带的价值是**虚拟化**,而我们每个项目的会话在真机 E2E 里是 14 条消息 ——
 * 虚拟化是过早优化;实测它的体积是 +193.3 kB raw / +61.3 kB gzip,而整个前端
 * bundle 才 224 KB / gzip 71 KB。我们真正需要的 `followOutput` 语义就是本文件
 * 这些行。
 *
 * ── 「程序自己的滚动不能关掉跟随」是怎么保证的 ────────────────────
 *
 * 不用 `isProgrammatic` 标志位 —— 那东西不可靠:`scrollTo()` 之后 scroll 事件
 * 是**异步**派发的,标志位在事件到达前就被清掉了,于是程序滚动被当成用户滚动。
 * 这里改用**方向**:本组件只会**向下**程序滚动(滚到底),而内容只会变长,
 * 所以「scrollTop 变小」在结构上只能来自用户。判据因此是:
 *
 *   贴底          → 跟随(无论谁滚的,到底了就该跟)
 *   没贴底 + 上移 → 用户上滚,关闭跟随
 *   没贴底 + 不动/下移 → 保持现状(可能是程序滚动途中,也可能是用户往下滚但还没到底)
 *
 * 内容临时变短时浏览器会把 scrollTop 夹到新的最大值 —— 夹完**正好是贴底**,
 * 按上面第一条仍然跟随,所以「流式重排导致误关跟随」这条失败路径被这条顺序堵住了
 * (而不是靠一个会永久失灵的记忆量)。
 */

/** 贴底判定的容差(px)。**不能是 0** —— 小数与子像素会让它永远差一点。 */
export const BOTTOM_THRESHOLD_PX = 32;

/** 流式高频更新下程序滚动的节流间隔(ms)。 */
export const SCROLL_THROTTLE_MS = 80;

/** 小于这个位移不算「上移」(子像素抖动)。 */
const MOVE_EPSILON_PX = 1;

export interface ScrollMetrics {
  scrollTop: number;
  clientHeight: number;
  scrollHeight: number;
}

export interface FollowState {
  /** 是否跟随新内容自动滚动到底。 */
  following: boolean;
  /** 上一次观察到的 scrollTop —— 判「上移」用。 */
  lastTop: number;
  /** 内容是否超出视口(不超出就没什么可滚的,不必显示「回到底部」)。 */
  overflowing: boolean;
}

export const INITIAL_FOLLOW: FollowState = { following: true, lastTop: 0, overflowing: false };

/** 贴底判定:`scrollTop + clientHeight >= scrollHeight - 阈值`。 */
export function isAtBottom(m: ScrollMetrics, threshold: number = BOTTOM_THRESHOLD_PX): boolean {
  return m.scrollTop + m.clientHeight >= m.scrollHeight - threshold;
}

/** 内容是否超出视口(1px 容差,避免取整误差把「刚好放下」判成可滚)。 */
export function isOverflowing(m: ScrollMetrics): boolean {
  return m.scrollHeight - m.clientHeight > 1;
}

/** 「回到底部」按钮的显示条件:用户已经上滚 **且** 确实有东西可滚回去。 */
export function shouldShowJumpButton(s: FollowState): boolean {
  return !s.following && s.overflowing;
}

export type FollowObservation =
  /** 来自 onScroll —— 位置变了(可能是用户,也可能是我们自己滚的)。 */
  | { kind: "scroll"; metrics: ScrollMetrics }
  /** 内容变了(新消息 / 流式 delta),度量取了新的。 */
  | { kind: "content"; metrics: ScrollMetrics }
  /** 用户点了「回到底部」。 */
  | { kind: "pin-bottom" }
  /** 切了项目 / 接待会话:一切归零,并且直接跳到底。 */
  | { kind: "reset"; metrics: ScrollMetrics };

export function observeFollow(state: FollowState, o: FollowObservation): FollowState {
  switch (o.kind) {
    case "scroll": {
      const m = o.metrics;
      const movedUp = m.scrollTop < state.lastTop - MOVE_EPSILON_PX;
      const following = isAtBottom(m) ? true : movedUp ? false : state.following;
      return { following, lastTop: m.scrollTop, overflowing: isOverflowing(m) };
    }
    case "content":
      // 内容变化**不改跟随状态、不动 lastTop**:scrollTop 没被用户动过。
      return { ...state, overflowing: isOverflowing(o.metrics) };
    case "pin-bottom":
      return { ...state, following: true };
    case "reset":
      return { following: true, lastTop: o.metrics.scrollTop, overflowing: isOverflowing(o.metrics) };
  }
}

/** 程序滚动的动机 —— 决定用哪种滚动行为。 */
export type ScrollReason = "content" | "pin-bottom" | "reset";

/**
 * 跟随**内容增长**时必须用 `"auto"`(瞬时):流式下每 80ms 一次 `"smooth"` 会让
 * 动画永远追不上内容,看起来像卡住。用户主动跳回底部才用 `"smooth"`。
 */
export function scrollBehaviorFor(reason: ScrollReason): ScrollBehavior {
  return reason === "pin-bottom" ? "smooth" : "auto";
}

/** 节流:距离上次程序滚动还差多少毫秒才能再滚(≤0 表示现在就可以)。 */
export function throttleDelay(
  lastAt: number,
  now: number,
  throttle: number = SCROLL_THROTTLE_MS,
): number {
  return Math.max(0, throttle - (now - lastAt));
}
