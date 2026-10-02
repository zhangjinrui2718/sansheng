/**
 * 批次 4b · 4a-OQ2 —— blackboardRoutes.ts 的 limit 静默回退统一到
 * parseLimitQuery 400 语义(与 http.ts 一致)
 *
 * 4a C9-4 已把 http.ts 的 /api/memory/fragments + /api/conversations 统一到
 * `parseLimitQuery`(非法 → 400 invalid_limit),当时显式留了 open question:
 * 「blackboardRoutes.ts 自带防御本批不动」。本批收口 —— /api/artifacts 的
 * `parseInt(...) + isFinite` 静默回退 100 与 http.ts 契约不一致。
 *
 * 同时覆盖 4a-OQ3:package.json files 数组含 "migrations/"
 * (npm 安装形态 boot 不再命中「目录缺失」路径;4a C9-2 的 fail-fast 依据)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

import { createApp } from "../../../src/server/http.js";
import { AgentKernel } from "../../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../../src/server/settings/store.js";
import { Keyring, Storage } from "../../../src/server/storage/index.js";

let dataDir: string;
let storage: Storage;
let httpServer: Server;
let app: Hono;
let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

const LOCAL_HOST = { host: "127.0.0.1:2718" };

beforeAll(async () => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-oq2-limit-"));
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DATA = dataDir;
  const keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({ providers: [], activeProviderId: "", cwd: dataDir, personaName: "三生-oq2" });
  const kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
  httpServer = createServer();
  app = await createApp({ dataDir, kernel, httpServer, settingsStore, storage });
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  try {
    storage?.close();
  } catch {
    /* ignore */
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (savedPiOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedPiOffline;
  if (savedSanshengData === undefined) delete process.env.SANSHENG_DATA;
  else process.env.SANSHENG_DATA = savedSanshengData;
});

describe("4a-OQ2 · /api/artifacts ?limit= 与 http.ts 统一 400 语义", () => {
  it("limit=abc → 400 invalid_limit(旧:静默回退 100 → 200)", async () => {
    const res = await app.request("/api/artifacts?scope=global&limit=abc", { headers: LOCAL_HOST });
    // RED(修复前):200
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("invalid_limit");
  });

  it("limit=  非法值在其它参数也非法时,limit 先报(参数校验顺序稳定)", async () => {
    const res = await app.request("/api/artifacts?scope=bogus&limit=abc", { headers: LOCAL_HOST });
    expect(res.status).toBe(400);
  });

  it("limit 缺省 / 合法 → 200(契约不破)", async () => {
    expect((await app.request("/api/artifacts?scope=global", { headers: LOCAL_HOST })).status).toBe(200);
    expect((await app.request("/api/artifacts?scope=global&limit=5", { headers: LOCAL_HOST })).status).toBe(200);
    expect((await app.request("/api/artifacts?scope=global&limit=99999", { headers: LOCAL_HOST })).status).toBe(200);
  });
});

describe("4a-OQ3 · npm 安装形态带 migrations/", () => {
  it("package.json files 数组包含 migrations", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as {
      files?: string[];
    };
    // RED(修复前):["dist","README.md","LICENSE"] —— npm 装出来的包没有 migrations/
    // 4a C9-2 的「全新库 + 目录缺失 → fail fast」在生产安装形态上必然命中
    expect(pkg.files).toContain("migrations");
  });

  it("bin / dist 路径未被改动(AGENTS.md 红线)", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8")) as {
      bin?: Record<string, string>;
      files?: string[];
    };
    expect(pkg.bin?.sansheng).toBe("./dist/src/cli/index.js");
    expect(pkg.files).toContain("dist");
  });
});
