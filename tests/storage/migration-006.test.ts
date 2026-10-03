/**
 * 批次 7-J · 迁移 006(沉淀工件 kind 归位)的行为测试
 *
 * **为什么单独测迁移**:迁移是**一次性动作**,跑完就没了,出问题也只能等用户
 * 升级到那一版才发现 —— 而那时数据已经被改过。所以这里在临时库上把迁移
 * 单独拎出来跑,逐条守住它必须满足的性质。
 *
 * 事故背景(会话 conv_murnhpls_oha6):沉淀服务复用了工作流 kind
 * hypothesis / intent / decision / note,产出一批**永远没人消费的工件** ——
 * 升级流程由 executor_callback 事件 + 父 todo 状态驱动,全库没有任何代码
 * 按 kind 扫它们,但 UI 把它们和真正的协议件画成同一种卡片。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

let dir: string;
let db: Database.Database;

/** 006 的 SQL 原文 —— 与 migrations/006_sediment_insight.sql 同源 */
const MIGRATION_006 = readFileSync(
  join(import.meta.dirname, "../../migrations/006_sediment_insight.sql"),
  "utf-8",
);

interface Seed {
  id: string;
  kind: string;
  author: string;
  status: string;
  title: string;
  metadata?: Record<string, unknown>;
}

function seedArtifacts(conv: string, artifacts: Seed[]): void {
  const full = artifacts.map((a) => ({
    id: a.id,
    scope: "conversation",
    conversationId: conv,
    kind: a.kind,
    title: a.title,
    body: `body of ${a.id}`,
    author: a.author,
    status: a.status,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    metadata: a.metadata ?? {},
  }));
  db.prepare(
    `INSERT INTO blackboards (conversation_id, artifacts_json, created_at, ts, version, schema_version)
     VALUES (?, ?, ?, 0, 1, 1)`,
  ).run(conv, JSON.stringify(full), Date.now());
}

function readAll(conv: string): Array<Record<string, unknown>> {
  const row = db
    .prepare(`SELECT artifacts_json FROM blackboards WHERE conversation_id = ?`)
    .get(conv) as { artifacts_json: string } | undefined;
  return row ? (JSON.parse(row.artifacts_json) as Array<Record<string, unknown>>) : [];
}

function run006(): void {
  db.exec(MIGRATION_006);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sansheng-006-"));
  db = new Database(join(dir, "t.db"));
  // 只建被 006 触及的最小结构(artifacts_json 是 005 加的列)
  db.exec(`CREATE TABLE blackboards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    artifacts_json TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    schema_version INTEGER NOT NULL DEFAULT 1
  );`);
});

afterEach(() => {
  try {
    db?.close();
  } catch {
    /* ignore */
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("006 · 沉淀工件改判为 insight", () => {
  it("四种旧 kind 各自映射到对应的 sedimentForm", () => {
    seedArtifacts("c1", [
      { id: "i1", kind: "intent", author: "communicator", status: "open", title: "实现 搜索", metadata: { source: "sedimentation" } },
      { id: "d1", kind: "decision", author: "communicator", status: "open", title: "结论:用 X", metadata: { source: "sedimentation" } },
      { id: "h1", kind: "hypothesis", author: "communicator", status: "open", title: "可能是 Y", metadata: { source: "sedimentation" } },
      { id: "n1", kind: "note", author: "communicator", status: "open", title: "背景 Z", metadata: { source: "sedimentation" } },
    ]);
    run006();
    const after = readAll("c1");
    expect(after.map((a) => a.kind)).toEqual(["insight", "insight", "insight", "insight"]);
    const forms = after.map((a) => (a.metadata as Record<string, unknown>).sedimentForm);
    expect(forms).toEqual(["goal", "decision", "hypothesis", "fact"]);
  });

  it("非沉淀工件**原样不动**(没有 metadata.source 一律放过)", () => {
    seedArtifacts("c2", [
      // executor 造的协议 hypothesis —— 绝不能被改判
      { id: "h-ex", kind: "hypothesis", author: "executor", status: "open", title: "等决策的假设" },
      // executor 的失败 note
      { id: "n-ex", kind: "note", author: "executor", status: "failed", title: "做不了" },
      // 沟通员的真 intent(触发 Planner)
      { id: "i-real", kind: "intent", author: "communicator", status: "resolved", title: "调研 方案" },
      // planner 的 todo
      { id: "t1", kind: "todo", author: "planner", status: "resolved", title: "第一步" },
    ]);
    run006();
    expect(readAll("c2").map((a) => a.kind)).toEqual(["hypothesis", "note", "intent", "todo"]);
  });

  it("**混合**场景:只改沉淀那几条,协议件逐字保留", () => {
    seedArtifacts("c3", [
      { id: "h-ex", kind: "hypothesis", author: "executor", status: "open", title: "协议假设" },
      { id: "s1", kind: "hypothesis", author: "communicator", status: "open", title: "沉淀假设", metadata: { source: "sedimentation" } },
      { id: "t1", kind: "todo", author: "planner", status: "resolved", title: "待办" },
    ]);
    run006();
    const after = readAll("c3");
    expect(after[0]?.kind).toBe("hypothesis");
    expect(after[0]?.metadata).toEqual({}); // 协议件的 metadata 不得被塞进 sedimentForm
    expect(after[1]?.kind).toBe("insight");
    expect(after[2]?.kind).toBe("todo");
  });

  it("idempotent:跑两遍结果与跑一遍相同(不会二次污染)", () => {
    seedArtifacts("c4", [
      { id: "h1", kind: "hypothesis", author: "communicator", status: "open", title: "推测", metadata: { source: "sedimentation", sedimentedFrom: "m_1" } },
    ]);
    run006();
    const once = readAll("c4");
    run006();
    expect(readAll("c4")).toEqual(once);
    // sedimentedFrom 等既有 metadata 必须保住
    expect((readAll("c4")[0]?.metadata as Record<string, unknown>).sedimentedFrom).toBe("m_1");
  });

  it("空 artifacts_json 不炸,仍是合法 JSON 数组", () => {
    seedArtifacts("c5", []);
    run006();
    expect(readAll("c5")).toEqual([]);
  });

  it("混合源:只有 source=sedimentation 的被改,其它 source 值不动", () => {
    seedArtifacts("c6", [
      { id: "x", kind: "note", author: "communicator", status: "open", title: "别的来源", metadata: { source: "something-else" } },
      { id: "y", kind: "note", author: "communicator", status: "open", title: "沉淀", metadata: { source: "sedimentation" } },
    ]);
    run006();
    expect(readAll("c6")[0]?.kind).toBe("note");
    expect(readAll("c6")[1]?.kind).toBe("insight");
  });
});
