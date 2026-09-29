import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { runMigrations } from "../../src/server/storage/migrations.js";
import {
  upsertAgentState,
  getAgentState,
  deleteAgentState,
} from "../../src/server/storage/index.js";

describe("storage/agentStates", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    runMigrations(db);
  });

  it("upsert + get roundtrip", () => {
    upsertAgentState(db, {
      conversationId: "conv-1",
      cwd: "/tmp",
      modelId: "claude-opus-4-1",
      provider: "anthropic",
      stateJson: JSON.stringify({ historyCount: 3 }),
      lastActiveAt: 1700000000,
    });
    const row = getAgentState(db, "conv-1");
    expect(row).not.toBeNull();
    expect(row?.conversationId).toBe("conv-1");
    expect(row?.cwd).toBe("/tmp");
    expect(row?.modelId).toBe("claude-opus-4-1");
    expect(row?.provider).toBe("anthropic");
    expect(row?.stateJson).toBe('{"historyCount":3}');
    expect(row?.lastActiveAt).toBe(1700000000);
  });

  it("upsert is idempotent (same id overwrites)", () => {
    upsertAgentState(db, {
      conversationId: "conv-2",
      cwd: "/a",
      modelId: "m1",
      provider: "p1",
      stateJson: '{"v":1}',
      lastActiveAt: 1000,
    });
    upsertAgentState(db, {
      conversationId: "conv-2",
      cwd: "/b",
      modelId: "m2",
      provider: "p2",
      stateJson: '{"v":2}',
      lastActiveAt: 2000,
    });
    const row = getAgentState(db, "conv-2");
    expect(row?.cwd).toBe("/b");
    expect(row?.modelId).toBe("m2");
    expect(row?.provider).toBe("p2");
    expect(row?.stateJson).toBe('{"v":2}');
    expect(row?.lastActiveAt).toBe(2000);
  });

  it("get returns null for unknown conversation", () => {
    expect(getAgentState(db, "nope")).toBeNull();
  });

  it("delete removes row", () => {
    upsertAgentState(db, {
      conversationId: "conv-3",
      cwd: null,
      modelId: null,
      provider: null,
      stateJson: null,
      lastActiveAt: 1,
    });
    expect(getAgentState(db, "conv-3")).not.toBeNull();
    deleteAgentState(db, "conv-3");
    expect(getAgentState(db, "conv-3")).toBeNull();
  });
});