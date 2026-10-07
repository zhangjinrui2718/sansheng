/**
 * 2026-10-07 · **接待会话的运行态端点**(`GET /api/intake/live`)
 *
 * 对话页那盏灯此前只由 WS 实时事件推出来,而 WS 没有回放 ⇒ 刷新 / 切页之后
 * 一个还在跑的回合显示成「就绪」。项目那条有 `GET /live` 可查,**接待此前 404**。
 *
 * 本文件钉住 `toIntakeLiveView` 的两件事:
 *   ① **按上下文过滤** —— 它只认 `projectId === null` 的回合(项目里的不许漏进来);
 *   ② `runtime === null`(没接上运行期快照)时如实报 `unavailable`,
 *      **不是**把「读不到」显示成「没在跑」。
 */
import { describe, expect, it } from "vitest";
import { toIntakeLiveView, type LiveRuntimeSnapshot } from "../../src/platform/transport/views.js";

const NOW = 1_000_000;

function snap(
  turns: LiveRuntimeSnapshot["turns"],
): LiveRuntimeSnapshot {
  return {
    turns,
    dispatch: { intervalMs: 10_000, lastRunAt: null },
    drainingProjects: [],
  };
}

describe("toIntakeLiveView · 接待会话的运行态", () => {
  it("只认 `projectId === null` 的回合(项目里的不许漏进接待)", () => {
    const view = toIntakeLiveView(
      NOW,
      snap([
        { projectId: null, agentId: "bm", startedAt: NOW - 3_000, trigger: { kind: "user" } },
        { projectId: "p1", agentId: "pm", startedAt: NOW - 1_000, trigger: { kind: "todo", todoKind: "decompose_project" } },
        { projectId: null, agentId: "bm", startedAt: NOW - 9_000, trigger: { kind: "user" } },
      ]),
    );
    expect(view.runtime).toBe("host");
    expect(view.runningTurns).toBe(2);
    expect(view.turns.map((t) => t.elapsedMs)).toEqual([3_000, 9_000]);
    // `trigger` 原样带出去 —— 前端靠它决定显示「推演中」还是「内部推进中」
    expect(view.turns[0]!.trigger).toEqual({ kind: "user" });
  });

  it("接待里没有回合在跑 ⇒ 读到了,而且是 0(不是「读不到」)", () => {
    const view = toIntakeLiveView(NOW, snap([]));
    expect(view.runtime).toBe("host");
    expect(view.runningTurns).toBe(0);
    expect(view.turns).toEqual([]);
  });

  it("⚠️ 没接上运行期快照 ⇒ `unavailable`,不是「没在跑」", () => {
    const view = toIntakeLiveView(NOW, null);
    expect(view.runtime).toBe("unavailable");
    // 这个 0 与上面那条的 0 **含义不同**(这里是「不知道」),所以 `runtime` 必须分开报
    expect(view.runningTurns).toBe(0);
  });

  it("时钟倒退(负数)只报 0,不显示「跑了负几秒」", () => {
    const view = toIntakeLiveView(
      NOW,
      snap([{ projectId: null, agentId: "bm", startedAt: NOW + 5_000, trigger: { kind: "user" } }]),
    );
    expect(view.turns[0]!.elapsedMs).toBe(0);
  });
});
