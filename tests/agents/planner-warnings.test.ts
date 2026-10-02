/**
 * 批次 4b · C3 —— Planner dropCycles 不级联 + warnings 静默
 * (docs/CODE-REVIEW-2026-10-01.md §C3)
 *
 * 旧实现:`validateAndNormalize` 先做 unknown-dep 过滤,再调 `dropCycles`。
 * drop 掉环上节点后**不重跑**过滤 → 存活 todo 的 dependsOn 指向已被 drop 的 id →
 * Orchestrator 的 areDepsResolved 永远 false → 该 todo 永不 spawn,run 只能等满
 * maxRunMs 超时(叠加审查 §A3 放大)。且 `warnings` 算完即丢,drop 静默发生。
 *
 * 修复契约:
 *  - drop 后重跑 unknown-dep 过滤直至收敛(有循环上限防死循环);
 *  - warnings 进 log(留痕,不再算完即丢);
 *  - 不改 Planner 的 parse / persist / bus 语义(ws-plan-integration 红线)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

import { runMigrations } from "../../src/server/storage/migrations.js";
import { Storage } from "../../src/server/storage/index.js";
import { Planner, type PlannerLlmCall } from "../../src/server/agents/planner.js";
import { makeArtifact } from "../../src/server/bus/index.js";
import { log } from "../../src/shared/log.js";

let storage: Storage;
let db: Database.Database;

beforeEach(() => {
  const _db = new Database(":memory:");
  runMigrations(_db);
  storage = new Storage(_db);
  db = _db;
});

afterEach(() => {
  vi.restoreAllMocks();
  try {
    storage.close();
  } catch {
    /* ignore */
  }
});

function makeIntent() {
  return makeArtifact({
    id: "intent-c3",
    kind: "intent",
    title: "goal",
    body: "goal",
    author: "communicator",
    status: "open",
    scope: "conversation",
    conversationId: "conv-c3",
  });
}

async function planWith(llmCall: PlannerLlmCall) {
  const planner = new Planner({ storage, llmCall });
  return planner.plan(makeIntent());
}

describe("C3 · dropCycles 后级联收敛", () => {
  it("存活 todo 依赖环上节点时,连它一起 drop(旧实现遗留悬挂依赖)", async () => {
    // B ↔ C 成环;C 被 drop 后,B 的 dependsOn=[C] 变成未知依赖 → B 也必须 drop;
    // A 依赖 B,B 被 drop → A 同样级联 drop。
    const llmCall: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "A", title: "a", body: "", dependsOn: ["B"] },
        { id: "B", title: "b", body: "", dependsOn: ["C"] },
        { id: "C", title: "c", body: "", dependsOn: ["B"] },
        { id: "D", title: "d", body: "", dependsOn: [] },
      ]);
    const res = await planWith(llmCall);
    const ids = res.todos.map((t) => t.id);
    // RED(修复前):["A","D"] —— A 的 dependsOn 指向已被 drop 的 B,永不 spawn
    expect(ids).toEqual(["D"]);
  });

  it("收敛结果里不残留任何指向不存在 id 的 dependsOn", async () => {
    const llmCall: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "A", title: "a", body: "", dependsOn: ["B"] },
        { id: "B", title: "b", body: "", dependsOn: ["C"] },
        { id: "C", title: "c", body: "", dependsOn: ["B"] },
        { id: "X", title: "x", body: "", dependsOn: ["A", "ZZZ"] },
      ]);
    const res = await planWith(llmCall);
    const present = new Set(res.todos.map((t) => t.id));
    for (const t of res.todos) {
      for (const d of t.dependsOn) {
        // RED(修复前):悬空 dependsOn 直接进 storage,Orchestrator 永不 spawn
        expect(present.has(d)).toBe(true);
      }
    }
  });

  it("无环无悬空依赖时行为不变(回归守护)", async () => {
    const llmCall: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "A", title: "a", body: "", dependsOn: [] },
        { id: "B", title: "b", body: "", dependsOn: ["A"] },
      ]);
    const res = await planWith(llmCall);
    expect(res.todos.map((t) => t.id)).toEqual(["A", "B"]);
    expect(res.todos[1]?.dependsOn).toEqual(["A"]);
  });
});

describe("C3 · warnings 留痕(不再算完即丢)", () => {
  it("环 drop 的 warning 进 log", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const llmCall: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "B", title: "b", body: "", dependsOn: ["C"] },
        { id: "C", title: "c", body: "", dependsOn: ["B"] },
        { id: "D", title: "d", body: "", dependsOn: [] },
      ]);
    await planWith(llmCall);
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // RED(修复前):warnings 数组算完即丢 → 零日志
    expect(logged).toMatch(/cycle/i);
  });

  it("unknown dependsOn 的 warning 进 log", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const llmCall: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "A", title: "a", body: "", dependsOn: ["NOPE"] },
        { id: "D", title: "d", body: "", dependsOn: [] },
      ]);
    await planWith(llmCall);
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/unknown dependsOn/i);
  });

  it("级联 drop 的 warning 同样留痕(说清是环 drop 之后触发的)", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const llmCall: PlannerLlmCall = async () =>
      JSON.stringify([
        { id: "A", title: "a", body: "", dependsOn: ["B"] },
        { id: "B", title: "b", body: "", dependsOn: ["C"] },
        { id: "C", title: "c", body: "", dependsOn: ["B"] },
        { id: "D", title: "d", body: "", dependsOn: [] },
      ]);
    await planWith(llmCall);
    const logged = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // RED(修复前):A 的级联 drop 完全静默
    expect(logged).toMatch(/A/);
  });

  it("无 drop 的正常计划不产生噪声日志", async () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    const llmCall: PlannerLlmCall = async () =>
      JSON.stringify([{ id: "A", title: "a", body: "", dependsOn: [] }]);
    await planWith(llmCall);
    const plannerWarnings = warnSpy.mock.calls.filter((c) => /planner/i.test(String(c[0])));
    expect(plannerWarnings).toEqual([]);
  });
});

// db 变量保留给未来断言(当前用例只经 Storage 写库)
void db;
