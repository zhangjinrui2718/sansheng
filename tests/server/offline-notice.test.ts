/**
 * 批次 5a.5 · T3 — 离线兜底(5a open question #2)
 *
 * 5a(B2 chat 双回复修复)删除 canned「已收到」占位后,PI_OFFLINE / 未配置
 * provider(kernel 无 Pi session)时用户发消息**完全静默**:decide chat 空
 * reply 不 sink,session 直答路径也不存在 —— 用户以为服务挂了。
 *
 * 修复:kernel.prompt() 的 !session 分支 emit error{code:"offline_no_session"}
 * (「当前离线,沟通员无法直答」)。选 error 事件形态 = 与前端 chat.ts 现有
 * `case "error"`(status:"error" + banner)消费兼容的最小方案,前端零改动。
 *
 * RED(旧代码):sink 只收到 start() 的内部诊断 no_provider,没有明确的
 * 「离线无法直答」提示事件。
 * 守护(修复前后都过):no_provider 诊断仍在(不被 T3 吞掉)、kernel 不崩。
 *
 * 不 mock SDK:无 provider 时 start() 在 createAgentSession 之前抛出,
 * 全程无网络、无 session 创建。临时目录,不碰真实 ~/.sansheng。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentKernel, type ServerEvent } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import { Keyring, Storage } from "../../src/server/storage/index.js";

let dataDir: string;
let storage: Storage;
let kernel: AgentKernel;
let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

beforeAll(() => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-offline-notice-"));
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DATA = dataDir;

  const keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  const settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  // 空 provider 配置 = 全新安装 / 离线环境形态
  settingsStore.save({
    providers: [],
    activeProviderId: "",
    cwd: dataDir,
    personaName: "三生-offline",
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

describe("kernel 离线兜底提示(批次 5a.5 T3)", () => {
  it("无 Pi session 时 prompt → emit error{code:offline_no_session},用户不再面对完全静默", async () => {
    const events: ServerEvent[] = [];
    const detach = kernel.attachSink((e) => events.push(e));
    try {
      await kernel.prompt("你好,有人在吗");

      // RED(旧代码):占位已删 + 无 session → chat 路径完全静默,无此事件
      const notice = events.find(
        (e): e is Extract<ServerEvent, { type: "error" }> =>
          e.type === "error" && e.error.code === "offline_no_session",
      );
      expect(notice).toBeTruthy();
      expect(notice!.error.message).toContain("离线");
      expect(notice!.error.message).toContain("无法直答");
      expect(notice!.conversationId).toBe(kernel.getConversationId());

      // 守护:start() 的 no_provider 内部诊断仍在(两个事件语义不同:诊断 vs 用户结论)
      expect(
        events.some((e) => e.type === "error" && e.error.code === "no_provider"),
      ).toBe(true);
      // 守护:kernel 状态不崩
      expect(kernel.isReady()).toBe(false);
    } finally {
      detach();
    }
  }, 20_000);
});
