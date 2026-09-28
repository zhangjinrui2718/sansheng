/**
 * Sansheng Hono app factory.
 * M0 健康检查 + 静态文件。
 * M1 /api/settings、/api/providers、WS。
 * M1.5 多 provider + 新建对话。
 * M3+ 注入多 agent / blackboard / artifacts 路由。
 */
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { log } from "../shared/log.js";
import { SettingsStore, genProviderId, isMaskedApiKey, type ProviderConfig, type ThinkingLevel } from "./settings/store.js";
import { listProviders } from "./providers/registry.js";
import type { AgentKernel, ServerEvent } from "./kernel/agentKernel.js";
import { attachWebSocket } from "./ws.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = import.meta.dirname ?? join(__filename, "..");

export interface AppOptions {
  dataDir: string;
  kernel: AgentKernel;
  httpServer: Server;
  settingsStore: SettingsStore;
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

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();
  const settingsStore = opts.settingsStore;

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

  // —— 静态文件:生产构建产物(dist/web) ——
  const webRoot = resolve(__dirname, "../../dist/web");
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

  // —— Attach WebSocket ——
  attachWebSocket(opts.httpServer, opts.kernel);

  return app;
}

function maskApiKey(k: string): string {
  if (!k) return "";
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}****${k.slice(-4)}`;
}