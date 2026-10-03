/**
 * BC7 工具:memory_search / memory_remember
 *
 * ── 为什么这两个工具在 ToolRunContext 之外还要一个 port ─────────────
 *
 * 记忆的后端是可替换的(设计 1 §8.3),所以工具不能直接碰 `memory_fragments`
 * 表 —— 它只能拿到 `MemoryPort`。这让「换第三方记忆系统」变成一次注入变更,
 * 而不是一次跨文件的 SQL 改写。
 *
 * 工具实现是 async 的(port 的契约是 Promise),派发器已支持。
 */
import { Type } from "@sinclair/typebox";
import { FRAGMENT_KINDS, isFragmentKind } from "../memory/port.js";
import { fail, ok, requireString, readString, readNumber, readStringArray,
  type PlatformTool, type ToolResult, type ToolRunContext } from "./types.js";

const MEMORY_MISSING =
  "记忆后端未注入 —— 这是装配错误,不是工具坏了。检查调用方是否传了 MemoryPort";

const memorySearch: PlatformTool = {
  name: "memory_search",
  capability: "memory.read",
  description:
    "检索长期记忆(关于用户的偏好 / 事实 / 项目背景)。**回答涉及用户个人偏好的问题前先查这里**,比猜准得多。注意它记的是**用户**,不是当前项目 —— 项目内的事用 board_list 查。",
  parameters: Type.Object({
    query: Type.String({ description: "检索词。中文按相邻两字匹配,英文按整词" }),
    kinds: Type.Optional(Type.Array(Type.String(), {
      description: `限定分类:${FRAGMENT_KINDS.join(" | ")}`,
    })),
    limit: Type.Optional(Type.Number({ description: "返回条数,默认 5" })),
  }),
  async run(args, ctx): Promise<ToolResult> {
    const memory = ctx.memory;
    if (memory === undefined) return fail("internal", MEMORY_MISSING);
    const query = requireString(args, "query");
    if (!query.ok) return query.result;

    const kindsRaw = readStringArray(args, "kinds");
    if (kindsRaw !== undefined) {
      const bad = kindsRaw.filter((k) => !isFragmentKind(k));
      if (bad.length > 0) {
        return fail("invalid_args", `未知记忆分类:${bad.join(", ")}`, FRAGMENT_KINDS);
      }
    }
    const limit = readNumber(args, "limit");

    const frags = await memory.recall(query.value, {
      ...(limit !== undefined ? { limit } : {}),
      ...(kindsRaw !== undefined && kindsRaw.length > 0
        ? { kinds: kindsRaw.filter(isFragmentKind) }
        : {}),
    });
    if (frags.length === 0) return ok(`没有匹配「${query.value}」的记忆片段`);
    return ok(
      `命中 ${frags.length} 条:\n` +
        frags
          .map(
            (f) =>
              `- [${f.kind}] ${f.content}(重要度 ${f.importance.toFixed(2)} · 命中 ${f.accessCount} 次)`,
          )
          .join("\n"),
    );
  },
};

const memoryRemember: PlatformTool = {
  name: "memory_remember",
  capability: "memory.write",
  description:
    "记一条关于**用户**的长期知识(偏好 / 事实 / 背景)。只记会长期有效的东西 —— 一次性的上下文不要记,那属于当前对话。项目内的工程事实走 board_write(kind=note),不要污染用户记忆。",
  parameters: Type.Object({
    kind: Type.String({ description: FRAGMENT_KINDS.join(" | ") }),
    content: Type.String({ description: "一句话说清。要能被独立读懂(脱离当前对话)" }),
    importance: Type.Optional(Type.Number({ description: "0~1,默认 0.5" })),
  }),
  async run(args, ctx): Promise<ToolResult> {
    const memory = ctx.memory;
    if (memory === undefined) return fail("internal", MEMORY_MISSING);
    const kind = readString(args, "kind");
    if (kind === undefined || !isFragmentKind(kind)) {
      return fail("invalid_args", `未知记忆分类「${String(kind)}」`, FRAGMENT_KINDS);
    }
    const content = requireString(args, "content");
    if (!content.ok) return content.result;
    const importance = readNumber(args, "importance");

    try {
      const id = await memory.remember({
        content: content.value,
        kind,
        ...(importance !== undefined ? { importance } : {}),
        // 记来源项目:关于某个项目的背景知识,项目没了它也该失效
        sourceProjectId: ctx.project.id,
      });
      return ok(`已记住(${kind})${id}:${content.value}`);
    } catch (err) {
      return fail("invalid_args", err instanceof Error ? err.message : String(err));
    }
  },
};

export const MEMORY_TOOLS: readonly PlatformTool[] = [memorySearch, memoryRemember];
