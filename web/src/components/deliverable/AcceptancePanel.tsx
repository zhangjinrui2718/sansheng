/**
 * 验收面板 —— 一件交付物的验收操作(复用件,V2)
 *
 * 被**两处**消费(动作只有一份实现):
 *   · 对话页行动区(features/chat/ActionRail)的「验收」展开;
 *   · 工件交付序列页(features/artifacts/ArtifactFlow)的行内验收 ——
 *     2026-11-21「工件一等公民」裁决:验收就发生在工件上。
 *
 * ⚠️ 传进来的恒为「已交付、还没表态」的交付物 —— 裁决之后调用方的行动项
 * /行内表单消失,结果由塌缩行(对话流)与序列行的裁决态承载。
 */
import { useState } from "react";
import { DeliveryVerdictActions } from "./DeliveryVerdictActions";
import { InlineDeliverableBody } from "./InlineDeliverableBody";

export function AcceptancePanel(props: { artifactId: string; title: string }) {
  const [showBody, setShowBody] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <DeliveryVerdictActions
        artifactId={props.artifactId}
        title={props.title}
        acceptance={{ handedOver: true, verdict: null, note: null, at: null, projectClosed: false }}
      />
      <div>
        <button
          type="button"
          className="sansheng-button"
          style={{ padding: "2px 10px", fontSize: 11 }}
          onClick={() => setShowBody((v) => !v)}
          data-role="acceptance-toggle"
        >
          {showBody ? "收起正文" : "查看正文"}
        </button>
      </div>
      {showBody && <InlineDeliverableBody artifactId={props.artifactId} title={props.title} />}
    </div>
  );
}
