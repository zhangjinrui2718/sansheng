/**
 * 批次 6 · P3 —— 会话级 legacy cwd 映射(kernel)
 *
 * `conversations.cwd` 是**会话级覆盖**,在旧出厂默认($HOME)期间被写成 `"/Users/fuyao"`。
 * settings 侧已经迁到 `~/sansheng-workspace`(批次 6 P2),但老会话行里的 `cwd` 还在
 * `$HOME`:kernel 的 `conv.cwd ?? this.cwd` 会让 resume 的老会话**继续把 agent 拉回整个家
 * 目录** —— 存量迁移只治 settings,治不了已经落库的行。
 *
 * 修复契约:conv.cwd 为空 **或等于旧默认($HOME)** → 继承 this.cwd(= settings.cwd);
 * 其它值(用户显式设过的项目目录等)原样保留。
 *
 * 覆盖:
 *  ⑤ conv.cwd === homedir → createAgentSession 收到 settings.cwd,agent_states 落 settings.cwd
 *  ⑤ conv.cwd === null(既有语义)→ 继承 settings.cwd
 *  ⑤ conv.cwd = 自定义目录 → 原样保留(不被误伤)
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

/* ── Fake Pi SDK:只替换 createAgentSession(与 kernel-concurrency 同款) ── */
const __t = vi.hoisted(() => ({
  createOpts: [] as Array<{ cwd?: string }>,
  reset() {
    this.createOpts.length = 0;
  },
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
  class FakeSession {
    isIdle = true;
    isStreaming = false;
    private listeners: Array<(ev: unknown) => void> = [];
    subscribe(listener: (ev: unknown) => void): () => void {
      this.listeners.push(listener);
      return () => {
        const i = this.listeners.indexOf(listener);
        if (i >= 0) this.listeners.splice(i, 1);
      };
    }
    async prompt(): Promise<void> {}
    abort(): void {}
    dispose(): void {
      this.listeners = [];
    }
  }
  return {
    createAgentSession: async (opts: { cwd?: string }) => {
      __t.createOpts.push(opts);
      return { session: new FakeSession() };
    },
    DefaultResourceLoader: class {
      async reload(): Promise<void> {}
    },
  };
});

import { AgentKernel } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import { Keyring, Storage, getAgentState, getConversation, upsertConversation } from "../../src/server/storage/index.js";

const tmpDirs: string[] = [];
let saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of ["PI_OFFLINE", "SANSHENG_DATA", "SANSHENG_DECIDE_LLM", "SANSHENG_SEDIMENT", "HOME"]) {
    saved[k] = process.env[k];
  }
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DECIDE_LLM = "0";
  process.env.SANSHENG_SEDIMENT = "0";
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const liveKernels: AgentKernel[] = [];
const openStorages: Storage[] = [];

afterEach(() => {
  for (const k of liveKernels.splice(0)) {
    try {
      k.invalidate();
    } catch {
      /* ignore */
    }
  }
  for (const s of openStorages.splice(0)) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
  __t.reset();
});

beforeEach(() => {
  __t.reset();
});

interface Stack {
  dataDir: string;
  /** 临时 HOME(= 本次测试里的「旧默认 $HOME」) */
  home: string;
  /** 冒充 settings.cwd 的工作根(放临时目录里,绝不碰真实家目录) */
  workspace: string;
  storage: Storage;
  settingsStore: SettingsStore;
  kernel: AgentKernel;
}

/**
 * cwd 用**回调**给出:cwd 的取值必须基于 makeStack 刚设好的临时 HOME,
 * 参数求值早于函数体(homedir() 直接写在实参里会拿到上一个测试残留的 HOME)。
 */
function makeStack(convs: Array<{ id: string; cwd: (home: string) => string | null }>): Stack {
  const dataDir = mkdtempSync(join(tmpdir(), "sansheng-b6-kernel-"));
  tmpDirs.push(dataDir);
  // 临时 HOME:homedir() 必须指向它,否则「旧默认 = $HOME」会撞上真实家目录
  const home = join(dataDir, "home");
  mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.SANSHENG_DATA = dataDir;

  const keyring = new Keyring(join(dataDir, ".keyring"));
  const storage = new Storage(join(dataDir, "sansheng.db"));
  openStorages.push(storage);
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  const workspace = join(dataDir, "workspace");
  settingsStore.save({
    providers: [
      {
        id: "p-b6",
        label: "b6-test",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-b6-fake",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "p-b6",
    cwd: workspace,
    personaName: "三生-b6",
  });

  for (const c of convs) {
    upsertConversation(storage.db, { id: c.id, cwd: c.cwd(home), modelId: "gpt-4o-mini", provider: "openai" });
  }

  // 生产同形态:cwd 来自 settings.cwd(createApp 注入),不是启动目录
  const kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), settingsStore.load().cwd, storage);
  liveKernels.push(kernel);
  return { dataDir, home, workspace, storage, settingsStore, kernel };
}

describe("批次 6 P3 · conv.cwd === 旧默认($HOME)→ 继承 settings.cwd", () => {
  it("⑤ resume 老会话:createAgentSession 收到 settings.cwd,不是 $HOME", async () => {
    const { home, workspace, kernel } = makeStack([{ id: "conv-legacy", cwd: (h) => h }]);
    expect(homedir()).toBe(home); // 前置:临时 HOME 已生效(旧默认就是它)

    await kernel.resume("conv-legacy");

    expect(__t.createOpts).toHaveLength(1);
    // RED(修复前):这里拿到的是 $HOME —— 老会话把 agent 拖回整个家目录
    expect(__t.createOpts[0]!.cwd).toBe(workspace);
    expect(__t.createOpts[0]!.cwd).not.toBe(home);
  });

  it("⑤ 落库的 agent_states.cwd 也是 settings.cwd(不把 $HOME 继续写下去)", async () => {
    const { storage, workspace, kernel } = makeStack([{ id: "conv-legacy2", cwd: (h) => h }]);

    await kernel.resume("conv-legacy2");

    expect(getAgentState(storage.db, "conv-legacy2")?.cwd).toBe(workspace);
    // conversations 行由 resume 末尾既有的 upsert 顺带治愈(COALESCE 非 null 即覆盖)
    expect(getConversation(storage.db, "conv-legacy2")?.cwd).toBe(workspace);
  });

  it("⑤ conv.cwd === null → 继承 settings.cwd(既有语义,守护不回归)", async () => {
    const { workspace, kernel } = makeStack([{ id: "conv-null", cwd: () => null }]);

    await kernel.resume("conv-null");

    expect(__t.createOpts[0]!.cwd).toBe(workspace);
  });

  it("⑤ conv.cwd = $HOME 的子目录 / 自定义目录 → 原样保留(不被 legacy 判定误伤)", async () => {
    const { home, storage, kernel } = makeStack([{ id: "conv-child", cwd: (h) => join(h, "projects", "mine") }]);
    const child = join(home, "projects", "mine");

    await kernel.resume("conv-child");

    expect(getAgentState(storage.db, "conv-child")?.cwd).toBe(child);
    expect(getConversation(storage.db, "conv-child")?.cwd).toBe(child);
  });
});
