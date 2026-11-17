/**
 * 「等你表态」收件箱(R-A,2026-11-17 IA v4)—— 待你验收 + 待答 + 收口提议
 * **融合成一个队列**。
 *
 * ── 为什么融合 ──────────────────────────────────────────────────
 *
 * 三类卡片回答的是**同一个问题**:「有什么在等我拍板」。此前它们分居两个 dock
 * (待你验收 / 待答),各自一份标题、一份计数、一份空态 —— 甲方要扫两块才能
 * 确定「我没欠账」。融合后:**一条队列、一个计数、一套卡片语言**
 * (类型徽章 + 主体 + 动作),按**最老优先**排序。
 *
 * ── 三类与它们的动作 ────────────────────────────────────────────
 *
 *   · 「验收」   —— 已交付、未裁决的交付物:通过 / 要改 / 查看
 *   · 「提问」   —— 业务经理的问题(锚定判据):选项或自由作答
 *   · 「收口提议」—— intent="close" 的提问:同意收口 / 先不收(走 consent 端点)
 *
 * ── 诚实纪律(原两条 dock 的判据原样继承)────────────────────────
 *
 *   · 「暂无」只能在**真的拿到终值**时说;加载中/读失败显示加载与错误,
 *     不许渲染成「没有」;
 *   · 已收口项目的提问**只数不渲染**(它们兑现不了 —— 排空器不跑终态项目),
 *     计数行必须显示(不许静默丢弃);
 *   · F3:「已答复、业务经理还没处置」的窗口也要报出来。
 *
 * 数据由 `ChatRightRail` 提升取数(详情 + 提问清单各一份实例),这里只收 props。
 */
import { DeliveryVerdictActions } from "@/components/deliverable/DeliveryVerdictActions";
import { ClientQuestionCard } from "@/components/client/ClientQuestionCard";
import { Pill } from "@/components/ui/primitives";
import { Help } from "@/components/ui/Help";
import { DataState, remoteListOf } from "@/components/ui/DataState";
import { artifactLocation } from "@/lib/entityMeta";
import { toHash } from "@/lib/route";
import { deliverableTypeLabel, deliverableTypeTone, fmtTime } from "@/lib/vocab";
import { scopeClientQuestions } from "@/lib/questionScope";
import type { useClientQuestions, ProjectDetailState } from "@/lib/data";
import type { ClientQuestionView, AwaitingAcceptanceView } from "@shared/types/platform";

type InboxItem =
  | { kind: "acceptance"; at: number; a: AwaitingAcceptanceView }
  | { kind: "question"; at: number; q: ClientQuestionView }
  | { kind: "close"; at: number; q: ClientQuestionView };

const KIND_LABEL = {
  acceptance: "验收",
  question: "提问",
  close: "收口提议",
} as const;

/** 队列总数 + 「整栏可隐藏」判据(R-A:两处取数都拿到终值且全空 ⇒ 隐藏)。 */
export function inboxCount(
  state: ProjectDetailState,
  questions: ReturnType<typeof useClientQuestions>,
  projectId: string | null,
): { total: number; knownEmpty: boolean } {
  const awaiting = state.detail?.awaitingAcceptance ?? [];
  const { items: asked } = scopeClientQuestions(questions.data, questions.closedProjectQuestions, projectId);
  const answeredPending = projectId !== null ? (questions.answeredUnconsumed[projectId] ?? 0) : 0;
  const total = awaiting.length + asked.length;
  const knownEmpty =
    projectId !== null &&
    state.error === null &&
    state.detail !== null &&
    !questions.loading &&
    questions.error === null &&
    total === 0 &&
    answeredPending === 0;
  return { total, knownEmpty };
}

export function InboxPanel({
  state,
  questions,
  projectId,
}: {
  state: ProjectDetailState;
  questions: ReturnType<typeof useClientQuestions>;
  projectId: string | null;
}) {
  const awaiting: AwaitingAcceptanceView[] = state.detail?.awaitingAcceptance ?? [];
  const { items: asked, closedCount } = scopeClientQuestions(
    questions.data,
    questions.closedProjectQuestions,
    projectId,
  );
  const answeredPending = projectId !== null ? (questions.answeredUnconsumed[projectId] ?? 0) : 0;

  const items: InboxItem[] = (
    [
      ...awaiting.map((a): InboxItem => ({ kind: "acceptance", at: a.deliveredAt, a })),
      ...asked.map((q): InboxItem =>
        q.intent === "close"
          ? { kind: "close", at: q.createdAt, q }
          : { kind: "question", at: q.createdAt, q },
      ),
    ] as InboxItem[]
  ).sort((x, y) => x.at - y.at);

  const total = items.length;
  const knownEmpty =
    state.error === null &&
    state.detail !== null &&
    !questions.loading &&
    questions.error === null &&
    total === 0;

  return (
    <section
      className="sansheng-card overflow-hidden flex flex-col flex-none"
      style={{ maxHeight: total > 2 ? "62%" : undefined }}
      data-role="inbox"
    >
      <div
        className="px-3 py-2 flex items-center gap-2 flex-none"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <span style={{ fontSize: 12, color: "var(--bone-dim)" }}>等你表态</span>
        {total > 0 ? (
          <Pill tone="amber">{total} 件等你拍板</Pill>
        ) : knownEmpty ? (
          <span className="ss-meta">暂无待表态</span>
        ) : (
          <span className="ss-meta">加载中…</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {projectId === null ? (
          <div className="ss-meta">未选项目</div>
        ) : (
          /* 四态一处:加载/错误/空/ ready 由 DataState 承担(没拿到数据就拿不到 rows)。 */
          <DataState
            what="等你表态"
            state={remoteListOf(items, questions.loading || state.detail === null, state.error ?? questions.error)}
            variant="note"
          >
            {(rows) =>
              rows.length === 0 ? (
                <div className="ss-meta">暂无待表态</div>
              ) : (
                rows.map((item) =>
            item.kind === "acceptance" ? (
              <article key={item.a.artifactId} className="sansheng-card p-2" title={item.a.artifactId}>
                <div className="flex items-center gap-1.5 flex-wrap">
                  <Pill tone="jade">{KIND_LABEL.acceptance}</Pill>
                  {item.a.deliverableType !== null && (
                    <Pill tone={deliverableTypeTone(item.a.deliverableType)} title="deliverable_type">
                      {deliverableTypeLabel(item.a.deliverableType)}
                    </Pill>
                  )}
                  <span className="ss-body" style={{ color: "var(--bone)" }}>
                    {item.a.title || "(无标题)"}
                  </span>
                  <span className="ss-meta ml-auto">交付于 {fmtTime(item.a.deliveredAt)}</span>
                </div>
                <DeliveryVerdictActions
                  artifactId={item.a.artifactId}
                  title={item.a.title}
                  acceptance={{
                    handedOver: true, verdict: null, note: null, at: null,
                    projectClosed: false,
                  }}
                />
                <div className="ss-meta">
                  <a
                    href={toHash(artifactLocation(item.a.artifactId))}
                    title="到工作项页的工件抽屉读正文"
                    style={{ color: "var(--cyan)", textDecoration: "underline dotted" }}
                  >
                    查看
                  </a>
                </div>
              </article>
            ) : (
              <div key={item.q.id} className="flex flex-col gap-1">
                <span style={{ paddingLeft: 2 }}>
                  <Pill tone={item.kind === "close" ? "amber" : "cyan"}>{KIND_LABEL[item.kind]}</Pill>
                </span>
                <ClientQuestionCard q={item.q} />
              </div>
            ),
          )
        )}
      </DataState>
        )}
      </div>

      {answeredPending > 0 && (
        <div
          className="ss-meta px-3 py-1 flex-none"
          style={{ borderTop: "1px solid var(--ink-3)" }}
          data-answered-unconsumed={answeredPending}
          title="业务经理消化掉之后,这一行会消失"
        >
          已答复 {answeredPending} 条 · 业务经理整理中
        </div>
      )}

      {closedCount > 0 && (
        <div
          className="ss-meta px-3 py-1 flex-none flex items-center gap-1"
          style={{ borderTop: "1px solid var(--ink-3)", color: "var(--ochre)" }}
          data-from-closed-projects={closedCount}
          title="项目已收口 · 不会再有人来处理,事实仍在项目页"
        >
          <span>已收口项目 {closedCount} 条</span>
          <Help id="client-question.closed" />
        </div>
      )}
    </section>
  );
}
