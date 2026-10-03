import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { runMigrations } from "../../src/server/storage/migrations.js";

describe("storage/migrations", () => {
  it("applies migrations on fresh db", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db); // 让 vec0 真实可用,migration 002 才能 applied
    const result = runMigrations(db);
    expect(result.applied).toContain(1);
    expect(result.applied).toContain(2);
    expect(result.applied).toContain(3); // M3a: agent_states
    expect(result.applied).toContain(4); // M3b: blackboards
    expect(result.applied).toContain(5); // M3+ B1: blackboards.artifacts_json column
    const version = (db.prepare(`SELECT MAX(version) as v FROM schema_version`).get() as { v: number }).v;
    expect(version).toBe(6); // 7-J 新增 006_sediment_insight
    db.close();
  });

  it("is idempotent — second run applies nothing", () => {
    const db = new Database(":memory:");
    loadSqliteVec(db);
    runMigrations(db);
    const result = runMigrations(db);
    expect(result.applied).toHaveLength(0);
    db.close();
  });
});

describe("storage/repo", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    loadSqliteVec(db);
    runMigrations(db);
  });

  it("conversations CRUD", async () => {
    const { upsertConversation, getConversation, listConversations } = await import(
      "../../src/server/storage/repo/conversations.js"
    );
    upsertConversation(db, { id: "c1", cwd: "/tmp", modelId: "m", provider: "p" });
    const c = getConversation(db, "c1");
    expect(c?.id).toBe("c1");
    expect(c?.cwd).toBe("/tmp");
    const list = listConversations(db, 10);
    expect(list).toHaveLength(1);
  });

  it("messages insert + list", async () => {
    const { insertMessage, listMessagesByConversation } = await import(
      "../../src/server/storage/repo/messages.js"
    );
    const { upsertConversation } = await import("../../src/server/storage/repo/conversations.js");
    // conversation 必须在 message 之前(外键约束)
    upsertConversation(db, { id: "c1" });
    insertMessage(db, {
      id: "m1",
      conversationId: "c1",
      turnIndex: 0,
      role: "user",
      content: "hello",
      toolCalls: null,
      thinking: null,
      usageInput: 0,
      usageOutput: 0,
      costUsd: 0,
      createdAt: Date.now(),
    });
    const list = listMessagesByConversation(db, "c1");
    expect(list).toHaveLength(1);
    expect(list[0]?.content).toBe("hello");
  });

  it("fragments search fallback排序", async () => {
    const { insertFragment, searchFragments } = await import(
      "../../src/server/storage/repo/fragments.js"
    );
    const now = Date.now();
    insertFragment(db, {
      id: "f1",
      kind: "summary",
      content: "low priority",
      sourceConversationId: null,
      sourceMessageId: null,
      importance: 0.3,
      decayFactor: 0.95,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: now,
      metadata: null,
    });
    insertFragment(db, {
      id: "f2",
      kind: "fact",
      content: "high priority",
      sourceConversationId: null,
      sourceMessageId: null,
      importance: 0.9,
      decayFactor: 0.95,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: now,
      metadata: null,
    });
    const results = searchFragments(db, { limit: 10 });
    expect(results[0]?.id).toBe("f2");
  });

  it("profile upsert + list", async () => {
    const { upsertProfile, listProfile } = await import("../../src/server/storage/repo/profile.js");
    upsertProfile(db, "name", "张三", 0.8);
    const all = listProfile(db);
    expect(all).toHaveLength(1);
    expect(all[0]?.key).toBe("name");
    // reinforce 应该增加 confidence
    upsertProfile(db, "name", "张三", 0.8); // evidence_count + 1
    const after = listProfile(db);
    expect(after[0]?.evidenceCount).toBe(2);
  });
});