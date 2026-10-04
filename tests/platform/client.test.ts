/**
 * 甲方接口测试(BC5 接线前置 · ADR-001 §5.1)
 *
 * 这两个工具是**整个组织架构的边界** —— 「甲方只与业务经理交互」的具体执行点。
 * 所以测试重点:
 *   - 其余三个角色即便硬调也被拦下(R1 的端到端验证)
 *   - 提问**先落工件再投递**,投递失败要留现场(不许静默回滚)
 *   - 用户答复走**与问答同一条落库路径**(7-L 纪律)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject, addMember, loadProjectForAuthz } from "../../src/platform/storage/repo/projects.js";
import { getArtifact, listArtifacts, listBackLinks } from "../../src/platform/storage/repo/artifacts.js";
import {
  resolveClientQuestion, pendingClientQuestions,
  CLIENT_TOOLS,
} from "../../src/platform/tools/client.js";
import { createLoggingClientChannel, type ClientChannel, type ClientQuestion } from "../../src/platform/client/port.js";
import { PlatformHub } from "../../src/platform/transport/hub.js";
import { listSessions, listSessionMessages } from "../../src/platform/storage/repo/sessions.js";
import type { ServerEvent } from "@shared/types/platform.js";
import type { WebSocket } from "ws";
import { dispatch, notYetBuiltToolNames, capabilitiesWithoutTools, registrySnapshot } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import type { Agent, Project } from "../../src/platform/harness/authorize.js";

let db: Database.Database;
let seq = 0;
let clock = 1_700_000_000_000;
let project: Project;
const agents = new Map<string, Agent>();
const ids: Record<string, string> = {};

/** 记录型假通道 —— 不碰网络,但留下「投出去了什么」 */
interface RecordingChannel extends ClientChannel {
  asked: Array<ClientQuestion & { questionId: string }>;
  told: string[];
  /** **谁播报的** —— A1 起 tell 必须带真实 agent id(§2.10.2 末) */
  toldBy: string[];
  failNextAsk?: Error;
}
function recordingChannel(): RecordingChannel {
  const ch: RecordingChannel = {
    asked: [],
    told: [],
    toldBy: [],
    async ask(q) {
      if (ch.failNextAsk) throw ch.failNextAsk;
      ch.asked.push(q);
    },
    async tell(input) {
      // 签名带 projectId —— 播报必须知道属于哪个项目(按项目分组呈现)
      if (input.projectId === undefined) throw new Error("tell 缺 projectId");
      // 作者必填且不可空:没有作者位的播报就是「静默归错人」的入口
      if (typeof input.agentId !== "string" || input.agentId === "") {
        throw new Error("tell 缺 agentId(播报没有作者 = 静默归错人)");
      }
      ch.told.push(input.message);
      ch.toldBy.push(input.agentId);
    },
  };
  return ch;
}
let channel: RecordingChannel;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  clock = 1_700_000_000_000;
  agents.clear();
  channel = recordingChannel();

  function mk(role: Agent["role"]): Agent {
    const id = `ag_${role}`;
    insertAgent(db, { id, role, specialization: null, displayName: role, createdAt: clock });
    const a: Agent = { id, role, displayName: role };
    agents.set(id, a);
    return a;
  }
  ids.bm = mk("business_manager").id;
  ids.pm = mk("project_manager").id;
  ids.wk = mk("worker").id;
  ids.qa = mk("quality_reviewer").id;

  insertProject(db, { id: "p1", name: "测试", client: "甲", goal: "g", status: "active", createdAt: clock });
  for (const id of Object.values(ids)) addMember(db, "p1", id, clock);
  project = loadProjectForAuthz(db, "p1")!;
});
afterEach(() => db.close());

function ctxFor(agentId: string, over: Partial<ToolRunContext> = {}): ToolRunContext {
  return {
    db, agent: agents.get(agentId)!, project,
    now: () => clock, newId: (p) => `${p}_${++seq}`,
    client: channel,
    ...over,
  };
}
async function call(agentId: string, tool: string, args: Record<string, unknown> = {}, over: Partial<ToolRunContext> = {}): Promise<ToolResult> {
  const r = dispatch(tool, args, ctxFor(agentId, over));
  return r instanceof Promise ? r : r;
}
function okText(r: ToolResult): string {
  if (!r.ok) throw new Error(`期望成功,失败[${r.code}] ${r.message}`);
  return r.text;
}
function errOf(r: ToolResult): Extract<ToolResult, { ok: false }> {
  if (r.ok) throw new Error(`期望失败,成功:${r.text}`);
  return r;
}

// ── 能力面已完整 ────────────────────────────────────────────────

describe("能力面已完整(BC5 接线前置)", () => {
  it("没有任何未建工具", () => {
    expect(notYetBuiltToolNames()).toEqual([]);
  });

  it("没有任何未覆盖能力", () => {
    expect(capabilitiesWithoutTools()).toEqual([]);
  });

  it("注册表一致性问题为 0", () => {
    expect(registrySnapshot().problems).toEqual([]);
    expect(registrySnapshot().implemented).toBe(34);
  });

  it("client 工具已注册", () => {
    expect(CLIENT_TOOLS.map((t) => t.name).sort()).toEqual(["ask_client", "tell_client"]);
  });
});

// ── R1:只有业务经理能跟甲方说话 ─────────────────────────────────

describe("R1 · 甲方那道门只有一个把手", () => {
  it("业务经理可以 ask_client", async () => {
    const t = okText(await call(ids.bm, "ask_client", { question: "要不要做 X?" }));
    expect(t).toContain("已向甲方提问");
  });

  it("业务经理可以 tell_client", async () => {
    okText(await call(ids.bm, "tell_client", { text: "进展顺利" }));
    expect(channel.told).toEqual(["进展顺利"]);
  });

  for (const key of ["pm", "wk", "qa"] as const) {
    it(`${key} 调 ask_client → 被 ceiling 门拦下`, async () => {
      const e = errOf(await call(ids[key], "ask_client", { question: "我要打扰甲方" }));
      expect(e.code).toBe("denied");
      expect(e.message).toContain("架构上界");
      expect(channel.asked, "被拦下的调用不该投递到通道").toEqual([]);
    });

    it(`${key} 调 tell_client → 被拦下`, async () => {
      const e = errOf(await call(ids[key], "tell_client", { text: "我来说两句" }));
      expect(e.code).toBe("denied");
      expect(channel.told).toEqual([]);
    });
  }
});

// ── ask_client 的行为 ───────────────────────────────────────────

describe("ask_client · 先落工件再投递", () => {
  it("建 client_question 工件(open)并投递到通道", async () => {
    const t = okText(await call(ids.bm, "ask_client", {
      question: "要不要加这个功能?",
      options: ["加(成本 2 天)", "不加(需求方不满)"],
      lean: "倾向加,但想听你的排期判断",
    }));
    const qid = t.match(/\((\S+?)\)/)![1]!;

    const art = getArtifact(db, qid)!;
    expect(art.kind).toBe("client_question");
    expect(art.status).toBe("open");
    expect(art.authorAgentId).toBe(ids.bm);
    expect(art.metadataJson).toContain("倾向加");

    expect(channel.asked).toHaveLength(1);
    expect(channel.asked[0]!.questionId).toBe(qid);
    expect(channel.asked[0]!.options).toHaveLength(2);
    expect(channel.asked[0]!.lean).toContain("倾向加");
  });

  it("缺 question 参数 → invalid_args,且不落工件不投递", async () => {
    const e = errOf(await call(ids.bm, "ask_client", {}));
    expect(e.code).toBe("invalid_args");
    expect(channel.asked).toEqual([]);
    expect(listArtifacts(db, "p1", { kind: "client_question" })).toEqual([]);
  });

  it("**投递失败时工件保留** —— 那是「本该问但没问成」的现场", async () => {
    channel.failNextAsk = new Error("传输层挂了");
    const e = errOf(await call(ids.bm, "ask_client", { question: "关键问题" }));
    expect(e.code).toBe("internal");
    expect(e.message).toContain("已登记但未送达");

    // 工件在,状态仍是 open —— 回滚掉就没人知道用户从没收到
    const qs = listArtifacts(db, "p1", { kind: "client_question" });
    expect(qs).toHaveLength(1);
    expect(qs[0]!.status).toBe("open");
  });

  it("未注入通道 → 如实报装配错误,不假装成功", async () => {
    // 显式传 undefined —— ctxFor 在 spread 之前就设了 client,解构掉字段再 spread
    // 是没用的(它会被重新加回来)
    const e = errOf(await call(ids.bm, "ask_client", { question: "x" }, { client: undefined }));
    expect(e.code).toBe("internal");
    expect(e.message).toContain("甲方通道未注入");
    expect(channel.asked, "装配错误时不该发生投递").toEqual([]);
  });
});

// ── 用户答复的回填 ──────────────────────────────────────────────

describe("resolveClientQuestion · 答复与提问走同一条落库路径", () => {
  async function askOne(): Promise<string> {
    const t = okText(await call(ids.bm, "ask_client", { question: "要不要做 X?", lean: "倾向做" }));
    return t.match(/\((\S+?)\)/)![1]!;
  }

  it("建 decision 工件 + answers 关联 + 提问转 accepted", async () => {
    const qid = await askOne();
    const r = resolveClientQuestion(db, qid, "做,但先做最小版", clock + 100, {
      newId: (p) => `${p}_ans`, answeredByAgentId: ids.bm,
    });
    expect(r.ok).toBe(true);
    expect(r.decisionArtifactId).toBe("art_ans");

    const d = getArtifact(db, "art_ans")!;
    expect(d.kind).toBe("decision");
    expect(d.status).toBe("accepted");
    expect(d.body).toContain("先做最小版");
    expect(d.body).toContain("要不要做 X?"); // 原问题留痕

    // 链连得起来:decision --answers--> question
    expect(listBackLinks(db, qid, "answers")).toEqual(["art_ans"]);
    expect(getArtifact(db, qid)!.status).toBe("accepted");
  });

  it("找不到提问 → not_found", () => {
    expect(resolveClientQuestion(db, "nope", "x", clock, { newId: (p) => p, answeredByAgentId: ids.bm }))
      .toEqual({ ok: false, reason: "not_found" });
  });

  it("不是 client_question → not_a_question(不许拿别的工件冒充提问)", async () => {
    const qid = await askOne();
    // 手动把 kind 改掉绕过 CHECK,模拟数据损坏
    db.pragma("ignore_check_constraints = ON");
    db.prepare(`UPDATE artifacts SET kind = 'note' WHERE id = ?`).run(qid);
    db.pragma("ignore_check_constraints = OFF");
    expect(resolveClientQuestion(db, qid, "x", clock, { newId: (p) => p, answeredByAgentId: ids.bm }))
      .toEqual({ ok: false, reason: "not_a_question" });
  });

  it("重复答复被拒(不能给同一个问题两个结论)", async () => {
    const qid = await askOne();
    resolveClientQuestion(db, qid, "答复一", clock, { newId: () => "art_a1", answeredByAgentId: ids.bm });
    expect(resolveClientQuestion(db, qid, "答复二", clock + 1, { newId: () => "art_a2", answeredByAgentId: ids.bm }))
      .toEqual({ ok: false, reason: "already_resolved" });
    expect(listArtifacts(db, "p1", { kind: "decision" })).toHaveLength(1);
  });

  it("pendingClientQuestions 给出「谁在等甲方」", async () => {
    const a = await askOne();
    const b = await askOne();
    expect(pendingClientQuestions(db, "p1").map((x) => x.id).sort()).toEqual([a, b].sort());

    // 答掉一条 → 只剩另一条
    resolveClientQuestion(db, a, "答了", clock, { newId: () => "art_x", answeredByAgentId: ids.bm });
    expect(pendingClientQuestions(db, "p1").map((x) => x.id)).toEqual([b]);
  });
});

// ── 日志通道(无传输层的兜底)──────────────────────────────────

describe("createLoggingClientChannel · 记下来而不是假装送达", () => {
  it("把问题与播报写进日志", async () => {
    const lines: string[] = [];
    const ch = createLoggingClientChannel((l) => lines.push(l));
    await ch.ask({ questionId: "q1", question: "要不要做?", options: ["要", "不要"], lean: "倾向要" });
    await ch.tell("已开工");
    expect(lines[0]).toContain("client.ask q1");
    expect(lines[0]).toContain("候选:要 | 不要");
    expect(lines[0]).toContain("倾向:倾向要");
    expect(lines[1]).toContain("client.tell");
  });
});

// ── A1 · 说话者身份铺到线上(设计 1 §2.10.2)────────────────────────
//
// 这一批只做「谁在说话」的**字段铺设**:契约必填 `agentId`、hub 的两个建轮
// 事件带它、`tell_client` 把 `ctx.agent.id` 透传进通道。
//
// ⚠️ 它**救不了** §2.10.3 那条「回合中途播报抢走前端 currentTurn」的缺陷 ——
// 根因在前端只有一个 currentTurn 槽、且 delta 不校验 messageId。那是 A2 的活,
// 所以这里一条都不涉及前端行为。

describe("A1 · 播报作者是「调用它的那个 agent」,不是通道里写死的值", () => {
  it("tell_client 把 ctx.agent.id 透传进 ClientChannel.tell", async () => {
    okText(await call(ids.bm, "tell_client", { text: "已开工" }));
    expect(channel.told).toEqual(["已开工"]);
    // 夹具里业务经理的 id 是 `ag_business_manager`,**不是字面量 "bm"** ——
    // 这正是「组织表换 id」的现场:写死 "bm" 的实现在这里会当场露馅。
    expect(channel.toldBy).toEqual([ids.bm]);
    expect(ids.bm).not.toBe("bm");
  });
});

describe("A1 · hub 的两个「建轮」事件带说话人,播报落库也用它", () => {
  /** 直接建 hub(不碰网络):假 ws 只做一件事 —— 把广播到的 JSON 收下来 */
  function hubCapturing(): { hub: PlatformHub; events: ServerEvent[] } {
    const events: ServerEvent[] = [];
    const hub = new PlatformHub(
      { db, now: () => clock, newId: (p) => `${p}_${++seq}` },
      {
        onUserMessage: async () => undefined,
        onAnswerQuestion: async () => undefined,
        onInterrupt: () => undefined,
      },
    );
    hub.addClient({
      on: () => undefined,
      send: (raw: string) => events.push(JSON.parse(raw) as ServerEvent),
    } as unknown as WebSocket);
    events.length = 0; // 丢掉 addClient 那条 ready
    return { hub, events };
  }

  it("emitMessageStart 把 agentId 原样放进事件(null = 甲方)", () => {
    const { hub, events } = hubCapturing();
    hub.emitMessageStart("p1", "m1", "assistant", ids.pm);
    hub.emitMessageStart("p1", "m2", "user", null);
    expect(events).toEqual([
      { type: "message_start", projectId: "p1", messageId: "m1", role: "assistant", agentId: ids.pm },
      { type: "message_start", projectId: "p1", messageId: "m2", role: "user", agentId: null },
    ]);
  });

  it("emitToolStart 把 agentId 原样放进事件(tool_start 自己也能建轮)", () => {
    const { hub, events } = hubCapturing();
    hub.emitToolStart("p1", "m1", { id: "t1", name: "board_write" }, ids.wk);
    expect(events).toEqual([
      {
        type: "tool_start", projectId: "p1", messageId: "m1", agentId: ids.wk,
        tool: { id: "t1", name: "board_write" },
      },
    ]);
  });

  it("clientChannel.tell 用入参里的 agent 落库 + 广播(不再写死 bm)", async () => {
    const { hub, events } = hubCapturing();
    await hub.clientChannel.tell({ projectId: "p1", message: "播报内容", agentId: ids.pm });

    const sessionId = listSessions(db, "p1")[0]!.id;
    expect(listSessionMessages(db, sessionId).map((m) => [m.kind, m.agentId, m.content])).toEqual([
      ["assistant", ids.pm, "播报内容"],
    ]);
    // 三条信封共用同一个 messageId(不写死它 —— 它由注入的 newId 计数器决定)
    expect(events.map((e) => e.type)).toEqual(["message_start", "delta", "message_end"]);
    const start = events[0]!;
    expect(start.type === "message_start" ? start.agentId : null).toBe(ids.pm);
    expect(start.type === "message_start" ? start.messageId : null).toBe(
      events[1]!.type === "delta" ? events[1]!.messageId : null,
    );
  });
});
