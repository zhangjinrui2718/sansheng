/**
 * W2-③ · 把 W1-① 的契约接到调用点 + 「没留工作记录」检测器
 *
 * ── 这批测试钉的三件事 ──────────────────────────────────────────
 *
 *   ① **`drainProject` 把 `todo.kind` 真的传下去**(`DrainDeps.runAgentTurn` /
 *      `DrainDeps.runWork` 的第三形参)。这是 W2-③ 里唯一「传错了也没有任何
 *      测试能抓住」的一半 —— 契约面(`shared/types/platform.ts` 的
 *      `TurnTrigger`)只保证**类型**,保证不了**值来自哪**。
 *      有牙的判据是**两个不同的待办类别**都必须原样到达(**负样本:写死
 *      `"execute_work"` ⇒ 第二段立刻红**)。
 *   ② **`detectUnannouncedTurn` 的判据**(纯函数):工件触发 + 没调 `tell_client`
 *      + 正文没有行首 `[未播报]` ⇒ 命中;四类负样本各自不命中。
 *   ③ **宿主的接线与产物**(真 `createPlatformHost`):排空叫醒业务经理时,
 *      `message_start` 封套上带的是**那条待办的真值**;而没留工作记录的回合
 *      会落一条**平台自己的** `system` 告警,且那条告警里**没有**被平台补写的
 *      `[未播报]` 行(编造现场比没有现场更坏)。
 *
 * ── 为什么第 ③ 组要起真宿主 ────────────────────────────────────
 *
 * `serve.ts` 的接线是 `(agentId, task, todoKind) => runAgentTurn(…, { kind:"todo",
 * todoKind })`。把 `todoKind` 换成字面量**编译得过**(它仍在 `TriggerTodoKind`
 * 闭集里),所以 `tsc` 抓不住 —— 只有一条真的把待办跑过去的测试抓得住。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertAsk } from "../../src/platform/storage/repo/asks.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { insertWork, updateWorkStatus } from "../../src/platform/storage/repo/works.js";
import { ensureProjectOrg } from "../../src/platform/runtime/org.js";
import {
  drainProject, type DrainTurnReport, type DrainWorkReport, type TodoKind,
} from "../../src/platform/runtime/dispatcher.js";
import { listProviders } from "../../src/platform/infra/providers.js";
import {
  createPlatformHost, detectUnannouncedTurn, type PlatformHost,
} from "../../src/platform/host/serve.js";
import type { TurnTrigger } from "@shared/types/platform.js";
import type { CreateSessionFn } from "../../src/platform/runtime/session.js";

const T0 = 1_700_000_000_000;

const okTurn: DrainTurnReport = {
  aborted: false, timedOut: false, text: "好了", toolCalls: [],
};

// ════════════════════════════════════════════════════════════════
// ① 排空器 → 宿主的 `todoKind` 透传
// ════════════════════════════════════════════════════════════════

describe("① `drainProject` 把 `todo.kind` 原样传给两条回合路(不是字面量)", () => {
  let db: Database.Database;
  let seq = 0;
  const newId = (p: string) => `${p}_${++seq}`;

  beforeEach(() => {
    seq = 0;
    db = openPlatformMemoryDb();
    insertProject(db, {
      id: "pA", name: "执行那条路", client: "甲", goal: "g", status: "active", createdAt: T0,
    });
    insertProject(db, {
      id: "pB", name: "汇报那条路", client: "甲", goal: "g", status: "active", createdAt: T0,
    });
    ensureProjectOrg(db, "pA", T0);
    ensureProjectOrg(db, "pB", T0);
  });
  afterEach(() => db.close());

  it("`execute_work` 与 `report_downstream` 各自到达对应那条路(写死任何一个值都会红)", async () => {
    /** 每个回合**实际收到**的 `todoKind`(以及它走的是哪条路) */
    const seen: Array<{ via: "runAgentTurn" | "runWork"; todoKind: TodoKind }> = [];

    // ── 现场 A:一条分派给 worker 的 open 工作项 ⇒ 唯一的待办是 `execute_work`,
    //    它走 `runWork`(工作项执行那条路)。
    const idA = newId("wk");
    insertWork(db, {
      id: idA, projectId: "pA", parentWorkId: null,
      title: "调研路线 A", goal: "写出对比结论", status: "open",
      assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
    });
    const rA = await drainProject({
      db, projectId: "pA", now: () => T0, log: () => {}, maxRounds: 1,
      runAgentTurn: async () => { throw new Error("现场 A 只有工作项待办,不该走聊天那条路"); },
      runWork: async (agentId, workId, todoKind): Promise<DrainWorkReport> => {
        seen.push({ via: "runWork", todoKind });
        return {
          workId, title: "调研路线 A", status: "open",
          aborted: false, timedOut: false, text: "", toolCalls: [],
        };
      },
    });

    // ── 现场 B:一条**下游事件**(根工作项终态 written 到 outbox)⇒ 唯一的待办是
    //    `report_downstream`,它走 `runAgentTurn`(聊天那条路),角色是业务经理。
    //
    //    「唯一」是刻意构造的:工作项已终态且已审 ⇒ 没有 `review_work`;
    //    根上挂着 `deliverable`(status `open`)⇒ `integrate` 的终止判据成立、
    //    而 `handover` 的资格判据(`accepted`)不成立;项目里有工作项 ⇒ 没有
    //    `decompose_project`。
    const idB = newId("wk");
    insertWork(db, {
      id: idB, projectId: "pB", parentWorkId: null,
      title: "交付物", goal: "g", status: "open",
      assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
    });
    updateWorkStatus(db, idB, "done", T0 + 5);
    db.prepare(`UPDATE works SET review_state = 'done' WHERE id = ?`).run(idB);
    insertArtifact(db, {
      id: newId("art"), projectId: "pB", conversationId: null,
      kind: "deliverable", status: "open", authorAgentId: "pm",
      title: "交付物", body: "现场", metadataJson: null,
      createdAt: T0 + 6, updatedAt: T0 + 6, workId: idB,
    });
    const rB = await drainProject({
      db, projectId: "pB", now: () => T0 + 10, log: () => {}, maxRounds: 1,
      reportBatchSize: 1, // 合并窗口关掉:有一条事件就叫醒
      runAgentTurn: async (agentId, _task, todoKind): Promise<DrainTurnReport> => {
        seen.push({ via: "runAgentTurn", todoKind });
        return okTurn;
      },
      runWork: async () => { throw new Error("现场 B 的待办不是工作项,不该走执行那条路"); },
    });

    // 两个现场的待办类别先各自钉住(否则下面的「跟着变」可能两段都是同一件事)
    expect(rA.visited.map((v) => v.kind)).toEqual(["execute_work"]);
    expect(rB.visited.map((v) => v.kind)).toEqual(["report_downstream"]);
    expect(rA.visited[0]!.agentId).toBe("wk");
    expect(rB.visited[0]!.agentId).toBe("bm");

    // ★ 判据:传下去的 `todoKind` **逐条等于**排空器自己记的 `visited[].kind`。
    expect(seen).toEqual([
      { via: "runWork", todoKind: "execute_work" },
      { via: "runAgentTurn", todoKind: "report_downstream" },
    ]);

    // ★ **有牙**的那一条:两个值必须**不同**。把 `drainOne` 里任何一处
    //   写成字面量(`todo.kind` → `"execute_work"`)都会让上一行或这一行红。
    expect(
      new Set(seen.map((s) => s.todoKind)).size,
      `两条待办的类别必须都原样到达 —— 现场:${JSON.stringify(seen)}`,
    ).toBe(2);
  });
});

// ════════════════════════════════════════════════════════════════
// ② 检测器判据(纯函数)
// ════════════════════════════════════════════════════════════════

describe("② `detectUnannouncedTurn`:工件触发 + 没播报 + 没留痕 ⇒ 命中", () => {
  const todoTrigger = (todoKind: TodoKind): TurnTrigger => ({ kind: "todo", todoKind });
  const call = (name: string, isError = false) => ({
    name, argsSummary: "", isError, resultSummary: "", durationMs: 1,
  });

  it("命中:平台叫醒 + 没调 `tell_client` + 正文没有行首标记", () => {
    const hit = detectUnannouncedTurn({
      channel: "client",
      trigger: todoTrigger("close_project"),
      text: "我看了库里那三条,都没什么可说的。",
      toolCalls: [],
      pendingEventCount: 3,
    });
    expect(hit).not.toBeNull();
    expect(hit!.todoKind).toBe("close_project");
    expect(hit!.pendingEventCount).toBe(3);
    expect(hit!.tellClientCalls).toBe(0);
    expect(hit!.textHead).toBe("我看了库里那三条,都没什么可说的。");
  });

  it("负样本 ①:甲方亲口触发的那一轮不在作用域里(`{ kind: \"user\" }`)", () => {
    expect(detectUnannouncedTurn({
      channel: "client",
      trigger: { kind: "user" },
      text: "他问的那个问题我在这里答。",
      toolCalls: [],
      pendingEventCount: 3,
    })).toBeNull();
  });

  it("负样本 ②:调过 `tell_client`(成功)⇒ 不命中", () => {
    expect(detectUnannouncedTurn({
      channel: "client",
      trigger: todoTrigger("close_project"),
      text: "播了。",
      toolCalls: [call("tell_client")],
      pendingEventCount: 3,
    })).toBeNull();
  });

  it("负样本 ②b:**内部角色**的平台回合不在作用域里(那条规矩只写给业务经理)", () => {
    // 项目经理拆解 / 质检审查同样「工件触发 + 没调 tell_client」,但它们
    // **没有对甲方的通道** —— 提示词从没要求过它们留痕。把它们算命中 =
    // 每个项目一开张连着几条假告警,而假告警会把这条计数变成噪音。
    for (const todoKind of ["decompose_project", "review_work", "integrate"] as const) {
      expect(detectUnannouncedTurn({
        channel: "internal",
        trigger: todoTrigger(todoKind),
        text: "我拆完了,建了三条工作项。",
        toolCalls: [],
        pendingEventCount: 2,
      }), `${todoKind} 的内部回合不该命中`).toBeNull();
    }
    // 正样本对照:同一个回合只要落在**甲方通道**上就必须命中 ——
    // 否则上面那三条断言可能只是「判据恒为 null」
    expect(detectUnannouncedTurn({
      channel: "client",
      trigger: todoTrigger("decompose_project"),
      text: "我拆完了,建了三条工作项。",
      toolCalls: [],
      pendingEventCount: 2,
    })).not.toBeNull();
  });

  it("正样本:`tell_client` **调用失败** ⇒ 仍然命中(没播出去就还得留痕)", () => {
    const hit = detectUnannouncedTurn({
      channel: "client",
      trigger: todoTrigger("close_project"),
      text: "我试着播报,但通道报错了。",
      toolCalls: [call("tell_client", true)],
      pendingEventCount: 1,
    });
    expect(hit).not.toBeNull();
    expect(hit!.tellClientCalls, "调用次数要如实记进现场").toBe(1);
  });

  it("负样本 ③:正文有**行首** `[未播报]` ⇒ 不命中(含缩进与第二行)", () => {
    expect(detectUnannouncedTurn({
      channel: "client",
      trigger: todoTrigger("close_project"),
      text: "[未播报] 评估 2 条,都不必播。",
      toolCalls: [], pendingEventCount: 2,
    })).toBeNull();
    // 提示词示例写在代码块里 ⇒ 行首有缩进;平台按**行首**认它,空白不算破例
    expect(detectUnannouncedTurn({
      channel: "client",
      trigger: todoTrigger("close_project"),
      text: "先说明一下背景。\n  [未播报] 评估 1 条。",
      toolCalls: [], pendingEventCount: 1,
    })).toBeNull();
  });

  it("负样本 ④:正文**中段引述** `[未播报]` 不算留痕 ⇒ 仍然命中", () => {
    const hit = detectUnannouncedTurn({
      channel: "client",
      trigger: todoTrigger("close_project"),
      text: '你问的那行 "[未播报]" 是我自己的记录。',
      toolCalls: [], pendingEventCount: 1,
    });
    expect(hit, "引述不是留痕 —— 平台不许被一句引用骗过").not.toBeNull();
    // 破折号列表项同理:那已经是一条正文,不是提示词要求的那一行
    expect(detectUnannouncedTurn({
      channel: "client",
      trigger: todoTrigger("close_project"),
      text: "- [未播报] 评估 1 条。",
      toolCalls: [], pendingEventCount: 1,
    })).not.toBeNull();
  });

  it("正样本:正文**空**(什么都没写)⇒ 命中", () => {
    expect(detectUnannouncedTurn({
      channel: "client",
      trigger: todoTrigger("close_project"),
      text: "",
      toolCalls: [], pendingEventCount: 5,
    })).not.toBeNull();
  });

  it("`textHead` 截断到常量长度,而项目级事件数**只是现场**(0 也照样命中)", () => {
    const long = "字".repeat(500);
    const hit = detectUnannouncedTurn({
      channel: "client",
      trigger: todoTrigger("close_project"),
      text: long,
      toolCalls: [], pendingEventCount: 0,
    });
    expect(hit).not.toBeNull();
    expect(hit!.textHead.length).toBeLessThan(long.length);
    // ⚠️ 这条是刻意钉住的:「本回合 ≥1 条未消费事件」**不是**闸门 ——
    // 「这一回合属于哪条事件」在库里不存在(见 `detectUnannouncedTurn` 上方),
    // 所以项目级读数只作为现场进告警。
    expect(hit!.pendingEventCount).toBe(0);
  });

  // ⚠️ 2026-10-06 真机修的一处(判据见 `shared/types/platform.ts` 的
  // `CLIENT_FACING_TODO_KINDS`)。
  //
  // 真机现场:业务经理在 24 次平台叫醒的回合里 `tell_client` 调用 **0 次**,而
  // 14:52 那条「档位与 <$25k Cash account 不匹配」被读面整条滤掉 —— 甲方从头
  // 到尾不知道自己的两个拍板互相打架。
  //
  // 修法是让这三类待办的**正文自动进甲方通道**(读面 `channelOf` 第 4 步),
  // 于是对它们再要求「必须 tell_client 才算已播报」,就是要求他在**已经是
  // 甲方通道的地方再广播一次** —— 那会把告警从真信号变成每 tick 一条的噪音,
  // 而假告警比没有告警更糟(它让这条计数不再有证据力)。
  it("例外:这三类待办的正文**自动进甲方通道** ⇒ 不再要求 tell_client,也不告警", () => {
    for (const todoKind of ["handover", "report_downstream", "resume_client"] as const) {
      expect(
        detectUnannouncedTurn({
          channel: "client",
          trigger: todoTrigger(todoKind),
          text: "甲方选了 A。这里有一个关键张力我必须当面说清。",
          toolCalls: [],
          pendingEventCount: 2,
        }),
        `${todoKind} 的正文已经到甲方眼前了,不该再报「没留工作记录」`,
      ).toBeNull();
    }
    // ⚠️ 正样本自检:同一个 `channel`、同一段正文,换一个**不在那个集合里**的
    // 待办类别就必须命中 —— 否则上面三条断言可能只是「判据恒为 null」。
    expect(detectUnannouncedTurn({
      channel: "client",
      trigger: todoTrigger("close_project"),
      text: "甲方选了 A。这里有一个关键张力我必须当面说清。",
      toolCalls: [],
      pendingEventCount: 2,
    })).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════
// ③ 宿主的接线 + 告警产物(真 `createPlatformHost`)
// ════════════════════════════════════════════════════════════════

describe("③ 真宿主:排空叫醒业务经理时,封套带的是待办真值,且告警不编造", () => {
  let dataDir: string;
  let host: PlatformHost | undefined;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    dataDir = mkdtempSync(join(tmpdir(), "ss-w2c-trigger-"));
    const p = listProviders()[0];
    const model = p?.models[0];
    if (p === undefined || model === undefined) {
      throw new Error("内建 provider catalog 是空的 —— 夹具造不出「已配置 provider」的现场");
    }
    writeFileSync(
      join(dataDir, "settings.json"),
      JSON.stringify({
        providers: [{
          id: "prov_test", label: "test", provider: p.id, modelId: model.id,
          apiKey: "test-key-not-used", thinkingLevel: "off",
        }],
        activeProviderId: "prov_test",
        cwd: dataDir,
        personaName: "测试",
      }),
      { mode: 0o600 },
    );
  });

  afterEach(() => {
    host?.close();
    host = undefined;
    rmSync(dataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  /**
   * 假会话:`prompt()` 里按 `reply` 吐一段正文,然后 `agent_settled`。
   *
   * 与真模型唯一的差别是「它不调工具」—— 而这一批要的正是「没调 `tell_client`」
   * 那个现场。
   */
  function fakeSession(reply: string): CreateSessionFn {
    return async () => {
      const listeners = new Set<(ev: AgentSessionEvent) => void>();
      const emit = (ev: AgentSessionEvent): void => { for (const l of [...listeners]) l(ev); };
      const session = {
        subscribe(fn: (ev: AgentSessionEvent) => void) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
        async prompt() {
          if (reply !== "") {
            emit({
              type: "message_update",
              assistantMessageEvent: { type: "text_delta", delta: reply },
            } as unknown as AgentSessionEvent);
          }
          emit({ type: "agent_settled" } as AgentSessionEvent);
        },
        async abort() { emit({ type: "agent_settled" } as AgentSessionEvent); },
        dispose() { /* 无需清理 */ },
      } as unknown as AgentSession;
      return { session };
    };
  }

  /**
   * 起宿主 + 挂观测点。
   *
   * ⚠️ 观测点必须挂在 `host.hub.emitMessageStart` 上:它是**回合封套的唯一出口**
   * (`source: "turn"`),播报走的是另一条(private 的 `emitBroadcastStart`)——
   * 所以这里看到的每一条都带 `trigger`。
   */
  async function bootHost(reply: string): Promise<{
    db: Database.Database;
    starts: Array<{ agentId: string | null; trigger: TurnTrigger | undefined }>;
    runNow: () => Promise<void>;
  }> {
    host = createPlatformHost({
      dataDir,
      host: "127.0.0.1",
      port: 0,
      version: "test",
      maxCascadeRounds: 1,
      // 定时器挪到一小时之后:这几条要的是**手动跑一轮**,不是它自己 fire
      dispatchIntervalMs: 3_600_000,
      createSession: fakeSession(reply),
    });
    const db = host.booted.deps.db;
    const starts: Array<{ agentId: string | null; trigger: TurnTrigger | undefined }> = [];
    const real = host.hub.emitMessageStart.bind(host.hub);
    // ⚠️ 形参顺序跟着 migration 024 变了(`sessionId` 插在第二位)。
    // 这条 mock 之所以必须逐字对齐:写错的话 `starts` 会**悄悄收集到错误的
    // 那一维**,而断言只检查 `agentId` 与 `trigger` —— 也就是说「收集错了」
    // 表现得像「断言没抓到」,而不是像编译错误。
    vi.spyOn(host.hub, "emitMessageStart").mockImplementation(
      (projectId, sessionId, messageId, role, agentId, trigger) => {
        starts.push({ agentId, trigger });
        real(projectId, sessionId, messageId, role, agentId, trigger);
      },
    );
    return { db, starts, runNow: () => host!.dispatchTimer.runNow() };
  }

  /**
   * 现场 A:**一个项目 + 一条问业务经理的 ask + 零工作项**。
   *
   * `answer_ask` 优先级最高(0)⇒ 排空第一个回合就是业务经理那条,而它是
   * **平台叫醒**的(不是甲方开口)⇒ `trigger` 必须是 `{kind:"todo", todoKind:"answer_ask"}`。
   * `maxCascadeRounds: 1` ⇒ 恰好一个回合,断言不会混进后面的东西。
   */
  function seedAsk(db: Database.Database): void {
    insertProject(db, {
      id: "p1", name: "语音机器人调研", client: "甲方",
      goal: "给出三条技术路线的对比与选型建议", status: "active", createdAt: T0,
    });
    ensureProjectOrg(db, "p1", T0);
    insertAsk(db, {
      id: "a1", projectId: "p1", fromAgentId: "pm", toAgentId: "bm",
      question: "这条产出算验收了吗?", hypothesis: "我猜算,但需要你确认", createdAt: T0 + 1,
    });
  }

  /** 现场 B:**一个项目 + 一条分派给 worker 的 open 工作项**(⇒ `execute_work`)。 */
  function seedOpenWork(db: Database.Database): void {
    insertProject(db, {
      id: "p1", name: "语音机器人调研", client: "甲方",
      goal: "给出三条技术路线的对比与选型建议", status: "active", createdAt: T0,
    });
    ensureProjectOrg(db, "p1", T0);
    insertWork(db, {
      id: "wk1", projectId: "p1", parentWorkId: null,
      title: "调研路线 A", goal: "写出对比结论", status: "open",
      assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
    });
  }

  it("`message_start` 上带的是 `{ kind:\"todo\", todoKind:\"answer_ask\" }`(真值,不是 execute_work)", async () => {
    const { starts, db, runNow } = await bootHost("我看了下,这条先不动。");
    seedAsk(db);
    await runNow();
    const turnStarts = starts.filter((s) => s.agentId === "bm");
    expect(turnStarts.length, "排空的第一个回合必须落在业务经理身上").toBeGreaterThanOrEqual(1);
    expect(turnStarts[0]!.trigger).toEqual({ kind: "todo", todoKind: "answer_ask" });
  });

  it("工作项执行那条路(`runWorkInSession`)同样带待办真值,而不是 `{ kind:\"user\" }`", async () => {
    const { starts, db, runNow } = await bootHost("");
    seedOpenWork(db);
    await runNow();
    const turnStarts = starts.filter((s) => s.agentId === "wk");
    expect(turnStarts.length, "open 的工作项 ⇒ 排空第一个回合是 worker 执行那条").toBeGreaterThanOrEqual(1);
    // 值来自 `todo.kind`(今天恒为 `execute_work`),**不是**宿主写的字面量 ——
    // 写成一个别的值(或干脆漏掉这一维)都会让这一行红。
    expect(turnStarts[0]!.trigger).toEqual({ kind: "todo", todoKind: "execute_work" });
  });

  it("**内部角色**被平台叫醒时不落告警(那条规矩只写给业务经理)", async () => {
    // 现场:一个**零工作项**的项目 ⇒ 待办是项目经理的 `decompose_project`
    // ——它同样「工件触发 + 没调 tell_client + 正文没有行首标记」,但它走的是
    // **内部通道**,提示词从没要求过它留痕。
    const { db, starts, runNow } = await bootHost("我拆完了,建了三条工作项。");
    insertProject(db, {
      id: "p1", name: "语音机器人调研", client: "甲方",
      goal: "给出三条技术路线的对比与选型建议", status: "active", createdAt: T0,
    });
    ensureProjectOrg(db, "p1", T0);
    await runNow();

    const turnStarts = starts.filter((s) => s.agentId === "pm");
    expect(turnStarts.length, "零工作项 ⇒ 第一个回合是项目经理拆解").toBeGreaterThanOrEqual(1);
    expect(turnStarts[0]!.trigger).toEqual({ kind: "todo", todoKind: "decompose_project" });
    // ★ 去掉 `detectUnannouncedTurn` 的 `channel` 闸门,这一行立刻红
    //   (它在**这条**路径上真的会走到检测器 —— `runAgentTurn`,不是 `runWorkInSession`)。
    const rows = db.prepare(
      `SELECT content FROM session_messages WHERE kind = 'system'`,
    ).all() as Array<{ content: string }>;
    expect(
      rows.filter((r) => r.content.includes("没留工作记录")).length,
      `内部角色不该落这条告警 —— 现场:${JSON.stringify(rows)}`,
    ).toBe(0);
  });

  it("没留工作记录 ⇒ 落一条**平台自己的** `system` 告警,且**不替模型补** `[未播报]`", async () => {
    const { db, starts, runNow } = await bootHost("我看了下,这条先不动。");
    seedAsk(db);
    await runNow();
    // 命中前提先钉住(否则下面查不到告警可能只是「回合没跑」)
    expect(starts.some((s) => s.trigger?.kind === "todo")).toBe(true);

    const rows = db.prepare(
      `SELECT content FROM session_messages WHERE kind = 'system' ORDER BY created_at`,
    ).all() as Array<{ content: string }>;
    const alarms = rows.filter((r) => r.content.includes("没留工作记录"));
    expect(alarms.length, `告警没落库 —— 现场:${JSON.stringify(rows)}`).toBe(1);

    const content = alarms[0]!.content;
    // 7-N:现场要够定位 —— 哪个回合 / 哪个待办 / 正文前若干字
    expect(content).toContain("answer_ask");
    expect(content).toContain("回合 ");
    expect(content).toContain("我看了下,这条先不动。");
    expect(content).toContain("未消费事件");
    // ★ **不编造**:告警里没有任何一行以 `[未播报]` 开头(那是业务经理的判断,
    //   不是平台的)。平台补一行 = 后来的读者会以为当时判断过。
    expect(
      content.split("\n").some((l) => /^[ \t]*\[未播报\]/.test(l)),
      "平台不许替模型写工作记录 —— 那是编造现场",
    ).toBe(false);
  });

  it("负样本:正文留了行首 `[未播报]` ⇒ 一条告警都不落", async () => {
    const { db, starts, runNow } = await bootHost("[未播报] 评估 1 条 —— 甲方此刻无事可做。");
    seedAsk(db);
    await runNow();
    expect(starts.some((s) => s.trigger?.kind === "todo")).toBe(true);
    const rows = db.prepare(
      `SELECT content FROM session_messages WHERE kind = 'system'`,
    ).all() as Array<{ content: string }>;
    expect(
      rows.filter((r) => r.content.includes("没留工作记录")).length,
      `合规的回合不该有任何告警 —— 现场:${JSON.stringify(rows)}`,
    ).toBe(0);
  });
});
