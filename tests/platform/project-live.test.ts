/**
 * 「**此刻**在做什么」的读面:`GET /api/projects/:id/live` + `ArtifactView.workId`
 *
 * ── 为什么这个文件必须存在(它守的是两类谎)────────────────────────
 *
 * 用户的原话:「现在只有做了些什么,没有正在做什么……我担心系统已经挂了,而实际
 * 还在运行」。这个端点就是为那句话补的读面,而它最危险的失效方向**不是崩**,
 * 是**看起来正常**:
 *
 *   ① **「读不到」被显示成「空闲」。** 运行期两项(忙闩 / 定时器心跳)来自宿主
 *      **内存**,只挂 HTTP 的装配(以及任何未接线的进程)根本拿不到。那时:
 *        · 正:`deps.live` 缺失 ⇒ `runtime: "unavailable"`, `turn === null`,
 *          `dispatch.lastRunAgeMs === null`;
 *        · 负:`runtime === "host"` 时**不许**再是 `unavailable`(否则这条判据
 *          在「实现永远返回 unavailable」时也全绿 —— 一次空转的检查)。
 *   ② **三个来源被混成一个。** 内存里的回合(重启即清零)、库里的工作项(重启后
 *      仍在)、`collectTodos` 的待办(排空器的判据)是三件事。这里逐条对着
 *      **独立算出来的真值**比,而不是对着实现自己的中间变量比。
 *
 * 另外钉住 `ArtifactView.workId`:工件页的 DAG 靠这条边把工件挂回产出它的环节。
 * 缺了它页面只能按 kind 平铺(那正是用户嫌「可读性太差」的现状);而**造假**
 * (拿 authorAgentId 之类猜一个环节)在页面上看不出来 —— 所以正样本(有产出边)
 * 与负样本(`decision` 的边是 `null`)都要断言。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { addMember, insertProject } from "../../src/platform/storage/repo/projects.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { appendSessionMessage, insertSession } from "../../src/platform/storage/repo/sessions.js";
import { addDep, insertWork, updateWorkStatus } from "../../src/platform/storage/repo/works.js";
import { insertArtifact } from "../../src/platform/storage/repo/artifacts.js";
import { bumpAttempt } from "../../src/platform/storage/repo/dispatch.js";
import { createPlatformApp, type HttpDeps } from "../../src/platform/transport/http.js";
import type { ArtifactView, ProjectLiveView } from "@shared/types/platform.js";

const P = "p-live";
const S = "s-live";
/**
 * 027 起正文住文件:测试里仍从「想写的正文」造出**落点三列** ——
 * sha256 与字节数都是真的(`node:crypto` 现算),不是占位串;正文本身不再进库。
 * 夹具仍然说得出「这件工件的正文是这一句」,只是表达成 (落点, 哈希, 字节数)。
 */
function bodyAt(path: string, content: string) {
  return {
    bodyPath: path,
    bodySha256: createHash("sha256").update(content, "utf8").digest("hex"),
    bodyBytes: Buffer.byteLength(content, "utf8"),
  };
}

let db: Database.Database;
let seq = 0;
let clock = 1_700_000_000_000;

beforeEach(() => {
  db = openPlatformMemoryDb();
  seq = 0;
  clock = 1_700_000_000_000;
  insertProject(db, {
    id: P, name: "催收机器人", client: "甲方", goal: "把架构方案交出来",
    status: "active", createdAt: clock,
  });
  insertSession(db, { id: S, projectId: P, createdAt: clock });
  for (const [id, role, name] of [
    ["bm", "business_manager", "业务经理"],
    ["pm", "project_manager", "项目经理"],
    ["wk", "research_worker", "研究员"],
    ["cw", "coding_worker", "工程师"],
    ["qa", "quality_reviewer", "质检"],
  ] as const) {
    insertAgent(db, { id, role, specialization: null, displayName: name, createdAt: clock });
    // ⚠️ **成员表是 `project_assignments`,不是 `agents`** —— `listProjectMembers`
    // 走的是 `listAssignments`。少这一步的话 `agents` 里五个角色都在,而读面返回
    // **空数组**(「本项目没有成员」),测试会在第一条断言上就红。
    addMember(db, P, id, clock);
  }
});

afterEach(() => {
  db.close();
});

/** 落一条会话消息。`tool` 那一条的正文是工具名(与 `kind='tool'` 的落库形态一致)。 */
function msg(
  agentId: string,
  kind: "assistant" | "thinking" | "tool",
  content: string,
  at = (clock += 10),
): void {
  seq += 1;
  appendSessionMessage(db, {
    id: `m${seq}`, sessionId: S, agentId, kind, content, createdAt: at,
    originSource: "turn", triggerKind: "todo",
  });
}

function work(
  id: string,
  over: {
    status?: "open" | "in_progress" | "blocked" | "done";
    assignee?: string;
    parent?: string | null;
    updatedAt?: number;
    reviewState?: "none" | "pending" | "done";
  } = {},
): void {
  clock += 10;
  insertWork(db, {
    id,
    projectId: P,
    parentWorkId: over.parent ?? null,
    title: `工作项 ${id}`,
    goal: `目标 ${id}`,
    status: over.status ?? "open",
    assigneeAgentId: over.assignee ?? "wk",
    createdAt: clock,
    updatedAt: over.updatedAt ?? clock,
    ...(over.reviewState !== undefined ? { reviewState: over.reviewState } : {}),
  });
}

function app(over?: Partial<HttpDeps>) {
  const deps: HttpDeps = {
    db,
    dataDir: "/tmp/project-live-test",
    cwd: "/tmp",
    personaName: "三生",
    version: "test",
    modelId: null,
    provider: null,
    hasAnyProvider: false,
    now: () => clock,
    newId: (prefix) => `${prefix}_${(seq += 1)}`,
    reset: () => ({ cleared: [], totalRows: 0 }),
    harnessDirs: { dataDir: "/tmp/project-live-test", factoryDir: "/tmp/project-live-factory" },
    settings: {
      read: () => ({}),
      write: async () => ({ ok: true as const, settings: {} }),
      providers: () => [],
    },
    ...over,
  };
  return createPlatformApp(deps);
}

async function fetchLive(over?: Partial<HttpDeps>): Promise<ProjectLiveView> {
  const res = await app(over).request(`/api/projects/${P}/live`);
  expect(res.status, "端点必须存在且 200").toBe(200);
  const body = (await res.json()) as { live: ProjectLiveView };
  return body.live;
}

// ── ① 「读不到」与「没在跑」必须分开 ─────────────────────────────

describe("① 运行期快照缺失时如实说「读不到」,不许冒充「空闲」", () => {
  it("没有接线(`deps.live` 缺失)⇒ runtime=unavailable,turn 全 null,心跳为 null", async () => {
    work("w1", { status: "in_progress", assignee: "wk" });

    const live = await fetchLive();
    expect(live.runtime).toBe("unavailable");
    expect(live.agents.length, "五个角色都要在(哪怕读不到运行期)").toBe(5);
    for (const a of live.agents) {
      expect(a.turn, `${a.agentId} 的回合读不到 ⇒ 必须是 null`).toBeNull();
    }
    expect(live.dispatch.lastRunAgeMs).toBeNull();
    expect(live.dispatch.intervalMs).toBe(0);
    // ⚠️ 负样本的另一半:**库里的真状态照样要给** —— 「运行期读不到」不该连累
    // 库里的工作项(那会让整块面板在测试装配下看起来「什么都没在发生」)。
    const wk = live.agents.find((a) => a.agentId === "wk");
    expect(wk?.currentWorks.map((w) => w.id)).toEqual(["w1"]);
  });

  it("接上了 ⇒ runtime=host,且**不再**是 unavailable(负样本,防止这条判据空转)", async () => {
    const live = await fetchLive({
      live: {
        turns: () => [],
        dispatch: () => ({ intervalMs: 10_000, lastRunAt: clock - 4000 }),
        drainingProjects: () => [],
        collect: {},
      },
    });
    expect(live.runtime).toBe("host");
    expect(live.dispatch.intervalMs).toBe(10_000);
    expect(live.dispatch.lastRunAgeMs, "心跳年龄由服务端算:now - lastRunAt").toBe(4000);
    expect(live.dispatch.draining).toBe(false);
  });
});

// ── ② 三个来源逐条对账 ──────────────────────────────────────────

describe("② 三个来源(内存回合 / 库里的活 / 排空器的待办)各自对得上", () => {
  it("回合:只认**这个项目**的闩,elapsedMs 与 trigger 都来自登记", async () => {
    const live = await fetchLive({
      live: {
        turns: () => [
          { projectId: P, agentId: "wk", startedAt: clock - 65_000, trigger: { kind: "todo", todoKind: "execute_work" } },
          // 别的项目里在跑的回合**不许**被算进来
          { projectId: "p-别的", agentId: "pm", startedAt: clock - 1000, trigger: { kind: "user" } },
        ],
        dispatch: () => ({ intervalMs: 10_000, lastRunAt: null }),
        drainingProjects: () => [P],
        collect: {},
      },
    });

    const wk = live.agents.find((a) => a.agentId === "wk");
    expect(wk?.turn?.elapsedMs).toBe(65_000);
    expect(wk?.turn?.trigger).toEqual({ kind: "todo", todoKind: "execute_work" });

    const pm = live.agents.find((a) => a.agentId === "pm");
    expect(pm?.turn, "别的项目的回合落到这个角色上就是跨项目污染").toBeNull();

    expect(live.runningTurns, "只数本项目的回合").toBe(1);
    expect(live.dispatch.draining, "正在排空本项目").toBe(true);
  });

  it("库里的活:`in_progress` / `blocked` 按负责人分开,`readyWorks` / `waitingWorks` 来自前置判定", async () => {
    work("w-done", { status: "done", assignee: "wk" });
    work("w-run", { status: "in_progress", assignee: "wk" });
    work("w-blocked", { status: "blocked", assignee: "wk" });
    work("w-other", { status: "in_progress", assignee: "qa" });
    // 前置没满足 ⇒ 这条不进 myOpenWorks,而进 myWaitingWorks(「它为什么还没动」)
    work("w-dep", { status: "done", assignee: "wk", reviewState: "done" });
    work("w-waiting", { status: "open", assignee: "wk" });
    addDep(db, "w-waiting", "w-run");

    const live = await fetchLive();
    const wk = live.agents.find((a) => a.agentId === "wk");
    const qa = live.agents.find((a) => a.agentId === "qa");

    // ⚠️ `done` 不在「正在做」里 —— 它已经收口了
    expect(wk?.currentWorks.map((w) => w.id).sort()).toEqual(["w-blocked", "w-run"]);
    expect(wk?.currentWorks.find((w) => w.id === "w-run")?.status).toBe("in_progress");
    expect(wk?.currentWorks.find((w) => w.id === "w-blocked")?.status).toBe("blocked");
    expect(qa?.currentWorks.map((w) => w.id)).toEqual(["w-other"]);
    expect(live.openWorks, "未终态 = open|in_progress|blocked(不含 done)").toBe(4);
    expect(wk?.waitingWorks, "w-waiting 在等 w-run(前置未满足 ⇒ 不算「手上的活」)").toBe(1);
    // `myOpenWorks` 的判据是 `open` ∪ `in_progress`(见 `pendingWork.ts`)——
    // 正在跑的 w-run **仍然算它手上的活**,这不是重复计数而是两个问题的两个答案:
    // 「现在能不能开工」与「它欠着几件」。
    expect(wk?.readyWorks, "w-run(in_progress)是唯一前置满足且未终态的").toBe(1);
  });

  it("排空器的待办:按 agent 分组,预算次数来自库里的账本,用满后不再叫醒但**看得见**", async () => {
    // 零工作项 ⇒ `decompose_project` 落在项目经理身上(它就是排空器的判据)
    const live = await fetchLive();
    const pm = live.agents.find((a) => a.agentId === "pm");
    expect(pm?.todos.map((t) => t.kind)).toContain("decompose_project");
    const first = pm?.todos.find((t) => t.kind === "decompose_project");
    expect(first?.attempts).toBe(0);
    expect(first?.maxAttempts, "缺省预算 3(`DEFAULT_MAX_ATTEMPTS`)").toBe(3);
    expect(first?.label.length, "待办必须带一行「人读的」说明").toBeGreaterThan(0);

    // 记账走**平台自己的**口(`bumpAttempt`)—— 手写 SQL 会变成第二份实现,
    // 而「预算几次」这件事必须只有一处定义。
    const key = `decompose_project:${P}`;
    bumpAttempt(db, { projectId: P, todoKey: key, targetState: null, at: clock });
    bumpAttempt(db, { projectId: P, todoKey: key, targetState: null, at: clock });

    const second = await fetchLive();
    const pm2 = second.agents.find((a) => a.agentId === "pm");
    expect(pm2?.todos.find((t) => t.kind === "decompose_project")?.attempts).toBe(2);

    // 第三次用满 ⇒ 排空器**不再叫它**。这件事必须在页面上看得见:
    // 「静默放弃」与「马上就会跑」在界面上长得一模一样(设计 1 §9.4)。
    bumpAttempt(db, { projectId: P, todoKey: key, targetState: null, at: clock });
    const third = await fetchLive();
    const pm3 = third.agents.find((a) => a.agentId === "pm");
    expect(pm3?.todos.map((t) => t.kind)).not.toContain("decompose_project");
    expect(pm3?.exhaustedTodos).toBe(1);
  });

  it("落库痕迹:`lastMessage` 的年龄按服务端时钟算,没说过话的角色是 null", async () => {
    msg("wk", "assistant", "开始做基础打断模块", clock - 30_000);
    msg("wk", "assistant", "读完了两份文档", clock - 12_000);

    const live = await fetchLive();
    const wk = live.agents.find((a) => a.agentId === "wk");
    expect(wk?.lastMessage?.ageMs, "最近一条落库消息").toBe(12_000);
    expect(wk?.lastMessage?.kind).toBe("assistant");
    expect(wk?.lastMessage?.excerpt).toBe("读完了两份文档");

    const bm = live.agents.find((a) => a.agentId === "bm");
    expect(bm?.lastMessage, "没说过话的角色必须是 null(不是 0 年龄的假活动)").toBeNull();
  });

  it("⚠️ 不提供 `lastTool`:真机库里 `kind='tool'` 的行数是 0(工具调用不落库)", async () => {
    // 这条是**负样本**,钉住一个已经删掉的字段:`MemberActivityView` 曾经有
    // `lastTool`,它按 `session_messages.kind='tool'` 查 —— 而那一类行在真机库里
    // **一条都没有**(实测 `SELECT kind, COUNT(*) … GROUP BY kind` 只有
    // user/assistant/system)。一个恒为 null 的字段比没有字段更坏:它让人以为
    // 「这个角色从没动过手」。
    //
    // 现在这条边只有一个来源:WS 广播(前端 `stores/chat.ts` 的 `inFlight`)。
    const res = await app().request(`/api/projects/${P}/live`);
    const { live } = (await res.json()) as { live: ProjectLiveView };
    for (const a of live.agents) {
      expect(
        Object.prototype.hasOwnProperty.call(a, "lastTool"),
        `${a.agentId} 上不许再出现 lastTool`,
      ).toBe(false);
    }
  });

  it("等甲方答的问题数 = 库里 open 的 client_question 工件数", async () => {
    insertArtifact(db, {
      id: "a-q1", projectId: P, conversationId: null, kind: "client_question",
      status: "open", authorAgentId: "bm", title: "用哪种部署形态?", ...bodyAt("artifacts/a-q1.md", ""),
      metadataJson: null, createdAt: clock, updatedAt: clock,
    });
    insertArtifact(db, {
      id: "a-q2", projectId: P, conversationId: null, kind: "client_question",
      status: "accepted", authorAgentId: "bm", title: "已答的问题", ...bodyAt("artifacts/a-q2.md", ""),
      metadataJson: null, createdAt: clock, updatedAt: clock,
    });

    const live = await fetchLive();
    expect(live.pendingQuestions, "只数 open —— 已采纳的不再等甲方").toBe(1);
  });

  it("未知项目 404(端点不是「永远 200 的空壳」)", async () => {
    const res = await app().request(`/api/projects/没有这个项目/live`);
    expect(res.status).toBe(404);
  });
});

// ── ③ 产出边(工件页 DAG 的挂点)──────────────────────────────────

describe("③ `ArtifactView.workId`:把工件挂回产出它的环节", () => {
  it("证据 / 评审发现带产出边,决策工件**不带**(`null` 是合法状态)", async () => {
    work("w1", { status: "done", assignee: "wk", reviewState: "done" });
    insertArtifact(db, {
      id: "a-ev", projectId: P, conversationId: null, kind: "evidence",
      status: "open", authorAgentId: "wk", title: "证据", ...bodyAt("artifacts/a-ev.md", "正文"),
      metadataJson: null, createdAt: clock, updatedAt: clock, workId: "w1",
    });
    insertArtifact(db, {
      id: "a-dec", projectId: P, conversationId: null, kind: "decision",
      status: "open", authorAgentId: "bm", title: "决策", ...bodyAt("artifacts/a-dec.md", "正文"),
      metadataJson: null, createdAt: clock, updatedAt: clock,
    });

    const res = await app().request(`/api/projects/${P}/artifacts`);
    expect(res.status).toBe(200);
    const { artifacts } = (await res.json()) as { artifacts: ArtifactView[] };
    const byId = new Map(artifacts.map((a) => [a.id, a]));
    expect(byId.get("a-ev")?.workId, "有产出边 ⇒ 挂在环节 w1 上").toBe("w1");
    expect(byId.get("a-dec")?.workId, "决策工件不挂在任何环节上(不是「缺参数」)").toBeNull();

    // 详情端点必须与列表端点**同形** —— 两个端点对同一条边给出两种答案,
    // 是「详情单独拉一次」这条设计最容易出的错(工件页正是这么用的)。
    const one = await app().request(`/api/artifacts/a-ev`);
    expect(one.status).toBe(200);
    const detail = (await one.json()) as { artifact: ArtifactView };
    expect(detail.artifact.workId).toBe("w1");
  });

  it("工作项被删时产出边被置 NULL(`ON DELETE SET NULL`,migration 014)—— 而读面不做任何改写", async () => {
    work("w1", { status: "in_progress", assignee: "wk" });
    insertArtifact(db, {
      id: "a-ev", projectId: P, conversationId: null, kind: "evidence",
      status: "open", authorAgentId: "wk", title: "证据", ...bodyAt("artifacts/a-ev2.md", ""),
      metadataJson: null, createdAt: clock, updatedAt: clock, workId: "w1",
    });

    // 正样本先立住:边在的时候**读得到**(否则下面那条「变成 NULL」可能只是
    // 因为这条边从来没被写进去过 —— 一次空转的检查)。
    const before = (await (await app().request(`/api/artifacts/a-ev`)).json()) as {
      artifact: ArtifactView;
    };
    expect(before.artifact.workId).toBe("w1");

    db.prepare(`DELETE FROM works WHERE id = ?`).run("w1");

    const after = (await (await app().request(`/api/artifacts/a-ev`)).json()) as {
      artifact: ArtifactView;
    };
    // 014 明确选了 `ON DELETE SET NULL` 而不是 CASCADE(工件是审计面,必须比
    // 产生它的东西活得久)⇒ 这里**就是** NULL,而读面只是把列原样透出。
    // 前端因此必须把 `workId === null` 读成「不挂在任何环节上」,并在工件页
    // 用**另一条**判据(名单里有没有这条工作项)标注「环节已不在」—— 不要
    // 在这里编一个 id 出来。
    expect(after.artifact.workId).toBeNull();
  });
});
