/**
 * 知识语料工具:knowledge_search / knowledge_read
 *
 * 设计 `docs/DESIGN-KNOWLEDGE.md` §6。两件事必须在这里做对:
 *
 * ① **它不是记忆**。`memory_search` 查的是"用户是谁、偏好什么"(短片段、会淡忘);
 *    这里查的是"项目里写过什么、交付过什么"(正文语料、不淡忘)。
 *    把两者合成一个读口,模型就分不清手里这条是用户偏好还是项目语料 —— 工具的
 *    description 必须把这条边界说出来。
 *
 * ② **预算是硬的**。RAG 特有的风险面:检索结果直接进提示词。真机有过单回合
 *    读进 109k token 撞上墙钟被 abort 的事故。所以:单次 ≤ 20 条、摘要 ≤ 200 字符、
 *    单块正文 ≤ 1200 字符(CHUNK_MAX),要全文就**再调一次** `knowledge_read`。
 */
import { Type } from "@sinclair/typebox";
import { getArtifact } from "../storage/repo/artifacts.js";
import {
  getKnowledgeChunk,
  isKnowledgeSourceKind,
  searchKnowledgeChunks,
  type KnowledgeSourceKind,
} from "../storage/repo/knowledge.js";
import { makeArtifactTextReader, materializeChunk, type Materialization } from "../knowledge/sources.js";
import { buildMatchQuery, excerpt } from "../knowledge/query.js";
import { readString, readNumber, requireString, fail, ok,
  type PlatformTool, type ToolResult, type ToolRunContext } from "./types.js";

/** 检索条数上限。它不是"性能旋钮",是**提示词预算**的一半(另一半是摘要长度)。 */
const SEARCH_LIMIT_MAX = 20;
const SEARCH_LIMIT_DEFAULT = 5;
/** 单条摘要上限(字符)。 */
const EXCERPT_MAX = 200;

/** 读一条块的正文(工件走项目仓、消息走库里)。装配缺失 ⇒ 返回 null,由调用方如实报错。 */
function materializer(ctx: ToolRunContext, chunkId: string): Materialization | null {
  const chunk = getKnowledgeChunk(ctx.db, chunkId);
  if (chunk === null) return null;
  // ⚠️ 不用 `workspaceAccess(ctx)`:语料是**跨项目**的,一条块的正文可能在别的项目仓里。
  // 所以这里按块自己的 project_id 算项目根。装配缺一半时 reader 为 null,
  // 由 `materializeChunk` 翻成一次可读的拒绝(不是空正文)。
  const reader = makeArtifactTextReader(ctx);
  return materializeChunk(ctx.db, reader, chunk);
}

/** 一行出处:能定位到"哪份正文的哪一段"才算引用。 */
function provenanceLine(ctx: ToolRunContext, chunkId: string): string {
  const chunk = getKnowledgeChunk(ctx.db, chunkId);
  if (chunk === null) return "（索引行已不在）";
  const where = chunk.projectId === null ? "（无项目）" : `项目 ${chunk.projectId}`;
  if (chunk.sourceKind === "artifact" && chunk.artifactId !== null) {
    const a = getArtifact(ctx.db, chunk.artifactId);
    const title = a === null ? "（工件行不在库里）" : `《${a.title}》`;
    const sha = a?.commitSha === null || a?.commitSha === undefined ? "" : `@${a.commitSha.slice(0, 8)}`;
    const path = a === null ? "" : ` · ${a.bodyPath}${sha}`;
    return `[工件] ${title} · ${where} · 字符区间 [${chunk.offset}, ${chunk.offset + chunk.length})${path}`;
  }
  return `[消息] ${chunk.messageId ?? chunk.sourceId} · ${where} · 字符区间 [${chunk.offset}, ${chunk.offset + chunk.length})`;
}

const knowledgeSearch: PlatformTool = {
  name: "knowledge_search",
  capability: "knowledge.read",
  description:
    "检索**项目语料**(所有角色的对话正文 + 工件正文 + 中间产出)。" +
    "**与 memory_search 不是一回事**:记忆记的是关于**用户**的偏好/事实(短片段、会淡忘);" +
    "这里查的是**项目里实际写过什么**(正文语料、按来源可追溯)。" +
    "回答「之前那个方案里怎么写的」「谁交付过什么」「上次讨论的结论是什么」之前查这里," +
    "比自己猜准得多。返回的是**片段**;要看某一段全文,用返回的 chunkId 调 knowledge_read。",
  parameters: Type.Object({
    query: Type.String({ description: "检索词。中文按相邻两字匹配,英文按整词;至少 2 个字" }),
    limit: Type.Optional(Type.Number({
      description: `返回条数,默认 ${SEARCH_LIMIT_DEFAULT},上限 ${SEARCH_LIMIT_MAX}(它是提示词预算,不是性能旋钮)`,
    })),
    kind: Type.Optional(Type.String({ description: "限定来源:artifact(工件正文)| message(对话正文)" })),
  }),
  async run(args, ctx): Promise<ToolResult> {
    const q = requireString(args, "query");
    if (!q.ok) return q.result;

    const kindRaw = readString(args, "kind");
    if (kindRaw !== undefined && !isKnowledgeSourceKind(kindRaw)) {
      return fail("invalid_args", `未知来源类型「${kindRaw}」`, ["artifact", "message"]);
    }

    const match = buildMatchQuery(q.value);
    if (match === null) {
      return fail(
        "invalid_args",
        `查询词「${q.value.trim()}」太短 —— 中文至少 2 个字、英文至少 2 个字符才切得出检索词。` +
          "换一个更具体的词(比如「量化」「docker 部署」),不要用单个字。",
      );
    }

    const limit = Math.min(Math.max(readNumber(args, "limit") ?? SEARCH_LIMIT_DEFAULT, 1), SEARCH_LIMIT_MAX);
    const hits = searchKnowledgeChunks(ctx.db, match, {
      limit,
      ...(kindRaw !== undefined ? { kind: kindRaw as KnowledgeSourceKind } : {}),
    });
    if (hits.length === 0) {
      return ok(
        `语料里没有匹配「${q.value}」的内容(检索式:${match})。` +
          "换一个词再试,或者用 board_list / memory_search 换一个面查 —— 别把「没搜到」当成「项目里没有」。",
      );
    }

    const lines: string[] = [`命中 ${hits.length} 条(检索式:${match}):`];
    for (const [i, h] of hits.entries()) {
      lines.push(`${i + 1}. ${provenanceLine(ctx, h.chunk.id)} · chunkId=${h.chunk.id}`);
      const m = materializer(ctx, h.chunk.id);
      if (m === null) {
        lines.push("   （索引行已不在）");
      } else if (m.state === "unavailable") {
        lines.push(`   ⚠️ 读不到正文:${m.problem}`);
      } else {
        if (m.state === "drifted") lines.push(`   ⚠️ ${m.problem}`);
        lines.push(`   ${excerpt(m.slice, EXCERPT_MAX)}`);
      }
    }
    lines.push("");
    lines.push(`上面每条都只是**片段**。要看某一条的完整段落,调 knowledge_read({ chunkId }) —— 只读一条,别一次读很多条。`);
    return ok(lines.join("\n"));
  },
};

const knowledgeRead: PlatformTool = {
  name: "knowledge_read",
  capability: "knowledge.read",
  description:
    "按 chunkId 读取知识语料里的**一个片段全文**(先用 knowledge_search 拿到 chunkId)。" +
    "它读的是索引记的那一段,不是整份工件 —— 要整份工件用 board_read。一次只读一条:内容是正文,直接进你的上下文。",
  parameters: Type.Object({
    chunkId: Type.String({ description: "knowledge_search 返回的 chunkId(形如 chk_xxx)" }),
  }),
  async run(args, ctx): Promise<ToolResult> {
    const id = requireString(args, "chunkId");
    if (!id.ok) return id.result;

    const m = materializer(ctx, id.value);
    if (m === null) {
      return fail(
        "not_found",
        `没有 chunkId=${id.value} 这条语料。它可能已被重扫替换(工件改了、消息清了)—— 重新 knowledge_search 一次拿新的 chunkId。`,
      );
    }
    const head = provenanceLine(ctx, id.value);
    if (m.state === "unavailable") {
      return fail("internal", `这条语料读不到正文:${m.problem}\n出处:${head}`);
    }
    const stateLine =
      m.state === "ok"
        ? "状态:ok(与索引一致)"
        : `状态:drifted —— ${m.problem ?? "索引与来源不一致"}`;
    return ok(`${head}\n${stateLine}\n\n${m.slice}`);
  },
};

export const KNOWLEDGE_TOOLS: readonly PlatformTool[] = [knowledgeSearch, knowledgeRead];
