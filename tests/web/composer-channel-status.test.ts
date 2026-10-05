/**
 * bug A · **「推演中」把输入框永久锁死**(真机,2026-10-05)
 *
 * ── 现场(逐行,git 211825a)─────────────────────────────────────
 *
 *     stores/chat.ts:540   status: "streaming"   ← message_start,无条件
 *     stores/chat.ts:560   status: "streaming"   ← delta,也无条件
 *     ChatSurface.tsx:90   ● {status === "streaming" ? "推演中" : …}
 *     ChatSurface.tsx:112  disabled={status === "streaming" || !hasKey || !hasContext}
 *
 * `status` 是**传输级**的「有没有人在跑」,从不按通道过滤。而排空器会让四个角色
 * 在**同一个项目**里背靠背地跑(真机 2026-10-05 01:11–01:29 的 8 个回合 =
 * `pm → bm → pm → wk → wk → wk → qa → bm`),那些内部回合的发言在对话页**看不见**
 * (A3 的 `partitionTurns` 把它们滤掉了)——⇒ 用户看到的是一个「推演中」、
 * **永远发不出话**的输入框,而他只是在等 worker 干活。
 *
 * ── 修法(判据)─────────────────────────────────────────────────
 *
 *     输入框禁用 ⟺ **甲方通道**在**本上下文**里有在飞的轮
 *     内部角色在跑 ⟹ 显示「内部推进中」+ 保留中断按钮,**输入框可用**
 *
 * 判据落在 `lib/data.ts` 的 `channelActivityOf` / `surfaceStatusOf`,复用 A3 已有的
 * `channelOf`(两跳:`agentId → 成员 role → clientFacing`)。**接待会话没有成员表**
 * 时沿用 A3 已定的那条「未知 agent 按 client」,不在这里另立规则。
 *
 * ── 正负样本(本项目纪律:必须命中的 + 必须不命中的,两个都对上才算判据没坏)──
 *
 *   正样本:只有 wk 在飞 → 不是 streaming(输入框可用)
 *   正样本:bm 在飞 → 是 streaming(输入框禁用)
 *   负样本:一个内部轮 + 一个 client 轮同时在飞 → **仍然禁用**
 *          (证明它不是「只要有内部轮就放行」)
 *   负样本:平台通知(kind=system)在飞 → 不算任何一侧的活动,不禁用
 *
 * ⚠️ 一条**刻意钉住成因**的断言:wk 在飞时,`ChatState.status`(传输级那一位)
 * **仍然是** `"streaming"`。这一位没有消失 —— 它是「有人在跑」的真话,
 * 而输入框的判据不再读它。谁要是把判据改回「读 status」,下面第一条就红。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MemberView, ProjectRole } from "@shared/types/platform";
import {
  channelActivityOf,
  channelContextOf,
  surfaceStatusOf,
  type ChannelContext,
} from "@/lib/data";
import { inFlightTurns, useChatStore, type Turn } from "@/stores/chat";
import { SurfaceStatusIndicator } from "@/components/chat/ChatSurface";

const PA = "p-alpha";
const PB = "p-beta";

/** 真机库的四个 agent(`runtime/org.ts` 的 ORG,跨项目共用同一组 id)。 */
const MEMBERS: MemberView[] = [
  { id: "bm", role: "business_manager", displayName: "业务经理", specialization: null },
  { id: "pm", role: "project_manager", displayName: "项目经理", specialization: null },
  { id: "wk", role: "worker", displayName: "工程师", specialization: "engineering" },
  { id: "qa", role: "quality_reviewer", displayName: "质检", specialization: null },
];

/** 与 `ROLE_SPECS` 同形:`clientFacing` 只有业务经理为 true(代码内常量)。 */
const ROLES: Array<{ role: ProjectRole; clientFacing: boolean }> = [
  { role: "business_manager", clientFacing: true },
  { role: "project_manager", clientFacing: false },
  { role: "worker", clientFacing: false },
  { role: "quality_reviewer", clientFacing: false },
];

function ctx(over?: Partial<{ members: MemberView[]; intake: boolean }>): ChannelContext {
  return channelContextOf({
    members: over?.members ?? MEMBERS,
    roles: ROLES,
    ready: true,
    intake: over?.intake ?? false,
  });
}

/** 手搓的轮(`Turn` 的必填字段一个都不能少;`tests/` 不在 tsconfig 的 include 里)。 */
function turn(
  id: string,
  role: Turn["role"],
  agentId: string | null,
  projectId: string | null,
): Turn {
  return { id, projectId, role, agentId, blocks: [{ kind: "text", text: "x" }], startedAt: 0 };
}

/** 现在在飞的轮(渲染层拿到的就是这一个列表)。 */
const live = (): Turn[] => inFlightTurns(useChatStore.getState());

/** 顶层判据:原始 status + 在飞的轮 → 顶部状态。 */
function surface(contextKey: string | null, context: ChannelContext = ctx()) {
  return surfaceStatusOf(useChatStore.getState().status, channelActivityOf(live(), context, contextKey));
}

/** 输入框的「有人在跑」那一半判据。 */
function clientBusy(contextKey: string | null, context: ChannelContext = ctx()): boolean {
  return channelActivityOf(live(), context, contextKey).client.length > 0;
}

beforeEach(() => {
  useChatStore.setState({
    projectId: PA,
    intakeActive: false,
    turns: [],
    inFlight: {},
    inFlightOrder: [],
    currentTurn: null,
    lastUserEchoId: null,
    status: "idle",
  });
});

describe("bug A · 只有内部角色在跑 ⇒ 输入框可用", () => {
  it("**正样本**:只有 wk 的轮在飞 → `status !== \"streaming\"`(输入框可用)", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: PA, messageId: "m-wk", role: "assistant", agentId: "wk" });
    s.applyEvent({ type: "delta", projectId: PA, messageId: "m-wk", text: "第 1 项做完了" });

    // ⚠️ 成因还在(这一位是「有人在跑」的真话)—— 但它不再是输入框的判据。
    expect(useChatStore.getState().status).toBe("streaming");
    expect(useChatStore.getState().status, "传输级那一位仍是 streaming 是**现状**,不是修法").not.toBe("idle");

    // 判据:内部通道不是甲方通道
    expect(surface(PA)).toBe("internal");
    expect(surface(PA)).not.toBe("streaming");
    expect(clientBusy(PA)).toBe(false);
  });

  it("**正样本**:pm 与 qa 在跑同样是 internal(不是只有 wk 特殊)", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: PA, messageId: "m-pm", role: "assistant", agentId: "pm" });
    s.applyEvent({ type: "message_start", projectId: PA, messageId: "m-qa", role: "assistant", agentId: "qa" });
    expect(surface(PA)).toBe("internal");
    expect(clientBusy(PA)).toBe(false);
  });

  it("**正样本**:bm 的轮在飞 → `status === \"streaming\"`(输入框禁用)", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: PA, messageId: "m-bm", role: "assistant", agentId: "bm" });
    expect(surface(PA)).toBe("streaming");
    expect(clientBusy(PA)).toBe(true);

    // 收口之后回到 idle(负样本:不许永远停在 streaming)
    s.applyEvent({ type: "agent_end", projectId: PA, ts: 1 });
    expect(surface(PA)).toBe("idle");
    expect(clientBusy(PA)).toBe(false);
  });

  it("**负样本**:一个内部轮 + 一个 client 轮同时在飞 → **仍然禁用**", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: PA, messageId: "m-wk", role: "assistant", agentId: "wk" });
    s.applyEvent({ type: "message_start", projectId: PA, messageId: "m-bm", role: "assistant", agentId: "bm" });

    // 「只要有内部轮就放行」的实现会在这里返回 false —— 那是错的:业务经理正在回你。
    expect(clientBusy(PA), "client 在飞就是禁用,内部轮不改变这一条").toBe(true);
    expect(surface(PA)).toBe("streaming");
  });

  it("**负样本**:平台通知(`role: \"system\"`)不算任何一侧的活动,不禁用输入框", () => {
    const sys = turn("s1", "system", null, PA);
    const act = channelActivityOf([sys], ctx(), PA);
    expect(act.client).toEqual([]);
    expect(act.internal).toEqual([]);
    expect(act.system.map((t) => t.id)).toEqual(["s1"]);
    expect(surfaceStatusOf("streaming", act)).toBe("idle");
  });

  it("**负样本**:项目里成员表之外的 agent → fail-closed 成 internal,不禁用(A3 的两跳原样)", () => {
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: PA, messageId: "m-ghost", role: "assistant", agentId: "ag_ghost" });
    expect(surface(PA)).toBe("internal");
    expect(clientBusy(PA)).toBe(false);
  });
});

describe("bug A · 接待会话与跨上下文(projectId === null 不是通配)", () => {
  it("**接待会话**:没有成员表时沿用 A3 的「未知 agent 按 client」⇒ 仍然禁用", () => {
    useChatStore.setState({ projectId: null, intakeActive: true, inFlight: {}, inFlightOrder: [], status: "idle" });
    const s = useChatStore.getState();
    s.applyEvent({ type: "message_start", projectId: null, messageId: "m-i", role: "assistant", agentId: "bm" });

    // 上下文键是 null(接待会话),成员表为空 —— 判据只能来自 A3 那条已定的规则。
    expect(surface(null, ctx({ members: [], intake: true }))).toBe("streaming");
    expect(clientBusy(null, ctx({ members: [], intake: true }))).toBe(true);
  });

  it("**负样本**:别的项目里在飞的轮不许锁住这里的输入框(服务端的忙闩也是按项目的)", () => {
    const s = useChatStore.getState();
    // 用户坐在 PA;排空器在 PB 里叫醒了业务经理(汇报待办)
    s.applyEvent({ type: "message_start", projectId: PB, messageId: "b-bm", role: "assistant", agentId: "bm" });
    s.applyEvent({ type: "message_start", projectId: PB, messageId: "b-wk", role: "assistant", agentId: "wk" });

    expect(clientBusy(PA)).toBe(false);
    expect(surface(PA)).toBe("idle");
    // 而 PB 自己那一边该看见 —— 判据是**恒等比较**,两个方向都要有样本
    expect(surface(PB)).toBe("streaming");
  });

  it("**负样本**:`tool_start` 建出来的内部轮同样不锁输入框(第二个建轮点)", () => {
    const s = useChatStore.getState();
    s.applyEvent({
      type: "tool_start", projectId: PA, messageId: "m-tool", agentId: "wk",
      tool: { id: "t1", name: "board_write" },
    });
    expect(clientBusy(PA)).toBe(false);
    expect(surface(PA)).toBe("internal");
  });
});

describe("bug A · 顶部状态措辞(内部在跑要**说**出来,但不能骗用户说「你不能说话」)", () => {
  it("internal 渲染成「内部推进中」,且不出现在甲方通道的「推演中」措辞里", () => {
    const html = renderToStaticMarkup(createElement(SurfaceStatusIndicator, { status: "internal" }));
    expect(html).toContain("内部推进中");
    expect(html).not.toContain("推演中");
    // 提示必须说清「输入框可用」,并且**不许**承诺服务端做不到的事
    // (服务端的「项目忙」闩在整次级联期间持有,发送仍可能被拒 —— 见报告)
    expect(html).toContain("输入框保持可用");
    expect(html).toContain("可能拒收");
  });

  it("streaming 仍然是「推演中」(甲方通道那一条不许被这次改动改掉)", () => {
    const html = renderToStaticMarkup(createElement(SurfaceStatusIndicator, { status: "streaming" }));
    expect(html).toContain("推演中");
    expect(html).not.toContain("内部推进中");
  });
});
