/**
 * 待你验收面板 —— 甲方对一份交付物**点头 / 摇头**的那一下(029)
 *
 * ── 它从「项目」页搬到了对话页右栏(用户裁决)───────────────────────
 *
 * 原先它是「项目」页里的一张 Section。搬家的理由与「待答」搬到右栏是**同一条**
 * (见 `ClientQuestionDock.tsx` 的文件头):**它是球在甲方那边的那一刻** ——
 * 交付物已经交到你手上了,组织这边没有任何人会再动它,直到你说收或不收。
 * 而甲方 90% 的时间在「对话」页。放远了就等于「有事在等你」没人知道 ——
 * 真机第一条 `client_question` 就是这么被漏掉的。
 *
 * 位置:**右栏三块的中间**,「本项目」下面、「待答」上面。两边都是
 * 「需要甲方动手」的事,挨着放 ⇒ 甲方在这一列里把「等我的」一次看全。
 *
 * ── 判据只有一条,而且是服务端给的 ────────────────────────────────
 *
 * `detail.awaitingAcceptance` = **已交付**(`project_sessions.deliverable_artifact_id`
 * 非空)**且 `delivery_verdicts` 里没有裁决**。与收口门、`project_close` 门读的
 * 是同一个 `deliveryAcceptance()`。⚠️ **已收口项目这一块恒空**
 * (`views.ts` 的 `awaitingAcceptanceOf` 对终态项目直接返回 `[]`)——
 * 收口不可逆,验收接口一律 409,给按钮就是给一件做不到的事。
 *
 * ── 为什么卡片上那个 `acceptance` 不是「编出来的」──────────────────
 *
 * 能出现在这张清单里的,**按定义**就是 `handedOver && verdict === null && 未收口`。
 * 那三个字段是**这条清单的判据本身**,不是乐观的默认值 —— 组件自己还有三道
 * 分支(`DeliveryVerdictActions.tsx`:未交付 / 已收口 / 已裁决),在这里永远走
 * 「等你验收 + 两个按钮」那一支。
 *
 * ── 为什么不做成折叠 ──────────────────────────────────────────────
 *
 * 与「待答」同一个理由:它平时就是空的,折叠按钮会变成一个永远点得着却永远
 * 没用的控件。有件可验收时它自己占高(`maxHeight` 封顶、内部滚)。
 */
import { useMemo } from "react";
import { DeliveryVerdictActions } from "@/components/deliverable/DeliveryVerdictActions";
import { Pill } from "@/components/ui/primitives";
import { deliverableTypeLabel, deliverableTypeTone, fmtTime } from "@/lib/vocab";
import type { ProjectDetailState } from "@/lib/data";
import type { AwaitingAcceptanceView } from "@shared/types/platform";

export function AcceptanceDock({ state }: { state: ProjectDetailState }) {
  const { projectId, detail, loading, error } = state;
  const items = useMemo<readonly AwaitingAcceptanceView[]>(
    () => detail?.awaitingAcceptance ?? [],
    [detail],
  );
  const count = items.length;

  /* ⚠️ **「没有」只能在真的知道没有的时候说**。这一格第一次写成 `count === 0` 就
     把「还没查过」「读失败」「没选项目」三种情况一并渲染成「没有等你验收的
     东西」—— 而它们与「货已经收完了」在屏幕上**长得一模一样**,那正是这个项目
     反复吃亏的那类静默失败(与 `ProjectLiveView` 的 `runtime: "unavailable"`
     同一条纪律)。回归在 `tests/web/acceptance-dock.test.ts` ①。 */
  const knownEmpty = projectId !== null && error === null && detail !== null && count === 0;

  return (
    /* `flex-none` + `maxHeight` 封顶:这一块**不能吃掉右栏**(「本项目」要能滚)。
       有件可验收时才给高度 —— 空的时候它只占一条头,见 `App.tsx` 那层 flex。 */
    <section
      className="sansheng-card overflow-hidden flex flex-col flex-none"
      style={{ maxHeight: count > 0 ? "35%" : undefined }}
    >
      <div
        className="px-3 py-2 flex items-center gap-2 flex-none"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <span style={{ fontSize: 12, color: "var(--bone-dim)" }}>待你验收</span>
        {count > 0 ? (
          <Pill tone="amber">{count} 件等你表态</Pill>
        ) : knownEmpty ? (
          <span className="ss-meta">没有等你验收的东西</span>
        ) : (
          <span className="ss-meta" title="还没查到 / 读不到,不是「没有」">
            还没查到
          </span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {projectId === null ? (
          <div className="ss-meta">先在左栏选一个项目。</div>
        ) : error !== null ? (
          <div className="ss-meta" style={{ color: "var(--cinnabar)" }}>
            加载失败:{error}
          </div>
        ) : loading && detail === null ? (
          /* 没查过 ≠ 查过了是空:首帧必须走这一档,否则一次慢请求会被读成「没有」。 */
          <div className="ss-meta">加载中…</div>
        ) : count === 0 ? (
          <div className="ss-meta">没有等你验收的东西 —— 交付出去的都收了。</div>
        ) : (
          items.map((a) => <DockCard key={a.artifactId} a={a} />)
        )}
      </div>

      {/* 这一行是**判据**,不是装饰:模型写在工件上的 `accepted` 是「定稿」,
          收不收由甲方说 —— 两件事分不清就会出现「作者自己批了自己的交付」。 */}
      <div className="ss-meta px-3 py-1 flex-none" title="来源:ProjectDetail.awaitingAcceptance(029)">
        这里点了才算数 —— 工件上的「定稿」不是你的验收
      </div>
    </section>
  );
}

/** 一份等你表态的交付物。**不标项目名** —— 这一块就在「本项目」下面,标出来是噪音。 */
function DockCard({ a }: { a: AwaitingAcceptanceView }) {
  return (
    <article className="sansheng-card p-2" title={a.artifactId}>
      <div className="flex items-center gap-1.5 flex-wrap">
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
        acceptance={{
          handedOver: true, verdict: null, note: null, at: null,
          // 见文件头:「能出现在这张清单里」本身就是这条判据 ⇒ `false` 是推论。
          projectClosed: false,
        }}
      />
    </article>
  );
}