/**
 * 成员活动判据(v5 Wave D,2026-11-20 从 `routes/Members.tsx` 搬出)—— 纯逻辑,无 JSX。
 *
 * 搬家的理由:全员并发板(`MemberCard`)与成员面板(`MemberPane`)要读**同一份**
 * 判据(欠什么、为什么在跑、年龄怎么算)—— 判据住在路由文件里,组件就得反向
 * import 一条路由。搬家 ≠ 改写:逐字继承,注释里的裁决记录照搬。
 */
import type { MemberActivityView, TriggerTodoKind, TurnTrigger } from "@shared/types/platform";

/**
 * `TriggerTodoKind` 的中文读法。
 *
 * ⚠️ 为什么不在 `lib/vocab.ts`:vocab 是**契约状态的共享词表**,而这一列在
 * 2026-10-06 之前没有任何前端读者,先随成员页落地;真要第二次用到它,再搬。
 * ⚠️ **migration 022 修过一处静默降级**:这一列曾因数据不落库而全部显示英文。
 */
const TODO_KIND_LABEL: Record<TriggerTodoKind, string> = {
  answer_ask: "回答提问",
  attend_meeting: "参加评审会",
  review_change: "评审变更",
  fix_work_assignment: "改派工作项",
  resolve_blocked_work: "处理被卡住的工作项",
  recover_failed_work: "重新划失败的工作项",
  decompose_project: "拆解项目",
  execute_work: "执行工作项",
  rework: "返工(质检判了不通过)",
  // 029:同一款待办的另一个入口 —— 甲方在界面上点了「要改」。
  rework_rejected: "重做(甲方拒收了交付物)",
  review_work: "审查产出",
  integrate: "整合成果",
  handover: "交付交接",
  report_downstream: "向甲方汇报下游结果",
  resume_client: "处置甲方的答复",
  close_project: "判断项目是否收口",
  escalate_stalled_work: "处置平台已经不再叫醒的待办",
  review_undelivered_project: "判断项目为什么没有交付物",
};

/** 未知取值原样显示英文 —— 「显示英文」比「显示一个编的中文」诚实。 */
export function todoKindLabel(kind: string | undefined): string {
  if (kind === undefined) return "未记录是哪一类待办";
  return (TODO_KIND_LABEL as Record<string, string>)[kind] ?? kind;
}

/** 「这一轮为什么存在」。判据与契约 `TurnTrigger` 一致,只有两半。 */
export function triggerText(trigger: TurnTrigger): string {
  if (trigger.kind === "user") return "你亲口发起";
  return `排空器按待办叫醒(${todoKindLabel(trigger.todoKind)})`;
}

/**
 * 服务端算的 `ageMs` → 人话。粒度**刻意到秒**:成员页存在的理由是让用户看出
 * 「它还活着」,60s 粒度会让「已跑 1 分」在一分钟里一动不动。
 */
export function formatAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时${m % 60}分`;
  const d = Math.floor(h / 24);
  return `${d}天${h % 24}小时`;
}

/**
 * 「本地收到这份快照之后过了多久」(加法为什么成立的前提:同一台机器 ——
 * `platform-serve` 与浏览器同机时钟;哪天不同机,换成两次快照的差值外推)。
 * 这是**展示层面的推进**,不是重新取数:误差只在两次轮询之间累积,只影响显示。
 */
export function elapsedSinceFetch(fetchedAt: number | null, now: number): number {
  if (fetchedAt === null) return 0;
  return Math.max(0, now - fetchedAt);
}

/**
 * 「它欠着几件事」= `readyWorks + todos.length`(口径的逐项理由见原版:
 * 不含 waitingWorks —— 前置未满不算欠;不含 exhaustedTodos —— 那是卡住不是欠)。
 * 和会重叠(一条 execute_work 待办往往正是 readyWorks 里的那条),准确读法是
 * 「需要它动手的处数」—— 宁可偏大也不偏小。
 */
export function memberDebt(activity: MemberActivityView | null): number {
  if (activity === null) return 0;
  return activity.readyWorks + activity.todos.length;
}

/** 「他欠着什么」的一行事实。**只有 > 0 的才出现** —— 0 占版面会淹掉有信息的那项。 */
export function debtFacts(activity: MemberActivityView): string[] {
  const facts: string[] = [];
  if (activity.readyWorks > 0) facts.push(`优先做 ${activity.readyWorks} 件`);
  if (activity.waitingWorks > 0) facts.push(`等前置 ${activity.waitingWorks} 件`);
  if (activity.exhaustedTodos > 0) facts.push(`预算用尽不再叫醒 ${activity.exhaustedTodos} 件`);
  return facts;
}
