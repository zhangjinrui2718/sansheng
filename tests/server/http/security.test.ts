/**
 * Sansheng · B4 回归测试:HTTP Origin/Host 校验 + WS 握手 Origin 校验
 *
 * 来源:docs/CODE-REVIEW-2026-10-01.md §B4(CSRF 删库面)。
 *
 * 缺陷形态(修复前):http.ts 全文无 Origin/Host/Sec-Fetch-Site 校验;
 * 任意网页 `fetch('http://127.0.0.1:2718/api/reset',{method:'POST',
 * body:'{"confirm":"reset"}'})`(text/plain 简单请求,无预检)即可删库;
 * WS 握手同样无 Origin 校验。
 *
 * 修复语义(单用户本地服务):
 *  - Host 校验(全部方法):hostname ∈ {127.0.0.1, localhost, ::1}(任意端口)
 *    否则 421 — 防 DNS rebinding;
 *  - Origin 校验(仅 POST/PUT/PATCH/DELETE):无 Origin 头 → 放行(curl/CLI);
 *    有 Origin → hostname 必须 ∈ 同一白名单(任意端口 — hostname 级已够防
 *    CSRF,端口级会破坏 vite dev proxy 5173→2718);否则 403;
 *  - Sec-Fetch-Site: cross-site → 直接 403(新浏览器信号,恶意页无法伪造);
 *  - GET/HEAD 不做 Origin 拦截(SPA 静态资源/浏览器直开);
 *  - WS upgrade:有 Origin → hostname 白名单;无 Origin → 放行。
 *
 * 测试走**真实 createApp 生产接线**(与 ws-plan-integration 同模式:真实
 * AgentKernel PI_OFFLINE + 真实 Storage 临时目录 + 真实 httpServer/ws client),
 * 证明的是"中间件注册在 createApp 里生效",而非孤立中间件单测。
 * 本文件刻意只 import 既有模块 — RED 状态(修复前)即可运行取失败原文。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

import { createApp } from "../../../src/server/http.js";
import { AgentKernel } from "../../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../../src/server/settings/store.js";
import { Keyring, Storage } from "../../../src/server/storage/index.js";
import type { Hono } from "hono";

/* ────────────────────────────────────────────────────────── *
 * 主栈:真实 createApp(所有非破坏性 case 共用)
 * ────────────────────────────────────────────────────────── */

let dataDir: string;
let storage: Storage;
let kernel: AgentKernel;
let httpServer: Server;
let app: Hono;
let port: number;
let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

beforeAll(async () => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-b4-security-"));
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DATA = dataDir;

  const keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "p-b4",
        label: "b4-test",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-b4-test-fake",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "p-b4",
    cwd: dataDir,
    personaName: "三生-b4",
  });

  kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
  await kernel.start(() => {});

  httpServer = createServer();
  app = await createApp({ dataDir, kernel, httpServer, settingsStore, storage });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  port = (httpServer.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  if (httpServer) {
    httpServer.closeAllConnections?.();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
  try { kernel?.invalidate(); } catch { /* ignore */ }
  try { storage?.close(); } catch { /* ignore */ }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (savedPiOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedPiOffline;
  if (savedSanshengData === undefined) delete process.env.SANSHENG_DATA;
  else process.env.SANSHENG_DATA = savedSanshengData;
});

/* ────────────────────────────────────────────────────────── *
 * helpers
 * ────────────────────────────────────────────────────────── */

const LOCAL_HOST = { host: "127.0.0.1:2718" };

function postReset(headers: Record<string, string> = {}, body = "{}") {
  return app.request("/api/reset", {
    method: "POST",
    headers: { ...LOCAL_HOST, "content-type": "application/json", ...headers },
    body,
  });
}

function connectWs(origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    // ws client 的 origin 选项即 Origin 头(只设一处,避免重复头被 node http 逗号合并)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, origin ? { origin } : {});
    ws.once("open", () => resolve(ws));
    ws.once("error", (err) => reject(err));
  });
}

async function closeWs(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => resolve(), 500);
      ws.once("close", () => { clearTimeout(t); resolve(); });
      ws.close();
    });
  }
}

/* ────────────────────────────────────────────────────────── *
 * HTTP:Origin / Sec-Fetch-Site / Host
 * ────────────────────────────────────────────────────────── */

describe("B4 · HTTP Origin/Host 校验(真实 createApp 接线)", () => {
  it("evil Origin POST /api/reset → 403(RED 现状:400 直达 handler)", async () => {
    const res = await postReset({ origin: "http://evil.example" });
    expect(res.status).toBe(403);
  });

  it("evil Origin(https)POST /api/reset → 403", async () => {
    const res = await postReset({ origin: "https://attacker.test" });
    expect(res.status).toBe(403);
  });

  it("Origin: null(sandboxed iframe)POST → 403", async () => {
    const res = await postReset({ origin: "null" });
    expect(res.status).toBe(403);
  });

  it("Sec-Fetch-Site: cross-site(无 Origin)POST → 403(RED 现状:400)", async () => {
    const res = await postReset({ "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
  });

  it("无 Origin POST → 放行到 handler(curl/CLI 非浏览器客户端,400=confirm 校验)", async () => {
    const res = await postReset();
    expect(res.status).toBe(400); // {error:"confirmation required..."} — 到达本体
  });

  it("localhost Origin(vite dev 端口 5173)POST → 放行(hostname 级白名单)", async () => {
    const res = await postReset({ origin: "http://localhost:5173" });
    expect(res.status).toBe(400);
  });

  it("127.0.0.1 Origin(生产端口)POST → 放行", async () => {
    const res = await postReset({ origin: "http://127.0.0.1:2718" });
    expect(res.status).toBe(400);
  });

  it("[::1] Origin POST → 放行", async () => {
    const res = await postReset({ origin: "http://[::1]:2718" });
    expect(res.status).toBe(400);
  });

  it("Sec-Fetch-Site: same-origin POST → 放行", async () => {
    const res = await postReset({ "sec-fetch-site": "same-origin" });
    expect(res.status).toBe(400);
  });

  it("evil Host 头 POST → 421(RED 现状:400)", async () => {
    const res = await postReset({ host: "evil.example.com:2718" });
    expect(res.status).toBe(421);
  });

  it("evil Host 头 GET /api/health → 421(DNS rebinding 防线,RED 现状:200)", async () => {
    const res = await app.request("/api/health", {
      method: "GET",
      headers: { host: "evil.example.com" },
    });
    expect(res.status).toBe(421);
  });

  it("evil Origin GET → 不拦(GET/HEAD 豁免 Origin 校验,SPA/浏览器直开)", async () => {
    const res = await app.request("/api/health", {
      method: "GET",
      headers: { ...LOCAL_HOST, origin: "http://evil.example" },
    });
    expect(res.status).toBe(200);
  });

  it("evil Origin POST /api/tools/invoke → 403(RED 现状:404 直达工具路由)", async () => {
    const res = await app.request("/api/tools/invoke", {
      method: "POST",
      headers: { ...LOCAL_HOST, origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ name: "nope" }),
    });
    expect(res.status).toBe(403);
  });
});

/* ────────────────────────────────────────────────────────── *
 * WS 握手 Origin
 * ────────────────────────────────────────────────────────── */

describe("B4 · WS 握手 Origin 校验(真实 attachWebSocket upgrade 钩子)", () => {
  it("evil Origin → 拒连(RED 现状:open 成功)", async () => {
    let opened: WebSocket | null = null;
    let err: unknown = null;
    try {
      opened = await connectWs("http://evil.example");
    } catch (e) {
      err = e;
    }
    if (opened) await closeWs(opened);
    // RED(修复前):opened = 已 open 的 WebSocket(恶意页可直连 ws 驱动 kernel)
    expect(opened, "evil Origin WS 握手不应成功").toBeNull();
    expect(err).toBeInstanceOf(Error);
  });

  it("无 Origin → 正常连接(批次 1 集成测试同款形态,不得破坏)", async () => {
    const ws = await connectWs();
    try {
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      await closeWs(ws);
    }
  });

  it("localhost:5173 Origin(vite dev proxy)→ 正常连接", async () => {
    const ws = await connectWs("http://localhost:5173");
    try {
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      await closeWs(ws);
    }
  });
});

/* ────────────────────────────────────────────────────────── *
 * 破坏性终局 case:独立第二套栈 — evil Origin + 合法 confirm body
 * RED 现状:200 且 dataDir2 里 db/settings/keyring 被真实删除(CSRF 删库实证)
 * ────────────────────────────────────────────────────────── */

describe("B4 · CSRF 删库面终局验证(独立栈,放最后)", () => {
  it('evil Origin POST /api/reset {"confirm":"reset"} → 403 且数据文件完好', async () => {
    const dataDir2 = mkdtempSync(join(tmpdir(), "sansheng-b4-destructive-"));
    const keyring2 = new Keyring(join(dataDir2, ".keyring"));
    const storage2 = new Storage(join(dataDir2, "sansheng.db"));
    const settingsStore2 = new SettingsStore(join(dataDir2, "settings.json"), keyring2);
    settingsStore2.save({
      providers: [],
      activeProviderId: "",
      cwd: dataDir2,
      personaName: "b4-destructive",
    });
    const kernel2 = new AgentKernel(settingsStore2, join(dataDir2, "pi"), dataDir2, storage2);
    const httpServer2 = createServer(); // 不 listen,只满足 createApp 依赖
    try {
      const app2 = await createApp({
        dataDir: dataDir2,
        kernel: kernel2,
        httpServer: httpServer2,
        settingsStore: settingsStore2,
        storage: storage2,
      });
      const res = await app2.request("/api/reset", {
        method: "POST",
        headers: { ...LOCAL_HOST, origin: "http://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ confirm: "reset" }),
      });
      // RED(修复前):status=200,sansheng.db/settings.json/.keyring 已被 rmSync
      expect(res.status, `CSRF 删库穿透:evil Origin 拿到 ${res.status}`).toBe(403);
      expect(existsSync(join(dataDir2, "sansheng.db"))).toBe(true);
      expect(existsSync(join(dataDir2, "settings.json"))).toBe(true);
      expect(existsSync(join(dataDir2, ".keyring"))).toBe(true);
    } finally {
      try { storage2.close(); } catch { /* RED 状态下 reset 已 close 过 */ }
      await new Promise<void>((resolve) => httpServer2.close(() => resolve()));
      rmSync(dataDir2, { recursive: true, force: true });
    }
  });
});
