/**
 * 批次 7-D · `outcome` 判别式缺省时按 payload 形状反推。
 *
 * 真实事故(conv_muqsidb0_wgru 第二次跑,todo-1,note `exec-err-e2hIDyhy`):
 * 模型输出 `{"evidence":{"title":"…","body":"## 结论先行…"}}` —— JSON 合法、
 * title 完整、正文充实,**唯独没写 `outcome` 字段**。旧实现只认
 * `obj.outcome === "evidence"`,把一份完全可用的 evidence 当 parse 失败丢掉
 * → todo failed → 级联带走其余 5 个 todo。
 *
 * 样本取自 note `exec-err-e2hIDyhy` 的 body 前 500 字符(逐字)。
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

/** 事故现场:模型交了完整 evidence,只是没写 outcome 包装 */
const REAL_MISSING_OUTCOME =
  '{"evidence":{"title":"百万级外呼 / 百外用户场景需求与对标基线","body":"## 结论先行\\n百万级外呼 / 百外坐席规模语音机器人场景的硬性基线已可勾勒:并发 100-1000 路起步、首响 TTFB ≤800ms、端到端 P50 ≤1.5s / P95 ≤2.5s、打断响应 ≤300ms、可用性 ≥99.95%。';

function makeStorage() {
  const db = new Database(":memory:");
  runMigrations(db);
  return { db, storage: new Storage(db) };
}

function makeTodo(convId: string): BlackboardArtifact {
  return makeArtifact({
    kind: "todo",
    title: "梳理百万级外呼/百外用户场景需求与对标基线",
    body: "调研场景与对标",
    scope: "conversation",
    conversationId: convId,
    author: "planner",
    status: "open",
    dependsOn: [],
  });
}

describe("批次 7-D · 缺 outcome 时按 payload 形状反推", () => {
  let db: Database.Database;
  let storage: Storage;

  beforeEach(() => {
    const s = makeStorage();
    db = s.db;
    storage = s.storage;
  });

  it("真实事故样本:只有 {evidence:{...}} → evidence 落库 + todo resolved", async () => {
    const todo = makeTodo("conv-7d-real");
    upsertArtifact(db, todo);

    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: (async () => REAL_MISSING_OUTCOME) as ExecutorLlmCall,
      now: () => 5000,
    });

    const result = await exec.execute(todo);
    // 修复前:outcome === "failed",todo 标 failed → 级联带走 5 个下游
    expect(result.outcome).toBe("evidence");
    expect(getArtifact(db, todo.id)?.status).toBe("resolved");

    const ev = listArtifacts(db, {
      scope: "conversation",
      conversationId: todo.conversationId,
    }).find((a) => a.kind === "evidence");
    expect(ev?.title).toBe("百万级外呼 / 百外用户场景需求与对标基线");
    expect(ev?.body).toContain("结论先行");
  });

  it("缺 outcome 且同时被截断 → 仍能救回(两个 bug 叠加)", async () => {
    const todo = makeTodo("conv-7d-both");
    upsertArtifact(db, todo);

    // 缺 outcome wrapper,且正文写到一半被 maxTokens 截断
    const both =
      '{"evidence":{"title":"百万级基线","body":"## 结论先行\\n并发 100-1000 路起步、首响 TTFB ≤800ms、端到端 P50 ≤1.5s、打断响应 ≤3';
    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: (async () => both) as ExecutorLlmCall,
      now: () => 5000,
    });

    const result = await exec.execute(todo);
    expect(result.outcome).toBe("evidence");
    const ev = listArtifacts(db, {
      scope: "conversation",
      conversationId: todo.conversationId,
    }).find((a) => a.kind === "evidence");
    expect(ev?.body).toContain("结论先行");
    // 截断仍要留痕
    expect(ev?.metadata?.truncated).toBe(true);
  });

  it("缺 outcome 的 {hypothesis:{...}} → hypothesis", async () => {
    const todo = makeTodo("conv-7d-hyp");
    upsertArtifact(db, todo);
    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: (async () => '{"hypothesis":{"title":"需要你拍板选型","body":"A 还是 B"}}') as ExecutorLlmCall,
      now: () => 5000,
    });
    const result = await exec.execute(todo);
    expect(result.outcome).toBe("hypothesis");
    const hyp = listArtifacts(db, {
      scope: "conversation",
      conversationId: todo.conversationId,
    }).find((a) => a.kind === "hypothesis");
    expect(hyp?.title).toBe("需要你拍板选型");
  });

  it("缺 outcome 的 {note:{...}} → failed(显式失败语义不丢)", async () => {
    const todo = makeTodo("conv-7d-note");
    upsertArtifact(db, todo);
    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: (async () => '{"note":{"title":"数据源不可达","body":"内网接口 403"}}') as ExecutorLlmCall,
      now: () => 5000,
    });
    const result = await exec.execute(todo);
    expect(result.outcome).toBe("failed");
    expect(getArtifact(db, todo.id)?.status).toBe("failed");
  });

  it("显式 outcome 优先于形状:说 failed 就算有 evidence 也认 failed", async () => {
    const todo = makeTodo("conv-7d-explicit");
    upsertArtifact(db, todo);
    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: (async () =>
        '{"outcome":"failed","evidence":{"title":"看似有货但明说失败","body":"x"},"note":{"title":"真失败","body":"y"}}') as ExecutorLlmCall,
      now: () => 5000,
    });
    const result = await exec.execute(todo);
    expect(result.outcome).toBe("failed");
  });

  it("非法 outcome 取值不猜 → parse 失败(不静默纠正,免得掩盖提示词问题)", async () => {
    const todo = makeTodo("conv-7d-bogus");
    upsertArtifact(db, todo);
    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: (async () => '{"outcome":"success","evidence":{"title":"t","body":"b"}}') as ExecutorLlmCall,
      now: () => 5000,
    });
    const result = await exec.execute(todo);
    expect(result.outcome).toBe("failed");
    expect(getArtifact(db, todo.id)?.status).toBe("failed");
  });

  // ── 2026-10-02 真实事故 conv_muqwgghs_4q0u / todo-5(note `exec-err-boBJpM8r`)──
  // 模型交出 `{"outcome":"","status":"in_progress","evidence":{…}}`:evidence 完整,
  // outcome **留了空串**。旧规则把空串当「非法取值」→ 直接 return null,
  // 批次 7-D 的形状推断根本没机会跑,一份完好的产物被烧掉。
  // 语义:`""` 不携带任何信息,等同「没写」;真正该拒绝的是 "success" 这种**说错话**的取值。
  it("outcome 是空串(模型声明了键但没填)→ 按形状推断救回,不判非法", async () => {
    const todo = makeTodo("conv-empty-outcome");
    upsertArtifact(db, todo);

    const raw =
      '{"outcome":"","status":"in_progress","evidence":{"title":"催收外呼语音机器人智能化能力:自研 vs 厂商对照",' +
      '"body":"# 智能化能力对照(自研 vs 厂商)\\n\\n## 结论先行\\n自研方案的核心差异化在于 **LLM-native 的对话引擎**。"}}';
    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: (async () => raw) as ExecutorLlmCall,
      now: () => 5000,
    });

    const result = await exec.execute(todo);
    expect(result.outcome).toBe("evidence");
    expect(getArtifact(db, todo.id)?.status).toBe("resolved");
    const ev = listArtifacts(db, {
      scope: "conversation",
      conversationId: todo.conversationId,
    }).find((a) => a.kind === "evidence");
    expect(ev?.title).toBe("催收外呼语音机器人智能化能力:自研 vs 厂商对照");
    expect(ev?.body).toContain("结论先行");
  });

  it("outcome 空串 + 只有 hypothesis 载荷 → 同样走形状推断", async () => {
    const todo = makeTodo("conv-empty-outcome-hyp");
    upsertArtifact(db, todo);
    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: (async () => '{"outcome":"","hypothesis":{"title":"需要用户拍板","body":"…","callbackReason":"judgment"}}') as ExecutorLlmCall,
      now: () => 5000,
    });
    const result = await exec.execute(todo);
    expect(result.outcome).toBe("hypothesis");
    expect(getArtifact(db, todo.id)?.status).toBe("waiting_for_decision");
  });

  it("outcome 空串且三个 payload 键都没有 → 仍 parse 失败(不凭空造产物)", async () => {
    const todo = makeTodo("conv-empty-outcome-nothing");
    upsertArtifact(db, todo);
    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: (async () => '{"outcome":"","status":"in_progress"}') as ExecutorLlmCall,
      now: () => 5000,
    });
    const result = await exec.execute(todo);
    expect(result.outcome).toBe("failed");
  });

  it("三个 payload 键都没有 → parse 失败(不凭空造产物)", async () => {
    const todo = makeTodo("conv-7d-empty");
    upsertArtifact(db, todo);
    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: (async () => '{"result":"looks done","details":"…"}') as ExecutorLlmCall,
      now: () => 5000,
    });
    const result = await exec.execute(todo);
    expect(result.outcome).toBe("failed");
  });

  it("完整规范输出不受影响(repaired 不置位、不打 truncated)", async () => {
    const todo = makeTodo("conv-7d-canonical");
    upsertArtifact(db, todo);
    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: (async () =>
        JSON.stringify({ outcome: "evidence", evidence: { title: "t", body: "b" } })) as ExecutorLlmCall,
      now: () => 5000,
    });
    const result = await exec.execute(todo);
    expect(result.outcome).toBe("evidence");
    const ev = listArtifacts(db, {
      scope: "conversation",
      conversationId: todo.conversationId,
    }).find((a) => a.kind === "evidence");
    expect(ev?.metadata?.truncated).toBeUndefined();
  });
});
