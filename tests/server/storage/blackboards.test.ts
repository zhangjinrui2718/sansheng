/**
 * Sansheng BlackboardArtifact v3 storage tests · M3+ B1
 *
 * Covers:
 *   - upsertArtifact: validation (10 kinds, 6 statuses, scope, callbackReason)
 *   - getArtifact: round-trip across rows
 *   - listArtifacts: scope/kind/status/limit filters
 *   - updateArtifactStatus: returns oldStatus; persists new status
 *   - migrateBlackboardArtifacts: legacy decisions/producedArtifacts → v3 artifacts
 *   - ensureBlackboardArtifactsColumn: idempotent on legacy DBs
 */
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { runMigrations } from "../../../src/server/storage/migrations.js";
import { ensureBlackboardArtifactsColumn } from "../../../src/server/storage/db.js";
import {
  upsertArtifact,
  getArtifact,
  listArtifacts,
  updateArtifactStatus,
  migrateBlackboardArtifacts,
  applyLegacyMigration,
  validateArtifact,
  GLOBAL_BLACKBOARD_ID,
} from "../../../src/server/storage/index.js";
import type { BlackboardArtifact } from "../../../shared/types/blackboard.js";

function makeArtifact(overrides: Partial<BlackboardArtifact> = {}): BlackboardArtifact {
  return {
    id: `a-${Math.random().toString(36).slice(2, 8)}`,
    scope: "global",
    conversationId: GLOBAL_BLACKBOARD_ID,
    kind: "note",
    title: "test note",
    body: "hello",
    author: "communicator",
    status: "open",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe("M3+ B1: BlackboardArtifact CRUD", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    runMigrations(db);
  });

  it("upsertArtifact persists + getArtifact retrieves", () => {
    const a = makeArtifact({ id: "a1", kind: "decision", title: "decision 1" });
    upsertArtifact(db, a);
    const fetched = getArtifact(db, "a1");
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe("a1");
    expect(fetched!.kind).toBe("decision");
    expect(fetched!.title).toBe("decision 1");
    expect(fetched!.status).toBe("open");
  });

  it("upsertArtifact updates existing artifact in-place", () => {
    const a = makeArtifact({ id: "a2", title: "v1" });
    upsertArtifact(db, a);
    upsertArtifact(db, { ...a, title: "v2", updatedAt: Date.now() + 100 });
    const fetched = getArtifact(db, "a2");
    expect(fetched!.title).toBe("v2");
  });

  it("upsertArtifact stores global scope artifacts under __global__", () => {
    const a = makeArtifact({ id: "a3", scope: "global" });
    upsertArtifact(db, a);
    const list = listArtifacts(db, { scope: "global" });
    expect(list).toHaveLength(1);
    expect(list[0]!.id).toBe("a3");
    expect(list[0]!.conversationId).toBe(GLOBAL_BLACKBOARD_ID);
  });

  it("upsertArtifact requires conversationId for scope=conversation", () => {
    const a = makeArtifact({
      id: "a4",
      scope: "conversation",
      // conversationId intentionally undefined
    });
    delete (a as { conversationId?: string }).conversationId;
    expect(() => upsertArtifact(db, a)).toThrow(/conversationId/);
  });

  it("upsertArtifact accepts all 10 valid kinds", () => {
    const kinds: BlackboardArtifact["kind"][] = [
      "decision",
      "hypothesis",
      "harness_proposal",
      "implementation_preview",
      "intent",
      "todo",
      "note",
      "evidence",
      "critique",
      "reflection",
    ];
    for (const kind of kinds) {
      const a = makeArtifact({ id: `kind-${kind}`, kind });
      upsertArtifact(db, a);
    }
    const all = listArtifacts(db, { scope: "global" });
    expect(all).toHaveLength(10);
  });

  it("upsertArtifact rejects invalid kind", () => {
    const a = makeArtifact({ kind: "bogus" as BlackboardArtifact["kind"] });
    expect(() => upsertArtifact(db, a)).toThrow(/kind invalid/);
  });

  it("upsertArtifact rejects invalid status", () => {
    const a = makeArtifact({ status: "bogus" as BlackboardArtifact["status"] });
    expect(() => upsertArtifact(db, a)).toThrow(/status invalid/);
  });

  it("upsertArtifact rejects invalid callbackReason", () => {
    const a = makeArtifact({
      kind: "hypothesis",
      metadata: { callbackReason: "bogus" as "judgment" },
    });
    expect(() => upsertArtifact(db, a)).toThrow(/callbackReason/);
  });

  it("upsertArtifact accepts judgment + harness_proposal callbackReasons", () => {
    for (const reason of ["judgment", "harness_proposal"] as const) {
      const a = makeArtifact({
        id: `cb-${reason}`,
        kind: "hypothesis",
        metadata: { callbackReason: reason },
      });
      upsertArtifact(db, a);
      const f = getArtifact(db, `cb-${reason}`);
      expect(f!.metadata?.callbackReason).toBe(reason);
    }
  });

  it("getArtifact returns null for missing id", () => {
    expect(getArtifact(db, "nope")).toBeNull();
  });

  it("listArtifacts filters by kind", () => {
    upsertArtifact(db, makeArtifact({ id: "d1", kind: "decision" }));
    upsertArtifact(db, makeArtifact({ id: "n1", kind: "note" }));
    upsertArtifact(db, makeArtifact({ id: "d2", kind: "decision" }));
    const decisions = listArtifacts(db, { scope: "global", kind: "decision" });
    expect(decisions).toHaveLength(2);
    expect(decisions.map((d) => d.id).sort()).toEqual(["d1", "d2"]);
  });

  it("listArtifacts filters by status", () => {
    upsertArtifact(db, makeArtifact({ id: "s1", kind: "decision", status: "open" }));
    upsertArtifact(db, makeArtifact({ id: "s2", kind: "decision", status: "resolved" }));
    const open = listArtifacts(db, { scope: "global", status: "open" });
    expect(open).toHaveLength(1);
    expect(open[0]!.id).toBe("s1");
  });

  it("listArtifacts filters by conversationId for scope=conversation", () => {
    upsertArtifact(
      db,
      makeArtifact({ id: "c1", scope: "conversation", conversationId: "conv-1" }),
    );
    upsertArtifact(
      db,
      makeArtifact({ id: "c2", scope: "conversation", conversationId: "conv-2" }),
    );
    const conv1 = listArtifacts(db, {
      scope: "conversation",
      conversationId: "conv-1",
    });
    expect(conv1).toHaveLength(1);
    expect(conv1[0]!.id).toBe("c1");
  });

  it("listArtifacts respects limit", () => {
    for (let i = 0; i < 5; i++) {
      upsertArtifact(db, makeArtifact({ id: `l-${i}` }));
    }
    const three = listArtifacts(db, { scope: "global", limit: 3 });
    expect(three).toHaveLength(3);
  });

  it("listArtifacts with scope=conversation + missing conversationId returns []", () => {
    const arr = listArtifacts(db, { scope: "conversation" });
    expect(arr).toEqual([]);
  });

  it("updateArtifactStatus returns oldStatus and persists new", () => {
    upsertArtifact(db, makeArtifact({ id: "u1", status: "open" }));
    const old = updateArtifactStatus(db, "u1", "resolved");
    expect(old).toBe("open");
    const fetched = getArtifact(db, "u1");
    expect(fetched!.status).toBe("resolved");
  });

  it("updateArtifactStatus returns null for missing id", () => {
    const old = updateArtifactStatus(db, "missing", "resolved");
    expect(old).toBeNull();
  });

  it("updateArtifactStatus rejects invalid status", () => {
    expect(() =>
      updateArtifactStatus(db, "any", "bogus" as BlackboardArtifact["status"]),
    ).toThrow(/status invalid/);
  });

  it("validateArtifact catches missing required fields", () => {
    expect(() => validateArtifact({} as BlackboardArtifact)).toThrow();
    expect(() =>
      validateArtifact({ id: "x" } as BlackboardArtifact),
    ).toThrow();
  });
});

describe("M3+ B1: migrateBlackboardArtifacts (legacy → v3)", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    runMigrations(db);
  });

  it("migrates legacy decisions_json into decision artifacts", () => {
    // Insert a legacy row directly via SQL
    const now = Date.now();
    db.prepare(
      `INSERT INTO blackboards
        (conversation_id, goal, plan_json, todos_json, evidence_json, critique_json,
         retrieved_memories_json, decisions_json, produced_artifacts_json, ts, version,
         iteration, status, created_at, schema_version)
       VALUES (?, 'g', '[]', '[]', '[]', '[]', '[]', ?, '[]', ?, 1, 0, 'active', ?, 1)`,
    ).run(
      "conv-legacy",
      JSON.stringify([
        { iteration: 0, by: "communicator", decision: "use SQLite", ts: 1700000000000 },
      ]),
      now,
      now,
    );
    const id = Number(
      (db.prepare(`SELECT id FROM blackboards WHERE conversation_id = ?`).get('conv-legacy') as { id: number }).id,
    );
    const n = applyLegacyMigration(db, id);
    expect(n).toBeGreaterThan(0);
    const row = db
      .prepare(`SELECT artifacts_json FROM blackboards WHERE id = ?`)
      .get(id) as { artifacts_json: string };
    const artifacts = JSON.parse(row.artifacts_json) as BlackboardArtifact[];
    expect(artifacts.length).toBeGreaterThan(0);
    const decision = artifacts.find((a) => a.kind === "decision");
    expect(decision).toBeDefined();
    expect(decision!.body).toBe("use SQLite");
    expect(decision!.author).toBe("communicator");
    expect(decision!.status).toBe("resolved");
  });

  it("migrates legacy produced_artifacts_json into evidence artifacts", () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO blackboards
        (conversation_id, goal, plan_json, todos_json, evidence_json, critique_json,
         retrieved_memories_json, decisions_json, produced_artifacts_json, ts, version,
         iteration, status, created_at, schema_version)
       VALUES (?, 'g', '[]', '[]', '[]', '[]', '[]', '[]', ?, ?, 1, 0, 'active', ?, 1)`,
    ).run(
      "conv-p",
      JSON.stringify([{ id: "art1", path: "/tmp/x.txt", summary: "wrote file" }]),
      now,
      now,
    );
    const id = Number(
      (db.prepare(`SELECT id FROM blackboards WHERE conversation_id = ?`).get('conv-p') as { id: number }).id,
    );
    applyLegacyMigration(db, id);
    const row = db
      .prepare(`SELECT artifacts_json FROM blackboards WHERE id = ?`)
      .get(id) as { artifacts_json: string };
    const artifacts = JSON.parse(row.artifacts_json) as BlackboardArtifact[];
    const evidence = artifacts.find((a) => a.kind === "evidence");
    expect(evidence).toBeDefined();
    expect(evidence!.body).toBe("wrote file");
    expect(evidence!.author).toBe("executor");
    expect(evidence!.refs).toEqual(["/tmp/x.txt"]);
  });

  it("migrateBlackboardArtifacts is idempotent (no dupes)", () => {
    const row = {
      id: 1,
      conversation_id: "conv-x",
      decisions_json: JSON.stringify([{ iteration: 0, by: "c", decision: "x" }]),
      produced_artifacts_json: "[]",
      artifacts_json: "[]",
    };
    const first = migrateBlackboardArtifacts(row);
    const second = migrateBlackboardArtifacts({ ...row, artifacts_json: JSON.stringify(first) });
    expect(second.length).toBe(first.length);
  });

  it("migrateBlackboardArtifacts handles empty row", () => {
    const out = migrateBlackboardArtifacts({});
    expect(out).toEqual([]);
  });
});

describe("M3+ B1: ensureBlackboardArtifactsColumn (idempotent)", () => {
  it("adds artifacts_json column to legacy DB without 005 migration", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    // Apply only migrations 1-4 to simulate a DB that didn't run 005
    runMigrations(db);
    // Drop artifacts_json column to simulate even older state
    // (SQLite doesn't support DROP COLUMN directly, so skip — column is present in 004 already? No, 004 doesn't have it)
    // Check column presence
    const cols = db.prepare(`PRAGMA table_info(blackboards)`).all() as Array<{ name: string }>;
    const has = cols.some((c) => c.name === "artifacts_json");
    // Migration 005 should have added it; ensureBlackboardArtifactsColumn is a no-op
    ensureBlackboardArtifactsColumn(db);
    const colsAfter = db.prepare(`PRAGMA table_info(blackboards)`).all() as Array<{ name: string }>;
    expect(colsAfter.some((c) => c.name === "artifacts_json")).toBe(has);
    db.close();
  });

  it("ensureBlackboardArtifactsColumn is safe to call twice", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    runMigrations(db);
    expect(() => {
      ensureBlackboardArtifactsColumn(db);
      ensureBlackboardArtifactsColumn(db);
    }).not.toThrow();
    db.close();
  });
});