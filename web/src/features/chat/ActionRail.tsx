/**
 * 行动区(V2,2026-11-21)—— 四个「等你动作」状态点钉在输入区上方。
 *
 * ── 形态(设计书 §4.1)────────────────────────────────────────
 *   · 位置恒定:长在 ChatComposer 正上方 —— 注意力焦点,不随对话滚动漂移
 *     (v5 流内卡的病就是漂移);仍在「聊天框里」,符合用户既有裁决的精神。
 *   · 每件待办一行:`[状态点] 类型词 · 摘要 [主按钮]`,点行展开操作表单;
 *     表单**复用既有卡身**(ClientQuestionCard / DeliveryVerdictActions /
 *     PlanConfirmCard)—— 动作只有一份实现,这里不重写任何提交逻辑。
 *   · **零待办整区消失**(简约);读不到 ⇒ 一行「读不到」常驻(不静默)。
 *
 * ⚠️ 判据在 `entities/streamCards.ts`(actionItemsOf);本组件只排版。
 * ⚠️ 状态点颜色 = theme.css 的 --status-wait-*(四状态点映射表,唯一一份)。
 */
import { useState } from "react";
import { AcceptancePanel } from "@/components/deliverable/AcceptancePanel";
import { ClientQuestionCard } from "./ClientQuestionCard";
import { PlanConfirmCard } from "./PlanConfirmCard";
import { excerpt } from "@/lib/vocab";
import type { ActionItem } from "@/entities/streamCards";
import { actionItemKey } from "@/entities/streamCards";
import type { PlanCardContext } from "./StreamFacts";

/** 四状态点:类型词 + 主按钮文案 + 状态色(theme.css --status-wait-*)。 */
const ACTION_META: Record<
  ActionItem["type"],
  { label: string; verb: string; color: string }
> = {
  confirm: { label: "确认开工", verb: "确认", color: "var(--status-wait-confirm)" },
  question: { label: "答问", verb: "回答", color: "var(--status-wait-question)" },
  acceptance: { label: "验收", verb: "验收", color: "var(--status-wait-acceptance)" },
  close: { label: "收口", verb: "表态", color: "var(--status-wait-close)" },
};

function summaryOf(item: ActionItem): string {
  switch (item.type) {
    case "confirm":
      return `${item.count} 条工作项等你确认后才动工`;
    case "question":
      return excerpt(item.q.question, 26);
    case "close":
      return "组织提议收口,等你表态";
    case "acceptance":
      return excerpt(item.a.title || item.a.artifactId, 26);
  }
}

export function ActionRail(props: {
  actions: readonly ActionItem[];
  unavailable: string | null;
  plan: PlanCardContext | null;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);

  // 零待办且读得到 ⇒ 整区消失(空态文案不渲染 —— 「没有事等你」不是信息)。
  if (props.actions.length === 0 && props.unavailable === null) return null;

  return (
    <div
      className="flex-none flex flex-col gap-1"
      style={{ padding: "8px 16px 0", borderTop: "1px solid var(--surface-border)" }}
      data-role="action-rail"
    >
      {props.actions.map((item) => {
        const key = actionItemKey(item);
        const meta = ACTION_META[item.type];
        const open = openKey === key;
        return (
          <div key={key} className="ss-action-row" data-action-type={item.type}>
            <button
              type="button"
              className="ss-action-line"
              aria-expanded={open}
              onClick={() => setOpenKey(open ? null : key)}
              title={item.type === "question" || item.type === "close" ? item.q.question : undefined}
            >
              <span
                aria-hidden
                className="ss-action-dot"
                style={{ background: meta.color }}
              />
              <span className="ss-action-label">{meta.label}</span>
              <span className="ss-action-summary">{summaryOf(item)}</span>
              <span className="ss-action-verb">{open ? "收起" : meta.verb}</span>
            </button>
            {open && (
              <div className="ss-action-form">
                {item.type === "confirm" && props.plan !== null && (
                  <PlanConfirmCard
                    projectId={props.plan.projectId}
                    goal={props.plan.goal}
                    acceptanceCriteria={props.plan.acceptanceCriteria}
                    works={props.plan.works}
                    onConfirmed={props.plan.onConfirmed}
                  />
                )}
                {(item.type === "question" || item.type === "close") && (
                  <ClientQuestionCard q={item.q} />
                )}
                {item.type === "acceptance" && (
                  <AcceptancePanel artifactId={item.a.artifactId} title={item.a.title} />
                )}
              </div>
            )}
          </div>
        );
      })}
      {props.actions.length === 0 && props.unavailable !== null && (
        <div className="ss-action-unavailable">{props.unavailable}</div>
      )}
    </div>
  );
}

