/**
 * Sansheng Hono app factory.
 * M0 健康检查 + 静态文件。
 * M1 /api/settings、/api/providers、WS。
 * M1.5 多 provider + 新建对话。
 * M3+ 注入多 agent / blackboard / artifacts 路由。
 */
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { log } from "../shared/log.js";
import { SettingsStore, genProviderId, isMaskedApiKey, type ProviderConfig, type ThinkingLevel } from "./settings/store.js";
import { listProviders } from "./providers/registry.js";
import type { AgentKernel, ServerEvent } from "./kernel/agentKernel.js";
import { attachWebSocket } from "./ws.js";
import { Storage } from "./storage/index.js";
import {
  getConversation,
  listConversations,
  listMessagesByConversation,
  listProfile,
  upsertProfile,
  getActiveBlackboard,
  listBlackboards,
  listFragmentsByKind,
  listFragmentsAll,
} from "./storage/index.js";
import {
  createToolRegistry,
  type CreateToolRegistryOptions,
} from "./tools/integration.js";
import { registerBlackboardArtifactRoutes } from "./http/blackboardRoutes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = import.meta.dirname ?? join(__filename, "..");

export interface AppOptions {
  dataDir: string;
  kernel: AgentKernel;
  httpServer: Server;
  settingsStore: SettingsStore;
  storage: Storage;
  /**
   * 可选:把外部已建好的 ToolRegistry opts 传入(如显式 sandbox / netPolicy)。
   * 不传 → createApp 在初始化时自动调用 createToolRegistry()(异步,加载默认 sandbox + net policy)。
   */
  toolRegistryOptions?: CreateToolRegistryOptions;
}

/** 从任意 throw 值取可读错误信息。 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 把内部 Settings 转成对外(掩码 apiKey)的 SettingsPublic */
function toPublic(s: ReturnType<SettingsStore["load"]>) {
  return {
    providers: s.providers.map((p) => ({
      id: p.id,
      label: p.label,
      provider: p.provider,
      modelId: p.modelId,
      apiKey: maskApiKey(p.apiKey),
      hasApiKey: p.apiKey.length > 0,
      baseUrl: p.baseUrl,
      thinkingLevel: p.thinkingLevel,
    })),
    activeProviderId: s.activeProviderId,
    cwd: s.cwd,
    personaName: s.personaName,
    costBudgetUsd: s.costBudgetUsd,
  };
}

export async function createApp(opts: AppOptions): Promise<Hono> {
  const app = new Hono();
  const settingsStore = opts.settingsStore;
  // M4: ToolRegistry(fs+http 6 件套)全局单例,每次 HTTP request 复用。
  // 创建可能涉及 ~/.sansheng/{sandbox,net}.json 读盘,所以是 async;直接 await。
  const tools = await createToolRegistry(opts.toolRegistryOptions);

  // —— Logger middleware ——
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    log.muted(`${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
  });

  // —— 健康检查 ——
  app.get("/api/health", (c) =>
    c.json({ ok: true, name: "sansheng", version: "0.1.0", ts: Date.now(), dataDir: opts.dataDir }),
  );

  // —— 配置(meta) ——
  app.get("/api/config", (c) => {
    const cfg = settingsStore.load();
    const active = settingsStore.activeProvider();
    return c.json({
      name: "sansheng",
      version: "0.1.0",
      host: process.env.SANSHENG_HOST ?? "127.0.0.1",
      port: Number(process.env.SANSHENG_PORT ?? 2718),
      features: { multiAgent: false, persistence: false, artifacts: false, harness: false, scheduler: false, chat: true },
      kernelReady: opts.kernel.isReady(),
      conversationId: opts.kernel.getConversationId(),
      personaName: cfg.personaName,
      activeProvider: active ? { label: active.label, provider: active.provider, modelId: active.modelId } : null,
      hasAnyProvider: cfg.providers.length > 0,
    });
  });

  // —— Settings: GET(掩码 apiKey) ——
  app.get("/api/settings", (c) => c.json(toPublic(settingsStore.load())));

  // —— Settings: PUT(整体替换 providers + 全局字段) ——
  app.put("/api/settings", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      providers?: Array<Partial<ProviderConfig>>;
      activeProviderId?: string;
      cwd?: string;
      personaName?: string;
      costBudgetUsd?: number;
    } | null;
    if (!body) return c.json({ error: "invalid body" }, 400);

    const cur = settingsStore.load();
    const curById = new Map(cur.providers.map((p) => [p.id, p]));

    const nextProviders: ProviderConfig[] = (body.providers ?? []).map((p) => {
      const existing = p.id ? curById.get(p.id) : undefined;
      // apiKey: 用户没填(undefined)或填的是掩码串 → 保留旧真值;填了新真值 → 用它
      let apiKey = existing?.apiKey ?? "";
      if (p.apiKey !== undefined && !isMaskedApiKey(p.apiKey)) apiKey = p.apiKey;
      return {
        id: p.id || genProviderId(),
        label: p.label || p.provider || "未命名",
        provider: p.provider || "",
        modelId: p.modelId || "",
        apiKey,
        baseUrl: p.baseUrl || undefined,
        thinkingLevel: (p.thinkingLevel as ThinkingLevel) ?? "medium",
      };
    });

    let activeProviderId = body.activeProviderId ?? cur.activeProviderId;
    if (!nextProviders.find((p) => p.id === activeProviderId)) {
      activeProviderId = nextProviders[0]?.id ?? "";
    }

    const next = {
      ...cur,
      providers: nextProviders,
      activeProviderId,
      cwd: body.cwd ?? cur.cwd,
      personaName: body.personaName ?? cur.personaName,
      costBudgetUsd: body.costBudgetUsd ?? cur.costBudgetUsd,
    };
    settingsStore.save(next);

    // provider 配置变了 → 让 kernel 下次重新 start
    opts.kernel.invalidate();
    return c.json({ ok: true, settings: toPublic(next) });
  });

  // —— Providers catalog(Pi builtin) ——
  app.get("/api/providers", (c) => c.json({ providers: listProviders() }));

  // —— 新建对话 ——
  app.post("/api/conversation/new", (c) => {
    const sink = (e: ServerEvent) => log.muted(`new-conv event: ${e.type}`);
    // newConversation 是同步逻辑(dispose + 换 id),用 void 触发即可
    void opts.kernel.newConversation(sink);
    return c.json({ ok: true, conversationId: opts.kernel.getConversationId() });
  });

  // —— 强制重置 kernel(stuck 恢复用) ——
  app.post("/api/kernel/reset", async (c) => {
    const sink = (e: ServerEvent) => log.muted(`reset-event: ${e.type}`);
    await opts.kernel.reset(sink);
    return c.json({ ok: true, conversationId: opts.kernel.getConversationId() });
  });

  // —— M3b: Blackboard / Agents / Memory 读路由 ——
  // 全部 try/catch 兑底:storage 缺失表 / sqlite-vec 未加载 / 任意 throw 都返回 JSON 500,不走 SPA fallback HTML。
  app.get("/api/blackboard/:id", (c) => {
    const conversationId = c.req.param("id");
    try {
      const bb = getActiveBlackboard(opts.storage.db, conversationId);
      return c.json({ blackboard: bb });
    } catch (err) {
      log.warn(`blackboard[${conversationId}] failed:`, err);
      return c.json({ blackboard: null, error: "storage_error", message: errMsg(err) }, 500);
    }
  });

  app.get("/api/blackboards/:id", (c) => {
    const conversationId = c.req.param("id");
    try {
      const list = listBlackboards(opts.storage.db, conversationId, 20);
      return c.json({ blackboards: list });
    } catch (err) {
      log.warn(`blackboards[${conversationId}] failed:`, err);
      return c.json({ blackboards: [], error: "storage_error", message: errMsg(err) }, 500);
    }
  });

  app.get("/api/agents/:id", (c) => {
    // M3b 占位:M3c 会接 ws 推送的 agents 快照/数据库中 agent_states 聚合
    return c.json({ agents: [] });
  });

  // —— M3+ B1: BlackboardArtifact v3 路由(extracted to blackboardRoutes.ts) ——
  registerBlackboardArtifactRoutes(app, opts.storage);

  app.get("/api/memory/fragments", (c) => {
    const kind = c.req.query("kind");
    const limit = Math.min(Number(c.req.query("limit") ?? "100"), 500);
    try {
      const fragments = kind
        ? listFragmentsByKind(opts.storage.db, kind as never, limit)
        : listFragmentsAll(opts.storage.db, limit);
      return c.json({ fragments });
    } catch (err) {
      log.warn(`memory/fragments failed:`, err);
      return c.json({ fragments: [], error: "storage_error", message: errMsg(err) }, 500);
    }
  });

  // ============== M2:持久化路由 ==============

  // 列出最近会话(供 HistoryRail 用)
  app.get("/api/conversations", (c) => {
    const limit = parseInt(c.req.query("limit") ?? "50", 10);
    const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50;
    try {
      const conversations = listConversations(opts.storage.db, safeLimit);
      return c.json({ conversations });
    } catch (err) {
      log.warn("list conversations failed:", err);
      return c.json({ error: "storage_error" }, 500);
    }
  });

  // 获取单个会话 + 它的全部 messages
  app.get("/api/conversations/:id", (c) => {
    const id = c.req.param("id");
    try {
      const conversation = getConversation(opts.storage.db, id);
      if (!conversation) return c.json({ error: "not_found" }, 404);
      const messages = listMessagesByConversation(opts.storage.db, id);
      return c.json({ conversation, messages });
    } catch (err) {
      log.warn("get conversation failed:", err);
      return c.json({ error: "storage_error" }, 500);
    }
  });

  // 列出 user profile(全部键值;M5/M7 才会用到,这里先暴露)
  app.get("/api/profile", (c) => {
    try {
      const profile = listProfile(opts.storage.db);
      return c.json({ profile });
    } catch (err) {
      log.warn("list profile failed:", err);
      return c.json({ error: "storage_error" }, 500);
    }
  });

  // upsert 一条 profile
  app.put("/api/profile/:key", async (c) => {
    const key = c.req.param("key");
    const body = (await c.req.json().catch(() => null)) as {
      value?: string;
      confidence?: number;
    } | null;
    if (!body || typeof body.value !== "string" || !body.value) {
      return c.json({ error: "value required" }, 400);
    }
    try {
      const confidence =
        typeof body.confidence === "number" && body.confidence >= 0 && body.confidence <= 1
          ? body.confidence
          : 0.7;
      upsertProfile(opts.storage.db, key, body.value, confidence);
      return c.json({ ok: true });
    } catch (err) {
      log.warn("upsert profile failed:", err);
      return c.json({ error: "storage_error" }, 500);
    }
  });

  // —— M4:ToolRegistry endpoints ——
  // 列出已注册工具的 { name, description }(不暴露 fn)。
  app.get("/api/tools/list", (c) => {
    return c.json({
      tools: tools.entries().map((e) => ({
        name: e.name,
        description: e.description ?? "",
      })),
    });
  });

  // 调用工具。
  //   body: { name, args? }
  //   resp 200: { ok: true, value }
  //   resp 400: { ok: false, error: { name: "TypeError", message, code?: "invalid_body" } }
  //   resp 404: { ok: false, error: { name: "ToolNotFoundError", message, code?: "tool_not_found" } }
  //   resp 500(由全局 onError 兜):工具 throw 原始 SandboxError/NetSandboxError,栈完整保留。
  app.post("/api/tools/invoke", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; args?: unknown } | null;
    if (!body || typeof body.name !== "string" || body.name.length === 0) {
      return c.json(
        {
          ok: false,
          error: {
            name: "TypeError",
            code: "invalid_body",
            message: "request body must be { name: string, args?: unknown }",
          },
        },
        400,
      );
    }
    const reg = tools.get(body.name);
    if (!reg) {
      return c.json(
        {
          ok: false,
          error: {
            name: "ToolNotFoundError",
            code: "tool_not_found",
            message: `tool not registered: ${body.name}`,
          },
        },
        404,
      );
    }
    // 不 wrap try/catch:让原始 SandboxError/NetSandboxError 抛出,走全局 onError 兜底成 500 JSON。
    // 这保留了 instance + stack trace,instanceof 检查在客户端仍有效。
    const value = await reg.fn(body.args);
    return c.json({ ok: true, value });
  });

  // 重置 Sansheng:删 db / keyring / settings / pi 目录(留 logs)
  app.post("/api/reset", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { confirm?: string } | null;
    if (body?.confirm !== "reset") {
      return c.json({ error: "confirmation required (pass {confirm:\"reset\"})" }, 400);
    }
    const targets = [
      join(opts.dataDir, "sansheng.db"),
      join(opts.dataDir, "sansheng.db-wal"),
      join(opts.dataDir, "sansheng.db-shm"),
      join(opts.dataDir, ".keyring"),
      join(opts.dataDir, "settings.json"),
      join(opts.dataDir, "pi"),
    ];
    const removed: string[] = [];
    const failed: string[] = [];
    // 先关 storage(SQLite) 释放文件句柄,不然 rm 会 win32/某些 fs 上失败
    try {
      opts.storage.close();
    } catch (err) {
      log.warn("storage close before reset:", err);
    }
    for (const t of targets) {
      try {
        if (existsSync(t)) {
          rmSync(t, { recursive: true, force: true });
          removed.push(t);
        }
      } catch (err) {
        failed.push(t);
        log.warn(`reset: failed to remove ${t}:`, err);
      }
    }
    log.warn(`reset via /api/reset: removed=${removed.length} failed=${failed.length}`);
    return c.json({ ok: true, removed, failed });
  });

  // —— 静态文件:生产构建产物(dist/web) ——
  // tsc rootDir=. → dist/src/server/http.js,需走三级上级到工程根
  const webRoot = resolve(__dirname, "../../../dist/web");
  if (existsSync(webRoot)) {
    app.use("/*", serveStatic({ root: webRoot }));
    app.get("*", (c) => {
      const htmlPath = join(webRoot, "index.html");
      if (existsSync(htmlPath)) return c.html(readFileSync(htmlPath, "utf-8"));
      return c.text("not built", 404);
    });
  } else {
    app.get("/", (c) =>
      c.html(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Sansheng · 三生</title></head>
<body style="background:#0B0F14;color:#E8E4D9;font-family:Inter,sans-serif;padding:48px;">
  <h1 style="font-weight:300;letter-spacing:.06em;color:#5E8B7E;">三生 · Sansheng</h1>
  <p style="color:#B7AE9D;">Web UI not built. <code style="color:#C76B4A">npm run build:web</code> first.</p>
</body></html>`),
    );
  }

  app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

  // —— 全局错误处理:任何 route handler 抛出的未捕获错误都返回 JSON,而不是 HTML —— 
  // 避免前端 fetch().json() 拿到 <!doctype... 抛 SyntaxError。
  // (例如 /api/memory/fragments 在 fragments 表缺失 / sqlite-vec 加载失败时会出错)
  app.onError((err, c) => {
    log.error(`unhandled route error on ${c.req.method} ${c.req.path}:`, err);
    return c.json(
      {
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
        path: c.req.path,
      },
      500,
    );
  });

  // —— Attach WebSocket ——
  attachWebSocket(opts.httpServer, opts.kernel, {
    storage: opts.storage,
    settingsStore: opts.settingsStore,
    dataDir: opts.dataDir,
  });

  return app;
}

function maskApiKey(k: string): string {
  if (!k) return "";
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}****${k.slice(-4)}`;
}