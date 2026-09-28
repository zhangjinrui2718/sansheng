/**
 * Sansheng HTTP/WS server entry.
 * - `sansheng start` (CLI) 调用 startServer()
 * - 后台 fork 启动时,直接 `node dist/server/index.js --host ...`
 */
import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./http.js";
import { log } from "../shared/log.js";
import { ensureDirs } from "../cli/commands.js";
import { SettingsStore } from "./settings/store.js";
import { AgentKernel } from "./kernel/agentKernel.js";
import { attachWebSocket } from "./ws.js";
import { join } from "node:path";
import type { Server } from "node:http";

export interface ServerOptions {
  host: string;
  port: number;
  dataDir: string;
}

export async function startServer(opts: ServerOptions): Promise<void> {
  ensureDirs();
  process.env.SANSHENG_DATA = opts.dataDir;
  // Pi SDK 在没网络或网络慢时会卡 ModelRuntime.refresh(~15s timeout),
  // 导致 createAgentSession() 长时间挂起、ready 发不出来。
  // Sansheng 用本地 catalog(provider+model 都在 builtin),不需要远程刷新。
  process.env.PI_OFFLINE = process.env.PI_OFFLINE ?? "1";

  const settingsStore = new SettingsStore(join(opts.dataDir, "settings.json"));
  const settings = settingsStore.load();
  const agentDir = join(opts.dataDir, "pi");
  const kernel = new AgentKernel(settingsStore, agentDir, settings.cwd);

  // 先建一个 placeholder app 占 fetch,只是为了 listen
  const placeholder = createApp({ dataDir: opts.dataDir, kernel, httpServer: createServer(), settingsStore });
  const httpServer = serve(
    { fetch: placeholder.fetch, port: opts.port, hostname: opts.host },
    (info) => {
      log.ok(`Sansheng listening on http://${info.address}:${info.port}`);
      log.muted(`data dir: ${opts.dataDir}`);
      log.muted(`pid: ${process.pid}`);
      if (process.env.SANSHENG_OPEN === "1") {
        import("open").then(({ default: opener }) => {
          opener(`http://${opts.host}:${opts.port}`).catch(() => {});
        });
      }
    },
  );

  // 拿到真正的 http.Server,再 attach WebSocket(WS 监听同一个 server 的 upgrade 事件)
  attachWebSocket(httpServer as unknown as Server, kernel);

  // daemon 模式响应 SIGTERM
  if (process.env.SANSHENG_DAEMON === "1") {
    process.on("SIGTERM", () => {
      log.muted("SIGTERM received, closing server");
      httpServer.close();
      process.exit(0);
    });
  }
}

// 作为独立模块被 fork 启动时
if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  const hostIdx = argv.indexOf("--host");
  const portIdx = argv.indexOf("--port");
  const host: string = hostIdx >= 0 && argv[hostIdx + 1] ? (argv[hostIdx + 1] as string) : "127.0.0.1";
  const portStr: string = portIdx >= 0 && argv[portIdx + 1] ? (argv[portIdx + 1] as string) : "2718";
  const homeDir = process.env.HOME ?? "/root";
  const dataDir: string = process.env.SANSHENG_DATA ?? `${homeDir}/.sansheng`;
  startServer({ host, port: Number(portStr), dataDir }).catch((err) => {
    log.error("failed to start server:", err);
    process.exit(1);
  });
}