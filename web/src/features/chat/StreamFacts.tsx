/**
 * 对话流里的**塌缩事实行**(V2)—— 完结表态留在发生时刻,居中小字。
 *
 * ── 变更记录 ────────────────────────────────────────────────────
 * v5 的可操作卡(提问/验收/计划)在 V2 搬进**行动区**(ActionRail,钉在输入区
 * 上方);流里只留塌缩事实(已答复/已裁决/已确认开工)—— 与 `HiddenNotice`
 * 同一格语言:它不是消息、不再可操作,只是**留在原地的历史事实**。
 * 判据在 `entities/streamCards.ts` 的 `streamFactsOf`(锚定时刻见其文件头)。
 *
 * ⚠️ `PlanCardContext` 仍从这里导出(行动区与 ChatSurface 共用这个形状)。
 */
import { excerpt, fmtTime } from "@/lib/vocab";
import type { StreamFact } from "@/entities/streamCards";
import type { WorkView } from "@shared/types/platform";

/** 计划行动项需要的上下文(ChatSurface 持有,传给 ActionRail 的展开表单)。 */
export interface PlanCardContext {
  projectId: string;
  goal: string;
  acceptanceCriteria: readonly string[];
  works: { data: readonly WorkView[]; loading: boolean; error: string | null };
  onConfirmed: () => void;
}

export function StreamFactView({ fact }: { fact: StreamFact }) {
  switch (fact.kind) {
    case "answered":
      return (
        <div className="flex justify-center" data-role="stream-answered">
          <div className="ss-note" style={{ fontSize: 11, textAlign: "center" }}>
            {fact.consumed
              ? `已答复「${excerpt(fact.question, 20)}」 · 已落 decision 工件`
              : `已答复「${excerpt(fact.question, 20)}」 · 整理中`}
          </div>
        </div>
      );
    case "verdict":
      return (
        <div className="flex justify-center" data-role="stream-verdict">
          <div className="ss-note" style={{ fontSize: 11, textAlign: "center" }}>
            {`${fact.verdict === "accept" ? "已接受" : "要改"}「${excerpt(fact.title, 20)}」${
              fact.note !== null && fact.note.length > 0 ? ` · ${excerpt(fact.note, 30)}` : ""
            } · ${fmtTime(fact.at)}`}
          </div>
        </div>
      );
    case "plan-confirmed":
      return (
        <div className="flex justify-center" data-role="stream-plan-confirmed">
          <div className="ss-note" style={{ fontSize: 11, textAlign: "center" }}>
            {`已确认开工 · ${fact.count} 条`}
          </div>
        </div>
      );
  }
}
