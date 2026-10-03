/**
 * 批次 7-H · 原生工具 + 最小工具循环
 *
 * 7-G 之前系统最实质的空洞:planner / executor 走 `completeSimple` **单轮补全**,
 * harness 就算给它们配了工具也**没有执行点**。7-H 补上两件事:
 *   ① `nativeTools.ts` —— Blackboard 与记忆的读取入口(SDK 工具完全够不着)
 *   ② `toolLoop.ts` —— 在单轮调用外面包一层循环,`ExecutorLlmCall` /
 *      `PlannerLlmCall` 签名**一个字节都不改**(jev 裁决 confidence 1.00)
 *
 * 本文件守:
 *   1. **循环语义**:无工具时等价单轮;工具轮只在认到 `tool_call` 时发生;
 *      轮数上限不静默截断;工具名越权要看得见。
 *   2. **原生工具真的读到了数据**:对真 Storage 建种子工件与记忆片段,
 *      断言 board_list / board_read / memory_search 返回的是**真实内容**,
 *      不是「调用成功」的空壳。
 *   3. **授权过滤在被授权方内部**:Executor 拿到工具全集 + 白名单时,
 *      白名单外的工具**不会**进入循环(与 tools.ts 的 ceiling 分层同思路)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runWithTools, renderToolProtocol, type LoopTool } from "../../src/server/agents/toolLoop.js";
import { buildNativeTools, buildNativeLoopTools } from "../../src/server/harness/nativeTools.js";
import { Storage } from "../../src/server/storage/db.js";
import { upsertArtifact, listArtifacts } from "../../src/server/storage/repo/blackboards.js";
import { upsertConversation } from "../../src/server/storage/repo/conversations.js";
import { insertFragment } from "../../src/server/storage/repo/fragments.js";
import { makeArtifact } from "../../src/server/bus/index.js";
import { Executor } from "../../src/server/agents/executor.js";
import { roleToolCeiling } from "../../src/server/harness/tools.js";

let dir: string;
let storage: Storage;

const CONV = "conv-7h";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sansheng-7h-"));
  storage = new Storage(join(dir, "sansheng.db"));
  // 工件表对 conversation 有外键,先建会话行
  upsertConversation(storage.db, { id: CONV, title: "7-H 测试会话" });
  upsertArtifact(
    storage.db,
    makeArtifact({
      id: "todo-1",
      scope: "conversation",
      conversationId: CONV,
      kind: "todo",
      title: "调研 ASR 方案",
      body: "产出三个技术栈的对比",
      author: "planner",
      status: "open",
    }),
  );
  upsertArtifact(
    storage.db,
    makeArtifact({
      id: "ev-1",
      scope: "conversation",
      conversationId: CONV,
      kind: "evidence",
      title: "已有结论: whisper.cpp 延迟最低",
      body: "实测 10s 音频 1.2s 转写,内存 80MB。来源:项目内 benchmark 脚本。",
      author: "executor",
      status: "resolved",
    }),
  );
  insertFragment(storage.db, {
    id: "frag-1",
    kind: "preference",
    content: "用户喜欢简洁的中文回答,不要长篇大论",
    sourceConversationId: CONV,
    sourceMessageId: null,
    importance: 0.9,
    decayFactor: 1,
    accessCount: 2,
    lastAccessedAt: null,
    createdAt: Date.now(),
    metadata: null,
  });
});

afterEach(() => {
  try {
    storage?.close();
  } catch {
    /* ignore */
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** 收集 exec 的返回文本(SDK 路径的测试用)。 */
async function callNative(name: string, args: Record<string, unknown>, s: Storage): Promise<string> {
  const tools = buildNativeTools(s);
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool missing: ${name}`);
  const r = await t.execute("id", args, undefined, undefined, undefined as never);
  const first = r.content[0];
  return first && first.type === "text" ? (first.text ?? "") : "";
}

describe("7-H 原生工具 · 真的读到了 Blackboard 与记忆", () => {
  it("board_list 列出本会话工件,并按 kind 过滤", async () => {
    const all = await callNative("board_list", { conversationId: CONV }, storage);
    expect(all).toContain("todo-1");
    expect(all).toContain("ev-1");
    expect(all).toContain("调研 ASR 方案");

    const onlyEvidence = await callNative("board_list", { conversationId: CONV, kind: "evidence" }, storage);
    expect(onlyEvidence).toContain("ev-1");
    expect(onlyEvidence).not.toContain("todo-1");
  });

  it("board_read 返回工件正文(不是只回标题)", async () => {
    const text = await callNative("board_read", { artifactId: "ev-1" }, storage);
    expect(text).toContain("whisper.cpp");
    expect(text).toContain("1.2s 转写");
  });

  it("board_read 对不存在的 id 明确失败,不返回空壳", async () => {
    const text = await callNative("board_read", { artifactId: "does-not-exist" }, storage);
    expect(text.startsWith("[工具失败]")).toBe(true);
  });

  it("memory_search 命中偏好片段", async () => {
    const text = await callNative("memory_search", { query: "简洁 中文 回答" }, storage);
    expect(text).toContain("用户喜欢简洁的中文回答");
    expect(text).toContain("preference");
  });

  it("缺参数时给可读错误而不是抛异常", async () => {
    expect(await callNative("board_list", {}, storage)).toContain("缺少 conversationId");
    expect(await callNative("board_read", {}, storage)).toContain("缺少 artifactId");
    expect(await callNative("memory_search", {}, storage)).toContain("缺少 query");
  });

  it("storage 缺失 → 返回空工具(而不是注册一调用就炸的工具)", () => {
    expect(buildNativeTools(undefined)).toEqual([]);
    expect(buildNativeLoopTools(undefined)).toEqual([]);
    expect(buildNativeTools(storage)).toHaveLength(3);
    expect(buildNativeLoopTools(storage)).toHaveLength(3);
  });
});

describe("7-H 工具循环 · 语义", () => {
  const echo = (name: string): LoopTool => ({
    name,
    description: `${name} 测试替身`,
    run: async (a) => `ran ${name} ${JSON.stringify(a)}`,
  });

  it("无工具 → 恰好一次调用,且不注入工具协议段", async () => {
    const llmCall = vi.fn(async () => '{"outcome":"evidence"}');
    const r = await runWithTools({ llmCall, systemPrompt: "SYS", userPrompt: "USR", tools: [] });
    expect(llmCall).toHaveBeenCalledTimes(1);
    expect(llmCall.mock.calls[0]?.[0].systemPrompt).toBe("SYS");
    expect(r.toolTurns).toBe(0);
    expect(r.finalText).toBe('{"outcome":"evidence"}');
  });

  it("有工具 → 协议段只列给定工具,工具轮结果回灌后再收敛", async () => {
    const seen: string[] = [];
    let n = 0;
    const llmCall = vi.fn(async (i: { systemPrompt: string; userPrompt: string }) => {
      seen.push(i.userPrompt);
      n += 1;
      if (n === 1) return '{"tool_call":{"name":"board_list","arguments":{"conversationId":"c"}}}';
      return '{"outcome":"evidence","evidence":{"title":"t","body":"b"}}';
    });
    const r = await runWithTools({
      llmCall,
      systemPrompt: "SYS",
      userPrompt: "USR",
      tools: [echo("board_list"), echo("board_read")],
    });

    expect(llmCall).toHaveBeenCalledTimes(2);
    // 协议段只列给定的那两个
    const sys = llmCall.mock.calls[0]?.[0].systemPrompt ?? "";
    expect(sys.startsWith("SYS")).toBe(true);
    expect(sys).toContain("board_list");
    expect(sys).toContain("board_read");
    expect(sys).not.toContain("net_post");
    // 第二轮上下文带上了工具结果
    expect(seen[1]).toContain("ran board_list");
    expect(r.toolTurns).toBe(1);
    expect(r.finalText).toContain("evidence");
    expect(r.truncated).toBe(false);
    expect(r.calls[0]?.ok).toBe(true);
  });

  it("模型点了白名单外的工具 → 回灌可读错误,不静默忽略", async () => {
    let n = 0;
    const llmCall = vi.fn(async () => {
      n += 1;
      return n === 1
        ? '{"tool_call":{"name":"rm_rf","arguments":{}}}'
        : '{"outcome":"failed"}';
    });
    const r = await runWithTools({ llmCall, systemPrompt: "S", userPrompt: "U", tools: [echo("board_list")] });
    expect(r.calls[0]?.ok).toBe(false);
    expect(llmCall.mock.calls[1]?.[0].userPrompt).toContain("没有名为");
  });

  it("工具抛异常 → 回灌错误继续,不中断整轮", async () => {
    const boom: LoopTool = { name: "boom", description: "会炸", run: async () => { throw new Error("kaboom"); } };
    let n = 0;
    const llmCall = vi.fn(async () => {
      n += 1;
      return n === 1 ? '{"tool_call":{"name":"boom","arguments":{}}}' : '{"outcome":"failed"}';
    });
    const r = await runWithTools({ llmCall, systemPrompt: "S", userPrompt: "U", tools: [boom] });
    expect(r.calls[0]?.ok).toBe(false);
    expect(llmCall.mock.calls[1]?.[0].userPrompt).toContain("kaboom");
    expect(r.finalText).toContain("failed");
  });

  it("轮数用尽 → truncated=true,绝不拿半成品当结论", async () => {
    const llmCall = vi.fn(async () => '{"tool_call":{"name":"board_list","arguments":{}}}');
    const r = await runWithTools({ llmCall, systemPrompt: "S", userPrompt: "U", tools: [echo("board_list")], maxToolTurns: 2 });
    expect(r.truncated).toBe(true);
    // 上限 N → 最多执行 N 次,最后一次认到 tool_call 但不再执行
    expect(llmCall).toHaveBeenCalledTimes(3);
    expect(r.calls).toHaveLength(2);
  });

  it("非 JSON 输出被当作终轮(不误判成工具轮)", async () => {
    const llmCall = vi.fn(async () => "这里就是一段普通回答,没有 JSON");
    const r = await runWithTools({ llmCall, systemPrompt: "S", userPrompt: "U", tools: [echo("x")] });
    expect(r.truncated).toBe(false);
    expect(r.toolTurns).toBe(0);
    expect(r.finalText).toContain("普通回答");
  });

  it("renderToolProtocol 对空工具返回空串(不注入无意义段)", () => {
    expect(renderToolProtocol([], 3)).toBe("");
  });

  // ──────────────────────────────────────────────────────────────────
  // 2026-10-03 真实事故 · 工具轮上下文**每轮只保留上一轮**(conv_murpu3ml_cged /
  // todo-1,note `exec-err-TVj9oQwe`)。
  //
  // transcript 原来是「opts.userPrompt + 上一轮结果」**重新拼**的,再往前的工具轮
  // 全部丢失。探针实测(模型连发 3 次 tool_call):第 3 次调用只看得到第 2 轮。
  // 模型每轮失忆 → 记不住自己查过什么 → 6 轮用尽仍不收敛 → 级联带走 todo-4。
  // 6 轮不是不够,是前 5 轮白跑了。
  // ──────────────────────────────────────────────────────────────────
  it("多轮工具调用:第 3 轮仍能看到第 1 轮(上下文必须累积,不能只留上一轮)", async () => {
    const seen: string[] = [];
    let n = 0;
    const llmCall = vi.fn(async (i: { systemPrompt: string; userPrompt: string }) => {
      seen.push(i.userPrompt);
      n += 1;
      if (n <= 3) return `{"tool_call":{"name":"grep","arguments":{"q":"第${n}次"}}}`;
      return '{"outcome":"evidence","evidence":{"title":"t","body":"b"}}';
    });
    await runWithTools({ llmCall, systemPrompt: "S", userPrompt: "U", tools: [echo("grep")] });

    expect(llmCall).toHaveBeenCalledTimes(4);
    // 修复前:seen[2] 只有「第2次」,seen[3] 只有「第3次」
    expect(seen[2]).toContain("第1次");
    expect(seen[2]).toContain("第2次");
    expect(seen[3]).toContain("第1次");
    expect(seen[3]).toContain("第2次");
    expect(seen[3]).toContain("第3次");
  });

  it("工具失败的那一轮同样进上下文(不能因为失败就被丢掉)", async () => {
    const seen: string[] = [];
    let n = 0;
    const llmCall = vi.fn(async (i: { systemPrompt: string; userPrompt: string }) => {
      seen.push(i.userPrompt);
      n += 1;
      if (n === 1) return '{"tool_call":{"name":"nope","arguments":{}}}';
      if (n === 2) return '{"tool_call":{"name":"grep","arguments":{"q":"x"}}}';
      return '{"outcome":"evidence","evidence":{"title":"t","body":"b"}}';
    });
    const r = await runWithTools({ llmCall, systemPrompt: "S", userPrompt: "U", tools: [echo("grep")] });
    expect(r.calls[0]?.ok).toBe(false);
    // 第 3 次调用里,失败那轮的错误仍在、后面那轮的结果也在
    expect(seen[2]).toContain("没有名为");
    expect(seen[2]).toContain("ran grep");
  });

  it("未收敛 → 失败 note 带上工具调用记录(可取证,不再是一句「未收敛」)", async () => {
    const failing = vi.fn(async () => '{"tool_call":{"name":"board_list","arguments":{"k":"v"}}}');
    const ex = new Executor({
      storage,
      llmCall: failing,
      systemPrompt: "S",
      tools: [echo("board_list")],
      allowedTools: ["board_list"],
    });
    const todo = makeArtifact({
      id: "todo-noconverge", scope: "conversation", conversationId: CONV,
      kind: "todo", title: "调研", body: "y", author: "planner", status: "open",
    });
    upsertArtifact(storage.db, todo);
    const res = await ex.execute(todo);
    expect(res.outcome).toBe("failed");

    const note = listArtifacts(storage.db, { scope: "conversation", conversationId: CONV })
      .find((a) => a.kind === "note");
    expect(note?.body).toContain("未收敛");
    // 取证:调用次数、工具名、参数都要在 note 里
    expect(note?.body).toContain("工具调用记录");
    expect(note?.body).toContain("board_list");
    expect(note?.body).toContain('"k":"v"');
  });
});

describe("7-H Executor · 授权过滤在被授权方内部", () => {
  const tool = (name: string): LoopTool => ({ name, description: name, run: async () => `ran ${name}` });

  it("白名单外的工具不会进入循环(即便调用方把全集都给了)", async () => {
    const llmCall = vi.fn(async () => '{"outcome":"failed","note":{"title":"t","body":"b"}}');
    const ex = new Executor({
      storage,
      llmCall,
      systemPrompt: "S",
      tools: [tool("board_list"), tool("secret_tool")],
      allowedTools: ["board_list"],
    });
    const todo = makeArtifact({
      id: "todo-loop",
      scope: "conversation",
      conversationId: CONV,
      kind: "todo",
      title: "干活",
      body: "做点事",
      author: "planner",
      status: "open",
    });
    upsertArtifact(storage.db, todo);
    await ex.execute(todo);
    // 提示词里只出现白名单内的工具
    const sys = llmCall.mock.calls[0]?.[0].systemPrompt ?? "";
    expect(sys).toContain("board_list");
    expect(sys).not.toContain("secret_tool");
  });

  it("不给 allowedTools → 一个工具都没有(安全默认,不因调用方疏忽而越权)", async () => {
    const llmCall = vi.fn(async () => '{"outcome":"failed","note":{"title":"t","body":"b"}}');
    const ex = new Executor({ storage, llmCall, systemPrompt: "S", tools: [tool("board_list")] });
    const todo = makeArtifact({
      id: "todo-noallow", scope: "conversation", conversationId: CONV,
      kind: "todo", title: "x", body: "y", author: "planner", status: "open",
    });
    upsertArtifact(storage.db, todo);
    await ex.execute(todo);
    expect(llmCall.mock.calls[0]?.[0].systemPrompt).not.toContain("board_list");
  });

  it("执行者的出厂集合恰好等于它的架构上界(含 write/edit/bash)", () => {
    const ceiling = [...roleToolCeiling("executor")];
    expect(ceiling).toContain("write");
    expect(ceiling).toContain("edit");
    expect(ceiling).toContain("bash");
    expect(ceiling).toContain("board_list");
    expect(ceiling).toContain("memory_search");
    // 网络出口仍对执行者关闭
    expect(ceiling).not.toContain("net_post");
    expect(ceiling).not.toContain("net_fetch");
  });
});
