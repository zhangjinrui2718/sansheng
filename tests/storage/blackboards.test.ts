import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { runMigrations } from "../../src/server/storage/migrations.js";
import {
  upsertBlackboard,
  getActiveBlackboard,
  listBlackboards,
  markBlackboardStatus,
} from "../../src/server/storage/index.js";
import type { Blackboard } from "../../shared/types/agents.js";

describe("storage/blackboards", () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    runMigrations(db);
  });

  function sample(overrides: Partial<Blackboard> = {}): Blackboard {
    return {
      conversationId: "conv-1",
      goal: "实现 M3b",
      plan: [{ id: "s1", description: "设计", status: "pending" }],
      todos: [],
      evidence: [],
      critique: [],
      retrievedMemories: [],
      decisions: [],
      producedArtifacts: [],
      ts: 1700000000000,
      version: 1,
      iteration: 0,
      status: "active",
      createdAt: 1700000000000,
      ...overrides,
    };
  }

  it("upsertBlackboard round-trips via getActiveBlackboard", () => {
    const id = upsertBlackboard(db, sample());
    expect(id).toBeGreaterThan(0);
    const fetched = getActiveBlackboard(db, "conv-1");
    expect(fetched).not.toBeNull();
    expect(fetched!.goal).toBe("实现 M3b");
    expect(fetched!.plan).toHaveLength(1);
    expect(fetched!.plan[0].id).toBe("s1");
    expect(fetched!.status).toBe("active");
  });

  it("listBlackboards returns newest first", () => {
    upsertBlackboard(db, sample({ createdAt: 1700000001000, ts: 1700000001000 }));
    upsertBlackboard(db, sample({ createdAt: 1700000002000, ts: 1700000002000 }));
    upsertBlackboard(db, sample({ createdAt: 1700000003000, ts: 1700000003000 }));
    const list = listBlackboards(db, "conv-1");
    expect(list).toHaveLength(3);
    expect(list[0].createdAt).toBeGreaterThan(list[1].createdAt);
  });

  it("markBlackboardStatus(approved) makes getActiveBlackboard return null", () => {
    const id = upsertBlackboard(db, sample());
    const fetched = getActiveBlackboard(db, "conv-1");
    expect(fetched).not.toBeNull();
    markBlackboardStatus(db, id, "approved");
    expect(getActiveBlackboard(db, "conv-1")).toBeNull();
  });

  it("round-trip preserves evidence/critique/decisions JSON shape", () => {
    const bb = sample({
      evidence: [
        { step_id: "s1", executor_id: "e1", kind: "result", content: "ok", ts: 1 },
      ],
      critique: [
        { iteration: 1, critic_id: "c1", approved: true, issues: [], suggestions: ["fine"], ts: 1 },
      ],
      decisions: [
        { iteration: 0, by: "memory", decision: "loaded 3 fragments", ts: 1 },
      ],
    });
    upsertBlackboard(db, bb);
    const fetched = getActiveBlackboard(db, "conv-1")!;
    expect(fetched.evidence[0].content).toBe("ok");
    expect(fetched.critique[0].approved).toBe(true);
    expect(fetched.decisions[0].by).toBe("memory");
  });
});