/**
 * 批次 UI · U3 —— /api/health 暴露 vec 真实能力面(4a-OQ5)
 *
 * 问题:sqlite-vec 是 optionalDependencies 的平台二进制,装不上时 boot 不崩,
 * 碎片检索静默退回 text/importance 排序(功能不受影响)—— 但**用户完全看不到
 * 这件事**,只能凭「记忆好像变差了」猜。批次 4a-OQ5 要求把降级态暴露出来。
 *
 * 契约(本文件锁死):
 *  - health 必须带 `vecLoaded: boolean`;
 *  - 它取自 `isVecAvailable(storage.db)` —— fragments repo 自己的实时探测
 *    (碎片检索实际走的就是它),**不是** `Storage.vecLoaded` 那个「构造器是否
 *    加载成功」的历史标志:后者在 B5 的 reopen() 之后仍是首次构造时的值
 *    (storage/db.ts 字段注释自述「诊断用」),与当前连接的真实可用性会脱节;
 *  - 降级时其余 health 字段一个不能少(daemon 健康探测 / data-reset 回归都读它)。
 *
 * 两种状态都在本文件验证:vec 可用(生产真加载)与 vec 不可用(mock 掉 sqlite-vec
 * load,复用 batches/4a vec-load-failure.test.ts 的同一手法)。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("sqlite-vec", () => ({
  load: () => {
    throw new Error("Loadble extension for sqlite-vec not found. (simulated)");
  },
  getLoadablePath: () => {
    throw new Error("simulated: extension binary missing");
  },
}));

import { createApp } from "../../src/server/http.js";
import { AgentKernel } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import { Keyring, Storage } from "../../src/server/storage/index.js";

/** 批次 4b B4 安全中间件的 Host 白名单(与其它 http 测试同款)。 */
const LOCAL_HOST = { host: "127.0.0.1" };

let dataDir: string;
let kernel: AgentKernel;
let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

beforeAll(async () => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-u3-health-"));
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DATA = dataDir;
}, 60_000);

afterAll(() => {
  try {
    kernel?.invalidate();
  } catch {
    /* ignore */
  }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (savedPiOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedPiOffline;
  if (savedSanshengData === undefined) delete process.env.SANSHENG_DATA;
  else process.env.SANSHENG_DATA = savedSanshengData;
});

async function makeApp() {
  const keyring = new Keyring(join(dataDir, ".keyring"));
  const storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "prov-u3",
        label: "u3",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-u3-0123456789abcdef",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "prov-u3",
    cwd: dataDir,
    personaName: "三生-u3",
  });
  kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
  // createApp 会 attachWebSocket(httpServer, …) —— 给一个不 listen 的空 server 即可
  // (与 tests/server/http/security.test.ts 同款做法)。
  const httpServer: Server = createServer();
  return createApp({ dataDir, kernel, httpServer, settingsStore, storage });
}

describe("U3 · /api/health 暴露 vec 真实能力面", () => {
  it("vec 不可用(mock 掉 sqlite-vec load)→ vecLoaded=false 且其余字段不丢", async () => {
    const app = await makeApp();
    const res = await app.request("/api/health", { headers: LOCAL_HOST });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // 新字段:降级时必须如实报 false(这是前端降级提示的唯一数据源)
    expect(body.vecLoaded).toBe(false);
    // 既有字段一个都不能少(daemon 健康探测 / data-reset 回归都读这个端点)
    expect(body.ok).toBe(true);
    expect(body.name).toBe("sansheng");
    expect(typeof body.ts).toBe("number");
    expect(body.dataDir).toBe(dataDir);
  });

  it("vec 可用 → vecLoaded=true(不产生降级噪音)", async () => {
    vi.doUnmock("sqlite-vec");
    vi.resetModules();
    // 动态重新导入,拿到未 mock 的 sqlite-vec(生产真加载路径)
    const realVec = await import("sqlite-vec");
    vi.doMock("sqlite-vec", () => realVec);
    vi.resetModules();
    const [{ createApp: createAppFresh }, { Storage: StorageFresh }, { SettingsStore: SSFresh }, { Keyring: KeyringFresh }, { AgentKernel: KernelFresh }] =
      await Promise.all([
        import("../../src/server/http.js"),
        import("../../src/server/storage/index.js"),
        import("../../src/server/settings/store.js"),
        import("../../src/server/storage/index.js"),
        import("../../src/server/kernel/agentKernel.js"),
      ]);
    const keyring = new KeyringFresh(join(dataDir, ".keyring2"));
    const storage = new StorageFresh(join(dataDir, "sansheng-vec.db"));
    const settingsStore = new SSFresh(join(dataDir, "settings-vec.json"), keyring);
    settingsStore.save({
      providers: [
        {
          id: "prov-u3b",
          label: "u3b",
          provider: "openai",
          modelId: "gpt-4o-mini",
          apiKey: "sk-u3b-0123456789abcdef",
          thinkingLevel: "off",
        },
      ],
      activeProviderId: "prov-u3b",
      cwd: dataDir,
      personaName: "三生-u3b",
    });
    const k2 = new KernelFresh(settingsStore, join(dataDir, "pi2"), dataDir, storage);
    const httpServer = createServer();
    const app = await createAppFresh({ dataDir, kernel: k2, httpServer, settingsStore, storage });
    try {
      const res = await app.request("/api/health", { headers: LOCAL_HOST });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.vecLoaded).toBe(true);
    } finally {
      k2.invalidate();
    }
  });
});
