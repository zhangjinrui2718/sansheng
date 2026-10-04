/**
 * 平台运行时 · 排空器(outbox / dispatcher)
 *
 * ── 它取代的是什么 ──────────────────────────────────────────────
 *
 * 批次 20 的 `driver.ts` 是一个**有状态的级联**:用户那条消息的回合结束后
 * 链式往下跑,状态(`downstream` / `reviewQueue` / `stallStore`)活在进程内存里。
 * 真机跑通了三生第一条完整链路,代价是六个补丁 —— 而六个补丁是**同一个根因**:
 * 把「刚才发生了什么」放在内存里,于是不得不靠状态签名、预算、跨级联记忆去弥补。
 * 真机跑出来的三个洞:
 *
 *   1. 撞上 `maxRounds` 停下时,那一路攒的「工作项做完了」随调用消失
 *      → 工作项做完了**永远没人向甲方汇报**(日志里只有一句「已达上限」)
 *   2. 质检的待办判据是级联观察到的内存事件(「工作项刚变成 done」)
 *      → 不持久、**重启后不补跑**
 *   3. 项目状态签名漏了 `meetings` → 项目经理成功表态却被判「无进展」,
 *      整条级联当场停住(那个项目最后 `works=0`)
 *
 * ── 现在的形状(三句话)──────────────────────────────────────────
 *
 *   判定  `collectTodos(db, projectId, now)` —— **纯查询**,唯一一处「下一步该谁跑」
 *   排空  `drainProject(deps)` —— 查到就跑到没有为止(有硬上界)
 *   触发 ① 状态迁移后的 nudge(事件)② fixed-delay 定时器(兜底)
 *         两者都**不携带任何状态**,只说「现在去查一下」
 *
 * **事件只是门铃,判定永远重新查库。** 这是本模块唯一的纪律:任何「上次发生过
 * 什么」都不许作为输入传进 `collectTodos` —— 那正是上面六个缺陷的来源。
 *
 * ── 为什么「等待审查」不再需要内存状态 ──────────────────────────
 *
 * `works.review_state`(migration 013)是三态的真状态:`none | pending | done`。
 * 迁入 `done` 时置 `pending`(`repo/works.ts` 的 `updateWorkStatus` —— status 的
 * 唯一写口),质检回合成功结束后由平台置 `done`。于是质检的待办就是**一条查询**,
 * 重启后照样查得出来。
 *
 * 「下游发生了什么、还没向甲方交代」同理落进 `dispatch_events`(outbox):
 * 工作项迁入终态、或登记了新阻塞时写一行,业务经理的汇报待办
 * 就是「这个项目还有没被交代的事件吗」。撞上界丢不掉它 —— 它在库里。
 *
 * ⚠️ **但这一层不再收「全部状态迁移」**:outbox 从「事件流水」缩成了
 * 「待交代队列」—— 写入侧的**可打扰判据**(根工作项 / 里程碑 / failed /
 * high|critical 的阻塞)在 `repo/works.ts` 的 `updateWorkStatus` 与
 * `repo/dispatch.ts` 的 `insertDispatchEvent`,**不在判定侧收窄**。
 * 为什么必须是写入侧:消费是全量的(`consumePendingDispatchEvents` 无差别标记
 * 全部未消费行),一次可打扰事件会把一串不可打扰事件一起标记为已交代,
 * 于是 `consumed_at` 开始撒谎。理由与代价见 `repo/works.ts` 那段长注释。
 */
import type Database from "better-sqlite3";
import { collectPendingWork, hasActionableWork } from "./pendingWork.js";
import { getAgent } from "../storage/repo/agents.js";
import {
  getProjectRow, loadProjectRoster,
} from "../storage/repo/projects.js";
import {
  listWorks, getWork, listWorksPendingReview, markWorkReviewed,
  isTerminalWorkStatus, type WorkStatus,
} from "../storage/repo/works.js";
import {
  bumpAttempt, consumePendingDispatchEvents, listAttempts,
  listPendingDispatchEvents, markAttemptNotified, pruneAttempts,
} from "../storage/repo/dispatch.js";
import { ROLE_SPECS, isProjectRole, type ProjectRole } from "../identity/role.js";
import type { Capability } from "../harness/capability.js";
import type { ToolCallRecord } from "./turn.js";

// ── 待办的形状 ──────────────────────────────────────────────────

export type TodoKind =
  /** 有人提问,我在等答 —— 有人因此停着,最高优先级 */
  | "answer_ask"
  /** 有会议等我表态 */
  | "attend_meeting"
  /** 有变更提案等我评审 */
  | "review_change"
  /** 有工作项被派给了非 worker(平台不会执行它)—— 派活的人必须改派或关掉 */
  | "fix_work_assignment"
  /** 项目里一个工作项都没有 —— 拆解 */
  | "decompose_project"
  /** 分派给我、前置已满足的工作项 */
  | "execute_work"
  /** 有工作项做完了、还等着审(`works.review_state = 'pending'`) */
  | "review_work"
  /** 下游出了结果,该由我向甲方交代(未消费的 outbox 事件) */
  | "report_downstream";

/**
 * 优先级。**数字小的先跑。**
 *
 * 次序的理由:
 *   - `answer_ask` 最前 —— 有人处于 blocked,不答它整条链停摆(设计 §5.1)
 *   - 其余按流程顺序:对齐(会议/变更)→ 修派活 → 拆解 → 执行 → 审查 → 汇报
 *   - `report_downstream` 最后 —— 它汇报的正是前面那些动作的结果
 *
 * ⚠️ 批次 20 在这里额外有一条「**最后一格预算留给汇报**」的特例(否则甲方
 * 在整个批次跑完前什么都听不到)。它现在**整块删掉了**:汇报这件事不再会丢
 * (outbox 在库里,下一次排空、乃至重启之后照样查得出来),所以次序可以是一条
 * 纯粹的优先级规则 —— 没有特例,也就没有特例与优先级不一致的那一类 bug。
 */
const PRIORITY: Readonly<Record<TodoKind, number>> = {
  answer_ask: 0,
  attend_meeting: 1,
  review_change: 2,
  fix_work_assignment: 3,
  decompose_project: 4,
  execute_work: 5,
  review_work: 6,
  report_downstream: 7,
};

export interface DriverTodo {
  readonly agentId: string;
  readonly role: ProjectRole;
  readonly kind: TodoKind;
  /** 所属项目。渲染现场(`renderTask`)要它 —— 不靠 key 里有没有项目 id 去猜 */
  readonly projectId: string;
  /** 身份:`(agent, 待办)` 的稳定标识。尝试预算按它记账 */
  readonly key: string;
  /** 这一次要动的那条记录(目前只有 execute_work 用得上) */
  readonly target: string | null;
  /** 这个待办覆盖的记录 id(`review_work` 的 work ids;消费时用) */
  readonly refs: readonly string[];
  /**
   * 目标行的版本(`updated_at`)。**只有它动过,尝试预算才清零** ——
   * 没有目标行的待办为 `null`,它们的版本信息已经在 `key` 里
   * (例如 `answer_ask:a1+a2`:集合变了 key 就变,预算是新的)。
   */
  readonly targetState: number | null;
  /** 已经叫醒过几次(来自库里的预算账本) */
  readonly attempts: number;
  /** 人读的一行 */
  readonly label: string;
}

export interface TodoBoard {
  readonly projectId: string;
  /** 现在可以叫醒的待办,已按优先级排好 */
  readonly runnable: readonly DriverTodo[];
  /**
   * **预算已经用完、不再叫醒**的待办。
   *
   * 它们不在 `runnable` 里(再叫也不会有不同的结果),但**必须能被如实报出来**:
   * 静默放弃与「系统在正常工作」在日志里长得一样,那是本项目反复栽过的形态。
   */
  readonly exhausted: readonly DriverTodo[];
}

// ── 事件 nudge(触发点之一)─────────────────────────────────────

/**
 * 哪些**成功的**工具调用算「状态迁移」,值得敲一下门铃。
 *
 * 判据是「这次调用可能改变**流水线**的状态」—— 于是 `blackboard.write`(产出)
 * 不在里面:写工件不产生新待办(工件不是待办来源),而 `work.update` 会
 * (做完了要审、要汇报)。`project.read` 之类只读的自然也不算。
 *
 * 门铃**不携带任何状态**,只让排空器「现在去查一下」。挂在这里(工具派发的
 * 唯一漏斗)而不是散在十几个工具里:散着写迟早漏一个,而漏掉的表现是
 * 「这件事要等下一次定时器」—— 一个只在延迟上显形、很难归因的 bug。
 */
export const NUDGE_CAPABILITIES: readonly Capability[] = [
  "project.open",
  "work.create", "work.update", "work.assign", "work.report",
  "collab.ask", "collab.answer", "collab.escalate",
  "collab.convene", "collab.meeting.respond", "collab.meeting.conclude",
  "change.propose", "change.review",
  "blocker.open", "blocker.update",
];

// ── 判定:纯查询 ─────────────────────────────────────────────────

export interface CollectTodosOptions {
  readonly db: Database.Database;
  readonly projectId: string;
  /** 时钟。**只用来算「已超时」之类的时间比较,不参与任何记忆** */
  readonly now: number;
  /** 单条待办的尝试预算。缺省 3 */
  readonly maxAttemptsPerTodo?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 扫一遍这个项目,列出**此刻真的有人能动手**的待办。
 *
 * ⚠️ 这是全系统**唯一**一处「下一步该谁跑」的判定,所以它的纯度是这套设计的
 * 地基:入参只有 `(db, projectId, now, 预算上限)`,不读任何进程内状态、
 * 不接收「上次发生了什么」。每个 tick、每次门铃都从库重新算。
 *
 * 只考虑项目的**活跃成员**(花名册),并且逐条按角色的 ceiling 过一遍 ——
 * 库里挂着而我的工具面够不着的事(例如业务经理推不动变更)不该把我叫醒:
 * 叫醒了也只能空转一轮。这与 `hasActionableWork` 同源,只是这里要逐条判定,
 * 不能再合并成一个布尔。
 */
export function collectTodos(opts: CollectTodosOptions): TodoBoard {
  const { db, projectId, now } = opts;
  const maxAttempts = opts.maxAttemptsPerTodo ?? DEFAULT_MAX_ATTEMPTS;
  const project = getProjectRow(db, projectId);
  if (project === null) return { projectId, runnable: [], exhausted: [] };

  const roster = loadProjectRoster(db, projectId);
  const todos: Omit<DriverTodo, "attempts" | "projectId">[] = [];

  for (const m of roster) {
    if (!isProjectRole(m.role)) continue;
    const role = m.role;
    const pw = collectPendingWork(db, m.id, projectId, now);
    /**
     * 派给非 worker 的工作项**平台不会执行**(`runWorkItem.checkRunnable` 拒绝),
     * 而它也不会让 `needsDecomposition` 为真(项目里确实有工作项)——
     * 于是它谁也不叫醒,永远停在那儿。真机现场就是这样:项目经理把
     * 「与甲方对齐业务场景」派给了业务经理,那条工作项至今 `open`。
     *
     * 现在的处置分两层:
     *   - **调用期** `work_create` / `work_assign` 直接拒收非 worker 的负责人
     *   - **存量数据**(那条已经躺在库里的工作项)由这条待办兜住:叫醒派活的人
     *     去改派或关掉它。可见,可处置,不静默。
     */
    const stranded =
      role === "project_manager"
        ? listWorks(db, projectId).filter((w) => {
            if (isTerminalWorkStatus(w.status)) return false;
            const a = getAgent(db, w.assigneeAgentId);
            return a === null || a.role !== "worker";
          })
        : [];

    // 库里挂着但我的工具面够不着的事,不叫醒我(与 `hasActionableWork` 同源:
    // 叫醒了也只能空转一轮)。「没人能执行的存量工作项」是唯一的例外 ——
    // 它恰恰**不**在 actionable 里(执行不是项目经理的能力),但必须有人处置。
    if (!hasActionableWork(pw) && stranded.length === 0) continue;

    if (pw.asksToAnswer.length > 0) {
      const ids = pw.asksToAnswer.map((a) => a.id).sort();
      todos.push({
        agentId: m.id, role, kind: "answer_ask",
        key: `answer_ask:${ids.join("+")}`, target: null, refs: ids, targetState: null,
        label: `回答 ${ids.length} 条等它的提问`,
      });
    }
    if (pw.meetingsToRespond.length > 0) {
      const ids = pw.meetingsToRespond.map((x) => x.id).sort();
      todos.push({
        agentId: m.id, role, kind: "attend_meeting",
        key: `attend_meeting:${ids.join("+")}`, target: null, refs: ids, targetState: null,
        label: `对 ${ids.length} 场会议表态`,
      });
    }
    // 变更只有持 `change.review` 的角色推得动(业务经理只有 change.read),
    // 而 `hasActionableWork` 已经按 ceiling 判过这一条。
    if (pw.pendingChanges.length > 0 && ROLE_SPECS[role].ceiling.includes("change.review")) {
      const ids = pw.pendingChanges.map((c) => c.id).sort();
      todos.push({
        agentId: m.id, role, kind: "review_change",
        key: `review_change:${ids.join("+")}`, target: null, refs: ids, targetState: null,
        label: `评审 ${ids.length} 条变更`,
      });
    }
    if (pw.needsDecomposition) {
      todos.push({
        agentId: m.id, role, kind: "decompose_project",
        key: `decompose_project:${projectId}`, target: null, refs: [], targetState: null,
        label: "把项目拆成工作项",
      });
    }
    // 执行只有 worker 能做 —— `runWorkItem.checkRunnable` 会在角色不对时拒绝,
    // 与其浪费一次唤醒,不如在这里就只认 worker。
    if (role === "worker") {
      for (const w of pw.myOpenWorks) {
        todos.push({
          agentId: m.id, role, kind: "execute_work",
          key: `execute_work:${w.id}`, target: w.id, refs: [w.id], targetState: w.updatedAt,
          label: `执行工作项 ${w.id}「${w.title}」`,
        });
      }
    }
    if (stranded.length > 0) {
      const ids = stranded.map((w) => w.id).sort();
      todos.push({
        agentId: m.id, role, kind: "fix_work_assignment",
        key: `fix_work_assignment:${ids.join("+")}`, target: null, refs: ids, targetState: null,
        label: `处置 ${ids.length} 条没人能执行的工作项`,
      });
    }
  }

  // ── 由库里的真状态(而不是级联事件)触发的两条 ──
  const bm = roster.find((m) => m.role === "business_manager");
  const events = listPendingDispatchEvents(db, projectId);
  if (bm !== undefined && events.length > 0) {
    const version = Math.max(...events.map((e) => e.seq));
    todos.push({
      agentId: bm.id, role: "business_manager", kind: "report_downstream",
      key: `report_downstream:${version}`, target: null, refs: [], targetState: version,
      label: `向甲方交代下游的 ${events.length} 条结果`,
    });
  }
  const qa = roster.find((m) => m.role === "quality_reviewer");
  const pendingReview = listWorksPendingReview(db, projectId);
  if (qa !== undefined && pendingReview.length > 0) {
    const ids = pendingReview.map((w) => w.id).sort();
    todos.push({
      agentId: qa.id, role: "quality_reviewer", kind: "review_work",
      key: `review_work:${ids.join("+")}`, target: null, refs: ids, targetState: null,
      label: `审查 ${ids.length} 个已完成的工作项`,
    });
  }

  // ── 尝试预算:唯一的「不再叫醒」判据,而且它在库里 ──
  const ledger = listAttempts(db, projectId);
  const withAttempts: DriverTodo[] = todos.map((t) => ({
    ...t,
    projectId,
    attempts: ledger.get(t.key)?.attempts ?? 0,
  }));
  const sorted = withAttempts.sort(
    (a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.key.localeCompare(b.key),
  );

  return {
    projectId,
    runnable: sorted.filter((t) => t.attempts < maxAttempts),
    exhausted: sorted.filter((t) => t.attempts >= maxAttempts),
  };
}

// ── 任务描述 ────────────────────────────────────────────────────

/**
 * 一个待办对应的一句「现在轮到你了」。
 *
 * 刻意短:细节由注入的项目上下文与待办清单承载 —— 在这里重复一遍会白占
 * context,而且两份说法迟早会漂。
 *
 * 它读库(`db`)只为把「下游刚刚发生了什么 / 哪些产出等着审」渲染成现场 ——
 * 那是**查出来的事实**,不是从上一轮传下来的状态。
 */
export function renderTask(db: Database.Database, todo: DriverTodo): string {
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
    case "fix_work_assignment":
      return (
        "# 现在轮到你了:处置没人能执行的工作项\n\n" +
        "下面这些工作项的负责人**不是 worker**,而平台只让 worker 执行工作项 —— " +
        "它们会永远停在原地。\n\n" +
        renderStrandedWorks(db, todo) +
        "\n\n用 `work_assign` 把它们改派给 worker(或者用 `work_update` 关掉不该存在的)," +
        "然后在同一条回复里说明你怎么处置的。"
      );
    case "decompose_project":
      return (
        "# 现在轮到你了:把项目拆成工作项\n\n" +
        "项目刚立起来,**一个工作项都还没有**。这是你的第一件事。\n\n" +
        "1. 先 `board_list` 看黑板上有没有人已经做过什么(重复规划是最贵的错误)\n" +
        "2. 用 `work_create` 拆出**能各自独立开工**的工作项;每个都给负责人与" +
        "**可验证的判据**,依赖关系用 `dependsOn` 显式写出来\n" +
        "   —— 负责人只能是 **worker**(执行角色),别的角色不执行工作项\n" +
        "   多件产出同属**一个交付物**时,用 `parentWorkId` 把它们挂到一条根工作项下面\n" +
        "   —— 中间工作项的完成只对项目内部可见,整个交付物收口才向甲方交代一次\n" +
        "3. 拆完**不要自己动手做** —— 你不持 `code.*`,执行是 worker 的事\n\n" +
        "工作项一旦建出来,worker 会被自动唤醒去跑它们 —— 你不需要再去催。"
      );
    case "review_work":
      return (
        "# 现在轮到你了:审查刚完成的产出\n\n" +
        renderPendingReviews(db, todo) +
        "\n\n用 `board_list` / `work_read` 核实:**目标达成了吗?依据能复核吗?边界越了吗?**\n" +
        "然后把结论写成 `review_finding` —— **通过也要写通过的依据**(「我核对了 X、Y、Z」),\n" +
        "「过了」两个字在事后没有任何价值。"
      );
    case "report_downstream":
      return (
        "# 现在轮到你了:主动向甲方交代进展\n\n" +
        "**没有人向你提问。** 你是被下游的结果唤醒的 —— 甲方不知道刚才发生了什么,\n" +
        "而这正是你该主动做的事(不要等他来问)。\n\n" +
        renderDownstream(db, todo) +
        "\n\n值得让他知道的,用 `tell_client` 播报;**不值得打扰他的,就不要播**" +
        "(他的注意力是稀缺资源)。有分量的结论仍然要 `board_write` —— " +
        "播报不替代落库。\n\n" +
        "下面这些事件**已经过写入侧的筛子**(只留根工作项 / 里程碑 / 失败 / " +
        "高severity 阻塞)—— 但「库里记了一笔」不等于「值得播报」:整批可以合成一句,也可以不播。"
      );
    case "execute_work":
      // worker 那条不走这里 —— `runWorkItem` 自己拼 `composeWorkPrompt`。
      // 留着这一支是为了穷尽性:新增 TodoKind 时这里会编译失败。
      return "# 现在轮到你了:执行工作项\n";
  }
}

const EVENT_LABEL: Readonly<Record<string, string>> = {
  work_done: "工作项完成",
  work_failed: "工作项失败",
  work_blocked: "工作项受阻",
  work_cancelled: "工作项取消",
  blocker_opened: "新登记阻塞",
};

/** 未交代的下游事件(查出来的现场,不是上一轮传下来的状态)。 */
function renderDownstream(db: Database.Database, todo: DriverTodo): string {
  const events = listPendingDispatchEvents(db, todo.projectId);
  if (events.length === 0) return "";
  return [
    "## 下游刚发生的事(从库里查出来的,不是猜的)",
    "",
    ...events.map((e) => `- [${EVENT_LABEL[e.kind] ?? e.kind}] ${e.summary}`),
    "",
    "**细节用 `project_read` / `board_read` / `blocker_read` 查证后再写。**",
  ].join("\n");
}

function renderPendingReviews(db: Database.Database, todo: DriverTodo): string {
  const rows = todo.refs
    .map((id) => getWork(db, id))
    .filter((w): w is NonNullable<typeof w> => w !== null);
  if (rows.length === 0) return "";
  return [
    "## 等着审的产出(库里 `review_state = 'pending'`)",
    "",
    ...rows.map((w) => `- \`${w.id}\`「${w.title}」(${w.assigneeAgentId})`),
  ].join("\n");
}

function renderStrandedWorks(db: Database.Database, todo: DriverTodo): string {
  const lines: string[] = [];
  for (const id of todo.refs) {
    const w = getWork(db, id);
    if (w === null) continue;
    const a = getAgent(db, w.assigneeAgentId);
    lines.push(
      `- \`${w.id}\`「${w.title}」→ ${a === null ? w.assigneeAgentId : `${a.displayName}(${a.role})`}` +
        `[${w.status}]`,
    );
  }
  return lines.join("\n");
}

// ── 排空 ────────────────────────────────────────────────────────

/** 一次 agent 回合的返回形态(宿主按 `TurnResult` / `ExecutionResult` 填)。 */
export interface DrainTurnReport {
  readonly aborted: boolean;
  readonly timedOut: boolean;
  readonly text: string;
  readonly toolCalls: readonly ToolCallRecord[];
  /** 会话没建出来 / 回合抛错 —— 这一回合什么都做不了,不能当作「已经交代过了」 */
  readonly failed?: boolean;
}

export interface DrainWorkReport extends DrainTurnReport {
  readonly workId: string;
  readonly title: string;
  readonly status: WorkStatus;
}

export interface DrainDeps {
  readonly db: Database.Database;
  readonly projectId: string;
  readonly now: () => number;
  /** 跑一个非执行类的 agent 回合(宿主负责建会话 / 桥事件 / 落库)。 */
  readonly runAgentTurn: (agentId: string, task: string) => Promise<DrainTurnReport>;
  /** 跑一个工作项(宿主走 `runWorkItem`)。 */
  readonly runWork: (agentId: string, workId: string) => Promise<DrainWorkReport>;
  readonly log: (line: string) => void;
  /** 单次**排空**最多跑几个 agent 回合。默认 8。**必须保守** —— 它是烧 token 的上界。 */
  readonly maxRounds?: number;
  /** 单条待办最多被叫醒几次(目标一动不动时)。默认 3 */
  readonly maxAttemptsPerTodo?: number;
  /** 用户中断:每回合前后各看一次 */
  readonly isCancelled?: () => boolean;
}

export type DrainStopReason = "exhausted" | "max_rounds" | "no_progress" | "cancelled";

export interface DrainVisit {
  readonly agentId: string;
  readonly kind: TodoKind;
  readonly label: string;
}

export interface DrainResult {
  readonly projectId: string;
  readonly rounds: number;
  readonly stopReason: DrainStopReason;
  /** 为什么停的一句话 —— 撞上界 / 预算用尽时宿主据此告诉用户 */
  readonly stopDetail: string;
  readonly visited: readonly DrainVisit[];
  /** 停下时**预算已用尽、不再叫醒**的待办 */
  readonly exhausted: readonly DriverTodo[];
  /**
   * 其中**这一次才刚用尽**的(还没广播过)。
   *
   * 宿主只对它们广播 —— 否则每 10 秒一条 system 消息,那也是一种静默。
   */
  readonly newlyExhausted: readonly DriverTodo[];
  /** 有没有真的叫醒过业务经理去汇报 */
  readonly reportedToClient: boolean;
}

const DEFAULT_MAX_ROUNDS = 8;

/**
 * 把这个项目里此刻所有的待办**排空**,直到没有待办、或撞上界、或用户中断。
 *
 * 它**不建会话、不发 WS 事件、不写会话消息** —— 那三件事由宿主提供的回调负责。
 * 这样这个循环可以在没有任何 provider / 网络的情况下被穷举测试
 * (见 `tests/platform/dispatcher.test.ts`),而「会不会失控」这条最要紧的性质
 * 也因此是**可测的**而不是「看起来应该会停」。
 *
 * ── 三件事保证它一定停 ──────────────────────────────────────────
 *
 *   1. **硬上界** `maxRounds`(默认 8,可配)。到界不静默:宿主据此广播
 *      `cascade_stopped` + 落一条 `system` 消息。
 *   2. **尝试预算** `maxAttemptsPerTodo`(默认 3,库里的账本)。某条待办被叫醒
 *      若干次而目标一动不动 → 不再叫醒它,并广播一次(不静默)。
 *      ⚠️ 这是**唯一**残留的「重复即停」机制,而它已经不是内存状态、也不是
 *      判定依据:它是按 (项目, 待办) 记在 `dispatch_attempts` 里的**预算**。
 *      与批次 20 的 `stallStore` 的本质区别有两条:
 *        - 重启后预算还在(重启不会让预算重新开始)
 *        - 它**不需要状态指纹**,所以不存在「指纹漏了一类状态 → 假的无进展
 *          把整条链掐死」这条失败路径(真机跑出来过:漏了 meetings,项目
 *          经理成功表态却被判无进展,那个项目最后 works=0)。计数的失效方向
 *          永远是「多跑一次」,不会是「误判停住」。
 *   3. **卡住一条不拖停整条**不再需要专门的补丁:预算按待办逐条记账,
 *      这条到界只影响它自己。
 */
export async function drainProject(deps: DrainDeps): Promise<DrainResult> {
  const maxRounds = deps.maxRounds ?? DEFAULT_MAX_ROUNDS;
  const maxAttempts = deps.maxAttemptsPerTodo ?? DEFAULT_MAX_ATTEMPTS;
  const visited: DrainVisit[] = [];
  let rounds = 0;
  let stopReason: DrainStopReason = "exhausted";
  let stopDetail = "没有可执行的待办了";
  let reportedToClient = false;
  let exhausted: readonly DriverTodo[] = [];
  let newlyExhausted: readonly DriverTodo[] = [];

  for (;;) {
    if (deps.isCancelled?.() === true) {
      stopReason = "cancelled";
      stopDetail = "用户中断了这次排空";
      break;
    }
    if (rounds >= maxRounds) {
      stopReason = "max_rounds";
      stopDetail =
        `已达单次排空上限 ${maxRounds} 个 agent 回合,仍有待办没跑完 —— ` +
        `已停下(不是静默停:这条会广播并落库)`;
      break;
    }

    const board = collectTodos({
      db: deps.db, projectId: deps.projectId, now: deps.now(), maxAttemptsPerTodo: maxAttempts,
    });
    // 账本只保留还存在的待办 —— 待办消失即预算作废(将来再次出现就是新预算)
    pruneAttempts(deps.db, deps.projectId, [
      ...board.runnable.map((t) => t.key), ...board.exhausted.map((t) => t.key),
    ]);
    exhausted = board.exhausted;

    if (board.runnable.length === 0) {
      if (board.exhausted.length === 0) {
        stopReason = "exhausted";
        stopDetail = "没有可执行的待办了";
      } else {
        const ledger = listAttempts(deps.db, deps.projectId);
        newlyExhausted = board.exhausted.filter(
          (t) => (ledger.get(t.key)?.notifiedAt ?? null) === null,
        );
        for (const t of newlyExhausted) {
          markAttemptNotified(deps.db, deps.projectId, t.key, deps.now());
        }
        const first = board.exhausted[0]!;
        stopReason = "no_progress";
        stopDetail =
          `${board.exhausted.length} 条待办已经用尽尝试预算(${maxAttempts} 次),` +
          `目标一直没有变化(例如「${first.label}」被叫醒过 ${first.attempts} 次)—— ` +
          `再叫也不会有不同的结果,已停下`;
        // 只在**第一次**用尽时留痕:定时器每 10 秒来一次,每次都打一行会把日志刷满
        if (newlyExhausted.length > 0) {
          deps.log(`dispatcher: 预算用尽,停止 —— ${stopDetail}`);
        }
      }
      break;
    }

    const todo = board.runnable[0]!;
    rounds++;
    visited.push({ agentId: todo.agentId, kind: todo.kind, label: todo.label });
    deps.log(
      `dispatcher: 第 ${rounds}/${maxRounds} 回合 → ${todo.agentId}(${todo.role}) · ${todo.label}`,
    );
    // **先记账再跑**:进程在回合中途被杀死也算用掉一次预算 ——
    // 否则「每跑必崩」的待办会无限重试。
    const attempts = bumpAttempt(deps.db, {
      projectId: deps.projectId, todoKey: todo.key, targetState: todo.targetState, at: deps.now(),
    });
    if (attempts > 1) deps.log(`dispatcher: 这条待办第 ${attempts}/${maxAttempts} 次被叫醒`);

    let aborted = false;
    let failed = false;
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
        failed = r.failed === true;
      } else {
        const r = await deps.runAgentTurn(todo.agentId, renderTask(deps.db, todo));
        aborted = r.aborted;
        failed = r.failed === true;
      }
    } catch (err) {
      // 一次回合抛错**不该**让整个排空炸掉 —— 后面可能还有别的角色能动。
      // 但要留现场:日志里写清是谁、哪个待办、什么错。
      failed = true;
      deps.log(
        `dispatcher: ✖ ${todo.agentId} 的「${todo.label}」抛错 —— ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── 消费:只有回合**成功结束**才算「这件事办过了」 ──
    //
    // 失败/被中断就不消费,下一次排空重来(at-least-once)。宁可多汇报一次,
    // 不能静默漏掉。
    if (!aborted && !failed) {
      if (todo.kind === "review_work") {
        for (const id of todo.refs) markWorkReviewed(deps.db, id, deps.now());
      }
      if (todo.kind === "report_downstream") {
        consumePendingDispatchEvents(deps.db, deps.projectId, todo.agentId, deps.now());
        reportedToClient = true;
      }
    }

    if (aborted) {
      stopReason = "cancelled";
      stopDetail = "用户中断了这次排空";
      break;
    }
  }

  // 「什么都没跑」的安静停不刷日志 —— 定时器每 10 秒来一次,每次都打一行
  // 「排空结束(0 回合)」会把真正有信息量的行淹掉(宿主那边同理)
  if (rounds > 0 || newlyExhausted.length > 0) {
    deps.log(`dispatcher: 排空结束(${rounds} 回合 · ${stopReason})—— ${stopDetail}`);
  }
  return {
    projectId: deps.projectId,
    rounds,
    stopReason,
    stopDetail,
    visited,
    exhausted,
    newlyExhausted,
    reportedToClient,
  };
}

