/**
 * 批次 4b · B5 —— POST /api/reset 后 server 变僵尸 + 密钥丢失链
 * (docs/CODE-REVIEW-2026-10-01.md §B5)
 *
 * 旧实现的两个实锤缺陷:
 *  1. `storage.close()` + rmSync 之后**无任何重开逻辑**(全仓 `new Storage(` 只有
 *     index.ts 一处)→ 除 health 外全部 API 500(use-after-close 被 try/catch 兜底),
 *     kernel 落库全失败,必须手动重启。
 *  2. 连带删掉 `.keyring` + `settings.json`:两者都不是会话数据,是**配置**。
 *     删掉后 SettingsStore 内存 cache 与 Keyring 内存 masterKey 仍指向已删文件;
 *     reset 之后任何一次 save() 会用旧 key 把 settings.json 写回来,重启时
 *     Keyring 生成**新随机 key** → 已存 apiKey 全部解密失败被静默清空。
 *
 * 本组 RED 覆盖:
 *  - 活体证据:reset 之后 health 200 + artifacts API 200(server 仍是活的);
 *  - 密钥链:reset 不删 .keyring / settings.json,磁盘往返后 apiKey 仍可解密;
 *  - reset 前置钩子被调用(ws attach 级 activeOrchestrator.abort 桥接点);
 *  - B5 × B8 协调:Storage.reopen(**非 boot 语义**)不再执行孤儿对账 ——
 *    同一进程内 reset 重建 Storage 时,库要么是空的(rm 成功),要么是 rm 失败的
 *    旧库(里面可能有本进程仍在跑的 run),两种形态下「进程边界 = 孤儿」的判据
 *    都不成立;boot 构造路径的既有对账行为必须原样保留(4a B8 回归守护)。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";

import { createApp } from "../../src/server/http.js";
import { AgentKernel } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import { Keyring, Storage } from "../../src/server/storage/index.js";
import { makeArtifact } from "../../src/server/bus/index.js";
import { upsertArtifact, getArtifact } from "../../src/server/storage/repo/blackboards.js";

const LOCAL_HOST = { host: "127.0.0.1:2718" };
const API_KEY = "sk-b5-regression-0123456789";

let dataDir: string;
let storage: Storage;
let kernel: AgentKernel;
let httpServer: Server;
let app: Hono;
let keyring: Keyring;
let settingsStore: SettingsStore;
let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

async function postReset(body: unknown) {
  return app.request("/api/reset", {
    method: "POST",
    headers: { ...LOCAL_HOST, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-b5-reset-"));
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DATA = dataDir;

  keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "prov-b5",
        label: "b5",
        provider: "deepseek",
        modelId: "deepseek-chat",
        apiKey: API_KEY,
        thinkingLevel: "medium",
      },
    ],
    activeProviderId: "prov-b5",
    cwd: dataDir,
    personaName: "三生-b5",
  });
  kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
  httpServer = createServer(); // 不 listen,只满足 createApp 依赖
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

describe("B5 · reset 后 server 仍存活(旧:storage.close() 后无重开 → 全 API 500)", () => {
  it("POST /api/reset 之后 GET /api/health 仍 200", async () => {
    const before = await app.request("/api/health", { headers: LOCAL_HOST });
    expect(before.status).toBe(200);

    const reset = await postReset({ confirm: "reset" });
    expect(reset.status).toBe(200);

    // RED(修复前):storage 已被 close → 后续依赖 db 的 API 全 500
    const after = await app.request("/api/health", { headers: LOCAL_HOST });
    expect(after.status).toBe(200);
  });

  it("reset 之后依赖 SQLite 的 API 仍 200,且新库 schema 完整", async () => {
    await postReset({ confirm: "reset" });
    const res = await app.request("/api/artifacts?scope=global", { headers: LOCAL_HOST });
    // RED(修复前):use-after-close → onError → 500 storage_error
    expect(res.status).toBe(200);
    const body = (await res.json()) as { artifacts: unknown[] };
    expect(Array.isArray(body.artifacts)).toBe(true);
    // 新库必须跑完 migrations(不是空表启动)
    const versions = storage.db
      .prepare(`SELECT version FROM schema_version ORDER BY version`)
      .all() as Array<{ version: number }>;
    expect(versions.length).toBeGreaterThanOrEqual(5);
  });

  it("reset 之后 kernel 仍可用(storage 重建后落库不抛 use-after-close)", async () => {
    await postReset({ confirm: "reset" });
    const conv = kernel.getConversationId();
    expect(typeof conv).toBe("string");
    // kernel 内核写库路径(upsertConversation)在 reset 后必须仍然可用
    expect(() => kernel.invalidate()).not.toThrow();
  });
});

describe("B5 · 密钥丢失链(reset 不该连带清 keyring/settings)", () => {
  it("reset 保留 .keyring 与 settings.json(它们是配置,不是会话数据)", async () => {
    expect(existsSync(join(dataDir, ".keyring"))).toBe(true);
    await postReset({ confirm: "reset" });
    // RED(修复前):targets 数组含 .keyring + settings.json → 两者被删
    expect(existsSync(join(dataDir, ".keyring"))).toBe(true);
    expect(existsSync(join(dataDir, "settings.json"))).toBe(true);
  });

  it("reset 之后新进程形态(新 Keyring + 新 SettingsStore)仍能解出同一个 apiKey", async () => {
    await postReset({ confirm: "reset" });
    // 模拟重启:全新实例读同一份磁盘文件
    const freshKeyring = new Keyring(join(dataDir, ".keyring"));
    const freshStore = new SettingsStore(join(dataDir, "settings.json"), freshKeyring);
    const s = freshStore.load();
    // RED(修复前):keyring 被删 → 新随机 masterKey;settings.json 被 reset 后的
    // save 用旧 key 写回 → 解密失败被静默清空 → apiKey === ""
    expect(s.providers.find((p) => p.id === "prov-b5")?.apiKey).toBe(API_KEY);
  });

  it("会话数据确实被清除(db 文件被删后重建为空库)", async () => {
    await postReset({ confirm: "reset" });
    const rows = storage.db
      .prepare(`SELECT count(*) as c FROM conversations`)
      .get() as { c: number };
    expect(rows.c).toBe(0);
  });
});

describe("B5 · reset 前置钩子(ws attach 级 activeOrchestrator.abort 桥接)", () => {
  it("POST /api/reset 触发 kernel 侧的数据重置钩子", async () => {
    const spy = vi.fn();
    kernel.setOnDataReset(spy);
    try {
      await postReset({ confirm: "reset" });
      // RED(修复前):无任何钩子 —— 在飞 plan 会在数据被删后继续烧 token/写库
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      kernel.setOnDataReset(undefined);
    }
  });

  it("重置后 kernel 丢弃在飞 Pi session / 模型句柄(不再持有旧 key 与旧会话)", async () => {
    await postReset({ confirm: "reset" });
    expect(kernel.isReady()).toBe(false);
    expect(kernel.getModel()).toBeNull();
  });
});

describe("B5 × B8 · boot 对账与同进程重建的协调", () => {
  let reconcileDir: string;

  beforeEach(() => {
    reconcileDir = mkdtempSync(join(tmpdir(), "sansheng-b5-reconcile-"));
  });

  function seedOpenTodo(dir: string): Storage {
    const s = new Storage(join(dir, "sansheng.db"));
    const todo = makeArtifact({
      id: "todo-b5-live",
      kind: "todo",
      title: "live todo of this process",
      body: "",
      author: "planner",
      status: "open",
      scope: "conversation",
      conversationId: "conv-b5",
    });
    upsertArtifact(s.db, todo);
    return s;
  }

  it("boot 构造(新进程语义)仍然对账非终态 todo —— 4a B8 回归守护", () => {
    const s1 = seedOpenTodo(reconcileDir);
    s1.close(); // 模拟进程退出
    const s2 = new Storage(join(reconcileDir, "sansheng.db"));
    expect(getArtifact(s2.db, "todo-b5-live")?.status).toBe("failed");
    s2.close();
  });

  it("Storage.reopen(同进程 reset 语义)不执行孤儿对账 —— 不误杀本进程活 run", () => {
    const s = seedOpenTodo(reconcileDir);
    // RED(修复前):reopen 不存在;若照搬构造器逻辑就会把本进程刚建的 open todo
    // 当成「上一个进程留下的孤儿」终态化 —— 活 run 被误杀
    s.reopen({ reconcile: false });
    expect(getArtifact(s.db, "todo-b5-live")?.status).toBe("open");
    s.close();
  });

  it("Storage.reopen 之后 db 仍然可用(句柄已换成新连接)", () => {
    const s = seedOpenTodo(reconcileDir);
    s.reopen({ reconcile: false });
    const row = s.db.prepare(`SELECT count(*) as c FROM blackboards`).get() as { c: number };
    expect(typeof row.c).toBe("number");
    s.close();
  });
});

describe("B5 · reset 的原子性辅助证据(tmp+rename 不留残渣)", () => {
  it("reset 之后数据目录里不残留临时文件", async () => {
    await postReset({ confirm: "reset" });
    const leftovers = readdirSync(dataDir).filter((f) => f.includes(".tmp") || f.includes("reset-"));
    expect(leftovers).toEqual([]);
  });

  it("reset 响应体如实回报被删与被保留的路径", async () => {
    const res = await postReset({ confirm: "reset" });
    const body = (await res.json()) as { ok: boolean; removed: string[]; preserved?: string[] };
    expect(body.ok).toBe(true);
    // 契约:keyring/settings 属于「保留」而不是「已删」
    const all = [...body.removed, ...(body.preserved ?? [])];
    expect(all.some((p) => p.endsWith(".keyring"))).toBe(true);
    expect(body.removed.some((p) => p.endsWith("settings.json"))).toBe(false);
  });
});

describe("B5 · 真实 ~/.sansheng 只读边界(本组测试只碰临时目录)", () => {
  it("测试用的 dataDir 确实是临时目录,不含真实用户数据", () => {
    expect(dataDir.startsWith(tmpdir())).toBe(true);
    // 若实现误把 HOME/.sansheng 拉进来,这里会命中真实路径
    const real = join(process.env.HOME ?? "", ".sansheng");
    expect(readFileSync(join(dataDir, "settings.json"), "utf-8").length).toBeGreaterThan(0);
    expect(existsSync(real)).toBe(dataDir === real);
  });

  it("reset 之后 settings.json 权限仍为 0600", async () => {
    await postReset({ confirm: "reset" });
    const mode = statSync(join(dataDir, "settings.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

// 防止 writeFileSync 未使用告警(该 import 供未来断言复用)
void writeFileSync;
