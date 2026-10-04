/**
 * 对话滚动语义 —— 三条行为的判定逻辑单测
 *
 * 实现对半分:判定逻辑全在 `web/src/lib/scroll.ts` 的纯函数里(可在这里直测),
 * `MessageList.tsx` 只负责把 DOM 的 `scrollTop/clientHeight/scrollHeight` 喂进来、
 * 按判定结果调 `scrollTo`。**没有引入 jsdom/RTL** —— 这个项目里 web 侧没有 DOM
 * 测试基建,而这三条行为真正会写错的地方全是判定,不是 DOM 调用。
 *
 * 守的三件事(与批次要求逐条对应):
 *   ① 上滚关闭跟随   ② 回到底部恢复跟随   ③ **程序自身的滚动不关闭跟随**
 *
 * ③ 是这类代码最常见的 bug:用 `isProgrammatic` 标志位去挡,但 `scrollTo()` 之后
 * scroll 事件是**异步**派发的,标志位早在事件到达前就被清掉了 —— 于是「我自己滚到底」
 * 被当成「用户上滚」,跟随永久关闭。所以判据改成**方向**(见 lib/scroll.ts 文件头)。
 */
import { describe, expect, it } from "vitest";
import {
  BOTTOM_THRESHOLD_PX,
  INITIAL_FOLLOW,
  isAtBottom,
  isOverflowing,
  observeFollow,
  scrollBehaviorFor,
  shouldShowJumpButton,
  throttleDelay,
  type FollowState,
  type ScrollMetrics,
} from "../../web/src/lib/scroll.js";

/** 视口高 600、内容 2000:底部 = scrollTop 1400。 */
const m = (scrollTop: number, scrollHeight = 2000, clientHeight = 600): ScrollMetrics => ({
  scrollTop,
  clientHeight,
  scrollHeight,
});

/** 场景:**先贴底,再上滚** —— 「用户上滚」必须从贴底状态出发才算数。 */
const atBottom: FollowState = observeFollow(INITIAL_FOLLOW, { kind: "scroll", metrics: m(1400) });
const scrolledUp: FollowState = observeFollow(atBottom, { kind: "scroll", metrics: m(600) });

describe("isAtBottom · 贴底判定(阈值不为 0)", () => {
  it("正好在底部 / 差一点点都算贴底", () => {
    expect(isAtBottom(m(1400))).toBe(true);
    expect(isAtBottom(m(1400 - BOTTOM_THRESHOLD_PX))).toBe(true);
    // 浮点/子像素:差 0.4px 用阈值 0 会判成「不贴底」,这正是阈值必须非 0 的原因
    expect(isAtBottom(m(1399.6))).toBe(true);
    expect(isAtBottom(m(1399.6), 0)).toBe(false);
  });

  it("离底超过阈值 = 用户不在底部", () => {
    expect(isAtBottom(m(1400 - BOTTOM_THRESHOLD_PX - 1))).toBe(false);
    expect(isAtBottom(m(0))).toBe(false);
  });

  it("内容没超出视口时也算贴底", () => {
    expect(isAtBottom(m(0, 400, 600))).toBe(true);
  });

  it("isOverflowing 只关心内容是否超出视口", () => {
    expect(isOverflowing(m(0, 2000, 600))).toBe(true);
    expect(isOverflowing(m(0, 600, 600))).toBe(false);
    expect(isOverflowing(m(0, 600.5, 600))).toBe(false); // 取整误差容差
  });
});

describe("observeFollow · ① 上滚关闭跟随 / ② 回到底部恢复跟随", () => {
  it("场景前置:贴底时跟随为真", () => {
    expect(atBottom.following).toBe(true);
    expect(atBottom.lastTop).toBe(1400);
  });

  it("上滚 → 关闭跟随,并显示「回到底部」", () => {
    expect(scrolledUp.following).toBe(false);
    expect(scrolledUp.lastTop).toBe(600);
    expect(shouldShowJumpButton(scrolledUp)).toBe(true);
  });

  it("上滚之后不再被新内容拽回去(内容变化不翻转跟随)", () => {
    const grown = observeFollow(scrolledUp, { kind: "content", metrics: m(600, 3000) });
    expect(grown.following).toBe(false);
    expect(shouldShowJumpButton(grown)).toBe(true);
  });

  it("自己滚回底部 → 恢复跟随", () => {
    const back = observeFollow(scrolledUp, { kind: "scroll", metrics: m(1400) });
    expect(back.following).toBe(true);
    expect(shouldShowJumpButton(back)).toBe(false);
  });

  it("往下滚但还没到底 → 保持「不跟随」(不提前恢复)", () => {
    const midway = observeFollow(scrolledUp, { kind: "scroll", metrics: m(1000) });
    expect(midway.following).toBe(false);
  });

  it("内容没超出视口时不显示按钮", () => {
    const n = observeFollow(INITIAL_FOLLOW, { kind: "scroll", metrics: m(0, 400, 600) });
    expect(shouldShowJumpButton(n)).toBe(false);
  });
});

describe("observeFollow · ③ 程序自身的滚动不关闭跟随(最常见的那个 bug)", () => {
  it("跟随中的向下程序滚动(滚到底)不关闭跟随", () => {
    expect(atBottom.following).toBe(true);
    // 连续的程序滚动(流式节流下每 80ms 一次)都不能把它关掉
    const again = observeFollow(atBottom, { kind: "scroll", metrics: m(1500, 2100) });
    expect(again.following).toBe(true);
  });

  it("流式内容变长、scrollTop 没动 → 仍然跟随,且 lastTop 不被内容改写", () => {
    const s = observeFollow(atBottom, { kind: "content", metrics: m(1400, 2600) });
    expect(s.following).toBe(true);
    expect(s.lastTop).toBe(1400);
  });

  it("内容临时变短被浏览器夹到底部 → 夹完正好贴底,不误关跟随", () => {
    // 流式重排(段落变代码块等)会让内容瞬间变短,scrollTop 被夹到新的最大值。
    // 夹完 scrollTop + clientHeight == scrollHeight —— 判据第一条(贴底→跟随)先命中,
    // 所以这条失败路径被「先判贴底、再判上移」的顺序堵住。
    expect(isAtBottom(m(900, 1500, 600))).toBe(true);
    const s = observeFollow(atBottom, { kind: "scroll", metrics: m(900, 1500, 600) });
    expect(s.following).toBe(true);
  });

  it("上滚后位置没再变(内容也不变)→ 保持不跟随", () => {
    const same = observeFollow(scrolledUp, { kind: "scroll", metrics: m(600) });
    expect(same.following).toBe(false);
  });
});

describe("observeFollow · 用户主动「回到底部」与切换上下文", () => {
  it("点「回到底部」→ 立刻恢复跟随(不必等滚动事件)", () => {
    const pinned = observeFollow(scrolledUp, { kind: "pin-bottom" });
    expect(pinned.following).toBe(true);
    expect(shouldShowJumpButton(pinned)).toBe(false);
  });

  it("切项目 / 进接待会话 → 归零并跳到底(不继承上一条对话的位置)", () => {
    const reset = observeFollow(scrolledUp, { kind: "reset", metrics: m(0, 400, 600) });
    expect(reset).toEqual({ following: true, lastTop: 0, overflowing: false });
  });

  it("抖动量小于 1px 不算「用户上滚」", () => {
    const jitter: FollowState = { following: false, lastTop: 600, overflowing: true };
    expect(observeFollow(jitter, { kind: "scroll", metrics: m(599.5) }).following).toBe(false);
  });
});

describe("滚动行为与节流", () => {
  it("跟随内容增长用瞬时滚动(smooth 永远追不上流式内容)", () => {
    expect(scrollBehaviorFor("content")).toBe("auto");
    expect(scrollBehaviorFor("reset")).toBe("auto");
    expect(scrollBehaviorFor("pin-bottom")).toBe("smooth");
  });

  it("throttleDelay:首次立刻可滚,间隔内要等剩余时间,超过则立刻", () => {
    expect(throttleDelay(0, 1_000_000)).toBe(0);
    expect(throttleDelay(1000, 1030)).toBe(50);
    expect(throttleDelay(1000, 1080)).toBe(0);
    expect(throttleDelay(1000, 5000)).toBe(0);
  });
});
