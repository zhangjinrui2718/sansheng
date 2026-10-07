/**
 * **质检判了「不通过」之后,这条产出回到谁手上** —— 这是判定,不是动作。
 *
 * ── 它补的是什么(2026-10-07 真机事故)────────────────────────────
 *
 * 真机现场:项目「催收语音机器人技术方案」的根工作项被质检**连续三轮 fail**,
 * 三份审查意见一共一万多字节、还自己写明了「建议升级」—— 而**三次审查之间
 * 一个执行回合都没有**(`turn_usage` 可查:wk 从那之后再没跑过)。两个缺陷叠在一起:
 *
 *   ① `review_verdict` 判 fail 时走 `updateWorkStatus(work, "in_progress")`,
 *      而**这条工作项是容器**(有子项)⇒ `pendingWork.ts` 的 `myOpenWorks` 把容器
 *      排除在外 ⇒ **返工永远不会派给任何一个执行者**。工具当时回给模型的话是
 *      「工作项已退回 in_progress,**原执行者会再跑一轮**」—— 平台做不到那件事,
 *      于是模型在**假前提**上推理(第二轮质检写下「worker 仍无任何实质性输出动作」)。
 *   ② 排空器每轮开头先跑 `closeIntegratedContainers`,那条根「非终态 + 子项全终态
 *      且已审」⇒ **8 秒内又被收口成 `done`** ⇒ 再叫质检审**同一份没变的东西**。
 *
 * ⇒ 结论:**「退回」不是一个平台动作,而是「这条产出又有了一个下一步」**。
 * 判据必须是**可查询的库事实**,而目的地必须由**产出本身**决定。
 *
 * ── 这个模块的三条判据 ──────────────────────────────────────────
 *
 *   1. {@link collectReworkPending} —— **哪条工作项在等返工**。
 *      判据 = 「最近一次审查结论是 `fail`」且「那之后**它自己**没有任何新产出」。
 *      两个方向都在库里,所以它是纯查询:重启后照样算得出来,不需要任何内存状态
 *      (批次 21 那条纪律)。
 *
 *      ⚠️ 第二条判据是**终止条件**,也是它与「再审一次」的分水岭:没有它,
 *      一条被 fail 的工作项会永远出现在待办里(每次都成立),只能靠尝试预算兜住
 *      —— 而预算按 AGENTS.md 的定性是**限流不是判据**。
 *
 *   2. {@link reworkOwner} —— **该退给谁**。用户裁决(2026-10-08):
 *      「如果有作者,你就给作者;找不到谁来解决这个工件的问题,你就退回给 PM」。
 *      所以目的地**从产出反推**,不从工作项的 `assignee` 读 —— 真机上
 *      `assignee` 是研究工,而缺的那份整合交付物从来不是它的活(PM 自己也是
 *      这么裁定的:`art_muxrp84fltv8u08k`)。
 *
 *      ⚠️ **不能直接拿 `artifacts.work_id` 反查作者**:migration 014 那条边是
 *      「产出 ∪ 关于」两个语义的并集,质检的 `review_finding` 正挂在**被审的那条**
 *      上 —— naive 实现会把返工退回给**质检自己**。产出侧判据是
 *      `isProducedArtifactKind`(`identity/role.ts`),与 `execution.ts` 同一个答案。
 *
 *   3. {@link reworkRound} —— **这是第几轮**。它给两件事用:任务正文里如实
 *      告诉模型「你已经第 N 轮了」,以及轮次到界后**换人**(见 `REWORK_ESCALATE_ROUND`)。
 *      今天这个数字只存在于模型写的散文里(severity 只是给人看的),所以
 *      「同一件事试了几次」在库里**没有结构化答案** —— 这一条把它补上,不加重试语义。
 *
 * ── 它不做什么 ──────────────────────────────────────────────────
 *
 * 不做任何状态迁移、不写库、不决定「要不要重试」。`rework` 待办由
 * `dispatcher.ts` 的规则表产出(与另外 14 条同形:纯查询 → 待办 → 排空器派发),
 * 返工回合怎么写产出、写几份,仍然是模型的判断。
 */
import type Database from "better-sqlite3";
import { listArtifacts, type ArtifactRow } from "../storage/repo/artifacts.js";
import {
  listReviewVerdicts, latestVerdictsByWork, type ReviewVerdictRow,
} from "../storage/repo/reviewVerdicts.js";
import { isProducedArtifactKind, type ProjectRole } from "../identity/role.js";
import { listWorks, type WorkRow } from "../storage/repo/works.js";

/**
 * 轮次到界就**换人**的门槛:第 3 轮返工起,平台把这条退回给项目经理。
 *
 * 为什么是「换人」而不是「再叫一次同一个作者」:真机上三轮 fail 的根因不是
 * 「作者没看清要求」,而是**这件事压根不在它的职责里**(整合交付物是 PM 的活)。
 * 同一件事被同一个人做三次都做不成时,再叫第三次**不会有不同的结果** ——
 * 那正是尝试预算存在的理由,而预算的表达是「不再叫醒」,对用户是静默的。
 * 换成一个能**重新划范围**的角色,是把它变成一次结构性的动作,而不是又一次重试。
 *
 * 为什么是 3 而不是 2:第 1 轮返工是常态(审查意见本来就常有);第 2 轮仍不通过
 * 说明要求可能没说清,仍值得原作者再试一次(它手上才有素材);到第 3 轮,
 * 「再说一遍」的边际收益已经是零。
 *
 * ⚠️ 它不是「重试上限」—— 重试上限仍然是 `dispatcher.ts` 的尝试预算,而这一条
 * 是**判据**(在库里、可查询、重启后照样成立),两者不要混。
 */
export const REWORK_ESCALATE_ROUND = 3;

/** 一条「在等返工」的工作项,连同它的现场。**全是结构化列,没有正文。** */
export interface ReworkPending {
  readonly workId: string;
  /** 工作项标题 —— 只给人读(待办 label / 日志),判据一个都不用 */
  readonly workTitle: string;
  /** 那次判不通过的结论(最新一条) */
  readonly verdict: ReviewVerdictRow;
  /**
   * 这是第几轮返工(= 这条工作项累计被判 `fail` 的次数,从 1 开始)。
   *
   * 它**不是**「尝试预算」:预算记的是「平台叫醒了几次」,这个是「质检否了几次」。
   * 两者会不一致(一次 fail 可能被叫醒多次;一次叫醒也可能没人动),而任务正文里
   * 该说给模型听的是**后者** —— 「你已经第 3 轮了」才是它能理解的事实。
   */
  readonly round: number;
  /**
   * 上一轮**它自己**交的产出 id(不含「关于」类,见 `isProducedArtifactKind`)。
   *
   * 只给 id,不给正文 —— 返工那个回合要**重新读**当时交的东西,而平台搬运正文
   * 等于替它读一遍(与 `renderAnsweredQuestions` 同一条纪律:平台摆事实,模型读正文)。
   */
  readonly producedArtifactIds: readonly string[];
  /**
   * 最近一条产出的作者 = **该为这份产出负责的人**;这条工作项一份产出都没有时为 `null`。
   *
   * `null` 就是真机那个现场(父工作项上 0 份 deliverable),此时由
   * {@link reworkOwner} 兜底给项目经理。
   */
  readonly authorAgentId: string | null;
}

/**
 * 这条工作项上**它自己**的产出(按时间升序)。
 *
 * 「它自己」= `work_id` 指向它 **且** kind 在产出侧 —— 质检挂在它上面的
 * `review_finding` 不算(`isProducedArtifactKind` 是那条边唯一的产出侧判据)。
 */
export function producedArtifactsOf(
  db: Database.Database,
  projectId: string,
  workId: string,
): ArtifactRow[] {
  return listArtifacts(db, projectId, { workId, limit: 500 })
    .filter((a) => isProducedArtifactKind(a.kind))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** 这条工作项累计被判了几次不通过(它就是「第几轮」的来源)。 */
export function failCountOf(db: Database.Database, workId: string): number {
  return listReviewVerdicts(db, workId).filter((v) => v.verdict === "fail").length;
}

/**
 * 「这条工作项在等返工吗」—— 是则返回现场,否则 `null`。
 *
 * 判据两条**同时**成立:
 *   - 最近一次审查结论是 `fail`;
 *   - 那次结论**之后**,这条工作项上没有任何**它自己的**新产出。
 *
 * 第二条是终止条件,也正是它与真机事故的区别:真机上三轮 fail 之间工件组成
 * **完全没变**(质检自己写下来的),而「没变」在库里就是「没有任何新产出」。
 */
export function reworkPendingOf(
  db: Database.Database,
  projectId: string,
  work: WorkRow,
  latestVerdict: ReviewVerdictRow | null,
): ReworkPending | null {
  if (latestVerdict === null || latestVerdict.verdict !== "fail") return null;
  const produced = producedArtifactsOf(db, projectId, work.id);
  const redelivered = produced.some((a) => a.createdAt > latestVerdict.createdAt);
  if (redelivered) return null;
  const author = produced.length === 0 ? null : produced[produced.length - 1]!.authorAgentId;
  return {
    workId: work.id,
    workTitle: work.title,
    verdict: latestVerdict,
    round: failCountOf(db, work.id),
    producedArtifactIds: produced.map((a) => a.id),
    authorAgentId: author,
  };
}

/**
 * 项目里在等返工的**全部**工作项 —— 就地查库的那一版。
 *
 * 给两个调用方用:`collectRuleFacts`(规则表的触发/终止判据)与
 * `dispatcher.ts` 的 `closeIntegratedContainers`(它必须**跳过**等返工的根,
 * 否则会把质检刚退回的那条又收口成 `done` —— 真机 8 秒内发生的事)。
 *
 * ⚠️ 传 `works` 时就不重查一遍工作项:`collectRuleFacts` 已经查过了,
 * 而「同一件事查两遍」在这张表上是**两份定义**的第一种形态。
 */
export function pendingReworkOfProject(
  db: Database.Database,
  projectId: string,
  works?: readonly WorkRow[],
): ReworkPending[] {
  const rows = works ?? listWorks(db, projectId);
  return collectReworkPending(db, projectId, rows, latestVerdictsByWork(db, projectId));
}

export function collectReworkPending(
  db: Database.Database,
  projectId: string,
  works: readonly WorkRow[],
  latestVerdicts: ReadonlyMap<string, ReviewVerdictRow>,
): ReworkPending[] {
  const out: ReworkPending[] = [];
  for (const w of works) {
    const p = reworkPendingOf(db, projectId, w, latestVerdicts.get(w.id) ?? null);
    if (p !== null) out.push(p);
  }
  return out;
}

/** 返工的目的地。 */
export interface ReworkOwner {
  readonly agentId: string;
  readonly role: ProjectRole;
  /** 为什么是它 —— 进日志与任务正文,不猜 */
  readonly reason: "author" | "pm_fallback" | "pm_escalated";
}

/** 名字里带 role 的最小投影 —— 不引 `AgentRow`,免得为了一个字段拖进整个仓储类型。 */
interface OwnerCandidate {
  readonly agentId: string;
  readonly role: ProjectRole;
}

/**
 * **该退给谁** —— 用户裁决:「有作者就给作者,找不到谁来解决这个工件的问题,就给 PM」。
 *
 * 判据顺序(每条都只用结构化事实):
 *   1. 第 {@link REWORK_ESCALATE_ROUND} 轮起 → **PM**(换人,见那个常量的说明);
 *   2. 这条工作项**有产出** → 那份产出的作者 —— 若它还是本项目的成员
 *      (作者可能已经被移出项目,那时它连会话都建不出来,派给它等于静默停摆);
 *   3. 其余(一条产出都没有,或作者已不在项目里)→ **项目经理**兜底。
 *
 * ⚠️ 目的地**不看 `works.assignee_agent_id`**。真机现场:那条根工作项的负责人是
 * 研究工,而缺的「整合交付物」从来不是研究工的活 —— 派给负责人只会再来一次
 * 「它不知道这不是自己的活」。谁是产出者,谁就该改它;没有产出者,就是没人认领 ⇒ PM。
 */
export function reworkOwner(
  pending: ReworkPending,
  members: readonly OwnerCandidate[],
): ReworkOwner | null {
  const pm = members.find((m) => m.role === "project_manager");
  if (pending.round >= REWORK_ESCALATE_ROUND) {
    return pm === undefined
      ? null
      : { agentId: pm.agentId, role: pm.role, reason: "pm_escalated" };
  }
  const author = pending.authorAgentId === null
    ? undefined
    : members.find((m) => m.agentId === pending.authorAgentId);
  if (author !== undefined) {
    // 执行角色的产出由它自己返工;非执行角色(PM 写的交付物被退回)同样由它返工 ——
    // 判据是「谁写的谁改」,不是「谁能执行工作项」(`execute_work` 才是后者)。
    return { agentId: author.agentId, role: author.role, reason: "author" };
  }
  return pm === undefined ? null : { agentId: pm.agentId, role: pm.role, reason: "pm_fallback" };
}

/**
 * `rework` 待办的任务正文。
 *
 * ── 用户裁决(2026-10-08)────────────────────────────────────────
 *
 * 「质检包(质检结论 + 原工件 id,**不要重复原文,否则浪费**)」。
 * 所以这里**只摆结构化事实**:第几轮、结论、severity、审查意见工件的 id、
 * 上一轮产出的 id。正文一个字都不搬 —— 要读判据,模型自己 `board_read`
 * (这也是 `renderDownstream` 那条纪律:平台不复述判据,免得两份定义漂)。
 *
 * 它必须带上 `findingArtifactId`:平台侧只有它,模型侧才有正文。少了这一行,
 * 「返工包」就退化成「你被退回了,自己猜为什么」—— 那正是真机上发生的事
 * (三次 fail 之间 wk 一个回合都没跑,也就没人有机会读到那三份意见)。
 */
export function renderReworkPacket(pending: ReworkPending, reason: ReworkOwner["reason"]): string {
  const v = pending.verdict;
  const lines = [
    `# 现在轮到你了:返工(第 ${pending.round} 轮)—— 质检判了「不通过」`,
    "",
    `- 工作项:\`${pending.workId}\``,
    `- 质检结论:**不通过**(severity=${v.severity})`,
    v.findingArtifactId === null
      ? "- 质检意见工件:**这次没有挂**(`review_verdict` 没带 `findingArtifactId`)—— " +
        "结论只有上面这一行,没有更多现场"
      : `- 质检意见工件:\`${v.findingArtifactId}\` —— **用 \`board_read\` 去读它**,` +
        "那里写着具体哪一条没达成;平台**不复述它的正文**(复述会白占你的 context,还会与原文漂)",
    pending.producedArtifactIds.length === 0
      ? "- 这条工作项上**你自己一份产出都没有**(平台按产出边查的)—— " +
        "这就是被打回的直接原因:目标要求的交付物不存在"
      : `- 你上一轮的产出(被退回的那一版):` +
        pending.producedArtifactIds.map((id) => `\`${id}\``).join("、"),
    reason === "pm_escalated"
      ? `- ⚠️ **第 ${pending.round} 轮了,平台把这一条换给了你(项目经理)**:` +
        "反复退给同一个作者已经没有不同的结果 —— " +
        "先判断「这件事到底该谁做 / 范围该怎么划」,再决定是你亲自写还是改派"
      : reason === "pm_fallback"
        ? "- ⚠️ **这条工作项没有任何产出、也没有可退的作者**,所以平台把它交给你(项目经理):" +
          "这通常意味着「该产出这份交付物的人从来没被指派过」—— 那正是你要裁定的那件事"
        : "- 判据是**谁写的谁改**:你写的这份产出被质检退回了",
    "",
    "## 做完之后",
    "",
    `1. 把意见里指出的问题解决掉,重新 \`board_write\` 一份产出 —— **\`workId\` 传 \`${pending.workId}\`**。`,
    "   平台判「返工做完了没有」看的就是这一条:**这条工作项上出现了比质检结论更新的产出**。",
    "   不重新交东西的话,这一条会被反复叫醒,直到把尝试预算烧完。",
    "2. 那个新产出落盘时,平台会把**被退回的那一版**标成 `superseded`(已被取代) ——",
    "   所以你不必手工去改旧工件的状态(也改不了:工件不可改,只能再写一份)。",
    "3. 改完之后把工作项状态推成 `done`(`work_update`)—— 它会重新进入审查。",
  ];
  return lines.join("\n");
}
