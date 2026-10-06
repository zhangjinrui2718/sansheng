/**
 * 项目摘要侧栏(旧 `AgentPanel` —— 「本会话的 Agent 活动」→ **本项目概览**)
 *
 * ── 为什么不再叫「Agent 活动」────────────────────────────────────
 *
 * 旧侧栏按**工件 author**(planner / executor / harness_manager)聚合出「谁在跑」,
 * 那是旧系统「按 agent 分工」的读法。新模型里活动的主体是**工作项**
 * (`WorkView.status` + `assigneeName`),角色是项目的四个固定职能。所以这一栏答
 * 三个问题:这个项目多大、卡在哪、谁在里面 —— 数据全部来自 `ProjectDetail`,
 * 不再自己从工件里猜角色状态。
 *
 * ── 与「成员」页的分工 ──────────────────────────────────────────
 *
 * 本组件是**摘要**(计数 + 未完成工作项的短列表);职责/L 能力的详情在成员页。
 * 慢速兜底轮询(5s)保留:WS 断流时这一栏是那几秒里唯一的真相。
 */
import { EmptyState, KV, Pill, StatStrip } from "@/components/ui/primitives";
import { useProjectDetail } from "@/lib/data";
import { useChatStore } from "@/stores/chat";
import {
  ROLE_LABEL,
  WORK_ALIVE,
  excerpt,
  projectStatusLabel,
  projectStatusTone,
  workStatusLabel,
  workStatusTone,
} from "@/lib/vocab";

export function AgentPanel() {
  const projectId = useChatStore((s) => s.projectId);
  const { detail, blockers, loading, error } = useProjectDetail(projectId, { pollMs: 5000 });

  const openWorks = detail?.works.filter((w) => WORK_ALIVE.has(w.status)) ?? [];

  return (
    /* `flex-1`:右栏现在有**两块**上下并列(「本项目」+「待答」,见 `App.tsx`
       那一层 flex),这一块要占满剩余高度、内部自己滚,不然两块会各按内容高度
       挤在一起 —— 内容少的时候下半栏会塌掉。 */
    <aside className="sansheng-card overflow-hidden flex flex-col flex-1" style={{ minHeight: 0 }}>
      <div
        className="px-3 py-2 flex items-center justify-between gap-2 flex-none"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <span style={{ fontSize: 12, color: "var(--bone-dim)" }}>本项目</span>
        {detail && <Pill tone={projectStatusTone(detail.status)}>{projectStatusLabel(detail.status)}</Pill>}
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {!projectId ? (
          <EmptyState>先在左栏选一个项目。</EmptyState>
        ) : error ? (
          <div className="ss-empty" style={{ color: "var(--cinnabar)" }}>
            加载失败:{error}
          </div>
        ) : loading && !detail ? (
          /* 没查过 ≠ 查过了是空:首帧必须走这一档。 */
          <EmptyState>加载中…</EmptyState>
        ) : !detail ? (
          <EmptyState>这个项目读不到详情。</EmptyState>
        ) : (
          <>
            <div className="flex flex-col gap-1">
              <div className="ss-body" style={{ color: "var(--bone)" }}>
                {detail.name}
              </div>
              <div className="ss-note">{detail.client || "未填甲方"}</div>
            </div>

            <StatStrip
              items={[
                { label: "工作项", value: `${detail.counts.openWorks}/${detail.counts.works}` },
                { label: "工件", value: detail.counts.artifacts },
                {
                  label: "待答",
                  value: detail.counts.pendingQuestions,
                  tone: detail.counts.pendingQuestions > 0 ? "amber" : undefined,
                },
                {
                  label: "阻塞",
                  value: detail.counts.openBlockers,
                  tone: detail.counts.openBlockers > 0 ? "cinnabar" : undefined,
                },
              ]}
            />

            <div className="flex flex-col">
              <div className="ss-section" style={{ fontSize: 12 }}>
                成员
              </div>
              {detail.members.length === 0 ? (
                <div className="ss-note">还没有成员。</div>
              ) : (
                detail.members.map((m) => (
                  <KV
                    key={m.id}
                    label={ROLE_LABEL[m.role]}
                    value={m.displayName}
                    title={m.specialization ?? undefined}
                  />
                ))
              )}
            </div>

            <div className="flex flex-col">
              <div className="ss-section" style={{ fontSize: 12 }}>
                未完成的工作项
              </div>
              {openWorks.length === 0 ? (
                <div className="ss-note">没有未完成的工作项。</div>
              ) : (
                <ul className="grid gap-1">
                  {openWorks.map((w) => (
                    <li key={w.id} className="flex items-center gap-1.5" title={`${w.title} · ${w.assigneeName}`}>
                      <span className="flex-none">
                        <Pill tone={workStatusTone(w.status)}>{workStatusLabel(w.status)}</Pill>
                      </span>
                      <span className="truncate ss-body" style={{ color: "var(--bone-dim)" }}>
                        {excerpt(w.title, 24)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {blockers.length > 0 && (
              <div className="flex flex-col">
                <div className="ss-section" style={{ fontSize: 12 }}>
                  阻塞
                </div>
                <ul className="grid gap-1">
                  {blockers.map((b) => (
                    <li key={b.id} className="ss-note truncate" title={b.detail}>
                      {excerpt(b.title, 30)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
