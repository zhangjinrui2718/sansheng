/**
 * Sansheng HTTP routes · M3+ B1: BlackboardArtifact v3
 *
 * Extracted from http.ts for testability — registerBlackboardArtifactRoutes(app, storage)
 * can be called from createApp AND from vitest with an in-memory DB (no kernel/ws mocking needed).
 *
 * Routes registered:
 *   - GET    /api/blackboard/global       (global bb artifacts; conversationId=__global__)
 *   - GET    /api/artifacts               (filter by scope/kind/status/limit/conversationId)
 *   - GET    /api/artifacts/:id           (single artifact by id)
 *   - POST   /api/artifacts               (upsert — validation 400 / 200 ok)
 *   - PATCH  /api/artifacts/:id/status    (update status; 404 / 200 ok)
 *   - GET    /api/executors/:id/state     (M3+ B1 mock; B3 will wire to real ExecutorSession)
 *
 * All routes use try/catch with errMsg() helper + log.warn fallback per the v4
 * per-handler try/catch pattern (commit 570467b).
 */
import type { Hono } from "hono";
import { log } from "../../shared/log.js";
import {
  upsertArtifact,
  getArtifact,
  listArtifacts,
  updateArtifactStatus,
  GLOBAL_BLACKBOARD_ID,
} from "../storage/index.js";
import type { Storage } from "../storage/index.js";
// 4b 4a-OQ2:与 http.ts 共用同一 ?limit= 契约(单一来源见 query.ts 文件头)。
import { parseLimitQuery } from "./query.js";
import {
  isArtifactKind,
  isArtifactStatus,
  type BlackboardArtifact,
  type ArtifactStatus,
} from "../../../shared/types/blackboard.js";

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function registerBlackboardArtifactRoutes(app: Hono, storage: Storage): void {
  // GET /api/blackboard/global — 全局 blackboard artifacts
  app.get("/api/blackboard/global", (c) => {
    try {
      const artifacts = listArtifacts(storage.db, {
        scope: "global",
        conversationId: GLOBAL_BLACKBOARD_ID,
        limit: 200,
      });
      return c.json({ artifacts });
    } catch (err) {
      log.warn("blackboard/global failed:", err);
      return c.json(
        { artifacts: [], error: "storage_error", message: errMsg(err) },
        500,
      );
    }
  });

  // GET /api/artifacts/:id — 单个 artifact
  app.get("/api/artifacts/:id", (c) => {
    const id = c.req.param("id");
    try {
      const artifact = getArtifact(storage.db, id);
      if (!artifact) return c.json({ error: "not_found", id }, 404);
      return c.json({ artifact });
    } catch (err) {
      log.warn(`artifact[${id}] failed:`, err);
      return c.json({ error: "storage_error", message: errMsg(err) }, 500);
    }
  });

  // GET /api/artifacts — list with filters
  app.get("/api/artifacts", (c) => {
    const scopeQ = c.req.query("scope");
    const kindQ = c.req.query("kind");
    const statusQ = c.req.query("status");
    const conversationId = c.req.query("conversationId");
    // 4b 4a-OQ2(审查 §C9 遗留 OQ):统一到 parseLimitQuery —— 旧实现
    // `parseInt(limit ?? "100") + isFinite` 把非法值静默回退成 100(200 + 一份
    // 「看起来正常」的数据),与 http.ts 的 400 invalid_limit 契约不一致。
    const limit = parseLimitQuery(c.req.query("limit"), 100, 500);
    if (limit === null) {
      return c.json(
        { error: "invalid_limit", message: "limit must be a finite number" },
        400,
      );
    }

    if (scopeQ && scopeQ !== "global" && scopeQ !== "conversation") {
      return c.json(
        {
          error: "invalid_scope",
          allowed: ["global", "conversation"],
          got: scopeQ,
        },
        400,
      );
    }
    if (kindQ && !isArtifactKind(kindQ)) {
      return c.json({ error: "invalid_kind", got: kindQ }, 400);
    }
    if (statusQ && !isArtifactStatus(statusQ)) {
      return c.json({ error: "invalid_status", got: statusQ }, 400);
    }

    const scope = (scopeQ ?? "conversation") as "global" | "conversation";
    if (scope === "conversation" && !conversationId) {
      return c.json(
        {
          error: "conversationId_required",
          message: "scope=conversation requires conversationId",
        },
        400,
      );
    }

    try {
      const artifacts = listArtifacts(storage.db, {
        scope,
        conversationId: conversationId ?? GLOBAL_BLACKBOARD_ID,
        kind: kindQ,
        status: statusQ,
        limit,
      });
      return c.json({ artifacts });
    } catch (err) {
      log.warn("artifacts list failed:", err);
      return c.json(
        { artifacts: [], error: "storage_error", message: errMsg(err) },
        500,
      );
    }
  });

  // POST /api/artifacts — upsert
  app.post("/api/artifacts", async (c) => {
    let body: Partial<BlackboardArtifact> | null = null;
    try {
      body = (await c.req.json().catch(() => null)) as
        | Partial<BlackboardArtifact>
        | null;
    } catch {
      body = null;
    }
    if (!body || typeof body !== "object" || !body.id) {
      return c.json(
        { error: "artifact required", message: "JSON body with id field" },
        400,
      );
    }
    try {
      upsertArtifact(storage.db, body as BlackboardArtifact);
      return c.json({ ok: true, id: body.id });
    } catch (err) {
      const msg = errMsg(err);
      const isValidation = /invalid|required/i.test(msg);
      log.warn(`upsertArtifact failed:`, err);
      return c.json(
        {
          error: isValidation ? "validation_error" : "storage_error",
          message: msg,
        },
        isValidation ? 400 : 500,
      );
    }
  });

  // PATCH /api/artifacts/:id/status — update status
  app.patch("/api/artifacts/:id/status", async (c) => {
    const id = c.req.param("id");
    let body: { status?: string } | null = null;
    try {
      body = (await c.req.json().catch(() => null)) as { status?: string } | null;
    } catch {
      body = null;
    }
    const newStatus = body?.status;
    if (!newStatus || !isArtifactStatus(newStatus)) {
      return c.json(
        {
          error: "status required",
          allowed: [
            "open",
            "in_progress",
            "waiting_for_decision",
            "resolved",
            "superseded",
            "failed",
          ],
        },
        400,
      );
    }
    try {
      const oldStatus = updateArtifactStatus(
        storage.db,
        id,
        newStatus as ArtifactStatus,
      );
      if (oldStatus === null) return c.json({ error: "not_found", id }, 404);
      return c.json({ ok: true, id, oldStatus, newStatus });
    } catch (err) {
      log.warn(`updateArtifactStatus[${id}] failed:`, err);
      return c.json({ error: "storage_error", message: errMsg(err) }, 500);
    }
  });

  // GET /api/executors/:id/state — M3+ B1 stub
  app.get("/api/executors/:id/state", (c) => {
    const id = c.req.param("id");
    return c.json({
      executorId: id,
      status: "idle",
      currentArtifact: null,
      blocked: false,
      lastEvent: null,
      updatedAt: Date.now(),
      note: "mock · B1 stub (B3 will wire to real ExecutorSession)",
    });
  });
}