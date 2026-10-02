/**
 * 截断回归(2026-10-02 真实事故 conv_muqsidb0_wgru / todo-2)。
 *
 * 事故链(全部由 ~/.sansheng/sansheng.db 的 artifacts_json 复原):
 *   1. Executor 被要求产出覆盖 ASR/LLM/TTS/VAD/端侧五大技术栈的调研报告;
 *   2. ws.ts makeLlmCall 调 completeSimple 未传 maxTokens、且只判 stopReason==="error",
 *      模型撞输出上限后 stopReason==="length" 被当成**成功**,半截 JSON 原样返回;
 *   3. parseOutcome 严格 JSON.parse 失败 → 返回 null;
 *   4. handleParseFailure → todo 标 failed;
 *   5. Orchestrator.cascadeFailDependents → todo-4/5/6 全部 cascade failed;
 *   → 6 个 todo 里 todo-1/todo-3 已产出 evidence(ev-yufc5E-MiE / ev-jJ9hnLRFlE),
 *     但所有综合步骤被带走,用户最终什么都没拿到。
 *
 * 本文件锁死修复后的行为:半截输出必须被救回成 evidence,todo 必须 resolved。
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/storage/migrations.js";
import { Storage } from "../../src/server/storage/index.js";
import { Executor, type ExecutorLlmCall } from "../../src/server/agents/executor.js";
import { artifactBus, makeArtifact } from "../../src/server/bus/index.js";
import {
  upsertArtifact,
  getArtifact,
  listArtifacts,
} from "../../src/server/storage/repo/blackboards.js";
import type { BlackboardArtifact } from "../../shared/types/blackboard.js";

/** 事故现场:从 exec-err-GfSsLFi0 的 note body 逐字还原的截断输出 */
const REAL_TRUNCATED_OUTPUT =
  '{"outcome":"evidence","evidence":{"title":"百外语音机器人模型层调研：ASR / LLM / TTS / VAD / 端侧方案","body":"# 模型层技术调研报告\\n\\n## 一、流式 ASR（自动语音识别）\\n\\n### 1. Whisper 系列（OpenAI）\\n- **Whisper (original)**：MIT，依赖 ffmpeg\\n- **whisper.cpp / whisper-stream**：Mac/iOS/Android/Raspberry';

function makeStorage() {
  const db = new Database(":memory:");
  runMigrations(db);
  return { db, storage: new Storage(db) };
}

function makeTodo(convId: string, overrides: Partial<BlackboardArtifact> = {}): BlackboardArtifact {
  return makeArtifact({
    kind: "todo",
    title: "调研模型层：ASR / LLM / TTS / VAD / 打断 / 端侧方案",
    body: "调研语音机器人模型栈……",
    scope: "conversation",
    conversationId: convId,
    author: "planner",
    status: "open",
    dependsOn: [],
    ...overrides,
  });
}

describe("agents/executor · 截断输出不再毁掉整轮 plan", () => {
  let storage: Storage;
  let db: Database.Database;

  beforeEach(() => {
    const s = makeStorage();
    storage = s.storage;
    db = s.db;
  });

  it("真实事故样本:半截 JSON 被救回,evidence 落库 + todo resolved", async () => {
    const todo = makeTodo("conv-trunc-real");
    upsertArtifact(db, todo);

    const llm: ExecutorLlmCall = async () => REAL_TRUNCATED_OUTPUT;
    const exec = new Executor({ storage, bus: artifactBus, llmCall: llm, now: () => 5000 });

    const result = await exec.execute(todo);

    // 修复前:outcome === "failed",todo 标 failed → cascade 带走全部下游
    expect(result.outcome).toBe("evidence");

    const refreshed = getArtifact(db, todo.id);
    expect(refreshed?.status).toBe("resolved");

    const all = listArtifacts(db, { scope: "conversation", conversationId: todo.conversationId });
    const evs = all.filter((a) => a.kind === "evidence");
    expect(evs.length).toBe(1);
    // title 未被截断,原样救回
    expect(evs[0]?.title).toBe("百外语音机器人模型层调研：ASR / LLM / TTS / VAD / 端侧方案");
    // body 写到哪儿保留到哪儿 —— 已产出的内容不丢弃
    expect(evs[0]?.body).toContain("# 模型层技术调研报告");
    expect(evs[0]?.body).toContain("流式 ASR");
  });

  it("救回的产物打 truncated 标记 —— 下游知道内容不完整", async () => {
    const todo = makeTodo("conv-trunc-flag");
    upsertArtifact(db, todo);

    const llm: ExecutorLlmCall = async () => REAL_TRUNCATED_OUTPUT;
    const exec = new Executor({ storage, bus: artifactBus, llmCall: llm, now: () => 5000 });
    await exec.execute(todo);

    const all = listArtifacts(db, { scope: "conversation", conversationId: todo.conversationId });
    const ev = all.find((a) => a.kind === "evidence");
    expect(ev?.metadata?.truncated).toBe(true);
  });

  it("完整 JSON 不打 truncated 标记(不误伤正常路径)", async () => {
    const todo = makeTodo("conv-trunc-clean");
    upsertArtifact(db, todo);

    const llm: ExecutorLlmCall = async () =>
      JSON.stringify({ outcome: "evidence", evidence: { title: "t", body: "b" } });
    const exec = new Executor({ storage, bus: artifactBus, llmCall: llm, now: () => 5000 });
    await exec.execute(todo);

    const all = listArtifacts(db, { scope: "conversation", conversationId: todo.conversationId });
    const ev = all.find((a) => a.kind === "evidence");
    expect(ev?.metadata?.truncated).toBeUndefined();
  });

  it("真·垃圾输出(无任何可救前缀)仍然 failed —— 不凭空造产物", async () => {
    const todo = makeTodo("conv-trunc-junk");
    upsertArtifact(db, todo);

    const llm: ExecutorLlmCall = async () => "抱歉,我无法完成这个任务。";
    const exec = new Executor({ storage, bus: artifactBus, llmCall: llm, now: () => 5000 });

    const result = await exec.execute(todo);
    expect(result.outcome).toBe("failed");
    expect(getArtifact(db, todo.id)?.status).toBe("failed");
  });

  it("hypothesis 分支同样受益于截断救回", async () => {
    const todo = makeTodo("conv-trunc-hyp");
    upsertArtifact(db, todo);

    const llm: ExecutorLlmCall = async () =>
      '{"outcome":"hypothesis","hypothesis":{"title":"需要确认选型","body":"Whisper 与 Parafor';
    const exec = new Executor({ storage, bus: artifactBus, llmCall: llm, now: () => 5000 });

    const result = await exec.execute(todo);
    expect(result.outcome).toBe("hypothesis");

    const all = listArtifacts(db, { scope: "conversation", conversationId: todo.conversationId });
    const hyp = all.find((a) => a.kind === "hypothesis");
    expect(hyp?.title).toBe("需要确认选型");
    expect(hyp?.metadata?.truncated).toBe(true);
  });
});
