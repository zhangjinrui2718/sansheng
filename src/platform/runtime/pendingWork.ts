/**
 * BC2 · 待办注入面(ADR-001 §5.2)
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 * 新模型里提问者进入 blocked,而**收到方不会主动知道**有东西在等它。
 * 旧系统靠 watchdog + artifactBus 事件推送;新模型把「判断」交给了收到方的
 * 正常回合 —— 但如果没人告诉它有东西在等,那个回合永远不会发生。
 *
 * 没有这一层会发生什么:整个 7-L 升级链在真实运行中**停摆**,而单元测试全绿
 * —— 因为测试都是显式调用 `ask_list` 的。这是「测试通过但系统不动」的典型形态。
 *
 * ── 为什么做成纯函数而不是「会话启动时查一次」──────────────���───────
 *
 * 「什么时候注入」是运行时的事(每轮?启动时?);「注入什么」是纯逻辑。
 * 拆开之后后者可以穷举测试,而前者只需要一行调用。
 *
 * ── 它不做的事 ──────────────────────────────────────────────────
 *
 * 不查数据库之外的任何东西、不写状态、不决定「要不要打扰」。它只回答
 * 「这个人此刻手上有哪些悬而未决的事」,并渲染成一段可注入的文本。
 * 「要不要现在就注入」由调用方决定。
 */
import type Database from "better-sqlite3";
import { listAsks, askedByMeOpen, listOverdueAsks, type AskRow } from "../storage/repo/asks.js";
import { pendingMeetingsFor, type MeetingRow } from "../storage/repo/meetings.js";
import { getAgent } from "../storage/repo/agents.js";
import { listBlockers, type BlockerRow } from "../storage/repo/blockers.js";
import { isChangeTerminal, listChanges, type ChangeRequestRow } from "../storage/repo/changes.js";
import {
  listWorks, depsSatisfied, depState, workIdsWithChildren, type WorkRow,
} from "../storage/repo/works.js";
import { getProjectRow } from "../storage/repo/projects.js";
import { ROLE_SPECS, isProjectRole, type ProjectRole } from "../identity/role.js";

export interface PendingWork {
  /** 在等我答的提问 —— **最高优先级**,有人因为我停着 */
  asksToAnswer: readonly AskRow[];
  /** 等我表态的会议(异步,不阻塞,但不该忘) */
  meetingsToRespond: readonly MeetingRow[];
  /** 我自己卡住的(我是提问者且还没结论)—— 用于让 agent 知道自己在等谁 */
  myBlockedAsks: readonly AskRow[];
  /** 已过截止仍未答复的 —— 仅统计,处置由调度器决定(ADR-001 §5.3) */
  overdueAsks: readonly AskRow[];
  /** 该项目未解决的阻塞 —— 供业务经理向甲方交代状况 */
  openBlockers: readonly BlockerRow[];
  /**
   * **待推进的变更**(非终态的:proposed / under_review / accepted)。
   *
   * 为什么不是只列 `proposed`:变更的状态机是
   * `proposed → under_review → accepted → implemented`,每一步都要有人推。
   * 只把 `proposed` 当待办,后果是真机跑出来过的形态 —— 项目经理把变更推到
   * `under_review` 之后**没有任何人会被叫醒**,那条变更永久停在那儿,
   * 而日志里一切正常(没有待办了)。
   */
  pendingChanges: readonly ChangeRequestRow[];
  /**
   * **分派给我、现在就能开工**的工作项(负责人是我、状态 `open`、前置全部满足)。
   *
   * 这一条此前是缺的 —— 25 个字段里没有「派给我的活」,于是 worker 的待办在
   * 注入面里**根本不存在**:它只能靠主动 `work_list` 才看得到自己有活。
   * 而「谁手上有可执行的待办就唤醒谁」这条驱动规则正需要它(见 `runtime/driver.ts`)。
   *
   * ── 容器**不在**这里(判据是「有子项」,不是「是根」)─────────────
   *
   * 「交付整合」这类**容器**根工作项不该被当成活派给执行者。真机现场:worker 拿到
   * 那条容器,跑了 6 分钟、读了全树,才自己识别出「它是一个『交付整合』容器,
   * 而我刚拿到的任务就是它」,然后 `work_update(blocked)` + 开一条阻塞 —— 一次
   * 纯浪费的回合(而它识别对了,**说明判据本来就该在平台这一侧**)。
   *
   * 过滤收在**这里**(而不是 `runtime/dispatcher.ts` 的规则 `if` 里),因为本函数
   * 就是**注入面**:下面 `renderPendingWork` 渲染的「分派给你、可以开工的工作项」
   * 正是它。两处各收一半会让「模型看得见它」与「平台拒绝跑它」同时成立 ——
   * 一处判据两个说法,迟早漂(而这个项目为「两份定义会漂」已付过好几次代价)。
   *
   * ⚠️ **已知失效方向:抢跑窗口。** PM 若在**第 N 回合**建出根、**第 N+1 回合**
   * 才建子项,那一瞬间根还是叶子 ⇒ 它**照样**会被派去执行。**同一个回合内**
   * 建根 + 建子项是安全的:门铃在回合内只记打点(`host/serve.ts` 的
   * `drainingProjects` / `nudgedProjects`),排空在**这个回合结束之后**才重查库,
   * 那时子项已经在库里了。⇒ 残余窗口 = 「PM 拆解到一半就停下了」,而那是**异常**
   * 本身;它的代价是**一个**被浪费的 worker 回合(不是停摆:worker 会把它置
   * `blocked`,而 `dispatcher.ts` 的 `resolve_blocked_work` 随即把 PM 叫回来)。
   * 关掉它需要「容器形态」这个**模型的声明**(方案乙,已否决:忘标就静默停摆)
   * 或一个时间启发式 —— 两者都比这个窗口更坏。
   */
  myOpenWorks: readonly WorkRow[];
  /**
   * 分派给我、但**前置还没满足**的工作项 —— 不在 actionable 里,只做可见性。
   *
   * 为什么单独列出来:`myOpenWorks` 把它们排除掉之后,「这条工作项为什么一直没跑」
   * 在界面上就没有答案了(7-N:见不到的现场等于没有现场)。
   *
   * ⚠️ 容器也不在这里 —— 容器**不是「还没轮到跑」,而是「不由执行者跑」**,
   * 把它摆成「在等前置」是对模型的一次误导(它按它做事的代价见 `myOpenWorks`)。
   */
  myWaitingWorks: readonly WorkRow[];
  /**
   * 可开工,但**前置里有被取消的**。
   *
   * 取消不构成阻塞(`depsSatisfied` 把 cancelled 算作满足),所以这些工作项进了
   * `myOpenWorks`。但**不能让 agent 以为一切按计划** —— 它是在「某个前置被取消了」
   * 的前提下开工的,那会影响它怎么理解自己的目标边界。
   *
   * 真机事故就出在这里:项目经理取消「综合对比」并新建了同名项,下游的 `dependsOn`
   * 指向**被取消的那份旧的**;修好阻塞判定之后,下游终于能开工了 —— 如果这时不告诉它,
   * 它就会在缺一块输入的情况下闷头做。
   */
  myWorksWithCancelledDeps: readonly {
    readonly work: WorkRow;
    readonly cancelledDepIds: readonly string[];
  }[];
  /**
   * 我负责拆解、但这个项目里**一个工作项都还没有**。
   *
   * 只有 `project_manager` 且项目 `active` 时才为真 —— 这是项目经理被唤醒的
   * 起点(新立项、零工作项)。已经拆过(哪怕拆出来的都做完了)就不再为真:
   * 「拆完了」和「没拆过」是两件事,后者的判据必须能区分它们。
   */
  needsDecomposition: boolean;
  /** 我这个 agent 的当前角色(从库里现读)。找不到时 `null`。 */
  readonly role: ProjectRole | null;
}

/** 收集一个 agent 在某项目里的全部待办。纯查询,无副作用。 */
export function collectPendingWork(
  db: Database.Database,
  agentId: string,
  projectId: string,
  now: number,
): PendingWork {
  const row = getAgent(db, agentId);
  const role = row !== null && isProjectRole(row.role) ? row.role : null;

  // 分派给我的工作项,按前置是否满足分两堆。终态的不算待办。
  //
  // **容器不进这两堆**(判据 = 有子项,见 `myOpenWorks` 的字段注释与
  // `workIdsWithChildren`):它由子项推动、由平台在整合成功后收口,不由执行者跑。
  const containers = workIdsWithChildren(db, projectId);
  const assigned = listWorks(db, projectId, { assigneeAgentId: agentId }).filter(
    (w) =>
      (w.status === "open" || w.status === "in_progress") && !containers.has(w.id),
  );
  const myOpenWorks: WorkRow[] = [];
  const myWaitingWorks: WorkRow[] = [];
  const myWorksWithCancelledDeps: Array<{ work: WorkRow; cancelledDepIds: readonly string[] }> = [];
  for (const w of assigned) {
    if (!depsSatisfied(db, w.id)) {
      myWaitingWorks.push(w);
      continue;
    }
    myOpenWorks.push(w);
    // 只在「可开工」时多查一次,专门为了把「前置被取消」这件事捞出来(见字段注释)
    const st = depState(db, w.id);
    if (st.cancelled.length > 0) {
      myWorksWithCancelledDeps.push({ work: w, cancelledDepIds: st.cancelled });
    }
  }

  // 项目还没拆过:只有项目经理该管这件事,且只在 active 项目上。
  const project = getProjectRow(db, projectId);
  const noWorksYet = listWorks(db, projectId).length === 0;
  const needsDecomposition =
    role === "project_manager" && project !== null && project.status === "active" && noWorksYet;

  return {
    asksToAnswer: listAsks(db, projectId, { toAgentId: agentId, actionableOnly: true }),
    meetingsToRespond: pendingMeetingsFor(db, agentId),
    myBlockedAsks: askedByMeOpen(db, agentId),
    overdueAsks: listOverdueAsks(db, now, projectId),
    openBlockers: listBlockers(db, projectId, { unresolvedOnly: true }),
    // 非终态的变更都算待办 —— 但**只对持 `change.review` 的角色**算
    // (由 hasActionableWork 按 ceiling 过滤;业务经理只有 change.read)
    pendingChanges: listChanges(db, projectId).filter((c) => !isChangeTerminal(c.status)),
    myOpenWorks,
    myWaitingWorks,
    myWorksWithCancelledDeps,
    needsDecomposition,
    role,
  };
}

/**
 * 有没有任何需要该 agent **动手**的事。用于决定「要不要注入 / 要不要唤醒」。
 *
 * ── 为什么要按角色的 ceiling 过滤(批次 20 的行为变更)────────────
 *
 * 一件事在库里挂着、而你的工具面根本够不着它,那就不该把你叫醒 ——
 * 叫醒了你也只能空转一轮然后被无进展检测停掉(见 `runtime/driver.ts` 的 ③)。
 *
 * 具体差在哪:全组织里只有 `project_manager` / `worker` / `quality_reviewer`
 * 持 `change.review`,业务经理只有 `change.read` —— 一条 `proposed` 变更对他是
 * 「看得见但推不动」,不该成为唤醒理由。
 *
 * 角色取自**库里现读的那一份**(`PendingWork.role`),不另收参数 ——
 * 两个来源迟早会漂,而「这个 agent 是什么角色」只有一个真相。
 * 角色读不出来(`null`)时不猜:退回「库里挂着就算」的宽判。
 */
export function hasActionableWork(w: PendingWork): boolean {
  const role = w.role;
  const canReviewChange = role === null || ROLE_SPECS[role].ceiling.includes("change.review");
  // 执行只有 worker 能做(`runWorkItem` 的 checkRunnable 会拒绝别的角色),
  // 所以派给别人的工作项不算「他此刻能动的事」。
  const canExecuteWork = role === null || role === "worker";
  return (
    w.asksToAnswer.length > 0 ||
    w.meetingsToRespond.length > 0 ||
    (canReviewChange && w.pendingChanges.length > 0) ||
    (canExecuteWork && w.myOpenWorks.length > 0) ||
    w.needsDecomposition
  );
}

/** 一句话摘要(日志/诊断用)。 */
export function summarizePendingWork(w: PendingWork): string {
  const parts: string[] = [];
  if (w.asksToAnswer.length > 0) parts.push(`${w.asksToAnswer.length} 条等你答`);
  if (w.meetingsToRespond.length > 0) parts.push(`${w.meetingsToRespond.length} 场会等表态`);
  if (w.pendingChanges.length > 0) parts.push(`${w.pendingChanges.length} 条变更待推进`);
  if (w.myOpenWorks.length > 0) parts.push(`${w.myOpenWorks.length} 个工作项可开工`);
  if (w.needsDecomposition) parts.push("项目还没拆解");
  if (w.myBlockedAsks.length > 0) parts.push(`你自己卡着 ${w.myBlockedAsks.length} 条`);
  if (w.overdueAsks.length > 0) parts.push(`${w.overdueAsks.length} 条已超时`);
  if (w.openBlockers.length > 0) parts.push(`${w.openBlockers.length} 个未解决阻塞`);
  return parts.length > 0 ? parts.join(" · ") : "无待办";
}

function nameOf(db: Database.Database, agentId: string): string {
  const a = getAgent(db, agentId);
  return a ? `${a.displayName}(${a.role})` : agentId;
}

/**
 * 渲染成可注入的文本。
 *
 * ── 与 `hasActionableWork` 的分工:一个是「有什么话要说」,一个是「要不要打断你」──
 *
 * 这两个判断**必须分开**,合并会两头不讨好:
 *   - 只按 actionable 渲染 → 业务经理想向甲方交代「有哪些未解决阻塞」时,
 *     那段信息根本渲染不出来(阻塞不是 actionable,没人被它阻塞着等回复)
 *   - 只按「有内容」唤醒 → 每轮都因为挂着几个老阻塞而注入一遍,白占 context
 *
 * 所以:渲染 = 我知道的全部;要不要注入 = 调用方按 `hasActionableWork` 决定。
 *
 * **真的一条都没有时返回空串** —— 让调用方可以无脑拼接。返回一段「你没有待办」
 * 的废话会白占 context,而重试轮里它会反复出现。
 */
export function renderPendingWork(db: Database.Database, w: PendingWork): string {
  const hasAnything =
    w.asksToAnswer.length > 0 ||
    w.meetingsToRespond.length > 0 ||
    w.pendingChanges.length > 0 ||
    w.myBlockedAsks.length > 0 ||
    w.overdueAsks.length > 0 ||
    w.openBlockers.length > 0 ||
    w.myOpenWorks.length > 0 ||
    w.myWaitingWorks.length > 0 ||
    // ⚠️ 必须列进来。它今天**必然**与 `myOpenWorks` 同时非空(收集时就在那个分支里),
    // 所以漏掉它不影响结果 —— 但这正是危险处:哪天 `myOpenWorks` 的判据一改,
    // 下面那段「前置被取消」的警告会**静默消失**,没人会发现。
    // (并行 subagent 复核时指出:这段可见性一直搭在别人的非空上。)
    w.myWorksWithCancelledDeps.length > 0 ||
    w.needsDecomposition;
  if (!hasAnything) return "";
  const lines: string[] = ["## 当前待办"];

  if (w.asksToAnswer.length > 0) {
    lines.push(
      "",
      `### 等你的提问(${w.asksToAnswer.length})—— 有人因此停着`,
      "**先处理这些**:提问者处于 blocked,你不答它就走不下去。",
      "能自己判断的直接 `answer`;判不了才 `escalate`(目标由平台计算)。",
      ...w.asksToAnswer.map(
        (a) =>
          `- ${a.id} ← ${nameOf(db, a.fromAgentId)}:${a.question.split("\n")[0]}` +
          `\n    它的假设:${a.hypothesis.split("\n")[0]}`,
      ),
    );
  }

  if (w.needsDecomposition) {
    lines.push(
      "",
      "### 这个项目还没有任何工作项 —— 拆解是你的第一件事",
      "业务经理已经把甲方诉求收敛成了项目目标(见上面「你所在的项目」)。",
      "先 `board_list` 看黑板上有没有人已经做过什么,再用 `work_create` 拆出",
      "**能各自独立开工**的工作项,每个都给负责人与可验证的判据。",
      "拆完之后**不要**自己动手做 —— 你不持 `code.*`。",
    );
  }

  if (w.myOpenWorks.length > 0) {
    lines.push(
      "",
      `### 分派给你、可以开工的工作项(${w.myOpenWorks.length})`,
      "用 `work_read` 看完整目标与依赖现场。**一次做完一个再开下一个。**",
      ...w.myOpenWorks.map(
        (x) => `- ${x.id} [${x.status}] ${x.title}(更新于 ${new Date(x.updatedAt).toISOString()})`,
      ),
    );
  }

  if (w.myWorksWithCancelledDeps.length > 0) {
    lines.push(
      "",
      `### ⚠️ 可开工,但前置里有被取消的(${w.myWorksWithCancelledDeps.length})`,
      "**这不是阻塞** —— 取消意味着那块范围不要了,你可以做。但你要知道自己的输入少了一块:",
      ...w.myWorksWithCancelledDeps.map(
        (x) => `- ${x.work.id} ${x.work.title} ← 前置被取消:${x.cancelledDepIds.join(", ")}`,
      ),
      "拿不准就先 `work_read` 看依赖,或 `ask_role` 问派活的人。",
    );
  }

  if (w.myWaitingWorks.length > 0) {
    lines.push(
      "",
      `### 分派给你、但前置还没满足(${w.myWaitingWorks.length})`,
      "这些**还不能开工**(前置未完成或已失败)。先 `work_read` 确认在等谁。",
      ...w.myWaitingWorks.map((x) => `- ${x.id} ${x.title}(状态 ${x.status})`),
    );
  }

  if (w.meetingsToRespond.length > 0) {
    lines.push(
      "",
      `### 等你表态的会议(${w.meetingsToRespond.length})`,
      "用 `meeting_read` 看议题与已有立场,`meeting_respond` 表态(反对必须写理由)。",
      ...w.meetingsToRespond.map((m) => `- ${m.id}:${m.topic}(发起人 ${nameOf(db, m.conveningAgentId)})`),
    );
  }

  if (w.pendingChanges.length > 0) {
    lines.push(
      "",
      `### 待推进的变更(${w.pendingChanges.length})`,
      "变更的状态机是 `proposed → under_review → accepted → implemented`,**每一步都要有人推**。",
      "用 `change_read` 看理由与影响面,`change_review` 推进到下一个状态。",
      ...w.pendingChanges.map((c) => `- [${c.status}] ${c.id}:${c.title}`),
    );
  }

  if (w.myBlockedAsks.length > 0) {
    lines.push(
      "",
      `### 你自己在等的(${w.myBlockedAsks.length})`,
      "这些还没结论,你目前被它们挡着。",
      ...w.myBlockedAsks.map((a) => `- ${a.id} → ${nameOf(db, a.toAgentId)}(状态 ${a.status})`),
    );
  }

  if (w.overdueAsks.length > 0) {
    lines.push(
      "",
      `### 已超时的提问(${w.overdueAsks.length})`,
      "**注意**:当前没有调度器周期性处置超时(ADR-001 §5.3),所以请自行判断是否催办或改走升级。",
      ...w.overdueAsks.map((a) => `- ${a.id}(截止 ${new Date(a.deadlineAt ?? 0).toISOString()})`),
    );
  }

  if (w.openBlockers.length > 0) {
    lines.push(
      "",
      `### 未解决的阻塞(${w.openBlockers.length})`,
      "向甲方交代项目状况时要能说清这些;用 `blocker_read` 看现场。",
      ...w.openBlockers.map((b) => `- [${b.severity}] ${b.id}:${b.title}`),
    );
  }

  return lines.join("\n");
}
