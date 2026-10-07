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
import { recordClientQuestion, markClientQuestionAnswered } from "../storage/repo/clientQuestions.js";
import type { ClientChannel } from "../client/port.js";
import type { WorkspacePort } from "../workspace/port.js";
import {
  WORKSPACE_ASSEMBLY_PROBLEM, accessFromDeps, workspaceAccess, writeArtifactBody,
} from "./artifactBody.js";
import { fail, ok, requireProject, requireString, readString, readStringArray,
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
    const proj = requireProject(ctx, "ask_client");
    if (!proj.ok) return proj.result;
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
    // 台账用的标题 —— 提问的正文标题就是问题本身(它要被读面显示成一条 open 的提问)
    const questionTitle = question.value;
    const questionBody =
      question.value +
      (options.length > 0 ? `\n\n候选:\n${options.map((o) => `- ${o}`).join("\n")}` : "") +
      (lean !== undefined ? `\n\n倾向:${lean}` : "");

    // ── 先写文件、后插行(设计 §4.3)─────────────────────────────────
    // 与 board_write 同一条纪律、同一个实现(顺序反了会得到「有索引无内容」)。
    const qAccess = workspaceAccess(ctx);
    if (qAccess === null) return fail("internal", WORKSPACE_ASSEMBLY_PROBLEM);
    const qWritten = writeArtifactBody(qAccess, {
      id,
      title: questionTitle,
      deliverableType: null,
      content: questionBody,
    });
    if (!qWritten.ok) {
      return fail(
        "internal",
        `提问正文写盘失败,这次 ask_client **没有落库、也没有投递**:${qWritten.problem}`,
      );
    }

    // 先落工件再投递 —— 顺序反了会出现「问题已经发给用户但库里没有记录」,
    // 用户答完之后无处回填。
    const at = ctx.now();
    try {
      insertArtifact(ctx.db, {
        id,
        projectId: proj.project.id,
        conversationId: null,
        kind: "client_question",
        status: OPEN,
        authorAgentId: ctx.agent.id,
        title: questionTitle,
        bodyPath: qWritten.value.bodyPath,
        bodySha256: qWritten.value.bodySha256,
        bodyBytes: qWritten.value.bodyBytes,
        metadataJson: JSON.stringify({
          options,
          ...(lean !== undefined ? { lean } : {}),
          askedBy: ctx.agent.id,
        }),
        createdAt: at,
        updatedAt: at,
      });
      // 台账行与工件**同一个 try 块**:缺了它,这次提问就没有 `consumed_at` 的起点,
      // 而 `resume_client` 规则的判据正是那一列(见 repo/clientQuestions.ts 文件头)。
      // ⚠️ 工件落库失败**不**回滚台账 —— 反过来才是错的:工件是现场,台账只是它的索引。
      recordClientQuestion(ctx.db, {
        questionArtifactId: id,
        projectId: proj.project.id,
        askedBy: ctx.agent.id,
        askedAt: at,
      });
    } catch (err) {
      return fail("internal", `落提问工件失败,已中止:${err instanceof Error ? err.message : String(err)}`);
    }

    try {
      await channel.ask({
        questionId: id,
        projectId: proj.project.id,
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
    const proj = requireProject(ctx, "tell_client");
    if (!proj.ok) return proj.result;
    const channel = optionalChannel(ctx);
    if (channel === null) {
      return fail("internal", "甲方通道未注入 —— 这是装配错误,不是工具坏了");
    }
    const text = requireString(args, "text");
    if (!text.ok) return text.result;
    try {
      // 作者是**调用这个工具的 agent**(`ctx.agent.id`),不是通道自己猜的:
      // 从前通道实现里写死了业务经理的 id —— 组织表换 id 就静默归错人(§2.10.2 末)。
      await channel.tell({ projectId: proj.project.id, message: text.value, agentId: ctx.agent.id });
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
  /**
   * ⚠️ `content_write_failed` 是**装配/磁盘**的问题,不是数据问题:
   * 正文没写成就**没有** decision 行(先文件后行)。调用方要把它渲染成
   * 「答复没能落库」而不是「找不到这个问题」。
   */
  reason?: "not_found" | "not_a_question" | "already_resolved" | "content_write_failed";
  /** `content_write_failed` 时的现场(路径 / 为什么写不成) */
  problem?: string;
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
  opts: {
    newId: (p: string) => string;
    answeredByAgentId: string;
    /**
     * **工作区**(+ 工作根)—— 落 `decision` 工件的正文用。
     *
     * 为什么它是必填而不是可选:`decision` 的正文与其它工件一样**住文件**
     * (migration 027 的三列 NOT NULL)。没有工作区就没有落点 —— 那只能让这次
     * 答复失败,而**不能**插一行指向不存在文件的记录(「有索引无内容」)。
     * 必填让「忘了装配」变成一次编译错误,而不是一次运行时静默降级。
     */
    workspace: WorkspacePort;
    /** 工作根(`<workRoot>/projects/<projectId>` 的 `workRoot`) */
    workspaceRoot: string;
  },
): ResolveClientQuestionResult {
  const q = getArtifact(db, questionId);
  if (q === null) return { ok: false, reason: "not_found" };
  if (q.kind !== "client_question") return { ok: false, reason: "not_a_question" };
  if (q.status !== "open") return { ok: false, reason: "already_resolved" };

  const decisionId = opts.newId("art");
  const decisionTitle = `甲方答复:${q.title.slice(0, 60)}`;
  const decisionBody = `${answer}\n\n---\n原问题:${q.title}`;
  // 先写文件、后插行(与 board_write 同一个实现、同一条纪律)。
  const access = accessFromDeps(
    { workspace: opts.workspace, workspaceRoot: opts.workspaceRoot },
    q.projectId,
  );
  if (access === null) {
    return { ok: false, reason: "content_write_failed", problem: WORKSPACE_ASSEMBLY_PROBLEM };
  }
  const written = writeArtifactBody(access, {
    id: decisionId, title: decisionTitle, deliverableType: null, content: decisionBody,
  });
  if (!written.ok) return { ok: false, reason: "content_write_failed", problem: written.problem };

  insertArtifact(db, {
    id: decisionId,
    projectId: q.projectId,
    conversationId: null,
    kind: "decision",
    status: ACCEPTED,
    authorAgentId: opts.answeredByAgentId,
    title: decisionTitle,
    bodyPath: written.value.bodyPath,
    bodySha256: written.value.bodySha256,
    bodyBytes: written.value.bodyBytes,
    metadataJson: JSON.stringify({ answersQuestionId: q.id, source: "client" }),
    createdAt: at,
    updatedAt: at,
  });
  addArtifactLink(db, decisionId, "answers", q.id);
  setArtifactStatus(db, q.id, ACCEPTED, at);
  // ⚠️ **与上面三句同一个 try 块** —— 7-L 纪律的另一半:「落 decision + 恢复
  // 执行者必须共用一条路径」。真机事故(2026-10-06 09:09)就是少了这一句:
  // decision 工件落了、提问转 accepted 了,而**没有任何一行记下「答复到了、
  // 业务经理还没看」**,于是 `resume_client` 规则无从判据、答复成了死信。
  markClientQuestionAnswered(db, q.id, decisionId, at);
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
