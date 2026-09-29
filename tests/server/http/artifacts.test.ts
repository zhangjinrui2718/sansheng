/**
 * Sansheng /api/artifacts tests · M3+ B1
 * Covers GET (single + list with filters), POST (upsert + validation), PATCH (status update).
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

describe("M3+ B1: GET /api/artifacts/:id", () => {
  let storage: ReturnType<typeof makeTestStorage>["storage"];
  let db: ReturnType<typeof makeTestStorage>["db"];
  let app: ReturnType<typeof makeTestApp>;

  beforeEach(() => {
    ({ db, storage } = makeTestStorage());
    app = makeTestApp(storage);
  });

  it("returns 200 + artifact by id", async () => {
    upsertArtifact(db, makeArtifact({ id: "x1", title: "hello" }));
    const res = await app.request("/api/artifacts/x1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifact: BlackboardArtifact };
    expect(body.artifact.id).toBe("x1");
    expect(body.artifact.title).toBe("hello");
  });

  it("returns 404 for missing id", async () => {
    const res = await app.request("/api/artifacts/nope");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; id: string };
    expect(body.error).toBe("not_found");
    expect(body.id).toBe("nope");
  });
});

describe("M3+ B1: GET /api/artifacts (list with filters)", () => {
  let storage: ReturnType<typeof makeTestStorage>["storage"];
  let db: ReturnType<typeof makeTestStorage>["db"];
  let app: ReturnType<typeof makeTestApp>;

  beforeEach(() => {
    ({ db, storage } = makeTestStorage());
    app = makeTestApp(storage);
    upsertArtifact(db, makeArtifact({ id: "g-decision", kind: "decision", scope: "global" }));
    upsertArtifact(db, makeArtifact({ id: "g-note-open", kind: "note", scope: "global", status: "open" }));
    upsertArtifact(db, makeArtifact({ id: "g-note-resolved", kind: "note", scope: "global", status: "resolved" }));
    upsertArtifact(
      db,
      makeArtifact({
        id: "c-conv1",
        scope: "conversation",
        conversationId: "conv-1",
        kind: "decision",
      }),
    );
    upsertArtifact(
      db,
      makeArtifact({
        id: "c-conv2",
        scope: "conversation",
        conversationId: "conv-2",
        kind: "decision",
      }),
    );
  });

  it("defaults to scope=conversation + requires conversationId", async () => {
    const res = await app.request("/api/artifacts");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("conversationId_required");
  });

  it("filters by conversationId (conversation scope)", async () => {
    const res = await app.request(
      "/api/artifacts?scope=conversation&conversationId=conv-1",
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: BlackboardArtifact[] };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]!.id).toBe("c-conv1");
  });

  it("filters by scope=global", async () => {
    const res = await app.request("/api/artifacts?scope=global");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: BlackboardArtifact[] };
    expect(body.artifacts).toHaveLength(3);
  });

  it("filters by kind=decision", async () => {
    const res = await app.request("/api/artifacts?scope=global&kind=decision");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: BlackboardArtifact[] };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]!.kind).toBe("decision");
  });

  it("rejects invalid kind with 400", async () => {
    const res = await app.request("/api/artifacts?scope=global&kind=bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_kind");
  });

  it("filters by status", async () => {
    const res = await app.request("/api/artifacts?scope=global&status=resolved");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: BlackboardArtifact[] };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]!.id).toBe("g-note-resolved");
  });

  it("rejects invalid status with 400", async () => {
    const res = await app.request("/api/artifacts?scope=global&status=bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_status");
  });

  it("rejects invalid scope with 400", async () => {
    const res = await app.request("/api/artifacts?scope=bogus");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_scope");
  });

  it("respects limit", async () => {
    const res = await app.request("/api/artifacts?scope=global&limit=2");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: BlackboardArtifact[] };
    expect(body.artifacts).toHaveLength(2);
  });

  it("clamps limit to max 500", async () => {
    const res = await app.request("/api/artifacts?scope=global&limit=99999");
    expect(res.status).toBe(200);
    // Should still work (no artifacts to clamp against)
    const body = (await res.json()) as { artifacts: BlackboardArtifact[] };
    expect(Array.isArray(body.artifacts)).toBe(true);
  });

  it("defaults limit to 100", async () => {
    const res = await app.request("/api/artifacts?scope=global");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: BlackboardArtifact[] };
    expect(body.artifacts).toHaveLength(3);
  });
});

describe("M3+ B1: POST /api/artifacts (upsert)", () => {
  let storage: ReturnType<typeof makeTestStorage>["storage"];
  let db: ReturnType<typeof makeTestStorage>["db"];
  let app: ReturnType<typeof makeTestApp>;

  beforeEach(() => {
    ({ db, storage } = makeTestStorage());
    app = makeTestApp(storage);
  });

  it("upserts a valid artifact", async () => {
    const a = makeArtifact({ id: "u1", kind: "decision", title: "go" });
    const res = await app.request("/api/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(a),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: string };
    expect(body.ok).toBe(true);
    expect(body.id).toBe("u1");
    const fetched = await app.request("/api/artifacts/u1");
    const fetchedBody = (await fetched.json()) as { artifact: BlackboardArtifact };
    expect(fetchedBody.artifact.title).toBe("go");
  });

  it("returns 400 if body is missing id", async () => {
    const res = await app.request("/api/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "no id" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 if body is invalid JSON", async () => {
    const res = await app.request("/api/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid kind (validation_error)", async () => {
    const res = await app.request("/api/artifacts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "bad1",
        scope: "global",
        kind: "bogus",
        title: "x",
      }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_error");
  });
});

describe("M3+ B1: PATCH /api/artifacts/:id/status", () => {
  let storage: ReturnType<typeof makeTestStorage>["storage"];
  let db: ReturnType<typeof makeTestStorage>["db"];
  let app: ReturnType<typeof makeTestApp>;

  beforeEach(() => {
    ({ db, storage } = makeTestStorage());
    app = makeTestApp(storage);
  });

  it("updates status and returns oldStatus", async () => {
    upsertArtifact(db, makeArtifact({ id: "p1", status: "open" }));
    const res = await app.request("/api/artifacts/p1/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; oldStatus: string; newStatus: string };
    expect(body.ok).toBe(true);
    expect(body.oldStatus).toBe("open");
    expect(body.newStatus).toBe("resolved");
  });

  it("returns 400 for invalid status value", async () => {
    const res = await app.request("/api/artifacts/any/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 if status field is missing", async () => {
    const res = await app.request("/api/artifacts/any/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 for missing artifact", async () => {
    const res = await app.request("/api/artifacts/missing/status", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "resolved" }),
    });
    expect(res.status).toBe(404);
  });
});