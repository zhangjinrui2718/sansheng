/**
 * Sansheng 前端 BusRow memo helper 单测(批次 3 F5 / B10-4)
 *
 * 缺陷(docs/CODE-REVIEW-2026-10-01.md §B10-4):Timeline.tsx 的
 *   `memo(BusRowImpl, (prev, next) => prev.msg === next.msg)` 丢弃了 `now` prop
 *   → 比较恒 true(只要 msg 引用不变),相对时间「刚刚」永远冻结;
 *   :303-306 的注释是对 memo 语义的误解。
 *
 * 修复:把比较器与时间桶抽成纯函数(nowBucket 30s 粒度 + busRowPropsEqual
 *   同时比较 msg 引用与 now 桶),Timeline.tsx 引用之。本文件测这两个纯函数
 *   (memo 在真实 DOM 下的重渲染行为列入 USER 手动验证)。
 *
 * RED:web/src/lib/busRow.ts 尚不存在 → import 失败。
 */
import { describe, expect, it } from "vitest";
import { nowBucket, busRowPropsEqual, BUS_ROW_NOW_BUCKET_MS } from "../../web/src/lib/busRow.js";

describe("F5 · nowBucket(30s 粒度桶)", () => {
  it("桶宽为 30s", () => {
    expect(BUS_ROW_NOW_BUCKET_MS).toBe(30_000);
  });

  it("同一 30s 窗口内的时间戳落入同一桶", () => {
    expect(nowBucket(0)).toBe(0);
    expect(nowBucket(1)).toBe(0);
    expect(nowBucket(29_999)).toBe(0);
    expect(nowBucket(30_000)).toBe(30_000);
    expect(nowBucket(30_001)).toBe(30_000);
    expect(nowBucket(59_999)).toBe(30_000);
    expect(nowBucket(60_000)).toBe(60_000);
  });
});

describe("F5 · busRowPropsEqual(比较 msg 引用 + now 桶)", () => {
  const msg = { id: "m1" } as unknown;

  it("msg 相同且 now 相同 → 相等(跳过重渲)", () => {
    expect(busRowPropsEqual({ msg, now: 60_000 }, { msg, now: 60_000 })).toBe(true);
  });

  it("msg 相同但 now 桶不同 → 不等(时间标签需重渲)", () => {
    // 这正是旧比较器丢弃 now 导致的冻结 bug
    expect(busRowPropsEqual({ msg, now: 60_000 }, { msg, now: 90_000 })).toBe(false);
  });

  it("msg 引用不同 → 不等(内容变更需重渲)", () => {
    const other = { id: "m2" } as unknown;
    expect(busRowPropsEqual({ msg, now: 60_000 }, { msg: other, now: 60_000 })).toBe(false);
  });

  it("now 在同一桶内变化不影响相等(30s 粒度抑制无谓重渲)", () => {
    expect(busRowPropsEqual({ msg, now: 60_000 }, { msg, now: 60_500 })).toBe(true);
  });
});
