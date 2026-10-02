/**
 * 批次 4b · B9 —— cancel_question 对 executor 回调问题完全无效 +
 *                 合成 question 不进 MessageBus
 * (docs/CODE-REVIEW-2026-10-01.md §B9)
 *
 * 旧实现的两个实锤:
 *  1. `handleExecutorCallback` 手工构造 `q-exec-*` BusMessage 直传
 *     `Communicator.handleWorkerAsk`,**未走 bus** → MessageBus.pending / stream /
 *     bus.jsonl 都没有它;`cancelPendingQuestion → bus.reply(id)` →
 *     「no pending question」→ false,waiting / watchdog / pendingExecutorCallbacks
 *     全不清理,用户点「取消」表面无报错,实际 todo 挂到 1 小时 failTimer。
 *  2. timeline / bus_replay 看不到 executor 提问(审计缺口,违背 PLAN.md bus 审计设计)。
 *
 * 修复契约:
 *  - 合成 question 进 MessageBus stream(可见、可审计、走既有 bus_event → ws);
 *  - `cancelPendingQuestion` 对 executor 回调问题返回 true,并同步通知
 *    Orchestrator 清 waiting + failTodo(不再挂满 1 小时);
 *  - D13 callbackReason 读取错位留 5c,本组不碰。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentKernel } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import { Keyring, Storage } from "../../src/server/storage/index.js";
import { artifactBus } from "../../src/server/bus/index.js";
import type { BusMessage } from "../../src/server/agents/messageBus.js";

let dataDir: string;
let storage: Storage;
let kernel: AgentKernel;
let settingsStore: SettingsStore;
let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

const EXEC_SESSION = "exec-b9-fixture";

beforeAll(async () => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-b9-cancel-"));
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DATA = dataDir;
  const keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "prov-b9",
        label: "b9",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-b9-0123456789abcdef",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "prov-b9",
    cwd: dataDir,
    personaName: "三生-b9",
  });
  kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
  // 真实 start()(PI_OFFLINE=1,不触网):ensureCommunicator 在这里建出 Communicator。
  // B9 的取消路径依赖 communicator 存在 —— pendingExecutorCallbacks 的登记发生在
  // handleWorkerAsk 之前,但 communicator 未就绪时整条升级链会被跳过
  // (与 ws-plan-integration 场景④同款前置条件)。
  await kernel.start();
}, 60_000);

afterAll(() => {
  try {
    kernel?.invalidate();
  } catch {
    /* ignore */
  }
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

async function askFromExecutor(): Promise<string> {
  await kernel.handleExecutorCallback(
    {
      todoId: "todo-b9-abcdef",
      reason: "judgment",
      hypothesisId: "hyp-b9-abcdef",
      executorSessionId: EXEC_SESSION,
    },
    kernel.getConversationId(),
  );
  const pending = [...kernelBusSnapshot()].filter(
    (m) => m.kind === "question" && m.id.startsWith("q-exec-"),
  );
  const last = pending.at(-1);
  if (!last) throw new Error("no q-exec question recorded in bus stream");
  return last.id;
}

function kernelBusSnapshot(): BusMessage[] {
  return kernel.getBus().snapshot();
}

describe("B9 · executor 合成 question 进 MessageBus stream(可审计)", () => {
  beforeEach(() => {
    kernel.getBus().clear();
  });

  it("handleExecutorCallback 之后,合成 question 出现在 bus stream 里", async () => {
    await askFromExecutor();
    const stream = kernelBusSnapshot();
    // RED(修复前):stream 为空 —— executor 提问是审计缺口
    const q = stream.find((m) => m.id.startsWith("q-exec-"));
    expect(q).toBeDefined();
    expect(q?.kind).toBe("question");
    expect(q?.fromRole).toBe("executor");
    expect(q?.context?.executorSessionId).toBe(EXEC_SESSION);
  });

  it("合成 question 也经 bus_event 广播(watchdog / timeline 可见)", async () => {
    const seen: string[] = [];
    const unsub = kernel.getBus().subscribe((m) => {
      seen.push(m.id);
    });
    try {
      const id = await askFromExecutor();
      expect(seen).toContain(id);
    } finally {
      unsub();
    }
  });
});

describe("B9 · cancel_question 对 executor 回调问题有效", () => {
  beforeEach(() => {
    kernel.getBus().clear();
  });

  it("取消 executor 提问返回 true(旧:false,用户点取消毫无反应)", async () => {
    const questionId = await askFromExecutor();
    // RED(修复前):communicator.cancelPending → bus.reply 无 pending → false
    expect(kernel.cancelPendingQuestion(questionId)).toBe(true);
  });

  it("取消后 executorCallback 映射被清空(不会二次触发 resume)", async () => {
    const questionId = await askFromExecutor();
    kernel.cancelPendingQuestion(questionId);
    const res = kernel.handleUserAnswer(questionId, "算了", kernel.getConversationId());
    // 取消后再回答 → 不应再写 decision / publish executor_resume
    expect(resumedFlag(res)).toBe(false);
  });

  it("取消会向 artifactBus 发 executor_cancel,携带 executorSessionId(供 Orchestrator 收尾)", async () => {
    const events: Array<{ executorSessionId: string; reason: string }> = [];
    const unsub = artifactBus.subscribe("executor_cancel", (e) => {
      events.push(e);
    });
    try {
      const questionId = await askFromExecutor();
      kernel.cancelPendingQuestion(questionId);
      // RED(修复前):无任何通知 → Orchestrator 的 waiting/watchdog 一直挂到 1h
      expect(events).toHaveLength(1);
      expect(events[0]?.executorSessionId).toBe(EXEC_SESSION);
      expect(typeof events[0]?.reason).toBe("string");
    } finally {
      unsub();
    }
  });

  it("取消一个不存在的 questionId → false(不伪造成功)", () => {
    expect(kernel.cancelPendingQuestion("q-does-not-exist")).toBe(false);
  });

  it("重复取消同一 questionId → 第二次 false(幂等语义)", async () => {
    const questionId = await askFromExecutor();
    expect(kernel.cancelPendingQuestion(questionId)).toBe(true);
    expect(kernel.cancelPendingQuestion(questionId)).toBe(false);
  });
});

function resumedFlag(res: { replied: boolean; resumed?: unknown }): boolean {
  return res.resumed !== undefined;
}

// vi 在本文件用于后续扩展(spy 预留),保持 import 被使用
void vi;
