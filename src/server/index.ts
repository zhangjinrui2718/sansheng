/**
 * Sansheng HTTP/WS server entry.
 * - `sansheng start` (CLI) 调用 startServer()
 * - 后台 fork 启动时,直接 `node dist/server/index.js --host ...`
 */
import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { createApp } from "./http.js";
import { log } from "../shared/log.js";
import { ensureDirs, clearOwnPidFile } from "../cli/commands.js";
import { SettingsStore } from "./settings/store.js";
import { AgentKernel } from "./kernel/agentKernel.js";
import { attachWebSocket } from "./ws.js";
import { Keyring, Storage } from "./storage/index.js";
import { ensureHarness } from "./harness/loader.js";
// 批次 5b-2 T2(审查 §B1):HarnessManager boot 启动 + 只读状态 API 数据源
import { bootHarnessManager } from "./agents/harnessBoot.js";
import { getHarnessManager } from "./agents/harnessManager.js";
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

  // M3b: 生成 harness 默认文件(planner/executor/critic/memory/reflection 的 system_prompts)
  try {
    ensureHarness(opts.dataDir);
  } catch (err) {
    log.warn("ensureHarness failed:", err);
  }

  // M2:Keyring(apiKey 加密)+ Storage(SQLite 持久化)
  const keyring = new Keyring(join(opts.dataDir, ".keyring"));
  const storage = new Storage(join(opts.dataDir, "sansheng.db"));

  const settingsStore = new SettingsStore(join(opts.dataDir, "settings.json"), keyring);
  const settings = settingsStore.load();
  const agentDir = join(opts.dataDir, "pi");
  const kernel = new AgentKernel(settingsStore, agentDir, settings.cwd, storage);

  // 批次 5b-2 T2(审查 §B1:harnessManager.ts 562 行生产从不启动 = 死代码):
  // boot 即订阅 artifactBus artifact_created,等 harness_proposal → 产只读
  // implementation_preview(v0 不写文件)。生产 decideFn = completeSimple
  // (kernel.getModel());无模型时 decideFn throw → manager 写失败 note(可见失败)。
  // proposals 生产发射点当前不存在(executor D13 待 5c)→ 启动即待命,
  // GET /api/harness 如实暴露运行态,不造假数据。
  try {
    bootHarnessManager({ storage, kernel });
  } catch (err) {
    log.warn("harness manager boot failed:", err);
  }

  // 先建一个 placeholder app 占 fetch,只是为了 listen
  const placeholder = await createApp({ dataDir: opts.dataDir, kernel, httpServer: createServer(), settingsStore, storage });
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
  attachWebSocket(httpServer as unknown as Server, kernel, {
    storage,
    settingsStore,
    dataDir: opts.dataDir,
  });

  // B10-6:SIGTERM 优雅退出不再限 daemon 模式 —— 前台 start 也写 pid 文件,
  // runStop 对前台进程同样发 SIGTERM;daemon 路径行为不变。
  process.on("SIGTERM", () => {
    log.muted("SIGTERM received, closing server");
    try {
      getHarnessManager()?.stop(); // 5b-2:退订 artifactBus
      httpServer.close();
      storage.close();
    } catch (err) {
      log.warn("shutdown close failed:", err);
    }
    process.exit(0);
  });

  // 进程退出兜底:关 SQLite + 删自己的 pid 文件(B10-6)。
  // SIGINT/SIGTERM/崩溃退出都会触发 exit 事件 → 不再残留 stale pid;
  // clearOwnPidFile 只在 pid 文件指向本进程时删除(防误删新实例的 pid)。
  const closeStorage = () => {
    try {
      getHarnessManager()?.stop(); // 5b-2:退订 artifactBus
    } catch {}
    try {
      storage.close();
    } catch {}
    clearOwnPidFile();
  };
  process.on("exit", closeStorage);
  process.on("SIGINT", () => {
    closeStorage();
    process.exit(0);
  });
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