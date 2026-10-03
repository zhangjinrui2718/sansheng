/**
 * BC2 工具:ask_role / answer / ask_list / ask_read / escalate
 *           convene / meeting_read / meeting_respond / meeting_conclude
 *
 * ── 这一组工具承载 7-L 升级链 ─────────────────────────────────────
 *
 * 旧模型里「执行者求助沟通员」是一条硬编码调用链:
 *   executor 写 hypothesis → artifactBus 事件 → orchestrator → 注入闭包 →
 *   kernel.handleExecutorCallback → communicator.handleWorkerAsk(判断轮)
 *
 * 新模型里它退化成两个普通动词:
 *   ask_role(target)  → 建一条 ask,提问者进 blocked
 *   收到方读 ask_list → 自己判断:能答就 answer,判不了就 escalate
 *
 * **「判断轮」不再是一次独立的 LLM 调用**,而是收到方的正常回合。这不是丢掉
 * 了 7-L 的成果 —— 恰恰相反,7-L 的核心结论是「升级的对象是沟通员,不是用户」,
 * 而那件事现在由「该问谁」这个参数直接表达,不再需要一层专门的转发机制。
 *
 * 旧模型的 `SANSHENG_WORKER_ASK=0` 卫生闸门随之消失:它守的那个独立调用点没有了。
 */
import { Type } from "@sinclair/typebox";
import {
  insertAsk, getAsk, listAsks, answerAsk, escalateAsk, cancelAsk,
  askChain, askedByMeOpen, ASK_STATUSES,
  type AskRow,
} from "../storage/repo/asks.js";
import {
  insertMeeting, getMeeting, listMeetings, listParticipants, respondToMeeting,
  concludeMeeting, stanceTally,
  MEETING_STATUSES, STANCES, isStance,
  type MeetingRow, type Stance,
} from "../storage/repo/meetings.js";
import { insertArtifact, getArtifact, type ArtifactStatus } from "../storage/repo/artifacts.js";

/** 决策工件的固定状态 —— 它就是「已裁定」的记录。 */
const ARTIFACT_ACCEPTED: ArtifactStatus = "accepted";
import { resolveAssignee } from "./resolve.js";
import { getAgent } from "../storage/repo/agents.js";
import { ESCALATION_TARGET } from "../harness/authorize.js";
import { fail, ok, requireString, readString, readStringArray, readNumber,
  type PlatformTool, type ToolResult, type ToolRunContext } from "./types.js";

/** 一条 ask 的渲染行 —— 列表与详情统一,避免两处漂移。 */
function renderAsk(db: ToolRunContext["db"], a: AskRow): string {
  const to = getAgent(db, a.toAgentId);
  const from = getAgent(db, a.fromAgentId);
  const who = `${from?.displayName ?? a.fromAgentId} → ${to?.displayName ?? a.toAgentId}`;
  const chain = a.parentAskId !== null ? `(升级自 ${a.parentAskId})` : "";
  return `[${a.status}] ${a.id} ${who}${chain}\n    ${a.question.split("\n")[0]}`;
}

// ── ask_role ────────────────────────────────────────────────────

const askRole: PlatformTool = {
  name: "ask_role",
  capability: "collab.ask",
  description:
    "向项目内的某个角色提问,然后你会进入 blocked 直到有结论。**必须带 hypothesis** —— 没有你自己的判断,对方无从判断,只能把问题原样推给上级。能自己查清楚的不要问:先 board_list / work_read 看看是不是已经有答案了。",
  parameters: Type.Object({
    targetRole: Type.String({
      description: "问谁:business_manager | project_manager | worker | quality_reviewer",
    }),
    targetSpec: Type.Optional(Type.String({
      description: "目标角色的细分(engineering | algorithm | data),同角色多人时必填",
    })),
    question: Type.String({ description: "要问什么(具体到一个可回答的问题)" }),
    hypothesis: Type.String({
      description:
        "**必填**:你自己的判断与理由。对方据此判断能不能直接答复,而不是把你的问题原样转给甲方",
    }),
    options: Type.Optional(Type.Array(Type.String(), {
      description: "你考虑过的候选方案(带上各自代价)",
    })),
    needs: Type.Optional(Type.String({
      description: "你需要对方做什么决定(要授权?要信息?要拍板?)",
    })),
    deadlineMs: Type.Optional(Type.Number({
      description: "多久没答复就算过期(毫秒)。不给则不设截止",
    })),
  }),
  run(args, ctx): ToolResult {
    const targetRole = requireString(args, "targetRole");
    if (!targetRole.ok) return targetRole.result;
    const question = requireString(args, "question");
    if (!question.ok) return question.result;
    const hypothesis = requireString(args, "hypothesis");
    if (!hypothesis.ok) {
      return fail(
        "invalid_args",
        "必须给 hypothesis —— 7-L 教训:没有它,对方连问题是什么都判断不了,只能原样转给用户",
      );
    }

    const resolved = resolveAssignee(
      ctx.db, ctx.project.id, targetRole.value, args["targetSpec"],
    );
    if (!resolved.ok) {
      return fail("not_found", `无法确定提问对象:${resolved.message}`, resolved.alternatives);
    }
    if (resolved.agentId === ctx.agent.id) {
      return fail("invalid_args", "不能向自己提问 —— 那不会产生任何新信息");
    }

    const options = readStringArray(args, "options") ?? [];
    const deadlineMs = readNumber(args, "deadlineMs");
    const id = ctx.newId("ask");
    const at = ctx.now();
    try {
      insertAsk(ctx.db, {
        id,
        projectId: ctx.project.id,
        fromAgentId: ctx.agent.id,
        toAgentId: resolved.agentId,
        question: question.value,
        hypothesis: hypothesis.value,
        optionsJson: options.length > 0 ? JSON.stringify(options) : null,
        needs: readString(args, "needs") ?? null,
        createdAt: at,
        deadlineAt: deadlineMs !== undefined ? at + deadlineMs : null,
      });
    } catch (err) {
      return fail("conflict", err instanceof Error ? err.message : String(err));
    }
    return ok(
      `已向 ${resolved.agentId} 提问(${id})。你已进入 blocked,等对方答复或升级。\n` +
        `问题:${question.value}`,
    );
  },
};

// ── answer ──────────────────────────────────────────────────────

const answer: PlatformTool = {
  name: "answer",
  capability: "collab.answer",
  description:
    "回答一条提问。**能自己判断的直接答,不要往上推** —— 往上推一次,甲方就多被打扰一次。答不出才用 escalate。落一条 decision 工件作为留痕(审计面要求:执行者必须拿到一份有决定工件的指令)。",
  parameters: Type.Object({
    askId: Type.String(),
    body: Type.String({ description: "答复正文:给出结论 + 依据" }),
    asDecision: Type.Optional(Type.Boolean({
      description: "是否落一条 decision 工件(默认 true)。关掉只用于纯信息性答复",
    })),
  }),
  run(args, ctx): ToolResult {
    const askId = requireString(args, "askId");
    if (!askId.ok) return askId.result;
    const body = requireString(args, "body");
    if (!body.ok) return body.result;

    const ask = getAsk(ctx.db, askId.value);
    if (ask === null) return fail("not_found", `找不到提问 ${askId.value}`);
    if (ask.toAgentId !== ctx.agent.id) {
      return fail(
        "denied",
        `这条提问是问 ${ask.toAgentId} 的,不是问你(${ctx.agent.id})—— 越权代答会让「谁做的决定」无从追溯`,
      );
    }
    if (ask.status !== "open") {
      return fail("conflict", `提问 ${askId.value} 当前状态是 ${ask.status},不是 open`);
    }

    const asDecision = args["asDecision"] !== false;
    const at = ctx.now();
    let artifactId: string | null = null;

    // 先落 decision 工件,再回填 ask —— 顺序反了会出现「ask 说已答复但没有 decision 工件」
    // 的审计空洞,而那正是 7-L 明文要求避免的形态。
    if (asDecision) {
      artifactId = ctx.newId("art");
      try {
        insertArtifact(ctx.db, {
          id: artifactId,
          projectId: ask.projectId,
          conversationId: null,
          kind: "decision",
          status: ARTIFACT_ACCEPTED,
          authorAgentId: ctx.agent.id,
          title: `对 ${ask.id} 的答复`,
          body: `${body.value}\n\n---\n原问题:${ask.question}\n提问者假设:${ask.hypothesis}`,
          metadataJson: JSON.stringify({ answersAskId: ask.id, askerAgentId: ask.fromAgentId }),
          createdAt: at,
          updatedAt: at,
        });
      } catch (err) {
        return fail("internal", `落 decision 工件失败,已中止:${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const r = answerAsk(ctx.db, askId.value, at, artifactId);
    if (!r.ok) {
      return fail(r.reason === "not_found" ? "not_found" : "conflict",
        r.reason === "not_found" ? `找不到提问 ${askId.value}` : `提问 ${askId.value} 已不是 open 状态`);
    }

    return ok(
      `已答复 ${askId.value}${artifactId !== null ? `(decision 工件 ${artifactId})` : ""}` +
        (r.alsoResolved.length > 0
          ? `\n沿升级链回填了 ${r.alsoResolved.length} 条父问:${r.alsoResolved.join(", ")}`
          : ""),
    );
  },
};

// ── ask_list / ask_read ─────────────────────────────────────────

const askList: PlatformTool = {
  name: "ask_list",
  capability: "collab.read",
  description:
    "列提问。**toMeOnly=true 是「有什么在等我答」的标准问法** —— 收到别人求助时先看它。askedByMe=true 看自己卡在哪。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    toMeOnly: Type.Optional(Type.Boolean({ description: "只要问我的,且还需要我答的" })),
    askedByMe: Type.Optional(Type.Boolean({ description: "只要我问的(看自己卡在哪)" })),
    status: Type.Optional(Type.String({ description: ASK_STATUSES.join(" | ") })),
    limit: Type.Optional(Type.Number()),
  }),
  run(args, ctx): ToolResult {
    const pid = readString(args, "projectId") ?? ctx.project.id;
    const status = readString(args, "status");

    if (args["askedByMe"] === true) {
      const rows = askedByMeOpen(ctx.db, ctx.agent.id);
      if (rows.length === 0) return ok("你没有悬而未决的提问");
      return ok(
        `你还有 ${rows.length} 条提问没有结论(你因此处于 blocked):\n` +
          rows.map((a) => renderAsk(ctx.db, a)).join("\n"),
      );
    }

    const rows = listAsks(ctx.db, pid, {
      ...(args["toMeOnly"] === true
        ? { toAgentId: ctx.agent.id, actionableOnly: true }
        : {}),
      ...(status !== undefined ? { status: status as AskRow["status"] } : {}),
      ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
    });
    if (rows.length === 0) {
      return ok(args["toMeOnly"] === true ? "没有等你的提问" : `项目 ${pid} 没有匹配的提问`);
    }
    return ok(`共 ${rows.length} 条:\n${rows.map((a) => renderAsk(ctx.db, a)).join("\n")}`);
  },
};

const askRead: PlatformTool = {
  name: "ask_read",
  capability: "collab.read",
  description:
    "读一条提问的完整内容(hypothesis / 候选方案 / 需要什么决定),以及它所在的升级链。**答复前必须先读它** —— 只看到一句话的摘要就答复,等于没读。",
  parameters: Type.Object({ askId: Type.String() }),
  run(args, ctx): ToolResult {
    const id = requireString(args, "askId");
    if (!id.ok) return id.result;
    const a = getAsk(ctx.db, id.value);
    if (a === null) return fail("not_found", `找不到提问 ${id.value}`);

    let options: string[] = [];
    if (a.optionsJson !== null) {
      try {
        const p: unknown = JSON.parse(a.optionsJson);
        if (Array.isArray(p)) options = p.filter((x): x is string => typeof x === "string");
      } catch {
        options = ["(options_json 已损坏)"];
      }
    }
    const chain = askChain(ctx.db, a.id);
    const resolution =
      a.resolutionArtifactId !== null ? getArtifact(ctx.db, a.resolutionArtifactId) : null;

    return ok(
      [
        `# ${a.id}  [${a.status}]`,
        `- 从:${a.fromAgentId} → 到:${a.toAgentId}`,
        ...(a.parentAskId !== null ? [`- 升级自:${a.parentAskId}`] : []),
        `- 创建:${new Date(a.createdAt).toISOString()}`,
        ...(a.deadlineAt !== null ? [`- 截止:${new Date(a.deadlineAt).toISOString()}`] : []),
        "",
        `## 问题`,
        a.question,
        "",
        `## 提问者的假设(必填项,对方据此判断)`,
        a.hypothesis,
        ...(options.length > 0 ? ["", `## 候选方案`, ...options.map((o) => `- ${o}`)] : []),
        ...(a.needs !== null ? ["", `## 需要什么决定`, a.needs] : []),
        ...(chain.length > 1
          ? ["", `## 升级链(${chain.length} 跳)`, ...chain.map((x) => `- [${x.status}] ${x.id} → ${x.toAgentId}`)]
          : []),
        ...(resolution !== null ? ["", `## 结论工件(${resolution.id})`, resolution.body] : []),
      ].join("\n"),
    );
  },
};

// ── escalate ────────────────────────────────────────────────────

const escalate: PlatformTool = {
  name: "escalate",
  capability: "collab.escalate",
  description:
    "把一条**问你的**提问升给上一级。目标由平台按组织图计算,**你不能指定** —— 这是「不越级」的机制保证。升级会把父问标成 escalated 并建一条子问,所以链上不会留下两条活问。你自己判不了的才升;能答的直接用 answer。",
  parameters: Type.Object({
    askId: Type.String({ description: "要升级的那条提问(必须是你收到的、且还 open)" }),
    reason: Type.String({ description: "为什么你判不了(说清缺什么信息或什么权限)" }),
    hypothesis: Type.String({
      description: "**必填**:你的倾向与理由。上级比下级更需要这份判断依据",
    }),
    options: Type.Optional(Type.Array(Type.String())),
    deadlineMs: Type.Optional(Type.Number()),
  }),
  run(args, ctx): ToolResult {
    const askId = requireString(args, "askId");
    if (!askId.ok) return askId.result;
    const reason = requireString(args, "reason");
    if (!reason.ok) return reason.result;
    const hypothesis = requireString(args, "hypothesis");
    if (!hypothesis.ok) {
      return fail("invalid_args", "升级也必须带 hypothesis —— 上级比下级更需要这份判断依据");
    }

    const parent = getAsk(ctx.db, askId.value);
    if (parent === null) return fail("not_found", `找不到提问 ${askId.value}`);
    if (parent.toAgentId !== ctx.agent.id) {
      return fail("denied", `这条提问不是问你的(问的是 ${parent.toAgentId}),你不能替它升级`);
    }
    if (parent.status !== "open") {
      return fail("conflict", `提问 ${askId.value} 当前是 ${parent.status},不是 open`);
    }

    const target = resolveEscalationAgent(ctx, parent.toAgentId);
    if (target === null) {
      return fail(
        "conflict",
        `问你的人已经是链路的最高一级(${ctx.agent.role}),没有可升级的对象。` +
          `这种情况应该用 answer 给出你能给的最优答复,或请它通过 client.ask 走甲方`,
      );
    }

    const deadlineMs = readNumber(args, "deadlineMs");
    const childId = ctx.newId("ask");
    const r = escalateAsk(ctx.db, askId.value, {
      id: childId,
      projectId: parent.projectId,
      fromAgentId: ctx.agent.id,
      toAgentId: target,
      parentAskId: askId.value,
      question: parent.question,
      hypothesis: `【升级自 ${parent.id}】${hypothesis.value}\n\n下级给出的原因:${reason.value}\n\n原假设:${parent.hypothesis}`,
      optionsJson: (() => {
        const o = readStringArray(args, "options");
        return o !== undefined && o.length > 0 ? JSON.stringify(o) : parent.optionsJson;
      })(),
      needs: parent.needs,
      createdAt: ctx.now(),
      deadlineAt: deadlineMs !== undefined ? ctx.now() + deadlineMs : null,
    }, ctx.now());

    if (!r.ok) {
      return fail(r.reason === "not_found" ? "not_found" : "conflict",
        `升级失败:${r.reason}`);
    }
    return ok(
      `已升级:${askId.value} → ${childId}(升给 ${target})\n` +
        `父问标为 escalated,链上现在只有 ${childId} 是活的。`,
    );
  },
};

/** 按 ESCALATION_TARGET 在项目内找上一级的 agent。 */
function resolveEscalationAgent(ctx: ToolRunContext, fromAgentId: string): string | null {
  const fromAgent = getAgent(ctx.db, fromAgentId);
  if (fromAgent === null) return null;
  const targetRole = ESCALATION_TARGET[fromAgent.role];
  if (targetRole === null) return null;
  const r = resolveAssignee(ctx.db, ctx.project.id, targetRole);
  return r.ok ? r.agentId : null;
}

// ── convene / meeting_* ─────────────────────────────────────────

const convene: PlatformTool = {
  name: "convene",
  capability: "collab.convene",
  description:
    "发起一次对焦会议(多边)。**会议是异步的,不阻塞任何人** —— 参会方在各自下个回合表态。适合「需要多方对齐但不必立刻有结论」的事;需要立刻拍板的单点问题用 ask_role。**只有发起人能收尾**。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    topic: Type.String({ description: "议题(具体到一句话能说清)" }),
    participants: Type.Array(
      Type.Object({
        role: Type.String(),
        spec: Type.Optional(Type.String()),
      }),
      { description: "参会方(至少一个)" },
    ),
    agenda: Type.Optional(Type.Array(Type.String(), { description: "议程条目" })),
  }),
  run(args, ctx): ToolResult {
    const pid = readString(args, "projectId") ?? ctx.project.id;
    const topic = requireString(args, "topic");
    if (!topic.ok) return topic.result;

    const raw = args["participants"];
    if (!Array.isArray(raw) || raw.length === 0) {
      return fail("invalid_args", "至少要有一个参会方 —— 开一场没人参加的对焦毫无意义");
    }

    const ids: string[] = [];
    for (const p of raw) {
      if (typeof p !== "object" || p === null) {
        return fail("invalid_args", "participants 的每一项必须是 {role, spec?}");
      }
      const role = (p as { role?: unknown }).role;
      const spec = (p as { spec?: unknown }).spec;
      const r = resolveAssignee(ctx.db, pid, role, spec);
      if (!r.ok) return fail("not_found", `参会方解析失败:${r.message}`, r.alternatives);
      if (!ids.includes(r.agentId)) ids.push(r.agentId);
    }
    // 发起人自动参会 —— 否则它要收尾却不在参会名单里
    if (!ids.includes(ctx.agent.id)) ids.push(ctx.agent.id);

    const agenda = readStringArray(args, "agenda") ?? [];
    const id = ctx.newId("mtg");
    try {
      insertMeeting(ctx.db, {
        id, projectId: pid, topic: topic.value,
        agendaJson: agenda.length > 0 ? JSON.stringify(agenda) : null,
        conveningAgentId: ctx.agent.id,
        createdAt: ctx.now(),
        participants: ids,
      });
    } catch (err) {
      return fail("invalid_args", err instanceof Error ? err.message : String(err));
    }
    return ok(
      `已发起会议 ${id}「${topic.value}」\n参会 ${ids.length} 方:${ids.join(", ")}\n` +
        `他们会在各自下个回合被提示表态;你(发起人)负责最后用 meeting_conclude 收尾。`,
    );
  },
};

const meetingRead: PlatformTool = {
  name: "meeting_read",
  capability: "collab.meeting.read",
  description: "读会议详情:议题、议程、各方立场与意见、纪要。",
  parameters: Type.Object({ meetingId: Type.String() }),
  run(args, ctx): ToolResult {
    const id = requireString(args, "meetingId");
    if (!id.ok) return id.result;
    const m = getMeeting(ctx.db, id.value);
    if (m === null) return fail("not_found", `找不到会议 ${id.value}`);
    const parts = listParticipants(ctx.db, m.id);
    const tally = stanceTally(ctx.db, m.id);

    let agenda: string[] = [];
    if (m.agendaJson !== null) {
      try {
        const p: unknown = JSON.parse(m.agendaJson);
        if (Array.isArray(p)) agenda = p.filter((x): x is string => typeof x === "string");
      } catch { agenda = ["(agenda_json 已损坏)"]; }
    }

    return ok(
      [
        `# ${m.topic}(${m.id})`,
        `- 状态:${m.status}`,
        `- 发起人:${m.conveningAgentId}`,
        `- 发起:${new Date(m.createdAt).toISOString()}`,
        ...(m.concludedAt !== null ? [`- 收尾:${new Date(m.concludedAt).toISOString()}`] : []),
        ...(agenda.length > 0 ? ["", "## 议程", ...agenda.map((x) => `- ${x}`)] : []),
        "",
        `## 各方立场(支持 ${tally.support} · 反对 ${tally.oppose} · 待定 ${tally.undecided} · 未表态 ${tally.silent})`,
        ...parts.map((p) =>
          p.respondedAt === null
            ? `- ${p.agentId}:**尚未表态**`
            : `- ${p.agentId}:${p.stance}${p.comment !== null ? ` — ${p.comment}` : ""}`,
        ),
        ...(m.summary !== null ? ["", "## 纪要", m.summary] : []),
      ].join("\n"),
    );
  },
};

const meetingRespond: PlatformTool = {
  name: "meeting_respond",
  capability: "collab.meeting.respond",
  description:
    "在会议上表态。**反对必须写原因** —— 没有理由的反对,主持人无法据此调整方案。你也可以表态「待定」并说明还缺什么。",
  parameters: Type.Object({
    meetingId: Type.String(),
    stance: Type.String({ description: STANCES.join(" | ") }),
    comment: Type.Optional(Type.String({ description: "说明;stance=oppose 时必填" })),
  }),
  run(args, ctx): ToolResult {
    const id = requireString(args, "meetingId");
    if (!id.ok) return id.result;
    const stance = readString(args, "stance");
    if (stance === undefined || !isStance(stance)) {
      return fail("invalid_args", `未知立场「${String(stance)}」`, STANCES);
    }
    const r = respondToMeeting(
      ctx.db, id.value, ctx.agent.id, stance as Stance, ctx.now(),
      readString(args, "comment"),
    );
    if (!r.ok) {
      const msg =
        r.reason === "not_found" ? `找不到会议 ${id.value}`
        : r.reason === "not_participant" ? "你不在这次会议的参会名单里"
        : r.reason === "meeting_closed" ? "会议已收尾或取消,不能再表态"
        : "反对必须写理由 —— 没有理由的反对无法被采纳";
      return fail(r.reason === "not_found" || r.reason === "not_participant" ? "not_found" : "conflict", msg);
    }
    return ok(`已在会议 ${id.value} 表态:${stance}`);
  },
};

const meetingConclude: PlatformTool = {
  name: "meeting_conclude",
  capability: "collab.meeting.conclude",
  description:
    "收尾会议并出纪要。**只有发起人能收** —— 否则「会议结论」没有责任人。不必等所有人表态(真实会议里总有人弃权),未表态者会在返回里列出,纪要里应如实带上。纪要会落成 meeting_note 工件。",
  parameters: Type.Object({
    meetingId: Type.String(),
    summary: Type.String({ description: "纪要:结论 + 谁负责做什么 + 谁有保留意见" }),
  }),
  run(args, ctx): ToolResult {
    const id = requireString(args, "meetingId");
    if (!id.ok) return id.result;
    const summary = requireString(args, "summary");
    if (!summary.ok) return summary.result;

    const m = getMeeting(ctx.db, id.value);
    if (m === null) return fail("not_found", `找不到会议 ${id.value}`);

    const at = ctx.now();
    const r = concludeMeeting(ctx.db, id.value, ctx.agent.id, summary.value, at);
    if (!r.ok) {
      const msg =
        r.reason === "not_found" ? `找不到会议 ${id.value}`
        : r.reason === "already_closed" ? "会议已收尾或取消"
        : r.reason === "not_convener" ? `只有发起人(${m.conveningAgentId})能收尾这次会议`
        : "纪要不能为空";
      return fail(r.reason === "not_convener" ? "denied" : "conflict", msg);
    }

    // 纪要落成工件 —— 7-L 纪律:任何改变流程状态的通信都必须留痕。
    // 工件写失败不回滚会议状态,但必须如实告警(否则「会议收尾了但黑板上没有纪要」无声发生)。
    let artifactNote = "";
    try {
      const artifactId = ctx.newId("art");
      insertArtifact(ctx.db, {
        id: artifactId,
        projectId: m.projectId,
        conversationId: null,
        kind: "meeting_note",
        status: "accepted",
        authorAgentId: ctx.agent.id,
        title: `会议纪要:${m.topic}`,
        body:
          `${summary.value}\n\n---\n参会方立场:\n` +
          listParticipants(ctx.db, m.id)
            .map((p) => `- ${p.agentId}:${p.stance ?? "未表态"}${p.comment !== null ? ` — ${p.comment}` : ""}`)
            .join("\n") +
          (r.pending.length > 0 ? `\n\n未表态:${r.pending.join(", ")}` : ""),
        metadataJson: JSON.stringify({ meetingId: m.id, pendingAgents: r.pending }),
        createdAt: at,
        updatedAt: at,
      });
      artifactNote = `\n纪要工件:${artifactId}`;
    } catch (err) {
      artifactNote = `\n⚠️ 纪要工件写入失败(会议已收尾):${err instanceof Error ? err.message : String(err)}`;
    }

    return ok(
      `会议 ${id.value} 已收尾${artifactNote}` +
        (r.pending.length > 0 ? `\n⚠️ 未表态:${r.pending.join(", ")}(纪要里应如实带上)` : ""),
    );
  },
};

export const COLLAB_TOOLS: readonly PlatformTool[] = [
  askRole, answer, askList, askRead, escalate,
  convene, meetingRead, meetingRespond, meetingConclude,
];

// 注意:**这里刻意不 re-export `pendingMeetingsFor` / `listOverdueAsks`**。
// 它们是给「平台把待办注入 agent 回合」与「调度器巡检超时」用的,而那两件事
// 目前都还没有实现(见 docs/ADR-001-harness-wiring.md §5.2 / §5.3)。
// 在这里转发一次会让它们看起来像「已接线」,而实际调用方为零 —— 那正是本
// 项目反复栽过的「声称有、实际没有」。要用的人直接去 storage/repo 取。
