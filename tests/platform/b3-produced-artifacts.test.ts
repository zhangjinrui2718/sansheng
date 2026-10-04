/**
 * B3 的裁决 · `producedArtifacts` 的读者是谁,以及**为什么宿主不该读它**
 *
 * ── 这一批的结论:设计 1 §2.12 的 B3 **两个选项都不做** ──────────────
 *
 * B3 的说法是「`execution.producedArtifacts` 每个回合都算出来了,而 `host/serve.ts`
 * 的对应位置只读 `turn`/`work`,**没有读者**」。实测三条,它不成立:
 *
 *   ① **它有读者,而且在生产路径上。** `renderExecutionReport`
 *      (`runtime/execution.ts:397`)把产出清单打进报告,而唯一的调用点是
 *      `src/platform/cli/run.ts:169` —— `platform-run` 命令的描述原文就是
 *      「打印产出工件与工具调用现场」。B3 的 grep 找的是**标识符**,
 *      于是漏掉了**穿过另一个函数名**的那个读者。这与 §9.4 那次
 *      「`grep -rn parentWorkId harness/` 是空的 ⇒ 没人告诉它」是同一个形状:
 *      **「grep 不到」不等于「不存在」;先问「还有哪条通道我没想到」。**
 *   ② **「宿主把它当布尔用」是空转,而且可证明。** `artifacts.work_id`(014 的产出边)
 *      今天**只有 `board_write` 会写**(`workId` 参数只在它的 schema 里),而
 *      `blackboard.write` 在 `NUDGE_CAPABILITIES` 里 —— 所以「这个回合产出了工件」
 *      蕴含「这个回合已经敲过门铃」。反过来门铃**更宽**:不挂边的 `board_write`
 *      也响铃,而 `producedArtifacts` 采不到它。→ 它给不出门铃给不出的触发信息。
 *   ③ **宿主再敲一次铃查到的是同一份待办。** `collectTodos` 的输入里根本没有工件
 *      (纯度纪律),而 `drainProject` 每一回合**都**重新查库。
 *
 * ⇒ 接线 = 「接上但依然没人读」的第三种失败;删它要删掉一个生产读者
 * (`platform-run` 的产出清单)与 7 条钉住 014 边语义的断言(那 7 条**有意义**:
 * 它们钉的是「谁的产出、哪条边的产出」,不是这个字段的偶然形态)。
 *
 * 下面四条断言钉的是**裁决本身的三条支柱**,不是某个实现细节:
 *   ① 报告那一支真的会打印产出(这一支在此之前**没有任何测试**,是覆盖缺口);
 *   ② 产出工件 ⇒ 同一次调用敲过门铃(正样本);
 *   ③ 敲门铃 ⇏ 采得到(负样本)—— 门铃严格更宽;
 *   ④ 产出工件不改变看板 —— 所以宿主侧的布尔是空转。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent, getAgent } from "../../src/platform/storage/repo/agents.js";
import {
  insertProject, addMember, loadProjectForAuthz,
} from "../../src/platform/storage/repo/projects.js";
import { insertWork, type WorkRow } from "../../src/platform/storage/repo/works.js";
import { listArtifacts } from "../../src/platform/storage/repo/artifacts.js";
import { collectTodos, NUDGE_CAPABILITIES } from "../../src/platform/runtime/dispatcher.js";
import {
  runWorkItem, renderExecutionReport, type ExecutionResult,
} from "../../src/platform/runtime/execution.js";
import { dispatch } from "../../src/platform/tools/registry.js";
import type { ToolRunContext, ToolResult } from "../../src/platform/tools/types.js";
import type { Agent } from "../../src/platform/harness/authorize.js";

let db: Database.Database;
let seq = 0;
const T0 = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  insertAgent(db, {
    id: "pm", role: "project_manager", specialization: null,
    displayName: "项目经理", createdAt: T0,
  });
  insertAgent(db, {
    id: "wk", role: "worker", specialization: "engineering",
    displayName: "工程师", createdAt: T0,
  });
  insertProject(db, {
    id: "p1", name: "语音机器人调研", client: "甲方",
    goal: "给出三条技术路线的对比与选型建议", status: "active", createdAt: T0,
  });
  for (const id of ["pm", "wk"]) addMember(db, "p1", id, T0);
});
afterEach(() => db.close());

function mkWork(): WorkRow {
  const w: WorkRow = {
    id: `w_${++seq}`, projectId: "p1", parentWorkId: null,
    title: "调研路线 A", goal: "写出对比结论",
    status: "open", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
  };
  insertWork(db, w);
  return w;
}

/** 假会话:剧本在 prompt 时执行(模拟 agent 通过工具做的事)。 */
function fakeSession(script: () => void): AgentSession {
  const listeners: Array<() => void> = [];
  return {
    subscribe(fn: () => void) {
      listeners.push(fn);
      return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
    },
    async prompt() { script(); },
    dispose() {},
    getActiveToolNames() { return []; },
  } as unknown as AgentSession;
}

/** 真工具路径的调用上下文(`nudge` 由调用方注入 —— 它就是门铃)。 */
function ctxFor(agentId: string, nudge: () => void): ToolRunContext {
  const row = getAgent(db, agentId);
  if (row === null) throw new Error(`未知 agent ${agentId}`);
  const project = loadProjectForAuthz(db, "p1");
  if (project === null) throw new Error("项目 p1 读不出来");
  const agent: Agent = {
    id: row.id, role: row.role, displayName: row.displayName,
    ...(row.specialization !== null ? { specialization: row.specialization } : {}),
  };
  return { db, agent, project, now: () => T0, newId: (p) => `${p}_b3`, nudge };
}

/**
 * 跑一个真工作项回合,剧本里走**真工具通道**(`dispatch("board_write", …)`)。
 * `withEdge` = 传不传 `workId` —— 那正是 014 产出边的**写入侧**。
 */
async function runTurnWithBoardWrite(opts: {
  workId: string;
  withEdge: boolean;
  nudge: () => void;
}): Promise<{ r: ExecutionResult; tool: ToolResult }> {
  let tool: ToolResult | null = null;
  const session = fakeSession(() => {
    const args: Record<string, unknown> = {
      kind: "evidence", title: "路线 A 的实测数据", body: "延迟 120ms",
      ...(opts.withEdge ? { workId: opts.workId } : {}),
    };
    const out = dispatch("board_write", args, ctxFor("wk", opts.nudge));
    if (out instanceof Promise) {
      throw new Error("`board_write` 应当是同步的 —— 异步化会让下面的「门铃时机」断言失去意义");
    }
    tool = out;
  });
  const r = await runWorkItem({
    session, db, workId: opts.workId, timeoutMs: 1000, injectPending: false,
  });
  if (tool === null) throw new Error("剧本没跑到 —— 这次断言没有信息量");
  return { r, tool };
}

/** 看板的可比快照:`(kind, key, agent, 预算)` 四样 —— 判定产出的全部信息都在里面。 */
const boardSnapshot = (): string[] =>
  [...collectTodos({ db, projectId: "p1", now: T0 }).runnable]
    .map((t) => `${t.kind}|${t.key}|${t.agentId}|${t.attempts}`)
    .sort();

// ── ① 读者在生产路径上(这一支今天没有测试)─────────────────────

describe("B3 · `producedArtifacts` 的读者是 CLI 报告(`platform-run`)", () => {
  it("报告会打印产出清单 —— 所以它不是「零读者」的代码", () => {
    const r: ExecutionResult = {
      outcome: "unconverged",
      work: {
        id: "w1", projectId: "p1", parentWorkId: null, title: "调研路线 A", goal: "g",
        status: "in_progress", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
      },
      turn: {
        text: "", thinking: "", toolCalls: [],
        pending: { injected: false, summary: "" }, settled: true, timedOut: false,
      },
      producedArtifacts: [{
        id: "art_b3", projectId: "p1", conversationId: null,
        kind: "evidence", status: "open", authorAgentId: "wk",
        title: "路线 A 的实测数据", body: "延迟 120ms", metadataJson: null,
        createdAt: T0, updatedAt: T0, workId: "w1",
      }],
      raisedBlockers: [],
    };
    const rep = renderExecutionReport(r);
    expect(rep).toContain("产出工件 1 个:");
    expect(rep).toContain("[evidence] art_b3: 路线 A 的实测数据");
    // **负样本**:这一支不能永远为真(空列表走的是另一个分支)
    expect(rep).not.toContain("产出工件: 无");
  });

  it("空产出的分支也没被上面那条断言挤掉", () => {
    const r: ExecutionResult = {
      outcome: "converged",
      work: {
        id: "w1", projectId: "p1", parentWorkId: null, title: "t", goal: "g",
        status: "done", assigneeAgentId: "wk", createdAt: T0, updatedAt: T0,
      },
      turn: {
        text: "", thinking: "", toolCalls: [],
        pending: { injected: false, summary: "" }, settled: true, timedOut: false,
      },
      producedArtifacts: [],
      raisedBlockers: [],
    };
    expect(renderExecutionReport(r)).toContain("产出工件: 无");
  });
});

// ── ②③ 门铃与产出采集的集合关系 ─────────────────────────────────

describe("B3 · 门铃与产出采集的集合关系(为什么它给不出新触发信息)", () => {
  it("正样本:挂上产出边 ⇒ 采得到它,且**同一次工具调用已经敲过门铃**", async () => {
    const w = mkWork();
    let rings = 0;
    const { r, tool } = await runTurnWithBoardWrite({
      workId: w.id, withEdge: true, nudge: () => { rings++; },
    });
    expect(tool.ok, tool.ok ? "" : `[${tool.code}] ${tool.message}`).toBe(true);
    expect(r.producedArtifacts.map((a) => a.id)).toEqual(["art_b3"]);
    expect(r.producedArtifacts[0]!.workId, "产出边记的就是这条工作项").toBe(w.id);
    // 这条断言就是整段论证的机器形式:**产出工件蕴含门铃已响**
    expect(
      rings,
      "`blackboard.write` ∈ NUDGE_CAPABILITIES ⇒ 产出工件的那次调用就是敲门铃的那次调用",
    ).toBe(1);
    expect(NUDGE_CAPABILITIES).toContain("blackboard.write");
  });

  it("负样本:同一次调用**不挂边** ⇒ 门铃照响,但采不到 —— 门铃严格更宽", async () => {
    const w = mkWork();
    let rings = 0;
    const { r, tool } = await runTurnWithBoardWrite({
      workId: w.id, withEdge: false, nudge: () => { rings++; },
    });
    expect(tool.ok, tool.ok ? "" : `[${tool.code}] ${tool.message}`).toBe(true);
    expect(rings, "门铃按**能力**响,不按「这条边挂没挂」响").toBe(1);
    expect(r.producedArtifacts, "014 的边是显式的 —— 没挂边就不属于这条工作项的产出").toEqual([]);
    // 工件本身在库里:丢的只是「这条工作项的产出」这条关系,不是数据
    expect(listArtifacts(db, "p1").map((a) => a.id)).toEqual(["art_b3"]);
  });

  it("自检:门铃计数器**不是恒为 1 的常量**(被拒的调用不敲门)", () => {
    // 没有这一条,上面那个 `rings === 1` 就无法排除「检查本身坏了」——
    // 而本项目为此付过代价(死文件检测用坏掉的模式返回了一个自信的 0)。
    let rings = 0;
    const out = dispatch(
      // worker 的 `writeKinds` 里没有 `review_finding`(`ROLE_SPECS`)⇒ 调用期门拒。
      // `ringNudge` 只在 `result.ok === true` 时响 ⇒ 计数器必须**一动不动**。
      "board_write",
      { kind: "review_finding", title: "越权的写法", body: "b" },
      ctxFor("wk", () => { rings++; }),
    );
    expect(out instanceof Promise, "`board_write` 应当是同步的").toBe(false);
    expect((out as ToolResult).ok, "这次调用必须是被拒的(否则下面的 0 没有信息量)").toBe(false);
    expect(rings).toBe(0);
  });

  it("**产出工件不改变看板** —— 宿主拿它当布尔再敲一次铃,查到的是同一份待办", async () => {
    const w = mkWork();
    const before = boardSnapshot();
    expect(
      before.some((x) => x.includes("execute_work")),
      "正样本自检:看板为空时「相同」没有任何信息量",
    ).toBe(true);

    let rings = 0;
    const { r } = await runTurnWithBoardWrite({
      workId: w.id, withEdge: true, nudge: () => { rings++; },
    });
    expect(r.producedArtifacts).toHaveLength(1);
    expect(rings).toBe(1);
    // 工件不是待办来源(纯度纪律):`collectTodos` 的输入里根本没有工件
    expect(
      boardSnapshot(),
      "再查一次得到逐字相同的看板 ⇒ 宿主侧那个布尔 `if (producedArtifacts.length > 0) nudge()` 是空转",
    ).toEqual(before);

    // 自检:这个比较器**不是恒等**的 —— 真加一条工作项,看板必须变。
    // 有了这一步,上面那句「逐字相同」才是一条有牙的断言。
    mkWork();
    expect(boardSnapshot()).not.toEqual(before);
  });
});
