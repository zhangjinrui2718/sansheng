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
 * `repo/dispatch.ts` 的 `insertDispatchEvent`。
 *
 * ── 判定侧收窄的是**时机**,不是**资格**(合并唤醒 / coalesce)──────────
 *
 * ⚠️ **真机复核:写入侧那一层在扁平结构下是空转的。** 实测用户自己的库:
 * `9 条 work → 9 条 root → 0 条中间`。扁平结构下**每条工作项终态都是「根终态」**,
 * 于是写入侧的「只要根」那条判据全部命中,一条也没被筛掉。
 *
 * ⚠️ **这条归因错过一次(2026-10-04 按设计 1 §9.4 更正,存此以免重犯)**:原文写的是
 * 「`grep -rn parentWorkId harness/` 是空的 —— 没有任何地方告诉项目经理要建树」。
 * **grep 的结果对,推出来的结论错**:作用域只扫了提示词单元目录,而**运行期的任务
 * 提示词**里就写着这句话 —— 本项目 `renderTask` 的 `decompose_project` 正文
 * (见下面「多件产出同属**一个交付物**时,用 `parentWorkId` 把它们挂到一条根工作项
 * 下面」),而它所在的通道(user message)正是这个文件自己认定为最强的那一条。
 * ⇒ 不是「没人告诉」,是「告诉了没做到」;**要修的是合规校验/机制,不是再加提示词**。
 * 归因错了,下一次的修法也会错 —— 教训:「grep 不到」不等于「不存在」,
 * 先问「还有哪条通道我没想到」。
 *
 * 所以「少打扰甲方」还需要第二刀,而这一刀只能落在**判定侧**(写入侧已经判不出
 * 更多东西了):`report_downstream` 不再「有一条事件就生成」,而是**攒够 N 条**
 * (`reportBatchSize`,缺省 3)**或最老的那条等了 T**
 * (`reportMaxDelayMs`,缺省 5 分钟)才生成一次待办。
 *
 * ── ⚠️ 澄清:「判定侧收窄会让 `consumed_at` 撒谎」这条论证的适用边界 ──────
 *
 * Wave 1 的复核提出过一条反方论证:消费是**全量**的
 * (`consumePendingDispatchEvents` 无差别标记该项目全部未消费行),所以判定侧
 * 收窄 = 一次可打扰事件会把一串不可打扰事件**一起**标记成已交代 → `consumed_at`
 * 撒谎。
 *
 * 那条论证**只在「不可打扰的事件仍然进库」时成立**。写入侧收紧之后它们大多
 * 根本不进库,库里剩下的每一行都是「该向甲方交代的事」⇒ 全量消费**不再是缺陷**。
 * 而合并唤醒与那条论证**不是同一件事**:它收窄的是**什么时候叫醒**,不是
 * **哪一行算交代过**。一次合并唤醒之后:
 *
 *   - 被消费的行 = 库里此刻全部未消费行 = `renderDownstream` 在同一回合里
 *     **逐行渲染给业务经理的那一批**(`renderTask` 就在这个回合里查库)。
 *     所以「这一行被交代过」与「业务经理见过这一行」是同一件事。
 *   - 攒着没到阈值的那几行**根本没被消费**(没有待办 → 没有回合 → 不消费),
 *     它们 `consumed_at` 仍是 `NULL`。
 *
 * ⇒ **结论:合并唤醒之后 `consumed_at` 不因「合并」而撒谎。** 唯一残留的谎是
 * 一条**先于本次改动就存在**的竞态:业务经理回合**进行中**新落库的事件会被
 * 同一次全量消费扫进去,而它没进那一回合渲染的名单(窗口 = 一个 agent 回合的
 * 时长,改动前后一样宽)。这不是合并唤醒引入的,也不是它能修的 —— 要修得把
 * 消费从「全量」改成「按 seq 集合」,落在 `repo/dispatch.ts`(见 §12 未决)。
 *
 * ── 立刻叫醒(绕过合并窗口)──────────────────────────────────────
 *
 * 「少打扰」不能拿「该立刻说的也不说」换:`work_failed` 与
 * severity ∈ {high, critical} 的 `blocker_opened` **不等窗口** —— 它们影响
 * 时间表,甲方要能据此重新决策(§2.9 的表)。判据见 `isImmediateEvent`。
 * 其余(根工作项完成 / 里程碑 / 取消 / 受阻)进窗口:它们**值得记录**,
 * 但**不值得为每一条单独叫醒一次**。
 */
import type Database from "better-sqlite3";
import { collectPendingWork, type PendingWork } from "./pendingWork.js";
import { getAgent } from "../storage/repo/agents.js";
import {
  getProjectRow, loadProjectRoster,
} from "../storage/repo/projects.js";
import {
  listWorks, getWork, listWorksPendingReview, markWorkReviewed,
  isTerminalWorkStatus, type WorkRow, type WorkStatus,
} from "../storage/repo/works.js";
import {
  bumpAttempt, consumePendingDispatchEvents, listAttempts,
  listPendingDispatchEvents, markAttemptNotified, pruneAttempts,
  type DispatchEventRow,
} from "../storage/repo/dispatch.js";
import { ROLE_SPECS, isProjectRole, type ProjectRole } from "../identity/role.js";
import type { Capability } from "../harness/capability.js";
import type { ToolCallRecord } from "./turn.js";

// ── 待办的形状 ──────────────────────────────────────────────────

/**
 * 待办的**闭合集**。
 *
 * 写成数组再导出类型,而不是一段裸联合:规则表(下面的 `RULES`)要用它做
 * **闭合性自检** —— 「每个 TodoKind 都恰有一条规则产出它,且没有规则产出集外的东西」
 * 因此是一条断言,而不是一句注释。类型仍然是同一个联合(`TodoKind`),
 * `PRIORITY` 的 `Record<TodoKind, number>` 照样强制穷尽。
 */
export const TODO_KINDS = [
  /** 有人提问,我在等答 —— 有人因此停着,最高优先级 */
  "answer_ask",
  /** 有会议等我表态 */
  "attend_meeting",
  /** 有变更提案等我评审 */
  "review_change",
  /** 有工作项被派给了非 worker(平台不会执行它)—— 派活的人必须改派或关掉 */
  "fix_work_assignment",
  /** 项目里一个工作项都没有 —— 拆解 */
  "decompose_project",
  /** 分派给我、前置已满足的工作项 */
  "execute_work",
  /** 有工作项做完了、还等着审(`works.review_state = 'pending'`) */
  "review_work",
  /** 下游出了结果,该由我向甲方交代(未消费的 outbox 事件) */
  "report_downstream",
] as const;

export type TodoKind = (typeof TODO_KINDS)[number];

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
 * 判据是「这次调用可能改变**流水线**的状态」—— 于是 `work.update` 在里面
 * (做完了要审、要汇报),`project.read` 之类只读的不在。
 *
 * 门铃**不携带任何状态**,只让排空器「现在去查一下」。挂在这里(工具派发的
 * 唯一漏斗)而不是散在十几个工具里:散着写迟早漏一个,而漏掉的表现是
 * 「这件事要等下一次定时器」—— 一个只在延迟上显形、很难归因的 bug。
 *
 * ── `blackboard.write` 为什么从「不在里面」变成「在里面」(B2)──────────
 *
 * 这里原先写着「`blackboard.write`(产出)**不在里面**:写工件**不产生新待办**
 * (**工件不是待办来源**)」—— 那句话今天**只对了一半**,而错的那一半正是本次
 * 要修的东西:
 *
 *   - **对的**:工件确实不是判据。`collectTodos` 一条规则都不读
 *     `artifacts`/`artifact_inserted`(见下面的 `RULES`),判定仍然全部从库里重算。
 *   - **错的**:「不产生新待办」⇒「不必敲门」。而门铃的判据**从来不是**
 *     「有没有新待办」,是「**值不值得重查一次**」。用户的原话是「每个角色的产出
 *     『工件』即可以推动这个流程往下走」—— 而今天**产出工件不会敲门铃**,
 *     于是「工件推动流程」这件事连一个触发点都没有:写完工件只能等 10 秒的
 *     兜底定时器。它**不改变判定**(判定永远重新查库),只把「刚产出了工件」
 *     这件事告诉排空器。
 *
 * ⚠️ **这是「事件只是 nudge,判定永远重新查库」的直接兑现,别把事件变成判据。**
 * 加这一条**不许**顺带在任何规则的 `if` 里开始读 `artifacts` —— 一旦哪条规则去读
 * 工件的存在性/正文,「不需要大模型判断」就退化成规则在做语义猜测(§2.11.3)。
 */
export const NUDGE_CAPABILITIES: readonly Capability[] = [
  "project.open",
  "work.create", "work.update", "work.assign", "work.report",
  "collab.ask", "collab.answer", "collab.escalate",
  "collab.convene", "collab.meeting.respond", "collab.meeting.conclude",
  "change.propose", "change.review",
  "blocker.open", "blocker.update",
  // 产出工件 = 「工件推动流程」的**触发侧**(§2.11.2):门铃响一下,排空器重新查库。
  // 它今天不点亮任何一条规则(`on` 里没有 `artifact_inserted`)—— 这正是纪律本身。
  "blackboard.write",
];

// ── 判定:纯查询 ─────────────────────────────────────────────────

export interface CollectTodosOptions {
  readonly db: Database.Database;
  readonly projectId: string;
  /** 时钟。**只用来算「已超时」之类的时间比较,不参与任何记忆** */
  readonly now: number;
  /** 单条待办的尝试预算。缺省 3 */
  readonly maxAttemptsPerTodo?: number;
  /**
   * **合并唤醒 · 条数**(coalesce)。下游事件攒够这么多条才叫醒业务经理一次。
   * 缺省 {@link DEFAULT_REPORT_BATCH_SIZE}。
   */
  readonly reportBatchSize?: number;
  /**
   * **合并唤醒 · 时限**(ms)。最老的那条未消费事件等了这么久就叫醒一次 ——
   * 它是**合并窗口的上界**,保证「事件永远等不到叫醒」不可能发生。
   * 缺省 {@link DEFAULT_REPORT_MAX_DELAY_MS}。
   */
  readonly reportMaxDelayMs?: number;
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 合并唤醒的**条数**阈值:缺省 3。
 *
 * 依据(都是可算的,不是手感):
 *   - 用户抱怨的是「**一长串**」。真机库是扁平结构(9 work / 9 root / 0 中间),
 *     所以**每条工作项终态都会产生一条事件**。攒 3 条 = 把「3 次唤醒」压成
 *     「1 次」,而这是**用户自己库里反复出现的规模**(9 条工作项 ⇒ 大约 3 次唤醒)。
 *   - 取 2 省得太少(仍有 4~5 次唤醒),取 5 会让只有 2~4 条工作项的小项目
 *     **永远靠 T 兜底** —— 那等于把「攒批」换成「定时」,丢掉了合并的意义。
 *   - 3 与本项目已有的「每待办尝试预算 3 次」同量级,不是新引入的魔法数。
 */
export const DEFAULT_REPORT_BATCH_SIZE = 3;

/**
 * 合并唤醒的**时限**阈值:缺省 5 分钟(300_000ms)。
 *
 * 依据:
 *   - 它是**延迟上界**,不是省 token 的手段:「一条根交付物做完了」最晚 5 分钟
 *     内就会进入业务经理的候选队列。
 *   - **必须显著大于定时器周期**:排空兜底定时器是 10 秒(`--dispatch-interval`),
 *     所以 T 到点之后最多再等 1 个 tick(≈10s)就会被查到 —— 5 分钟 ≈ 30 个 tick,
 *     漏掉一两个 tick 不会改变结果。
 *   - **不能太小**:一次 agent 回合本身是 2–3 分钟(真机观测),T 取到分钟以下
 *     等同于「每条都立刻叫醒」(合并根本不生效)。
 *   - **不能太大**:15 / 30 分钟会让「只有一个交付物的项目」在甲方的观感上
 *     变成「没有反应」—— 而用户要的是少打扰,不是不吭声。
 */
export const DEFAULT_REPORT_MAX_DELAY_MS = 5 * 60_000;

/**
 * **该立刻播、不等合并窗口**的阻塞严重度。
 *
 * ⚠️ 与 `repo/dispatch.ts` 的 `INTERRUPTING_BLOCKER_SEVERITIES`(写入侧那一份)
 * 是**同一个判据的两道独立防线**,刻意不共用常量:写入侧那份是「值不值得记」,
 * 这一份是「值不值得立刻叫醒」。两层各自成立 —— 哪天写入侧放宽(例如为了审计
 * 把 low/medium 也记下来),这里仍然不会因为它们去打断甲方。
 * 两处不一致的表现是「多叫醒一次」(at-least-once 方向),不是静默漏掉。
 */
const IMMEDIATE_BLOCKER_SEVERITIES: ReadonlySet<string> = new Set(["high", "critical"]);

/**
 * 这条未消费事件**绕过合并窗口**吗?
 *
 * 只有两类:
 *   ① `work_failed` —— 与树的位置无关。它影响时间表,甲方要能重新决策。
 *   ② `blocker_opened` 且 severity ∈ {high, critical} —— 同上。
 *
 * **其余一律进窗口**(根工作项完成 / 里程碑 / 取消 / 受阻):它们值得记录,
 * 但不值得为每一条单独烧一次完整回合 + 在会话里留一条回复。
 */
function isImmediateEvent(db: Database.Database, e: DispatchEventRow): boolean {
  if (e.kind === "work_failed") return true;
  if (e.kind !== "blocker_opened") return false;
  const found = db
    .prepare(`SELECT severity FROM blockers WHERE id = ?`)
    .get(e.subjectId) as { severity: string } | undefined;
  // 查不到阻塞行时**立刻叫醒**(宁可多说一次,不能静默漏一条)。
  // 与写入侧 `worthInterrupting` 同一条 at-least-once 取舍:直接往
  // outbox 写一条 subject 不存在的 blocker_opened 是允许的。
  if (found === undefined) return true;
  return IMMEDIATE_BLOCKER_SEVERITIES.has(found.severity);
}

// ── 规则表:8 条分支的形状(设计 1 §2.11.4)───────────────────────
//
// ── 为什么把它做成表,而不是继续写 8 个分支 ──────────────────────
//
// 用户的原话(§2.11 的来源):「项目从立项-拆解-干活-质检-交付……这个过程需要
// **依赖于工程架构来推动,并不是依赖于 agent 来推动**,工程架构推动的基础是在于
// **标准的领域模型**,每个角色的产出「**工件**」即**可以推动这个流程往下走**,
// 这里面**不需要大模型判断**(可能就是一些规则)」。
//
// 「一些规则」要能被逐条读、逐条审、逐条替换 —— 所以判据从 `collectTodos` 的
// 8 个分支搬进这张表,而 `collectTodos` 只剩三件事:**物化现场 → 跑规则 → 记预算**。
// 行为**逐字不变**:`tests/platform/dispatcher.test.ts` 一字不改全绿就是判据。

/**
 * 触发集(**闭合**,设计 1 §2.11.4)。
 *
 * 它描述的是「哪一类**新事实**值得让这条规则重查一遍」,而**不是**输入:
 * `collectTodos` 仍然只收 `(db, projectId, now, 预算)` —— 它**不知道**是哪个触发
 * 把它叫起来的。`on` 今天**没有生产读者**(没有东西按触发筛规则;门铃只是一个
 * 布尔「去查一下」),守它形状的是 `tests/platform/dispatcher-rules.test.ts`。
 *
 * 判据是「这一类新事实**能改变**这条规则的输出」——**建**算,**收口**也算:
 * 一次作答会让「等它的提问」少一条(集合变了 ⇒ 待办的 key 也变了 ⇒ 预算换新的),
 * 所以 `ask_answered` 与 `ask_opened` 一样值得写进 `on`。
 *
 * ⚠️ **它与 `NUDGE_CAPABILITIES` 不是同一张表、也不必一一对应。** 那张表是
 * 「这次调用值不值得敲一下门铃」,这张表是「这条规则的输出会因为什么而变」。
 * 缺口是**已知**的:立项 / 建工作项 / 改派 / 建会 / 登记阻塞都只能敲铃而说不出
 * 触发名(所以它们在 `RULES` 里表现为「只靠 `tick`」)。今天无害 —— 门铃不筛规则;
 * 哪天按触发筛规则,这几条 nudge 会打空,那时得先给闭合集补名(一次显式评审)。
 */
export const TRIGGERS = [
  "artifact_inserted",
  "work_status_changed",
  "ask_opened",
  "ask_answered",
  "meeting_concluded",
  "change_decided",
  /** 兜底:兜底定时器的每一次 tick。**每条规则的 `on` 都必须含它**(见 `RULES`) */
  "tick",
] as const;

export type Trigger = (typeof TRIGGERS)[number];

/**
 * 花名册里的**一个人** + 他此刻的结构化现场。
 *
 * `pending` 是 `collectPendingWork` 的纯查询结果(结构化投影)。规则只许读它的
 * **计数量 / id / 状态 / 时间戳**,不许读正文(`question` / `topic` / `rationale`)——
 * 一旦哪条规则去读正文,「不需要大模型判断」就失效了,而失效的表现是
 * **规则开始做语义猜测**(§2.11.3,本项目最贵的一类 bug)。
 */
export interface RuleMember {
  readonly agentId: string;
  readonly role: ProjectRole;
  readonly pending: PendingWork;
  /** 角色上界含 `change.review` 吗 —— 与 `hasActionableWork` 同源,不另立一份判据 */
  readonly canReviewChange: boolean;
}

/**
 * 规则能读到的**全部**事实。
 *
 * ⚠️ 刻意**不给 `db` 句柄**:规则因此拿不到别的东西,于是「规则的 `if` 只读
 * 结构化的列、不读 `body`」是一处**结构上的**事实,而不是一句靠自觉维持的约定 ——
 * 想绕过它得先改这个接口,而改接口是一次显式评审。库里的读全部在
 * `collectRuleFacts` 里做完。
 */
export interface RuleFacts {
  readonly projectId: string;
  readonly now: number;
  /** 花名册(与 `loadProjectRoster` 同序),只含 `isProjectRole` 的人 */
  readonly members: readonly RuleMember[];
  /** 非终态、且负责人**不存在或不是 worker** 的工作项(与成员无关,按项目算一次) */
  readonly strandedWorks: readonly WorkRow[];
  /** outbox 里未消费的下游事件(`created_at, seq` 升序 —— `[0]` 就是最老的那条) */
  readonly events: readonly DispatchEventRow[];
  /** 上面那批里有没有**绕过合并窗口**的(失败 / 高危阻塞)。预先判好,规则不查库 */
  readonly immediateEvent: boolean;
  /** `works.status='done' AND review_state='pending'` */
  readonly pendingReview: readonly WorkRow[];
  readonly reportBatchSize: number;
  readonly reportMaxDelayMs: number;
}

/** 一条规则产出的待办(还没挂上库里的尝试预算)。 */
export type TodoDraft = Omit<DriverTodo, "attempts" | "projectId">;

/**
 * 规则要叫醒的**角色**。
 *
 * `"roster"` = 「花名册里与那条记录相关的人」—— 具体是谁由库里的行决定,
 * 不是某个固定角色:被提问的那个人(`asks.to_agent_id`)、被邀参会且还没表态的
 * 那个人(`meeting_participants`)、持 `change.review` 的那个人。
 */
export type RuleTargetRole = ProjectRole | "roster";

export interface Rule {
  readonly id: string;
  /** 哪一类新事实值得重查(闭合集)。**每条都必须含 `tick`** —— 见 `RULES` 说明 */
  readonly on: readonly Trigger[];
  /** 条件侧:纯函数,只读 `RuleFacts`。可含状态/集合谓词,**不许读 `body`** */
  readonly if: (q: RuleFacts) => readonly TodoDraft[];
  /** 动作:`TodoKind` + 目标角色 */
  readonly then: { readonly kind: TodoKind; readonly targetRole: RuleTargetRole };
  /** 这条规则补的是**哪一环** / 有事故见证的现场 */
  readonly why: string;
}

/**
 * 8 条规则 —— 原来的 8 个分支,行为逐字不变。
 *
 * ── ⚠️ 每条 `on` 都含 `tick`,这是刻意的、也是必须的 ─────────────
 *
 * 今天 `collectTodos` 是**纯查询**:任何触发(门铃 / 定时器)都会重新跑**全部**规则。
 * 所以:
 *
 *   1. `tick` 是**重启后补跑**那条性质的载体 —— 哪天真的按触发筛规则,漏了 `tick`
 *      的规则会静默停掉,而它的表现正是「重启之后没人补跑」。
 *   2. `tick` 之外的那些取值说的是「这条规则会**因为什么**而变」。
 *      **只**写 `tick` 的规则同样诚实:它的条件在闭合触发集里没有对应的新事实
 *      (建会 / 建工作项 / 改派负责人 / 登记阻塞 / 立项都不在闭合集里,见 §2.11.4
 *      的 `Trigger`)—— 那几件事今天靠 10 秒的兜底定时器接住。
 *
 * 一句话判据:**闭合触发集里没有任何取值能让它变 ⇒ 老实写 `tick`。**
 *
 * ── ⚠️ 与原来那 8 个分支的两处结构差别(都不改变输出)────────────
 *
 *   1. **成员循环里那句 `if (!hasActionableWork(pw) && stranded.length === 0) continue;`
 *      整块删掉了。** 它是**短路优化**,不是判据:它列的条件与下面各条规则的判据
 *      一一对应(asks / meetings / `canReviewChange` 的变更 / worker 的工作项 /
 *      `needsDecomposition`),唯一的例外 `stranded` 由 `fix_stranded_assignment`
 *      自己按角色认领。删掉之后输出逐字相同 —— 试比较:guard 为假时,原来一个
 *      todo 也不会 push。
 *   2. **`stranded` 从「每个 project_manager 算一遍」改成「按项目算一次」**
 *      (`RuleFacts.strandedWorks`)。它是纯读、与成员无关,结果一样;规则的
 *      `m.role === "project_manager"` 才是原判据里那个角色条件。
 *
 * 排序也不受影响:输出仍按 `(PRIORITY[kind], key)` 排,而**同 kind 同 key 的并列**
 * (一场会议里的多个参会方 / 持 `change.review` 的多个角色)在原实现里就是
 * **花名册序**,这里同样是花名册序(规则内层遍历 `q.members`)。
 */
export const RULES: readonly Rule[] = [
  {
    id: "answer_pending_ask",
    // 建(有新问)与收口(作答沿 `parent_ask_id` 链回填父问)都会改变这个集合。
    on: ["ask_opened", "ask_answered", "tick"],
    if: (q) => {
      const out: TodoDraft[] = [];
      for (const m of q.members) {
        const ids = m.pending.asksToAnswer.map((a) => a.id).sort();
        if (ids.length === 0) continue;
        out.push({
          agentId: m.agentId, role: m.role, kind: "answer_ask",
          key: `answer_ask:${ids.join("+")}`, target: null, refs: ids, targetState: null,
          label: `回答 ${ids.length} 条等它的提问`,
        });
      }
      return out;
    },
    then: { kind: "answer_ask", targetRole: "roster" },
    why:
      "7-L 的现场:提问者进 blocked 之后**收到方不会主动知道**有东西在等它,于是整条" +
      "升级链在真机上停摆 —— 而单元测试全绿(测试都显式调 `ask_list`)。这条规则就是" +
      "那个「告诉它」的机械版本;它也是唯一一条「有人因为我停着」的待办,所以排最前(§5.1)。",
  },
  {
    id: "attend_pending_meeting",
    // 「建会」在闭合触发集里没有取值(那是 `collab.convene` 的门铃);只有「收尾」有。
    on: ["meeting_concluded", "tick"],
    if: (q) => {
      const out: TodoDraft[] = [];
      for (const m of q.members) {
        const ids = m.pending.meetingsToRespond.map((x) => x.id).sort();
        if (ids.length === 0) continue;
        out.push({
          agentId: m.agentId, role: m.role, kind: "attend_meeting",
          key: `attend_meeting:${ids.join("+")}`, target: null, refs: ids, targetState: null,
          label: `对 ${ids.length} 场会议表态`,
        });
      }
      return out;
    },
    then: { kind: "attend_meeting", targetRole: "roster" },
    why:
      "会议是异步的:不阻塞、不产出,也没有任何东西会提醒你 —— 漏掉一次表态不会有报错," +
      "只会在纪要里表现为静默(§5.4)。判据是 `meeting_participants.responded_at IS NULL`" +
      "且会议还在 `convened|in_progress`(`pendingMeetingsFor`)。",
  },
  {
    id: "review_pending_change",
    // 变更的每一步迁移(`proposed→under_review→accepted→implemented`)都改这一列 ——
    // 但闭合集里只有「已决」有取值,「提出」没有(`change.propose` 只是门铃)。
    on: ["change_decided", "tick"],
    if: (q) => {
      const out: TodoDraft[] = [];
      for (const m of q.members) {
        // 变更只有持 `change.review` 的角色推得动(业务经理只有 `change.read`)。
        // 这个谓词与 `hasActionableWork` 同源:`RuleMember.canReviewChange`。
        if (!m.canReviewChange) continue;
        const ids = m.pending.pendingChanges.map((c) => c.id).sort();
        if (ids.length === 0) continue;
        out.push({
          agentId: m.agentId, role: m.role, kind: "review_change",
          key: `review_change:${ids.join("+")}`, target: null, refs: ids, targetState: null,
          label: `评审 ${ids.length} 条变更`,
        });
      }
      return out;
    },
    then: { kind: "review_change", targetRole: "roster" },
    why:
      "真机跑出来过:项目经理把变更推到 `under_review` 之后**没有任何人会被叫醒**,那条变更" +
      "永久停在那儿,而日志里一切正常(没有待办了)。判据因此含**非终态的全部状态**" +
      "(`proposed` / `under_review` / `accepted`),不只是 `proposed`。",
  },
  {
    id: "decompose_empty_project",
    // 立项(`project.open`)与第一件工作项(`work.create`)都不在闭合触发集里 ——
    // 而 §9.4 明写「接待会话里那次立项**刻意不 nudge**」,所以这条只可能靠 tick。
    on: ["tick"],
    if: (q) => {
      const out: TodoDraft[] = [];
      for (const m of q.members) {
        if (!m.pending.needsDecomposition) continue;
        out.push({
          agentId: m.agentId, role: m.role, kind: "decompose_project",
          key: `decompose_project:${q.projectId}`, target: null, refs: [], targetState: null,
          label: "把项目拆成工作项",
        });
      }
      return out;
    },
    then: { kind: "decompose_project", targetRole: "project_manager" },
    why:
      "批次 21 之前的真机形态:`projects=1, works=0` —— 立项之后组织停在那儿," +
      "`project_manager` 与 `quality_reviewer` **从来没有被叫醒过**(§9.4)。判据是" +
      "「项目 `active` 且一个工作项都没有」(`needsDecomposition`):「拆完了」与「没拆过」" +
      "必须能区分,所以它看的是**总数**,不是「有没有 open 的」。",
  },
  {
    id: "execute_assigned_work",
    // 前置满足是**别的**工作项的状态迁移(所以这条真的会被 `work_status_changed` 点亮);
    // 「建工作项 / 改派」在闭合集里没有取值。
    on: ["work_status_changed", "tick"],
    if: (q) => {
      const out: TodoDraft[] = [];
      for (const m of q.members) {
        // 执行只有 worker 能做 —— `runWorkItem.checkRunnable` 会在角色不对时拒绝,
        // 与其浪费一次唤醒,不如在这里就只认 worker。
        if (m.role !== "worker") continue;
        for (const w of m.pending.myOpenWorks) {
          out.push({
            agentId: m.agentId, role: m.role, kind: "execute_work",
            key: `execute_work:${w.id}`, target: w.id, refs: [w.id], targetState: w.updatedAt,
            label: `执行工作项 ${w.id}「${w.title}」`,
          });
        }
      }
      return out;
    },
    then: { kind: "execute_work", targetRole: "worker" },
    why:
      "`myOpenWorks` 曾经**不存在**:注入面的字段里没有「派给我的活」,于是 worker 的待办" +
      "在系统里根本不存在,它只能靠主动 `work_list` 才看得到自己有活 —— 「测试通过但系统" +
      "不动」的典型形态(`pendingWork.ts` 的字段注释)。判据含 `in_progress`(重跑一条" +
      "已经在跑的工作项是合法的),不只是 `open`。",
  },
  {
    id: "fix_stranded_assignment",
    on: ["work_status_changed", "tick"],
    if: (q) => {
      const ids = q.strandedWorks.map((w) => w.id).sort();
      if (ids.length === 0) return [];
      const out: TodoDraft[] = [];
      for (const m of q.members) {
        if (m.role !== "project_manager") continue;
        out.push({
          agentId: m.agentId, role: m.role, kind: "fix_work_assignment",
          key: `fix_work_assignment:${ids.join("+")}`, target: null, refs: ids, targetState: null,
          label: `处置 ${ids.length} 条没人能执行的工作项`,
        });
      }
      return out;
    },
    then: { kind: "fix_work_assignment", targetRole: "project_manager" },
    why:
      "真机现场:项目经理把「与甲方对齐业务场景」派给了**业务经理**,那条工作项至今 `open`" +
      " —— 平台不执行非 worker 的负责人,`needsDecomposition` 也不为真(项目里确实有工作项)," +
      "于是它谁也不叫醒。这条规则是**存量数据**的自愈路径(新数据由 `work_create` / " +
      "`work_assign` 的调用期门直接拒收)。",
  },
  {
    id: "review_done_works",
    // `review_state` 的唯一写口就是 `works.status` 的唯一写口(`updateWorkStatus`),
    // 所以「刚做完」在这里表现为一次工作项状态迁移。
    on: ["work_status_changed", "tick"],
    if: (q) => {
      const qa = q.members.find((m) => m.role === "quality_reviewer");
      if (qa === undefined || q.pendingReview.length === 0) return [];
      const ids = q.pendingReview.map((w) => w.id).sort();
      return [{
        agentId: qa.agentId, role: "quality_reviewer", kind: "review_work",
        key: `review_work:${ids.join("+")}`, target: null, refs: ids, targetState: null,
        label: `审查 ${ids.length} 个已完成的工作项`,
      }];
    },
    then: { kind: "review_work", targetRole: "quality_reviewer" },
    why:
      "批次 20 的判据是**级联观察到的内存事件**(「工作项刚变成 done」)—— 不持久、" +
      "**重启后不补跑**(本文件头注释 ① 的第 2 个洞)。migration 013 把 `review_state`" +
      "落成库里的真状态之后,它退化成**一条查询**:`works.status='done' AND " +
      "review_state='pending'`。",
  },
  {
    id: "report_downstream_events",
    // 事件由 `updateWorkStatus`(done/failed/blocked/cancelled)与 `insertBlocker` 写;
    // 后者的 `blocker.open` 在闭合触发集里没有取值。
    on: ["work_status_changed", "tick"],
    if: (q) => {
      const bm = q.members.find((m) => m.role === "business_manager");
      if (bm === undefined || q.events.length === 0) return [];
      // ── 合并唤醒:攒够 N 条、或最老的那条等到 T,才叫醒一次 ──────────
      //
      // 加这两个条件的**唯一**理由是用户的原话:「业务经理干的事情太多了……
      // 聊天记录里面的一长串,真真甲方不关心这些」。真机库是扁平结构,写入侧的
      // 「只留根」那条判据**全部命中**(每条工作项都是根),所以「每条终态都叫醒
      // 一次」这件事只能在这里收窄。见本文件头注释。
      //
      // ⚠️ `events` 是**升序**(`created_at, seq`),所以 `events[0]` 就是最老的那条
      // —— 「最老的等了多久」不需要另查一次,它就在这一次查询里。
      const oldest = q.events[0]!.createdAt;
      const waitedMs = q.now - oldest;
      const enough = q.events.length >= q.reportBatchSize;
      const waited = waitedMs >= q.reportMaxDelayMs;
      if (!q.immediateEvent && !enough && !waited) return [];
      // 叫醒的理由要能被看见 —— 否则「为什么这次只叫了一次」在事后无从回答
      const reason = q.immediateEvent
        ? "其中有该立刻说的(失败 / 高危阻塞)"
        : enough
          ? `已攒够 ${q.events.length} 条(阈值 ${q.reportBatchSize})`
          : `最老的一条等了 ${Math.round(waitedMs / 1000)}s(上界 ${Math.round(q.reportMaxDelayMs / 1000)}s)`;
      const version = Math.max(...q.events.map((e) => e.seq));
      return [{
        agentId: bm.agentId, role: "business_manager", kind: "report_downstream",
        key: `report_downstream:${version}`, target: null, refs: [], targetState: version,
        label: `向甲方交代下游的 ${q.events.length} 条结果(${reason})`,
      }];
    },
    then: { kind: "report_downstream", targetRole: "business_manager" },
    why:
      "批次 20 真机跑出来过「工作项做完了而**没有人向甲方汇报**」—— 撞上 `maxRounds` 时" +
      "那一路攒的结果随调用消失(本文件头注释 ① 的第 1 个洞)。下游结果现在落在 outbox" +
      "(`dispatch_events`)里,所以这条规则重启之后照样查得出来;它**收窄的是时机,不是资格**" +
      "(没到阈值的行根本没被消费,`consumed_at` 不因合并而撒谎,§9.4)。",
  },
];

/**
 * 把规则要读的结构化事实**一次性**从库里查出来(纯查询,查完规则就没有别的读法)。
 *
 * 为什么先物化:①规则因此拿不到 `db`(见 `RuleFacts`);②每个成员只算一次
 * `collectPendingWork`(8 条规则各查一遍会把它变成 8 倍)—— 而这是**同一次调用内的
 * 缓存**,不是跨调用状态:它随 `collectTodos` 的返回一起消失,下一次 tick 重新查库。
 */
function collectRuleFacts(
  db: Database.Database,
  projectId: string,
  now: number,
  opts: CollectTodosOptions,
): RuleFacts {
  const members: RuleMember[] = [];
  for (const m of loadProjectRoster(db, projectId)) {
    if (!isProjectRole(m.role)) continue;
    const role = m.role;
    members.push({
      agentId: m.id,
      role,
      pending: collectPendingWork(db, m.id, projectId, now),
      canReviewChange: ROLE_SPECS[role].ceiling.includes("change.review"),
    });
  }

  /**
   * 派给非 worker(或负责人已不存在)的**非终态**工作项 —— `fix_stranded_assignment`
   * 的判据。它与成员无关,所以按项目算一次;角色条件留在规则里。
   */
  const strandedWorks = listWorks(db, projectId).filter((w) => {
    if (isTerminalWorkStatus(w.status)) return false;
    const a = getAgent(db, w.assigneeAgentId);
    return a === null || a.role !== "worker";
  });

  const events = listPendingDispatchEvents(db, projectId);
  return {
    projectId,
    now,
    members,
    strandedWorks,
    events,
    // 查库的活在这里做完 —— `isImmediateEvent` 要看 `blockers.severity`,规则拿不到 db
    immediateEvent: events.some((e) => isImmediateEvent(db, e)),
    pendingReview: listWorksPendingReview(db, projectId),
    reportBatchSize: opts.reportBatchSize ?? DEFAULT_REPORT_BATCH_SIZE,
    reportMaxDelayMs: opts.reportMaxDelayMs ?? DEFAULT_REPORT_MAX_DELAY_MS,
  };
}

/**
 * 扫一遍这个项目,列出**此刻真的有人能动手**的待办。
 *
 * ⚠️ 这是全系统**唯一**一处「下一步该谁跑」的判定,所以它的纯度是这套设计的
 * 地基:入参只有 `(db, projectId, now, 预算上限)`,不读任何进程内状态、
 * 不接收「上次发生了什么」。每个 tick、每次门铃都从库重新算 —— 它**不知道**
 * 是哪个触发把它叫起来的。
 *
 * 三件事,没有第四件:
 *   ① 物化现场 `collectRuleFacts`(纯查询)
 *   ② 跑规则表 `RULES`(纯函数,只读 ① 的结果)。**判定只有一处** —— 逻辑散在
 *      `collectTodos` 里就又会变回「8 个分支」,规则表也不该有第二个真相源
 *   ③ 挂上库里的尝试预算,按优先级排好
 */
export function collectTodos(opts: CollectTodosOptions): TodoBoard {
  const { db, projectId, now } = opts;
  const maxAttempts = opts.maxAttemptsPerTodo ?? DEFAULT_MAX_ATTEMPTS;
  const project = getProjectRow(db, projectId);
  if (project === null) return { projectId, runnable: [], exhausted: [] };

  const facts = collectRuleFacts(db, projectId, now, opts);
  const todos: TodoDraft[] = [];
  for (const rule of RULES) todos.push(...rule.if(facts));

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
        // ⚠️ **刻意不下命令、不复述判据。**
        //
        // 这里原先是「# 现在轮到你了:**主动**向甲方交代进展 … 而这正是你该主动做的事
        // (不要等他来问)… 值得让他知道的,用 tell_client 播报;**不值得打扰他的,
        // 就不要播**(他的注意力是稀缺资源)」。
        //
        // 问题有两层:① 它在 **user message** 里(recency 比 system prompt 强),
        // 而且**标题本身就是在下命令** —— 提示词里那条克制要去跟一句命令对撞;
        // ② 那句「不值得打扰的不要播」是**判据的第二次陈述**,而判据的真相源在
        // `business_manager.core`(「播不播:三个问题」)—— **两份定义迟早漂**,
        // 而这个项目为「两份定义会漂」已经付过好几次代价。
        //
        // 所以平台只做两件事:**把事实摆出来**、**说「你来判断」**。
        // 判据只**引用**位置,不复述内容。(批次 22,由提示词那一批 subagent 发现:
        // 它在提示词侧只能「去预设」这句平台措辞,消除不了它。)
        "# 下游出了结果 —— 播不播由你决定\n\n" +
        "**没有人向你提问。** 你是被下游的结果唤醒的 —— 甲方不知道刚才发生了什么。\n\n" +
        renderDownstream(db, todo) +
        "\n\n播不播**由你判断**,判据是 `business_manager.core` 的「播不播:三个问题」那一节 ——\n" +
        "**这里刻意不复述它**。有分量的结论仍然要 `board_write` —— 播报不替代落库。\n\n" +
        "下面这些事件**已经过写入侧的筛子**(只留根工作项 / 里程碑 / 失败 / " +
        "高severity 阻塞),而且**已经过合并窗口** —— 平台攒够一批或等到时限才 " +
        "叫醒你这一次,所以这里**一次列出的是一批**,不是一件。" +
        "「库里记了一笔」不等于「值得播报」:整批可以合成**一句**,也可以不播。"
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
  /**
   * 合并唤醒:下游事件攒够这么多条才叫醒业务经理一次。
   * 默认 {@link DEFAULT_REPORT_BATCH_SIZE}(见 `collectTodos`)。
   */
  readonly reportBatchSize?: number;
  /**
   * 合并唤醒:最老的那条未消费事件等了这么久(ms)就叫醒一次。
   * 默认 {@link DEFAULT_REPORT_MAX_DELAY_MS}。
   */
  readonly reportMaxDelayMs?: number;
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
      ...(deps.reportBatchSize !== undefined ? { reportBatchSize: deps.reportBatchSize } : {}),
      ...(deps.reportMaxDelayMs !== undefined ? { reportMaxDelayMs: deps.reportMaxDelayMs } : {}),
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

