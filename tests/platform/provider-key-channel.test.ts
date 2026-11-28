/**
 * Provider 凭据的通道(2026-11-28)· 回归 —— **明文 key 不进 `process.env`**
 *
 * ── 它补的是什么 ────────────────────────────────────────────────
 *
 * 在此之前,active provider 的 key 由 `syncActiveProviderApiKeyEnv()` 写进 `process.env`
 * (SDK 自建的 ModelRuntime 从 env 读凭据)。代价:会话里 spawn 的**每一个子进程** ——
 * 内置 `bash`、角色自己仓库里的 MCP 服务、docker —— 都继承得到它。真模型实验里研究员
 * 第一件事就是 `env | grep KEY`(它自己打了码)。
 *
 * 现在:平台自建 `ModelRuntime`(与 SDK 自建的同参数),key 经 `setRuntimeApiKey` 进它的
 * **内存**;`process.env` 一个字节都不写。本文件用**真的 SDK ModelRuntime** 验
 * (它不需要网络:`allowModelNetwork` 不开),只把最后的 `createAgentSession` 换成假的。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { createPlatformSession, type CreateSessionFn } from "../../src/platform/runtime/agentRuntime/pi/session.js";
import {
  armRuntimeApiKey, listProviders, platformModelRuntime, providerEnvKey, resolveModel,
} from "../../src/platform/runtime/agentRuntime/pi/providers.js";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { ensureOrg, ensureProjectOrg } from "../../src/platform/runtime/org.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { createGitWorkspace } from "../../src/platform/workspace/git.js";
import type { RuntimeDeps } from "../../src/platform/runtime/assembly.js";
import type Database from "better-sqlite3";

/** 有 env 映射的 provider(夹具要的是「以前靠 env 也拿得到 key」的那几家)。 */
const PROVIDERS = listProviders().filter((p) => p.models.length > 0 && providerEnvKey(p.id) !== undefined);

let db: Database.Database;
let dataDir: string;
let workRoot: string;

beforeEach(() => {
  db = openPlatformMemoryDb();
  ensureOrg(db, 1);
  insertProject(db, { id: "p1", name: "P", client: "甲", goal: "g", status: "active", createdAt: 1 });
  ensureProjectOrg(db, "p1", 1);
  dataDir = mkdtempSync(join(tmpdir(), "ss-key-channel-"));
  workRoot = mkdtempSync(join(tmpdir(), "ss-key-channel-work-"));
});
afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(workRoot, { recursive: true, force: true });
});

function fakeSession(): AgentSession {
  return {
    subscribe: () => () => {},
    prompt: async () => ({ messages: [] }),
    abort: async () => {},
    dispose() {},
    getActiveToolNames: () => [],
  } as unknown as AgentSession;
}

const deps = (): RuntimeDeps => ({ db, dataDir, workspaceRoot: workRoot, workspace: createGitWorkspace() });

/** 建一次会话,记下交给 `createAgentSession` 的参数。 */
async function build(opts: { apiKey?: string; provider?: string }): Promise<{
  result: ReturnType<typeof createPlatformSession> extends Promise<infer R> ? R : never;
  captured: Parameters<CreateSessionFn>[0];
}> {
  const provider = opts.provider ?? PROVIDERS[0]!.id;
  const modelId = listProviders().find((p) => p.id === provider)!.models[0]!.id;
  const model = resolveModel({ provider, modelId, apiKey: "k", baseUrl: null });
  if (model === null) throw new Error("夹具:模型解析不出来");
  const captured: Array<Parameters<CreateSessionFn>[0]> = [];
  const createSession: CreateSessionFn = async (o) => { captured.push(o); return { session: fakeSession() }; };
  const result = await createPlatformSession(deps(), "wk", "p1", {
    cwd: workRoot, agentDir: join(dataDir, "agent"), model, dataDir, createSession,
    ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
  });
  return { result, captured: captured[0]! };
}

describe("provider 凭据通道 · key 只进 ModelRuntime 的内存", () => {
  it("给了 apiKey ⇒ 平台自建 ModelRuntime、key 在它的内存里(运行期来源);`process.env` 没被写", async () => {
    const provider = PROVIDERS[0]!.id;
    const envKey = providerEnvKey(provider)!;
    const before = process.env[envKey];
    const { result, captured } = await build({ apiKey: "k-secret" });
    if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
    expect(result.wiring.credentialChannel).toBe("runtime");
    expect(captured.modelRuntime, "那份 runtime 必须真的交给 createAgentSession").toBeDefined();
    // 真 SDK 的 ModelRuntime:凭据来源是「runtime」,不是 env
    expect(captured.modelRuntime!.getProviderAuthStatus(provider)).toEqual({ configured: true, source: "runtime" });
    expect(process.env[envKey], "process.env 一个字节都不许写").toBe(before);
  });

  it("没给 apiKey ⇒ 走 SDK 自己的来源(auth.json / 用户 shell 的 env),不传 ModelRuntime", async () => {
    const { result, captured } = await build({});
    if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
    expect(result.wiring.credentialChannel).toBe("sdk_default");
    expect(captured.modelRuntime).toBeUndefined();
  });

  it("apiKey 是空串 ⇒ **不冒充** `runtime`(没设进去就别说走了运行期通道),交给 SDK 自己的来源", async () => {
    const { result } = await build({ apiKey: "" });
    if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
    expect(result.wiring.credentialChannel).toBe("sdk_default");
  });

  it("同一个 agentDir 复用同一份 ModelRuntime(不是每次建会话重建一份)", async () => {
    const a = await build({ apiKey: "k1" });
    const b = await build({ apiKey: "k1" });
    expect(a.captured.modelRuntime).toBeDefined();
    expect(b.captured.modelRuntime).toBe(a.captured.modelRuntime);
  });

  it("两家的 key 可以同时在内存里、互不覆盖(env 通道做不到:共用变量名的会互相冲掉)", async () => {
    const second = PROVIDERS.find((p) => p.id !== PROVIDERS[0]!.id);
    if (second === undefined) throw new Error("夹具:目录里找不到第二家 provider");
    const runtime = await platformModelRuntime(join(dataDir, "agent"));
    expect(await armRuntimeApiKey(runtime, PROVIDERS[0]!.id, "k-one")).toBe(true);
    expect(await armRuntimeApiKey(runtime, second.id, "k-two")).toBe(true);
    expect(runtime.getProviderAuthStatus(PROVIDERS[0]!.id)).toEqual({ configured: true, source: "runtime" });
    expect(runtime.getProviderAuthStatus(second.id)).toEqual({ configured: true, source: "runtime" });
    // 空 key 不设:交给 SDK 自己的来源
    expect(await armRuntimeApiKey(runtime, PROVIDERS[0]!.id, "")).toBe(false);
  });

  it("哨兵:`src/` 里不再有任何「往 process.env 赋值」的代码(那个函数也删了)", () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith(".ts")) continue;
        const src = readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
        if (/process\.env\[[^\]]+\]\s*=[^=]/.test(src) || /process\.env\.\w+\s*=[^=]/.test(src)) offenders.push(p);
        if (/syncActiveProviderApiKeyEnv/.test(src)) offenders.push(`${p}(还在调 syncActiveProviderApiKeyEnv)`);
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
    // 自检:检查器对已知样本必须命中(否则上面那条「没有」证明不了任何事)
    const hit = (s: string): boolean => /process\.env\[[^\]]+\]\s*=[^=]/.test(s.replace(/\/\*[\s\S]*?\*\//g, ""));
    expect(hit('process.env["K"] = "v";')).toBe(true);
    expect(hit('/* process.env["K"] = "v"; */ const a = 1;')).toBe(false);
  });
});
