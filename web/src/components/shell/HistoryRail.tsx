/**
 * 项目左栏(旧 `HistoryRail` —— 会话列表 → **项目列表**)
 *
 * ── 为什么整块换掉 ──────────────────────────────────────────────
 *
 * 旧左栏列的是**会话**(`GET /api/conversations?limit=50`),每条显示标题 / 预览 /
 * 消息数。新模型里「对话不再独立存在」:项目是一等实体,每个项目一条连续对话。
 * 所以这一栏列的是**项目**(名称 / 状态 / 规模),点一下 = 切上下文。
 *
 * ── 徽标:按项目分组,不是一条混合流 ─────────────────────────────
 *
 * 每个项目显示自己的「待你回答 N 个问题」(来自 `counts.pendingQuestions`,
 * 该字段就是为左栏徽标准备的 —— 契约注释原话)。校准后的裁决是**按项目分组呈现**,
 * 所以这里是一个个项目各自的徽标,而不是把全仓问题混成一条流水账
 * (混合流在「待办」页,那里才有全局队列)。
 *
 * 数据源:store 的 `projects`(由 `GET /api/projects` 填充),`projectsRevision`
 * 打戳时重拉 —— WS 的提问/工作项/工件事件都会递增它。
 */
import { useState } from "react";
import { useChatStore } from "@/stores/chat";
import { Pill } from "@/components/ui/primitives";
import { projectStatusLabel, projectStatusTone, excerpt } from "@/lib/vocab";

export function HistoryRail() {
  const projects = useChatStore((s) => s.projects);
  const projectId = useChatStore((s) => s.projectId);
  const loading = useChatStore((s) => s.projectsLoading);
  const error = useChatStore((s) => s.error);
  const selectProject = useChatStore((s) => s.selectProject);
  const createProject = useChatStore((s) => s.createProject);

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", client: "", goal: "" });
  const [busy, setBusy] = useState(false);

  // 项目列表的加载由 App 统一负责(它在所有路由下都挂着,且按 projectsRevision
  // 重拉)—— 本组件只读 store,不自己 fetch,避免同一份列表在两处各拉一次。

  async function submit() {
    const name = form.name.trim();
    if (!name || busy) return;
    setBusy(true);
    const id = await createProject({
      name,
      client: form.client.trim(),
      goal: form.goal.trim(),
    });
    setBusy(false);
    if (id !== null) {
      setForm({ name: "", client: "", goal: "" });
      setCreating(false);
    }
  }

  return (
    <aside className="sansheng-card overflow-hidden flex flex-col" style={{ minHeight: 0 }}>
      <div
        className="flex items-center justify-between px-3 py-2 flex-none"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <span style={{ fontSize: 12, color: "var(--bone-dim)" }}>项目</span>
        <button
          className="sansheng-button"
          style={{ padding: "2px 8px", fontSize: 11 }}
          onClick={() => setCreating((v) => !v)}
          title="新建项目(项目即上下文容器,每个项目一条连续对话)"
        >
          {creating ? "取消" : "+ 新建"}
        </button>
      </div>

      {creating && (
        <div
          className="px-2.5 py-2 flex flex-col gap-1.5 flex-none"
          style={{ borderBottom: "1px solid var(--ink-3)", background: "var(--ink-1)" }}
        >
          {(
            [
              ["name", "项目名"],
              ["client", "甲方"],
              ["goal", "目标"],
            ] as const
          ).map(([key, label]) => (
            <input
              key={key}
              className="ss-input"
              placeholder={label}
              value={form[key]}
              onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              style={{
                background: "var(--ink-2)",
                border: "1px solid var(--ink-3)",
                borderRadius: 4,
                padding: "3px 6px",
                fontSize: 12,
                color: "var(--bone)",
                outline: "none",
              }}
            />
          ))}
          <button
            className="sansheng-button-primary"
            style={{ padding: "3px 10px", fontSize: 11 }}
            disabled={busy || form.name.trim().length === 0}
            onClick={() => void submit()}
          >
            {busy ? "创建中…" : "创建项目"}
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-1.5 flex flex-col gap-1">
        {error && (
          <div
            className="rounded-md px-3 py-2"
            style={{
              background: "var(--ink-2)",
              border: "1px solid var(--cinnabar)",
              color: "var(--cinnabar)",
              fontSize: 11,
            }}
          >
            加载失败: {error.message}
          </div>
        )}
        {loading && projects.length === 0 && !error && <EmptyState text="加载中…" />}
        {!loading && projects.length === 0 && !error && (
          <EmptyState text="还没有项目。点右上「+ 新建」开一个。" />
        )}

        {projects.map((p) => {
          const isActive = p.id === projectId;
          const pending = p.counts.pendingQuestions;
          return (
            <button
              key={p.id}
              type="button"
              onClick={() => void selectProject(p.id)}
              className="text-left rounded-md px-2.5 py-1.5 transition-colors"
              style={{
                background: isActive ? "var(--ink-2)" : "transparent",
                border: isActive ? "1px solid var(--jade)" : "1px solid transparent",
                borderLeft: isActive ? undefined : "1px solid var(--ink-3)",
                cursor: "pointer",
              }}
              title={`${p.name} · ${p.client || "无甲方"} · 工作项 ${p.counts.openWorks}/${p.counts.works} 未完成 · 工件 ${p.counts.artifacts}`}
            >
              <div className="flex items-baseline justify-between gap-2">
                <span
                  className="font-serif truncate"
                  style={{ fontSize: 13, color: "var(--bone)", letterSpacing: ".04em" }}
                >
                  {p.name}
                </span>
                <span className="flex-none">
                  <Pill tone={projectStatusTone(p.status)}>{projectStatusLabel(p.status)}</Pill>
                </span>
              </div>
              <div className="flex items-baseline gap-2 mt-0.5">
                <span className="truncate flex-1" style={{ fontSize: 11, color: "var(--bone-mute)" }}>
                  {p.goal ? excerpt(p.goal, 40) : p.client || "(无目标)"}
                </span>
                {/* 「待你回答 N 个问题」—— 这个徽标是本栏存在的核心信息,
                    为 0 时不渲染(不摆一个测出来的 0)。 */}
                {pending > 0 && (
                  <span className="flex-none">
                    <Pill tone="amber" title={`${p.name} 有 ${pending} 个问题等你回答`}>
                      待答 {pending}
                    </Pill>
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div
      className="rounded-md flex flex-col items-center justify-center text-center px-4 py-6"
      style={{
        background: "var(--ink-2)",
        border: "1px dashed var(--ink-3)",
        color: "var(--bone-mute)",
      }}
    >
      <div className="font-serif text-base" style={{ color: "var(--bone-dim)", letterSpacing: ".06em" }}>
        缘起
      </div>
      <p className="text-xs mt-1 leading-relaxed">{text}</p>
    </div>
  );
}
