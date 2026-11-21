/**
 * 工件交付序列(V2,2026-11-21)—— **工件是一等公民**
 *
 * ── 裁决记录 ────────────────────────────────────────────────────
 * 2026-11-21 用户裁决:「把工件当成一等公民,所有的交互和展示都需要围绕工件
 * 展开,不要再突出角色和工作节点,这些都可以放到以工件为交付序列的内部去」。
 *
 * ⇒ 这个页面就是那个「交付序列」:这个项目**产出了什么**,按时间倒序一条流。
 *   · **交付物大行**:html_report / code_service 是甲方真正拿到手的东西 ——
 *     标题 + 类型 + 裁决态(待验收/已接受/要改/未交付)直接上屏;
 *   · 其余工件常规行:kind 徽标 + 标题 + 作者(小字,过程信息收进来) + 时刻;
 *   · 点行 = 全局抽屉(EntityInspector):事实/关系/内容三段 —— **作者与
 *     「产出于哪条工作项」就在抽屉的事实与关系段里**(实体脊既有判据),
 *     角色与工作项不占一级导航,但一件工件由谁、在哪条活里做出来,点开即达。
 *
 * ⚠️ 四态纪律照旧:读不到 ≠ 没有;未选项目给引导;零工件给空态(新项目
 * 还没产出是常态,不渲染成故障)。
 */
import { useMemo, useState } from "react";
import { useChatStore } from "@/stores/chat";
import { useArtifacts, useProjectDetail } from "@/lib/data";
import { DataState, remoteListOf } from "@/components/ui/DataState";
import { EmptyState } from "@/components/ui/primitives";
import { EntityInspector } from "@/components/shell/EntityInspector";
import { InlineDeliverableBody } from "@/components/deliverable/InlineDeliverableBody";
import { artifactMeta } from "@/lib/entityMeta";
import {
  artifactKindLabel,
  artifactStatusLabel,
  deliverableTypeLabel,
  fmtTime,
} from "@/lib/vocab";
import type { ArtifactView } from "@shared/types/platform";

/** 交付物的裁决态行(甲方视角的那一句话;非交付物没有这一段,显示定稿状态)。 */
function verdictLabelOf(a: ArtifactView): { label: string; color: string } | null {
  if (a.deliverableType === null || a.acceptance === null) return null;
  const acc = a.acceptance;
  if (!acc.handedOver) return { label: "未交付", color: "var(--text-3)" };
  if (acc.verdict === null) return { label: "待你验收", color: "var(--status-wait-acceptance)" };
  if (acc.verdict === "accept") return { label: "已接受", color: "var(--ok)" };
  return { label: "要改", color: "var(--danger)" };
}

export function ArtifactFlowPage() {
  const projectId = useChatStore((s) => s.projectId);
  const intakeActive = useChatStore((s) => s.intakeActive);
  const effectiveProjectId = intakeActive ? null : projectId;

  const detailState = useProjectDetail(effectiveProjectId);
  const artifactsState = useArtifacts({ projectId: effectiveProjectId });
  const [onlyDeliverables, setOnlyDeliverables] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const works = detailState.detail?.works ?? [];
  const inspected = useMemo(
    () => artifactsState.data.find((a) => a.id === openId) ?? null,
    [artifactsState.data, openId],
  );

  return (
    <div className="ss-page" data-role="artifact-flow">
      <h1 className="ss-page-title">工件</h1>

      {effectiveProjectId === null ? (
        <p className="ss-meta">先在左栏选一个项目 —— 工件总是属于某个项目。</p>
      ) : (
        <>
          <div className="flex items-center gap-2 flex-wrap" style={{ marginBottom: 12 }}>
            <span className="ss-meta">
              {detailState.detail ? `${detailState.detail.name} · ` : ""}
              交付物{" "}
              {artifactsState.data.filter((a) => a.deliverableType !== null).length} · 工件{" "}
              {artifactsState.data.length}
            </span>
            <button
              type="button"
              className="sansheng-button"
              style={{ padding: "2px 10px", fontSize: 11, marginLeft: "auto" }}
              data-active={onlyDeliverables ? "true" : undefined}
              onClick={() => setOnlyDeliverables((v) => !v)}
            >
              {onlyDeliverables ? "只看交付物 ✓" : "只看交付物"}
            </button>
          </div>

          <DataState
            what="工件清单"
            state={remoteListOf(artifactsState.data, artifactsState.loading, artifactsState.error)}
            unavailable="读不到这个项目的工件清单。"
          >
            {(all) => {
              const rows = onlyDeliverables
                ? all.filter((a) => a.deliverableType !== null)
                : all;
              if (rows.length === 0) {
                return (
                  <EmptyState>
                    {onlyDeliverables
                      ? "还没有交付物 —— 组织交出成品时会出现在这里。"
                      : "这个项目还没有产出工件 —— 对话立项、确认开工之后,做出来的东西会按时间排在这里。"}
                  </EmptyState>
                );
              }
              const sorted = [...rows].sort((a, b) => b.createdAt - a.createdAt);
              return (
                <div className="flex flex-col gap-1">
                  {sorted.map((a) => {
                    const verdict = verdictLabelOf(a);
                    const isDeliverable = a.deliverableType !== null;
                    return (
                      <button
                        key={a.id}
                        type="button"
                        className="ss-artifact-row"
                        data-deliverable={isDeliverable ? "true" : undefined}
                        onClick={() => setOpenId(a.id)}
                      >
                        <span className="ss-artifact-kind">
                          {isDeliverable
                            ? deliverableTypeLabel(a.deliverableType!)
                            : artifactKindLabel(a.kind)}
                        </span>
                        <span className="ss-artifact-title">{a.title || a.id}</span>
                        {/* 过程信息收进来:作者与时刻是小字元数据,不再是独立页面的主角 */}
                        <span className="ss-artifact-meta">
                          {a.authorName} · {fmtTime(a.createdAt)}
                        </span>
                        {verdict !== null ? (
                          <span className="ss-artifact-verdict" style={{ color: verdict.color }}>
                            {verdict.label}
                          </span>
                        ) : (
                          <span className="ss-artifact-verdict" style={{ color: "var(--text-3)" }}>
                            {artifactStatusLabel(a.status)}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            }}
          </DataState>
        </>
      )}

      {inspected !== null && (
        <EntityInspector
          title={inspected.title || inspected.id}
          items={artifactMeta(inspected, {
            workTitle:
              inspected.workId === null
                ? null
                : (works.find((w) => w.id === inspected.workId)?.title ?? null),
          })}
          subject={{ kind: "artifact", artifact: inspected }}
          context={{
            projectId: effectiveProjectId,
            works: { data: works, loading: detailState.loading, error: detailState.error },
            artifacts: {
              data: artifactsState.data,
              loading: artifactsState.loading,
              error: artifactsState.error,
            },
          }}
          onClose={() => setOpenId(null)}
        >
          <InlineDeliverableBody artifactId={inspected.id} title={inspected.title} />
        </EntityInspector>
      )}
    </div>
  );
}
