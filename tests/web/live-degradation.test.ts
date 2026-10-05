/**
 * 取数失败时,**运行态那几位必须降级**(`lib/data.ts` 的 `liveForDisplay`)
 *
 * ── 为什么这条要有独立的测试 ────────────────────────────────────
 *
 * 用户的原话是「我担心系统已经挂了,而实际还在运行」。它的**镜像**同样致命:
 * **系统真的挂了,而界面还在显示「正在跑」**。那条路很具体 ——
 *
 *   `useProjectLive` 的取数一旦失败(宿主被杀 / 端口断 / 500),`useLoad` 会保留
 *   上一份 `data`(这是**对的**:不能把界面清空成「什么都没有」),而那份快照里的
 *   `turn` / `dispatch.lastRunAgeMs` 是**内存事实**,只在**取到的那一刻**成立。
 *   照着旧值渲染 ⇒ 屏幕上有一个呼吸的绿点,而它证明的是几秒前的事,
 *   甚至是一个已经死掉的进程。
 *
 * 所以判据是**按来源分开**降级,而不是「全清」或「全留」:
 *
 *   - 运行期(内存):`turn` / `dispatch` / `runningTurns` / `runtime` ⇒ 降级;
 *   - 库派生:`currentWorks` / `todos` / `lastMessage` / 项目计数 ⇒ **原样保留**
 *     (它们不是「此刻」,一次失败不会让它们变假;清掉等于把已经知道的事实扔掉)。
 *
 * 这里用**纯函数**测这条,而不是渲染整页:降级是**判据**,不该只活在一个 hook
 * 的闭包里 —— 页面那一侧只需要老老实实按 `runtime` 分支(它已经有自己的 SSR 测试)。
 */
import { describe, expect, it } from "vitest";
import type { ProjectLiveView } from "@shared/types/platform";
import { liveForDisplay } from "@/lib/data";

function live(): ProjectLiveView {
  return {
    projectId: "p1",
    at: 1_700_000_000_000,
    runtime: "host",
    dispatch: { intervalMs: 10_000, lastRunAgeMs: 4_000, draining: true },
    runningTurns: 1,
    openWorks: 3,
    pendingQuestions: 1,
    agents: [
      {
        agentId: "wk",
        turn: { elapsedMs: 65_000, trigger: { kind: "todo", todoKind: "execute_work" } },
        currentWorks: [{ id: "w1", title: "基础打断模块", status: "in_progress", ageMs: 120_000 }],
        readyWorks: 1,
        waitingWorks: 2,
        todos: [{ kind: "execute_work", label: "执行 w1", attempts: 1, maxAttempts: 3, target: "w1" }],
        exhaustedTodos: 0,
        lastMessage: { kind: "assistant", excerpt: "开始做", ageMs: 30_000 },
      },
    ],
  };
}

describe("liveForDisplay · 取数失败 ⇒ 运行期降级、库派生保留", () => {
  it("没有拿到过(null)⇒ 原样 null(「还没查过」不是「运行态为不可用」)", () => {
    expect(liveForDisplay(null, "boom")).toBeNull();
    expect(liveForDisplay(null, null)).toBeNull();
  });

  it("没出错 ⇒ **同一份对象**,不做任何降级(负样本:防这条降级无条件生效)", () => {
    const l = live();
    expect(liveForDisplay(l, null)).toBe(l);
  });

  it("出错 ⇒ 绿点与心跳一律归零:turn=null、runtime=unavailable、心跳 null、draining=false", () => {
    const d = liveForDisplay(live(), "连接被拒绝");
    expect(d).not.toBeNull();
    expect(d?.runtime).toBe("unavailable");
    expect(d?.runningTurns).toBe(0);
    expect(d?.dispatch.lastRunAgeMs).toBeNull();
    expect(d?.dispatch.draining, "「正在排空」是内存事实,失败后不许继续声称").toBe(false);
    expect(d?.agents[0]?.turn, "「已在跑 65s」是内存事实,失败后不许继续声称").toBeNull();
    // 间隔是配置(不是观测),保留原值 —— 归零会让页面显示「每 0s 查一次」
    expect(d?.dispatch.intervalMs).toBe(10_000);
  });

  it("出错时**库派生的那几位原样保留**(清掉等于把已知事实扔掉)", () => {
    const l = live();
    const d = liveForDisplay(l, "连接被拒绝");
    expect(d?.agents[0]?.currentWorks).toEqual(l.agents[0]?.currentWorks);
    expect(d?.agents[0]?.todos).toEqual(l.agents[0]?.todos);
    expect(d?.agents[0]?.lastMessage).toEqual(l.agents[0]?.lastMessage);
    expect(d?.agents[0]?.readyWorks).toBe(1);
    expect(d?.agents[0]?.waitingWorks).toBe(2);
    expect(d?.openWorks).toBe(3);
    expect(d?.pendingQuestions).toBe(1);
  });
});
