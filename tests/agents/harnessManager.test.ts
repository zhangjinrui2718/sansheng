import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/storage/migrations.js";
import { Storage } from "../../src/server/storage/index.js";
import { HarnessManager } from "../../src/server/agents/harnessManager.js";
import { artifactBus, makeArtifact } from "../../src/server/bus/index.js";
import { upsertArtifact, listArtifacts } from "../../src/server/storage/repo/blackboards.js";
import type { BlackboardArtifact } from "../../shared/types/blackboard.js";
import type { HarnessDecideFn, HarnessNotifyUserFn } from "../../src/server/agents/harnessManager.js";

function makeStorage() {
  const db = new Database(":memory:");
  runMigrations(db);
  const storage = new Storage(db);
  return { db, storage };
}

const VALID_PREVIEW_JSON = JSON.stringify({
  previewMarkdown:
    "## 概要\nAdd JWT issuer.\n\n## 目标文件\n- `src/server/auth/jwt.ts`\n\n## 风险与注意事项\nminor",
  riskLevel: "low",
  targetFiles: ["src/server/auth/jwt.ts"],
  estimatedLines: 40,
  mode: "create",
});

function makeProposal(): BlackboardArtifact {
  return makeArtifact({
    kind: "harness_proposal",
    title: "Add JWT issuer",
    body: "Need JWT helper for mobile clients",
    scope: "global",
    author: "executor",
    status: "open",
    metadata: { callbackReason: "harness_proposal" },
  });
}

describe("agents/harnessManager", () => {
  let storage: Storage;
  let db: Database.Database;

  beforeEach(() => {
    const s = makeStorage();
    storage = s.storage;
    db = s.db;
  });

  it("start() subscribes to bus; stop() unsubscribes (no double processing)", async () => {
    const decide: HarnessDecideFn = async () => VALID_PREVIEW_JSON;
    const mgr = new HarnessManager({ storage, bus: artifactBus, decideFn: decide });

    const stop = mgr.start();
    expect(mgr.hasSeen("n/a")).toBe(false);

    // emit one proposal → should process once
    const p1 = makeProposal();
    upsertArtifact(db, p1);
    artifactBus.publish({ type: "artifact_created", artifact: p1 });

    // emit same proposal again → dedupe via `seen`
    artifactBus.publish({ type: "artifact_created", artifact: p1 });

    // give the async handler a tick
    await new Promise((r) => setTimeout(r, 10));

    const previews = listArtifacts(db, { scope: "global", limit: 100 }).filter(
      (a) => a.kind === "implementation_preview",
    );
    expect(previews.length).toBe(1);

    stop();
    // after stop, emit a new proposal → should not be processed
    const p2 = makeProposal();
    upsertArtifact(db, p2);
    artifactBus.publish({ type: "artifact_created", artifact: p2 });
    await new Promise((r) => setTimeout(r, 10));

    const previewsAfter = listArtifacts(db, { scope: "global", limit: 100 }).filter(
      (a) => a.kind === "implementation_preview",
    );
    expect(previewsAfter.length).toBe(1);
  });

  it("publish path: harness_proposal → emits implementation_preview artifact on bus", async () => {
    const decide: HarnessDecideFn = async () => VALID_PREVIEW_JSON;
    const mgr = new HarnessManager({ storage, bus: artifactBus, decideFn: decide });

    const seen: BlackboardArtifact[] = [];
    const unsub = artifactBus.subscribe("artifact_created", (e) => {
      seen.push(e.artifact);
    });

    try {
      const stop = mgr.start();
      const p = makeProposal();
      upsertArtifact(db, p);
      artifactBus.publish({ type: "artifact_created", artifact: p });

      await new Promise((r) => setTimeout(r, 10));
      stop();

      const previews = seen.filter((a) => a.kind === "implementation_preview");
      expect(previews.length).toBe(1);
      expect(previews[0]?.metadata?.riskLevel).toBe("low");
      expect(previews[0]?.metadata?.mode).toBe("create");
      // must reference the proposal it derived from
      expect(previews[0]?.refs).toContain(p.id);
    } finally {
      unsub();
    }
  });

  it("high-risk preview → notifyUser called with riskLevel=high", async () => {
    const highRiskJson = JSON.stringify({
      previewMarkdown: "## 概要\ndangerous change",
      riskLevel: "high",
      targetFiles: ["src/server/auth/jwt.ts"],
      estimatedLines: 200,
      mode: "refactor",
    });

    const decide: HarnessDecideFn = async () => highRiskJson;

    const notified: Array<{
      riskLevel: string;
      title: string;
      text: string;
      previewId: string;
      proposalId: string;
    }> = [];
    const notifyUser: HarnessNotifyUserFn = (input) => {
      notified.push(input);
    };

    const mgr = new HarnessManager({
      storage,
      bus: artifactBus,
      decideFn: decide,
      notifyUser,
    });

    const stop = mgr.start();
    const p = makeProposal();
    upsertArtifact(db, p);
    artifactBus.publish({ type: "artifact_created", artifact: p });
    await new Promise((r) => setTimeout(r, 10));
    stop();

    expect(notified.length).toBe(1);
    expect(notified[0]?.riskLevel).toBe("high");
    expect(notified[0]?.proposalId).toBe(p.id);
    // previewId should match the upserted implementation_preview
    const previews = listArtifacts(db, { scope: "global", limit: 100 }).filter(
      (a) => a.kind === "implementation_preview",
    );
    expect(previews.length).toBe(1);
    expect(notified[0]?.previewId).toBe(previews[0]?.id);
  });

  it("low-risk preview → notifyUser NOT called (only warn)", async () => {
    const decide: HarnessDecideFn = async () => VALID_PREVIEW_JSON;
    const notified: number[] = [];
    const notifyUser: HarnessNotifyUserFn = () => {
      notified.push(1);
    };

    const warns: string[] = [];
    const mgr = new HarnessManager({
      storage,
      bus: artifactBus,
      decideFn: decide,
      notifyUser,
      warn: (m) => warns.push(m),
    });

    const stop = mgr.start();
    const p = makeProposal();
    upsertArtifact(db, p);
    artifactBus.publish({ type: "artifact_created", artifact: p });
    await new Promise((r) => setTimeout(r, 10));
    stop();

    expect(notified.length).toBe(0);
    expect(warns.some((w) => w.includes("preview"))).toBe(true);
  });

  it("decideFn throws → failure note upserted (manager does not crash)", async () => {
    const decide: HarnessDecideFn = async () => {
      throw new Error("LLM down");
    };

    const warns: string[] = [];
    const mgr = new HarnessManager({
      storage,
      bus: artifactBus,
      decideFn: decide,
      warn: (m) => warns.push(m),
    });

    const stop = mgr.start();
    const p = makeProposal();
    upsertArtifact(db, p);
    artifactBus.publish({ type: "artifact_created", artifact: p });
    await new Promise((r) => setTimeout(r, 10));
    stop();

    const previews = listArtifacts(db, { scope: "global", limit: 100 }).filter(
      (a) => a.kind === "implementation_preview",
    );
    expect(previews.length).toBe(0);

    const notes = listArtifacts(db, { scope: "global", limit: 100 }).filter(
      (a) => a.kind === "note",
    );
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(notes.some((n) => n.body.includes("LLM down"))).toBe(true);
    expect(warns.some((w) => w.includes("decideFn threw"))).toBe(true);
  });

  it("ignores non-harness_proposal artifact_created events", async () => {
    const decideCalls: number[] = [];
    const decide: HarnessDecideFn = async () => {
      decideCalls.push(1);
      return VALID_PREVIEW_JSON;
    };

    const mgr = new HarnessManager({ storage, bus: artifactBus, decideFn: decide });

    const stop = mgr.start();
    // emit a todo — should be ignored
    const todo = makeArtifact({
      kind: "todo",
      title: "x",
      body: "x",
      author: "planner",
    });
    upsertArtifact(db, todo);
    artifactBus.publish({ type: "artifact_created", artifact: todo });

    // emit an evidence artifact — should be ignored
    const ev = makeArtifact({
      kind: "evidence",
      title: "y",
      body: "y",
      author: "executor",
    });
    upsertArtifact(db, ev);
    artifactBus.publish({ type: "artifact_created", artifact: ev });

    await new Promise((r) => setTimeout(r, 10));
    stop();

    expect(decideCalls.length).toBe(0);
  });

  // ── M3+ B6 reinforcement: 3 new tests ─────────────────────────────

  // Helper: minimal constructor wrapper (decideFn + notifyUser + timeout).
  function newHarnessManager(opts: {
    decideFn: HarnessDecideFn;
    notifyUser?: HarnessNotifyUserFn;
    decideTimeoutMs?: number;
  }): { manager: HarnessManager; storage: Storage } {
    return {
      manager: new HarnessManager({
        storage,
        bus: artifactBus,
        decideFn: opts.decideFn,
        notifyUser: opts.notifyUser,
        decideTimeoutMs: opts.decideTimeoutMs,
      }),
      storage,
    };
  }

  // Helper: persist a proposal to storage + return the artifact for bus.emit.
  function harnessProposalEvent() {
    const p = makeProposal();
    upsertArtifact(db, p);
    return p;
  }

  // Helper: filter artifacts by kind (matches existing inline pattern).
  function listArtifactsByKind(targetStorage: Storage, kind: string) {
    return listArtifacts(targetStorage.db, { scope: "global", limit: 100 }).filter(
      (a) => a.kind === kind,
    );
  }

  it("B6: decideFn timeout → writeFailureNote with timeout reason", async () => {
    const neverResolve: HarnessDecideFn = () => new Promise(() => {});
    const { manager } = newHarnessManager({
      decideFn: neverResolve,
      decideTimeoutMs: 50,
      notifyUser: () => {},
    });
    await manager.start();
    const p = harnessProposalEvent();
    artifactBus.publish({ type: "artifact_created", artifact: p });
    // wait past timeout (50ms) + bookkeeping slack
    await new Promise((r) => setTimeout(r, 150));
    const notes = listArtifactsByKind(storage, "note");
    expect(notes.length).toBe(1);
    expect(notes[0]?.metadata?.errorMsg).toMatch(/timeout/);
    const s = manager.getStats();
    expect(s.received).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.processed).toBe(0);
    manager.stop();
  });

  it("B6: stats — received/processed/failed all increment on success path", async () => {
    const fakeDecideOk: HarnessDecideFn = async () => VALID_PREVIEW_JSON;
    const { manager } = newHarnessManager({
      decideFn: fakeDecideOk,
      notifyUser: () => {},
    });
    await manager.start();
    artifactBus.publish({ type: "artifact_created", artifact: harnessProposalEvent() });
    await new Promise((r) => setTimeout(r, 30));
    const s = manager.getStats();
    expect(s.received).toBe(1);
    expect(s.processed).toBe(1);
    expect(s.failed).toBe(0);
    expect(s.skippedSeen).toBe(0);
    expect(s.skippedInFlight).toBe(0);
    expect(s.skippedStorageDedup).toBe(0);
    expect(s.seenSize).toBe(1);
    expect(s.inFlightSize).toBe(0);
    manager.stop();
  });

  it("B6: stats — skippedInFlight when same proposal emitted twice in window", async () => {
    const slowDecide = vi.fn(
      () =>
        new Promise<string>((r) =>
          setTimeout(() => r('{"previewMarkdown":"x","riskLevel":"low","targetFiles":[],"estimatedLines":1,"mode":"create"}'), 100),
        ),
    );
    const { manager } = newHarnessManager({
      decideFn: slowDecide,
      notifyUser: () => {},
    });
    await manager.start();
    const p = harnessProposalEvent();
    // first emit → in-flight (decideFn still pending at 10ms)
    artifactBus.publish({ type: "artifact_created", artifact: p });
    await new Promise((r) => setTimeout(r, 10));
    // second emit same id → skippedInFlight
    artifactBus.publish({ type: "artifact_created", artifact: p });
    // wait past slow decide (100ms) + bookkeeping
    await new Promise((r) => setTimeout(r, 200));
    const s = manager.getStats();
    expect(s.received).toBe(2);
    expect(s.processed).toBe(1);
    expect(s.failed).toBe(0);
    expect(s.skippedInFlight).toBe(1);
    manager.stop();
  });
});