/**
 * 批次 4a · C9-4 — `?limit=abc` → NaN → better-sqlite3 datatype mismatch → 500(应 400)
 * (docs/CODE-REVIEW-2026-10-01.md §C9:http.ts /api/memory/fragments 无防御,
 *  对照 /api/conversations 既有 parseInt+isFinite 防御 → 不一致)
 *
 * 修复契约(统一语义,http.ts parseLimitQuery):
 *  - 缺省 → 默认值(clamp 到 [1, max]);
 *  - 非法(非有限数值,如 abc/NaN/Infinity)→ **400 invalid_limit**
 *    (客户端参数错误应显式拒绝:既不 500,也不静默吞成默认值);
 *  - 合法 → trunc + clamp。
 *  - /api/memory/fragments 与 /api/conversations 两个端点统一走同一 helper。
 *
 * harness:真实 createApp(与 security.test.ts 同模式,临时 dataDir +
 * SANSHENG_DATA/PI_OFFLINE 隔离,不触真实 ~/.sansheng;kernel 不 start —
 * 本组路由不依赖 Pi session)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

import { createApp } from "../../../src/server/http.js";
import { AgentKernel } from "../../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../../src/server/settings/store.js";
import { Keyring, Storage } from "../../../src/server/storage/index.js";

let dataDir: string;
let storage: Storage;
let kernel: AgentKernel;
let httpServer: Server;
let app: Hono;
let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

const LOCAL_HOST = { host: "127.0.0.1:2718" };

beforeAll(async () => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-c9-limit-"));
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DATA = dataDir;

  const keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [],
    activeProviderId: "",
    cwd: dataDir,
    personaName: "三生-c9",
  });
  kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
  httpServer = createServer(); // 不 listen,只满足 createApp 依赖
  app = await createApp({ dataDir, kernel, httpServer, settingsStore, storage });
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  try { storage?.close(); } catch { /* ignore */ }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (savedPiOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedPiOffline;
  if (savedSanshengData === undefined) delete process.env.SANSHENG_DATA;
  else process.env.SANSHENG_DATA = savedSanshengData;
});

describe("C9-4 · /api/memory/fragments ?limit= 校验", () => {
  it("limit=abc → 400(不再 500)", async () => {
    const res = await app.request("/api/memory/fragments?limit=abc", { headers: LOCAL_HOST });
    // RED(修复前):Number("abc")=NaN 直达 SQL LIMIT → better-sqlite3 throw → 500
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_limit");
  });

  it("kind=fact&limit=xyz → 400", async () => {
    const res = await app.request("/api/memory/fragments?kind=fact&limit=xyz", { headers: LOCAL_HOST });
    expect(res.status).toBe(400);
  });

  it("limit=5 合法 → 200;缺省 → 200(默认值)", async () => {
    const ok1 = await app.request("/api/memory/fragments?limit=5", { headers: LOCAL_HOST });
    expect(ok1.status).toBe(200);
    const ok2 = await app.request("/api/memory/fragments", { headers: LOCAL_HOST });
    expect(ok2.status).toBe(200);
  });
});

describe("C9-4 · /api/conversations ?limit= 统一语义", () => {
  it("limit=abc → 400(与 fragments 端点统一;旧行为是静默回退默认值)", async () => {
    const res = await app.request("/api/conversations?limit=abc", { headers: LOCAL_HOST });
    // RED(修复前):parseInt+isFinite 静默回退 50 → 200(端点间语义不一致)
    expect(res.status).toBe(400);
  });

  it("limit=50 合法 → 200", async () => {
    const res = await app.request("/api/conversations?limit=50", { headers: LOCAL_HOST });
    expect(res.status).toBe(200);
  });
});
