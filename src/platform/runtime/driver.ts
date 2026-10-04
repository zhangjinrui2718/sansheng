/**
 * 平台运行时 · 驱动者循环(谁手上有可执行的待办,就唤醒谁)
 *
 * ── 它补的是什么 ────────────────────────────────────────────────
 *
 * 在它之前,这个系统里**只有两个驱动者**:
 *
 *   - `host/serve.ts` 跑业务经理的回合(用户消息触发)
 *   - `cli/run.ts` 跑 worker(手工 CLI)
 *
 * 于是 `project_manager` 与 `quality_reviewer` **从来没有被叫醒过**:
 * 立项之后项目就停在那里,工作项一个都不会被拆出来,`projects=1, works=0,
 * artifacts=0` —— 真机实测就是这个状态。四个角色定义齐了,但不是一个组织。
 *
 * 这个模块把「谁此刻该动」变成一条可执行的判定,并**带硬上界地**把链子往下跑。
 *
 * ── ① 每个角色「可执行的待办」是什么 ─────────────────────────────
 *
 * | 角色 | 待办 | 判据 | 可靠吗 |
 * |---|---|---|---|
 * | `business_manager` | 有人升级给它 / 下游刚出结果要它向甲方交代 | `asksToAnswer` + 本层级联观察到的下游结果 | 前者是库里的 `open` ask;后者是**事件**,不是猜的判据 |
 * | `project_manager` | 有人问它 / 有变更待评 / **项目一个工作项都没有** | `asksToAnswer` · `pendingChanges` · `needsDecomposition` | 三条都是可查的事实 |
 * | `worker` | **分派给它、前置已满足、还没终态的工作项** | `myOpenWorks` | 是 |
 * | `quality_reviewer` | 有人问它 / 有变更待评 / **刚有工作项做完** | `asksToAnswer` · `pendingChanges` + 本层级联观察到的「工作项 → done」 | 「刚做完」是**平台观察到的事件** |
 *
 * **一句实话(第 4 列)**:现有模型里**没有**「等待审查」这个状态 ——
 * `works.status` 只有 open/in_progress/blocked/done/failed/cancelled,工件状态
 * 只有 open/accepted/rejected/superseded,`artifact_links` 的 rel 只有
 * parent/depends_on/answers,而质检**不持 `work.update`**(它改不了工作项状态)。
 * 也就是说:库里没有一处能回答「这条产出还没被审过」。
 *
 * 所以质检的唤醒判据**不是**从库里"查"出来的,而是**本层级联观察到的事件**:
 * 「刚才有一个工作项从非终态变成了 done」。这是真的 —— 平台确实知道这件事;
 * 它只是不持久,所以重启后不会补跑(这一点在报告里如实写明)。
 * **没有硬编一个看起来能跑但语义是假的判据。**
 *
 * ── ② 谁触发 ────────────────────────────────────────────────────
 *
 * 两个入口共用这一个函数,取舍写在 `host/serve.ts`:
 *   1. 用户那条消息的回合结束后 → 链式往下跑(延迟最优)
 *   2. 调度器 tick → 扫一次(捡回链子在上界处停下时剩下的)
 *
 * ── ③ 怎么保证一定会停 ──────────────────────────────────────────
 *
 * 三层,缺一层都不够:
 *
 *   1. **硬上界** `maxRounds`(默认 8,可配)。到界**不静默停**:`CascadeResult`
 *      带回 `stopReason`,宿主据此广播事件 + 落一条 system 消息。
 *   2. **无进展检测(级联内)**:同一 `(todo.key, 项目状态签名)` 在本层级联里
 *      出现第二次 → 停。判据是**状态签名**,不是「跑了几轮」。
 *   3. **无进展检测(跨级联)** `stallStore`:同一个待办在**同一个项目状态下**
 *      已经被叫醒过且什么也没改变 → 以后不再叫醒它。
 *      没有这一层,周期扫描会每 60 秒把同一个待办重叫一遍 —— 那是烧 token 的
 *      正解形态,而且它在日志里长得像「系统在正常工作」。
 *
 * ── ④ 每个回合给 agent 什么任务描述 ──────────────────────────────
 *
 * **不另造一套**:`runAgentTurn` 负责拼「项目上下文(A)+ 待办清单
 * (`renderPendingWork`)+ 本模块给出的这一段任务」;worker 那条走现成的
 * `runWorkItem`(它自己拼 `composeWorkPrompt`)。本模块只生产最后那一段。
 */
import type Database from "better-sqlite3";
import { collectPendingWork, hasActionableWork } from "./pendingWork.js";
import { listWorks, type WorkStatus } from "../storage/repo/works.js";
import { listAsks } from "../storage/repo/asks.js";
import { listBlockers, type BlockerRow } from "../storage/repo/blockers.js";
import { listChanges } from "../storage/repo/changes.js";
import { listMeetings, stanceTally } from "../storage/repo/meetings.js";
import { countArtifactsByKind } from "../storage/repo/artifacts.js";
import { getProjectRow, listAssignments, loadProjectRoster } from "../storage/repo/projects.js";
import { isProjectRole, type ProjectRole } from "../identity/role.js";
import type { ToolCallRecord } from "./turn.js";

// ── 待办的形状 ──────────────────────────────────────────────────

export type TodoKind =
  /** 有人提问,我在等答 —— 有人因此停着,最高优先级 */
  | "answer_ask"
  /** 有会议等我表态 */
  | "attend_meeting"
  /** 有变更提案等我评审 */
  | "review_change"
  /** 项目里一个工作项都没有 —— 拆解 */
  | "decompose_project"
  /** 分派给我、前置已满足的工作项 */
  | "execute_work"
  /** 刚有工作项做完,需要审查 */
  | "review_work"
  /** 下游出了结果,该由我向甲方交代 */
  | "report_downstream";

/**
 * 优先级。**数字小的先跑。**
 *
 * 次序的理由:
 *   - `answer_ask` 最前 —— 有人处于 blocked,不答它整条链停摆(设计 §5.1)
 *   - 其余按流程顺序:对齐(会议/变更)→ 拆解 → 执行 → 审查 → 汇报
 *   - `report_downstream` 最后 —— 它汇报的正是前面那些动作的结果
 */
const PRIORITY: Readonly<Record<TodoKind, number>> = {
  answer_ask: 0,
  attend_meeting: 1,
  review_change: 2,
  decompose_project: 3,
  execute_work: 4,
  review_work: 5,
  report_downstream: 6,
};

export interface DriverTodo {
  readonly agentId: string;
  readonly role: ProjectRole;
  readonly kind: TodoKind;
  /** 身份:`(agent, 待办)` 的稳定标识。无进展检测按它比对 */
  readonly key: string;
  /** 这一次要动的那条记录(目前只有 execute_work 用得上) */
  readonly target: string | null;
  /** 人读的一行 */
  readonly label: string;
}

/** 下游发生了什么 —— **由级联自己观察**,不是从库里"查"出来的判据。 */
export interface DownstreamResult {
  readonly kind: "work_done" | "work_failed" | "work_blocked" | "blocker_opened";
  readonly id: string;
  readonly summary: string;
}

/** 刚做完、待审的工作项。 */
export interface PendingReview {
  readonly workId: string;
  readonly title: string;
}

/** 级联运行中累积、且**只在本层级联里有效**的状态。 */
export interface CascadeState {
  readonly downstream: DownstreamResult[];
  readonly reviewQueue: PendingReview[];
}

export function emptyCascadeState(): CascadeState {
  return { downstream: [], reviewQueue: [] };
}

// ── 无进展记忆(跨级联)────────────────────────────────────────

export interface StallRecord {
  /** 被唤醒那一刻的项目状态签名 */
  readonly signature: string;
  readonly attempts: number;
}

export interface StallStore {
  get(key: string): StallRecord | undefined;
  set(key: string, rec: StallRecord): void;
  delete(key: string): void;
  /** 数据被重置时清掉 —— 那些 key 指向已经不存在的工作项/项目 */
  clear(): void;
}

/** 进程内实现。**重启即忘** —— 重启后每个待办最多再多被叫一次(如实写在注释里)。 */
export function createMemoryStallStore(): StallStore {
  const m = new Map<string, StallRecord>();
  return {
    get: (k) => m.get(k),
    set: (k, v) => { m.set(k, v); },
    delete: (k) => { m.delete(k); },
    clear: () => { m.clear(); },
  };
}

// ── 项目状态签名 ────────────────────────────────────────────────

/**
 * 一个项目的「状态指纹」。用在无进展检测上。
 *
 * **为什么要它,而不是「跟上次比有没有变化」这句话**:后者需要一个基线,
 * 而基线本身要么存库(多一份要维护的真相)、要么靠调用方记(每个调用方都得记得)。
 * 把状态算成一个字符串,就只需要比较两个字符串。
 *
 * ── 覆盖面的纪律:漏掉一类状态 = 一次**假的**「没有进展」────────────
 *
 * 这个函数少写一列,后果不是「检测变松」,而是**检测变紧** —— 一次真实的动作
 * 被读成「什么都没发生」,于是级联当场停下,而日志里写着
 * 「同一个待办已被叫醒过 1 次」。真机跑出来过:第一版漏了 `meetings`,于是
 * 项目经理**成功**在一场会上表了态(`meeting_respond` 落库、meeting 从
 * convened 推到 in_progress)之后被判成无进展,整条级联在最该往下走的那一步
 * 停住 —— 那个项目最后 `works=0`。
 *
 * 所以覆盖面刻意保守但**完整**:项目自身状态与成员、工作项状态与更新时间、
 * 提问、会议(**含各方是否已表态**)、阻塞、变更、工件**总数**。
 * 只写不读的工件(比如又写了一条 note)也会让计数变化 —— 那正是「它确实干了活」。
 */
export function projectSignature(db: Database.Database, projectId: string): string {
  const project = getProjectRow(db, projectId);
  const members = listAssignments(db, projectId)
    .map((a) => `${a.agentId}${a.removedAt !== undefined ? "-removed" : ""}`)
    .sort()
    .join(",");
  const works = listWorks(db, projectId)
    .map((w) => `${w.id}:${w.status}:${w.updatedAt}`)
    .join(",");
  const asks = listAsks(db, projectId).map((a) => `${a.id}:${a.status}`).join(",");
  // 会议:**立场分布**必须进签名 —— 参会方表态只改 `meeting_participants`,
  // 而 `meetings.status` 只在**第一个人**表态时从 convened 推到 in_progress。
  // 只看 status 会把「第二个人也表态了」读成没有任何变化。
  const meetings = listMeetings(db, projectId)
    .map((m) => {
      const t = stanceTally(db, m.id);
      return `${m.id}:${m.status}:${t.support}/${t.oppose}/${t.undecided}/${t.silent}`;
    })
    .join(",");
  const blockers = listBlockers(db, projectId)
    .map((b) => `${b.id}:${b.status}:${b.resolvedAt ?? 0}`)
    .join(",");
  const changes = listChanges(db, projectId)
    .map((c) => `${c.id}:${c.status}:${c.decidedAt ?? 0}`)
    .join(",");
  const artifacts = Object.values(countArtifactsByKind(db, projectId))
    .reduce((n, x) => n + x, 0);
  return (
    `P[${project?.status ?? "?"}:${members}]` +
    `W[${works}]Q[${asks}]M[${meetings}]B[${blockers}]C[${changes}]N${artifacts}`
  );
}

// ── 收集待办 ────────────────────────────────────────────────────

export interface CollectTodosOptions {
  readonly db: Database.Database;
  readonly projectId: string;
  readonly now: number;
  readonly state: CascadeState;
}

/**
 * 扫一遍这个项目,列出**此刻真的有人能动手**的待办,按优先级排好。
 *
 * 只考虑项目的**活跃成员**(花名册),不给不在项目里的人派活 ——
 * `buildToolContext` 的 `agent_not_assigned` 会在调用期把它拒掉,提前筛掉
 * 是为了不浪费一次唤醒。
 */
export function collectTodos(opts: CollectTodosOptions): DriverTodo[] {
  const { db, projectId, now, state } = opts;
  const project = getProjectRow(db, projectId);
  if (project === null) return [];

  const roster = loadProjectRoster(db, projectId);
  const todos: DriverTodo[] = [];

  for (const m of roster) {
    if (!isProjectRole(m.role)) continue;
    const role = m.role;
    const pw = collectPendingWork(db, m.id, projectId, now);
    // 库里挂着但我的工具面够不着的事,不叫醒我(理由见 hasActionableWork 注释)
    if (!hasActionableWork(pw)) continue;

    if (pw.asksToAnswer.length > 0) {
      todos.push({
        agentId: m.id, role, kind: "answer_ask",
        key: `answer_ask:${pw.asksToAnswer.map((a) => a.id).sort().join("+")}`,
        target: null,
        label: `回答 ${pw.asksToAnswer.length} 条等它的提问`,
      });
    }
    if (pw.meetingsToRespond.length > 0) {
      todos.push({
        agentId: m.id, role, kind: "attend_meeting",
        key: `attend_meeting:${pw.meetingsToRespond.map((x) => x.id).sort().join("+")}`,
        target: null,
        label: `对 ${pw.meetingsToRespond.length} 场会议表态`,
      });
    }
    if (role !== "business_manager" && pw.pendingChanges.length > 0) {
      todos.push({
        agentId: m.id, role, kind: "review_change",
        key: `review_change:${pw.pendingChanges.map((c) => c.id).sort().join("+")}`,
        target: null,
        label: `评审 ${pw.pendingChanges.length} 条变更`,
      });
    }
    if (pw.needsDecomposition) {
      todos.push({
        agentId: m.id, role, kind: "decompose_project",
        key: `decompose_project:${projectId}`,
        target: null,
        label: "把项目拆成工作项",
      });
    }
    // 执行只有 worker 能做 —— `runWorkItem` 的 checkRunnable 会在角色不对时拒绝,
    // 与其浪费一次唤醒,不如在这里就只认 worker。
    if (role === "worker") {
      for (const w of pw.myOpenWorks) {
        todos.push({
          agentId: m.id, role, kind: "execute_work",
          key: `execute_work:${w.id}`,
          target: w.id,
          label: `执行工作项 ${w.id}「${w.title}」`,
        });
      }
    }
  }

  // ── 由级联事件(而不是库)触发的两条 ──
  const bm = roster.find((m) => m.role === "business_manager");
  if (bm !== undefined && state.downstream.length > 0) {
    todos.push({
      agentId: bm.id, role: "business_manager", kind: "report_downstream",
      key: `report_downstream:${state.downstream.map((d) => d.id).sort().join("+")}`,
      target: null,
      label: `向甲方交代下游的 ${state.downstream.length} 条结果`,
    });
  }
  const qa = roster.find((m) => m.role === "quality_reviewer");
  if (qa !== undefined && state.reviewQueue.length > 0) {
    todos.push({
      agentId: qa.id, role: "quality_reviewer", kind: "review_work",
      key: `review_work:${state.reviewQueue.map((r) => r.workId).sort().join("+")}`,
      target: null,
      label: `审查 ${state.reviewQueue.length} 个刚完成的工作项`,
    });
  }

  return todos.sort(
    (a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.key.localeCompare(b.key),
  );
}

// ── 任务描述(④:不另造一套)─────────────────────────────────────

/** 渲染下游结果那一段 —— 只给业务经理的汇报回合用。 */
export function renderDownstream(state: CascadeState): string {
  if (state.downstream.length === 0) return "";
  const LABEL: Readonly<Record<DownstreamResult["kind"], string>> = {
    work_done: "工作项完成",
    work_failed: "工作项失败",
    work_blocked: "工作项受阻",
    blocker_opened: "新登记阻塞",
  };
  return [
    "## 下游刚发生的事(本层级联观察到的,不是猜的)",
    "",
    ...state.downstream.map((d) => `- [${LABEL[d.kind]}] \`${d.id}\` ${d.summary}`),
    "",
    "**这些条目来自本项目的库**,细节用 `project_read` / `board_read` 查证后再写。",
  ].join("\n");
}

/**
 * 一个待办对应的一句「现在轮到你了」。
 *
 * 刻意短:细节由上面的项目上下文与待办清单承载 —— 在这里重复一遍会白占
 * context,而且两份说法迟早会漂。
 */
export function renderTask(todo: DriverTodo, state: CascadeState): string {
  switch (todo.kind) {
    case "answer_ask":
      return (
        "# 现在轮到你了:回答提问\n\n" +
        "上面「等你的提问」里每一条都带着提问者的假设 —— 那是他思考过的结果。\n" +
        "**能自己判断的直接 `answer`**,判不了才 `escalate`(目标由平台计算,你指定不了)。\n" +
        "不要只是回一段话:不调 `answer`,提问者就一直 block 着。"
      );
    case "attend_meeting":
      return (
        "# 现在轮到你了:会议表态\n\n" +
        "用 `meeting_read` 看议题与已有立场,再 `meeting_respond` 表态。\n" +
        "**反对必须写理由** —— 没有理由的反对,主持人无法据此调整方案。"
      );
    case "review_change":
      return (
        "# 现在轮到你了:评审变更提案\n\n" +
        "用 `change_read` 看理由与影响面,再用 `change_review` 推进状态。\n" +
        "**没评审就实施**是这类流程最典型的漏洞 —— 所以这个动作不能省。"
      );
    case "decompose_project":
      return (
        "# 现在轮到你了:把项目拆成工作项\n\n" +
        "项目刚立起来,**一个工作项都还没有**。这是你的第一件事。\n\n" +
        "1. 先 `board_list` 看黑板上有没有人已经做过什么(重复规划是最贵的错误)\n" +
        "2. 用 `work_create` 拆出**能各自独立开工**的工作项;每个都给负责人与" +
        "**可验证的判据**,依赖关系用 `dependsOn` 显式写出来\n" +
        "3. 拆完**不要自己动手做** —— 你不持 `code.*`,执行是 worker 的事\n\n" +
        "工作项一旦建出来,worker 会被自动唤醒去跑它们 —— 你不需要再去催。"
      );
    case "review_work":
      return (
        "# 现在轮到你了:审查刚完成的产出\n\n" +
        `${renderDownstream(state)}\n\n` +
        "用 `board_list` / `work_read` 核实:**目标达成了吗?依据能复核吗?边界越了吗?**\n" +
        "然后把结论写成 `review_finding` —— **通过也要写通过的依据**(「我核对了 X、Y、Z」),\n" +
        "「过了」两个字在事后没有任何价值。"
      );
    case "report_downstream":
      return (
        "# 现在轮到你了:主动向甲方交代进展\n\n" +
        "**没有人向你提问。** 你是被下游的结果唤醒的 —— 甲方不知道刚才发生了什么,\n" +
        "而这正是你该主动做的事(不要等他来问)。\n\n" +
        `${renderDownstream(state)}\n\n` +
        "值得让他知道的,用 `tell_client` 播报;**不值得打扰他的,就不要播**" +
        "(他的注意力是稀缺资源)。有分量的结论仍然要 `board_write` —— " +
        "播报不替代落库。"
      );
    case "execute_work":
      // worker 那条不走这里 —— `runWorkItem` 自己拼 `composeWorkPrompt`。
      // 留着这一支是为了穷尽性:新增 TodoKind 时这里会编译失败。
      return "# 现在轮到你了:执行工作项\n";
  }
}

// ── 级联 ────────────────────────────────────────────────────────

/** 一次 agent 回合的返回形态(宿主按 `TurnResult` / `ExecutionResult` 填)。 */
export interface CascadeTurnReport {
  readonly aborted: boolean;
  readonly timedOut: boolean;
  readonly text: string;
  readonly toolCalls: readonly ToolCallRecord[];
}

export interface CascadeWorkReport extends CascadeTurnReport {
  readonly workId: string;
  readonly title: string;
  readonly status: WorkStatus;
}

export interface CascadeDeps {
  readonly db: Database.Database;
  readonly projectId: string;
  readonly now: () => number;
  /** 跑一个非执行类的 agent 回合(宿主负责建会话 / 桥事件 / 落库)。 */
  readonly runAgentTurn: (agentId: string, task: string) => Promise<CascadeTurnReport>;
  /** 跑一个工作项(宿主走 `runWorkItem`)。 */
  readonly runWork: (agentId: string, workId: string) => Promise<CascadeWorkReport>;
  readonly log: (line: string) => void;
  /** 单次**级联**最多跑几个 agent 回合。默认 8。**必须保守** —— 它是烧 token 的上界。 */
  readonly maxRounds?: number;
  readonly stallStore?: StallStore;
  /**
   * 级联状态(下游结果 / 待审队列)。
   *
   * **由调用方持有、跨级联复用** —— 这是真机跑出来的一条洞:
   *
   *   一次级联撞上 `maxRounds` 停下时,它这一路累积的「下游刚做完什么」
   *   与「哪些产出等着审」如果只活在这个函数的局部变量里,就**随它一起消失**。
   *   后果不是报错,而是:工作项做完了,业务经理**永远不会**被叫醒来汇报,
   *   质检也永远不会看那两条产出 —— 而日志里只有一句「已达上限,已停下」,
   *   看起来像一次正常的限流。
   *
   * 所以调用方(宿主)按项目持有一份,下一次级联接着用。
   * 传 `undefined` 时每次新建(测试与一次性调用用)。
   */
  readonly state?: CascadeState;
  /** 用户中断:每回合前后各看一次 */
  readonly isCancelled?: () => boolean;
}

export type CascadeStopReason = "exhausted" | "max_rounds" | "no_progress" | "cancelled";

export interface CascadeVisit {
  readonly agentId: string;
  readonly kind: TodoKind;
  readonly label: string;
}

export interface CascadeResult {
  readonly projectId: string;
  readonly rounds: number;
  readonly stopReason: CascadeStopReason;
  /** 为什么停的一句话 —— 撞上界时宿主据此告诉用户 */
  readonly stopDetail: string;
  readonly visited: readonly CascadeVisit[];
  /** 本层级联观察到、且还没被汇报出去的下游结果 */
  readonly downstream: readonly DownstreamResult[];
  /** 有没有真的叫醒过业务经理去汇报 */
  readonly reportedToClient: boolean;
}

const DEFAULT_MAX_ROUNDS = 8;

/**
 * 把这个项目里此刻所有的待办**链式**跑下去,直到没有待办、或撞上界、或没有进展。
 *
 * 它**不建会话、不发 WS 事件、不写会话消息** —— 那三件事由宿主提供的那两个
 * 回调负责。这样这个循环可以在没有任何 provider / 网络的情况下被穷举测试
 * (见 `tests/platform/driver.test.ts`),而「会不会失控」这条最要紧的性质
 * 也因此是**可测的**而不是「看起来应该会停」。
 */
export async function runCascade(deps: CascadeDeps): Promise<CascadeResult> {
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const stall = deps.stallStore ?? createMemoryStallStore();
  const state = deps.state ?? emptyCascadeState();
  const visited: CascadeVisit[] = [];
  let rounds = 0;
  let stopReason: CascadeStopReason = "exhausted";
  let stopDetail = "没有可执行的待办了";
  let reportedToClient = false;

  // 级联内已经试过的 (todo.key, 签名) —— 与跨级联的 stallStore 是两层保险:
  // 后者防止「周期扫描反复叫醒同一个待办」,前者防止「同一层级联里绕回来」。
  const attempted = new Set<string>();

  for (;;) {
    if (deps.isCancelled?.() === true) {
      stopReason = "cancelled";
      stopDetail = "用户中断了这次级联";
      break;
    }
    if (rounds >= maxRounds) {
      stopReason = "max_rounds";
      stopDetail =
        `已达单次级联上限 ${maxRounds} 个 agent 回合,仍有待办没跑完 —— ` +
        `已停下(不是静默停:这条会广播并落库)`;
      break;
    }

    const now = deps.now();
    const todos = collectTodos({ db: deps.db, projectId: deps.projectId, now, state });
    if (todos.length === 0) {
      stopReason = "exhausted";
      stopDetail = "没有可执行的待办了";
      break;
    }

    const signature = projectSignature(deps.db, deps.projectId);
    /**
     * **把卡住的那一条剔掉,而不是整条级联陪它一起停。**
     *
     * 一个人在同一个状态上原地转圈,不代表别人手上的活也不能干 ——
     * 真机跑出来过:项目经理在一场会上表态之后(当时的签名漏了会议)被判成
     * 无进展,于是整条级联在最需要往下走的那一步停住,而 worker 手上的活
     * 一条都没开。一条待办卡住是**局部**事实,处置也必须是局部的。
     */
    const stalledFor = (t: DriverTodo): StallRecord | undefined => {
      const rec = stall.get(`${deps.projectId}::${t.key}`);
      return rec !== undefined && rec.signature === signature ? rec : undefined;
    };
    const runnable = todos.filter(
      (t) => stalledFor(t) === undefined && !attempted.has(`${t.key}@${signature}`),
    );
    if (runnable.length === 0) {
      stopReason = "no_progress";
      const first = todos[0]!;
      const rec = stalledFor(first);
      stopDetail =
        `${todos.length} 条待办在当前项目状态下都已经试过且没有产生任何变化` +
        `(例如「${first.label}」被叫醒过 ${rec?.attempts ?? 1} 次)—— ` +
        `再叫也不会有不同的结果,已停下`;
      deps.log(`driver: 无进展,停止 —— ${stopDetail}`);
      break;
    }

    /**
     * **最后一个回合留给「向甲方交代」。**
     *
     * 撞上界之前,`execute_work`(优先级 4)总是压过 `report_downstream`(6)。
     * 拆分得大一点时,后果是甲方在整个批次跑完之前**什么都听不到** ——
     * 而这是唯一一个「不做的代价是无人察觉」的动作:worker 的活下一次级联
     * 接着干,甲方却不会知道有人在为他干活。
     *
     * 所以只在**最后一格预算**里做这个调度:有攒下的下游结果就先汇报掉。
     * 代价是这一轮可能早于质检结论(所以提示词要求它先查证再写,不要凭摘要
     * 说「质检已通过」)。
     */
    const lastRound = rounds === maxRounds - 1;
    const todo = lastRound
      ? (runnable.find((t) => t.kind === "report_downstream") ?? runnable[0]!)
      : runnable[0]!;
    const stallKey = `${deps.projectId}::${todo.key}`;
    const prev = stall.get(stallKey);
    attempted.add(`${todo.key}@${signature}`);

    const blockersBefore = new Set(
      listBlockers(deps.db, deps.projectId).map((b) => b.id),
    );

    rounds++;
    visited.push({ agentId: todo.agentId, kind: todo.kind, label: todo.label });
    deps.log(
      `driver: 第 ${rounds}/${maxRounds} 回合 → ${todo.agentId}(${todo.role}) · ${todo.label}`,
    );

    let aborted = false;
    let workStatus: WorkStatus | null = null;
    let workTitle = "";
    try {
      if (todo.kind === "execute_work") {
        if (todo.target === null) {
          // 不该发生:execute_work 一定带 target。硬失败而不是猜一个工作项。
          stopReason = "no_progress";
          stopDetail = "execute_work 待办没有带工作项 id —— 装配错误,已停下";
          break;
        }
        const r = await deps.runWork(todo.agentId, todo.target);
        aborted = r.aborted;
        workStatus = r.status;
        workTitle = r.title;
      } else {
        const r = await deps.runAgentTurn(todo.agentId, renderTask(todo, state));
        aborted = r.aborted;
      }
    } catch (err) {
      // 一次回合抛错**不该**让整个级联炸掉 —— 后面可能还有别的角色能动。
      // 但要留现场:日志里写清是谁、哪个待办、什么错。
      deps.log(
        `driver: ✖ ${todo.agentId} 的「${todo.label}」抛错 —— ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 后置:算进展、累积下游结果 ──
    const postSignature = projectSignature(deps.db, deps.projectId);
    if (postSignature === signature) {
      stall.set(stallKey, { signature, attempts: (prev?.attempts ?? 0) + 1 });
    } else {
      stall.delete(stallKey);
    }

    if (workStatus === "done") {
      state.downstream.push({
        kind: "work_done", id: todo.target ?? "", summary: `「${workTitle}」已完成`,
      });
      state.reviewQueue.push({ workId: todo.target ?? "", title: workTitle });
    } else if (workStatus === "failed") {
      state.downstream.push({
        kind: "work_failed", id: todo.target ?? "", summary: `「${workTitle}」失败了`,
      });
    } else if (workStatus === "blocked") {
      state.downstream.push({
        kind: "work_blocked", id: todo.target ?? "", summary: `「${workTitle}」受阻`,
      });
    }

    for (const b of listBlockers(deps.db, deps.projectId)) {
      if (blockersBefore.has(b.id)) continue;
      state.downstream.push({
        kind: "blocker_opened", id: b.id, summary: `${titleOfBlocker(b)}[${b.severity}]`,
      });
    }

    if (todo.kind === "review_work") {
      // 审查这件事**一次性**:队列交出去之后清空。
      // 不按「有没有写出 review_finding」来判 —— 那个判据依赖模型自己建立
      // artifact_link,现有模型里没有保证(见文件头 ①)。清空是可预期的终止,
      // 而「它到底审了没有」由这一回合的工具调用现场回答。
      state.reviewQueue.length = 0;
    }
    if (todo.kind === "report_downstream") {
      // 已经交代过了 —— 清空,否则同一批结果会一直挂在待办里。
      state.downstream.length = 0;
      reportedToClient = true;
    }

    if (aborted) {
      stopReason = "cancelled";
      stopDetail = "用户中断了这次级联";
      break;
    }
  }

  deps.log(
    `driver: 级联结束(${rounds} 回合 · ${stopReason})—— ${stopDetail}`,
  );
  return {
    projectId: deps.projectId,
    rounds,
    stopReason,
    stopDetail,
    visited,
    downstream: state.downstream,
    reportedToClient,
  };
}

function titleOfBlocker(b: BlockerRow): string {
  return `${b.title} `;
}

/**
 * 供宿主与测试复用:这个项目的待办快照(一次性,不跑任何东西)。
 *
 * ⚠️ **`state` 必须传调用方持有的那一份**。不传时按空状态算 —— 而空状态看不见
 * 「下游刚做完什么」与「哪些产出等着审」,于是周期扫描的门会判成「没有待办」并
 * 直接跳过。真机跑出来过:上限截断的那次级联留下的待汇报结果,因此**永远不会**
 * 被汇报(见 `CascadeDeps.state` 的说明)。
 */
export function peekTodos(
  db: Database.Database,
  projectId: string,
  now: number,
  state: CascadeState = emptyCascadeState(),
): DriverTodo[] {
  return collectTodos({ db, projectId, now, state });
}
