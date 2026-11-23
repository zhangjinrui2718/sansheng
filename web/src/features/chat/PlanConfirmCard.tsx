/**
 * 「计划」卡 —— D3 硬档(2026-11-17):项目经理拆解出的工作项在甲方**确认开工**
 * 之前不派工(migration 033 的 `works.confirmed_at` + 派工门)。这张卡是甲方
 * 表态的地方:目标 + 验收判据 + 拆解清单 + **确认开工**。
 *
 * ── v5(2026-11-20):它现在长在**对话流里**,不再是头部 band ──────────
 *
 * 旧裁决「提问是状态不是消息(答完之后要从历史里删一条已经发生过的话)」被
 * 2026-11-20 的用户裁决取代:表态卡进流,以**锚定时刻 + 完结塌缩**的方式
 * (锚 = 最新一条未确认工作项的 createdAt,见 `entities/streamCards.ts` 文件头)。
 * 确认之后这张卡塌缩成一行「已确认开工 · N 条」(`plan-confirmed`),历史不删除。
 *
 * ── 「要先调整」 ─────────────────────────────────────────────────
 *
 * 不是按钮分支,是把输入框交还甲方:他说「先不做第 2 项」→ 业务经理转项目经理
 * 改清单(退役/重建工作项)→ 新工作项同样未确认,这张卡按新计数继续等确认。
 *
 * ── 数据 ────────────────────────────────────────────────────────
 *
 * 工作项清单由**调用方提升**(ChatSurface 持有唯一一份 `useWorks`,塌缩行的
 * 批次判据也读它)—— 本组件只收 props,不再自己拉一份。
 * 开关判据是**服务端算好的** `counts.unconfirmedWorks`(调用方传给
 * `streamCardsOf`,那里判 >0 才发卡)—— 不在组件里自己数
 * (计数漂移是这个项目反复吃过的亏)。
 */
import { useState } from "react";
import { confirmWorks } from "@/lib/api";
import { Pill, RedMeta } from "@/components/ui/primitives";
import type { WorkView } from "@shared/types/platform";

export function PlanConfirmCard({
  projectId,
  goal,
  acceptanceCriteria,
  works,
  onConfirmed,
}: {
  projectId: string;
  goal: string;
  /** 结构化验收判据(migration 031;空数组 = 判据还在 goal 文本里,如实不编)。 */
  readonly acceptanceCriteria: readonly string[];
  /** 拆解清单(调用方提升的唯一实例;这里不再自己 fetch)。 */
  readonly works: { data: readonly WorkView[]; loading: boolean; error: string | null };
  /** 确认成功后的收尾(调用方刷新左栏计数;计数归零 ⇒ 卡塌缩)。 */
  onConfirmed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const plan = works.data.filter(
    (w) => w.status === "open" || w.status === "in_progress" || w.status === "blocked",
  );

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await confirmWorks(projectId);
      onConfirmed();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="sansheng-card p-3 w-full"
      style={{ borderColor: "var(--jade)" }}
      data-role="plan-card"
    >
      <div className="flex items-center gap-2" style={{ marginBottom: 8 }}>
        <span style={{ fontSize: 13, color: "var(--bone)", fontWeight: 500 }}>计划</span>
        <Pill tone="amber">等你确认开工</Pill>
      </div>

      {goal.length > 0 && (
        <div className="ss-note" style={{ marginBottom: 6 }}>
          目标:{goal.length > 120 ? `${goal.slice(0, 120)}…` : goal}
        </div>
      )}

      {acceptanceCriteria.length > 0 && (
        <div className="ss-note" style={{ marginBottom: 6 }}>
          验收判据({acceptanceCriteria.length} 条):
          {acceptanceCriteria.map((c, i) => (
            <div key={i} style={{ paddingLeft: 12 }}>
              {`①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮`.charAt(Math.min(i, 14))} {c}
            </div>
          ))}
        </div>
      )}

      <div style={{ marginBottom: 6 }}>
        <div className="ss-meta" style={{ marginBottom: 2 }}>
          拆解({plan.length} 项):
        </div>
        {works.loading ? (
          <div className="ss-meta" style={{ paddingLeft: 12 }}>
            加载中…
          </div>
        ) : works.error !== null ? (
          <div style={{ paddingLeft: 12 }}>
            <RedMeta>读不到拆解清单:{works.error}</RedMeta>
          </div>
        ) : (
          <div className="grid" style={{ gap: 2 }}>
            {plan.map((w, i) => (
              <div key={w.id} style={{ paddingLeft: 12, fontSize: 12 }}>
                <div className="flex items-baseline gap-2">
                  <span className="ss-meta" style={{ flex: "none" }}>
                    {i + 1}
                  </span>
                  <span className="ss-body truncate" style={{ color: "var(--bone)" }} title={w.title}>
                    {w.title}
                  </span>
                  <span className="ss-meta" style={{ flex: "none" }}>
                    {w.assigneeName}
                    {w.dependsOn.length > 0 ? ` · 前置 ${w.dependsOn.length} 项` : " · 无前置"}
                  </span>
                </div>
                {/* 工作项级验收判据(037):给逐条就摆出来 —— 甲方确认的是
                    「这些活做成什么样算完」,不是一列标题。空 = 未给,不编。 */}
                {(w.acceptanceCriteria ?? []).length > 0 && (
                  <div className="ss-meta" style={{ paddingLeft: 18 }}>
                    {(w.acceptanceCriteria ?? []).map((c, j) => (
                      <div key={j} className="truncate" title={c}>
                        {`验收 ${j + 1}:${c}`}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="sansheng-button"
          style={{ padding: "4px 14px", fontSize: 12, background: "var(--jade)", color: "var(--ink-0)" }}
          disabled={busy || works.loading}
          onClick={() => void confirm()}
          title="确认后平台开始派工(排空器下一次轮询接手)"
        >
          确认开工
        </button>
        {error !== null && <RedMeta>{error}</RedMeta>}
      </div>
    </div>
  );
}
