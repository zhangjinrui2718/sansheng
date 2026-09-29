import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { runMigrations } from "../../src/server/storage/migrations.js";
import { Storage } from "../../src/server/storage/index.js";
import { Orchestrator } from "../../src/server/agents/orchestrator.js";
import { AgentRunner, type RunnerSettings } from "../../src/server/agents/runner.js";
import type { RoleKind, AgentRunSummary } from "../../shared/types/agents.js";

class FakeAgentRunner {
  role: RoleKind;
  status: AgentRunSummary["status"] = "idle";
  inputPreview = "";
  outputPreview = "";
  startedAt = 0;
  callCount = 0;
  /** 可由测试在创建 runner 前覆盖:next(input) → output 文本 */
  responder: (input: string) => string;

  constructor(role: RoleKind, responder: (input: string) => string) {
    this.role = role;
    this.responder = responder;
  }

  async run(input: string): Promise<string> {
    this.callCount++;
    this.inputPreview = input.slice(0, 200);
    this.startedAt = Date.now();
    this.status = "thinking";
    const out = this.responder(input);
    this.outputPreview = out.slice(0, 500);
    this.status = "done";
    return out;
  }

  abort(): void {
    this.status = "aborted";
  }

  dispose(): void {}

  toSummary(): AgentRunSummary {
    return {
      role: this.role,
      sessionId: "fake",
      startedAt: this.startedAt,
      endedAt: Date.now(),
      status: this.status,
      inputPreview: this.inputPreview,
      outputPreview: this.outputPreview,
    };
  }
}

const DUMMY_SETTINGS: RunnerSettings = {
  provider: "fake",
  apiKey: "sk-fake",
  modelId: "fake-model",
  thinkingLevel: "off",
};

const RESPONSES = {
  approve: (input: string) => {
    // critic 检查最先(critic 输入也含 "Plan:")
    if (input.includes("Reply JSON:")) {
      return JSON.stringify({ approved: true, issues: [], suggestions: [] });
    }
    if (input.includes("Your steps:")) {
      // executor 输入:从 "Your steps:\n" 后提第一个 JSON 数组
      const m = input.match(/Your steps:\n(\[[^\n]*\][\s\S]*?)(?:\n\nGoal|$)/);
      try {
        const steps = JSON.parse(m?.[1] ?? "[]");
        return JSON.stringify(
          steps.map((s: { id: string }) => ({
            step_id: s.id,
            kind: "result",
            content: `done ${s.id}`,
          })),
        );
      } catch {
        return "[]";
      }
    }
    if (input.includes("Write a plan:")) {
      // planner 输入
      return JSON.stringify([
        { id: "s1", description: "step one", status: "pending", assignedExecutor: "e1" },
        { id: "s2", description: "step two", status: "pending", assignedExecutor: "e2" },
      ]);
    }
    return "";
  },
  reject: (input: string) => {
    if (input.includes("Reply JSON:")) {
      return JSON.stringify({
        approved: false,
        issues: [{ severity: "major", message: "证据不足" }],
        suggestions: ["再跑一次"],
      });
    }
    if (input.includes("Your steps:")) {
      const m = input.match(/Your steps:\n(\[[^\n]*\][\s\S]*?)(?:\n\nGoal|$)/);
      try {
        const steps = JSON.parse(m?.[1] ?? "[]");
        return JSON.stringify(
          steps.map((s: { id: string }) => ({
            step_id: s.id,
            kind: "result",
            content: `done ${s.id}`,
          })),
        );
      } catch {
        return "[]";
      }
    }
    if (input.includes("Write a plan:")) {
      return JSON.stringify([
        { id: "s1", description: "step one", status: "pending", assignedExecutor: "e1" },
      ]);
    }
    return "";
  },
  reflect: (input: string) => {
    if (input.includes("Reflection") || input.includes("反思") || input.includes("remembered")) {
      return "下次需要更早发起 critic 评估";
    }
    return RESPONSES.approve(input);
  },
};

function makeStorage(): { db: Database.Database; close: () => void } {
  const db = new Database(":memory:");
  loadSqliteVec(db);
  runMigrations(db);
  // 测试用一个假的 conversation_id,创建 conversations 行避免 fragment FK 报错
  db.prepare(
    `INSERT OR REPLACE INTO conversations (id, title, created_at, last_active_at) VALUES (?, ?, ?, ?)`,
  ).run("conv-1", "test", Date.now(), Date.now());
  db.prepare(
    `INSERT OR REPLACE INTO conversations (id, title, created_at, last_active_at) VALUES (?, ?, ?, ?)`,
  ).run("conv-2", "test", Date.now(), Date.now());
  // Storage 接受 dbPath 字符串;测试直接用 db 接口包一个最小 stub(Orchestrator 只用 .db)
  return { db, close: () => db.close() };
}

function makeOrchestrator(
  storage: { db: Database.Database; close: () => void },
  dataDir: string,
  responder: (input: string) => string,
): Orchestrator {
  return new Orchestrator({
    storage: storage as unknown as Storage,
    dataDir,
    agentDir: "/tmp/agentdir",
    settings: DUMMY_SETTINGS,
    runnerFactory: (role, _id) => {
      // bypass AgentRunner constructor: cast to AgentRunner because orchestrator types say so
      const fake = new FakeAgentRunner(role, responder);
      return fake as unknown as AgentRunner;
    },
  });
}

describe("agents/orchestrator", () => {
  let storage: { db: Database.Database; close: () => void };
  const tmpDir = "/tmp/sansheng-orch-test";

  beforeEach(async () => {
    storage = makeStorage();
    // 准备 harness 目录(M3b: loadHarness 走文件路径,但 inject factory 后其实不真读)
    const { mkdirSync } = await import("node:fs");
    try {
      mkdirSync(`${tmpDir}/harness/system_prompts`, { recursive: true });
    } catch {}
  });

  it("happy path: planner + executor + critic approve → status=approved iteration=1", async () => {
    const orch = makeOrchestrator(storage, tmpDir, RESPONSES.approve);
    const bb = await orch.run("conv-1", "build X", () => {});
    expect(bb.status).toBe("approved");
    expect(bb.iteration).toBe(1);
    expect(bb.plan.length).toBe(2);
    expect(bb.evidence.length).toBe(2);
    expect(bb.critique.length).toBe(1);
    expect(bb.critique[0].approved).toBe(true);
  });

  it("rejected 3 times → maxIter reached → status=abandoned, critique.length=3", async () => {
    const orch = makeOrchestrator(storage, tmpDir, RESPONSES.reject);
    // 用一个会在第 3 次 approve 的 responder 模拟 maxIter
    const responses = Array(3).fill(RESPONSES.reject).concat([RESPONSES.approve]);
    const factory = (role: RoleKind) => {
      const fake = new FakeAgentRunner(role, () => "");
      // 让 critic 永远 reject
      if (role === "critic") {
        return new FakeAgentRunner(role, () =>
          JSON.stringify({ approved: false, issues: [{ severity: "minor", message: "no" }], suggestions: [] }),
        ) as unknown as AgentRunner;
      }
      return fake as unknown as AgentRunner;
    };
    const orch2 = new Orchestrator({
      storage: storage as unknown as Storage,
      dataDir: tmpDir,
      agentDir: "/tmp/agentdir",
      settings: DUMMY_SETTINGS,
      runnerFactory: factory,
    });
    const bb = await orch2.run("conv-1", "build Y", () => {});
    // 默认 maxIterations=5,budget.maxIter,全部 reject
    expect(bb.status).toBe("abandoned");
    expect(bb.critique.length).toBeGreaterThanOrEqual(3);
  });

  it("reflection fragment inserted when reflection returns text", async () => {
    const factory = (role: RoleKind) => {
      if (role === "reflection") {
        return new FakeAgentRunner(role, () => "下次先批预算") as unknown as AgentRunner;
      }
      return new FakeAgentRunner(role, RESPONSES.approve) as unknown as AgentRunner;
    };
    const orch = new Orchestrator({
      storage: storage as unknown as Storage,
      dataDir: tmpDir,
      agentDir: "/tmp/agentdir",
      settings: DUMMY_SETTINGS,
      runnerFactory: factory,
    });
    const bb = await orch.run("conv-1", "build Z", () => {});
    expect(bb.status).toBe("approved");
    const frags = storage.db.prepare("SELECT COUNT(*) AS c FROM fragments").get() as { c: number };
    expect(frags.c).toBeGreaterThanOrEqual(1);
    const row = storage.db
      .prepare("SELECT kind, content FROM fragments ORDER BY created_at DESC LIMIT 1")
      .get() as { kind: string; content: string };
    expect(row.kind).toBe("context");
    expect(row.content).toContain("[reflection]");
    expect(row.content).toContain("下次先批预算");
  });

  it("upsertBlackboard called once at end (single row persisted)", async () => {
    const orch = makeOrchestrator(storage, tmpDir, RESPONSES.approve);
    await orch.run("conv-1", "build W", () => {});
    const count = storage.db
      .prepare("SELECT COUNT(*) AS c FROM blackboards WHERE conversation_id = ?")
      .get("conv-1") as { c: number };
    expect(count.c).toBe(1);
  });
});