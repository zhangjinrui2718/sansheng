/**
 * Sansheng Harness · SDK 内置工具 → 工具循环的桥接(批次 8-A)
 *
 * ── 这个文件为什么存在(2026-10-03 角色职能核查的头号发现)───────────────
 * 7-H 给执行者定的工具集合是 13 个(含 read / grep / find / ls / edit / write / bash),
 * 出厂提示词也明写「你有文件工具(读 / 检索 / 列目录 / 编辑 / 写入 / 执行命令)」。
 * 但 planner / executor 走的是 `completeSimple` + **自建工具循环**(`agents/toolLoop.ts`),
 * 而那个循环的工具池里**从来没有** SDK 的这 8 个工具 —— 集合文件说 13,循环里真的只有 6。
 *
 * 后果不是「少几个工具」,而是**提示词在教模型用不存在的工具**:模型按提示词调
 * `read` → toolLoop 回「没有名为 read 的工具」→ 而同一份提示词的纪律段又要求
 * 「事实来自工具,没查过的不要写」—— 于是模型在压力下**编造**文件内容。
 * 核查实证见 docs/AGENT-AUDIT-2026-10-03.md §1.3(含可复现脚本输出)。
 *
 * 对照:沟通员**没有**这个问题,因为它走 Pi session,`createAgentSession({ tools })`
 * 由 SDK 自己注册内置工具,allowlist 是机制级的。所以这不是「SDK 工具不能用」,
 * 是「自建循环没把它们接进来」。
 *
 * ── SDK 事实(0.87.1,本批实测)──────────────────────────────────────
 * · 运行时导出 `createReadOnlyTools(cwd)` → read / grep / find / ls,
 *   `createCodingTools(cwd)` → read / bash / edit / write(**read 会重复出现,按名去重**)。
 * · `ToolDefinition.createTool` 只在 .d.ts 里声明、**构建产物没导出**;
 *   运行时能用的是上面两个工厂 —— 照 .d.ts 写会拿到 undefined(本批第一版就踩了)。
 * · 工具形状 `{ name, label, description, parameters, execute(toolCallId, params, signal?) }`,
 *   返回 `{ content: [{ type: "text", text }] }`。
 *
 * ── 边界(与 7-H 裁决保持一致,不擅自放宽)─────────────────────────────
 * · **授权仍由 ROLE_CEILING + 集合文件决定**:本文件只负责「把工具做出来」,
 *   接进池子之后还要过 Executor/Planner 构造时的 `allowedTools` 过滤
 *   (executor.ts:178 / planner.ts:190)。本文件**不做任何授权判断**。
 * · **工作根 = settings.cwd**(ws.ts 传 `kernel.getCwd()`,默认 `~/sansheng-workspace`),
 *   与 Pi session 里的 SDK 工具同一个根。这批**不引入**新的路径沙箱:7-H 已经把
 *   「SDK 的 edit/write/bash 不经 Sansheng Sandbox」写进 AGENTS.md 与 tools.ts 文件头,
 *   本次只补「工具缺失」,不同时改「工具边界」——两件事混在一起会让回归无法归因。
 * · **powershell 不接**:macOS/Linux 上无意义,且与 bash 同为 exec 级,收一个就够
 *   (7-H 的 executor 上界里本来就没有它)。
 */
import { log } from "../../shared/log.js";
import { TOOL_CATALOG, type SdkToolName } from "./tools.js";
import type { LoopTool, LoopToolParam } from "../agents/toolLoop.js";

/** 本批接进循环的 SDK 工具。`powershell` 刻意不在内(见文件头)。 */
const LOOP_SDK_TOOLS: readonly SdkToolName[] = [
  "read",
  "grep",
  "find",
  "ls",
  "edit",
  "write",
  "bash",
];

/** 工具结果正文上限(字符)。
 *  与 sandbox policy.maxBytes(30KB)同量级、留一点余量:再大就该让模型分段读,
 *  而不是一轮灌满上下文(7-N「工具轮上下文累积」的教训)。 */
const RESULT_MAX_CHARS = 32 * 1024;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** SDK 工具的结构化子集(只声明我们真用的字段,避免把 pi-agent-core 的类型
 *  引进 server 侧依赖图 —— 它是 SDK 的传递依赖,不是本项目的直接依赖)。 */
interface SdkToolLike {
  name: string;
  description?: string;
  /** typebox 参数 schema(SDK 自带)—— 批次 8-F 用来把参数名告诉模型 */
  parameters?: unknown;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: ReadonlyArray<{ type: string; text?: string }> }>;
}

/**
 * 批次 8-F:把 SDK 的 typebox schema 压成协议段能渲染的参数清单。
 * 只取 properties 的键名 + 必填标记 + 字段自带的 description ——
 * **不把整个 JSON Schema 塞进 systemPrompt**(每轮膨胀几百 token,不划算)。
 * schema 缺失或形状不认识时返回 undefined(退化到「无参数提示」,与 8-F 之前同款)。
 */
function toParams(schema: unknown): LoopToolParam[] | undefined {
  if (typeof schema !== "object" || schema === null) return undefined;
  const s = schema as {
    properties?: Record<string, { description?: unknown } | undefined>;
    required?: unknown;
  };
  const props = s.properties;
  if (typeof props !== "object" || props === null) return undefined;
  const required = new Set(
    Array.isArray(s.required) ? s.required.filter((k): k is string => typeof k === "string") : [],
  );
  const out: LoopToolParam[] = [];
  for (const [key, def] of Object.entries(props)) {
    const desc =
      def && typeof def === "object" && typeof def.description === "string"
        ? def.description
        : "";
    out.push({
      name: key,
      required: required.has(key),
      // SDK 的 description 是英文短句,模型读得懂;只截断防止长篇占提示词
      description: desc.length > 90 ? desc.slice(0, 90) + "…" : desc,
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * AgentToolResult.content → 给模型看的纯文本。图片块跳过(工具循环是文本协议),
 * 跳过的部分如实标注,不静默丢。
 */
function renderResult(content: ReadonlyArray<{ type: string; text?: string }>): string {
  const parts: string[] = [];
  let skippedImages = 0;
  for (const block of content) {
    if (typeof block.text === "string" && block.text.length > 0) parts.push(block.text);
    else if (block.type === "image") skippedImages += 1;
  }
  if (skippedImages > 0) {
    parts.push(`[${skippedImages} 个图片内容块未转述 —— 工具循环是文本协议]`);
  }
  const out = parts.join("\n").trim();
  if (out.length <= RESULT_MAX_CHARS) return out.length > 0 ? out : "(工具返回了空内容)";
  return (
    out.slice(0, RESULT_MAX_CHARS) +
    `\n\n> ⚠️ 工具结果超过 ${RESULT_MAX_CHARS} 字符已截断。需要更多请分段读取。`
  );
}

/**
 * 把 SDK 内置工具包成 LoopTool。
 *
 * 失败语义与 harness 另两组工具同款:**抛错 → `[工具失败]` 前缀的文本回灌**,
 * 不 reject 整轮(toolLoop.ts 文件头纪律 1)。模型要能「换个参数重试」,
 * 就不能把一次参数错误变成整条 todo 失败。
 *
 * 构造失败(SDK 版本不兼容 / cwd 不可用)**不抛**:返回已成功的那些 + warn。
 * 理由与 createBridgedLoopTools 同款 —— 这里丢的是「能力」不是「授权」,
 * 少几个工具好过整个 executor 起不来。
 */
export async function createSdkLoopTools(cwd: string): Promise<LoopTool[]> {
  const factories: Array<(dir: string) => SdkToolLike[]> = [];
  try {
    const mod = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      createReadOnlyTools?: (dir: string) => SdkToolLike[];
      createCodingTools?: (dir: string) => SdkToolLike[];
    };
    if (typeof mod.createReadOnlyTools === "function") {
      factories.push(mod.createReadOnlyTools);
    }
    if (typeof mod.createCodingTools === "function") {
      factories.push(mod.createCodingTools);
    }
    if (factories.length === 0) {
      log.warn("harness: SDK 未导出 createReadOnlyTools/createCodingTools(版本不兼容),planner/executor 拿不到 SDK 内置工具");
      return [];
    }
  } catch (err) {
    log.warn("harness: SDK 工具桥接 import 失败,planner/executor 拿不到 SDK 内置工具:", errMessage(err));
    return [];
  }

  // 两个工厂都会产出 read;按名去重,保留第一次出现(只读工厂在前)。
  const byName = new Map<string, SdkToolLike>();
  for (const factory of factories) {
    let built: SdkToolLike[];
    try {
      built = factory(cwd);
    } catch (err) {
      log.warn("harness: SDK 工具构造失败,跳过该组:", errMessage(err));
      continue;
    }
    for (const tool of built) {
      if (!LOOP_SDK_TOOLS.includes(tool.name as SdkToolName)) continue; // 只收本批声明的 7 个
      if (byName.has(tool.name)) continue;
      byName.set(tool.name, tool);
    }
  }

  const out: LoopTool[] = [];
  for (const name of LOOP_SDK_TOOLS) {
    const tool = byName.get(name);
    if (!tool) {
      log.warn(`harness: SDK 工具 ${name} 未能构造,该工具在本轮不可用`);
      continue;
    }
    out.push({
      name,
      // 描述用 TOOL_CATALOG 的中文一行摘要,不用 SDK 的长 description:
      // renderToolProtocol 会把每条拼进 systemPrompt,SDK 原文动辄两三行 × 7 个工具。
      description: TOOL_CATALOG[name].summary,
      // 批次 8-F:参数名从 SDK 自带的 typebox schema 取(权威来源,不会与实现漂移)。
      // 少了这一步,模型只能猜参数名 —— 实机里它给 bash 传了 {"cmd":...},
      // 于是回灌 `/bin/bash: undefined`,工具等于没有。
      parameters: toParams(tool.parameters),
      run: async (args: Record<string, unknown>): Promise<string> => {
        try {
          const res = await tool.execute(`loop-${name}-${Date.now().toString(36)}`, args);
          return renderResult(res.content);
        } catch (err) {
          return `[工具失败] ${name}: ${errMessage(err)}`;
        }
      },
    });
  }
  return out;
}

/** 本批接进循环的 SDK 工具名(不变量测试与 diagnose 用)。 */
export const LOOP_SDK_TOOL_NAMES: readonly string[] = LOOP_SDK_TOOLS;