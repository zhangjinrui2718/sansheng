/**
 * Sansheng GET /api/blackboard/global tests · M3+ B1
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  makeTestStorage,
  makeTestApp,
} from "./_helpers.js";
import { upsertArtifact, GLOBAL_BLACKBOARD_ID } from "../../../src/server/storage/index.js";
import type { BlackboardArtifact } from "@shared/types/blackboard.js";

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

describe("M3+ B1: GET /api/blackboard/global", () => {
  let storage: ReturnType<typeof makeTestStorage>["storage"];
  let db: ReturnType<typeof makeTestStorage>["db"];
  let app: ReturnType<typeof makeTestApp>;

  beforeEach(() => {
    ({ db, storage } = makeTestStorage());
    app = makeTestApp(storage);
  });

  it("returns empty artifacts when global bb is empty", async () => {
    const res = await app.request("/api/blackboard/global");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: BlackboardArtifact[] };
    expect(body.artifacts).toEqual([]);
  });

  it("returns only global artifacts (filters out conversation-scoped)", async () => {
    upsertArtifact(db, makeArtifact({ id: "g1", scope: "global" }));
    upsertArtifact(db, makeArtifact({ id: "g2", scope: "global" }));
    upsertArtifact(
      db,
      makeArtifact({
        id: "c1",
        scope: "conversation",
        conversationId: "conv-1",
      }),
    );
    const res = await app.request("/api/blackboard/global");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: BlackboardArtifact[] };
    expect(body.artifacts).toHaveLength(2);
    expect(body.artifacts.map((a) => a.id).sort()).toEqual(["g1", "g2"]);
  });

  it("limits global artifacts to 200", async () => {
    for (let i = 0; i < 5; i++) {
      upsertArtifact(db, makeArtifact({ id: `g-${i}`, scope: "global" }));
    }
    const res = await app.request("/api/blackboard/global");
    const body = (await res.json()) as { artifacts: BlackboardArtifact[] };
    expect(body.artifacts.length).toBe(5);
  });
});