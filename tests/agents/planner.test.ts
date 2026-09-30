import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/storage/migrations.js";
import { Storage } from "../../src/server/storage/index.js";
import { Planner, type PlannerLlmCall } from "../../src/server/agents/planner.js";
import { artifactBus } from "../../src/server/bus/index.js";
import { makeArtifact } from "../../src/server/bus/index.js";
import { listArtifacts, getArtifact, upsertArtifact } from "../../src/server/storage/repo/blackboards.js";
import type { BlackboardArtifact } from "../../shared/types/blackboard.js";

function makeStorage() {
  const db = new Database(":memory:");
  runMigrations(db);
  const storage = new Storage(db);
  return { db, storage };
}

function fakeLlmCall(output: string): PlannerLlmCall {
  return async () => output;
}

function makeIntent(convId: string): BlackboardArtifact {
  return makeArtifact({
    kind: "intent",
    title: "test intent",
    body: "build a CLI todo list",
    scope: "conversation",
    conversationId: convId,
    author: "communicator",
    status: "open",
  });
}

describe("agents/planner", () => {
  let storage: Storage;
  let db: Database.Database;

  beforeEach(() => {
    const s = makeStorage();
    storage = s.storage;
    db = s.db;
  });

  it("happy path: JSON array → todos upserted to storage and published on bus", async () => {
    const intent = makeIntent("conv-1");
    upsertArtifact(db, intent);

    const busEvents: BlackboardArtifact[] = [];
    const unsub = artifactBus.subscribe("artifact_created", (e) => {
      busEvents.push(e.artifact);
    });

    try {
      const llm: PlannerLlmCall = fakeLlmCall(
        JSON.stringify([
          { id: "t1", title: "Step 1", body: "do thing one", dependsOn: [] },
          { id: "t2", title: "Step 2", body: "do thing two", dependsOn: ["t1"] },
        ]),
      );

      const planner = new Planner({
        storage,
        bus: artifactBus,
        llmCall: llm,
        now: () => 1234,
      });

      const result = await planner.plan(intent);

      expect(result.todos.length).toBe(2);
      const t1 = getArtifact(db, "t1");
      const t2 = getArtifact(db, "t2");
      expect(t1?.title).toBe("Step 1");
      expect(t1?.kind).toBe("todo");
      expect(t1?.status).toBe("open");
      expect(t2?.dependsOn).toEqual(["t1"]);

      const createdTodoIds = busEvents
        .filter((a) => a.kind === "todo")
        .map((a) => a.id);
      expect(createdTodoIds).toContain("t1");
      expect(createdTodoIds).toContain("t2");
    } finally {
      unsub();
    }
  });

  it("strips ```json fence before parsing", async () => {
    const intent = makeIntent("conv-fence");
    upsertArtifact(db, intent);

    const llm: PlannerLlmCall = fakeLlmCall(
      "```json\n[{\"id\":\"x\",\"title\":\"X\",\"body\":\"xb\",\"dependsOn\":[]}]\n```",
    );

    const planner = new Planner({
      storage,
      bus: artifactBus,
      llmCall: llm,
    });

    const result = await planner.plan(intent);
    expect(result.todos.length).toBe(1);
    expect(result.todos[0]?.id).toBe("x");
  });

  it("validation drops entries missing required fields; returns empty list when none valid", async () => {
    const intent = makeIntent("conv-validation");
    upsertArtifact(db, intent);

    // missing title/body → invalid; one bad dep ignored
    const llm: PlannerLlmCall = fakeLlmCall(
      JSON.stringify([
        { id: "bad1" }, // missing title + body
        { id: "bad2", title: "ok", body: "ok", dependsOn: ["nonexistent"] }, // bad dep filtered
        { id: "good", title: "G", body: "Gb", dependsOn: [] },
      ]),
    );

    const planner = new Planner({
      storage,
      bus: artifactBus,
      llmCall: llm,
    });

    const result = await planner.plan(intent);
    // bad1 dropped, bad2 dropped (empty deps after filter), good kept
    expect(result.todos.length).toBe(1);
    expect(result.todos[0]?.id).toBe("good");

    // intent should still be open (validation didn't outright fail)
    const persistedIntent = getArtifact(db, intent.id);
    expect(persistedIntent?.status).toBe("open");
  });

  it("parse failure → writes note + marks intent failed; returns empty todos", async () => {
    const intent = makeIntent("conv-parse-fail");
    upsertArtifact(db, intent);

    const llm: PlannerLlmCall = fakeLlmCall("not json at all, just prose");

    const planner = new Planner({
      storage,
      bus: artifactBus,
      llmCall: llm,
    });

    const result = await planner.plan(intent);
    expect(result.todos.length).toBe(0);

    const refreshed = getArtifact(db, intent.id);
    expect(refreshed?.status).toBe("failed");

    // a failure note should have been added to the conversation scope
    const all = listArtifacts(db, {
      scope: "conversation",
      conversationId: intent.conversationId,
    });
    const notes = all.filter((a) => a.kind === "note");
    expect(notes.length).toBeGreaterThanOrEqual(1);
  });

  it("LLM throws → handleLlmFailure writes note + marks intent failed (no throw)", async () => {
    const intent = makeIntent("conv-llm-throw");
    upsertArtifact(db, intent);

    const busEvents: BlackboardArtifact[] = [];
    const statusEvents: Array<{ id: string; newStatus: string }> = [];
    const unsubArtifact = artifactBus.subscribe("artifact_created", (e) => {
      busEvents.push(e.artifact);
    });
    const unsubStatus = artifactBus.subscribe(
      "artifact_status_changed",
      (e) => {
        if (e.artifactId === intent.id) statusEvents.push({ id: e.artifactId, newStatus: e.newStatus });
      },
    );

    try {
      const llm: PlannerLlmCall = async () => {
        throw new Error("upstream LLM 500");
      };

      const planner = new Planner({
        storage,
        bus: artifactBus,
        llmCall: llm,
      });

      // 不再 throw —— 对称 Executor.handleLlmFailure：返回 {todos:[]} + 标记 intent failed
      const result = await planner.plan(intent);
      expect(result.todos).toEqual([]);

      // failure note 落地
      const failureNotes = busEvents.filter(
        (a) => a.kind === "note" && a.title.includes("LLM failed"),
      );
      expect(failureNotes.length).toBe(1);
      expect(failureNotes[0]?.body).toContain("upstream LLM 500");

      // intent 被标 failed
      const refreshed = getArtifact(db, intent.id);
      expect(refreshed?.status).toBe("failed");
      expect(statusEvents).toContainEqual({ id: intent.id, newStatus: "failed" });
    } finally {
      unsubArtifact();
      unsubStatus();
    }
  });

  it("duplicate IDs → earlier wins (dedup by id)", async () => {
    const intent = makeIntent("conv-dup");
    upsertArtifact(db, intent);

    const llm: PlannerLlmCall = fakeLlmCall(
      JSON.stringify([
        { id: "dup", title: "first", body: "first body", dependsOn: [] },
        { id: "dup", title: "second", body: "second body", dependsOn: [] },
      ]),
    );

    const planner = new Planner({
      storage,
      bus: artifactBus,
      llmCall: llm,
    });

    const result = await planner.plan(intent);
    expect(result.todos.length).toBe(1);
    expect(result.todos[0]?.title).toBe("first");
  });

  it("0 valid todos after validation → handleParseFailure with extra param + intent failed", async () => {
    const intent = makeIntent("conv-zero-valid");
    upsertArtifact(db, intent);

    const busEvents: BlackboardArtifact[] = [];
    const statusEvents: Array<{ artifactId: string; newStatus: string }> = [];
    const unsubArtifact = artifactBus.subscribe("artifact_created", (e) => {
      busEvents.push(e.artifact);
    });
    const unsubStatus = artifactBus.subscribe(
      "artifact_status_changed",
      (e) => {
        statusEvents.push({ artifactId: e.artifactId, newStatus: e.newStatus });
      },
    );

    try {
      // 所有 todo 都缺少 title(被归一化函数 drop)→ 验证后 todo.length === 0
      const llm: PlannerLlmCall = fakeLlmCall(
        JSON.stringify([
          { id: "no-title-1", body: "no title here" },
          { id: "no-title-2", body: "no title here either" },
        ]),
      );

      const planner = new Planner({
        storage,
        bus: artifactBus,
        llmCall: llm,
      });

      const result = await planner.plan(intent);
      expect(result.todos).toEqual([]);

      // failure note 落地（明确 extra 参数）
      const failureNotes = busEvents.filter(
        (a) => a.kind === "note" && a.title.includes("parse failed"),
      );
      expect(failureNotes.length).toBe(1);
      expect(failureNotes[0]?.body).toContain("0 valid todos after validation");

      // intent failed
      expect(statusEvents.some((e) => e.artifactId === intent.id && e.newStatus === "failed")).toBe(true);
    } finally {
      unsubArtifact();
      unsubStatus();
    }
  });

  it("dependsOn references unknown todo id → warning + valid peers persisted", async () => {
    const intent = makeIntent("conv-bad-dep");
    upsertArtifact(db, intent);

    const llm: PlannerLlmCall = fakeLlmCall(
      JSON.stringify([
        { id: "bad", title: "BadDep", body: "x", dependsOn: ["does-not-exist"] },
        { id: "good1", title: "G1", body: "g1b", dependsOn: [] },
        { id: "good2", title: "G2", body: "g2b", dependsOn: ["good1"] },
      ]),
    );

    const planner = new Planner({
      storage,
      bus: artifactBus,
      llmCall: llm,
    });

    const result = await planner.plan(intent);
    // bad 被过滤，good1/good2 保留
    expect(result.todos.length).toBe(2);
    const ids = result.todos.map((t) => t.id).sort();
    expect(ids).toEqual(["good1", "good2"]);
  });

  it("DAG cycle (A↔B) → both nodes dropped, cycle-free peers kept", async () => {
    const intent = makeIntent("conv-cycle");
    upsertArtifact(db, intent);

    const llm: PlannerLlmCall = fakeLlmCall(
      JSON.stringify([
        { id: "A", title: "A", body: "a", dependsOn: ["B"] },
        { id: "B", title: "B", body: "b", dependsOn: ["A"] }, // A↔B 环
        { id: "C", title: "C", body: "c", dependsOn: [] }, // 不在环上，保留
        { id: "D", title: "D", body: "d", dependsOn: ["C"] }, // 依赖 C，保留
      ]),
    );

    const planner = new Planner({
      storage,
      bus: artifactBus,
      llmCall: llm,
    });

    const result = await planner.plan(intent);
    const ids = result.todos.map((t) => t.id).sort();
    // A 和 B 都在环上被 drop；C/D 不在环上，保留。
    expect(ids).toEqual(["C", "D"]);
    expect(ids).not.toContain("A");
    expect(ids).not.toContain("B");
  });

  it("self-cycle (A→A) → A dropped, cycle-free peers kept", async () => {
    const intent = makeIntent("conv-self-cycle");
    upsertArtifact(db, intent);

    const llm: PlannerLlmCall = fakeLlmCall(
      JSON.stringify([
        { id: "A", title: "A", body: "a", dependsOn: ["A"] }, // 自反
        { id: "B", title: "B", body: "b", dependsOn: [] },
      ]),
    );

    const planner = new Planner({
      storage,
      bus: artifactBus,
      llmCall: llm,
    });

    const result = await planner.plan(intent);
    const ids = result.todos.map((t) => t.id).sort();
    expect(ids).toEqual(["B"]);
  });
});