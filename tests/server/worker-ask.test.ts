/**
 * 批次 7-L · kernel 侧集成:executor 卡住 → 沟通员先判一轮 → 答得了不问用户。
 *
 * 单元测试(tests/agents/worker-ask.test.ts)守的是 Communicator 的岔路口;
 * 本文件守的是**接线**:判断轮有没有真的被 kernel 构造出来、有没有真的被
 * handleExecutorCallback 用上、沟通员答完之后执行者是不是照常被 decision 恢复。
 *
 * 7-B 的教训是「提示词写了、注册表写了,但没人读」—— 那次是靠一个
 * 「enforced 单元的 consumer 路径必须能在 src/ 里 grep 到」才抓住的。
 * 同类风险在 7-L 这里同样存在,所以本文件用真实 kernel + 真实 store 跑一遍。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentKernel } from "../../src/server/kernel/agentKernel.js";
import { SettingsStore } from "../../src/server/settings/store.js";
import { Keyring, Storage, getArtifact, upsertArtifact } from "../../src/server/storage/index.js";
import { artifactBus, makeArtifact } from "../../src/server/bus/index.js";
import type { BusMessage } from "../../src/server/agents/messageBus.js";

const EXEC_SESSION = "exec-7l-fixture";
const HYP_ID = "hyp-7l-abcdef";

let dataDir: string;
let storage: Storage;
let settingsStore: SettingsStore;
let kernel: AgentKernel;
let savedPiOffline: string | undefined;
let savedSanshengData: string | undefined;

/** 收到过哪些 ws 事件(kernel.attachSink 收集),用来断言「用户有没有被打扰」。 */
let kernelEvents: Array<Record<string, unknown>> = [];

/** 判断轮 fake:由每个用例通过 setVerdict 控制。 */
let verdict = "answer";
let capturedPrompt = "";

beforeAll(async () => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-7l-workerask-"));
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DATA = dataDir;
  const keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "prov-7l",
        label: "7l",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-7l-0123456789abcdef",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "prov-7l",
    cwd: dataDir,
    personaName: "三生-7l",
  });
  kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage, {
    // DI seam(注入绕过 SANSHENG_WORKER_ASK=0 卫生闸门):精确控制判断轮结论
    workerAskLlmCall: async ({ userPrompt }) => {
      capturedPrompt = userPrompt;
      if (verdict === "answer") {
        return JSON.stringify({
          verdict: "answer",
          answer: "按方案 A 走,沿用现有命名。",
          basis: "方案 B 要改三处调用点,代价更大。",
        });
      }
      return JSON.stringify({
        verdict: "escalate",
        question: "删旧数据这一步现在做吗?",
        lean: "我倾向先 dry-run。",
        ruledOut: "已排除:重跑任务(同样不可逆且更慢)。",
      });
    },
  });
  await kernel.start();
  kernel.attachSink((e) => {
    kernelEvents.push(e as unknown as Record<string, unknown>);
  });

  // 造一条真的 hypothesis:7-L 起问题 payload 带它的全文,判断轮要读得到。
  upsertArtifact(
    storage.db,
    makeArtifact({
      id: HYP_ID,
      scope: "conversation",
      conversationId: kernel.getConversationId(),
      kind: "hypothesis",
      title: "这条升级路径要不要加沟通员判断轮?",
      body: "候选 A:executor → 沟通员 → 用户(多一跳,但用户被打扰少)。候选 B:维持直通用户。",
      author: "executor",
      status: "open",
    }),
  );
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

describe("7-L · 接线:判断轮真的被用上了(不是又一个死接线)", () => {
  it("verdict=answer → 没有任何 pending_question 发给用户", async () => {
    verdict = "answer";
    kernelEvents = [];
    const resumed: string[] = [];
    const off = artifactBus.subscribe("executor_resume", (e) => {
      resumed.push(e.decisionArtifactId);
    });
    try {
      await kernel.handleExecutorCallback(
        { todoId: "todo-7l-abcdef", reason: "judgment", hypothesisId: HYP_ID, executorSessionId: EXEC_SESSION },
        kernel.getConversationId(),
      );
    } finally {
      off();
    }

    // 用户侧零打扰 —— 7-L 之前这里必定有一条 pending_question
    expect(kernelEvents.filter((e) => e["type"] === "pending_question")).toEqual([]);
    // 但执行者被 decision 恢复了
    expect(resumed).toHaveLength(1);
    const dec = getArtifact(storage.db, resumed[0]!);
    expect(dec?.kind).toBe("decision");
    expect(dec?.body).toContain("按方案 A 走");
  }, 30_000);

  it("判断轮真的拿到了 hypothesis 全文(标题 + 候选方案 body)", async () => {
    expect(capturedPrompt).toContain("这条升级路径要不要加沟通员判断轮?");
    expect(capturedPrompt).toContain("候选 A");
  });

  it("总线上留下 comm→worker 的 reply —— 审计流能看到「沟通员自己答了」", async () => {
    verdict = "answer";
    await kernel.handleExecutorCallback(
      { todoId: "todo-7l-abcdef", reason: "judgment", hypothesisId: HYP_ID, executorSessionId: EXEC_SESSION },
      kernel.getConversationId(),
    );
    const reply = kernel.getBus().snapshot().find((m: BusMessage) => m.kind === "reply");
    expect(reply?.fromRole).toBe("communicator");
    expect(reply?.toRole).toBe("executor");
  }, 30_000);

  it("verdict=escalate → 问用户的是 q-comm-*,fromRole=communicator,且带上倾向", async () => {
    verdict = "escalate";
    kernelEvents = [];
    await kernel.handleExecutorCallback(
      { todoId: "todo-7l-abcdef", reason: "judgment", hypothesisId: HYP_ID, executorSessionId: EXEC_SESSION },
      kernel.getConversationId(),
    );

    const pending = kernelEvents.find((e) => e["type"] === "pending_question") as
      | { questionId: string; payload: string; fromRole: string }
      | undefined;
    expect(pending).toBeTruthy();
    // 7-L 之前这里是 q-exec-*(看起来像执行者直接找用户)
    expect(pending?.questionId).toMatch(/^q-comm-/);
    expect(pending?.fromRole).toBe("communicator");
    expect(pending?.payload).toContain("删旧数据这一步现在做吗?");
    expect(pending?.payload).toContain("我倾向先 dry-run。");

    // 用户回答沟通员的问题 → 执行者照常恢复(登记的是 q-comm-* 那个 id)
    const resumed: string[] = [];
    const off = artifactBus.subscribe("executor_resume", (e) => {
      resumed.push(e.decisionArtifactId);
    });
    try {
      const r = kernel.handleUserAnswer(pending!.questionId, "先 dry-run", kernel.getConversationId());
      expect(r.resumed).toBeDefined();
    } finally {
      off();
    }
    expect(resumed).toHaveLength(1);
    expect(getArtifact(storage.db, resumed[0]!)?.body).toBe("先 dry-run");
  }, 30_000);

  it("用户回答后重复回答同一问题 → 不再二次 resume(幂等)", async () => {
    verdict = "escalate";
    kernelEvents = [];
    await kernel.handleExecutorCallback(
      { todoId: "todo-7l-abcdef", reason: "judgment", hypothesisId: HYP_ID, executorSessionId: EXEC_SESSION },
      kernel.getConversationId(),
    );
    const pending = kernelEvents.find((e) => e["type"] === "pending_question") as
      | { questionId: string }
      | undefined;
    kernel.handleUserAnswer(pending!.questionId, "先 dry-run", kernel.getConversationId());
    const resumed: string[] = [];
    const off = artifactBus.subscribe("executor_resume", (e) => {
      resumed.push(e.decisionArtifactId);
    });
    try {
      const again = kernel.handleUserAnswer(pending!.questionId, "改主意了", kernel.getConversationId());
      expect(again.resumed).toBeUndefined();
    } finally {
      off();
    }
    expect(resumed).toEqual([]);
  }, 30_000);

  it("沟通员答完之后,原问题不再能被取消(已闭环,不是悬挂态)", async () => {
    verdict = "answer";
    await kernel.handleExecutorCallback(
      { todoId: "todo-7l-abcdef", reason: "judgment", hypothesisId: HYP_ID, executorSessionId: EXEC_SESSION },
      kernel.getConversationId(),
    );
    const q = kernel.getBus().snapshot().filter((m: BusMessage) => m.id.startsWith("q-exec-")).at(-1)!;
    expect(kernel.cancelPendingQuestion(q.id)).toBe(false);
  }, 30_000);
});
