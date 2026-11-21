/**
 * 对话流里的**表态卡**(v5,2026-11-20)—— 「等你表态」从右栏收件箱搬进消息流。
 *
 * ── 渲染分两类,视觉语言刻意分开 ────────────────────────────────
 *
 *   · **可操作的卡**(提问 / 验收 / 计划)= 实体卡(`sansheng-card`),
 *     复用既有卡身:`ClientQuestionCard`(收口提议也由它按 intent 分叉)、
 *     `DeliveryVerdictActions`、`PlanConfirmCard` —— 动作只有一份实现,
 *     这里不重写任何提交逻辑。
 *   · **塌缩的事实行**(已答复 / 已裁决 / 已确认开工)= 居中的小字行,
 *     与 `HiddenNotice` 同一格语言:它不是消息、不再可操作,只是**留在原地的
 *     事实**(锚定时刻见 `lib/streamCards.ts` 文件头)。
 *
 * ── 诚实纪律(从 Inbox 原样继承)────────────────────────────────
 *
 * 加载中/读失败不许渲染成「没有」:卡只在数据到终值时出现(`streamCardsOf`
 * 的判据),空态文案在流里**退场**;读失败由 `cardsUnavailableOf` 的那一行
 * 在流尾如实说(调用方传入)。已收口项目的提问只数不渲染 —— 计数落点仍是
 * 项目页「待你回答」。
 */
import { DeliveryVerdictActions } from "@/components/deliverable/DeliveryVerdictActions";
import { ClientQuestionCard } from "@/components/client/ClientQuestionCard";
import { PlanConfirmCard } from "./PlanConfirmCard";
import { Pill } from "@/components/ui/primitives";
import { useState } from "react";
import { deliverableTypeLabel, deliverableTypeTone, excerpt, fmtTime } from "@/lib/vocab";
import type { StreamCard } from "@/lib/streamCards";
import { InlineDeliverableBody } from "@/components/deliverable/InlineDeliverableBody";
import type { AwaitingAcceptanceView, WorkView } from "@shared/types/platform";

/** 计划卡需要的上下文(ChatSurface 持有,经 MessageList 传到这里)。 */
export interface PlanCardContext {
  projectId: string;
  goal: string;
  acceptanceCriteria: readonly string[];
  works: { data: readonly WorkView[]; loading: boolean; error: string | null };
  onConfirmed: () => void;
}

/**
 * 验收卡(可操作)—— 元信息 + 裁决动作 + **「查看正文」展开段**(v5 Wave B)。
 *
 * 展开态是组件内状态(不进 store,与 `InternalProcessBlock` 同一条理由:
 * 展开是阅读姿势,不是事实)。正文懒加载:点开才挂 `InlineDeliverableBody`
 * (它自己再取工件详情),流不背常驻请求。
 */
export function AcceptanceCard({ a }: { a: AwaitingAcceptanceView }) {
  const [open, setOpen] = useState(false);
  return (
    <article
      className="sansheng-card p-3 w-full"
      data-role="stream-acceptance"
      title={a.artifactId}
    >
      <div className="flex items-center gap-1.5 flex-wrap">
        <Pill tone="jade">验收</Pill>
        {a.deliverableType !== null && (
          <Pill tone={deliverableTypeTone(a.deliverableType)} title="deliverable_type">
            {deliverableTypeLabel(a.deliverableType)}
          </Pill>
        )}
        <span className="ss-body" style={{ color: "var(--bone)" }}>
          {a.title || "(无标题)"}
        </span>
        <span className="ss-meta ml-auto">交付于 {fmtTime(a.deliveredAt)}</span>
      </div>
      <DeliveryVerdictActions
        artifactId={a.artifactId}
        title={a.title}
        // awaitingAcceptance 只含「已交付、还没表态」的;verdict/note 由裁决后
        // 的塌缩行(`verdict`)承载,这里恒为未表态。
        acceptance={{ handedOver: true, verdict: null, note: null, at: null, projectClosed: false }}
      />
      <div className="mt-1.5 flex flex-col gap-1.5">
        <div>
          <button
            type="button"
            className="sansheng-button"
            style={{ padding: "2px 10px", fontSize: 11 }}
            onClick={() => setOpen((v) => !v)}
            data-role="acceptance-toggle"
          >
            {open ? "收起正文" : "查看正文"}
          </button>
        </div>
        {open && <InlineDeliverableBody artifactId={a.artifactId} title={a.title} />}
      </div>
    </article>
  );
}

export function StreamCardView({
  card,
  plan,
}: {
  card: StreamCard;
  plan: PlanCardContext | null;
}) {
  switch (card.kind) {
    case "question":
      return (
        <div className="w-full flex" data-role="stream-question">
          {/* 收口提议(intent="close")由 ClientQuestionCard 内部分叉渲染,
              两类卡共用同一份提交逻辑 —— 这里不再多一层判据。 */}
          <ClientQuestionCard q={card.q} />
        </div>
      );
    case "answered":
      return (
        <div className="flex justify-center" data-role="stream-answered">
          <div className="ss-note" style={{ fontSize: 11, textAlign: "center" }}>
            {card.consumed
              ? `已答复「${excerpt(card.question, 20)}」 · 已落 decision 工件`
              : `已答复「${excerpt(card.question, 20)}」 · 整理中`}
          </div>
        </div>
      );
    case "acceptance":
      return <AcceptanceCard a={card.a} />;
    case "verdict":
      return (
        <div className="flex justify-center" data-role="stream-verdict">
          <div className="ss-note" style={{ fontSize: 11, textAlign: "center" }}>
            {`${card.verdict === "accept" ? "已接受" : "要改"}「${excerpt(card.title, 20)}」${
              card.note !== null && card.note.length > 0 ? ` · ${excerpt(card.note, 30)}` : ""
            } · ${fmtTime(card.at)}`}
          </div>
        </div>
      );
    case "plan":
      return plan === null ? null : (
        <div className="w-full flex" data-role="stream-plan">
          <PlanConfirmCard
            projectId={plan.projectId}
            goal={plan.goal}
            acceptanceCriteria={plan.acceptanceCriteria}
            works={plan.works}
            onConfirmed={plan.onConfirmed}
          />
        </div>
      );
    case "plan-confirmed":
      return (
        <div className="flex justify-center" data-role="stream-plan-confirmed">
          <div className="ss-note" style={{ fontSize: 11, textAlign: "center" }}>
            {`已确认开工 · ${card.count} 条`}
          </div>
        </div>
      );
  }
}
