import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/storage/migrations.js";
import { Storage } from "../../src/server/storage/index.js";
import { Executor, type ExecutorLlmCall } from "../../src/server/agents/executor.js";
import { artifactBus } from "../../src/server/bus/index.js";
import { makeArtifact } from "../../src/server/bus/index.js";
import {
  upsertArtifact,
  getArtifact,
  listArtifacts,
  updateArtifactStatus,
} from "../../src/server/storage/repo/blackboards.js";
import type { BlackboardArtifact } from "../../shared/types/blackboard.js";

function makeStorage() {
  const db = new Database(":memory:");
  runMigrations(db);
  const storage = new Storage(db);
  return { db, storage };
}

function makeTodo(
  convId: string,
  overrides: Partial<BlackboardArtifact> = {},
): BlackboardArtifact {
  return makeArtifact({
    kind: "todo",
    title: "test todo",
    body: "do the thing",
    scope: "conversation",
    conversationId: convId,
    author: "planner",
    status: "open",
    dependsOn: [],
    ...overrides,
  });
}

describe("agents/executor", () => {
  let storage: Storage;
  let db: Database.Database;

  beforeEach(() => {
    const s = makeStorage();
    storage = s.storage;
    db = s.db;
  });

  it("evidence path → todo marked resolved + evidence artifact upserted", async () => {
    const todo = makeTodo("conv-evidence");
    upsertArtifact(db, todo);

    const llm: ExecutorLlmCall = async () =>
      JSON.stringify({
        outcome: "evidence",
        evidence: {
          title: "Found relevant file",
          body: "src/server/bus/index.ts is where it lives",
        },
      });

    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: llm,
      now: () => 5000,
    });

    const result = await exec.execute(todo);
    expect(result.outcome).toBe("evidence");

    const refreshed = getArtifact(db, todo.id);
    expect(refreshed?.status).toBe("resolved");

    const all = listArtifacts(db, {
      scope: "conversation",
      conversationId: todo.conversationId,
    });
    const evs = all.filter((a) => a.kind === "evidence");
    expect(evs.length).toBe(1);
    expect(evs[0]?.title).toBe("Found relevant file");
  });

  it("hypothesis-judgment path → todo waiting_for_decision + executor_callback emitted on bus", async () => {
    const todo = makeTodo("conv-hyp-judge");
    upsertArtifact(db, todo);

    const busEvents: Array<{
      executorSessionId: string;
      hypothesisId: string;
      reason: string;
    }> = [];
    const unsub = artifactBus.subscribe("executor_callback", (e) => {
      busEvents.push({
        executorSessionId: e.executorSessionId,
        hypothesisId: e.hypothesisId,
        reason: e.reason,
      });
    });

    try {
      const llm: ExecutorLlmCall = async () =>
        JSON.stringify({
          outcome: "hypothesis",
          hypothesis: {
            title: "Need human judgment on auth strategy",
            body: "JWT vs session cookies for mobile clients",
            callbackReason: "judgment",
          },
        });

      const exec = new Executor({
        storage,
        bus: artifactBus,
        llmCall: llm,
        now: () => 9000,
      });

      const result = await exec.execute(todo);
      expect(result.outcome).toBe("hypothesis");

      const refreshed = getArtifact(db, todo.id);
      expect(refreshed?.status).toBe("waiting_for_decision");

      const all = listArtifacts(db, {
        scope: "conversation",
        conversationId: todo.conversationId,
      });
      const hyps = all.filter((a) => a.kind === "hypothesis");
      expect(hyps.length).toBe(1);
      expect(hyps[0]?.metadata?.callbackReason).toBe("judgment");

      expect(busEvents.length).toBe(1);
      expect(busEvents[0]?.reason).toBe("judgment");
      expect(busEvents[0]?.executorSessionId).toBe(exec.sessionId);
      expect(busEvents[0]?.hypothesisId).toBe(hyps[0]?.id);
    } finally {
      unsub();
    }
  });

  it("hypothesis-harness_proposal path → callback reason=harness_proposal", async () => {
    const todo = makeTodo("conv-hyp-harness");
    upsertArtifact(db, todo);

    const busEvents: Array<{ reason: string }> = [];
    const unsub = artifactBus.subscribe("executor_callback", (e) => {
      busEvents.push({ reason: e.reason });
    });

    try {
      const llm: ExecutorLlmCall = async () =>
        JSON.stringify({
          outcome: "hypothesis",
          hypothesis: {
            title: "Suggest harness update",
            body: "Add jwt-issuer to harness system_prompts",
            callbackReason: "harness_proposal",
          },
        });

      const exec = new Executor({
        storage,
        bus: artifactBus,
        llmCall: llm,
      });

      const result = await exec.execute(todo);
      expect(result.outcome).toBe("hypothesis");

      const refreshed = getArtifact(db, todo.id);
      expect(refreshed?.status).toBe("waiting_for_decision");

      const all = listArtifacts(db, {
        scope: "conversation",
        conversationId: todo.conversationId,
      });
      const hyps = all.filter((a) => a.kind === "hypothesis");
      expect(hyps[0]?.metadata?.callbackReason).toBe("harness_proposal");

      expect(busEvents[0]?.reason).toBe("harness_proposal");
    } finally {
      unsub();
    }
  });

  it("failed path → todo marked failed + failure note persisted", async () => {
    const todo = makeTodo("conv-failed");
    upsertArtifact(db, todo);

    const llm: ExecutorLlmCall = async () =>
      JSON.stringify({
        outcome: "failed",
        note: { title: "Cannot proceed", body: "Missing upstream API key" },
      });

    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: llm,
    });

    const result = await exec.execute(todo);
    expect(result.outcome).toBe("failed");

    const refreshed = getArtifact(db, todo.id);
    expect(refreshed?.status).toBe("failed");

    const all = listArtifacts(db, {
      scope: "conversation",
      conversationId: todo.conversationId,
    });
    const notes = all.filter((a) => a.kind === "note");
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes[0]?.title).toBe("Cannot proceed");
  });

  it("parse failure → failed outcome (note + todo failed)", async () => {
    const todo = makeTodo("conv-parse");
    upsertArtifact(db, todo);

    const llm: ExecutorLlmCall = async () => "totally not json";

    const exec = new Executor({
      storage,
      bus: artifactBus,
      llmCall: llm,
    });

    const result = await exec.execute(todo);
    expect(result.outcome).toBe("failed");

    const refreshed = getArtifact(db, todo.id);
    expect(refreshed?.status).toBe("failed");
  });

  it("strips ```json fence and parses inner JSON", async () => {
    const todo = makeTodo("conv-fence");
    upsertArtifact(db, todo);

    const llm: ExecutorLlmCall = async () =>
      "```json\n{\"outcome\":\"evidence\",\"evidence\":{\"title\":\"FromFence\",\"body\":\"body\"}}\n```";

    const exec = new Executor({ storage, bus: artifactBus, llmCall: llm });
    const result = await exec.execute(todo);
    expect(result.outcome).toBe("evidence");
  });

  it("LLM throws → failed outcome with note + todo failed (does not propagate)", async () => {
    const todo = makeTodo("conv-llm-throw");
    upsertArtifact(db, todo);

    const llm: ExecutorLlmCall = async () => {
      throw new Error("rate limit exceeded");
    };

    const exec = new Executor({ storage, bus: artifactBus, llmCall: llm });

    const result = await exec.execute(todo);
    expect(result.outcome).toBe("failed");

    const refreshed = getArtifact(db, todo.id);
    expect(refreshed?.status).toBe("failed");

    const all = listArtifacts(db, {
      scope: "conversation",
      conversationId: todo.conversationId,
    });
    const notes = all.filter((a) => a.kind === "note");
    expect(notes.some((n) => n.body.includes("rate limit"))).toBe(true);
  });

  it("dependsOn gating: upstream todo not resolved → execute returns failed (pending)", async () => {
    const upstream = makeTodo("conv-deps", { id: "upstream" });
    upsertArtifact(db, upstream);

    const downstream = makeTodo("conv-deps", {
      id: "downstream",
      dependsOn: ["upstream"],
    });
    upsertArtifact(db, downstream);

    // leave upstream.status='open' (unresolved)
    const llmCalls: number[] = [];
    const llm: ExecutorLlmCall = async () => {
      llmCalls.push(1);
      return JSON.stringify({
        outcome: "evidence",
        evidence: { title: "x", body: "y" },
      });
    };

    const exec = new Executor({ storage, bus: artifactBus, llmCall: llm });

    const result = await exec.execute(downstream);
    expect(result.outcome).toBe("failed");
    // LLM should not have been called — gating happens before llmCall
    expect(llmCalls.length).toBe(0);

    // downstream should remain 'open' (not transitioned to failed)
    const refreshed = getArtifact(db, downstream.id);
    expect(refreshed?.status).toBe("open");
  });

  it("dependsOn gating: upstream todo resolved → execute runs normally", async () => {
    const upstream = makeTodo("conv-deps2", { id: "upstream" });
    upsertArtifact(db, upstream);
    updateArtifactStatus(db, "upstream", "resolved");

    const downstream = makeTodo("conv-deps2", {
      id: "downstream",
      dependsOn: ["upstream"],
    });
    upsertArtifact(db, downstream);

    const llm: ExecutorLlmCall = async () =>
      JSON.stringify({
        outcome: "evidence",
        evidence: { title: "ran", body: "ok" },
      });

    const exec = new Executor({ storage, bus: artifactBus, llmCall: llm });
    const result = await exec.execute(downstream);
    expect(result.outcome).toBe("evidence");
  });

  it("sessionId is stable across multiple execute calls and exposed on instance", async () => {
    const t1 = makeTodo("conv-sid", { id: "t-sid-1" });
    const t2 = makeTodo("conv-sid", { id: "t-sid-2" });
    upsertArtifact(db, t1);
    upsertArtifact(db, t2);

    const llm: ExecutorLlmCall = async () =>
      JSON.stringify({
        outcome: "evidence",
        evidence: { title: "x", body: "y" },
      });

    const exec = new Executor({ storage, bus: artifactBus, llmCall: llm });
    const sid = exec.sessionId;
    expect(sid).toMatch(/^exec-/);

    await exec.execute(t1);
    await exec.execute(t2);
    // same instance sessionId
    expect(exec.sessionId).toBe(sid);
  });
});