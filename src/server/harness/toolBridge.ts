/**
 * Sansheng Harness · 工具桥接(tool bridge)
 *
 * 存在的理由:`src/server/tools/` 早就实现了一层**完整且有沙箱**的工具 —— fs 四件套
 * (Sandbox:`~/.sansheng/workspace` + `~/.sansheng/canvas` 两个允许根、30 KiB 上限、
 * 不跟随 symlink、写 symlink default-deny)+ http 两件套(netSandbox:空 allowlist 全拒、
 * 端口限 80/443/8080/8443、private IP 全拒、5 MiB 上限、DNS lookup 防 rebinding)。
 * 加上 `ToolRegistry` 与 `GET /api/tools/list` / `POST /api/tools/invoke`,它一直都在。
 *
 * **但零个 agent 够得着它。** 沟通员的 4 个工具是 Pi SDK 自带的,走的是另一套根
 * (SDK `read` 读 `cwd`;sansheng `fs.readFile` 读 `~/.sansheng/canvas`)。这跟旧的
 * `HarnessConfig.enabledTools` 是同一种病:一整层做完了没人调。
 *
 * 本模块把那 6 个 registry 注册项包成 SDK 的 `ToolDefinition`,经
 * `createAgentSession({ customTools })` 进入 agent 的工具面。SDK 侧
 * `isAllowedTool` 对 builtin / extension / customTools **统一过滤**,所以本模块
 * 只负责「把工具搬进 session」,**不做任何授权判断** —— 授权仍然 100% 由
 * `harness/tools/{role}.json` 的 `allowed` 名单决定(见 tools.ts 的 ceiling 分层)。
 * 两边刻意不重复实现策略:一份名单,一处裁决。
 *
 * ── 命名:为什么 LLM 侧的名字不是 `fs.readFile` ─────────────────────────
 * 1. **provider 约束**:OpenAI / Anthropic / DeepSeek 的 function-name schema 都是
 *    `^[a-zA-Z0-9_-]{1,64}$`,**带点的名字会被 provider 直接拒收**。registry 内部的
 *    `fs.readFile` 是内部标识,不能原样暴露给模型。
 * 2. **语义冲突**:SDK 已有 `read`(沿 `cwd` 走)。若 sansheng 的读盘工具也叫 `read`,
 *    模型面对两个根完全不同、权限完全不同的「读文件」会混用 —— 而权限面混用是
 *    安全事故,不是体验问题。
 * 故 LLM 侧一律 `snake_case`,并用 `canvas_`(与 sandbox 自己的术语
 * `~/.sansheng/canvas` 对齐)/ `net_` 前缀标明根与网络属性。
 *
 * ── 错误处理:为什么不 reject 而是返回文本 ─────────────────────────────
 * registry 的工具会把 `SandboxError` / `NetSandboxError` / `TypeError` 原样抛出
 * (integration.ts 的设计取舍:不 wrapper 捕获,保住 instanceof 链路与原始栈帧)。
 * 桥接层**故意**不把异常变成 rejection:
 *   - rejection 可能带崩整轮 tool batch,而「路径被沙箱拒绝」是模型**可以自行改正**
 *     的普通反馈(换个路径、问用户);
 *   - 但必须**显式可辨** —— 统一前缀 + 错误码,不让模型把「被拒」读成「成功但没内容」。
 * 真正的编程错误会原样出现在文本里,不会静默。
 * 唯一的例外是 `signal.aborted`:对齐 SDK 内置工具的做法(read.js 同样 reject
 * `"Operation aborted"`),不把取消伪装成一次失败的调用。
 *
 * ── 已知局限(接线时要知道)────────────────────────────────────────────
 * - **中途取消未接线**:`fs` / `http` 的函数签名不收 `AbortSignal`。桥接层只能在
 *   调用前后各查一次 `signal.aborted`;一次正在进行的 30s HTTP 拉取无法被打断。
 *   真要可中断,得先改 `src/server/tools/{fs,http}.ts` 的签名(独立批次)。
 * - **只有内置那 8 个 + 这 6 个**。SDK 还支持 extension 侧注册工具,本模块不涉及。
 */
import { Type, type TSchema } from "typebox";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolRegistry } from "../tools/registry.js";
import type { ListEntry, ReadResult, StatResult, WriteResult } from "../tools/fs.js";
import type { HttpResult } from "../tools/http.js";
import { log } from "../../shared/log.js";

/**
 * 工具名的 provider 合规正则。OpenAI / Anthropic / DeepSeek 的 function-name
 * schema 一律 `^[a-zA-Z0-9_-]{1,64}$` —— **点号会被拒收**,这是 LLM 侧名字不能
 * 直接沿用 `fs.readFile` 的硬原因。测试对本文件里每个名字做断言。
 */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

/** module-level type guard:识别 sandbox / net sandbox 抛的结构化错误(取其 code)。 */
function hasErrorCode(e: unknown): e is { code: string } {
  return typeof e === "object" && e !== null && "code" in e && typeof (e as { code: unknown }).code === "string";
}

function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 把 registry 返回值渲染成给模型看的文本;details 保留结构化副本供 UI/日志。 */
interface Rendered {
  text: string;
  details: unknown;
}

/**
 * 工具自身失败 → 统一失败结果。**只有 registry 抛出的错走这里**;
 * 取消(signal.aborted)在 execute 里显式 reject,不进本函数 ——
 * 两者语义不同,混起来会把「用户打断」伪装成「工具报错」。
 */
function failResult(tool: string, e: unknown) {
  const f = failure(tool, e);
  return { content: [{ type: "text" as const, text: f.text }], details: f.details };
}

/**
 * 统一的失败渲染。前缀固定 `[工具失败]`,带上工具名与错误码 —— 模型必须能一眼
 * 区分「工具报错了」和「工具成功但返回空」。
 */
function failure(tool: string, e: unknown): Rendered {
  const code = hasErrorCode(e) ? ` (${e.code})` : "";
  return {
    text: `[工具失败] ${tool}${code}: ${errMessage(e)}\n这是一次被拒绝或未成功的调用 —— 调整参数后重试,不要当成成功结果继续推理。`,
    details: { error: errMessage(e), code: hasErrorCode(e) ? e.code : null },
  };
}

/** 「取消」不是失败反馈,是控制流 —— 与 SDK 内置工具一致,走 reject。 */
function assertNotAborted(signal: AbortSignal | undefined, tool: string): void {
  if (signal?.aborted) throw new Error(`${tool} aborted`);
}

function renderRead(r: ReadResult, path: string): Rendered {
  // sandbox 侧已按 policy.maxBytes 截断,这里不再二次加工(避免两处上限打架)。
  return { text: r.content, details: { path, mtimeMs: r.mtimeMs, chars: r.content.length } };
}

function renderWrite(r: WriteResult, path: string): Rendered {
  return {
    text: `已写入 ${path}(${r.bytesWritten} 字节,mtimeMs=${r.mtimeMs})`,
    details: { path, ...r },
  };
}

function renderList(entries: ListEntry[], path: string): Rendered {
  if (entries.length === 0) return { text: `目录为空:${path}`, details: { path, entries } };
  const lines = entries.map((e) => {
    const size = e.size !== undefined ? ` ${e.size}B` : "";
    const mtime = e.mtimeMs !== undefined ? ` mtimeMs=${e.mtimeMs}` : "";
    return `${e.kind}${size}${mtime}\t${e.name}`;
  });
  return {
    text: `${path} 共 ${entries.length} 项:\n${lines.join("\n")}`,
    details: { path, count: entries.length, entries },
  };
}

function renderStat(r: StatResult, path: string): Rendered {
  return { text: `${path}: kind=${r.kind} size=${r.size} mtimeMs=${r.mtimeMs}`, details: { path, ...r } };
}

function renderHttp(r: HttpResult): Rendered {
  const trunc = r.bodyTruncated ? "\n[响应体已按 sandbox 上限截断]" : "";
  return {
    text: `HTTP ${r.status}${trunc}\n\n${r.body}`,
    details: { status: r.status, bodyTruncated: r.bodyTruncated, headers: r.headers },
  };
}

/**
 * 桥接清单的**名字面**。`as const` 是刻意的:tools.ts 要用它拼出 `ToolName` 闭合
 * 联合(授权面必须是闭合的,不能是运行时才确定的)。
 *
 * LLM 侧名字 = 模型看到并调用的名字;registry 内部名(带点)见 BRIDGED_TOOLS。
 * 两者**故意不同**,理由见文件头。
 */
export const BRIDGED_TOOL_NAMES = [
  "canvas_read",
  "canvas_list",
  "canvas_stat",
  "canvas_write",
  "net_fetch",
  "net_post",
] as const;
export type BridgedToolName = (typeof BRIDGED_TOOL_NAMES)[number];

/** LLM 侧名 ↔ ToolRegistry 内部名 ↔ 风险等级。 */
export const BRIDGED_TOOLS: ReadonlyArray<{
  llmName: BridgedToolName;
  registryName: string;
  risk: "readonly" | "mutating" | "exec";
}> = [
  { llmName: "canvas_read", registryName: "fs.readFile", risk: "readonly" },
  { llmName: "canvas_list", registryName: "fs.listDir", risk: "readonly" },
  { llmName: "canvas_stat", registryName: "fs.stat", risk: "readonly" },
  { llmName: "canvas_write", registryName: "fs.writeFile", risk: "mutating" },
  { llmName: "net_fetch", registryName: "http.fetch", risk: "exec" },
  { llmName: "net_post", registryName: "http.postJson", risk: "exec" },
];

/* ── 参数 schema(typebox v1)─────────────────────────────────────────────
 * 刻意**不复刻** registry 的宽松校验:那层的 ToolFn 接 `unknown`、由调用方负责
 * 校验;桥到 LLM 侧反而要把约束前置到 schema —— 让模型在生成参数时就被 schema
 * 挡住,比在 execute 里抛 TypeError 更省一轮往返。 */

const pathProp = Type.String({ description: "路径(相对 ~/.sansheng/workspace 或 canvas 根,或绝对路径);越出允许根会被 SandboxError 拒绝" });
const headersProp = Type.Optional(
  Type.Record(Type.String(), Type.String(), { description: "请求头" }),
);

/**
 * 把 registry 的 6 个注册项包成 SDK ToolDefinition。
 *
 * 返回值直接进 `createAgentSession({ customTools })`;**不要**在这里按 allowlist
 * 过滤 —— SDK 的 `isAllowedTool` 会用 harness 的 `allowed` 名单统一过滤,
 * 在此重复实现一遍策略只会产生两个真相源。
 */
export function buildBridgedTools(registry: ToolRegistry): ToolDefinition[] {
  return [
    defineTool({
      name: "canvas_read",
      label: "读 canvas 文件",
      description:
        "读 ~/.sansheng/ 下 sandbox 允许根(workspace / canvas)内的文件内容。与内置 read 不同:内置 read 沿会话工作目录(cwd)走,本工具只碰 sansheng 自己的允许根。单文件上限 30 KiB。不跟随 symlink。",
      promptSnippet: "canvas_read(path, encoding?) — 读 sansheng sandbox 允许根内的文件",
      parameters: Type.Object({
        path: pathProp,
        encoding: Type.Optional(
          Type.Union([Type.Literal("utf8"), Type.Literal("base64")], {
            description: "默认 utf8;二进制内容用 base64",
          }),
        ),
      }),
      executionMode: "parallel",
      async execute(_id, { path, encoding }, signal) {
        // 取消检查**必须在 try 之外**:取消是控制流,不是失败反馈 ——
        // 放进 try 会被下面的 catch 吞掉,渲染成 [工具失败],等于把一次
        // 用户主动打断伪装成工具报错(与 SDK 内置 read 的 reject 语义相悖)。
        assertNotAborted(signal, "canvas_read");
        let r: ReadResult;
        try {
          r = (await registry.invoke("fs.readFile", {
            path,
            ...(encoding !== undefined ? { encoding } : {}),
          })) as ReadResult;
        } catch (e) {
          return failResult("canvas_read", e);
        }
        assertNotAborted(signal, "canvas_read");
        const out = renderRead(r, path);
        return { content: [{ type: "text" as const, text: out.text }], details: out.details };
      },
    }),

    defineTool({
      name: "canvas_list",
      label: "列 canvas 目录",
      description: "列出 sansheng sandbox 允许根内的目录条目。默认隐藏 .dotfile。",
      promptSnippet: "canvas_list(path, includeHidden?, maxEntries?) — 列 sandbox 允许根内的目录",
      parameters: Type.Object({
        path: pathProp,
        includeHidden: Type.Optional(Type.Boolean({ description: "默认 false(隐藏 .dotfile)" })),
        maxEntries: Type.Optional(Type.Number({ description: "最多返回条目数" })),
      }),
      executionMode: "parallel",
      async execute(_id, { path, includeHidden, maxEntries }, signal) {
        assertNotAborted(signal, "canvas_list");
        let entries: ListEntry[];
        try {
          entries = (await registry.invoke("fs.listDir", {
            path,
            ...(includeHidden !== undefined ? { includeHidden } : {}),
            ...(maxEntries !== undefined ? { maxEntries } : {}),
          })) as ListEntry[];
        } catch (e) {
          return failResult("canvas_list", e);
        }
        assertNotAborted(signal, "canvas_list");
        const r = renderList(entries, path);
        return { content: [{ type: "text" as const, text: r.text }], details: r.details };
      },
    }),

    defineTool({
      name: "canvas_stat",
      label: "看 canvas 文件属性",
      description: "取 sandbox 允许根内某路径的 kind(file/dir/symlink/other)、size、mtimeMs。",
      promptSnippet: "canvas_stat(path) — 取 sandbox 允许根内的文件属性",
      parameters: Type.Object({ path: pathProp }),
      executionMode: "parallel",
      async execute(_id, { path }, signal) {
        assertNotAborted(signal, "canvas_stat");
        let st: StatResult;
        try {
          st = (await registry.invoke("fs.stat", { path })) as StatResult;
        } catch (e) {
          return failResult("canvas_stat", e);
        }
        assertNotAborted(signal, "canvas_stat");
        const r = renderStat(st, path);
        return { content: [{ type: "text" as const, text: r.text }], details: r.details };
      },
    }),

    defineTool({
      name: "canvas_write",
      label: "写 canvas 文件",
      description:
        "写 ~/.sansheng/ sandbox 允许根内的文件(原子写)。**默认不在任何角色的架构上界内** —— 启用它是一次显式的架构决策(改 tools.ts 的 ROLE_CEILING),不是改集合文件。",
      promptSnippet: "canvas_write(path, content, createDirs?) — 写 sandbox 允许根内的文件(需架构上界放行)",
      parameters: Type.Object({
        path: pathProp,
        content: Type.String({ description: "文件内容(utf-8)" }),
        createDirs: Type.Optional(Type.Boolean({ description: "父目录不存在时递归创建;默认 false" })),
      }),
      executionMode: "sequential",
      async execute(_id, { path, content, createDirs }, signal) {
        assertNotAborted(signal, "canvas_write");
        let wr: WriteResult;
        try {
          wr = (await registry.invoke("fs.writeFile", {
            path,
            content,
            ...(createDirs !== undefined ? { createDirs } : {}),
          })) as WriteResult;
        } catch (e) {
          return failResult("canvas_write", e);
        }
        assertNotAborted(signal, "canvas_write");
        const r = renderWrite(wr, path);
        return { content: [{ type: "text" as const, text: r.text }], details: r.details };
      },
    }),

    defineTool({
      name: "net_fetch",
      label: "HTTP GET",
      description:
        "对 allowlist 内公网 URL 发 GET/HEAD。默认 allowlist 为空(全部拒绝);端口限 80/443/8080/8443,private IP 全拒。**不在任何角色的架构上界内**。",
      promptSnippet: "net_fetch(url, method?, headers?, maxBytes?, timeoutMs?) — allowlist 内公网 GET/HEAD(需架构上界放行)",
      parameters: Type.Object({
        url: Type.String({ description: "目标 URL(必须命中 ~/.sansheng/net.json 的 allowlist)" }),
        method: Type.Optional(Type.Union([Type.Literal("GET"), Type.Literal("HEAD")])),
        headers: headersProp,
        maxBytes: Type.Optional(Type.Number({ description: "响应体上限;默认 sandbox 5 MiB" })),
        timeoutMs: Type.Optional(Type.Number({ description: "超时;默认 30s" })),
      }),
      executionMode: "parallel",
      async execute(_id, { url, method, headers, maxBytes, timeoutMs }, signal) {
        assertNotAborted(signal, "net_fetch");
        let res: HttpResult;
        try {
          res = (await registry.invoke("http.fetch", {
            url,
            ...(method !== undefined ? { method } : {}),
            ...(headers !== undefined ? { headers } : {}),
            ...(maxBytes !== undefined ? { maxBytes } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          })) as HttpResult;
        } catch (e) {
          return failResult("net_fetch", e);
        }
        assertNotAborted(signal, "net_fetch");
        const r = renderHttp(res);
        return { content: [{ type: "text" as const, text: r.text }], details: r.details };
      },
    }),

    defineTool({
      name: "net_post",
      label: "HTTP POST JSON",
      description:
        "向 allowlist 内公网 URL POST JSON。**默认不在任何角色的架构上界内** —— 与 harness 的既有红线「禁止外发邮件」直接冲突,启用需要显式的架构决策。",
      promptSnippet: "net_post(url, body, headers?, maxBytes?, timeoutMs?) — allowlist 内公网 POST(需架构上界放行,且与既有红线冲突)",
      parameters: Type.Object({
        url: Type.String({ description: "目标 URL(必须命中 ~/.sansheng/net.json 的 allowlist)" }),
        body: Type.Unknown({ description: "JSON 序列化后的请求体" }),
        headers: headersProp,
        maxBytes: Type.Optional(Type.Number({ description: "响应体上限;默认 sandbox 5 MiB" })),
        timeoutMs: Type.Optional(Type.Number({ description: "超时;默认 30s" })),
      }),
      executionMode: "sequential",
      async execute(_id, { url, body, headers, maxBytes, timeoutMs }, signal) {
        assertNotAborted(signal, "net_post");
        let res: HttpResult;
        try {
          res = (await registry.invoke("http.postJson", {
            url,
            body,
            ...(headers !== undefined ? { headers } : {}),
            ...(maxBytes !== undefined ? { maxBytes } : {}),
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
          })) as HttpResult;
        } catch (e) {
          return failResult("net_post", e);
        }
        assertNotAborted(signal, "net_post");
        const r = renderHttp(res);
        return { content: [{ type: "text" as const, text: r.text }], details: r.details };
      },
    }),
  ];
}

/**
 * 桥接工厂:建 registry(读 `~/.sansheng/sandbox.json` + `~/.sansheng/net.json`)
 * 并一次性包出全部 6 个 ToolDefinition。
 *
 * 失败(两个 policy 文件任一损坏)**不抛**:返回空数组 + warn。理由与
 * harness/tools.ts 的 fail-closed 同源但方向相反 —— 这里丢的是「额外能力」,
 * 不是「授权」;让一个配错的 sandbox.json 把整个 server 拉起来不划算,
 * 而把授权面静默放宽才是事故。agent 仍然保有 SDK 内置工具。
 */
export async function createBridgedTools(): Promise<ToolDefinition[]> {
  try {
    const { createToolRegistry } = await import("../tools/integration.js");
    const registry = await createToolRegistry();
    return buildBridgedTools(registry);
  } catch (err) {
    log.warn(
      `harness: 工具桥接失败(policy 文件或 registry 构造出错),本轮只暴露 SDK 内置工具: ${errMessage(err)}`,
    );
    return [];
  }
}

/** 测试用:确认 schema 非空(typebox 对象)—— 挡住「忘了写 parameters」的退化。 */
export function hasUsableParameters(t: ToolDefinition): boolean {
  return t.parameters !== undefined && typeof t.parameters === "object" && t.parameters !== null;
}

export type { TSchema };
