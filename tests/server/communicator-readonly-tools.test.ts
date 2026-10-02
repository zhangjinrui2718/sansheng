/**
 * 批次 5b-1 · P3 — 沟通员直答 session 工具限权(只读白名单)
 *
 * 架构裁决(jev A 方案,conf 1.00):沟通员从机制上杜绝直接干活 —— 一切改动类
 * 工作走 task→规划执行链路。P3 = 机制层保险:直答 session(kernel.createPiSession,
 * 唯一生产 createAgentSession 调用点)剥掉写/执行类工具(bash/edit/write/
 * powershell),只保留只读(read/grep/find/ls,即 SDK createReadOnlyTools 的
 * 工具面)—— 即使模型无视 prompt 约束想动手,也没有手可动。
 *
 * SDK 调研结论(node_modules/@earendil-works/pi-coding-agent@0.87.1):
 *  - CreateAgentSessionOptions 提供 `tools?: string[]`(allowlist)/
 *    `excludeTools?: string[]`(denylist)/ `noTools?: "all"|"builtin"`。
 *  - agent-session.js `_refreshToolRegistry`:`allowedToolNames` 对 builtin、
 *    extension-registered、SDK customTools **统一过滤**(isAllowedTool),且提供
 *    allowlist 时只有名单内工具会被激活 → 白名单是机制级硬约束,选它。
 *  - 只读工具面 = createReadOnlyTools(cwd) 的 read/grep/find/ls(ToolName 闭合
 *    联合:read|bash|powershell|edit|write|grep|find|ls)。
 *  - Executor(plan 链路)走 llmCall(completeSimple 单轮),根本不经 Pi session
 *    → 本限权与 plan 链路工具面零交集(「Executor 工具面绝不动」自动成立)。
 *
 * 断言方式:与 harness-prompt-injection.test.ts 同形态 —— 真实 createAgentSession
 * (PI_OFFLINE=1 不触网 + fake apiKey)+ AgentSession.getActiveToolNames()/
 * getAllTools()(SDK 公开 API)。RED(基线):默认 active tools = read/bash/edit/
 * write(可写可执行)→ 白名单断言红。
 *
 * ── 与既有测试的分工 ──
 *   - 本文件是**端到端**那一条(真 createAgentSession,断言 session 上真的激活了
 *     哪些工具);harness-tool-bridge.test.ts 守桥接层自身的语义(命名合规 /
 *     代理正确 / 错误可辨 / 沙箱真挡)。
 *
 * ⚠️ 批次 7-F 行为变更:直答 session 的 active tools 从 SDK 只读四件套扩到
 * **七件**(多 canvas_read / canvas_list / canvas_stat —— 7-F 桥接进来的
 * sansheng sandbox 只读工具)。**写与执行侧不变**:`bash` / `edit` / `write` /
 * `powershell` / `canvas_write` / `net_fetch` / `net_post` 一个都不许出现。
 * 扩的是「能看什么」,不是「能改什么」。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentKernel } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import { Keyring, Storage } from "../../src/server/storage/index.js";
import { roleToolCeiling } from "../../src/server/harness/tools.js";

/** 期望的只读面 = 该角色的架构上界全集(不在测试里复写一份名单 —— 单一事实源) */
const EXPECTED_READ_ONLY = [...roleToolCeiling("communicator")];
/** 写 / 执行 / 网络出口类工具 —— 直答 session 一个都不能有 */
const MUTATING = [
  "bash",
  "powershell",
  "edit",
  "write",
  "canvas_write",
  "net_fetch",
  "net_post",
];

let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

let dataDir: string;
let storage: Storage;
let kernel: AgentKernel;

beforeAll(() => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  process.env.PI_OFFLINE = "1";
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-readonly-tools-"));
  process.env.SANSHENG_DATA = dataDir;
  const keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "p-ro",
        label: "readonly-test",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-readonly-test-fake",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "p-ro",
    cwd: dataDir,
    personaName: "三生-readonly",
  });
  kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
});

afterAll(() => {
  try { kernel?.invalidate(); } catch { /* ignore */ }
  try { storage?.close(); } catch { /* ignore */ }
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  if (savedPiOffline === undefined) delete process.env.PI_OFFLINE;
  else process.env.PI_OFFLINE = savedPiOffline;
  if (savedSanshengData === undefined) delete process.env.SANSHENG_DATA;
  else process.env.SANSHENG_DATA = savedSanshengData;
});

describe("沟通员直答 session 只读工具白名单(批次 5b-1 P3 + 7-F 桥接)", () => {
  it("start() 后 active tools 恰好是上界全集;写/执行/网络出口全部不在(注册面也没有)", async () => {
    await kernel.start();
    const session = kernel.getSession();
    expect(session).toBeTruthy();

    // SDK 公开 API:当前激活工具名
    const active = session!.getActiveToolNames();
    for (const t of MUTATING) {
      expect(active, `active tools 不得含 ${t}(实际: ${active.join(",")})`).not.toContain(t);
    }
    // 只读工具应当在(read 是沟通员自查的最低能力面)
    expect(active).toContain("read");
    // 7-F:桥接进来的 canvas 只读三件套**真的激活了** —— 这是「桥接 + allowlist
    // 联合生效」的证明。customTools 必须同时过 isAllowedTool 过滤才会出现在这里。
    for (const t of ["canvas_read", "canvas_list", "canvas_stat"]) {
      expect(active, `7-F 桥接的 ${t} 未被激活 —— customTools 没能进 session`).toContain(t);
    }
    // 白名单封闭:active ⊆ 上界
    for (const t of active) {
      expect(EXPECTED_READ_ONLY, `active tool ${t} 必须在只读上界内`).toContain(t);
    }
    // 恰好等于上界(不多不少):多一个就是授权放宽,少一个就是桥接没生效
    expect([...active].sort()).toEqual([...EXPECTED_READ_ONLY].sort());

    // 注册面(getAllTools)同样过滤 —— allowlist 是机制级硬约束,不只是「未激活」
    const registered = session!.getAllTools().map((t) => t.name);
    for (const t of MUTATING) {
      expect(registered, `registry 不得含 ${t}`).not.toContain(t);
    }
  }, 90_000);

  it("resume() 重建 session 后限权仍生效(重建路径不漏)", async () => {
    const convId = kernel.getConversationId();
    await kernel.resume(convId);
    const session = kernel.getSession();
    expect(session).toBeTruthy();
    const active = session!.getActiveToolNames();
    for (const t of MUTATING) expect(active).not.toContain(t);
    expect(active).toContain("read");
    expect(active).toContain("canvas_read");
  }, 90_000);
});
