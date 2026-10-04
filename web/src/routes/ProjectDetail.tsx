/**
 * 项目详情屏(新)
 *
 * 一个项目「是什么、谁在做、做到哪、卡在哪、等我答什么」—— 五件事一屏说完。
 * 数据全部来自两个只读端点,由 `useProjectDetail` 统一读取:
 *
 *   GET /api/projects/:id          → ProjectDetail(目标 / 成员 / 工作项 / 待答问题)
 *   GET /api/projects/:id/blockers → 阻塞列表(「哪件事被卡住了」)
 *
 * 反造假纪律:没有就显示空态,不摆 0 占位、不造示例行;每个计数都来自本次真实数组
 * 的 length。工作项的 DAG 入边(`dependsOn`)只在存在时标注,不画一张空图。
 */
import { PageHeader, Pill, Section, StatStrip, EmptyState, KV } from "@/components/ui/primitives";
import { ClientQuestionCard } from "@/components/client/ClientQuestionCard";
import { useProjectDetail } from "@/lib/data";
import { useChatStore } from "@/stores/chat";
import {
  ROLE_LABEL,
  blockerSeverityLabel,
  blockerSeverityTone,
  blockerStatusLabel,
  blockerStatusTone,
  excerpt,
  fmtTime,
  projectStatusLabel,
  projectStatusTone,
  workStatusLabel,
  workStatusTone,
} from "@/lib/vocab";

export function ProjectDetailPage() {
  const projectId = useChatStore((s) => s.projectId);
  const { detail, blockers, loading, error } = useProjectDetail(projectId);

  if (!projectId) {
    return (
      <div className="ss-page">
        <PageHeader title="项目" />
        <EmptyState>先在「对话」页的左栏选一个项目。</EmptyState>
      </div>
    );
  }

  return (
    <div className="ss-page">
      <PageHeader
        title={detail?.name ?? "项目"}
        hint={detail ? (detail.client ? `甲方 ${detail.client}` : undefined) : undefined}
        hintTitle="数据来源:GET /api/projects/:id 与 GET /api/projects/:id/blockers。"
        aside={
          detail ? (
            <StatStrip
              items={[
                { label: "状态", value: projectStatusLabel(detail.status), tone: projectStatusTone(detail.status) },
                { label: "工作项", value: `${detail.counts.openWorks}/${detail.counts.works}` },
                { label: "工件", value: detail.counts.artifacts },
                {
                  label: "待答",
                  value: detail.counts.pendingQuestions,
                  tone: detail.counts.pendingQuestions > 0 ? "amber" : undefined,
                },
              ]}
            />
          ) : undefined
        }
      />

      {error !== null ? (
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      ) : loading && !detail ? (
        <EmptyState>加载中…</EmptyState>
      ) : !detail ? (
        <EmptyState>读不到这个项目。</EmptyState>
      ) : (
        <>
          <Section title="目标">
            {detail.goal.length > 0 ? (
              <div className="sansheng-card p-3 ss-body" style={{ color: "var(--bone)" }}>
                {detail.goal}
              </div>
            ) : (
              <EmptyState>这个项目还没写目标。</EmptyState>
            )}
          </Section>

          <Section title="成员" count={detail.members.length}>
            {detail.members.length === 0 ? (
              <EmptyState>还没有成员。四个角色:业务经理 / 项目经理 / 执行者 / 质检审查员。</EmptyState>
            ) : (
              <div className="sansheng-card px-3 py-1.5">
                {detail.members.map((m) => (
                  <KV
                    key={m.id}
                    label={ROLE_LABEL[m.role]}
                    value={m.displayName}
                    title={m.specialization !== null ? `专长 ${m.specialization} · ${m.id}` : m.id}
                  />
                ))}
              </div>
            )}
          </Section>

          <Section
            title="工作项"
            count={detail.works.length}
            hint="项目经理把目标拆成的工作项"
            hintTitle="状态取值来自契约 WorkStatus(open|in_progress|blocked|done|failed|cancelled)。"
          >
            {detail.works.length === 0 ? (
              <EmptyState>还没有工作项。</EmptyState>
            ) : (
              <div className="grid gap-1.5">
                {detail.works.map((w) => (
                  <article key={w.id} className="sansheng-card p-2.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Pill tone={workStatusTone(w.status)}>{workStatusLabel(w.status)}</Pill>
                      <span className="ss-body" style={{ color: "var(--bone)" }}>
                        {w.title}
                      </span>
                      <span className="ss-meta ml-auto">{w.assigneeName || w.assigneeAgentId}</span>
                    </div>
                    {w.goal.length > 0 && w.goal !== w.title && (
                      <div className="ss-note mt-0.5" title={w.goal}>
                        {excerpt(w.goal, 90)}
                      </div>
                    )}
                    <div className="ss-meta mt-0.5">
                      {fmtTime(w.createdAt)}
                      {w.dependsOn.length > 0 && ` · 依赖 ${w.dependsOn.length} 项`}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Section>

          <Section
            title="待你回答"
            count={detail.pendingQuestions.length}
            hint="答完落成 decision 工件"
            hintTitle="来源:ProjectDetail.pendingQuestions(kind = client_question 的工件)。它是持久的 —— 关掉页面下次还看得见。"
          >
            {detail.pendingQuestions.length === 0 ? (
              <EmptyState>没有等甲方回答的问题。</EmptyState>
            ) : (
              <div className="grid gap-2">
                {detail.pendingQuestions.map((q) => (
                  <ClientQuestionCard key={q.id} q={q} />
                ))}
              </div>
            )}
          </Section>

          <Section
            title="阻塞"
            count={blockers.length}
            hint="卡住了哪些工作项"
            hintTitle="来源:GET /api/projects/:id/blockers。severity / status 取值来自契约的 BlockerSeverity / BlockerStatus。"
          >
            {blockers.length === 0 ? (
              <EmptyState>没有登记在案的阻塞。</EmptyState>
            ) : (
              <div className="grid gap-1.5">
                {blockers.map((b) => (
                  <article key={b.id} className="sansheng-card p-2.5">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Pill tone={blockerSeverityTone(b.severity)}>{blockerSeverityLabel(b.severity)}</Pill>
                      <Pill tone={blockerStatusTone(b.status)}>{blockerStatusLabel(b.status)}</Pill>
                      <span className="ss-body" style={{ color: "var(--bone)" }}>
                        {b.title}
                      </span>
                      <span className="ss-meta ml-auto">{b.raisedByName}</span>
                    </div>
                    {b.detail.length > 0 && (
                      <div className="ss-note mt-0.5" title={b.detail}>
                        {excerpt(b.detail, 90)}
                      </div>
                    )}
                    <div className="ss-meta mt-0.5">
                      {fmtTime(b.createdAt)}
                      {b.blockedWorkIds.length > 0 && ` · 卡住 ${b.blockedWorkIds.length} 个工作项`}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}
