/**
 * Sansheng /api/executors/:id/state mock tests · M3+ B1
 * M3+ B1 stub; B3 will wire to real ExecutorSession.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { makeTestStorage, makeTestApp } from "./_helpers.js";

describe("M3+ B1: GET /api/executors/:id/state", () => {
  let app: ReturnType<typeof makeTestApp>;

  beforeEach(() => {
    const { storage } = makeTestStorage();
    app = makeTestApp(storage);
  });

  it("returns mock state for any executor id", async () => {
    const res = await app.request("/api/executors/exec-123/state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      executorId: string;
      status: string;
      currentArtifact: null;
      blocked: boolean;
      lastEvent: null;
      updatedAt: number;
      note: string;
    };
    expect(body.executorId).toBe("exec-123");
    expect(body.status).toBe("idle");
    expect(body.currentArtifact).toBeNull();
    expect(body.blocked).toBe(false);
    expect(body.lastEvent).toBeNull();
    expect(typeof body.updatedAt).toBe("number");
    expect(body.note).toContain("mock");
  });

  it("returns mock state for any id (no DB lookup yet)", async () => {
    const res = await app.request("/api/executors/anything/state");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { executorId: string };
    expect(body.executorId).toBe("anything");
  });
});