/**
 * Sansheng Hono app factory.
 * M0 健康检查 + 静态文件。
 * M1 加入 /api/settings、/api/providers、/api/chat,并 attach WebSocket。
 * M3+ 注入多 agent / blackboard / artifacts 路由。
 */
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "../shared/log.js";
import { SettingsStore, type Settings } from "./settings/store.js";
import { listProviders } from "./providers/registry.js";
import type { AgentKernel } from "./kernel/agentKernel.js";
import type { Server } from "node:http";
import { attachWebSocket } from "./ws.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = import.meta.dirname ?? join(__filename, "..");

export interface AppOptions {
  dataDir: string;
  kernel: AgentKernel;
  httpServer: Server;
  settingsStore: SettingsStore;
}

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();

  // —— Logger middleware ——
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    log.muted(`${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
  });

  const settingsStore = opts.settingsStore;

  // —— 健康检查 ——
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      name: "sansheng",
      version: "0.1.0",
      ts: Date.now(),
      dataDir: opts.dataDir,
    }),
  );

  // —— 配置(meta) ——
  app.get("/api/config", (c) => {
    const cfg = settingsStore.load();
    return c.json({
      name: "sansheng",
      version: "0.1.0",
      host: process.env.SANSHENG_HOST ?? "127.0.0.1",
      port: Number(process.env.SANSHENG_PORT ?? 2718),
      features: {
        multiAgent: false,
        persistence: false,
        artifacts: false,
        harness: false,
        scheduler: false,
        chat: true,
      },
      kernelReady: opts.kernel.isReady(),
      conversationId: opts.kernel.getConversationId(),
      personaName: cfg.personaName,
    });
  });

  // —— Settings: GET ——
  // 返回时把 apiKey 屏蔽(只给前几位 + ***)
  app.get("/api/settings", (c) => {
    const s = settingsStore.load();
    return c.json({
      ...s,
      apiKey: maskApiKey(s.apiKey),
      hasApiKey: s.apiKey.length > 0,
    });
  });

  // —— Settings: PUT ——
  app.put("/api/settings", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<Settings> | null;
    if (!body) return c.json({ error: "invalid body" }, 400);
    const cur = settingsStore.load();
    // 如果 apiKey 是 masked 形式(全星号 或 包含 **** 中间片段),保留旧值
    // 避免"用户重新保存时不小心把显示用的 masked 串当成真 key 覆盖了真 key"
    let apiKey = body.apiKey ?? cur.apiKey;
    if (body.apiKey && isMaskedApiKey(body.apiKey)) apiKey = cur.apiKey;
    const next: Settings = {
      ...cur,
      ...body,
      apiKey,
    };
    settingsStore.save(next);
    return c.json({ ok: true, settings: { ...next, apiKey: maskApiKey(next.apiKey), hasApiKey: next.apiKey.length > 0 } });
  });

  // —— Providers catalog ——
  app.get("/api/providers", (c) => c.json({ providers: listProviders() }));

  // —— Test connection (PING via API key;后续 M1+ 加真发消息) ——
  app.post("/api/settings/test", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<Settings> | null;
    if (!body?.apiKey || !body.provider) return c.json({ ok: false, error: "missing fields" }, 400);
    return c.json({
      ok: true,
      message: "API key saved; runtime test will run on next /ws send",
      provider: body.provider,
      modelId: body.modelId,
    });
  });

  // —— 静态文件:生产构建产物(dist/web) ——
  const webRoot = resolve(__dirname, "../../dist/web");
  if (existsSync(webRoot)) {
    app.use(
      "/*",
      serveStatic({
        root: webRoot,
      }),
    );
    app.get("*", (c) => {
      const htmlPath = join(webRoot, "index.html");
      if (existsSync(htmlPath)) {
        return c.html(readFileSync(htmlPath, "utf-8"));
      }
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

  // —— 404 ——
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

/** 判断一个字符串是否是我们生成的 mask placeholder,防止它被当成真 key 写回去 */
function isMaskedApiKey(s: string): boolean {
  if (!s) return true; // 空串也算"没改"
  if (s === "****") return true;
  if (/^\*+$/.test(s)) return true; // 全是星号
  if (s.includes("****")) return true; // 包含我们的 mask 分隔符 "****"
  return false;
}