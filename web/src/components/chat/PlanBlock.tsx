/**
 * Sansheng UI · 执行计划卡(批次 8-C)
 *
 * 解决的缺陷(docs/AGENT-AUDIT-2026-10-03.md G3,严重度 P0):「计划不可见、跑飞的 plan
 * 停不下来」。此前用户交办一件事后,对话流里从拆解到完成**一片空白** —— 既看不见
 * 「正在做哪一步」,也**没有任何按钮能叫停**(server 侧 abort_plan 一直有,前端零调用)。
 *
 * 渲染纪律:
 * 1. **诚实**:只在真的收到 plan_planned 时才有这张卡。本组件不造示例数据、不在空态
 *    画一条假计划;服务端真给 0 步就如实显示 0 步 + EmptyState。
 * 2. **只改那一行**:每行是一个 memo 化的 TodoRow,plan_todo_update 只把变化的那一行
 *    换成新对象,其余行引用不变 → 不重渲染 → 滚动中的聊天不闪。
 * 3. **不新增颜色**:状态色全走既有 token(--jade 已完成 / --bone 待办 / --amber 进行中
 *    或等待 / --cinnabar 失败),不引新依赖、不改 tokens.css。
 * 4. **不画箭头图**:dependsOn 非空就用一行小字标「依赖前一步」,原始 id 进 title=。
 */
import { memo } from "react";
import type { PlanBlockData, PlanTodo } from "@shared/types/chat";
import { useChatStore } from "@/stores/chat";
import { EmptyState, Flag, Pill, Section, toneColor, type Tone } from "@/components/ui/primitives";

interface StatusVisual {
  tone: Tone;
  label: string;
}

/**
 * todo 状态 → 视觉。与工件状态同一套 ArtifactStatus(shared/types/blackboard.ts),
 * 故有第六个取值 superseded(被取代)—— 不假装它不存在,如实显示「已作废」。
 */
function statusVisual(status: PlanTodo["status"]): StatusVisual {
  switch (status) {
    case "resolved":
      return { tone: "jade", label: "已完成" };
    case "in_progress":
      return { tone: "amber", label: "进行中" };
    case "waiting_for_decision":
      return { tone: "amber", label: "等决策" };
    case "failed":
      return { tone: "cinnabar", label: "失败" };
    case "superseded":
      return { tone: "mute", label: "已作废" };
    case "open":
      return { tone: "bone", label: "待办" };
    default:
      // 兜底:契约外的新状态(ArtifactStatus 以后扩展)按待办显示,而不是崩掉整张卡。
      return { tone: "bone", label: "待办" };
  }
}

/**
 * 一行 todo。**memo 是这一层的关键**:store 侧只把变化的那一行换成新对象,
 * 其余 todo 引用不变,React 因此跳过它们 —— 整卡重渲染会让正在滚动的聊天闪。
 */
const TodoRow = memo(function TodoRow({ todo }: { todo: PlanTodo }) {
  const v = statusVisual(todo.status);
  return (
    <div className="flex flex-col" style={{ padding: "4px 0" }}>
      <div className="flex items-baseline gap-2">
        <span className="ss-meta flex-none" style={{ color: toneColor(v.tone), minWidth: 36 }}>
          {v.label}
        </span>
        <span style={{ fontSize: 13, lineHeight: "20px", color: "var(--bone)", wordBreak: "break-word" }}>
          {todo.title}
        </span>
      </div>
      {/* 依赖:一行小字,不画箭头图(原始 id 挂 title=,点开可查) */}
      {todo.dependsOn.length > 0 ? (
        <span className="ss-meta" style={{ paddingLeft: 36 }} title={"依赖 " + todo.dependsOn.join("、")}>
          依赖前一步
        </span>
      ) : null}
      {/* 失败原因:只来自 plan_todo_update 的 reason(todo_failed 时才有值) */}
      {todo.reason ? (
        <div style={{ paddingLeft: 36 }}>
          <Flag tone="cinnabar">
            <span className="ss-note" style={{ color: "var(--cinnabar)" }}>
              {todo.reason}
            </span>
          </Flag>
        </div>
      ) : null}
    </div>
  );
});

/** 卡片整体状态(头部那一枚 Pill)。只在终态 / 点了中止时变化。 */
function planState(plan: PlanBlockData): StatusVisual {
  if (plan.terminal) {
    return plan.terminal.kind === "done"
      ? { tone: "jade", label: "已完成" }
      : { tone: "cinnabar", label: plan.abortRequested ? "已中止" : "已失败" };
  }
  if (plan.abortRequested) return { tone: "amber", label: "已发送中止" };
  return { tone: "amber", label: "执行中" };
}

export function PlanBlock({ plan }: { plan: PlanBlockData }) {
  const sendAbortPlan = useChatStore((s) => s.sendAbortPlan);
  const state = planState(plan);

  return (
    <div className="sansheng-card" style={{ padding: "10px 14px 12px" }}>
      <Section
        title={"执行计划(" + plan.todos.length + " 步)"}
        aside={<Pill tone={state.tone}>{state.label}</Pill>}
      >
        {plan.todos.length === 0 ? (
          <EmptyState>服务端没有下发任何步骤</EmptyState>
        ) : (
          <div className="flex flex-col">
            {plan.todos.map((todo) => (
              <TodoRow key={todo.id} todo={todo} />
            ))}
          </div>
        )}

        {plan.terminal ? (
          /* 终态:隐藏中止按钮,只留一行收场(数字由 store 从本卡 todos 如实数出) */
          <div className="ss-note" style={{ borderTop: "1px solid var(--ink-2)", paddingTop: 8, color: toneColor(state.tone) }}>
            {plan.terminal.text}
          </div>
        ) : (
          <>
            {/* 中止是**不可撤销**动作:server 会 abort 掉在飞 executor,没有撤销路径。
                提示常驻在按钮旁边,不藏进 title=。 */}
            <div className="flex items-center justify-between gap-3 flex-wrap" style={{ borderTop: "1px solid var(--ink-2)", paddingTop: 8 }}>
              <span className="ss-note">
                {plan.abortRequested
                  ? "中止已发出,正在执行的步骤会停下;已完成的产出保留"
                  : "中止会取消正在执行的步骤,已完成的产出保留"}
              </span>
              <button
                type="button"
                className="sansheng-button flex-none disabled:opacity-40 disabled:cursor-not-allowed"
                disabled={plan.abortRequested}
                onClick={sendAbortPlan}
                title="中止会取消正在执行的步骤,已完成的产出保留(不可撤销)"
                style={{
                  color: plan.abortRequested ? "var(--bone-mute)" : "var(--cinnabar)",
                }}
              >
                {plan.abortRequested ? "已发送中止" : "中止"}
              </button>
            </div>
          </>
        )}
      </Section>
    </div>
  );
}