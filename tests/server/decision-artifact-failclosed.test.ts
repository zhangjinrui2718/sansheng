/**
 * 批次 UI · U4 —— decision artifact 落库失败即 fail-closed
 * (docs/CODE-REVIEW-2026-10-01.md §B8 遗留,4b 备案未做;本批做掉)
 *
 * 旧实现的实锤(agentKernel.ts handleUserAnswer):
 *   ```ts
 *   try { upsertArtifact(this.storage.db, decision); }
 *   catch (err) { log.warn(...); }          // ← 只 warn
 *   artifactBus.publish({ type: "artifact_created", artifact: decision });
 *   artifactBus.publish({ type: "executor_resume", ... });
 *   ```
 * 落库失败却仍 publish `executor_resume` → Orchestrator 收到后用
 * `decisionArtifactId` 重启 executor,而这个 id 在库里**根本不存在**:
 *   - executor_resume 的消费方(Orchestrator)按 id 回查 artifact 拿 decision 正文,
 *     查不到 → 拿不到用户刚做的决定(这正是 §A4 修的那个链路);
 *   - 事件广播却告诉全进程「这个 decision 存在」——审计面撒谎;
 *   - 用户在工件页永远看不到自己刚做的决定,而 executor 却像收到过一样继续跑。
 *
 * 契约(本文件锁死):
 *   - 成功路径不变:落库 + artifact_created + executor_resume 三件事都发生,
 *     返回 resumed{...}(ws-plan-integration 场景④依赖,回归守护);
 *   - 失败路径:不落库 → 不 publish 任何事件,返回**不含** resumed
 *     (调用方 ws.ts 的 `if (!replied && !resumed)` 会照常按 replied=true 处理,
 *      不伪造 resumed 成功信号)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const EXEC_SESSION = "exec-u4-fixture";

beforeAll(async () => {
  savedPiOffline = process.env.PI_OFFLINE;
  savedSanshengData = process.env.SANSHENG_DATA;
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-u4-decision-"));
  process.env.PI_OFFLINE = "1";
  process.env.SANSHENG_DATA = dataDir;
  const keyring = new Keyring(join(dataDir, ".keyring"));
  storage = new Storage(join(dataDir, "sansheng.db"));
  settingsStore = new SettingsStore(join(dataDir, "settings.json"), keyring);
  settingsStore.save({
    providers: [
      {
        id: "prov-u4",
        label: "u4",
        provider: "openai",
        modelId: "gpt-4o-mini",
        apiKey: "sk-u4-0123456789abcdef",
        thinkingLevel: "off",
      },
    ],
    activeProviderId: "prov-u4",
    cwd: dataDir,
    personaName: "三生-u4",
  });
  kernel = new AgentKernel(settingsStore, join(dataDir, "pi"), dataDir, storage);
  // 真实 start()(PI_OFFLINE=1,不触网):合成 question 进 MessageBus 需要 communicator
  // 就绪(与 ws-plan-integration 场景④ / executor-cancel 同一前置条件)。
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

/** 走真实 executor 提问链路拿到一个 q-exec-* questionId。 */
async function askFromExecutor(): Promise<string> {
  await kernel.handleExecutorCallback(
    {
      todoId: "todo-u4-abcdef",
      reason: "judgment",
      hypothesisId: "hyp-u4-abcdef",
      executorSessionId: EXEC_SESSION,
    },
    kernel.getConversationId(),
  );
  const pending = kernel
    .getBus()
    .snapshot()
    .filter((m: BusMessage) => m.kind === "question" && m.id.startsWith("q-exec-"));
  const last = pending.at(-1);
  if (!last) throw new Error("no q-exec question recorded in bus stream");
  return last.id;
}

describe("U4 · decision artifact 落库成功 → 事件照发(回归守护)", () => {
  it("成功路径:artifact_created + executor_resume 都 publish,返回 resumed", async () => {
    const qid = await askFromExecutor();
    const created: string[] = [];
    const resumed: string[] = [];
    const offCreated = artifactBus.subscribe("artifact_created", (e) => {
      created.push(e.artifact.id);
    });
    const offResume = artifactBus.subscribe("executor_resume", (e) => {
      resumed.push(e.decisionArtifactId);
    });
    try {
      const r = kernel.handleUserAnswer(qid, "就按 A 方案走", kernel.getConversationId());
      // 注:replied 对 q-exec-* 恒 false(B9 遗留:合成 question 进 bus stream 但不在
      // MessageBus.pending,bus.reply 找不到)—— 本组只锁 executor_resume 契约。
      expect(r.resumed).toBeDefined();
      expect(created).toEqual([r.resumed?.decisionArtifactId]);
      expect(resumed).toEqual([r.resumed?.decisionArtifactId]);
    } finally {
      offCreated();
      offResume();
    }
  });
});

describe("U4 · decision artifact 落库失败 → fail-closed(不 publish)", () => {
  it("RED(修复前):upsertArtifact 抛错后仍 publish executor_resume(向全进程撒谎 decision 已落库)", async () => {
    const qid = await askFromExecutor();
    // 确定性制造 storage 失败:artifacts 实际存在 blackboards 表的 artifacts_json 列,
    // 删掉该表 → ensureArtifactBlackboard 的 INSERT 必 throw(no such table)。
    storage.db.exec("DROP TABLE blackboards");
    const created: string[] = [];
    const resumed: string[] = [];
    const offCreated = artifactBus.subscribe("artifact_created", (e) => {
      created.push(e.artifact.id);
    });
    const offResume = artifactBus.subscribe("executor_resume", (e) => {
      resumed.push(e.decisionArtifactId);
    });
    try {
      const r = kernel.handleUserAnswer(qid, "这个决定没法落库", kernel.getConversationId());
      // 落库失败 → 不得有任何 artifact_created / executor_resume 广播
      expect(created).toEqual([]);
      expect(resumed).toEqual([]);
      // 也不得向上层谎报 resumed
      expect(r.resumed).toBeUndefined();
    } finally {
      offCreated();
      offResume();
    }
  });
});
