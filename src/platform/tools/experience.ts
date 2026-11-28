/**
 * 经验库工具:experience_save / experience_retire / experience_search / experience_read
 *
 * migration 040(2026-11-28)。三套东西的边界必须在工具的 description 里说清
 * (与 `tools/knowledge.ts` 文件头同一条纪律):
 *
 *   memory_*         关于**用户**(偏好、事实),会淡忘
 *   knowledge_*      关于**项目**(对话与工件正文的语料),按项目隔离
 *   experience_*     关于**这个角色自己的手艺**(经验、外部调研),跨项目、按角色隔离
 *
 * ── 隔离 ───────────────────────────────────────────────────────
 *
 * 四个工具都只碰 `ctx.agent.id` 自己的条目。别的角色的条目对调用者来说与「没有」
 * 长得一样(不暴露存在性)—— 与 `knowledge_read` 同一道门。
 *
 * ── 预算是硬的 ─────────────────────────────────────────────────
 *
 * 与语料同一条:检索结果直接进提示词。单次 ≤ 20 条、摘要 ≤ 200 字符;要看全文再调
 * 一次 `experience_read`。
 *
 * ── 调研必须带出处 ──────────────────────────────────────────────
 *
 * `research` 类条目在**工具层**强制 `source` 非空 —— 经验库里的东西会跟着角色进以后
 * 每一个项目,一句没有出处的「网上说的」比不记更坏(与 `research_worker.protocol.md`
 * 「拿不出来源的结论,标注为推断」同一条规矩)。
 */
import { Type } from "@sinclair/typebox";
import {
  AGENT_NOTE_KINDS,
  countActiveAgentNotes,
  getAgentNote,
  insertAgentNote,
  isAgentNoteKind,
  retireAgentNote,
  searchAgentNotes,
  updateAgentNote,
  type AgentNoteInput,
  type AgentNoteKind,
  type AgentNoteRow,
} from "../storage/repo/agentNotes.js";
import { buildMatchQuery, excerpt } from "../knowledge/query.js";
import { getProjectRow } from "../storage/repo/projects.js";
import {
  fail, ok, readNumber, readString, requireString,
  type PlatformTool, type ToolResult, type ToolRunContext,
} from "./types.js";

/** 在用条目上限。它不是性能旋钮:库越大,最相关的几条越容易被同质的旧条目挤掉。 */
export const EXPERIENCE_MAX_ACTIVE = 500;
const TITLE_MAX = 80;
const CONTENT_MAX = 8000;
const SOURCE_MAX = 300;
const REASON_MAX = 300;
const SEARCH_LIMIT_DEFAULT = 5;
const SEARCH_LIMIT_MAX = 20;
const EXCERPT_MAX = 200;

const KIND_LABEL: Readonly<Record<AgentNoteKind, string>> = { lesson: "经验", research: "调研" };

function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 最多 300 字符的一行(防一条超长原因把提示词撑爆)。 */
function clampLine(s: string, max: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

/**
 * 取一条**属于调用者**的条目。别人的条目与不存在的条目返回同一种失败 —— 不暴露存在性。
 */
function ownNote(ctx: ToolRunContext, id: string): { readonly ok: true; readonly note: AgentNoteRow } | { readonly ok: false; readonly result: ToolResult } {
  const note = getAgentNote(ctx.db, id);
  if (note === null || note.agentId !== ctx.agent.id) {
    return {
      ok: false,
      result: fail("not_found", `没有属于你的 noteId=${id}。重新 experience_search 一次拿新的 id。`),
    };
  }
  return { ok: true, note };
}

/**
 * 校验并组装一条条目的可改字段。新建与改写共用 —— 两处各写一遍就会漂。
 * `prior` 是改写时的原条目:来源项目缺省沿用它的(改一条经验不等于换了个学到处)。
 */
function noteInput(
  ctx: ToolRunContext,
  args: Readonly<Record<string, unknown>>,
  prior: { readonly sourceProjectId: string | null } | null,
): { readonly ok: true; readonly input: AgentNoteInput } | { readonly ok: false; readonly result: ToolResult } {
  const kindRaw = readString(args, "kind");
  if (kindRaw === undefined || !isAgentNoteKind(kindRaw)) {
    return { ok: false, result: fail("invalid_args", `kind 必须是 ${AGENT_NOTE_KINDS.join(" / ")} 之一`, AGENT_NOTE_KINDS) };
  }
  // ⚠️ `requireString` 只拒「空串与不是字符串的」—— 一串空白它能过;条目的标题与正文
  // 必须 trim 之后还剩东西(一条标题是空白的经验,检索到了也没法认)。
  const title = requireString(args, "title");
  if (!title.ok) return title;
  if (title.value.trim() === "") {
    return { ok: false, result: fail("invalid_args", "title 不能只有空白") };
  }
  if (title.value.trim().length > TITLE_MAX) {
    return { ok: false, result: fail("invalid_args", `title 太长(${title.value.trim().length} > ${TITLE_MAX} 字符)—— 压成一句话`) };
  }
  const content = requireString(args, "content");
  if (!content.ok) return content;
  if (content.value.trim() === "") {
    return { ok: false, result: fail("invalid_args", "content 不能只有空白") };
  }
  if (content.value.trim().length > CONTENT_MAX) {
    return { ok: false, result: fail("invalid_args", `content 太长(${content.value.trim().length} > ${CONTENT_MAX} 字符)—— 一条只记一件事;确实很长的调研资料拆成几条`) };
  }
  const source = readString(args, "source")?.trim() ?? null;
  if (source !== null && source.length > SOURCE_MAX) {
    return { ok: false, result: fail("invalid_args", `source 太长(${source.length} > ${SOURCE_MAX} 字符)`) };
  }
  if (kindRaw === "research" && (source === null || source === "")) {
    return {
      ok: false,
      result: fail(
        "invalid_args",
        "调研条目必须带 source(网址、书名或「某某文档第几节」这类可追溯的出处)。拿不出来源的内容不要记成调研。",
      ),
    };
  }
  const explicitProject = readString(args, "sourceProjectId");
  if (explicitProject !== undefined && getProjectRow(ctx.db, explicitProject) === null) {
    return { ok: false, result: fail("not_found", `sourceProjectId=${explicitProject} 不是库里有的项目。不给这个参数 = 当前项目。`) };
  }
  const sourceProjectId = explicitProject !== undefined
    ? explicitProject
    : (prior !== null ? prior.sourceProjectId : (ctx.project?.id ?? null));
  return {
    ok: true,
    input: { kind: kindRaw, title: title.value.trim(), content: content.value.trim(), source, sourceProjectId },
  };
}

const experienceSave: PlatformTool = {
  name: "experience_save",
  capability: "experience.write",
  description:
    "往**你自己的经验库**记一条(跨项目留着,只有你自己检索得到)。两类:" +
    "`lesson` = 做法与教训(「这类报告先列数据再下结论」「那个接口要带重试」);" +
    "`research` = 外部调研得来的事实或资料,**必须带 source 出处**。" +
    "给了 `noteId` 就是改写那一条(退休的条目改对了会重新生效)。" +
    "**与 memory_remember 不是一回事**:那记的是关于用户的事;这里记的是你自己的手艺。" +
    "记之前先 `experience_search` 看有没有重复 —— 改一条旧的比再记一条新的好。",
  parameters: Type.Object({
    kind: Type.String({ description: "lesson(经验)| research(调研,必带 source)" }),
    title: Type.String({ description: `一句话标题(≤ ${TITLE_MAX} 字符)` }),
    content: Type.String({ description: `正文:下次该怎么做 / 查到了什么(≤ ${CONTENT_MAX} 字符)` }),
    source: Type.Optional(Type.String({ description: "出处。research 必填:网址、书名、文档位置" })),
    noteId: Type.Optional(Type.String({ description: "改写哪一条(experience_search 返回的 id,形如 an_xxx);不给 = 新建" })),
    sourceProjectId: Type.Optional(Type.String({ description: "这条经验是在哪个项目里学到的;不给 = 当前项目" })),
  }),
  run(args, ctx): ToolResult {
    const priorId = readString(args, "noteId");
    const prior = priorId === undefined ? null : ownNote(ctx, priorId);
    if (prior !== null && !prior.ok) return prior.result;

    const input = noteInput(ctx, args, prior === null ? null : prior.note);
    if (!input.ok) return input.result;

    if (priorId !== undefined && prior !== null && prior.ok) {
      // `updateAgentNote` 返回 false = 行不在(刚被删):不许当成功。
      if (!updateAgentNote(ctx.db, priorId, input.input, ctx.now())) {
        return fail("not_found", `noteId=${priorId} 刚刚不在了(可能被删除)—— 重新 experience_search 一次。`);
      }
      const wasRetired = prior.note.status === "retired";
      return ok(
        `已改写 ${priorId}「${input.input.title}」${wasRetired ? "(它原本已退休,现在重新生效)" : ""}。`,
      );
    }

    const active = countActiveAgentNotes(ctx.db, ctx.agent.id);
    if (active >= EXPERIENCE_MAX_ACTIVE) {
      return fail(
        "conflict",
        `你的经验库已经有 ${active} 条在用的条目,到了上限(${EXPERIENCE_MAX_ACTIVE})。` +
          "先 experience_search 找出过时的,用 experience_retire 把它们退休,再记新的。",
      );
    }
    const row = insertAgentNote(ctx.db, {
      id: ctx.newId("an"),
      agentId: ctx.agent.id,
      note: input.input,
      now: ctx.now(),
    });
    return ok(`已记下 ${row.id}「${row.title}」(${KIND_LABEL[row.kind]})。`, { noteId: row.id });
  },
};

const experienceRetire: PlatformTool = {
  name: "experience_retire",
  capability: "experience.write",
  description:
    "把你自己经验库里的**一条**标成退休(要写原因)。退休的条目不再被检索到、也不再出现在你每轮的相关经验里;" +
    "读还是读得到。发现自己以前记错了、或者做法已经过时,用它 —— 别让一条错的经验一直冒出来。" +
    "你只能退休自己的条目;没有「删除」这个动作(删除是甲方在界面上做的事)。",
  parameters: Type.Object({
    noteId: Type.String({ description: "experience_search 返回的 id(形如 an_xxx)" }),
    reason: Type.String({ description: `为什么退休(≤ ${REASON_MAX} 字符):记错了 / 过时了 / 被哪条更好的取代了` }),
  }),
  run(args, ctx): ToolResult {
    const id = requireString(args, "noteId");
    if (!id.ok) return id.result;
    const reason = requireString(args, "reason");
    if (!reason.ok) return reason.result;
    if (reason.value.trim() === "") {
      return fail("invalid_args", "reason 不能只有空白 —— 写清为什么退休(记错了 / 过时了 / 被哪条取代了)");
    }
    if (reason.value.trim().length > REASON_MAX) {
      return fail("invalid_args", `reason 太长(${reason.value.trim().length} > ${REASON_MAX} 字符)`);
    }
    const own = ownNote(ctx, id.value);
    if (!own.ok) return own.result;
    // `retireAgentNote` 返回 false = 已经退休:如实说,不当成成功。
    if (!retireAgentNote(ctx.db, id.value, reason.value.trim(), ctx.now())) {
      return fail("conflict", `${id.value} 已经是退休状态(原因:${clampLine(own.note.retireReason ?? "未写", REASON_MAX)})。`);
    }
    return ok(`已退休 ${id.value}「${own.note.title}」。它不会再出现在你的检索结果里。`);
  },
};

const experienceSearch: PlatformTool = {
  name: "experience_search",
  capability: "experience.read",
  description:
    "检索**你自己的经验库**(你以前记的做法、教训、外部调研;跨项目)。" +
    "**与 knowledge_search 不是一回事**:那查的是当前项目里写过的工件与对话;这里查的是你自己在别的项目里沉淀下来的东西。" +
    "动手之前查一下 —— 同一个坑不值得踩第二遍。返回的是片段;要看全文,用返回的 noteId 调 experience_read。",
  parameters: Type.Object({
    query: Type.String({ description: "检索词。中文按相邻两字匹配,英文按整词;至少 2 个字" }),
    limit: Type.Optional(Type.Number({ description: `返回条数,默认 ${SEARCH_LIMIT_DEFAULT},上限 ${SEARCH_LIMIT_MAX}` })),
    kind: Type.Optional(Type.String({ description: "限定类型:lesson(经验)| research(调研)" })),
  }),
  run(args, ctx): ToolResult {
    const q = requireString(args, "query");
    if (!q.ok) return q.result;
    const kindRaw = readString(args, "kind");
    if (kindRaw !== undefined && !isAgentNoteKind(kindRaw)) {
      return fail("invalid_args", `未知类型「${kindRaw}」`, AGENT_NOTE_KINDS);
    }
    const match = buildMatchQuery(q.value);
    if (match === null) {
      return fail(
        "invalid_args",
        `查询词「${q.value.trim()}」太短 —— 中文至少 2 个字、英文至少 2 个字符才切得出检索词。换一个更具体的词。`,
      );
    }
    const limit = Math.min(Math.max(readNumber(args, "limit") ?? SEARCH_LIMIT_DEFAULT, 1), SEARCH_LIMIT_MAX);
    const hits = searchAgentNotes(ctx.db, match, {
      agentId: ctx.agent.id,
      limit,
      ...(kindRaw !== undefined ? { kind: kindRaw as AgentNoteKind } : {}),
    });
    if (hits.length === 0) {
      // 「没搜到」与「库是空的」是两句话:后者提示它该开始记了。
      const active = countActiveAgentNotes(ctx.db, ctx.agent.id);
      return ok(
        active === 0
          ? "你的经验库还是空的。这一轮做完如果有值得下次复用的做法或踩过的坑,用 experience_save 记下来。"
          : `你的经验库里没有匹配「${q.value}」的条目(检索式:${match};库里共有 ${active} 条在用的)。换一个词再试。`,
      );
    }
    const lines: string[] = [`命中 ${hits.length} 条(检索式:${match}):`];
    for (const [i, h] of hits.entries()) {
      const n = h.note;
      lines.push(
        `${i + 1}. [${KIND_LABEL[n.kind]}]《${n.title}》 · 记于 ${localDate(n.createdAt)}` +
          `${n.source !== null ? ` · 出处:${clampLine(n.source, 80)}` : ""} · noteId=${n.id}`,
      );
      lines.push(`   ${excerpt(n.content, EXCERPT_MAX)}`);
    }
    lines.push("");
    lines.push("上面每条都只是片段。要看某一条的全文,调 experience_read({ noteId })。");
    return ok(lines.join("\n"));
  },
};

const experienceRead: PlatformTool = {
  name: "experience_read",
  capability: "experience.read",
  description:
    "按 noteId 读你自己经验库里的**一条全文**(先用 experience_search 拿到 noteId)。只读得到你自己的条目。" +
    "一次只读一条:内容是正文,直接进你的上下文。",
  parameters: Type.Object({
    noteId: Type.String({ description: "experience_search 返回的 noteId(形如 an_xxx)" }),
  }),
  run(args, ctx): ToolResult {
    const id = requireString(args, "noteId");
    if (!id.ok) return id.result;
    const own = ownNote(ctx, id.value);
    if (!own.ok) return own.result;
    const n = own.note;
    const head =
      `[${KIND_LABEL[n.kind]}]《${n.title}》 · 记于 ${localDate(n.createdAt)} · 最后改于 ${localDate(n.updatedAt)}` +
      `${n.source !== null ? `\n出处:${n.source}` : ""}`;
    const state = n.status === "active" ? "状态:在用" : `状态:已退休 —— ${clampLine(n.retireReason ?? "未写原因", REASON_MAX)}`;
    return ok(`${head}\n${state}\n\n${n.content}`);
  },
};

export const EXPERIENCE_TOOLS: readonly PlatformTool[] = [experienceSave, experienceRetire, experienceSearch, experienceRead];
