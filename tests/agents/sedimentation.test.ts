/**
 * 批次 5b-2 · T1 — 回合后异步智能沉淀服务(单元)
 *
 * 契约(jev 裁决 A 方案:保流式,回合后异步提取 artifacts):
 *  ① 实质回合 → 严格 JSON artifacts(D7 schema:kind ∈ intent/hypothesis/note/decision)
 *     → 质量闸门(kind 白名单 / title≤60 / body<200 / 每回合≤3 / 同会话相似 title 去重)
 *     → upsertArtifact(conversation scope)+ artifactBus.publish("artifact_created")。
 *  ② 宁缺毋滥:模型输出空数组(寒暄回合)→ 不落库。
 *  ③ parse 失败 / LLM 抛错 / 超时(默认 ≤8s)/ 无模型 / SANSHENG_SEDIMENT=0 →
 *     静默跳过(返回 skipped + reason,绝不 throw,绝不影响主路径)。
 *  ④ DI seam:注入 llmCall 绕过 env 闸门与模型闸门(显式注入 = 显式测试意图,
 *     与 makeLlmCommunicatorDecide 同款语义)。
 *  ⑤ storage 故障不 throw(upsert 失败 → 该条丢弃,bus 不广播未落库的 artifact)。
 *
 * RED 基线(6fca0e2):src/server/agents/sedimentation.ts 不存在 → 本文件收集失败。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../src/server/storage/migrations.js";
import { Storage } from "../../src/server/storage/index.js";
import {
  sedimentTurn,
  SEDIMENT_SYSTEM_PROMPT,
  SEDIMENT_ALLOWED_KINDS,
  type SedimentLlmDeps,
  type SedimentTurnInput,
} from "../../src/server/agents/sedimentation.js";
import { artifactBus, makeArtifact } from "../../src/server/bus/index.js";
import { upsertArtifact, listArtifacts } from "../../src/server/storage/repo/blackboards.js";
import type { BlackboardArtifact } from "../../shared/types/blackboard.js";

const CONV = "conv-sed-unit";

function makeStorage(): { db: Database.Database; storage: Storage } {
  const db = new Database(":memory:");
  runMigrations(db);
  return { db, storage: new Storage(db) };
}

/** 不触网的假 model 桩(getModel 只判 null/非 null)。 */
const STUB_MODEL = { provider: "fake", id: "fake-model" } as never;

function depsWith(
  llmCall: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>,
  extra: Partial<SedimentLlmDeps> = {},
): SedimentLlmDeps {
  return { getModel: () => STUB_MODEL, llmCall, ...extra };
}

function baseInput(over: Partial<SedimentTurnInput> = {}): SedimentTurnInput {
  return {
    conversationId: CONV,
    userText: "我们决定把部署流程改成蓝绿部署,先在小流量上验证",
    assistantText: "好的,已记录:部署流程切换为蓝绿部署,小流量先行验证。",
    ...over,
  };
}

let db: Database.Database;
let storage: Storage;
let busSeen: BlackboardArtifact[];
let unsub: (() => void) | null = null;
let savedEnv: string | undefined;

beforeEach(() => {
  const s = makeStorage();
  db = s.db;
  storage = s.storage;
  busSeen = [];
  unsub = artifactBus.subscribe("artifact_created", (e) => {
    busSeen.push(e.artifact);
  });
  savedEnv = process.env.SANSHENG_SEDIMENT;
});

afterEach(() => {
  try { unsub?.(); } catch { /* ignore */ }
  unsub = null;
  try { storage?.close(); } catch { /* ignore */ }
  if (savedEnv === undefined) delete process.env.SANSHENG_SEDIMENT;
  else process.env.SANSHENG_SEDIMENT = savedEnv;
});

function dbArtifacts(): BlackboardArtifact[] {
  return listArtifacts(db, { scope: "conversation", conversationId: CONV, limit: 100 });
}

describe("batch5b-2 T1 · sedimentation 服务(单元)", () => {
  it("S1: 实质回合 → artifacts 入库(conversation scope)+ artifact_created bus 事件 + 注入绕过 env 闸门", async () => {
    // setup-env 已全局置 SANSHENG_SEDIMENT=0;注入 llmCall 必须绕过闸门(④)
    expect(process.env.SANSHENG_SEDIMENT).toBe("0");
    let captured: { systemPrompt: string; userPrompt: string } | null = null;
    const deps = depsWith(async (input) => {
      captured = input;
      return JSON.stringify({
        artifacts: [
          {
            kind: "decision",
            title: "部署流程切换为蓝绿部署",
            body: "先在小流量上验证,再全量切换。",
            author: "communicator",
          },
        ],
      });
    });

    const result = await sedimentTurn(deps, storage, baseInput());

    expect(result.status).toBe("stored");
    expect(result.artifacts).toHaveLength(1);
    const art = result.artifacts[0]!;
    expect(art.kind).toBe("decision");
    expect(art.scope).toBe("conversation");
    expect(art.conversationId).toBe(CONV);
    expect(art.author).toBe("communicator");
    expect(art.metadata?.source).toBe("sedimentation");
    // 落库
    const stored = dbArtifacts();
    expect(stored.some((a) => a.id === art.id && a.title === "部署流程切换为蓝绿部署")).toBe(true);
    // bus 广播(UI artifact_created 消费链路,批次 1/3 已接)
    expect(busSeen.some((a) => a.id === art.id)).toBe(true);
    // prompt 形态:system = 沉淀器协议(含质量闸门),user = 转录(本轮 user raw + assistant 回复)
    expect(captured).not.toBeNull();
    expect(captured!.systemPrompt).toBe(SEDIMENT_SYSTEM_PROMPT);
    expect(captured!.systemPrompt).toContain("宁缺毋滥");
    expect(captured!.userPrompt).toContain("蓝绿部署");
    expect(captured!.userPrompt).toContain("已记录");
  });

  it("S2: 寒暄回合(模型输出空数组)→ status=empty,不落库不广播", async () => {
    const deps = depsWith(async () => JSON.stringify({ artifacts: [] }));
    const result = await sedimentTurn(
      deps,
      storage,
      baseInput({ userText: "你好呀", assistantText: "你好!今天过得怎么样?" }),
    );
    expect(result.status).toBe("empty");
    expect(result.artifacts).toHaveLength(0);
    expect(dbArtifacts()).toHaveLength(0);
    expect(busSeen).toHaveLength(0);
  });

  it("S3: parse 失败(非 JSON 输出)→ skipped/parse_failed,静默不 throw 不落库", async () => {
    const deps = depsWith(async () => "抱歉,我无法按该格式输出。这是一段自然语言。");
    const result = await sedimentTurn(deps, storage, baseInput());
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("parse_failed");
    expect(dbArtifacts()).toHaveLength(0);
    // 绝不落「解析失败」降级 note(沉淀路径的 fallbackToNote 语义 = 丢弃)
    expect(busSeen).toHaveLength(0);
  });

  it("S4: llmCall 抛错 → skipped/llm_error,不 throw", async () => {
    const deps = depsWith(async () => {
      throw new Error("network down");
    });
    const result = await sedimentTurn(deps, storage, baseInput());
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("llm_error");
    expect(dbArtifacts()).toHaveLength(0);
  });

  it("S5: 超时(timeoutMs)→ skipped/timeout,不 throw", async () => {
    const deps = depsWith(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('{"artifacts":[]}'), 300)),
      { timeoutMs: 30 },
    );
    const result = await sedimentTurn(deps, storage, baseInput());
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("timeout");
    expect(dbArtifacts()).toHaveLength(0);
  });

  it("S6: 去重 — 同 conversation 已有相似 title(包含关系)→ 丢弃;批内重复 → 只留一条", async () => {
    // 预置已有 artifact(同会话)
    upsertArtifact(
      db,
      makeArtifact({
        kind: "note",
        title: "部署流程改用蓝绿方案",
        body: "既有记忆",
        author: "communicator",
        scope: "conversation",
        conversationId: CONV,
      }),
    );
    const deps = depsWith(async () =>
      JSON.stringify({
        artifacts: [
          { kind: "note", title: "部署流程改用蓝绿方案(补充说明)", body: "与既有 title 包含关系 → 去重" },
          { kind: "note", title: "批内重复标题", body: "第一条" },
          { kind: "note", title: "批内重复标题", body: "第二条 → 批内去重" },
          { kind: "note", title: "全新且不相似的主题:数据库备份策略", body: "保留" },
        ],
      }),
    );
    const result = await sedimentTurn(deps, storage, baseInput());
    expect(result.status).toBe("stored");
    const titles = result.artifacts.map((a) => a.title);
    expect(titles).not.toContain("部署流程改用蓝绿方案(补充说明)");
    expect(titles.filter((t) => t === "批内重复标题")).toHaveLength(1);
    expect(titles).toContain("全新且不相似的主题:数据库备份策略");
    expect(result.droppedByGate).toBeGreaterThanOrEqual(2);
    // DB 中新增的只有保留下来的
    const stored = dbArtifacts().filter((a) => a.metadata?.source === "sedimentation");
    expect(stored.map((a) => a.title).sort()).toEqual([...titles].sort());
  });

  it("S7: 质量闸门 — kind 白名单 / title≤60 / body<200 / 每回合≤3", async () => {
    const longTitle = "标".repeat(80);
    const longBody = "文".repeat(300);
    const deps = depsWith(async () =>
      JSON.stringify({
        artifacts: [
          { kind: "intent", title: "修复登录页样式错位", body: "按钮与输入框重叠。" },
          { kind: "todo", title: "不该出现的 todo", body: "kind 白名单外 → 丢弃" },
          { kind: "evidence", title: "不该出现的 evidence", body: "kind 白名单外 → 丢弃" },
          { kind: "note", title: longTitle, body: longBody },
          { kind: "hypothesis", title: "第四条假设", body: "超出每回合上限 → 丢弃" },
          { kind: "decision", title: "第二条决策", body: "保留" },
        ],
      }),
    );
    const result = await sedimentTurn(deps, storage, baseInput());
    expect(result.status).toBe("stored");
    expect(result.artifacts.length).toBeLessThanOrEqual(3);
    expect(result.artifacts.length).toBe(3);
    for (const a of result.artifacts) {
      expect(SEDIMENT_ALLOWED_KINDS.has(a.kind)).toBe(true);
      expect(a.title.length).toBeLessThanOrEqual(60);
      expect(a.body.length).toBeLessThan(200);
    }
    // todo/evidence 被 kind 闸门丢弃,超限被数量闸门丢弃
    expect(result.droppedByGate).toBeGreaterThanOrEqual(3);
    expect(result.artifacts.some((a) => a.kind === "todo" || a.kind === "evidence")).toBe(false);
  });

  it("S8: env 闸门 — SANSHENG_SEDIMENT=0 且未注入 → skipped/disabled,不触模型", async () => {
    process.env.SANSHENG_SEDIMENT = "0";
    let modelChecks = 0;
    const deps: SedimentLlmDeps = {
      getModel: () => {
        modelChecks++;
        return STUB_MODEL;
      },
    };
    const result = await sedimentTurn(deps, storage, baseInput());
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("disabled");
    expect(modelChecks).toBe(0); // 闸门先于模型检查,不触网
    expect(dbArtifacts()).toHaveLength(0);
  });

  it("S9: 无模型且未注入(闸门开)→ skipped/no_model", async () => {
    process.env.SANSHENG_SEDIMENT = "1";
    const deps: SedimentLlmDeps = { getModel: () => null };
    const result = await sedimentTurn(deps, storage, baseInput());
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("no_model");
  });

  it("S10: storage 故障(db 已关)→ 不 throw,不落库不广播", async () => {
    const broken = makeStorage();
    broken.storage.close();
    const deps = depsWith(async () =>
      JSON.stringify({ artifacts: [{ kind: "note", title: "落库会失败", body: "db 已关闭" }] }),
    );
    const result = await sedimentTurn(deps, broken.storage, baseInput());
    // 服务自身 resolve(kernel 侧另有 .catch 双保险);未落库的 artifact 不广播
    expect(result.artifacts).toHaveLength(0);
    expect(result.status).not.toBe("stored");
  });

  it("S11: 前文转录进 userPrompt(截断防跑飞),空 assistant+空 user → skipped/empty_turn", async () => {
    let captured = "";
    const deps = depsWith(async (input) => {
      captured = input.userPrompt;
      return JSON.stringify({ artifacts: [] });
    });
    await sedimentTurn(
      deps,
      storage,
      baseInput({
        recentTranscript: [
          { role: "user", content: "Earlier context about databases" },
          { role: "assistant", content: "Earlier reply about backups" },
        ],
      }),
    );
    expect(captured).toContain("Earlier context about databases");
    expect(captured).toContain("Earlier reply about backups");

    const empty = await sedimentTurn(deps, storage, baseInput({ userText: "  ", assistantText: "" }));
    expect(empty.status).toBe("skipped");
    expect(empty.reason).toBe("empty_turn");
  });
});
