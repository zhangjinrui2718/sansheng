/**
 * 上下文指针的卫生(migration 024 的后续)
 *
 * ── 真机事故(2026-10-06 22:14)────────────────────────────────────
 *
 * 用户在**接待会话**里发了一句「之前做的美股自动化交易平台方案设计,7 份报告太
 * 繁琐了,给我合成一份报告」,然后**没有人回应**。
 *
 * 库里的现场:那句话**落库了**(接待会话里),业务经理也确实在跑(3 分 50 秒后
 * 开了 v2 项目)。所以不是「没收到」也不是「没执行」——是**界面这一侧**。
 *
 * 根因是 `startIntake()` **没有清 `sessionId`**:
 *
 *   1. 用户在项目 A 的对话里(`sessionId` = A 的主对话);
 *   2. 点左栏「接待会话」→ `startIntake()` → `projectId=null`、
 *      `intakeActive=true`,**但 `sessionId` 还留着 A 的那条**;
 *   3. 发消息 → `sendMessage` 把 **A 的 sessionId** 一起发出去,
 *      而 `projectId` 是 `null`;
 *   4. 服务端 `handleUserMessage` 校验归属:
 *      `getSession(A的会话).projectId !== null` ⇒ **`code: not_found`**,
 *      消息被拒;
 *   5. 用户看到的是**自己的乐观上屏气泡**,然后什么都没有 ——
 *      而「被服务端拒收」这件事**没有任何反馈**。
 *
 * ⚠️ 这条链路**不需要任何异常**:每一个动作都是正常点击。所以它极难被发现,
 * 而它的表现(「发了没人应」)与「服务端挂了」一模一样。
 *
 * 修法两层(下面两条用例各钉一层):
 *   · `startIntake()` 必须把 `sessionId` / `sessions` **一起清掉**;
 *   · `sendMessage` 在**接待会话**里**根本不发** `sessionId` ——
 *     接待会话全局**只有一条**(迁移里的部分唯一索引),没有「选哪条」这回事,
 *     带上它只会多一条能错的路径。
 */
import { beforeEach, describe, expect, it, afterEach, vi } from "vitest";
import { useChatStore } from "../../web/src/stores/chat";

interface Sent { type: string; projectId: string | null; content: string; sessionId?: string }

let sent: Sent[] = [];

beforeEach(() => {
  sent = [];
  useChatStore.setState({
    socket: {
      sendToProject: (projectId: string | null, content: string, sessionId?: string) => {
        sent.push({
          type: "send", projectId, content,
          ...(sessionId !== undefined ? { sessionId } : {}),
        });
      },
      send: () => {},
      on: () => {},
      close: () => {},
    } as never,
  });
});
afterEach(() => vi.restoreAllMocks());

describe("① `startIntake()` 必须清掉上一个项目的会话指针", () => {
  it("从项目切回接待会话:`sessionId` 被清空,而全局线索引**刻意不清**", async () => {
    // 先假装在项目 A 的对话里
    useChatStore.setState({
      projectId: "pA",
      intakeActive: false,
      sessionId: "s_A_main",
      // ⚠️ 这里曾经是一个扁平的 `sessions: SessionSummary[]`(只装**当前**项目的线),
      // 守卫断言它被清空。改二级目录后它变成 `sessionsByProject` —— **全局**索引
      // (所有项目的线),左栏在所有路由下都画着它。
      //
      // ⇒ 守卫的**判据**从「这个数组被清空」改成「**指针**被清空、**索引**不清」。
      // 这不是把守卫改松:`sessionsByProject` 里没有任何东西会被发出去(发送只带
      // `projectId` + `sessionId`,见下一条 `it`),而清掉它会让**所有**项目的
      // 二级目录同时消失 —— 拿一条可见的故障换一个看不见的风险。
      sessionsByProject: {
        pA: [
          {
            id: "s_A_main", kind: "main", title: null, channel: "internal",
            deliverableArtifactId: null, createdAt: 1, lastMessageAt: 2,
          },
        ],
      },
    } as never);
    vi.stubGlobal("fetch", async () => ({
      ok: true, status: 200, statusText: "OK",
      text: async () => JSON.stringify({ messages: [] }),
    }));

    await useChatStore.getState().startIntake();

    const s = useChatStore.getState();
    expect(s.intakeActive).toBe(true);
    expect(s.projectId).toBeNull();
    // ⚠️ **这条是这次修的全部** —— 留着上一条项目的 `sessionId`,下一次发送就会
    // 带着它出去,而服务端会以「不属于项目 null」拒收(2026-10-06 真机事故)。
    expect(s.sessionId, "上一条项目的会话 id 不能带进接待会话").not.toBe("s_A_main");
    // ⚠️ 索引**不该**被清:它是全局读面,清掉会让左栏每个项目的二级目录同时空掉。
    expect(
      s.sessionsByProject.pA?.[0]?.id,
      "全局线索引不是上下文指针,切回接待会话不该清它",
    ).toBe("s_A_main");
    vi.unstubAllGlobals();
  });

  it("接待会话里发出的 `send` **不带** `sessionId`", async () => {
    // 接待会话全局只有一条 —— 带上 id 只会多一条能错的路径。
    useChatStore.setState({
      projectId: null, intakeActive: true, sessionId: null, sessionsByProject: {},
    } as never);
    useChatStore.getState().sendMessage("谈一个新项目");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.projectId).toBeNull();
    expect(
      Object.prototype.hasOwnProperty.call(sent[0]!, "sessionId"),
      "接待会话的 send 不该带 sessionId",
    ).toBe(false);
  });

  it("立项后的切换**带一句解释** —— 静默搬走对话就是「没人回应」的来源", async () => {
    // 服务端会把接待会话的消息整体迁进新项目并删掉接待会话(C4 的设计)。
    // 迁移是对的,但用户刚经历的是「我发了句话、等了很久、界面变了」。
    // ⇒ 切换必须**有解释**;否则那是一次无来由的上下文变更。
    useChatStore.setState({ projectId: null, intakeActive: true, sessionId: null, sessions: [] });
    const sessions = [{
      id: "s_new", kind: "main" as const, title: null, channel: "internal" as const,
      deliverableArtifactId: null, createdAt: 1, lastMessageAt: 2,
    }];
    vi.stubGlobal("fetch", async (url: string) => {
      const path = String(url).replace("/api", "").split("?")[0] ?? "";
      const body = path.endsWith("/sessions")
        ? { projectId: "p_new", sessions }
        : { projectId: "p_new", messages: [] };
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body) };
    });

    useChatStore.getState().applyEvent({
      type: "project_opened", projectId: "p_new", name: "新项目",
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const s = useChatStore.getState();
    expect(s.projectId).toBe("p_new");
    expect(s.intakeActive).toBe(false);
    expect(s.contextNotice, "切换必须有解释").toBeTruthy();
    expect(s.contextNotice).toContain("新项目");
    expect(s.contextNotice, "要说明对话被搬走了,而不只是「切了个项目」")
      .toContain("搬");
    vi.unstubAllGlobals();
  });

  it("发消息后提示消失 —— 它已经完成使命,不该一直挂着", () => {
    useChatStore.setState({
      projectId: "pA", intakeActive: false, sessionId: "s_A_main",
      contextNotice: "已立项…",
      sessions: [{
        id: "s_A_main", kind: "main", title: null, channel: "internal",
        deliverableArtifactId: null, createdAt: 1, lastMessageAt: 2,
      }],
    });
    useChatStore.getState().sendMessage("开始吧");
    expect(useChatStore.getState().contextNotice).toBeNull();
  });

  it("⚠️ 正样本自检:项目内发送**照旧**带 `sessionId`", () => {
    // 少了这一条,上面那条也可能因为「压根没发出去」而绿。
    useChatStore.setState({
      projectId: "pA", intakeActive: false,
      sessionId: "s_A_main",
      sessions: [{
        id: "s_A_main", kind: "main", title: null, channel: "internal",
        deliverableArtifactId: null, createdAt: 1, lastMessageAt: 2,
      }],
    });
    useChatStore.getState().sendMessage("在吗");
    expect(sent[0]!.sessionId, "项目内必须带会话 id,否则发不到用户选的那条线")
      .toBe("s_A_main");
  });
});