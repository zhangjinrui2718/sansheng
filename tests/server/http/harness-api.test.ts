/**
 * 批次 5b-2 · T2 — HarnessManager boot 启动 + GET /api/harness 只读状态 API
 *
 * 契约:
 *  ① GET /api/harness:RED 基线(6fca0e2)404 → 修复后 200 + 真实字段:
 *     manager 运行态(running/stats/decideSource/startedAt)、harness prompts 摘要
 *     (6 角色,行数 + default/legacy_factory/user_edited/empty 状态 — loader 信息)、
 *     config(enabledTools/redLines/budget)、proposals/previews(blackboard storage
 *     真实数据,manager 自身无持久化 → 运行计数为内存态,notes 说明字段)。
 *  ② boot 接线:bootHarnessManager() 后 getHarnessManager() 单例存在且 isRunning();
 *     真实链路:harness_proposal 入库 + artifact_created 发布 → manager 消费 →
 *     implementation_preview 落库(stats.processed=1)→ API 可见。
 *  ③ 安全中间件覆盖确认(§B4):新 GET endpoint 自动落在 app.use("*") 安全守卫之后 —
 *     evil Host → 421;GET 豁免 Origin 校验(evil Origin → 仍 200,语义照旧)。
 *     本批**只读**,无 POST /api/harness(manager v0 无 apply 语义,无可安全暴露的
 *     mutation;POST 的 evil Origin 403 由既有 security.test.ts 覆盖)。
 *
 * harness 参照 security.test.ts:真实 createApp + 真实 AgentKernel(PI_OFFLINE)+
 * 临时 dataDir(不碰真实 ~/.sansheng;toolRegistry 显式注入 tmp sandbox/netPolicy,
 * 跳过 ~/.sansheng/{sandbox,net}.json 读盘)。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

import { createApp } from "../../../src/server/http.js";
import { AgentKernel } from "../../../src/server/kernel/agentKernel.js";
import { roleToolCeiling } from "../../../src/server/harness/tools.js";
import { SettingsStore } from "../../../src/server/settings/store.js";
import { Keyring, Storage } from "../../../src/server/storage/index.js";
import { ensureHarness } from "../../../src/server/harness/loader.js";
import { getHarnessManager } from "../../../src/server/agents/harnessManager.js";
import { artifactBus, makeArtifact } from "../../../src/server/bus/index.js";
import { upsertArtifact, listArtifacts } from "../../../src/server/storage/repo/blackboards.js";
import { Sandbox } from "../../../src/server/tools/sandbox.js";
import { resolveNetPolicy } from "../../../src/server/tools/netSandbox.js";

let dataDir: string;
let storage: Storage;
let kernel: AgentKernel;
let httpServer: Server;
let app: Hono;
let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

const VALID_PREVIEW_JSON = JSON.stringify({
  previewMarkdown:
    "## 概要\nAdd JWT issuer.\n\n## 目标文件\n- `src/server/auth/jwt.ts`\n\n## 风险与注意事项\nminor",
  riskLevel: "low",
  targetFiles: ["src/server/auth/jwt.ts"],
  estimatedLines: 40,
  mode: "create",
});

beforeAll(async () => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-harness-api-"));
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DATA = dataDir;

  const keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "p-ha",
        label: "ha-test",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-ha-test-fake",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "p-ha",
    cwd: dataDir,
    personaName: "三生-ha",
  });
  kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
  // 出厂 harness prompts 落盘(状态断言用;index.ts boot 同款调用)
  ensureHarness(dataDir);

  httpServer = createServer();
  app = await createApp({
    dataDir,
    kernel,
    httpServer,
    settingsStore,
    storage,
    // 测试卫生:显式 tmp sandbox/netPolicy → createToolRegistry 不读真实 ~/.sansheng
    toolRegistryOptions: {
      sandbox: new Sandbox({ homedir: dataDir }),
      netPolicy: resolveNetPolicy({ allowlist: [] }),
    },
  });
}, 60_000);

afterAll(async () => {
  try { getHarnessManager()?.stop(); } catch { /* ignore */ }
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

const LOCAL_HOST = { host: "127.0.0.1:2718" };

async function getHarness(headers: Record<string, string> = {}): Promise<Response> {
  return app.request("/api/harness", { method: "GET", headers: { ...LOCAL_HOST, ...headers } });
}

describe("batch5b-2 T2 · GET /api/harness(真实 createApp 接线)", () => {
  it("H1: 未 boot → 200 + manager.running=false + prompts 6 角色 default + config + 空 proposals/previews + notes(RED 基线:404)", async () => {
    const res = await getHarness();
    expect(res.status).toBe(200); // RED 基线:404 not_found
    const body = (await res.json()) as Record<string, never> & {
      manager: { running: boolean; stats: unknown; decideSource: unknown; startedAt: unknown };
      prompts: Array<{ role: string; lines: number; chars: number; state: string }>;
      toolSets: Array<{
        role: string;
        allowed: string[];
        blockedByCeiling: string[];
        enforced: boolean;
        source: string;
      }>;
      harnessManagerPrompt: { source: string; lines: number };
      config: { redLines: string[]; budget: Record<string, number> };
      proposals: unknown[];
      previews: unknown[];
      notes: string[];
    };
    expect(body.manager.running).toBe(false);
    expect(body.manager.stats).toBeNull();
    expect(Array.isArray(body.prompts)).toBe(true);
    expect(body.prompts.length).toBe(6);
    for (const p of body.prompts) {
      expect(p.lines).toBeGreaterThan(0);
      expect(p.state).toBe("default"); // ensureHarness 刚写出厂默认
    }
    expect(body.harnessManagerPrompt.source).toBeTruthy();
    expect(body.harnessManagerPrompt.lines).toBeGreaterThan(0);
    // 批次 7-E:toolSets 取代已删除的 config.enabledTools。
    // 断言的是**真实生效的那一个**(communicator),不是"字段存在"。
    expect(body.toolSets.length).toBe(7); // RoleKind 6 + harness_manager
    const comm = body.toolSets.find((t) => t.role === "communicator");
    // 名单从 roleToolCeiling 派生(7-F 起含 canvas_*),不在测试里写死
    expect(comm?.allowed).toEqual([...roleToolCeiling("communicator")]);
    expect(comm?.allowed).toContain("canvas_read");
    expect(comm?.enforced).toBe(true);
    expect(comm?.blockedByCeiling).toEqual([]);
    for (const t of body.toolSets) expect(t.source).toBe("factory");
    expect(Array.isArray(body.config.redLines)).toBe(true);
    expect(body.config.budget.maxIterations).toBeGreaterThan(0);
    expect(body.proposals).toEqual([]);
    expect(body.previews).toEqual([]);
    expect(body.notes.length).toBeGreaterThan(0); // manager 无持久化 → 说明字段
  });

  it("H2: 用户编辑过的 prompt → state=user_edited(loader 版本链信息透出)", async () => {
    const p = join(dataDir, "harness", "system_prompts", "planner.md");
    writeFileSync(p, `${readFileSync(p, "utf-8")}\n\n# 用户手笔:plan 上限改为 5 steps\n`, "utf-8");
    const res = await getHarness();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { prompts: Array<{ role: string; state: string }> };
    const planner = body.prompts.find((x) => x.role === "planner");
    expect(planner?.state).toBe("user_edited");
    // 其余角色仍是出厂默认
    const comm = body.prompts.find((x) => x.role === "communicator");
    expect(comm?.state).toBe("default");
  });

  it("H3: bootHarnessManager → 单例存在 + isRunning + API 运行态真实字段(RED 基线:模块不存在)", async () => {
    // 动态 import:RED 基线 harnessBoot.ts 不存在 → 本用例红,但不拖垮 H1 的 404 证据
    const { bootHarnessManager } = await import("../../../src/server/agents/harnessBoot.js");
    const mgr = bootHarnessManager({
      storage,
      kernel,
      decideFn: async () => VALID_PREVIEW_JSON, // DI seam(测试);生产默认 completeSimple(kernel.getModel())
    });
    expect(getHarnessManager()).toBe(mgr);
    expect(mgr.isRunning()).toBe(true);

    const res = await getHarness();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manager: {
        running: boolean;
        stats: Record<string, number> | null;
        decideSource: string | null;
        startedAt: number | null;
      };
    };
    expect(body.manager.running).toBe(true);
    expect(body.manager.decideSource).toBe("injected");
    expect(typeof body.manager.startedAt).toBe("number");
    expect(body.manager.stats).not.toBeNull();
    expect(body.manager.stats!.received).toBe(0);
    expect(body.manager.stats!.processed).toBe(0);
  });

  it("H4: 真实链路 — harness_proposal 入库+发布 → manager 消费 → preview 落库 → API 可见", async () => {
    const proposal = makeArtifact({
      kind: "harness_proposal",
      title: "Add JWT issuer",
      body: "Need JWT helper for mobile clients",
      scope: "global",
      author: "executor",
      status: "open",
      metadata: { category: "tool", riskLevel: "low", callbackReason: "harness_proposal" },
    });
    upsertArtifact(storage.db, proposal);
    artifactBus.publish({ type: "artifact_created", artifact: proposal });

    // manager 异步处理 → 轮询 storage 里出现 implementation_preview
    await vi.waitFor(
      () =>
        expect(
          listArtifacts(storage.db, { scope: "global", kind: "implementation_preview", limit: 50 })
            .length,
        ).toBe(1),
      { timeout: 5_000 },
    );

    const res = await getHarness();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      manager: { running: boolean; stats: Record<string, number> | null };
      proposals: Array<{ id: string; kind: string }>;
      previews: Array<{ id: string; kind: string; refs?: string[] }>;
    };
    expect(body.manager.running).toBe(true);
    expect(body.manager.stats!.received).toBe(1);
    expect(body.manager.stats!.processed).toBe(1);
    expect(body.proposals.some((a) => a.id === proposal.id)).toBe(true);
    expect(body.previews).toHaveLength(1);
    expect(body.previews[0]!.refs).toContain(proposal.id);

    // 清理:停 manager(避免影响后续用例的全局 bus)
    getHarnessManager()?.stop();
  });

  it("H5: 安全中间件覆盖确认 — evil Host → 421;GET 豁免 Origin(evil Origin → 200)", async () => {
    const evilHost = await app.request("/api/harness", {
      method: "GET",
      headers: { host: "evil.example.com" },
    });
    expect(evilHost.status).toBe(421);

    // GET 不做 Origin 拦截(§B4 语义照旧;本批未新增 POST 端点)
    const evilOrigin = await getHarness({ origin: "http://evil.example.com" });
    expect(evilOrigin.status).toBe(200);
  });
});
