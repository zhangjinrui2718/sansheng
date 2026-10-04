/**
 * 甲方接口工具:ask_client / tell_client
 *
 * ── 这两个工具是整个组织架构的边界 ────────────────────────────────
 *
 * 「甲方只与业务经理交互」由 `ROLE_SPECS.business_manager.clientFacing` 保证,
 * 而这两个工具就是那件事的**具体执行点**。其余三个角色即便把工具名写进集合
 * 文件,也会在 ceiling 门与 scope 门被拦下(设计 1 §4.3)。
 *
 * ── 提问为什么落成工件而不是挂起 Promise ──────────────────────────
 *
 * 旧 `MessageBus.ask()` 返回一个 Promise 等 `reply()` resolve —— 266 行、
 * 带 JSONL 持久化,而它的唯一调用方是一个零实例化的死类。真正跑通升级链的
 * 是**异步消息 + 状态机**。这里沿用后者:
 *
 *   ask_client  → 建一条 `client_question` 工件(status=open) → 投递给传输层 → 返回
 *   用户答复     → 建一条 `decision` 工件(rel=answers 指向提问)→ 提问工件转 accepted
 *
 * 「提问者进入 blocked」由工件状态表达,不由挂起的 Promise 表达。
 */
import { Type } from "@sinclair/typebox";
import {
  insertArtifact, getArtifact, setArtifactStatus, addArtifactLink,
  listArtifacts, type ArtifactStatus,
} from "../storage/repo/artifacts.js";
import type { ClientChannel } from "../client/port.js";
import { fail, ok, requireString, readString, readStringArray,
  type PlatformTool, type ToolResult, type ToolRunContext } from "./types.js";

const OPEN: ArtifactStatus = "open";
const ACCEPTED: ArtifactStatus = "accepted";

const askClient: PlatformTool = {
  name: "ask_client",
  capability: "client.ask",
  description:
    "向甲方提问。**这是你唯一能直接接触用户的动词** —— 其余角色遇到不确定的事必须来找你,不能自己打扰甲方。提问前先自问:这条真的需要用户拍板吗?能自己判断的直接判断,能问上游的先问上游。给候选项比开放式提问更容易得到可执行的答复。",
  parameters: Type.Object({
    question: Type.String({ description: "问什么(具体到一个可回答的问题)" }),
    options: Type.Optional(Type.Array(Type.String(), {
      description: "候选项(带各自代价)。强烈建议给 —— 开放式提问的答复往往不可执行",
    })),
    lean: Type.Optional(Type.String({
      description: "你的倾向与理由。让用户一眼看到你建议怎么做,而不是从零判断",
    })),
  }),
  async run(args, ctx): Promise<ToolResult> {
    const channel = optionalChannel(ctx);
    if (channel === null) {
      return fail(
        "internal",
        "甲方通道未注入 —— 这是装配错误,不是工具坏了。检查调用方是否传了 ClientChannel",
      );
    }
    const question = requireString(args, "question");
    if (!question.ok) return question.result;
    const options = readStringArray(args, "options") ?? [];
    const lean = readString(args, "lean");

    const id = ctx.newId("q");
    const at = ctx.now();

    // 先落工件再投递 —— 顺序反了会出现「问题已经发给用户但库里没有记录」,
    // 用户答完之后无处回填。
    try {
      insertArtifact(ctx.db, {
        id,
        projectId: ctx.project.id,
        conversationId: null,
        kind: "client_question",
        status: OPEN,
        authorAgentId: ctx.agent.id,
        title: question.value,
        body:
          question.value +
          (options.length > 0 ? `\n\n候选:\n${options.map((o) => `- ${o}`).join("\n")}` : "") +
          (lean !== undefined ? `\n\n倾向:${lean}` : ""),
        metadataJson: JSON.stringify({
          options,
          ...(lean !== undefined ? { lean } : {}),
          askedBy: ctx.agent.id,
        }),
        createdAt: at,
        updatedAt: at,
      });
    } catch (err) {
      return fail("internal", `落提问工件失败,已中止:${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await channel.ask({
        questionId: id,
        projectId: ctx.project.id,
        question: question.value,
        ...(options.length > 0 ? { options } : {}),
        ...(lean !== undefined ? { lean } : {}),
      });
    } catch (err) {
      // 投递失败不回滚工件 —— 那条 open 的 client_question 是**现场**:
      // 它说明「本该问但没问成」。回滚掉就没人知道用户从没收到这个问题。
      return fail(
        "internal",
        `提问工件已落库(${id}),但投递给甲方失败:${err instanceof Error ? err.message : String(err)}。` +
          `该提问现在处于「已登记但未送达」状态,需要人工处理`,
      );
    }

    return ok(
      `已向甲方提问(${id})。你进入 blocked,等用户答复。\n` +
        `问题:${question.value}` +
        (options.length > 0 ? `\n候选:${options.join(" | ")}` : ""),
    );
  },
};

const tellClient: PlatformTool = {
  name: "tell_client",
  capability: "client.message",
  description:
    "向甲方播报(不等待答复)。**播报不替代落库** —— 有结论要留痕的,仍然要 board_write。这个动词只负责「让用户知道」。",
  parameters: Type.Object({
    text: Type.String({ description: "要播报的内容" }),
  }),
  async run(args, ctx): Promise<ToolResult> {
    const channel = optionalChannel(ctx);
    if (channel === null) {
      return fail("internal", "甲方通道未注入 —— 这是装配错误,不是工具坏了");
    }
    const text = requireString(args, "text");
    if (!text.ok) return text.result;
    try {
      await channel.tell({ projectId: ctx.project.id, message: text.value });
    } catch (err) {
      return fail("internal", `播报失败:${err instanceof Error ? err.message : String(err)}`);
    }
    return ok(`已向甲方播报:${text.value}`);
  },
};

/** 通道从 ctx 取。可选字段 → 缺席时工具如实报装配错误,而不是假装成功。 */
function optionalChannel(ctx: ToolRunContext): ClientChannel | null {
  return ctx.client ?? null;
}

// ── 用户答复的回填 ──────────────────────────────────────────────

export interface ResolveClientQuestionResult {
  ok: boolean;
  reason?: "not_found" | "not_a_question" | "already_resolved";
  decisionArtifactId?: string;
}

/**
 * 用户答复了一条 `client_question`。
 *
 * **提问与答复走同一条落库路径** —— 7-L 纪律:落 decision + 恢复执行者必须共用
 * 一条路径,否则审计面上会出现「拿到了指令但没有对应的 decision 工件」。
 *
 * 它建一条 `decision` 工件并用 `rel='answers'` 指向提问,然后把提问转 accepted。
 * 这样「用户答了什么」和「据此做了什么决定」在链上连得起来。
 */
export function resolveClientQuestion(
  db: ToolRunContext["db"],
  questionId: string,
  answer: string,
  at: number,
  opts: { newId: (p: string) => string; answeredByAgentId: string },
): ResolveClientQuestionResult {
  const q = getArtifact(db, questionId);
  if (q === null) return { ok: false, reason: "not_found" };
  if (q.kind !== "client_question") return { ok: false, reason: "not_a_question" };
  if (q.status !== "open") return { ok: false, reason: "already_resolved" };

  const decisionId = opts.newId("art");
  insertArtifact(db, {
    id: decisionId,
    projectId: q.projectId,
    conversationId: null,
    kind: "decision",
    status: ACCEPTED,
    authorAgentId: opts.answeredByAgentId,
    title: `甲方答复:${q.title.slice(0, 60)}`,
    body: `${answer}\n\n---\n原问题:${q.title}`,
    metadataJson: JSON.stringify({ answersQuestionId: q.id, source: "client" }),
    createdAt: at,
    updatedAt: at,
  });
  addArtifactLink(db, decisionId, "answers", q.id);
  setArtifactStatus(db, q.id, ACCEPTED, at);
  return { ok: true, decisionArtifactId: decisionId };
}

/** 当前还挂着、等用户答的问题 —— 「谁在等甲方」的查询入口。 */
export function pendingClientQuestions(
  db: ToolRunContext["db"],
  projectId: string,
): ReturnType<typeof listArtifacts> {
  return listArtifacts(db, projectId, { kind: "client_question", status: "open" });
}

export const CLIENT_TOOLS: readonly PlatformTool[] = [askClient, tellClient];
