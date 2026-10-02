/**
 * 批次 7-B · harness prompt 接线回归。
 *
 * 修复前的死接线(用户报「沟通员分发任务太简单暴力,没做归类拆解」的直接成因):
 *   - Orchestrator 构造时存了 `this.dataDir`,但**从未用过**;
 *   - spawnPlanner / spawnExecutor 只传 `{ storage }`(以及注入的 llmCall);
 *   - 于是 Planner / Executor 拿到的永远是各自模块里的 6-9 行 stub
 *     (DEFAULT_PLANNER_PROMPT / DEFAULT_EXECUTOR_PROMPT);
 *   - `shared/prompts/planner.md` 那份 91 行、含输出协议 / 字段语义 / 拆解
 *     示例的正经提示词是**死代码**(`loadPlannerPrompt` 全项目无调用方);
 *   - 用户在 ~/.sansheng/harness/system_prompts/ 里编辑的 planner.md 从未被读取。
 *
 * 即 Planner 实际只收到 4 句「你是 Planner,把 intent 拆成 todos」。
 * 本文件锁死:harness 里的提示词必须真的到达 Planner / Executor。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/storage/migrations.js";
import { Storage } from "../../src/server/storage/index.js";
import { Orchestrator } from "../../src/server/agents/orchestrator.js";
import { Planner, type PlannerLlmCall } from "../../src/server/agents/planner.js";
import { Executor, type ExecutorLlmCall } from "../../src/server/agents/executor.js";
import { artifactBus, makeArtifact } from "../../src/server/bus/index.js";
import { ensureHarness, loadHarness } from "../../src/server/harness/loader.js";
import { upsertArtifact, listArtifacts } from "../../src/server/storage/repo/blackboards.js";
import type { BlackboardArtifact } from "../../shared/types/blackboard.js";

const PLANNER_MARKER = "MAGIC-PLANNER-PROMPT-7B";
const EXECUTOR_MARKER = "MAGIC-EXECUTOR-PROMPT-7B";

function makeStorage() {
  const db = new Database(":memory:");
  runMigrations(db);
  return { db, storage: new Storage(db) };
}

function makeDataDirWithPrompts(): string {
  const dir = mkdtempSync(join(tmpdir(), "sansheng-harness-"));
  const sp = join(dir, "harness", "system_prompts");
  mkdirSync(sp, { recursive: true });
  writeFileSync(join(sp, "planner.md"), PLANNER_MARKER, "utf-8");
  writeFileSync(join(sp, "executor.md"), EXECUTOR_MARKER, "utf-8");
  return dir;
}

function makeIntent(convId: string): BlackboardArtifact {
  return makeArtifact({
    kind: "intent",
    title: "调研并产出语音机器人技术方案",
    body: "覆盖模型、Harness、工程架构",
    scope: "conversation",
    conversationId: convId,
    author: "communicator",
    status: "open",
  });
}

describe("批次 7-B · harness prompt 真的到达 Planner / Executor", () => {
  let db: Database.Database;
  let storage: Storage;
  let dataDir: string;

  beforeEach(() => {
    const s = makeStorage();
    db = s.db;
    storage = s.storage;
    dataDir = makeDataDirWithPrompts();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("Planner 收到 harness/system_prompts/planner.md 的内容(而非模块 stub)", async () => {
    const intent = makeIntent("conv-7b-planner");
    upsertArtifact(db, intent);

    const seen: string[] = [];
    const plannerLlmCall: PlannerLlmCall = async (input) => {
      seen.push(input.systemPrompt);
      return JSON.stringify([
        { id: "todo-1", title: "查现状", body: "列出现状", dependsOn: [] },
      ]);
    };

    const orch = new Orchestrator({
      storage,
      dataDir,
      agentDir: join(dataDir, "agent"),
      plannerLlmCall,
      executorLlmCall: (async () =>
        JSON.stringify({ outcome: "evidence", evidence: { title: "e", body: "b" } })) as ExecutorLlmCall,
    });

    await orch.run("conv-7b-planner", intent.title);
    orch.shutdown();

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain(PLANNER_MARKER);
  });

  it("Executor 经由 Orchestrator 收到 harness/system_prompts/executor.md 的内容", async () => {
    const intent = makeIntent("conv-7b-executor");
    upsertArtifact(db, intent);

    const seen: string[] = [];
    const executorLlmCall: ExecutorLlmCall = async (input) => {
      seen.push(input.systemPrompt);
      return JSON.stringify({ outcome: "evidence", evidence: { title: "e", body: "b" } });
    };

    const orch = new Orchestrator({
      storage,
      dataDir,
      agentDir: join(dataDir, "agent"),
      plannerLlmCall: (async () =>
        JSON.stringify([
          { id: "todo-1", title: "查现状", body: "列出现状", dependsOn: [] },
        ])) as PlannerLlmCall,
      executorLlmCall,
    });

    await orch.run("conv-7b-executor", intent.title);
    orch.shutdown();

    // Executor 确实被调度过(否则本测试是空转)
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toContain(EXECUTOR_MARKER);
  });

  it("显式传入 plannerSystemPrompt 优先于 harness 文件", async () => {
    const intent = makeIntent("conv-7b-override");
    upsertArtifact(db, intent);

    const seen: string[] = [];
    const orch = new Orchestrator({
      storage,
      dataDir,
      agentDir: join(dataDir, "agent"),
      plannerSystemPrompt: "EXPLICIT-OVERRIDE",
      plannerLlmCall: (async (input) => {
        seen.push(input.systemPrompt);
        return "[]";
      }) as PlannerLlmCall,
    });

    await orch.run("conv-7b-override", intent.title);
    orch.shutdown();

    expect(seen[0]).toBe("EXPLICIT-OVERRIDE");
    expect(seen[0]).not.toContain(PLANNER_MARKER);
  });

  it("harness 目录缺失时不炸 —— 回落模块内默认 prompt", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "sansheng-noharness-"));
    try {
      const intent = makeIntent("conv-7b-noharness");
      upsertArtifact(db, intent);

      const seen: string[] = [];
      const orch = new Orchestrator({
        storage,
        dataDir: emptyDir,
        agentDir: join(emptyDir, "agent"),
        plannerLlmCall: (async (input) => {
          seen.push(input.systemPrompt);
          return "[]";
        }) as PlannerLlmCall,
      });
      await orch.run("conv-7b-noharness", intent.title);
      orch.shutdown();

      // 回落到 DEFAULT_PLANNER_PROMPT(模块 stub),不是 undefined
      expect(seen[0]).toContain("Sansheng · Planner");
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

/** 断言 harness 里的 executor prompt 内容确实是那份 marker(前置校验) */
function harnessExecutorPrompt(dataDir: string): string {
  return loadHarness(dataDir).systemPrompts.executor;
}

describe("批次 7-B · ensureHarness 升级链", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sansheng-ensure-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("出厂旧版 planner.md 会被升级为新默认(用户未编辑过)", () => {
    const sp = join(dir, "harness", "system_prompts");
    mkdirSync(sp, { recursive: true });
    // 7-B 之前那份 10 行旧默认
    writeFileSync(
      join(sp, "planner.md"),
      `# Planner (规划师)
你的职责:
- 阅读用户目标和当前 Blackboard
- 拆解为有序的 plan steps
- 给每个 step 指定 executor_id
- 写回 Blackboard.plan

约束:
- plan 不超过 8 steps
- 每个 step 必须有可验证的成功标准
- 简单任务不要用多 agent`,
      "utf-8",
    );

    ensureHarness(dir);
    const after = loadHarness(dir).systemPrompts.planner;
    expect(after).toContain("先归类,再拆解");
    expect(after).toContain("输出协议");
  });

  it("用户编辑过的 planner.md 不被覆盖", () => {
    const sp = join(dir, "harness", "system_prompts");
    mkdirSync(sp, { recursive: true });
    const mine = "# 我自己写的规划师提示词\n请按我的方式来。";
    writeFileSync(join(sp, "planner.md"), mine, "utf-8");

    ensureHarness(dir);
    expect(loadHarness(dir).systemPrompts.planner).toBe(mine);
  });

  it("ensureHarness 幂等:连续两次不产生差异", () => {
    ensureHarness(dir);
    const first = loadHarness(dir).systemPrompts.planner;
    ensureHarness(dir);
    expect(loadHarness(dir).systemPrompts.planner).toBe(first);
  });
});

describe("批次 7-B · 产物可观测", () => {
  it("sanity:listArtifacts 仍能读到 planner 产出的 intent", () => {
    const s = makeStorage();
    const intent = makeIntent("conv-7b-sanity");
    upsertArtifact(s.db, intent);
    const all = listArtifacts(s.db, {
      scope: "conversation",
      conversationId: intent.conversationId,
    });
    expect(all.some((a) => a.kind === "intent")).toBe(true);
  });

  it("harness executor prompt 前置校验:文件内容就是 marker", () => {
    const dir = makeDataDirWithPrompts();
    try {
      expect(harnessExecutorPrompt(dir)).toContain(EXECUTOR_MARKER);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
