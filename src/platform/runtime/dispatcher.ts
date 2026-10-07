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
 * ⚠️ **2026-10-05 复核(形状变了,结论不变)**:当前 `~/.sansheng/sansheng.db` 是
 * **1 根 + 4 子项**(树),`dispatch_attempts` 是空的 —— 那份 `9/9/0` 的实测属于
 * **更早的一份库**。结论不变(扁平形状下这一刀确实空转),但**不要把「真机库是扁平的」
 * 当成当下的库形状**;而「判据不能写成『是根』」这条纪律在**两种形状下都成立**
 * (见 `repo/works.ts` 的 `workIdsWithChildren`)。
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
  listWorks, getWork, listWorksPendingReview, markWorkReviewed, updateWorkStatus,
  isTerminalWorkStatus, type WorkRow, type WorkStatus,
} from "../storage/repo/works.js";
import { blockersForWork, listBlockers } from "../storage/repo/blockers.js";
import { latestReviewVerdict, latestVerdictsByWork } from "../storage/repo/reviewVerdicts.js";
import {
  collectReworkPending, pendingReworkOfProject, reworkOwner,
  renderReworkPacket, REWORK_ESCALATE_ROUND, type ReworkPending,
} from "./rework.js";
import {
  listArtifacts, getArtifact, type ArtifactRow,
} from "../storage/repo/artifacts.js";
import {
  bumpAttempt, consumePendingDispatchEvents, listAttempts,
  listPendingDispatchEvents, markAttemptNotified, pruneAttempts,
  type DispatchEventRow,
} from "../storage/repo/dispatch.js";
import {
  consumeClientAnswers, getClientQuestions, listUnconsumedClientAnswers, type ClientQuestionRow,
} from "../storage/repo/clientQuestions.js";
import { ROLE_SPECS, isProjectRole, isExecutorRole, EXECUTOR_ROLES, type ProjectRole } from "../identity/role.js";
import { openDeliverableSession } from "../storage/repo/sessions.js";
import type { Capability } from "../harness/capability.js";
import type { ProjectStatus } from "../harness/authorize.js";
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
  /** 有工作项被派给了非执行角色(平台不会执行它)—— 派活的人必须改派或关掉 */
  "fix_work_assignment",
  /**
   * 有工作项**停在 `blocked`** 而没有任何人在推它 —— 项目经理必须处置。
   *
   * ⚠️ 这一条的存在理由是一条**真机实测的缺陷**:`blocked` 的工作项**不在任何
   * 待办里**(`pendingWork.ts` 的 `myOpenWorks` 只要 `open|in_progress`),而
   * **没有任何规则读 `works.status='blocked'`**。后果不是「少叫醒一次」,是
   * **整个项目零待办**:一条 `blocked` 的子项把依赖它的下游全卡在
   * `myWaitingWorks`(`depsSatisfied=false`),于是排空器每 10 秒空转,
   * 而「零待办」与「组织已经把活干完了」在日志里长得**一模一样**。
   *
   * 真机现场(`collectTodos` 直接跑在真机库的 `VACUUM INTO` 副本上):
   * `1 根 blocked + 子项 done/done/blocked/open/open` ⇒ 待办**空** ——
   * 没有任何人会被叫醒。判据见 `RULES` 里 `resolve_blocked_work` 的 `why`。
   */
  "resolve_blocked_work",
  /**
   * 有工作项**停在 `failed`** 而没有任何人在处置它 —— 项目经理必须重新划范围。
   *
   * ⚠️ 这一条是 `resolve_blocked_work` 的**同构**兄弟,而它当时**没人写**。
   * 同一个形态、同一个后果:那条待办不存在 ⇒ 整项目零待办 ⇒ 排空器每 10 秒空转,
   * 而「零待办」与「组织已经把活干完了」在日志里长得**一模一样**。
   *
   * 差别只在**谁来处置**:被阻塞的活 PM 改派/登记阻塞就能继续,而
   * **`failed` 的活 PM 重跑一次就会同样失败**(见 `RULES` 里的 `why`)。
   */
  "recover_failed_work",
  /** 项目里一个工作项都没有 —— 拆解 */
  "decompose_project",
  /** 分派给我、前置已满足的工作项 */
  "execute_work",
  /**
   * **质检判了「不通过」,这条产出要有人返工**(2026-10-07 真机事故补)。
   *
   * 它补的是一整条断掉的回路。真机现场:根工作项被质检**连续三轮 fail**,
   * 三份意见写得清清楚楚,而**三次审查之间一个执行回合都没有** ——
   * 因为 fail 走的是「退回给工作项负责人」,而那条工作项是**容器**:
   *
   *   - 容器被 `pendingWork.ts` 的 `myOpenWorks` 排除(它不由执行者跑)⇒ 没人接手;
   *   - 排空器每轮开头的 `closeIntegratedContainers` 见它「子项全终态 + 已审」⇒
   *     8 秒内又把它收口成 `done` ⇒ 质检再审**同一份没变的东西**。
   *
   * ⚠️ **它不是「退回」这个动作的别名,而是「工件流转」的机械形态**:
   * 质检结论是一条工件(`review_finding`)+ 一行结构化结论(`review_verdict`),
   * 这条待办就是从那一行**推出来的下一步** —— 与另外 14 条规则同形:纯查询、判据在库里、
   * 重启后照样算得出来。目的地由**产出的作者**决定,没有作者才兜底给项目经理
   * (见 `runtime/rework.ts`,那里写着用户对这件事的裁决)。
   *
   * ⚠️ **终止判据是「这条工作项上出现了比质检结论更新的产出」** ——
   * 没有它,`if` 每个 tick 都成立,规则会一直叫到尝试预算用尽(而预算按 AGENTS.md
   * 的定性是**限流不是判据**)。真机上「三轮之间工件组成完全无变化」正是这条判据
   * 说出来的事实。
   */
  "rework",
  /** 有工作项做完了、还等着审(`works.review_state = 'pending'`) */
  "review_work",
  /**
   * 根工作项的整棵子树都收口了(终态 + 审过),而**这条根上还没有 `deliverable` 工件**
   * —— 质检之后缺的那一环(C3,设计 1 §2.11.4)。
   *
   * 「整合完了」这个事实**没有**落在 `works` 上,而是落在**工件**上:根工作项上存在
   * 一条 `kind='deliverable'` 的工件。这正是用户要的「工件即推动流程」—— 也是这条
   * 规则唯一的终止判据(缺了它,`if` 每次都成立,会一直叫到尝试预算用尽,而预算
   * 是**限流不是判据**)。
   */
  "integrate",
  /**
   * 存在**已验收**的 `deliverable` 工件,而它还没有交付会话 —— 该业务经理出面了(C3)。
   *
   * ⚠️ 建会话是 **C4** 的活(migration 017 给 `project_sessions` 加
   * `deliverable_artifact_id` + `channel`)。C3 只把这条待办**产出来**;
   * 终止判据读的正是那一列(见 `collectRuleFacts` 的 `deliveredArtifactIds`)。
   */
  "handover",
  /** 下游出了结果,该由我向甲方交代(未消费的 outbox 事件) */
  "report_downstream",
  /**
   * **我提的问题被甲方答复了,而我还没处置**(020 的 `client_questions`:
   * `answered_at IS NOT NULL AND consumed_at IS NULL`)。
   *
   * ⚠️ 这一条的存在理由是一次**真机事故**(2026-10-06 09:09,项目「美股自动化
   * 交易平台方案设计」):甲方在待答面板点了答复,后端写了 decision 工件、
   * 建了 `answers` 审计边、提问转 `accepted` —— 而**没有任何一行记下「答复到了、
   * 业务经理还没看」**。排空器每 10 秒查一次库,查到的是「四个角色零待办」。
   * 之后系统再没有产生过一条消息,而业务经理在 08:59 亲口宣布过的那条队列
   * (「等您回完 W1,我会按 W2→…→W7 逐项问」)永远不会自动开始。
   *
   * 它是 7-L 那条修复的**漏网之鱼**:「提问者进 blocked、但对方不会主动知道」
   * 当时只治了 agent↔agent 的 `asks` 表(`answer_pending_ask`),而
   * `client_question` 是**另一条通道** —— 同一个病,两条通道只治了一条。
   */
  "resume_client",
  /**
   * **这个项目没有一件没做完的事了,该业务经理判断要不要收口**(规则
   * `close_finished_project`)。
   *
   * ⚠️ 它补的是「组织停在一个永远不会自己收尾的状态」这个洞。2026-10-06 的真机
   * 终局:11 条工作全部 `done` + `review_state='done'`、6 条 `review_verdict` 全
   * `pass`、outbox 空、`openWorks=0`、`pendingQuestions=0`、`runningTurns=0` ——
   * 而 `projects.status` 仍是 `active`。用户看到的字面就是「项目还在进行中,
   * 但没有任何人在干活」。
   *
   * `project_close` 工具一直有生产调用方(`tools/project.ts`),**零自动触发**:
   * 11 条规则里没有一条提到项目收口,`NUDGE_CAPABILITIES` 里也没有
   * `project.close`。**代码里写了逻辑 ≠ 它有读者**(7-E 的复发)。
   *
   * ⚠️ **判据成立时不自动关闭,而是叫醒业务经理去判断** —— 收不收口是业务判断,
   * 不是平台能从库里推出来的结论(§2.11.3:规则不做语义猜测)。
   */
  "close_project",
] as const;

export type TodoKind = (typeof TODO_KINDS)[number];

/**
 * 优先级。**数字小的先跑。**
 *
 * 次序的理由:
 *   - `answer_ask` 最前 —— 有人处于 blocked,不答它整条链停摆(设计 §5.1)
 *   - `resume_client` 紧随 —— **有人刚对你说话**(甲方答了你的问题)。与上一条
 *     同族,只是对面不是 agent 而是用户:他刚在界面上点了一下,却在屏上什么
 *     都看不到。让它排第二是为了「答复与回应之间不隔一整轮」—— 排在最后
 *     的话,一次汇报待办会把它的回应推到下一轮,而那正是这次事故的形态。
 *   - 其余按流程顺序:对齐(会议/变更)→ 修派活 → 拆解 → 执行 → 审查 → 整合 → 交付 → 汇报
 *   - `report_downstream` 最后 —— 它汇报的正是前面那些动作的结果
 *
 * ⚠️ 批次 20 在这里额外有一条「**最后一格预算留给汇报**」的特例(否则甲方
 * 在整个批次跑完前什么都听不到)。它现在**整块删掉了**:汇报这件事不再会丢
 * (outbox 在库里,下一次排空、乃至重启之后照样查得出来),所以次序可以是一条
 * 纯粹的优先级规则 —— 没有特例,也就没有特例与优先级不一致的那一类 bug。
 */
const PRIORITY: Readonly<Record<TodoKind, number>> = {
  answer_ask: 0,
  resume_client: 1,
  attend_meeting: 2,
  review_change: 3,
  // 两条「修」的待办挨着:派活错了与活被卡住都是**项目经理的存量修复**,
  // 而它们都挡着下面的执行 / 审查 / 整合。
  fix_work_assignment: 4,
  resolve_blocked_work: 5,
  // 与 `resolve_blocked_work` 同构,但**更挡路**:`blocked` 改派一下就能继续,
  // 而 `failed` 没人重新划范围就一直卡着下游(见 RULES 里的 `why`)。
  recover_failed_work: 5,
  decompose_project: 6,
  execute_work: 7,
  // 返工排在**审查之前**:它要重做的是审查已经否掉的那份产出,所以它必须先跑完,
  // 才有新的东西可审(`review_work` 的判据也把「等返工」的那些排除掉了 —— 见那条规则)。
  rework: 8,
  review_work: 9,
  // 整合与交付接在**审查之后**(C3,§2.11.4):子树收口 → 整合 → 交付。
  // `integrate` 排在 `review_work` 之后是刻意的:容器自己也可能 `done` 而没审,
  // 那种情况下先让质检把 `review_work` 跑掉,再叫项目经理整合(否则会在
  // 「还有一条 done 没审」时提前整合 —— 而 ② 那一条判据正是禁止这个的)。
  integrate: 10,
  handover: 11,
  report_downstream: 12,
  // 收口排**最后**:它成立的前提是「上面每一条都不成立」,所以它排在最后不是
  // 优先级偏好,是**顺序依赖** —— 有任何一件没做完的事,这条就压根不成立。
  close_project: 13,
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
  // ⚠️ B2 落地时它**一条规则也点不亮**(8 条规则的 `on` 里没有 `artifact_inserted`);
  // C3 之后它有读者了 —— `integrate_reviewed_subtree` 与 `handover_deliverable`
  // 的 `on` 里都有它(这一批里第一次真的有人用这个触发名)。纪律没变:门铃只是
  // 「去查一下」,判定仍然全部重新查库(它们读的是工件的 kind / work_id 这两列)。
  "blackboard.write",
  /**
   * 写下审查结论 → 叫醒一次「这条产出该返工了没有」的重新评估。
   *
   * ⚠️ **它此前不在里面**,而缺的正是「判 fail 之后那一步」:`review_verdict` 判
   * `fail` 时**会**走 `updateWorkStatus` 把工作项退回,但那是**仓储调用**、不持能力,
   * 所以门铃不会响(与 `resolveClientQuestion` 那条「纯仓储写 ⇒ 静默」同源)。
   * 结果:`rework` 那条待办只能等 10 秒的兜底 tick —— 不改变判定(判定永远重新查库),
   * 但把「刚被判不通过」这件事的响应推迟了一格。加它不改变任何判据。
   */
  "work.review_verdict",
  /**
   * 项目收口 → 叫醒一次「这个项目做完了没有」的重新评估。
   *
   * ⚠️ 加它是因为 `project_close` 那个工具**一直有生产调用方却零自动触发** ——
   * 「代码里写了逻辑」不等于「它有读者」(7-E)。真机终局:所有工作项 done、所有审查
   * pass、outbox 空,而 `projects.status` 永远是 `active`。
   */
  "project.close",
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

/**
 * 单条待办的尝试预算上限:缺省 **3**。
 *
 * 导出是给**读面**用的(`transport/views.ts` 的 `toProjectLiveView` 要显示
 * 「已叫醒 2/3 次」)。把一个 `3` 抄到读面那一侧,等于把「预算到底几次」变成
 * 两份定义 —— 而这个项目的裁判口径只有一处(`collectTodos`)。
 */
export const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * 合并唤醒的**条数**阈值:缺省 3。
 *
 * 依据(都是可算的,不是手感):
 *   - 用户抱怨的是「**一长串**」。那次实测的真机库是扁平结构
 *     (9 work / 9 root / 0 中间;⚠️ 2026-10-05 复核当前库是 1 根 + 4 子项),
 *     所以那一次**每条工作项终态都会产生一条事件**。攒 3 条 = 把「3 次唤醒」压成
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
  /** 非终态、且负责人**不存在或不是执行角色**的工作项(与成员无关,按项目算一次) */
  readonly strandedWorks: readonly WorkRow[];
  /** outbox 里未消费的下游事件(`created_at, seq` 升序 —— `[0]` 就是最老的那条) */
  readonly events: readonly DispatchEventRow[];
  /** 上面那批里有没有**绕过合并窗口**的(失败 / 高危阻塞)。预先判好,规则不查库 */
  readonly immediateEvent: boolean;
  /** `works.status='done' AND review_state='pending'` */
  readonly pendingReview: readonly WorkRow[];
  // ── C3 的两条新规则要读的结构化事实(§2.11.4 的下两行)────────────
  /**
   * 项目里**全部**工作项(树形关系就在 `parentWorkId` 上)。
   *
   * `integrate` 要沿它算「根 R 的整棵子树」,而那**必须**是一条集合谓词:
   * 「3 个子项都跑完了」不是任何一条工件的属性(§2.11.2 的两条反例)。
   * 与 `strandedWorks` 共用这一次查询,不另查一遍。
   */
  readonly works: readonly WorkRow[];
  /**
   * **已经有 `deliverable` 工件挂着的**工作项。
   *
   * 这就是 `integrate` 的终止判据 ③(§2.11.4):「这条交付已经整合完了」这个
   * 结构化事实落在**工件**上,不在 `works` 的某一列上 —— 用户要的正是
   * 「工件即推动流程」。缺了它,`if` 每次都成立,规则会一直叫到尝试预算用尽
   * (而预算是**限流,不是判据**)。
   */
  readonly deliverableWorkIds: ReadonlySet<string>;
  // ── `resolve_blocked_work` 要读的两条结构化事实(见下面那条规则)──────
  /**
   * **有人正在等甲方回话** —— 库里唯一一条真正表示「球在甲方那边」的结构化事实。
   *
   * `ask_client`(只有业务经理持 `client.ask`)落一条 `client_question`
   * (`status='open'`),甲方答复时转 `accepted`(`tools/client.ts` 的
   * `resolveClientQuestion`)。所以「项目里有未答复的 client_question」
   * = 此刻存在一个**只有外部输入能解**的等待。
   *
   * ⚠️ 它是**项目级**的,不是工作项级的:`ask_client` 的参数表里**没有 `workId`**,
   * 于是 `client_question` 的产出边(`artifacts.work_id`)恒为 `NULL` ——
   * 库里没有「这条提问对应哪条工作项」这条边(真机库实测:两条 `q_*` 的
   * `work_id` 都是 `NULL`)。所以这条判据只能粗到项目粒度,见
   * `resolve_blocked_work` 的 `why`(那里如实写了它的失效方向)。
   */
  readonly awaitingClient: boolean;
  /**
   * **我提的问题被甲方答复了、而我还没处置**的那些提问
   * (020:`answered_at IS NOT NULL AND consumed_at IS NULL`)。
   *
   * ⚠️ 它与上面那个 `awaitingClient` 是**同一件事的两端**,但方向相反:
   * `awaitingClient` = 「球在甲方那边」(还没答),本字段 = 「球回到我这边了」
   * (答了、我没看)。`awaitingClient` 今天**只被当抑制条件用**
   * (`resolve_blocked_work`:别叫 PM,它等的是外部输入)——
   * **它从来没有被当成触发条件**,于是真机上出现了「答复落库 → 零待办 →
   * 永远不动」(2026-10-06 09:09,见 `resume_client` 的 `why`)。
   *
   * 只读 id 与时间戳,**不读问题正文**(§2.11.3:规则的 `if` 不读正文 ——
   * 规则一旦开始做语义猜测,「不需要大模型判断」就失效了)。
   */
  readonly unconsumedClientAnswers: readonly ClientQuestionRow[];
  /**
   * **挂着至少一个未解决阻塞**(`status ∈ {open, acknowledged}`)的工作项 id。
   *
   * 这是「这条工作项为什么被卡住」在库里的**唯一结构化答案**:`blockers` 表本身
   * **没有** `work_id` 列,关联落在 `blocker_blocks`(migration 008),
   * 而读它的生产入口是 `repo/blockers.ts` 的 `blockersForWork`(逐条查)。
   * 规则要的是**整个项目的集合**,所以这里按项目查一次。
   *
   * 只读 `status` 这一列 —— 连 `severity` 都没读(更不读 `title` / `detail`):
   * §2.11.3 那条纪律(规则的 `if` 不读正文)**从这里就开始成立**。
   */
  readonly blockedByBlockerWorks: ReadonlySet<string>;
  /**
   * `kind='deliverable' AND status='accepted'` 的工件 —— `handover` 的**资格**判据。
   *
   * 只有**已验收**的交付物才该交付:整合刚写完(`open`)时还不该惊动甲方。
   */
  readonly acceptedDeliverables: readonly ArtifactRow[];
  /**
   * **已经有交付会话挂着的**交付物 id —— `handover` 的**终止**判据。
   *
   * 读的是 `project_sessions.deliverable_artifact_id`,而**那一列今天还不存在**:
   * 它是 C4 的 migration 017(§2.11.6)。所以这里**先问 schema**,列不在时如实
   * 返回空集(= 还没有任何交付会话),并**不假装**判据已成立或已失效 ——
   * 见 `deliveredArtifactIds` 的说明。
   */
  readonly deliveredArtifactIds: ReadonlySet<string>;
  readonly reportBatchSize: number;
  readonly reportMaxDelayMs: number;
  // ── 2026-10-06 真机终局补的三条事实(`close_finished_project` + goal 对齐)──
  /**
   * `projects.status` —— 「这个项目结束了没有」在库里的**唯一答案**。
   *
   * 它是 `close_finished_project` 的**终止判据**:项目一进终态,规则立刻不成立。
   * 落在一列上而不是宿主内存里,所以**重启后自动补跑**、不需要任何额外状态
   * (批次 21 把「刚才发生了什么」从内存里赶出去之后,这是判据的默认形态)。
   */
  readonly projectStatus: ProjectStatus;
  /**
   * **非终态**工作项的条数(`status ∉ {done, failed, cancelled}`)。
   *
   * 规则算 `works.filter(w => !isTerminalWorkStatus(w.status)).length` 也行,
   * 但那样同一条「什么算终态」的知识就散在规则里 —— 而 `isTerminalWorkStatus`
   * 是 `works` 表的**唯一真相**。这里只搬数字,判据仍在同一处。
   */
  readonly nonTerminalWorkCount: number;
  /**
   * **项目级**未解决阻塞数(`status ∈ {open, acknowledged}`)。
   *
   * ⚠️ 它**不能**用 `blockedByBlockerWorks.size` 代替:那条边落在 `blocker_blocks`
   * 上,而**阻塞可以先登记、后挂工作项**(真机里 `blockers` 表没有 `work_id` 列)。
   * 只看挂上去的那条边,会漏掉「有人登记了一个阻塞但还没决定挂哪儿」——
   * 而那恰恰是**最该拦住收口**的一种。
   */
  readonly unresolvedBlockerCount: number;
  /**
   * `projects.goal` —— **甲方立项时说的那句「要达成什么」**。
   *
   * ⚠️ 它今天**一个字都没被任何规则或提示词读过**(`grep -n goal dispatcher.ts`
   * 在 2026-10-06 之前零命中)。后果是真机现场里:质检的任务正文问「目标达成了吗?」,
   * 而**「目标」是什么压根不在那个回合的提示词里** —— `renderPendingReviews`
   * 只渲染 `id` / `title` / `assigneeAgentId`。于是质检转头去读项目经理写的整改
   * brief 当判据,对着 brief 判 `pass`,而甲方明确答复过的那句诉求(「我要一份,
   * 不是七份」)没有任何一条机制携带到验收环节。
   *
   * 它是**数据**不是硬编码判据(旧 pi 的 `Blackboard.goal` 是同一个思路):
   * 谁都可以改它,但**验收现场必须看得见它**。
   */
  readonly projectGoal: string;
  /**
   * **质检判了「不通过」、而还没有人重新交过东西**的工作项(`runtime/rework.ts`)。
   *
   * 它是 `rework` 那条规则**两侧**的判据来源:触发侧是「有谁在等返工」,
   * 终止侧是 —— 一条工作项**不在这个列表里**就说明它已经重新交过产出(或者没被判 fail)。
   *
   * 同时它是另外三条规则的**抑制条件**(见各自的 `if`),而那三处抑制正是真机事故的
   * 直接修复:一条刚被判 fail 的工作项**不该**被再次收口(`closeIntegratedContainers`)、
   * **不该**被再叫去执行(`execute_work`,它要的是返工回合而不是普通执行回合,
   * 后者不带质检意见)、**不该**被再次审查(`review_work` —— 库里那份产出一个字没变,
   * 真机上就是这样审了三遍)。
   */
  readonly reworkPending: readonly ReworkPending[];
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
 * **12 条**规则 —— 前 8 条是 B1 从原来那 8 个分支搬过来的(行为逐字不变),
 * 接着 2 条是 C3 新增的 `integrate` / `handover`(§2.11.4 的下两行),
 * 再 1 条是 020 的 `resume_client`,最后 1 条是 2026-10-06 真机终局补的
 * `close_finished_project`(项目永远停在 `active` 那一条)。
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
 *      一一对应(asks / meetings / `canReviewChange` 的变更 / 执行角色的工作项 /
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
      // ⚠️ **等返工的工作项不走这一条**(2026-10-07 事故的第三个面)。
      //
      // 判据不同:这一条派的是「按工作项目标干活」的回合(`composeWorkPrompt`),
      // 而等返工的工作项要的是**带着质检意见的返工回合**(`rework` 那条规则)——
      // 让同一个 agent 同时收到两条待办只会有一轮白跑,拿哪条先跑都一样。
      // 早于本批次的形态更糟:容器**两条都收不到**(容器不在 `myOpenWorks` 里),
      // 于是 fail 之后没有任何人被叫醒 —— 真机上三次审查之间零回合。
      const reworking = new Set(q.reworkPending.map((p) => p.workId));
      for (const m of q.members) {
        // 执行只有**执行角色**能做 —— `runWorkItem.checkRunnable` 会在角色不对时
        // 拒绝,与其浪费一次唤醒,不如在这里就只认执行角色。
        // 判据读 `EXECUTOR_ROLES` 而不是写死一个名字:写死会让新加的执行角色
        // 永远收不到「该开工了」这条待办(2026-10-08 加编码工时正是这个坑)。
        if (!isExecutorRole(m.role)) continue;
        for (const w of m.pending.myOpenWorks) {
          if (reworking.has(w.id)) continue;
          out.push({
            agentId: m.agentId, role: m.role, kind: "execute_work",
            key: `execute_work:${w.id}`, target: w.id, refs: [w.id], targetState: w.updatedAt,
            label: `执行工作项 ${w.id}「${w.title}」`,
          });
        }
      }
      return out;
    },
    // ⚠️ `targetRole` 只是**展示/日志**用的标注 —— 真正该谁跑,由上面每条
    // 待办自己的 `role` 决定(`TodoDraft` 逐条带角色)。写死一个执行角色名
    // 会让告警文案把编码工的活说成研究工的。
    then: { kind: "execute_work", targetRole: EXECUTOR_ROLES[0] },
    why:
      "`myOpenWorks` 曾经**不存在**:注入面的字段里没有「派给我的活」,于是执行角色的待办" +
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
      " —— 平台不执行非执行角色的负责人,`needsDecomposition` 也不为真(项目里确实有工作项)," +
      "于是它谁也不叫醒。这条规则是**存量数据**的自愈路径(新数据由 `work_create` / " +
      "`work_assign` 的调用期门直接拒收)。",
  },
  {
    id: "recover_failed_work",
    // `failed` 是一次**状态迁移**(`work_update` → `work_status_changed`)——
    // 与 `resolve_blocked_work` 同一条触发。处置掉的信号是同一个事件
    // (PM 把它改成 `cancelled` / 拆成新工作项),所以不需要新增触发名。
    on: ["work_status_changed", "tick"],
    if: (q) => {
      const pm = q.members.find((m) => m.role === "project_manager");
      if (pm === undefined) return [];
      // ── 唯一的判据:项目里有工作项停在 `failed` ────────────────────
      //
      // `failed` 是**终态**(`isTerminalWorkStatus` 含 done/failed/cancelled),
      // 所以 `execute_work`(`pendingWork.myOpenWorks` 只要 `open|in_progress`)
      // **永远不会**再捡起它 —— 也不该捡:重跑同一条只会同样失败(见 `why`)。
      // 于是它连带把依赖它的下游全卡在 `myWaitingWorks`(`depsSatisfied=false`),
      // 而**没有任何规则读 `works.status='failed'`** ⇒ 整项目**零待办**。
      //
      // ⚠️ **不判「项目是不是还有别的事可做」**:那要跨规则看别的规则的输出,
      // 而 `collectTodos` 是纯查询、规则之间不能互相依赖。用「有 failed 就叫 PM」
      // + 尝试预算限流,三条出路都正确(见 `why` 的最后一段)。
      const ids = q.works.filter((w) => w.status === "failed").map((w) => w.id).sort();
      if (ids.length === 0) return [];
      return [{
        agentId: pm.agentId, role: "project_manager", kind: "recover_failed_work",
        // 集合谓词,与 `resolve_blocked_work` / `review_work` 同形:
        // **进度 = key 变了** —— 处置掉一条,集合缩小 ⇒ 自动拿到新预算。
        key: `recover_failed_work:${ids.join("+")}`,
        target: null, refs: ids, targetState: null,
        label: `重新划范围:${ids.length} 条失败的工作项`,
      }];
    },
    then: { kind: "recover_failed_work", targetRole: "project_manager" },
    why:
      "**真机实测的静默停摆**(2026-10-06 22:35,项目「美股自动化交易平台方案设计·单报告" +
      "合并版」):一条执行角色工作项在单回合读进去 **109,231 token** 之后撞上墙钟上界" +
      "(10 分钟)被 `abort()` 打断,经 `updateWorkStatus` 这个唯一写口记成 `failed`。\n" +
      "`work_failed` outbox 事件被消费了(业务经理 22:38:48 确实被叫醒、去向甲方交代)—— " +
      "**然后就再也没有任何人被叫醒**。直接跑 `collectTodos`:`runnable: 0, exhausted: 0`。\n" +
      "⚠️ **`exhausted` 也是 0**:不是「试够了所以放弃」,是**根本没有一条规则提到 " +
      "`failed`**(`blocked` 有 `resolve_blocked_work`,`failed` 一条都没有)。" +
      "而「零待办」与「组织已经把活干完了」在日志里长得**一模一样** —— " +
      "项目页上那个数字就是「什么都没在干,但项目还在进行中」。\n" +
      "**为什么叫 PM 而不是让执行者重跑**:`execution.ts` 的 `disposeTimeout` 注释里" +
      "已经写明「一次卡到墙钟的回合,自动重跑只是把同一段卡死行为再买一遍」。" +
      "真机那条正是如此:目标太大(合并 7 份报告)⇒ 原样重跑会同样超时。" +
      "**该做的是重新划范围**——而「怎么划」是业务判断,PM 有 `work_create` / " +
      "`work_update` / `work_assign`(§2.11.3:不替模型判)。\n" +
      "⚠️ **三条出路都正确,这是它敢用「有 failed 就叫」这个粗判据的原因**:\n" +
      "  ① PM 把它关掉 / 拆掉 ⇒ `failed` 消失 ⇒ 判据不成立,规则安静下来;\n" +
      "  ② PM 改写目标后重开 ⇒ 它不再是 `failed` ⇒ 同上;\n" +
      "  ③ PM 什么都不做 ⇒ 尝试预算走完,`exhausted` 出现 ⇒ `announceDrain` " +
      "落一条 `system` 消息报出「恢复尝试已用尽」(**不是静默停**)。\n" +
      "终止判据落在 `works.status` 上(`failed` 集合清空),重启后自动补跑。",
  },
  {
    id: "resolve_blocked_work",
    // `blocked` 是一次**状态迁移**(`work_update` → `work_status_changed`),而
    // 「阻塞被解除」在闭合触发集里**没有取值**(`blocker.update` 只能敲门铃,
    // 说不出触发名 —— 与「建会 / 建工作项 / 改派 / 登记阻塞」同一个已知缺口)。
    on: ["work_status_changed", "tick"],
    if: (q) => {
      const pm = q.members.find((m) => m.role === "project_manager");
      if (pm === undefined) return [];
      const ids = q.works
        // `blocked` 是非终态(`isTerminalWorkStatus` 只含 done/failed/cancelled),
        // 所以这里不需要再判一次终态。
        .filter((w) => w.status === "blocked")
        // ── 唯一的抑制条件:**等甲方**,两条同时成立 ──────────────────
        //
        //   ① 项目里有未答复的 `client_question`(球在甲方那边),
        //   ② 这条工作项**挂了至少一个未解决的阻塞**(它的现场已经在库里,
        //      `blocker_list` 查得到,不是一条无声的 `blocked`)。
        //
        // ② 不是装饰:一条**裸 `blocked`**(没人登记过阻塞)无论甲方那边在等什么,
        // 都必须要有人去看一眼 —— 那是「说不出为什么卡住」,而不是「说清了在等谁」。
        // 少了 ②,一次无关的甲方提问就能把一条没人解释过的 `blocked` 静默压住,
        // 而那正是本规则要修的那个形态(零待办 —— 与「组织干完了」长得一样)。
        //
        // ⚠️ 抑制是**项目级**的粗判据(库里没有「这条提问对应哪条工作项」的边,
        // 见 `RuleFacts.awaitingClient`)。失效方向如实记在 `why` 里。
        .filter((w) => !(q.awaitingClient && q.blockedByBlockerWorks.has(w.id)))
        .map((w) => w.id)
        .sort();
      if (ids.length === 0) return [];
      return [{
        agentId: pm.agentId, role: "project_manager", kind: "resolve_blocked_work",
        // 集合谓词,与 `review_work` / `fix_work_assignment` / `integrate` 同形:
        // **进度 = key 变了** —— 处置掉一条,集合缩小 ⇒ 自动拿到新预算。
        key: `resolve_blocked_work:${ids.join("+")}`,
        target: null, refs: ids, targetState: null,
        label: `处置 ${ids.length} 条被阻塞的工作项`,
      }];
    },
    then: { kind: "resolve_blocked_work", targetRole: "project_manager" },
    why:
      "**真机实测的静默停摆**(这条规则就是为它写的):`blocked` 的工作项**不在任何待办里**" +
      " —— `pendingWork.ts` 的 `myOpenWorks` 只要 `open|in_progress`,而**没有任何规则读**" +
      "`works.status='blocked'`(`grep 'blocked' dispatcher.ts` 当时只命中注释;" +
      "`asks` 表 0 行;`blocker_opened` 只在 severity ∈ {high, critical} 时写 outbox," +
      "medium 阻塞**连 outbox 都没有**)。后果是整个项目**零待办**:一条 `blocked` 的子项" +
      "把依赖它的下游全卡在 `myWaitingWorks`(`depsSatisfied=false`),排空器每 10 秒空转。" +
      "真机库副本上三组对照:①原样(1 根 blocked + 子项 done/done/blocked/open/open)⇒ 待办**空**;" +
      "②只留那条 blocked 的子项 ⇒ `integrate` **不出现**;③那条子项也 done ⇒ `integrate` 出现 ✓" +
      "(⇒ 根 blocked 不卡 integrate,卡住的是**那条子项没人推**)。" +
      "判据的另一半是**不许把「等甲方」也当成「该叫 PM」**:甲方还没回话时(项目里有" +
      "未答复的 `client_question`)那条 `blocked` 等的就是**外部输入** —— 而向甲方开口只有" +
      "业务经理做得到(`client.ask` 只在他的 ceiling 里;**两个执行角色连 `ask_client` 都不持**)," +
      "PM 叫醒也只能空转一轮(抑制条件见规则的 `if`)。" +
      "⚠️ 它会**多叫醒 PM**(与合并唤醒「少打扰」反向),所以靠 `dispatch_attempts` 限流 —— " +
      "而限流**不是判据**:判据是上面那条「有工作项停在 blocked 且没有驱动者」,预算只决定" +
      "「叫几次」,不决定「叫不叫」。",
  },
  {
    id: "rework_failed_review",
    // 触发名说的是「这条规则的输出会因为什么而变」:
    //   `work_status_changed` —— 判 fail 的那次调用会把工作项从 `done` 退回
    //     (唯一写口 `updateWorkStatus`),那是它出现的信号;
    //   `artifact_inserted` —— **返工完成的信号**:这条工作项上出现了比质检结论
    //     更新的产出(`blackboard.write` 会敲门铃),于是这条待办消失。
    // 两侧都读工件的**结构化列**(`kind` / `work_id` / `created_at`),不读正文。
    on: ["work_status_changed", "artifact_inserted", "tick"],
    if: (q) => {
      const out: TodoDraft[] = [];
      for (const p of q.reworkPending) {
        const owner = reworkOwner(p, q.members);
        if (owner === null) continue; // 项目里连项目经理都没有 —— 装配问题,不是判据
        out.push({
          agentId: owner.agentId, role: owner.role, kind: "rework",
          // key 按**工作项**单键:一件产出的返工就是一件事。集合谓词在这里没有意义
          // (与 `review_work` 的 join 不同 —— 那个是「一批等审的」)。
          key: `rework:${p.workId}`, target: p.workId, refs: [p.workId],
          // ⚠️ `targetState` **刻意是 null**:这条待办的「目标动了」= **重新交了一份产出**,
          // 而那一件事在库里表现为「待办消失」(`reworkPendingOf` 转 null)⇒ `pruneAttempts`
          // 把预算清掉(`repo/dispatch.ts`)。若改挂 `works.updated_at`,一次 no-op 的
          // `work_update` 就能把预算清零 —— 那正是「重复即停」的失效方向。
          targetState: null,
          label: p.producedArtifactIds.length === 0
            ? `返工「${p.workTitle}」(第 ${p.round} 轮,它一份产出都没有)`
            : `返工「${p.workTitle}」的产出(第 ${p.round} 轮,质检判不通过)`,
        });
      }
      return out;
    },
    then: { kind: "rework", targetRole: "roster" },
    why:
      "**2026-10-07 真机事故的直接修复**。现场:项目「催收语音机器人技术方案」的根工作项被" +
      "质检**连续三轮 fail**,三份审查意见共一万多字节(还自己写了「建议升级」),而" +
      "**三次审查之间一个执行回合都没有**(`turn_usage` 可查)。两个缺陷叠在一起:" +
      "① `review_verdict` 判 fail 走 `updateWorkStatus(work,'in_progress')`,而那条工作项是" +
      "**容器**(有子项)⇒ `pendingWork.ts` 的 `myOpenWorks` 把容器排除在外 ⇒ **没有执行者会接手**" +
      "(工具当时回给模型的话是「原执行者会再跑一轮」—— 平台做不到那件事,于是模型在假前提上推理);" +
      "② 排空器每轮开头的 `closeIntegratedContainers` 见那条根「非终态 + 子项全终态且已审」⇒" +
      "**8 秒内又把它收口成 done** ⇒ 再叫质检审**同一份没变的东西**(真机:`dispatch_events` 里" +
      "4 条一字不差的「已完成」)。" +
      "⇒ 修法不是「再退回一次」,而是**让质检结论这一条工件真的继续流转**:判据是" +
      "「最近一次结论是 fail 且那之后它自己没有新产出」,**目的地由产出的作者决定**" +
      "(用户裁决:有作者给作者,找不到人解决就给 PM;第 " + REWORK_ESCALATE_ROUND + " 轮起换人)。" +
      "⚠️ 这条规则的出现**必然**让另外三处收窄(同一次修复的三个面):`review_done_works`" +
      "不再审「等返工」的产出(真机就是这样审了三遍)、`execute_assigned_work` 不再把它当普通" +
      "执行回合派出去(那个回合不带质检意见)、`closeIntegratedContainers` 不再撤销这次退回。",
  },
  {
    id: "review_done_works",
    // `review_state` 的唯一写口就是 `works.status` 的唯一写口(`updateWorkStatus`),
    // 所以「刚做完」在这里表现为一次工作项状态迁移。
    on: ["work_status_changed", "tick"],
    if: (q) => {
      const qa = q.members.find((m) => m.role === "quality_reviewer");
      if (qa === undefined || q.pendingReview.length === 0) return [];
      // ⚠️ **等返工的那些不审**(2026-10-07 事故的第四个面)。
      //
      // 真机上就是这样审了三遍:工作项被判 fail → 平台 8 秒内又把它收口成 done
      // → 这条规则看到「done + pending」→ 质检再审**同一份一个字节都没变的产出**,
      // 第三次的审查意见写着「三轮以来工件组成完全无变化」。判据在库里就写着:
      // 那条工作项最近一次结论是 fail、且那之后它自己没有任何新产出 ⇒
      // **它不是在等审,是在等返工** —— 再审只能是同一句话再说一遍。
      const reworking = new Set(q.reworkPending.map((p) => p.workId));
      const ids = q.pendingReview.filter((w) => !reworking.has(w.id)).map((w) => w.id).sort();
      if (ids.length === 0) return [];
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
      // ⚠️ **球在甲方那边时不追加**(与 `handover_deliverable` 同一条纪律)。
      //
      // 真机现场(2026-10-07 09:03–09:13):一个**已经 `done` 且已经交付**的项目上,
      // 业务经理被 `report_downstream` + `handover` 叫醒三轮,连问甲方三件事 ——
      // 而 `ask_client` **没有任何合并窗口**(`report_downstream` 自己有
      // 「攒够 N 条或等 T」,提问那条没有)。三件里两件问的是同一件事,
      // 第三件要甲方去核对业务经理自己读得到的内容。
      //
      // 抑制**不是**丢弃:这些行留在 outbox 里(`consumed_at` 仍为 NULL),
      // 甲方一答复,`resume_client` 那一轮连同它们一起交代。
      if (q.awaitingClient) return [];
      // ── 合并唤醒:攒够 N 条、或最老的那条等到 T,才叫醒一次 ──────────
      //
      // 加这两个条件的**唯一**理由是用户的原话:「业务经理干的事情太多了……
      // 聊天记录里面的一长串,真真甲方不关心这些」。那次实测的真机库是扁平结构,
      // 写入侧的
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

  // ══ C3:质检之后缺的那两环(设计 1 §2.11.4 的下两行)══════════════
  //
  // 上面 8 条是 B1「行为逐字不变」的搬运结果;下面 2 条是**新功能**,所以它们
  // 改变行为是**设计的一部分**(`tests/platform/dispatcher.test.ts` 里几条精确的
  // 序列断言因此会多出一环 —— 那些断言在 C3 里被如实更新,见该文件的注释)。
  //
  // 用户的原话:「质检完了产出工件触发项目经理整合然后交付,交付给到业务经理,
  // 业务经理拿到交付物(也是工件的一种),然后**主动发起和用户的对话**」。
  // 上面两条规则各自对应这句话的一环,而**唯一的机械判据**都落在工件上:
  // `integrate` 的终止判据是「根工作项上有没有 `deliverable` 工件」,
  // `handover` 的资格判据是「有没有 `status='accepted'` 的 `deliverable`」。
  {
    id: "integrate_reviewed_subtree",
    // ①子树最后一条工作项**收口**(`work_status_changed` —— 一次状态迁移)
    // ②**产出工件**(`artifact_inserted`,这一批里第一次真的有人用它 —— B1 实测
    //   8 条规则一条都没用到它;约束是给**条件侧**的:下面 `if` 读的是工件的
    //   **结构化列**(kind / work_id),不读正文,§2.11.3)
    // ③兜底 tick(重启后补跑:状态在库里)
    on: ["work_status_changed", "artifact_inserted", "tick"],
    if: (q) => {
      const pm = q.members.find((m) => m.role === "project_manager");
      if (pm === undefined) return [];
      const children = childrenByParent(q.works);
      /** 这一轮准备好整合的根(每个 = 一条要写交付物的交付) */
      const ready: WorkRow[] = [];
      for (const root of q.works) {
        if (root.parentWorkId !== null) continue; // 只看根
        // 判据本身在 `deliveryCollected` / `hasDeliverableOnSubtree` ——
        // **平台收口容器时读的是同一对函数**(见 `closeIntegratedContainers`)。
        // 两份定义会漂,而这个项目为它付过代价。
        //
        // ⚠️ 方向:规则要的是「收口了 **且还没有** 交付物」= 该叫醒项目经理去写。
        // 收口那条走的是「收口了 **且已经有** 交付物」。
        if (
          deliveryCollected(root, children) &&
          !hasDeliverableOnSubtree(root, children, q.deliverableWorkIds)
        ) {
          // ⚠️ **等返工的根不走这一条**:它要的不是「整合子项」,而是「把质检指出的
          // 问题解决掉」—— 那条路由 `rework` 规则带着质检意见派出去(目的地可能是
          // 原作者,也可能是被升级到的 PM)。两条规则同时点火 = 一个根被叫两次,
          // 而其中一次不带任何质检现场(2026-10-07 事故第五个面)。
          if (q.reworkPending.some((p) => p.workId === root.id)) continue;
          ready.push(root);
        }
      }
      if (ready.length === 0) return [];

      // ── 为什么**一条待办覆盖全部就绪的根**,而不是每个根一条 ─────────
      //
      // ① 与这张表里其他「集合谓词」的规则同形(`review_work` / `fix_work_assignment`
      //    的 key 就是 id 集合的 join):**进度 = key 变了**。项目经理整合掉一个根,
      //    那个根从集合里消失 ⇒ key 变 ⇒ 自动拿到新预算(at-least-once,不会漏)。
      // ② 一条待办 = **一个回合**。那次实测的真机库是扁平结构
      //    (9 work / 9 root / 0 中间;⚠️ 2026-10-05 复核当前库是 1 根 + 4 子项),
      //    那一次每根一条待办会一次排空就叫醒项目经理 9 次,把 `maxRounds`(默认 8)烧光 ——
      //    而业务经理的汇报排在它们**后面**,于是「甲方什么都不知道」这件事会
      //    被一次整合风暴掩盖(那是真机上已经出现过一次的形态)。
      const ids = ready.map((w) => w.id).sort();
      const only = ready.length === 1 ? ready[0]! : null;
      const kidCount = only === null ? 0 : (children.get(only.id) ?? []).length;
      return [{
        agentId: pm.agentId, role: "project_manager", kind: "integrate",
        key: `integrate:${ids.join("+")}`, target: null, refs: ids,
        // 没有单一目标行,版本由 **key 的集合**承载(与 `review_work` 同一条理由)
        targetState: null,
        label: only === null
          ? `整合 ${ready.length} 条已收口的交付(根工作项 ${ids.join(" / ")})`
          : kidCount > 0
            ? `整合根工作项 ${only.id}「${only.title}」下的 ${kidCount} 条子项产出`
            : `整合工作项 ${only.id}「${only.title}」并写出交付物`,
      }];
    },
    then: { kind: "integrate", targetRole: "project_manager" },
    why:
      "流水线在质检之后**没有下一环**:`TodoKind` 的 8 个取值里没有「整合」," +
      "`grep -rn 整合 src/` 只命中两处测试数据注释(§2.11.1)。判据是**集合 + 状态谓词**" +
      "而不是「产出了工件」—— 一个 `cancelled` 的子项没有工件,纯工件判据会让里程碑" +
      "永不达成(§2.11.2)。而**终止判据必须是工件**(③):`deliverable` 挂在根工作项上" +
      "这件事就是「整合完了」在库里的唯一答案;没有它,这条 `if` 每次 tick 都成立," +
      "会一直叫到尝试预算用尽 —— 而预算是**限流不是判据**,拿它兜一条每次都成立的规则" +
      "等于让流水线静默停在一个「看起来跑过很多次」的地方(§2.11.4 末)。",
  },
  {
    id: "handover_deliverable",
    // 只可能因为「新落了一条工件」而变:资格是 `deliverable` + `accepted`,
    // 而 `status` 今天**写完之后基本改不了**(唯一的生产变更点是 client_question 那条;
    // `applyArtifactStatus` 全仓零调用方,§2.11.3)。所以它今天事实上是**建**触发的。
    // 仍然写 `tick`:兜底定时器是**重启后补跑**的唯一载体(见 `RULES` 的说明)。
    on: ["artifact_inserted", "tick"],
    if: (q) => {
      const bm = q.members.find((m) => m.role === "business_manager");
      if (bm === undefined) return [];
      // ⚠️ **球在甲方那边时不追加第二次交代**(2026-10-06 真机现场补)。
      //
      // 真机:`09:03:42` 与 `09:03:59` —— 相隔 **17 秒** —— 业务经理连着问了两件,
      // 而第一件还没有答复。它等的是甲方,这时候再叫醒它,只会让它**再问一件**。
      //
      // 而它真的会:第二件是「你确认这份子文件覆盖是否完整」—— **那份工件
      // 业务经理自己读得到**(`blackboard.read` 在它的 ceiling 里,实测 09:04
      // 它就读了),却把「你自己核对」变成了一条要甲方动手的待办。
      //
      // 抑制**不是**丢弃:未消费的 outbox 事件留在库里,甲方一答复,
      // `resume_client` 那一轮会把它们一起交代出去(合并唤醒本来就是这个形状)。
      if (q.awaitingClient) return [];
      const out: TodoDraft[] = [];
      for (const a of q.acceptedDeliverables) {
        // ── 终止判据:这条交付物已经有交付会话了(§2.11.6 的那条边)──
        //
        // 判据**从库里查**(`project_sessions.deliverable_artifact_id`),不是从
        // 本回合的产出里带 —— 一个回合的产出只有执行角色那条路、只有挂了 014 边的
        // 行、而且只有增量(B3 实测),拿它当触发会让交付这一环**静默不可见**。
        if (q.deliveredArtifactIds.has(a.id)) continue;
        out.push({
          agentId: bm.agentId, role: "business_manager", kind: "handover",
          key: `handover:${a.id}`, target: a.id, refs: [a.id], targetState: a.updatedAt,
          label: `把交付物「${a.title}」交付给甲方`,
        });
      }
      return out;
    },
    then: { kind: "handover", targetRole: "business_manager" },
    why:
      "交付之后**没有下一环**:交付物的存在没人读(§2.11.1)。这条规则是「业务经理" +
      "主动开一条对话」的**唯一入口**。资格判据是 `status='accepted'` —— 整合刚写完" +
      "(`open`)时还不该惊动甲方;终止判据是**交付会话那条边**,它由 C4 的 migration 017" +
      "加到 `project_sessions` 上(`deliverable_artifact_id`)。列不在时 `deliveredArtifactIds`" +
      "**如实**返回空集(还没有任何交付会话),而不是假装已经交付过 —— C4 一落地,这条" +
      "判据自动开始成立,规则自己就停了。",
  },
  {
    id: "resume_client",
    // 「答复落库」唯一可能的形态就是「新落了一条工件」—— `decision` 工件由
    // `resolveClientQuestion` 原子创建(tools/client.ts),而它不持任何能力,
    // 所以不会敲门铃;`artifact_inserted` 这条触发名仍然由那条工件满足
    // (与 `integrate_reviewed_subtree` / `handover_deliverable` 同一条通道)。
    // `tick` 不是装饰:它是**重启后补跑**的唯一载体(见 `RULES` 的说明)——
    // 答复落在库里的那一刻进程正好重启,那条工件已经不会被「插入」第二次。
    on: ["artifact_inserted", "tick"],
    if: (q) => {
      const bm = q.members.find((m) => m.role === "business_manager");
      if (bm === undefined || q.unconsumedClientAnswers.length === 0) return [];
      // 集合谓词,与 `answer_ask` / `review_work` 同形:**进度 = key 变了** ——
      // 处置掉一条,集合缩小 ⇒ 自动拿到新预算。不需要额外机制。
      const ids = q.unconsumedClientAnswers.map((a) => a.questionArtifactId).sort();
      return [{
        agentId: bm.agentId, role: "business_manager", kind: "resume_client",
        key: `resume_client:${ids.join("+")}`, target: null, refs: ids, targetState: null,
        label: `处置甲方对 ${ids.length} 个问题的答复`,
      }];
    },
    then: { kind: "resume_client", targetRole: "business_manager" },
    why:
      "**真机事故**(2026-10-06 09:09,项目「美股自动化交易平台方案设计」):甲方在待答" +
      "面板点了答复,`POST /api/client-questions/:id/answer` 写了 decision 工件、建了" +
      "`answers` 审计边、把提问转 `accepted` —— 三件事全对,答复也**确实在库里**。" +
      "而 3 分钟后的 `GET /live` 是:`四个角色 todos 全空` / `openWorks: 0` / " +
      "`runningTurns: 0`。之后系统再没有产生过一条消息,而业务经理 20 分钟前亲口" +
      "宣布的队列(「等您回完 W1,我会按 W2→…→W7 逐项问」)永远不会自动开始。" +
      "**根因不是答复没记下来,是没有任何一行记下「答复到了、他还没看」** —— " +
      "于是排空器每 10 秒查库,每次都读到「无事可做」。" +
      "⚠️ 它是 7-L 那次修复的漏网之鱼:「提问者进 blocked、但对方不会主动知道」" +
      "当时只治了 agent↔agent 的 `asks` 表(`answer_pending_ask` 读 `asksToAnswer`)," +
      "而 `client_question` 是**另一条载体** —— 同一个病,两条通道只治了一条。" +
      "**判据必须是库里的终止判据**:答复是过去式,「他答过」不会自己消失,所以" +
      "`consumed_at` 必须是一列而不是内存里的一个 Set(020);拿尝试预算兜一条每 10 秒" +
      "都成立的规则,等于让流水线静默停在一个「看起来跑过很多次」的地方(§2.11.4 末)。" +
      "⚠️ **本规则只认「答复到了」,绝不认「提问还没答复」** —— 后者要一条" +
      "「有 open 的 client_question 就叫醒业务经理」的规则,而那是错的:球在甲方那边," +
      "每 10 秒叫醒他一次就是空转(与 `resolve_blocked_work` 的抑制条件同一条纪律的两面)。",
  },
  {
    id: "close_finished_project",
    // 判据的每一半都只可能因为「新落了一件事」或「一件东西不再是那样」而变:
    // 工作项状态迁移、交付物落库、答复被消费。而 `tick` 是**重启后补跑**的唯一载体
    // —— 项目状态只在库里,不播撒(批次 21 的纪律:判定每次从库里重算)。
    on: ["work_status_changed", "artifact_inserted", "tick"],
    if: (q) => {
      const bm = q.members.find((m) => m.role === "business_manager");
      if (bm === undefined) return [];
      // ── 终止判据:项目已经不是 active 了 ────────────────────────────
      // 落在一列上(`projects.status`),所以项目一收口这条规则立刻不成立,
      // **不需要任何额外状态**。这也是「收口不可逆」在机制上的体现:它不会被
      // 第二次叫醒、不会把一个已关闭的项目重新叫活。
      if (q.projectStatus !== "active") return [];
      // ── 资格判据:八件事**同时**不成立,才谈得上「做完了」────────────
      //
      // 每一条都读**结构化列**,不读正文(§2.11.3)。少一条就会在不该收口的
      // 时候收口 —— 而收口是**不可逆**的(`closeProject` 直接 `throw`),
      // 所以这里宁可多列几条。
      if (q.nonTerminalWorkCount > 0) return [];
      if (q.pendingReview.length > 0) return [];          // 做完但还没审
      if (q.events.length > 0) return [];                  // 下游结果还没交代
      if (q.awaitingClient) return [];                     // 还有问题在等甲方
      if (q.unconsumedClientAnswers.length > 0) return []; // 答复到了还没处置
      if (q.unresolvedBlockerCount > 0) return [];          // 还有没解决的阻塞
      // **还没有任何已验收的交付物** = 「做完了」没有交付物证明。
      // ⚠️ 这一条挡住的是最难看的一种终局:工作项全 done、审全 pass,而**甲方
      // 手上什么都没有**。真机上它就是靠这条形态出现的(交付物在,但根工作项
      // 自己的产出只是 evidence)。
      if (q.acceptedDeliverables.length === 0) return [];
      // 有交付物却**还没交付给甲方** —— 那是 `handover` 的活,顺序在它后面。
      if (q.acceptedDeliverables.some((a) => !q.deliveredArtifactIds.has(a.id))) return [];
      // ── 到这里才成立 ────────────────────────────────────────────
      return [{
        agentId: bm.agentId, role: "business_manager", kind: "close_project",
        // key 用项目 id:它就是这件事唯一的身份,变化只可能来自 status 变终态。
        key: `close_project:${q.projectId}`,
        target: q.projectId, refs: q.acceptedDeliverables.map((a) => a.id),
        targetState: null,
        label: `判断这个项目是不是做完了(已交付 ${q.acceptedDeliverables.length} 份)`,
      }];
    },
    then: { kind: "close_project", targetRole: "business_manager" },
    why:
      "**真机终局**(2026-10-06 17:2x,项目「美股自动化交易平台方案设计」):11 条工作" +
      "全部 `done` + `review_state='done'`、6 条 `review_verdict` 全部 `pass`、outbox 空、" +
      "`openWorks=0` / `pendingQuestions=0` / `openBlockers=0` / `runningTurns=0` ——" +
      "**而 `projects.status` 永远是 `active`**。用户看到的字面就是「什么都没在干," +
      "但项目还在进行中」,而这两种状态在界面上的距离是**零像素**。" +
      "`project_close` 工具一直有生产调用方(`tools/project.ts`),**零自动触发** ——" +
      "11 条规则里没有一条提到收口,`NUDGE_CAPABILITIES` 里也没有 `project.close`。" +
      "**「代码里写了逻辑」不等于「它有读者」**(7-E)。" +
      "⚠️ **判据成立时不自动关闭,而是叫醒业务经理去判断**:「收不收口」是业务判断," +
      "不是平台能从库里推出来的结论(§2.11.3)。终局那一次的正确行为是" +
      "「业务经理看着交付物说一句『可以收了』」,不是「平台觉得活干完了就销号」。",
  },
];

/**
 * **交付会话 ↔ 交付物**这条边(设计 1 §2.11.6)的读面。
 *
 * ⚠️ **这一列今天还不存在** —— 它由 **C4** 的 migration 017 加到 `project_sessions`
 * 上(`deliverable_artifact_id TEXT REFERENCES artifacts(id)`)。C3 只做「产出这条
 * 待办」,建会话留给 C4。所以这里**先问 schema 再查**(`PRAGMA table_info`):
 *
 *   - 列在  → 查出已被交付过的交付物 id(终止判据真的成立)
 *   - 列不在 → 返回**空集**,含义是「还没有任何交付会话」
 *
 * 为什么不是 `try { … } catch { return new Set() }`:一条 SQL 报错被吞掉之后,
 * 「列还没迁移」与「查询写错了」在结果上长得一模一样(本项目最贵的失败形态)。
 * `PRAGMA table_info` 是一次**问得出答案**的检查,不需要靠异常区分。
 *
 * 为什么不在模块作用域缓存这张表的结构:那是**跨调用的进程内状态**,而本模块
 * 全部的纪律就是「判定每次从库里重算」(§9.4)。`table_info` 是常数级开销。
 */
function deliveredArtifactIds(db: Database.Database, projectId: string): ReadonlySet<string> {
  const columns = db.pragma("table_info(project_sessions)") as ReadonlyArray<{ name: string }>;
  if (!columns.some((c) => c.name === "deliverable_artifact_id")) return new Set();
  const rows = db
    .prepare(
      `SELECT deliverable_artifact_id AS id FROM project_sessions
       WHERE project_id = ? AND deliverable_artifact_id IS NOT NULL`,
    )
    .all(projectId) as ReadonlyArray<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * 这条根 R 的交付**收口了**吗 —— 设计 1 §2.11.4 的 **①②** + 两条「没什么可交付」
 * 的处置(**不含 ③**;③ 是 `hasDeliverableOnSubtree`,因为它的两个方向各有读者)。
 *
 * **两个读者共用这一份前置判据**,这是它被抽出来的唯一理由:
 *   ① `integrate` 规则的 `if` = 收口了 **且 还没有**交付物 ⇒ 叫项目经理去写;
 *   ② `closeIntegratedContainers` = 收口了 **且 已经有**交付物 ⇒ 容器收口成 `done`。
 * 两处各写一套,迟早出现「规则说整合完了、平台说没有」(或反过来)—— 而这个项目
 * 为「两份定义会漂」已经付过好几次代价。
 */
function deliveryCollected(
  root: WorkRow,
  children: ReadonlyMap<string, WorkRow[]>,
): boolean {
  const subtree = subtreeOf(root, children);
  const kids = subtree.slice(1);
  // ── ① 子树**全部终态** ──────────────────────────────────────
  //
  // `cancelled` 按 §2.8 算**收口**(`isTerminalWorkStatus` 含它):取消的定义
  // 是「这块范围不要了,输入少了一块」,它不阻塞也不产出 —— 若按「必须有产出」
  // 判,一个取消的子项就能把里程碑**永久钉死**(§2.11.2 的第一条反例)。
  //
  // ⚠️ 判的是**后代**;没有后代时判 R **自己**(§9.4:「扁平时每个根就是它
  // 自己,子树判据退化成单条工作项判据」)。不能反过来只判后代:空集上
  // 「全部终态」**恒真**,刚拆完就会把项目经理叫来整合。
  const judged = kids.length > 0 ? kids : [root];
  if (!judged.every((w) => isTerminalWorkStatus(w.status))) return false;
  // ── ② 产出都审过 ─────────────────────────────────────────────
  //
  // 含 R 自己:容器也可能是 `done` 而没审(在树上,`work_update` 可以把它标成
  // done)。这时**先让 `review_work` 跑**(优先级 7 < 8),别在还有人没审时整合。
  if (subtree.some((w) => w.status === "done" && w.reviewState !== "done")) return false;
  // ── 两条「没什么可交付」的处置(设计表里没有,理由是它们各自的现场)──
  //
  //   - **R 自己 `cancelled`**:整块范围不要了,没有交付可言。不拦它就会
  //     叫项目经理去交付一个已经被取消的交付物(它什么都不会写 ⇒ 被反复
  //     叫醒到预算用尽,然后在会话里留下一条「预算用尽」的噪音)。
  //   - **子树里一条 `done` 都没有**(全 failed / 全 cancelled):没有产出可
  //     整合。失败该走的是「向甲方交代」(outbox 里已有 `work_failed`),
  //     不是「交付」。
  if (root.status === "cancelled") return false;
  if (!subtree.some((w) => w.status === "done")) return false;
  return true;
}

/**
 * 这条交付的**整棵子树**上落着 `deliverable` 工件吗 —— 设计 1 §2.11.4 的 **③**。
 *
 * 「已经整合过了」这个结构化事实落在**工件**上,不在 `works` 的某一列上(用户要的
 * 正是「工件即推动流程」)。判据放宽到**整棵子树**(不只是 R 自己):`board_write`
 * 的产出边是模型显式填的,填给子项同样是「这份交付有整合产物」—— 这里宁可少叫
 * 一次,也不能因为边挂错了地方而反复叫到预算用尽(那是**静默**的一种:
 * 它长得像「系统跑过很多次」)。
 *
 * ⚠️ **同一个谓词有两个方向,两个方向都不许各写一份**:
 *   - **没有它** ⇒ `integrate` 规则该叫醒项目经理去写交付物(规则用 `!`);
 *   - **有它** ⇒ `closeIntegratedContainers` 该把容器收口(`done`)。
 * 这正是它被单独抽出来的理由:两处各写一套,迟早出现「规则说整合完了、平台说
 * 没有」或者反过来 —— 而这个项目为「两份定义会漂」已经付过好几次代价。
 */
function hasDeliverableOnSubtree(
  root: WorkRow,
  children: ReadonlyMap<string, WorkRow[]>,
  deliverableWorkIds: ReadonlySet<string>,
): boolean {
  return subtreeOf(root, children).some((w) => deliverableWorkIds.has(w.id));
}

/**
 * 平台记账:**把已经整合完、却还停在非终态的容器收口成 `done`**。
 *
 * ── 为什么必须有它(缺陷丙①的另一半)───────────────────────────
 *
 * 丙① 之后容器不进 `execute_work`(判据 = 有子项),而 `integrate` 也**不会**
 * 再为它产出待办(判据 ③ 已被那条 `deliverable` 满足)⇒ 若没有这一条,
 * **没有任何东西会再推动这条根**:它会永远停在 `open` / `blocked`,项目看板可能
 * 因此**整个空掉**(零待办 —— 与「组织已经把活干完了」长得一模一样,这正是本批
 * 要修的那个形态)。
 *
 * ── 为什么是「每次排空先查一次库」,而不是「整合那个回合之后再写」──────
 *
 * 后者漏掉一整类现场:**产出边挂在子项上**时(规则刻意容忍,见 ③ 的说明),
 * 那条根一辈子不会进入任何 `integrate` 回合 ⇒ 永远收不了口。判据是**库里的
 * 事实**(工件 + 状态),所以它必须是**声明式**的一次查询,而不是某个回合的
 * 副产品 —— 与 `markWorkReviewed` / `consumePendingDispatchEvents` 同一条纪律:
 * **回合成功才记账**,而「这件事办过了没有」永远重新查库。
 *
 * ⚠️ **必须走唯一写口** `updateWorkStatus`(§2.7):状态迁移表、`review_state`、
 * outbox 事件三件事都在那个函数里维护 —— 直接 `UPDATE works SET status='done'`
 * 会静默绕过迁移合法性,并让「根工作项终态 ⇒ 向甲方交代」那条链路断掉。
 *
 * ⚠️ **已知后果(刻意留下,不是漏洞)**:根迁入 `done` ⇒ `review_state='pending'`
 * ⇒ 那条整合产物按既有的 `review_work` 规则被质检修一遍。要跳过它得另外调
 * `markWorkReviewed` —— 那是**另一条设计决定**(谁审整合产物),不该由收口顺手做掉。
 */
function closeIntegratedContainers(
  db: Database.Database,
  projectId: string,
  at: number,
  log: (line: string) => void,
  /**
   * **在等返工**的工作项 id(`runtime/rework.ts` 的判据)。
   *
   * 由调用方传进来而不是在这里现查:调用方(`drainProject`)**每一轮都要**这个集合,
   * 而「同一件事查两遍」的下一步就是「两份定义」(判据一旦被复制,迟早漂)。
   */
  reworkIds: ReadonlySet<string>,
): readonly string[] {
  const works = listWorks(db, projectId);
  const children = childrenByParent(works);
  const deliverableWorkIds = new Set(
    listArtifacts(db, projectId, { kind: "deliverable", limit: 500 })
      .map((a) => a.workId)
      .filter((id): id is string => id !== null),
  );
  const closed: string[] = [];
  for (const root of works) {
    if (root.parentWorkId !== null) continue; // 只看根:容器就是「有子项的根」那一类
    if (isTerminalWorkStatus(root.status)) continue;
    // 刚被质检退回、还没人返工 ⇒ **不许收口**(否则就是那个 8 秒循环)
    if (reworkIds.has(root.id)) continue;
    if (!deliveryCollected(root, children)) continue;
    if (!hasDeliverableOnSubtree(root, children, deliverableWorkIds)) continue;
    const r = updateWorkStatus(db, root.id, "done", at);
    if (!r.ok) {
      // not_found / illegal_transition 都会走到这里,而它们都是**装配或迁移表**的
      // 问题:不许吞(7-N —— 见不到的现场等于没有现场)。
      log(`dispatcher: ✖ 容器 ${root.id} 收口失败(${r.reason})—— ${r.message}`);
      continue;
    }
    if (r.changed) closed.push(root.id);
  }
  return closed;
}

/**
 * **挂着至少一个未解决阻塞的工作项** id(一次查库,给 `RuleFacts` 用)。
 *
 * ── 为什么这条 SQL 在本文件而不是 `repo/blockers.ts` ────────────────
 *
 * `blockersForWork(db, workId)` 已经是那条边的读面,但它是**逐条**查的;规则要的
 * 是「这个项目里哪些工作项挂着未解决阻塞」—— 按项目查一次。写在这里不另建一个
 * 仓储入口,是因为宿主侧的「阻塞行存在吗」本来就已经有同样的先例
 * (`isImmediateEvent` 直接 `SELECT severity FROM blockers WHERE id = ?`)。
 *
 * **只读 `status`**:`severity` / `title` / `detail` 一个都不读。规则的 `if` 一旦
 * 读 `severity` 就会开始猜「这条阻塞该谁修」,而那正是 §2.11.3 禁止的
 * 「规则做语义判断」。判据只用「有没有」,不用「像不像」。
 */
function worksWithUnresolvedBlocker(
  db: Database.Database,
  projectId: string,
): ReadonlySet<string> {
  const rows = db
    .prepare(
      `SELECT DISTINCT bb.work_id AS id
         FROM blocker_blocks bb JOIN blockers b ON b.id = bb.blocker_id
        WHERE b.project_id = ? AND b.status IN ('open', 'acknowledged')`,
    )
    .all(projectId) as ReadonlyArray<{ id: string }>;
  return new Set(rows.map((r) => r.id));
}

/**
 * 子 → 父 的邻接表(一次遍历建好,免得每个根各扫一遍全部工作项)。
 *
 * 树形是**数据**上的关系(`works.parent_work_id`,migration 007),不是内存里的
 * 级联状态 —— 所以重启之后子树判据照样算得出来。
 */
function childrenByParent(works: readonly WorkRow[]): ReadonlyMap<string, WorkRow[]> {
  const map = new Map<string, WorkRow[]>();
  for (const w of works) {
    if (w.parentWorkId === null) continue;
    const kids = map.get(w.parentWorkId);
    if (kids === undefined) map.set(w.parentWorkId, [w]);
    else kids.push(w);
  }
  return map;
}

/** 整棵子树(含 `root` 自己)。广度优先,顺序稳定(按 `works` 的 `created_at` 序)。
 *
 * `seen` 不是优化而是**终止条件**:`parent_work_id` 上的环今天没有校验(它是数据,
 * 不是 `work_deps` 的那张表),一个环会让「算子树」永远不收敛 —— 而它挂在排空的
 * 每个 tick 上。环里的节点只算一次,规则照常给出答案(宁可少叫一次,不能挂住进程)。 */
function subtreeOf(root: WorkRow, children: ReadonlyMap<string, WorkRow[]>): WorkRow[] {
  const out: WorkRow[] = [root];
  const seen = new Set<string>([root.id]);
  for (let i = 0; i < out.length; i++) {
    for (const kid of children.get(out[i]!.id) ?? []) {
      if (seen.has(kid.id)) continue;
      seen.add(kid.id);
      out.push(kid);
    }
  }
  return out;
}

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

  const works = listWorks(db, projectId);
  const deliverables = listArtifacts(db, projectId, {
    kind: "deliverable",
    // 上界调到 `listArtifacts` 允许的最大值:这条查询是**全项目**的,漏掉一条
    // 就意味着「明明整合过了却又被叫醒一次」(而反向漏掉 = 永远不叫)。
    limit: 500,
  });

  /**
   * 派给**非执行角色**(或负责人已不存在)的**非终态**工作项 ——
   * `fix_stranded_assignment` 的判据。它与成员无关,所以按项目算一次;
   * 角色条件留在规则里。
   */
  const strandedWorks = works.filter((w) => {
    if (isTerminalWorkStatus(w.status)) return false;
    const a = getAgent(db, w.assigneeAgentId);
    return a === null || !isExecutorRole(a.role);
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
    works,
    deliverableWorkIds: new Set(
      deliverables.map((a) => a.workId).filter((id): id is string => id !== null),
    ),
    awaitingClient: listArtifacts(db, projectId, {
      kind: "client_question",
      status: "open",
      // 与交付物那两条查询同一条理由:漏一条 = 判据反过来(把「在等甲方」读成
      // 「没人在等」⇒ 多叫醒一次;或把「没人在等」读成「在等」⇒ 静默少叫一次)。
      limit: 500,
    }).length > 0,
    unconsumedClientAnswers: listUnconsumedClientAnswers(db, projectId),
    blockedByBlockerWorks: worksWithUnresolvedBlocker(db, projectId),
    acceptedDeliverables: listArtifacts(db, projectId, {
      kind: "deliverable",
      status: "accepted",
      limit: 500,
    }),
    deliveredArtifactIds: deliveredArtifactIds(db, projectId),
    reportBatchSize: opts.reportBatchSize ?? DEFAULT_REPORT_BATCH_SIZE,
    reportMaxDelayMs: opts.reportMaxDelayMs ?? DEFAULT_REPORT_MAX_DELAY_MS,
    projectStatus: getProjectRow(db, projectId)?.status ?? "draft",
    nonTerminalWorkCount: works.filter((w) => !isTerminalWorkStatus(w.status)).length,
    unresolvedBlockerCount: listBlockers(db, projectId, { unresolvedOnly: true }).length,
    projectGoal: getProjectRow(db, projectId)?.goal ?? "",
    // 查库的活在这里做完:规则拿不到 db(见 `RuleFacts` 的注释)。
    // 结论按工作项**一次查全**(`latestVerdictsByWork`),不逐条查 —— 逐条查会让
    // 每个 tick 的查询数随工作项数线性长。
    reworkPending: collectReworkPending(db, projectId, works, latestVerdictsByWork(db, projectId)),
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
        `下面这些工作项的负责人**不是执行角色**(${EXECUTOR_ROLES.join(" / ")}),` +
        "而平台只让执行角色跑工作项 —— " +
        "它们会永远停在原地。\n\n" +
        renderStrandedWorks(db, todo) +
        `\n\n用 \`work_assign\` 把它们改派给执行角色(或者用 \`work_update\` 关掉不该存在的),` +
        "然后在同一条回复里说明你怎么处置的。"
      );
    case "recover_failed_work":
      // ⚠️ 同 `resolve_blocked_work` 那一段的性质:判据只在 `RULES` 里有
      // 一处,这里说的是「**重划范围**」时你有哪些动词可用。
      return (
        "# 现在轮到你了:有工作项失败了,需要重新划范围\n\n" +
        "下面这些工作项**停在 `failed`**。`failed` 是**终态**,所以执行待办" +
        "(`execute_work` 只看 `open|in_progress`)**永远不会再捡起它们** ——\n" +
        "依赖它们的下游也一条都开不了工。**没有任何人会替你处理它们**,\n" +
        "而「零待办」与「组织已经把活干完了」在日志里长得一模一样。\n\n" +
        renderFailedWorks(db, todo) +
        "\n\n⚠️ **不要原样重跑。** 一条工作项被打成 `failed` 通常是因为它**一次" +
        "做不完**(真机现场:合并 7 份报告的那条,单回合读进去 10.9 万 token、" +
        "撞上墙钟上界被打断)。原样复活再跑一次会**同样超时** —— 那不是恢复," +
        "那是把同一段卡死再买一遍。\n\n" +
        "**平台允许你走的只有这两条路**(`failed` 在迁移表里只有这两个出边," +
        "别的会被 `work_update` 直接拒掉并回灌合法出边):\n\n" +
        "**① 拆小(推荐,绝大多数情况该走这条)**\n" +
        "- 用 `work_create` 建 2–4 条**更窄**的工作项,每条一个明确的子问题 —— " +
        "判据是「一条能在一个回合里做完」,不是「一条听起来完整」。\n" +
        "- 建完把这条**退役**:`work_update` 把它的 `status` 改成 `cancelled`" +
        "(它已经被取代了,不是还要做)。\n" +
        "- ⚠️ **不改掉它就是没做完**:`failed` 会一直停在那儿,系统会一遍遍" +
        "来问你,而真正该干的活已经没人推了。\n\n" +
        "**② 复活重试(只在失败原因确实是偶发时才用)**\n" +
        "- `work_update` 把 `status` 改成 `in_progress`,它就回到执行待办里。\n" +
        "- ⚠️ **平台不记录失败原因**,所以这个判断只能你来做:目标过大、" +
        "一个回合做不完 ⇒ 走 ①;外部依赖抽风、偶发 ⇒ 走 ②。判错会再失败一次," +
        "而系统只给有限的几次机会,之后会**公开报出「重新划范围的尝试已用尽」**," +
        "不会静默停在那儿。\n\n" +
        "**处置完要在回复里说清**:哪几条被拆成了什么、哪条被关掉了、为什么。"
      );
    case "resolve_blocked_work":
      // ⚠️ **这一段是「`blocked` 该怎么处置」的第二次陈述吗?** 不是 ——
      // 它是**平台判据的引用**:下面列出的每条工作项都是平台从库里查出来的
      // (`works.status='blocked'`),而这里说的是「你有哪几个动词可用」。
      // 判据本身在 `RULES` 的 `resolve_blocked_work` 里,只有一处。
      return (
        "# 现在轮到你了:处置被阻塞的工作项\n\n" +
        "下面这些工作项**停在 `blocked`**,而它们在挡着后面的活 —— " +
        "依赖它们的工作项一条都开不了工。**没有任何人会替你处理它们**:\n" +
        "`blocked` 不在执行待办里(`execute_work` 只看 `open|in_progress`),所以卡住的\n" +
        "不是某一个回合,而是整个项目 —— 待办会变成空的,而「空待办」与「组织已经把活\n" +
        "干完了」在日志里长得一模一样。\n\n" +
        renderBlockedWorks(db, todo) +
        "\n\n**逐条处置**(阻塞不是一种状态,是一件需要决定的事):\n\n" +
        "1. 用 `blocker_read` 看它挂着的阻塞现场 —— `detail` 里写着「需要谁做什么决定」\n" +
        "2. 判它属于哪一种,然后动手:\n" +
        "   - **依赖边配错了**(例如下游指向了被取消的那一份)→ `work_update` 改 `dependsOn`\n" +
        "   - **派错了执行角色** → `work_assign` 改派(负责人**只能是执行角色**:" +
        ` ${EXECUTOR_ROLES.join(" / ")};\`work_create\` /` +
        " `work_assign` 的调用期门都拒收别的角色)。⚠️ 容器(有子项的工作项)**不需要**归属正确" +
        " —— 它不由执行者跑,所以「容器派给了执行角色」**不是**要修的东西\n" +
        "   - **阻塞已经解决** → `blocker_update` 落 `resolved`(必须写 `resolution`)," +
        "再把工作项挪回 `open` / `in_progress`:**不挪回去它永远不会被跑**\n" +
        "   - **只有甲方能解**(缺数据 / 凭据 / 权限 / 决策)→ `ask_role` 让业务经理去问甲方。" +
        "**不要**替甲方假设答案,也不要自己承诺一个没有依据的期限\n" +
        "   - **这块范围不要了** → `work_update` 置 `cancelled`(取消 = 收口,不是失败)\n" +
        "3. 处置完在**同一条回复**里说清每条的去向 —— 下一 tick 平台会重新查库\n\n" +
        "**不要自己动手做这些工作项里的活** —— 你不持 `code.*`,执行是执行角色的事。"
      );
    case "decompose_project":
      return (
        "# 现在轮到你了:把项目拆成工作项\n\n" +
        "项目刚立起来,**一个工作项都还没有**。这是你的第一件事。\n\n" +
        "1. 先 `board_list` 看黑板上有没有人已经做过什么(重复规划是最贵的错误)\n" +
        "2. 用 `work_create` 拆出**能各自独立开工**的工作项;每个都给负责人与" +
        "**可验证的判据**,依赖关系用 `dependsOn` 显式写出来\n" +
        `   —— 负责人只能是**执行角色**:${EXECUTOR_ROLES.join(" / ")},别的角色不执行工作项\n` +
        "   —— **这两个角色的区别是「要交出什么东西」,选错不会报错,只会产出错的东西**:\n" +
        "     · `research_worker`(研究员)→ 交**信息**:技术方案 / 架构图 / 调研结论 /\n" +
        "       汇报材料。落点是 `board_write(kind='deliverable', deliverableType='html_report')`\n" +
        "     · `coding_worker`(工程师)→ 交**能跑的东西**:一份可独立部署到 Docker 的代码服务\n" +
        "       (git 仓库 + Dockerfile)。落点是 `board_write(kind='deliverable',\n" +
        "       deliverableType='code_service')`\n" +
        "     一条工作项**只交一种**:要报告就派研究工,要代码就派编码工;\n" +
        "     两者都要时拆成两条,别让一个角色去做另一个角色的产物\n" +
        "   多件产出同属**一个交付物**时,用 `parentWorkId` 把它们挂到一条根工作项下面\n" +
        "   —— 中间工作项的完成只对项目内部可见,整个交付物收口才向甲方交代一次\n" +
        "3. 拆完**不要自己动手做** —— 你不持 `code.*`,执行是执行角色的事\n\n" +
        "工作项一旦建出来,对应角色的执行者会被自动唤醒去跑它们 —— 你不需要再去催。"
      );
    case "review_work":
      return (
        "# 现在轮到你了:审查刚完成的产出\n\n" +
        renderPendingReviews(db, todo) +
        "\n\n用 `board_list` / `work_read` 核实:**目标达成了吗?依据能复核吗?边界越了吗?**\n\n" +
        // ⚠️ **判据的优先级**(2026-10-06 真机事故的修复)。这段不是提醒,是**纠偏**:
        // 上面那段渲染里现在摆着两层靶子(`projects.goal` 与 `works.goal`),而质检
        // 此前拿到的是「一份 brief」—— 真机原文是「严格按整改 work_brief 的硬约束
        // 执行,4 条判据全部满足」,而甲方明确否掉过「七份子文档」这个形态。
        // **brief 可以定义「怎么做」,不能定义「做成什么」**。
        "**判据按这个优先级来,不许倒过来**:\n\n" +
        "1. **这条工作项的 `goal`**(上面已给)—— 它是这条产出的**靶子**\n" +
        "2. **项目的 `goal`**(上面已给)—— 用来判「这一条是不是在为总靶子服务」\n" +
        "3. work_brief / 整改要求 —— **只定义「怎么做」**\n\n" +
        "⚠️ **若 3 与 1 或 2 冲突,以 1 / 2 为准,并把冲突原样写进 `review_finding`** —— " +
        "不要拿 brief 覆盖 goal,也不要因为「brief 做到了」就判通过。" +
        "2026-10-06 那次就是「brief 把『一份』定义成一份目录,于是甲方要的『一份』" +
        "在验收环节凭空消失了」—— 那个洞就是这一条补的。\n\n" +
        "然后做两件**都必须**做的事:\n\n" +
        "1. 把结论写成 `review_finding` 工件 —— **通过也要写通过的依据**" +
        "(「我核对了 X、Y、Z」),「过了」两个字在事后没有任何价值\n" +
        "2. **调 `review_verdict` 报出结论**(`workId` / `verdict` / `severity`;" +
        "有审查意见工件就一并给 `findingArtifactId`)\n\n" +
        "⚠️ **第 2 步不是可选项**:平台**只认这个调用**,不读你写的正文。" +
        "不给结论 ⇒ 平台不认为你审过了,这条产出会被**重新交给你审**。" +
        "而 `verdict='fail'` 会让平台把这份产出**退回给写它的人**返工" +
        "(判据是产出边上的作者,不是工作项的负责人;这条工作项一份产出都没有时交给项目经理;" +
        `同一件事到第 ${REWORK_ESCALATE_ROUND} 轮会换人)—— ` +
        "所以判 fail 之前先问一句:是「目标没达成」还是「形式没对齐」?" +
        "后者若不影响可用性,判 fail 会让整轮白跑。\n\n" +
        "**两份不是一回事**:工件是给人看的现场,`review_verdict` 是给机器读的判据。" +
        "只有前者的话,平台分不清「通过」与「不通过」—— 那正是 2026-10-06 那次" +
        "「质检判了不通过、平台却标成已审」的根因。"
      );
    case "rework": {
      // ── 「返工包」:质检结论 + 上一轮的产出 id,**一个字的正文都不搬** ──
      //
      // 用户裁决(2026-10-08):「质检包(质检结论 + 原工件 id,不要重复原文,否则浪费)」。
      // 现场从库里**现查**(待办只带 id),与 `collectTodos` 的判据**同一个函数** ——
      // 在这里另写一份「谁在等返工」就是两份定义。
      const workId = todo.refs[0];
      const pending = workId === undefined
        ? undefined
        : pendingReworkOfProject(db, todo.projectId).find((p) => p.workId === workId);
      if (pending === undefined) {
        // 现场与待办不一致(常见原因:这条工作项刚有人交了新产出 ⇒ 它已经不在等返工了)。
        // **不编一套现场**:如实说平台此刻查到的形状,让模型自己 `work_list` 看。
        return (
          "# 现在轮到你了:返工\n\n" +
          "平台刚查了一遍库:这条工作项**此刻已经不在等返工了**" +
          "(有人交过新产出,或者它的最新结论不再是「不通过」)。\n\n" +
          "先用 `work_list` / `board_list` 看清现状,再决定要不要动手 —— " +
          "**别凭这条待办的标题猜内容**:它可能已经过期了。"
        );
      }
      const members = loadProjectRoster(db, todo.projectId)
        .flatMap((m) => (isProjectRole(m.role) ? [{ agentId: m.id, role: m.role }] : []));
      const owner = reworkOwner(pending, members);
      const work = getWork(db, pending.workId);
      const kids = work === null
        ? []
        : childrenByParent(listWorks(db, todo.projectId)).get(pending.workId) ?? [];
      return [
        renderReworkPacket(pending, owner?.reason ?? "author"),
        // 容器(`有子项`的那种根)额外把子树摆出来:**它要交的是这条工作项自己的
        // 那份产出**,而不是把子项重写一遍 —— 真机上缺的正是「一份整合稿」。
        ...(kids.length > 0
          ? [
              "",
              "## 这条工作项底下有什么(它是容器,要交的是**它自己**那份产出)",
              "",
              renderSubtrees(db, todo),
            ]
          : []),
      ].join("\n");
    }
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
    case "integrate":
      // ⚠️ **这一段是 `deliverable` 这个 kind 的「什么时候写」**(C3 的另一半)。
      //
      // 为什么写在**这里**而不是只写在 `harness/system_prompts/project_manager.core.md`:
      //   - `board_write` 的 kind 描述是**派生**的(`ARTIFACT_KINDS.join(" | ")`),
      //     所以项目经理**看得见** `deliverable` 这个名字,却没有任何地方告诉它
      //     「整合完子树后要写一条」。这一支正是那个「什么时候」。
      //   - 这条通道是 **user message**,而本项目自己认定 recency 比 system prompt
      //     强(= §9.4 的教训:`decompose_project` 里那句「用 parentWorkId 建树」
      //     就写在这里);它只在**真被叫醒整合**的那一个回合出现,不占别处的 context。
      //   - 它同时**引用了平台判据**(③ 靠 `workId` 挂边):不写清这一点,模型很
      //     容易写一条不挂边的交付物 —— 那时 `if` 仍然成立,规则会一直叫到预算用尽,
      //     而表现只是「系统跑过很多次」(静默失败的一种)。
      return (
        "# 现在轮到你了:整合这条交付\n\n" +
        "下面这些交付的工作项**都已经跑完并审过了**,流水线停在这里等你整合。\n\n" +
        renderSubtrees(db, todo) +
        "\n\n**怎么整合**:\n\n" +
        "1. 用 `board_list`(传 `workId` = 每条子项)**逐条读**它们的产出 —— " +
        "整合是收敛,不是复述:甲方的诉求、结论、依据、还剩什么没解决,收成一份能独立读懂的东西\n" +
        "2. **每一份交付各写一条**交付物,用 `board_write`:\n" +
        "   - `kind` 用 **`deliverable`**\n" +
        // ⚠️ **2026-10-07 加的一条**(migration 025)。`deliverableType` 是**必填**的,
        // 缺了平台直接拒收 —— 所以这一句不是「建议」,它是「不写就写不进去」。
        // 为什么放在**这条 user message** 里而不是只写进
        // `harness/system_prompts/project_manager.core.md`:同 §9.4 的教训 ——
        // 那条通道 recency 比 system prompt 强,而它**只**在真被叫醒整合的
        // 这一次出现,不占别处的 context。
        "   - `deliverableType` 用 **`html_report`**(**必填,不传平台会拒收**):" +
        "交付物必须声明自己是哪种类型,而当前只有这一种 —— " +
        "凡是**只有信息交付**的东西(技术方案 / 架构图 / 汇报材料 / 评审结论 / 说明书)都归它\n" +
        "   - `body` 因此是**一份 HTML 文档**,不是 markdown:甲方在界面上点开它" +
        "看到的是一个渲染好的网页。用**内联 `<style>`**,**架构图 / 流程图用内联 SVG**," +
        "**不要写 `<script>` / `<iframe>`**(平台在禁用脚本的沙箱里渲染,写了就是一片空白)," +
        "不要外链样式表或字体,控制在 512 KiB 以内\n" +
        "   - `workId` **必须显式传那条根工作项的 id**:" +
        "平台判「这条交付整合完了没有」看的**就是**「这条根工作项上有没有 `deliverable` 工件」——" +
        "不传 `workId` 的话这条待办会**一直重新出现**,直到把尝试预算烧完\n" +
        "   - `status` 用 **`accepted`**:交付那一环的资格判据是「已验收的交付物」," +
        "写成 `open` 交付就不会被触发(而工件状态写完之后**改不了**,只能重写一条)\n" +
        "3. 子项里的细节**不要**抄进来:交付物给甲方看,用 `links` 把依据指回那几条产出\n\n" +
        // ⚠️ **2026-10-06 真机补的一条**。它治的是「分章结论冒充最终交付」:
        //
        // 平台判「这条交付整合完了没有」只看**结构化事实**(根上有没有 `deliverable`),
        // 而它**分不清**你交的是「七份分章结论」还是「一份整合后的总稿」—— 2026-10-06
        // 的真机上,项目经理写了 7 份各 1–3KB 的分章结论挂到根上,平台立刻认为整合
        // 完成、根工作项自动收口;而甲方明确答复过要的是「一份」。
        // **这不是平台能推出来的结论,所以写成判据交给你。**
        "4. ⚠️ **看上面那条根工作项的 `goal`**:如果它要的是**一份东西**" +
        "(措辞含「整合 / 汇总 / 总稿 / 整体 / 最终交付 / 一份」),那么" +
        "**几份分章结论不算交付** —— 7 份 W1..W7 的结论挂在根上,平台会认为" +
        "「整合完了」,但甲方拿到的是 7 个文件而不是他要的那一个。\n" +
        "   这时你必须**在根上另写一份引用全部子项的总稿**:正文里逐条列出它整合了" +
        "哪几条、每一份的结论一句话,让甲方只读这一份就能做决定。\n" +
        "   ⚠️ 反过来,如果 `goal` 就是要**分章节给**(措辞含「每章 / 分别 / 各自」)," +
        "那就按分章交 —— **判据是这条 goal,不是这句提示词**。\n\n" +
        "**不要自己动手补做子项里的活** —— 你持 `work.update`(该关的关掉、该登记的阻塞登记)," +
        "但执行是执行角色的事。写完之后交付由业务经理接手,不需要你去催。"
      );
    case "handover":
      // 这一支只说**事实**与**职责**,不承诺平台行为:建交付会话是 C4 的活
      // (migration 017 + `ensureSession` 的显式通道),而这里的话必须在 C4 之前
      // 与之后都成立 —— 提示词许一个平台还没做的承诺,是最容易腐烂的一类文字。
      return (
        "# 现在轮到你了:把这份交付交代给甲方\n\n" +
        renderDeliverable(db, todo) +
        "\n\n这份交付物**已经验收**,而甲方**还没有收到它**。整合是项目经理的产物," +
        "你的职责是**交付与交代**:\n\n" +
        "1. 先 `board_read` 读它的正文 —— 你要交代的是它的**内容**,不是它的 id\n" +
        "2. 用你自己的话把它交代给甲方:交付了什么、依据是什么、甲方接下来能做什么、\n" +
        "   还剩什么没解决(有就直说,不要粉饰)\n" +
        "3. 甲方的追问用 `ask_client`(会等他回答)—— 不要自己假设他会怎么答\n\n" +
        "**不要在这里重新整合或改写它**,也不要替项目经理补做子项里的活。" +
        "你的价值在于**让甲方听懂这份交付**,不在于再写一份。"
      );
    case "resume_client":
      // 与 `report_downstream` 同纪律:**只把事实摆出来、说「你来判断」**。
      // 平台不下「现在去问下一项」这种命令 —— 那要么是判据的第二次陈述
      // (会与提示词单元里的规则漂),要么是在替模型做决定。
      return (
        "# 现在轮到你了:甲方答复了你的问题\n\n" +
        renderAnsweredQuestions(db, todo) +
        "\n\n甲方**已经答了**,而这些答复**还没有被你处置**。用 `board_read` 读每一条" +
        "答复的正文(`answers` 边指向它问的那条问题),然后:\n\n" +
        "1. 这个答复**改变了什么**?落成 `decision` 工件(有取舍的),别让它只活在对话里\n" +
        "2. 它**解开了**什么、又**新开了**什么?该往下走的往下走(下一次提问用 `ask_client`)\n" +
        "3. 它与你**先前告诉甲方的说法冲突**吗?冲突要当面说清,不要默默改口\n\n" +
        "**不要在没读答复正文的情况下凭标题作答** —— 甲方答的常常不是标题里那个问题。"
      );
    case "close_project":
      // 与 `resume_client` 同纪律:**摆事实、说你来判断**。
      // ⚠️ 平台**不自动关闭项目**:收口不可逆(`closeProject` 直接 `throw`),
      // 而「收不收口」是业务判断 —— §2.11.3 那条纪律在这里不是形式主义。
      return (
        "# 现在轮到你了:这个项目看起来做完了,该不该收?\n\n" +
        renderClosureReview(db, todo) +
        "\n\n**平台的判据已经全绿**:没有未完成的工作项、没有待审的产出、没有等你交代的" +
        "下游结果、没有等甲方的提问、没有未处置的答复、没有未解决的阻塞,所有已验收的" +
        "交付物也都交付过了。\n\n" +
        "**但平台不知道该不该收** —— 那是你的判断,不是一行 `status` 能推出来的。\n\n" +
        "**先回答自己一个问题:甲方要的东西,拿到了吗?** 对照上面那份 `goal` —— " +
        "不是「工作项都 done 了」,而是**那份 goal 要的东西真的在那里**。\n\n" +
        "然后二选一:\n\n" +
        "1. **确实做完了** → 用 `project_close`(`outcome: \"done\"`)收掉," +
        "并对甲方说清**最终交付物是哪几份**、它们在哪、怎么用。\n" +
        "   ⚠️ 这一步之前,那些交付物**已经在交付会话里了** —— 你要做的不是重发一遍," +
        "是给一个**收尾的结论**:做完了什么、依据是什么、接下来建议他做什么。\n" +
        "2. **还差东西** → **不要关**。用 `work_create` 把缺的那部分立成工作项" +
        "(能自己做的直接排上),或者用 `ask_client` 去问甲方要什么。" +
        "   平台下一次 tick 会重新查库;只要还有一件事没做完,这条待办就不成立。\n\n" +
        "⚠️ **关掉是不可逆的**:`closeProject` 对终态项目直接抛错,项目内能力随即全部失效" +
        "(只剩记忆与代码工具)。**拿不准就别关** —— 代价只是下一次 tick 再问你一遍;" +
        "关错的代价是整个项目作废。"
      );
    case "execute_work":
      // 执行角色那条不走这里 —— `runWorkItem` 自己拼 `composeWorkPrompt`。
      // 留着这一支是为了穷尽性:新增 TodoKind 时这里会编译失败。
      return "# 现在轮到你了:执行工作项\n";
  }
}

/**
 * 要整合的那些子树(查出来的现场:`id` / 标题 / 状态 / 审查态)。
 *
 * 只渲染**结构化的列**,不渲染正文 —— 与规则的 `if` 同一条纪律(§2.11.3):
 * 整合要收敛什么内容,是**它的判断**,平台只负责把「有哪些东西、都什么状态」摆出来。
 *
 * 一个回合可能覆盖**多条**交付(扁平结构下尤其如此):那时这个回合要**每一条**
 * 各写一份交付物 —— 而不是把几份交付揉成一份。
 */
function renderSubtrees(db: Database.Database, todo: DriverTodo): string {
  const works = listWorks(db, todo.projectId);
  const children = childrenByParent(works);
  const blocks: string[] = [];
  for (const id of todo.refs) {
    const root = getWork(db, id);
    if (root === null) continue;
    const subtree = subtreeOf(root, children);
    const kids = subtree.slice(1);
    blocks.push(
      [
        `### 交付 \`${root.id}\`「${root.title}」`,
        "",
        root.goal.trim() === ""
          ? "⚠️ 这条根工作项的 `goal` 是空的 —— 你无从判断它要的是「几份子结论」还是「一份总稿」。"
          : `**这条根工作项要达成什么**:${root.goal.slice(0, GOAL_HEAD_CHARS)}` +
            `${root.goal.length > GOAL_HEAD_CHARS ? "…" : ""}`,
        "",
        ...subtree.map((w) => `- \`${w.id}\`「${w.title}」[${w.status} · 审查 ${w.reviewState}]`),
        "",
        kids.length > 0
          ? `根工作项是 \`${root.id}\`,下面 ${kids.length} 条都属于它 —— ` +
            `交付物的 \`workId\` 传 \`${root.id}\`。`
          : `\`${root.id}\` 没有子项(扁平结构:它就是这条交付本身)—— ` +
            `交付物的 \`workId\` 传 \`${root.id}\`。`,
      ].join("\n"),
    );
  }
  if (blocks.length === 0) return "";
  return ["## 这回合要整合的交付(库里查出来的,不是猜的)", ...blocks].join("\n\n");
}

/**
 * 甲方刚答复完的那几个问题(查出来的现场:`id` / 标题 / 答复工件 id)。
 *
 * 只渲染**结构化的列**,不渲染答复正文 —— 与规则的 `if` 同一条纪律(§2.11.3)。
 * 答复正文必须由模型自己 `board_read`:平台把它摆出来,是为了让它知道
 * 「有几条、等了多久」,不是为了替它读。
 */
function renderAnsweredQuestions(db: Database.Database, todo: DriverTodo): string {
  const ledgers = getClientQuestions(db, todo.refs);
  const blocks: string[] = [];
  for (const id of todo.refs) {
    const q = getArtifact(db, id);
    if (q === null) continue;
    const row = ledgers.get(id);
    blocks.push(
      [
        `- \`${q.id}\`「${q.title}」` +
          (row?.answerArtifactId != null
            ? ` → 答复 \`${row.answerArtifactId}\``
            : " → **(库里没有答复工件 —— 这条要人工看一眼)**"),
        `  - 提问 ${q.createdAt} · 答复 ${row?.answeredAt ?? "?"} · 提问状态 ${q.status}`,
      ].join("\n"),
    );
  }
  if (blocks.length === 0) return "## 甲方答复了这些问题(库里查出来的)";
  return ["## 甲方答复了这些问题(库里查出来的,不是猜的)", ...blocks].join("\n");
}

/** 等着交付的那条工件(结构化列;正文由模型自己 `board_read`)。 */
function renderDeliverable(db: Database.Database, todo: DriverTodo): string {
  const a = todo.target === null ? null : getArtifact(db, todo.target);
  if (a === null) return "";
  return [
    "## 已验收的交付物(库里查出来的)",
    "",
    `- \`${a.id}\`「${a.title}」(${a.kind} · ${a.status} · 作者 ${a.authorAgentId})` +
      (a.workId !== null ? `\n- 挂在根工作项 \`${a.workId}\` 上` : "\n- 没有挂工作项(产出边为空)"),
  ].join("\n");
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

/** 目标正文的截断长度 —— 够判断「这条要达成什么」,又不把整个回合撑爆。 */
const GOAL_HEAD_CHARS = 400;

/**
 * 「等审的产出」那段渲染。
 *
 * ⚠️ **2026-10-06 真机修的一处洞:这里原来只渲染 `id` / `title` / `assigneeAgentId`。**
 *
 * 而 `review_work` 的任务正文问的是「**目标达成了吗?**」—— 判据在提示词里,
 * **达成目标的定义却不在这个回合的任何地方**。质检只能自己去翻,于是它翻到了
 * **项目经理写的整改 brief**,拿 brief 当判据。真机原文(2026-10-06 16:2x):
 *
 * > 「W0-A 严格按整改 work_brief 的『目录式引用 + 严禁复述/改写』硬约束执行,
 * > **4 条判据全部满足**」——
 * > 而甲方在同一天明确答复过:选 A「wk 补做」,**否掉了**「接受 7 份子文档」。
 *
 * brief 把「一份」定义成「一份目录」,质检对着 brief 判 pass,业务经理据此宣布
 * 「项目正式交付完成」。**甲方那句原始诉求没有任何一条机制携带到验收环节。**
 *
 * 现在渲染两层:
 *   - `projects.goal` —— 甲方立项时说的「要达成什么」(整个项目的靶子)
 *   - `works.goal`   —— 这一条工作项的靶子
 *
 * ⚠️ **两层都不能省**:只看 `works.goal`,一条「按 brief 写目录」的工作项照样能
 * 自洽地通过;**只有把项目的靶子摆出来,「这一条是不是在为总靶子服务」才可判**。
 * 两层都是**数据**(旧 pi 的 `Blackboard.goal` 是同一个思路),不是硬编码判据 ——
 * 谁都可以改,但**验收现场必须看得见**。
 */
/**
 * 「这个项目看起来做完了」那段渲染 —— 收口判定的**事实侧**。
 *
 * 只渲染**结构化的列**(`works.status` / `review_state` / 工件的 `kind`+`status`+
 * `title`)+ 两条 goal 正文。**不渲染任何工件正文** —— 与规则的 `if` 同一条纪律:
 * 「做完了没有」是业务经理的判断,平台只负责把「有哪些东西、都什么状态、
 * 最初要的是什么」摆出来。
 */
function renderClosureReview(db: Database.Database, todo: DriverTodo): string {
  const project = getProjectRow(db, todo.projectId);
  const lines: string[] = [];
  if (project !== null && project.goal.trim() !== "") {
    lines.push(
      "## 这个项目当初要达成什么",
      "",
      project.goal.trim(),
      "",
      "**这一句是收口与否的靶子** —— 下面那些工作项全 `done` 只是「过程收口」," +
      "不等于这一句被满足了。",
      "",
    );
  }
  const deliverables = todo.refs
    .map((id) => getArtifact(db, id))
    .filter((a): a is NonNullable<typeof a> => a !== null);
  if (deliverables.length > 0) {
    lines.push(
      "## 最终交付物(甲方手上就是这些)",
      "",
      ...deliverables.map(
        (a) => `- \`${a.id}\`「${a.title}」[${a.kind} · ${a.status}]`,
      ),
      "",
    );
  }
  const works = listWorks(db, todo.projectId);
  if (works.length > 0) {
    const byStatus = new Map<string, number>();
    for (const w of works) byStatus.set(w.status, (byStatus.get(w.status) ?? 0) + 1);
    lines.push(
      `## 工作项(共 ${works.length} 条):` +
        [...byStatus.entries()].sort().map(([s, n]) => `${s} ${n}`).join(" · "),
      "",
      "> 这些数字只说明**过程**收口了。它们**不能**代替上面那句 goal —— " +
      "真机上一次正是「11 条全 done、6 条审查全 pass、而甲方要的那一份并不存在」。",
      "",
    );
  }
  return lines.join("\n");
}

function renderPendingReviews(db: Database.Database, todo: DriverTodo): string {
  const rows = todo.refs
    .map((id) => getWork(db, id))
    .filter((w): w is NonNullable<typeof w> => w !== null);
  if (rows.length === 0) return "";
  const project = getProjectRow(db, todo.projectId);
  const lines: string[] = ["## 等着审的产出(库里 `review_state = 'pending'`)"];
  if (project !== null && project.goal.trim() !== "") {
    lines.push(
      "",
      `**这个项目要达成什么**(\`projects.goal\`,甲方立项时说的):`,
      "",
      project.goal.trim(),
    );
  }
  lines.push("");
  for (const w of rows) {
    const goal = w.goal.trim();
    lines.push(`- \`${w.id}\`「${w.title}」(${w.assigneeAgentId})`);
    lines.push(
      goal === ""
        ? "  **要达成什么**:⚠️ 这条工作项的 `goal` 是空的 —— 那就没有判据。"
        : `  **要达成什么**:${goal.slice(0, GOAL_HEAD_CHARS)}${goal.length > GOAL_HEAD_CHARS ? "…" : ""}`,
    );
  }
  return lines.join("\n");
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

/**
 * 被阻塞的工作项 + **它挂着的未解决阻塞**(查出来的现场:`id` / `severity` / 负责人)。
 *
 * 只渲染**结构化的列**,不渲染阻塞正文 —— 与规则的 `if` 同一条纪律(§2.11.3):
 * 「这条阻塞该谁修」是项目经理的判断,平台只负责把「有哪些东西」摆出来,
 * 并**明确标出**「一条阻塞都没登记」的那种情况(它是**最需要人看**的一种:
 * 说不出为什么卡住,而不是说清了在等谁)。
 */
function renderBlockedWorks(db: Database.Database, todo: DriverTodo): string {
  const lines: string[] = [];
  for (const id of todo.refs) {
    const w = getWork(db, id);
    if (w === null) continue;
    const a = getAgent(db, w.assigneeAgentId);
    const blockers = blockersForWork(db, id);
    lines.push(
      `- \`${w.id}\`「${w.title}」← 负责人 ` +
        `${a === null ? w.assigneeAgentId : `${a.displayName}(${a.role})`}` +
        (blockers.length > 0
          ? `;挂着 ${blockers.length} 个未解决阻塞:` +
            blockers.map((b) => `\`${b.id}\`[${b.severity}]`).join(" / ")
          : ";⚠️ **一条阻塞都没登记** —— 没人说得出它为什么 `blocked`"),
    );
  }
  return lines.join("\n");
}

/**
 * 失败工作项的现场(平台从库里查出来的,不是模型转述的)。
 *
 * ⚠️ **只列能查到的**:`works` 表上没有「为什么失败」那一列,也没有「谁在等它」。
 * 刻意**不猜**:「它为什么失败」不可查(§2.11.3:判据与现场都只读结构化的列),
 * 拿别的行的时间差去凑一个「停了多久」是**印一行看起来正常的错数字** ——
 * 试过一版用「最后一条消息的时间」当「此刻」,而那可能偏几小时。
 */
function renderFailedWorks(db: Database.Database, todo: DriverTodo): string {
  const lines: string[] = [];
  for (const id of todo.refs) {
    const w = getWork(db, id);
    if (w === null) continue;
    const a = getAgent(db, w.assigneeAgentId);
    lines.push(
      `- \`${w.id}\`「${w.title}」← 负责人 ` +
        `${a === null ? w.assigneeAgentId : `${a.displayName}(${a.role})`}` +
        `;状态 \`${w.status}\`、审查 \`${w.reviewState}\``,
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
  /**
   * **拒绝执行**(不是失败):待办本身不该被跑(例如工作项已是终态、负责人不是执行角色)。
   *
   * ⚠️ 与 `failed` 分开是有理由的:两者在界面上都表现为「这一次没成」,但**原因与
   * 该做什么**完全不同 —— 失败要重试 / 要人看,拒绝说明**判据漏了一条**(为什么
   * 会派一条不该跑的待办)。宿主侧由 `runWorkItem` 的 `checkRunnable` 产出
   * (`ExecutionResult.refusalReason`),在这之前它**只体现在日志里**。
   */
  readonly refused?: boolean;
  /**
   * 这一次没跑起来的一句话现场(拒绝理由 / 抛错信息)。**没有就 `null`/省略**——
   * 7-N:空转的那几次必须事后看得出「当时是什么状况」,而不是只有一行「失败了」。
   */
  readonly detail?: string;
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
  /**
   * 跑一个非执行类的 agent 回合(宿主负责建会话 / 桥事件 / 落库)。
   *
   * ── `todoKind`:为什么它是**形参**而不是宿主自己猜的(W2-③)──────────
   *
   * 宿主要把「这一轮为什么存在」写进 `message_start` 的 `trigger`
   * (`{ kind: "todo", todoKind }`,见 `shared/types/platform.ts` 的 `TurnTrigger`)。
   * 而 `drainProject` 是**唯一**同时持有「待办」与「回合」的地方 ⇒ 这个值
   * **只能**在这里跨过边界。宿主侧没有第二个合法来源:它拿到的是
   * `(agentId, task)`,而同一个 agent 既可能被用户消息叫醒(`business_manager`),
   * 也可能被 `answer_ask` / `report_downstream` / `handover` 叫醒 —— 从
   * `agentId` 反推 trigger 会得到一个「看起来对、换一个场景就错」的值,
   * 而错了的表现是**工件触发的回合正文被当成对甲方说的话**进对话页(静默判错)。
   *
   * ⚠️ **不是 `string`,是 `TodoKind`** —— 漏传 / 拼错必须编译不过。
   */
  readonly runAgentTurn: (
    agentId: string,
    task: string,
    todoKind: TodoKind,
  ) => Promise<DrainTurnReport>;
  /**
   * 跑一个工作项(宿主走 `runWorkItem`)。`todoKind` 的理由与
   * {@link DrainDeps.runAgentTurn} 逐字相同:值**只能**从这里的 `todo.kind`
   * 跨过去。⚠️ 这一支在**今天**恒为 `"execute_work"`(调用点是下面那条
   * `if (todo.kind === "execute_work")`),但那正是「今天恰好是个常量」而不是
   * 「它是一个常量」—— 传**真值**而不是写字面量,改判据时才不会漏掉这一处。
   */
  readonly runWork: (
    agentId: string,
    workId: string,
    todoKind: TodoKind,
  ) => Promise<DrainWorkReport>;
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

/**
 * 一次派发的结局。**这是「8 个回合」那条告警里唯一能分辨真假的东西。**
 *
 * 2026-10-05 真机现场:一条 `max_rounds` 告警写着「8 个 agent 回合」,而 8 次派发里
 * **只有 2 个真回合** —— 另外 6 次在 33 ms 内返回,四个角色的 SDK 会话里连一条
 * prompt 记录都没有(既没花钱,也没干活)。根因是计数写成了「派发次数」而文案写成
 * 了「agent 回合」。所以结局必须逐条记下来:它同时是给用户看的现场(见
 * `formatIdleTrail`)与给下一个改判据的人看的账。
 */
export type DispatchOutcome =
  /** 真的叫醒了一个 agent(它跑了;跑成什么样是 `DrainTurnReport` 自己的事) */
  | "ran"
  /** 待办被拒绝执行 —— `runWorkItem` 的 `checkRunnable` 判它不该跑(没调模型) */
  | "refused"
  /** 派发了但没跑起来(建会话失败 / 抛错 / 回合成败未知) */
  | "failed";

export interface DrainVisit {
  readonly agentId: string;
  readonly kind: TodoKind;
  readonly label: string;
  /** 这一派发有没有真的跑起来 —— 见 {@link DispatchOutcome} */
  readonly outcome: DispatchOutcome;
  /** 拒绝/失败时的一句话现场(跑起来了就是 `null`) */
  readonly detail: string | null;
}

/**
 * 空转派发的清单(纯函数,`announceDrain` 与测试共用)。
 *
 * 「空转」= 派发出去但没叫醒任何 agent。**必须让它们出现在告警里**:它们是
 * 「预算花在哪了」的答案,而这正是那条 `max_rounds` 告警存在时用户第一个会问的问题。
 *
 * `limit` 之外的那些折成一行计数 —— 项目大了可能出现几十次空转,整段铺上去
 * 会把真正的信息(停了 / 还有活在)淹掉。折叠**不静默**:折几条写在那一行里。
 */
export function formatIdleTrail(
  visited: readonly DrainVisit[],
  limit = 6,
): readonly string[] {
  // 序号取**派发次序**(`i + 1`),这样告警里的「第 3 次」能与 `本轮路径` 和日志对上。
  // 不要用 `indexOf` 反查:那既慢又依赖「对象不复用」这个没写在类型里的前提。
  const idle: Array<{ readonly v: DrainVisit; readonly n: number }> = [];
  visited.forEach((v, i) => {
    if (v.outcome !== "ran") idle.push({ v, n: i + 1 });
  });
  if (idle.length === 0) return [];
  const lines = idle.slice(0, Math.max(limit, 0)).map(({ v, n }) => {
    const why = v.detail !== null && v.detail !== "" ? `:${v.detail}` : "";
    return `  · 第 ${n} 次 ${v.agentId} · ${v.kind} —— ${v.outcome === "refused" ? "被拒" : "没跑起来"}${why}`;
  });
  if (idle.length > lines.length) {
    lines.push(`  · 另有 ${idle.length - lines.length} 次同类空转(同上,不再逐条展开)`);
  }
  return lines;
}

export interface DrainResult {
  readonly projectId: string;
  /**
   * **派发次数**(= attempts)。⚠️ 它**不是**「真跑起来的回合数」:
   * 拒绝执行与建会话失败都算一次派发却不叫醒任何 agent。真回合数见 `turns`。
   *
   * 名字保留 `rounds` 是刻意的:里里外外(CLI 上界、`stopDetail`、历史告警文案、
   * 既有测试)都用它,改名只会制造一次无声的口径漂移。
   */
  readonly rounds: number;
  /** 其中**真的叫醒了一个 agent** 的次数(`outcome === "ran"`)。`turns ≤ rounds` */
  readonly turns: number;
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
 * 它**不发 WS 事件、不写会话消息** —— 那两件事由宿主提供的回调负责(谁来跑回合、
 * 事件怎么桥到前端)。这样这个循环可以在没有任何 provider / 网络的情况下被穷举
 * 测试(见 `tests/platform/dispatcher.test.ts`),而「会不会失控」这条最要紧的
 * 性质也因此是**可测的**而不是「看起来应该会停」。
 *
 * ⚠️ **C4 之后它确实会建一条会话行**(`handover` 成功后的第三支,见下面消费块),
 * 所以旧句「它不建会话」已经为假 —— 留着它就是一句会腐烂的注释。建会话与
 * 「跑一个 agent 回合」「把消息落库」是两类动作:前者是**平台记账**(与
 * `markWorkReviewed` / `consumePendingDispatchEvents` 同一类,都是「这件事办过了」
 * 的落库),后者才是宿主的事。判据因此仍然可以在这一个函数里被穷举测试。
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
  /** 其中**真的叫醒了一个 agent** 的次数(见 `DispatchOutcome`) */
  let turns = 0;
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
      // ⚠️ 文案必须带**两个数**:这个上界数的是**派发次数**,而「派发」不等于
      // 「叫醒了一个 agent」(2026-10-05 真机:8 次派发里只有 2 个真回合)。
      // 只报一个数会让人以为「组织跑了 8 个回合还没干完」——那是**假现场**。
      stopDetail =
        `已达单次排空上限 ${maxRounds} 次派发(其中 ${turns} 个真回合),仍有待办没跑完 —— ` +
        `已停下(不是静默停:这条会广播并落库)`;
      break;
    }

    // ── 平台记账(丙②):把**已经整合完**的容器收口 ────────────────────
    //
    // 放在查待办**之前**,而且每一轮都查一次(纯查询,没有跨调用状态):
    //   - 「判据是库里的工件」⇒ 它必须是声明式的,不是某个回合的副产品 ——
    //     「整合那个回合成功之后再写」会漏掉**产出边挂在子项上**的整类现场。
    //   - 先收口再查库,新终态的根这一轮就能点亮它的 `review_work`(质检那一条),
    //     不必等下一个 tick。
    //   - 收口本身不占 `maxRounds` 的配额:它是平台的账,不是一个 agent 回合。
    //
    // ⚠️ **2026-10-07 起它跳过所有「在等返工」的根**。原因就是这条修复要治的那个
    // 8 秒循环:质检判 fail 会把那条根退回 `in_progress`,而这条收口的判据
    // (「子项全终态且已审」)对它**照样成立** ⇒ 于是它被立刻收口成 `done`,
    // 质检再审**同一份没变的东西**(真机连审三轮,`dispatch_events` 里 4 条一字不差
    // 的「已完成」)。「刚被退回、还没人返工」这件事在库里就是
    // `pendingReworkOfProject`,所以抑制条件与 `rework` 那条规则**同一个判据**。
    const reworkIds = new Set(
      pendingReworkOfProject(deps.db, deps.projectId).map((p) => p.workId),
    );
    for (const id of closeIntegratedContainers(deps.db, deps.projectId, deps.now(), deps.log, reworkIds)) {
      deps.log(
        `dispatcher: 容器 ${id} 已收口 → done(它的交付整合完了);` +
          "等一下质检会按 review_work 审这条整合产物",
      );
    }

    // ── 平台记账(021 的消费侧):**已经判过 `pass` 的产出,标成已审** ──────
    //
    // ⚠️ **2026-10-07 真机死锁的直接修复。** 判据与消费点原本不同源:
    // `markWorkReviewed` 的判据在 021 之后翻成了「存在一条 pass 结论」,
    // 而消费动作仍绑在**回合类型**上(`todo.kind === "review_work"`)⇒
    // pass 写在任何别的回合里都不会被消费。真机现场:质检在 `answer_ask` 回合里
    // 判了「通过」(17:09:18),而那条 `review_work` 的尝试预算已经 3/3 用尽 ⇒
    // **那个回合再也不会发生** ⇒ `review_state` 永远是 `pending` ⇒
    // `close_finished_project` 要求「待审产出 = 0」⇒ 项目永远收不了口,
    // 而且因为预算用尽只播报一次,**连告警都没有**(静默死锁)。
    //
    // 修法与上面那条收口**同一条纪律**:「这件事办过了没有」永远重新查库,
    // 声明式、幂等、重启后补跑 —— 与「哪个回合办成的」彻底解耦。
    for (const w of listWorksPendingReview(deps.db, deps.projectId)) {
      if (latestReviewVerdict(deps.db, w.id)?.verdict !== "pass") continue;
      markWorkReviewed(deps.db, w.id, deps.now());
      deps.log(`dispatcher: ${w.id} 已判通过 → 标成已审(review_state='done')`);
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
    // 先记一条「还不知道结局」的 visit(这一行的位置就是派发次序),跑完再把结局写回去
    // —— 日志行要在回合**开始之前**出来(一个回合可能跑十几分钟,先有行才看得出它在跑)。
    visited.push({
      agentId: todo.agentId, kind: todo.kind, label: todo.label,
      outcome: "ran", detail: null,
    });
    const visitAt = visited.length - 1;
    deps.log(
      `dispatcher: 第 ${rounds}/${maxRounds} 次派发 → ${todo.agentId}(${todo.role}) · ${todo.label}`,
    );
    // **先记账再跑**:进程在回合中途被杀死也算用掉一次预算 ——
    // 否则「每跑必崩」的待办会无限重试。
    const attempts = bumpAttempt(deps.db, {
      projectId: deps.projectId, todoKey: todo.key, targetState: todo.targetState, at: deps.now(),
    });
    if (attempts > 1) deps.log(`dispatcher: 这条待办第 ${attempts}/${maxAttempts} 次被叫醒`);

    let aborted = false;
    let failed = false;
    let refused = false;
    let detail: string | null = null;
    try {
      if (todo.kind === "execute_work") {
        if (todo.target === null) {
          // 不该发生:execute_work 一定带 target。硬失败而不是猜一个工作项。
          stopReason = "no_progress";
          stopDetail = "execute_work 待办没有带工作项 id —— 装配错误,已停下";
          break;
        }
        const r = await deps.runWork(todo.agentId, todo.target, todo.kind);
        aborted = r.aborted;
        failed = r.failed === true;
        refused = r.refused === true;
        detail = r.detail ?? null;
      } else {
        const r = await deps.runAgentTurn(todo.agentId, renderTask(deps.db, todo), todo.kind);
        aborted = r.aborted;
        failed = r.failed === true;
        refused = r.refused === true;
        detail = r.detail ?? null;
      }
    } catch (err) {
      // 一次回合抛错**不该**让整个排空炸掉 —— 后面可能还有别的角色能动。
      // 但要留现场:日志里写清是谁、哪个待办、什么错。
      failed = true;
      detail = err instanceof Error ? err.message : String(err);
      deps.log(
        `dispatcher: ✖ ${todo.agentId} 的「${todo.label}」抛错 —— ${detail}`,
      );
    }

    // ── 结局:这一次派发有没有**真的叫醒一个 agent** ──────────────────
    //
    // ⚠️ 这一段是 2026-10-05 那条「8 个回合」告警的直接产物。当时 8 次派发里 6 次
    // 在 33 ms 内返回、库里零痕迹,而文案写成「8 个 agent 回合」——**假现场**。
    // 现在:①结局进 `visited`(谁被叫醒过、谁没有);②没跑起来的那几次各留一行
    // 日志(不只在 WS 上闪一下);③`turns` 与 `rounds` 一起进 `DrainResult`,
    // 由宿主写进告警文案。
    const outcome: DispatchOutcome = refused ? "refused" : failed ? "failed" : "ran";
    if (outcome === "ran") turns++;
    else {
      visited[visitAt] = {
        agentId: todo.agentId, kind: todo.kind, label: todo.label, outcome, detail,
      };
      deps.log(
        `dispatcher: ✖ 第 ${rounds} 次派发没跑起来(${outcome})—— ` +
          `${todo.agentId} · ${todo.label}` +
          (detail !== null && detail !== "" ? `:${detail}` : ""),
      );
    }

    // ── 消费:只有回合**成功结束**才算「这件事办过了」 ──
    //
    // 失败/被中断就不消费,下一次排空重来(at-least-once)。宁可多汇报一次,
    // 不能静默漏掉。
    if (!aborted && !failed) {
      if (todo.kind === "review_work") {
        // ⚠️ **021 之后,判据从「回合成功结束」翻成「存在一条 pass 结论」。**
        //
        // 翻之前:回合成功就 `markWorkReviewed` —— 于是质检判「不通过」与判
        // 「通过」在库里**长得一模一样**(都是 `review_state='done'`)。真机事故
        // (2026-10-06 08:57)就是这么发生的:质检给根工作项判了不通过、6 条判据
        // 0 条达成、审查意见 3352 字,而库里的工作项是 done/done,**不会再审第二次**,
        // 不通过也没有任何读者 —— 死信。
        //
        // 翻之后:回合成功但**没有结论** ⇒ **不消费**,留在 `pending`,下一 tick 重审,
        // 并在告警里点名「质检跑完了但没给结论」。模型忘了调 `review_verdict`
        // 的失效方向从此是「多重审一次」,而不是「静默认审过了」——
        // 与 `authorize.ts` 的 fail-closed 同一个方向。
        for (const id of todo.refs) {
          const v = latestReviewVerdict(deps.db, id);
          if (v?.verdict === "pass") markWorkReviewed(deps.db, id, deps.now());
        }
      }
      if (todo.kind === "report_downstream") {
        consumePendingDispatchEvents(deps.db, deps.projectId, todo.agentId, deps.now());
        reportedToClient = true;
      }
      // ── 第四支(020):甲方答复的**终点** ────────────────────────────
      //
      // 与上面三支同一条纪律:回合**成功结束**才记「这件事办过了」,失败/被中断
      // 就不消费、下一次排空重来(at-least-once)。宁可多处置一次,不能静默漏掉
      // 甲方的一次答复 —— 那正是这次事故的形态(答复在库里,永远没人看)。
      if (todo.kind === "resume_client") {
        consumeClientAnswers(deps.db, deps.projectId, todo.agentId, deps.now());
      }
      // ── 第三支(C4):交付那一环的**终点** ────────────────────────
      //
      // 「业务经理主动开一条对话」这句话的机械形态:平台在 `handover` 回合
      // **成功结束后**开一条交付对话(`channel='client'` +
      // `deliverable_artifact_id`)—— 与上面两支同形:回合成功才记账,
      // 失败 / 被中断就下次重来。
      //
      // **为什么这条边必须在库里**:它同时是 `handover_deliverable` 规则的
      // **终止判据**(`deliveredArtifactIds` 读的就是这一列)。没有它,那条规则
      // 每个 tick 都成立,只能靠尝试预算兜住 —— 而预算按 AGENTS.md 的定性是
      // **限流不是判据**,拿它兜一条每次都成立的规则等于让流水线静默停在一个
      // 「看起来跑过很多次」的地方(§2.11.4 末)。
      //
      // **幂等**:`openDeliverableSession` 先读库(同一条交付物已有会话就返回
      // `created:false`),所以重复消费不会开出第二条对话 —— at-least-once 的
      // 重放是安全的。
      //
      // ⚠️ `todo.target` 就是那条交付物的 id(`handover:${a.id}` 的 target)。
      // 为 `null` 时**什么都不做**:那是装配错误(这条待办一定带 target),
      // 此刻悄悄开一条不挂边的会话,只会让下一次排空再产出同一条待办 —— 那才是
      // 「静默」的正确形态:规则如实地说「还没交付」,由预算兜住。
      if (todo.kind === "handover" && todo.target !== null) {
        const r = openDeliverableSession(deps.db, {
          projectId: deps.projectId,
          deliverableArtifactId: todo.target,
          channel: "client",
          createdAt: deps.now(),
        });
        if (r.created) {
          deps.log(
            `dispatcher: 交付物 ${todo.target} 的对话已开出来(${r.sessionId},通道 client)`,
          );
        }
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
    deps.log(
      `dispatcher: 排空结束(${rounds} 次派发 · ${turns} 个真回合 · ${stopReason})—— ${stopDetail}`,
    );
  }
  return {
    projectId: deps.projectId,
    rounds,
    turns,
    stopReason,
    stopDetail,
    visited,
    exhausted,
    newlyExhausted,
    reportedToClient,
  };
}

