/**
 * 左栏二级目录的**数据路径**(左栏在所有路由下都挂着,所以这段路径的判据
 * 不能只看「对话页对不对」)。
 *
 * 它守三件事,每件都对应一种具体的坏法:
 *
 *   ① **一次取齐,不 N+1**。逐个项目问 `GET /api/projects/:id/sessions` 在有
 *      20 个项目的库里就是 21 个请求,而左栏**每切一个路由**都要重画。
 *      钉住「`/api/sessions` 恰好一次、逐项目端点零次」。
 *      ⚠️ 正负样本都在:只断言「请求过一次」的话,一个同时逐项目拉的实现照样通过。
 *
 *   ② **按每条线自己的 `projectId` 分组**,而不是「当前打开的项目」。
 *      错法很具体:用 `state.projectId` 分组 ⇒ 甲方打开 p2 的瞬间,p1 的线
 *      会从左栏消失(它们被分到 p2 那组去了,而 p2 打开时通常还没有自己的线)。
 *
 *   ③ **全局索引是全局的**:新开一条线立刻可见、切走再切回别的项目的二级
 *      目录仍在。这两条各自都曾是 bug —— 前者要刷新页面才出现,后者会让
 *      左栏**每切一次项目就空掉一格**。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../web/src/stores/chat.js";

const P1 = "p-rail-1";
const P2 = "p-rail-2";

let calls: string[] = [];

/** 一条线;`projectId` 是服务端给的归属,前端**必须**按它分组。 */
function line(id: string, projectId: string, extra: Record<string, unknown> = {}) {
  return {
    id, projectId, kind: "thread", title: `线 ${id}`, channel: "internal",
    deliverableArtifactId: null, createdAt: 1, lastMessageAt: 2, ...extra,
  };
}

function routes(url: string): unknown {
  if (url === "/api/sessions") {
    return { sessions: [line("s1_main", P1, { kind: "main", title: null }), line("t1", P1), line("s2_main", P2, { kind: "main", title: null })] };
  }
  if (url === "/api/projects") {
    return {
      projects: [
        { id: P1, name: "项目一", status: "active", goal: "g", client: "甲方", version: null, parentProjectId: null, createdAt: 1, lastMessageAt: 1, artifactCount: 0, sessionCount: 2 },
        { id: P2, name: "项目二", status: "active", goal: "g", client: "甲方", version: null, parentProjectId: null, createdAt: 1, lastMessageAt: 1, artifactCount: 0, sessionCount: 1 },
      ],
    };
  }
  if (url.startsWith("/api/projects/") && url.endsWith("/sessions")) {
    return { sessions: [line("s1_main", P1, { kind: "main", title: null })] };
  }
  if (url.startsWith("/api/sessions/") && url.endsWith("/messages")) return { messages: [] };
  if (url.startsWith("/api/projects/") && url.endsWith("/live")) return { runtime: "ok", running: [] };
  if (url.includes("/session_created") || url.includes("/thread_created")) return {};
  return {};
}

beforeEach(() => {
  calls = [];
  useChatStore.setState({
    projects: [], sessionsByProject: {}, projectId: null, sessionId: null,
    intakeActive: true, contextDecided: false, error: null, sessionIndexError: null,
  } as never);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return {
      ok: true, status: 200, statusText: "OK",
      json: async () => routes(url),
      text: async () => JSON.stringify(routes(url)),
    };
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("① 一次取齐,不逐项目 N+1", () => {
  it("`loadProjects` 连带取一次 `/api/sessions`,逐项目端点零次", async () => {
    await useChatStore.getState().loadProjects();
    // `loadSessionIndex` 是 `void`(不阻塞),等它落地
    await vi.waitFor(() => expect(useChatStore.getState().sessionsByProject[P1]).toHaveLength(2));

    const indexCalls = calls.filter((u) => u === "/api/sessions");
    const perProject = calls.filter((u) => /\/api\/projects\/[^/]+\/sessions(\?|$)/.test(u));
    // ⚠️ 两个方向都钉:只查「请求过 /api/sessions」的话,一个同时逐项目拉的
    // 实现照样通过 —— 而那正是这里要防的东西。
    expect(indexCalls, "全项目索引恰好取一次").toHaveLength(1);
    expect(perProject, "逐项目端点一次都不该打").toEqual([]);
  });

  it("索引拉挂了**不**把项目列表变成「加载失败」", async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "/api/sessions") throw new Error("网络断了");
      return {
        ok: true, status: 200, statusText: "OK",
        json: async () => routes(url),
        text: async () => JSON.stringify(routes(url)),
      };
    });
    await useChatStore.getState().loadProjects();
    await vi.waitFor(() => expect(useChatStore.getState().sessionIndexError).not.toBeNull());

    const s = useChatStore.getState();
    // ⚠️ 失败后果不同:会话索引挂了只影响二级目录,项目列表必须还在。
    // 合成一个 try 就是拿「二级目录空了」遮住「项目也没了」。
    expect(s.projects).toHaveLength(2);
    expect(s.error, "项目列表不该报失败").toBeNull();
  });
});

describe("② 按每条线自己的 `projectId` 分组", () => {
  it("两个项目的线各自落在自己的组里", async () => {
    await useChatStore.getState().loadProjects();
    await vi.waitFor(() => expect(useChatStore.getState().sessionsByProject[P2]).toHaveLength(1));

    const s = useChatStore.getState();
    expect(s.sessionsOf(P1).map((x) => x.id)).toEqual(["s1_main", "t1"]);
    expect(s.sessionsOf(P2).map((x) => x.id)).toEqual(["s2_main"]);
    // 负样本:组里**不许**混进别的项目的线 —— 那是「按当前项目分组」的实现。
    expect(s.sessionsOf(P1).every((x) => x.projectId === P1)).toBe(true);
    expect(s.sessionsOf(P2).every((x) => x.projectId === P2)).toBe(true);
  });

  it("切到 p2 不会让 p1 的线消失(分组依据不是「当前项目」)", async () => {
    await useChatStore.getState().loadProjects();
    await vi.waitFor(() => expect(useChatStore.getState().sessionsByProject[P1]).toHaveLength(2));

    useChatStore.setState({ projectId: P2 } as never);
    const s = useChatStore.getState();
    expect(s.sessionsOf(P1), "打开 p2 时 p1 的二级目录必须还在").toHaveLength(2);
    expect(s.sessionsOf(P2)).toHaveLength(1);
  });

  it("没有线的项目返回空数组,不是 `undefined`(左栏要直接 map)", () => {
    expect(useChatStore.getState().sessionsOf("p-不存在的项目")).toEqual([]);
  });
});

describe("③ 新开的线立刻可见;全局索引切走再切回仍在", () => {
  it("`newThread` 之后新线就在这个项目的二级目录里,不靠重拉", async () => {
    await useChatStore.getState().loadProjects();
    await vi.waitFor(() => expect(useChatStore.getState().sessionsByProject[P1]).toHaveLength(2));
    // ⚠️ `newThread` 在 `projectId === null` 时**早退**(接待会话里没有「这个项目的线」),
    // 所以这里必须先把上下文切到 p1 —— 否则这条测的是早退分支,不是索引更新。
    useChatStore.setState({ projectId: P1, intakeActive: false } as never);

    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      calls.push(url);
      if (url.endsWith("/api/projects/" + P1 + "/sessions") && init?.method === "POST") {
        return {
          ok: true, status: 200, statusText: "OK",
          json: async () => ({ sessionId: "t_new", title: "新的一面" }),
          text: async () => JSON.stringify({ sessionId: "t_new", title: "新的一面" }),
        };
      }
      return {
        ok: true, status: 200, statusText: "OK",
        json: async () => routes(url),
        text: async () => JSON.stringify(routes(url)),
      };
    });

    await useChatStore.getState().newThread("新的一面");

    const s = useChatStore.getState();
    // ⚠️ **逐条比**,不是 `toContain` —— `toContain` 会在「原有的线被清掉了、
    // 只剩新线」时照样通过(实测:把 append 之前的 spread 改成空的,这条断言
    // 不变红),而那正是「左栏里旧线消失」的样子。
    expect(s.sessionsOf(P1).map((x) => x.id)).toEqual(["s1_main", "t1", "t_new"]);
    expect(s.sessionsOf(P2).map((x) => x.id), "新线不许串到别的项目下").toEqual(["s2_main"]);
    // ⚠️ 负样本:它**不该**靠「再拉一次索引」才出现 —— 那样每次开线都多一个请求,
    // 而左栏在每个路由都要重画。
    expect(calls.filter((u) => u === "/api/sessions")).toHaveLength(1);
    expect(s.sessionId).toBe("t_new");
  });

  it("`selectProject` 不清全局索引(左栏在所有路由下都画着它)", async () => {
    await useChatStore.getState().loadProjects();
    await vi.waitFor(() => expect(useChatStore.getState().sessionsByProject[P2]).toHaveLength(1));

    await useChatStore.getState().selectProject(P1);
    const s = useChatStore.getState();
    // ⚠️ 以前那条扁平的 `sessions` 装的是「上一个项目的线」,清掉是对的;
    // 换成全局索引之后还清 ⇒ 左栏**每切一次项目就空掉一格**。
    expect(s.sessionsOf(P2), "切到 p1 之后 p2 的二级目录必须还在").toHaveLength(1);
    expect(s.sessionsOf(P1)).toHaveLength(2);
  });
});