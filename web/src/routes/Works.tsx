/**
 * 工作项屏(新)—— 取代旧的「目标」页
 *
 * 旧页叫「目标」,数据源其实是 intent/todo 工件,文件头自己承认「M7 Goals 子系统
 * 尚未实现,当前为投影视图」。新模型里这件事有真身:**works 是一等实体**
 * (`WorkView`:title / goal / status / assigneeName / dependsOn)。
 *
 * ── 为什么必须先在页面里选项目 ──────────────────────────────────
 *
 * 契约的接口面(platform.ts 末尾)明确**没有**跨项目的 `/api/works`:
 * 「工作项与工件总是属于某个项目,跨项目的同类列表没有使用场景,而提供一个就等于
 * 邀请调用方绕过项目这个组织维度」。所以这一页只列**一个项目**的工作项,项目由
 * 页面顶部的选择器决定(默认跟随对话页当前项目)。要看别的项目就切选择器,
 * 而不是打一个不存在的「全部工作项」端点。
 */
import { useEffect, useState } from "react";
import { EmptyState, PageHeader, Pill, Section, StatStrip } from "@/components/ui/primitives";
import { useWorks } from "@/lib/data";
import { useChatStore } from "@/stores/chat";
import { WORK_ALIVE, excerpt, fmtTime, workStatusLabel, workStatusTone } from "@/lib/vocab";
import type { WorkView } from "@shared/types/platform";

export function WorksPage() {
  const projects = useChatStore((s) => s.projects);
  const activeProjectId = useChatStore((s) => s.projectId);
  const [selected, setSelected] = useState<string | null>(activeProjectId);

  useEffect(() => {
    setSelected(activeProjectId);
  }, [activeProjectId]);

  const { data: works, loading, error } = useWorks(selected);
  const projectName = projects.find((p) => p.id === selected)?.name;

  const alive = works.filter((w) => WORK_ALIVE.has(w.status));
  const settled = works.filter((w) => !WORK_ALIVE.has(w.status));

  return (
    <div className="ss-page">
      <PageHeader
        title="工作项"
        hint={projectName}
        hintTitle="数据来源:GET /api/projects/:id/works。契约没有跨项目的 /api/works —— 工作项总是属于某个项目。状态取值来自契约 WorkStatus。"
        aside={
          <div className="flex items-center gap-2 flex-wrap">
            <select
              value={selected ?? ""}
              onChange={(e) => setSelected(e.target.value === "" ? null : e.target.value)}
              style={{
                background: "var(--ink-1)",
                border: "1px solid var(--ink-3)",
                borderRadius: 4,
                padding: "2px 4px",
                color: "var(--bone-dim)",
                fontSize: 11,
              }}
              title="选择项目"
            >
              <option value="">选择项目…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {works.length > 0 && (
              <StatStrip
                items={[
                  { label: "总数", value: works.length },
                  { label: "未完成", value: alive.length, tone: alive.length > 0 ? "amber" : undefined },
                ]}
              />
            )}
          </div>
        }
      />

      {selected === null ? (
        <EmptyState>先在「对话」页的左栏选一个项目,或在上面的选择器里挑一个。</EmptyState>
      ) : error !== null ? (
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      ) : loading && works.length === 0 ? (
        <EmptyState>加载中…</EmptyState>
      ) : works.length === 0 ? (
        <EmptyState>这个项目还没有工作项。项目经理会把目标拆成工作项。</EmptyState>
      ) : (
        <div className="grid gap-4">
          <Section title="未完成" count={alive.length} hint="先看还有什么事">
            {alive.length === 0 ? (
              <EmptyState>没有未完成的工作项。</EmptyState>
            ) : (
              <div className="grid gap-1.5">
                {[...alive]
                  .sort((a, b) => b.updatedAt - a.updatedAt)
                  .map((w) => (
                    <WorkRow key={w.id} w={w} />
                  ))}
              </div>
            )}
          </Section>

          {settled.length > 0 && (
            <Section title="已收口" count={settled.length}>
              <div className="grid gap-1.5">
                {[...settled]
                  .sort((a, b) => b.updatedAt - a.updatedAt)
                  .map((w) => (
                    <WorkRow key={w.id} w={w} muted />
                  ))}
              </div>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function WorkRow({ w, muted = false }: { w: WorkView; muted?: boolean }) {
  return (
    <article
      className="sansheng-card p-2.5"
      style={muted ? { opacity: 0.65 } : undefined}
      title={w.id}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Pill tone={workStatusTone(w.status)}>{workStatusLabel(w.status)}</Pill>
        <span className="ss-body" style={{ color: "var(--bone)" }}>
          {w.title}
        </span>
        <span className="ss-meta ml-auto">{w.assigneeName || w.assigneeAgentId}</span>
      </div>
      {w.goal.length > 0 && w.goal !== w.title && <div className="ss-note mt-0.5">{excerpt(w.goal, 110)}</div>}
      <div className="ss-meta mt-0.5">
        更新 {fmtTime(w.updatedAt)}
        {w.dependsOn.length > 0 && ` · 依赖 ${w.dependsOn.length} 项:${w.dependsOn.join(", ")}`}
      </div>
    </article>
  );
}
