/**
 * Sansheng Harness · 原生工具(native tools)
 *
 * ── 为什么需要这一层,而 7-F 的 toolBridge 不够 ─────────────────────────
 * 7-F 桥接的是 `src/server/tools/` 的 **sandbox 工具**(fs / http):它们背后是
 * `ToolRegistry` + `Sandbox` + `NetSandbox`,与 Sansheng 自己的数据结构无关。
 *
 * 但 Sansheng 真正的「系统原语」是 **Blackboard 与记忆** —— 而这些**没有任何
 * SDK 工具能碰到**:`read`/`grep` 读的是磁盘,`bash` 跑的是命令,没有任何一个
 * 能回答「兄弟 todo 产出什么了」「用户以前说过什么偏好」。
 *
 * 结果是 7-G 之后系统最实质的功能空洞:
 *   - **executor** 领到 todo 后看不到任何前人的结论,只能凭模型脑补写 evidence
 *     (它的出厂提示词里明确写着「不要编造具体的文件路径、API 参数」—— 那是
 *      对能力缺失的**诚实补偿**,不是能力本身);
 *   - **communicator** 看不到 blackboard 就无法转述执行方的产出,只能等回调;
 *   - **planner** 看不到已有 todo,会重复规划。
 *
 * 本模块把这三个原语包成工具。**全部只读**:写工件仍走 Executor 自己的
 * JSON 产物协议(hypothesis / evidence / note),那是带状态机与深度限制的成熟
 * 通道,再加一个写入口只会制造第二条真相源。
 *
 * ── 依赖方向 ─────────────────────────────────────────────────────────
 * 本模块依赖 storage(repo 层),storage 不依赖 harness,无环。
 * 与 toolBridge 的区别是数据源:toolBridge → ToolRegistry;nativeTools → Storage。
 * 两者都由 kernel 在建 session / 跑执行时组装。
 */
import { Type, type TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { listArtifacts, getArtifact } from "../storage/repo/blackboards.js";
import { searchFragmentsByText } from "../storage/repo/fragments.js";
import type { Storage } from "../storage/db.js";
import type { BlackboardArtifact } from "../../../shared/types/blackboard.js";
import type { LoopTool } from "../agents/toolLoop.js";

/**
 * 构造 SDK `ToolDefinition` 的**结构化字面量**。
 *
 * 刻意不用 SDK 导出的 `defineTool()`。查过 0.87.1 的实现:
 * `customTools` 在 `agent-session.js` 的 `_refreshToolRegistry` 里只被**结构化**
 * 消费(`definition.name` + definition 本身),`defineTool` 只是一个类型层的
 * 同一性标记(`AnyToolDefinition` 就是 `ToolDefinition` 的别名),运行时零校验。
 *
 * 换来的是**工具定义不再依赖 SDK 的具体导出**。本仓有 11 个测试文件对 SDK 做了
 * 窄 mock(只桩 `createAgentSession`),工具模块一旦 import 一个它们没覆盖的导出,
 * 这些测试会在**加载期**整体炸掉 —— 7-H 已经踩过一次(缺 `defineTool` → 33 个
 * 失败,其中一个测试文件甚至没能加载)。
 *
 * 「字面量到底能不能用」由端到端测试证明,不由类型证明:
 * `tests/server/communicator-readonly-tools.test.ts` 走**真** `createAgentSession`,
 * 断言 native 工具真的出现在 `getActiveToolNames()` 里。
 */
function sdkTool<T extends ToolDefinition>(t: T): T {
  return t;
}


/** 原生工具名面(`as const` 是刻意的:与 tools.ts 一样,工具名必须是闭合联合)。 */
export const NATIVE_TOOL_NAMES = ["board_list", "board_read", "memory_search"] as const;
export type NativeToolName = (typeof NATIVE_TOOL_NAMES)[number];

/**
 * 统一的工具返回形状。
 *
 * 原生工具**不产出结构化 details** —— 调用方是模型,给它的只有文本;
 * `details` 恒为 null 也就绕开了 typebox 泛型「从第一个 return 反推 TDetails」
 * 那个坑。
 */
async function textResult(p: Promise<string>): Promise<{ content: { type: "text"; text: string }[]; details: null }> {
  return { content: [{ type: "text", text: await p }], details: null };
}

/** module-level type guard:把对话 id 收窄成非空字符串(不给就报可读错误而非崩)。 */
function asConversationId(v: unknown): string {
  return typeof v === "string" && v.trim() ? v.trim() : "";
}

function renderArtifactLine(a: BlackboardArtifact): string {
  const parent = a.metadata?.parentTodoId;
  const ref = typeof parent === "string" && parent ? ` ← ${parent}` : "";
  return `[${a.status}] ${a.kind} ${a.id} · ${a.title}（作者 ${a.author}）${ref}`;
}

function renderArtifactBody(a: BlackboardArtifact): string {
  const meta = Object.keys(a.metadata ?? {}).length > 0 ? `\n\nmetadata: ${JSON.stringify(a.metadata)}` : "";
  return `# ${a.title}\n\n- id: ${a.id}\n- kind: ${a.kind}\n- status: ${a.status}\n- author: ${a.author}\n- scope: ${a.scope}\n${a.refs && a.refs.length > 0 ? `- refs: ${a.refs.join(", ")}\n` : ""}\n\n${a.body}${meta}`;
}

/* ── 纯实现(SDK ToolDefinition 与 LoopTool 共用)─────────────────────────
 * 7-H 教训:不要把 SDK `ToolDefinition` 适配成 `LoopTool` —— 它的 execute 签名
 * 要求第 5 个参数 `ctx: ExtensionContext`(非可选),而 llmCall 路径根本没有
 * session 上下文,适配就得上 `as never`,而项目纪律只允许 registry.ts 用它。
 * 正确做法是**把实现抽成纯函数**,两条路径各自包一层薄壳:
 *   Pi session 路径(communicator)→ sdkTool({ execute: 调 impl })
 *   completeSimple 路径(planner/executor)→ { run: impl }
 * 顺带好处:impl 直接返回文本,不用再跟 AgentToolResult 的 details 类型较劲。 */

async function implBoardList(storage: Storage, args: Record<string, unknown>): Promise<string> {
  try {
    const convId = asConversationId(args["conversationId"]);
    if (!convId) return "[工具失败] board_list: 缺少 conversationId";
    const limit = Math.min(Math.max(Number(args["limit"] ?? 30) || 30, 1), 200);
    const kind = args["kind"];
    const status = args["status"];
    const rows = listArtifacts(storage.db, {
      scope: "conversation",
      conversationId: convId,
      limit,
      ...(typeof kind === "string" ? { kind } : {}),
      ...(typeof status === "string" ? { status } : {}),
    });
    if (rows.length === 0) return `会话 ${convId} 的 Blackboard 上没有匹配的工件。`;
    return `共 ${rows.length} 条:\n${rows.map(renderArtifactLine).join("\n")}\n\n要读某条的正文,用 board_read 传它的 id。`;
  } catch (e) {
    return `[工具失败] board_list: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function implBoardRead(storage: Storage, args: Record<string, unknown>): Promise<string> {
  try {
    const id = asConversationId(args["artifactId"]);
    if (!id) return "[工具失败] board_read: 缺少 artifactId";
    const row = getArtifact(storage.db, id);
    if (!row) return `[工具失败] board_read: 找不到工件 ${id}(可能已被清理,或 id 属于别的会话)`;
    return renderArtifactBody(row);
  } catch (e) {
    return `[工具失败] board_read: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function implMemorySearch(storage: Storage, args: Record<string, unknown>): Promise<string> {
  try {
    const query = typeof args["query"] === "string" ? (args["query"] as string) : "";
    if (!query.trim()) return "[工具失败] memory_search: 缺少 query";
    const limit = Math.min(Math.max(Number(args["limit"] ?? 5) || 5, 1), 20);
    // 与 ws.ts 的记忆富集走同一个函数、同一套 kinds 默认值 —— 不在这里另立
    // 一套检索语义,否则「注入给用户的记忆」和「agent 查到的记忆」会不一致。
    const rows = searchFragmentsByText(storage.db, query, { limit });
    if (rows.length === 0) return `没有匹配「${query}」的记忆片段。`;
    const body = rows
      .map((r) => `[${r.kind}] ${r.content}（重要度 ${r.importance.toFixed(2)} · 命中 ${r.accessCount} 次）`)
      .join("\n");
    return `命中 ${rows.length} 条:\n${body}`;
  } catch (e) {
    return `[工具失败] memory_search: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** 工具的公共元数据(两条路径共用,避免描述文案两处漂移)。 */
const META = {
  board_list: {
    label: "列 Blackboard 工件",
    description:
      "列出当前会话 Blackboard 上的工件(todo / evidence / hypothesis / decision / note),可按 kind 与 status 过滤。**这是你了解「别人已经做了什么」的唯一途径** —— 同一次 plan 里兄弟 todo 的产出都在这里。",
    snippet: "board_list(conversationId, kind?, status?, limit?) — 列出 Blackboard 工件",
  },
  board_read: {
    label: "读 Blackboard 工件",
    description:
      "按 id 读一条工件的完整正文(evidence / hypothesis / decision / note / todo)。**写结论前先读同题的已有结论** —— 复述别人的结论远好过凭空再写一份。",
    snippet: "board_read(artifactId) — 按 id 读一条工件的完整正文",
  },
  memory_search: {
    label: "检索长期记忆",
    description:
      "按文本检索长期记忆片段(用户的偏好 / 事实 / 项目背景 / 上下文),返回按相关度排序的条目。**回答涉及用户个人偏好的问题前先查这里**,比猜准得多。",
    snippet: "memory_search(query, limit?) — 检索长期记忆片段(用户偏好/事实/背景)",
  },
} as const;

/** SDK 路径(communicator 的 Pi session)。 */
export function buildNativeTools(storage: Storage | undefined): ToolDefinition[] {
  if (!storage) return [];
  return [
    sdkTool({
      name: "board_list",
      label: META.board_list.label,
      description: META.board_list.description,
      promptSnippet: META.board_list.snippet,
      parameters: Type.Object({
        conversationId: Type.String({ description: "会话 id(由系统提供)" }),
        kind: Type.Optional(Type.String({ description: "按 kind 过滤:todo / evidence / hypothesis / decision / note / intent" })),
        status: Type.Optional(Type.String({ description: "按 status 过滤:open / in_progress / waiting_for_dependency / waiting_for_decision / resolved / failed" })),
        limit: Type.Optional(Type.Number({ description: "最多返回条数;默认 30,上限 200" })),
      }),
      executionMode: "parallel",
      execute: async (_id, args: Record<string, unknown>) => textResult(implBoardList(storage, args)),
    }),
    sdkTool({
      name: "board_read",
      label: META.board_read.label,
      description: META.board_read.description,
      promptSnippet: META.board_read.snippet,
      parameters: Type.Object({ artifactId: Type.String({ description: "工件 id(来自 board_list)" }) }),
      executionMode: "parallel",
      execute: async (_id, args: Record<string, unknown>) => textResult(implBoardRead(storage, args)),
    }),
    sdkTool({
      name: "memory_search",
      label: META.memory_search.label,
      description: META.memory_search.description,
      promptSnippet: META.memory_search.snippet,
      parameters: Type.Object({
        query: Type.String({ description: "检索词;中文按字拆、英文按词(≥2 字符)" }),
        limit: Type.Optional(Type.Number({ description: "最多返回条数;默认 5" })),
      }),
      executionMode: "parallel",
      execute: async (_id, args: Record<string, unknown>) => textResult(implMemorySearch(storage, args)),
    }),
  ];
}

/**
 * 循环路径(planner / executor 的 completeSimple)。**刻意不 import SDK 类型** ——
 * 循环不跑 Pi session,拿不到也不需要 schema 校验与 ExtensionContext。
 */
export function buildNativeLoopTools(storage: Storage | undefined): LoopTool[] {
  if (!storage) return [];
  return [
    { name: "board_list", description: META.board_list.snippet, run: (a) => implBoardList(storage, a) },
    { name: "board_read", description: META.board_read.snippet, run: (a) => implBoardRead(storage, a) },
    { name: "memory_search", description: META.memory_search.snippet, run: (a) => implMemorySearch(storage, a) },
  ];
}

/** 测试用:确认 schema 非空(挡住「忘了写 parameters」的退化)。 */
export function hasUsableNativeParameters(t: ToolDefinition): boolean {
  return t.parameters !== undefined && typeof t.parameters === "object" && t.parameters !== null;
}

export type { TSchema };
