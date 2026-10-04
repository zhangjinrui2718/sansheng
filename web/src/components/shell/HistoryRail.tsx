/**
 * 项目左栏(旧 `HistoryRail` —— 会话列表 → **项目列表**)
 *
 * ── 为什么整块换掉 ──────────────────────────────────────────────
 *
 * 旧左栏列的是**会话**(`GET /api/conversations?limit=50`),每条显示标题 / 预览 /
 * 消息数。新模型里「对话不再独立存在」:项目是一等实体,每个项目一条连续对话。
 * 所以这一栏列的是**项目**(名称 / 状态 / 规模),点一下 = 切上下文。
 *
 * ── 「+ 新建」不再是表单 ────────────────────────────────────────
 *
 * 上一版点「+ 新建」弹的是 name / client / goal 三个输入框 —— 用户提交时撞上
 * `project_open` 的参数校验,报「goal 不能为空」。那是**让甲方替业务经理立项**:
 * 立项是业务经理的动作。所以现在这个按钮切到**接待会话**(`startIntake()`):
 * 用户与业务经理说想要什么,谈拢之后由业务经理调 `project_open`,
 * 服务端广播 `project_opened`,本栏自动出现新项目并切过去。
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
import { useChatStore } from "@/stores/chat";
import { Pill } from "@/components/ui/primitives";
import { projectStatusLabel, projectStatusTone, excerpt } from "@/lib/vocab";

export function HistoryRail() {
  const projects = useChatStore((s) => s.projects);
  const projectId = useChatStore((s) => s.projectId);
  const intakeActive = useChatStore((s) => s.intakeActive);
  const loading = useChatStore((s) => s.projectsLoading);
  const error = useChatStore((s) => s.error);
  const selectProject = useChatStore((s) => s.selectProject);
  const startIntake = useChatStore((s) => s.startIntake);

  // 项目列表的加载由 App 统一负责(它在所有路由下都挂着,且按 projectsRevision
  // 重拉)—— 本组件只读 store,不自己 fetch,避免同一份列表在两处各拉一次。

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
          onClick={() => void startIntake()}
          title="和业务经理谈一个新项目 —— 立项由他执行,你只需要说想要什么"
        >
          + 新建
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-1.5 flex flex-col gap-1">
        {/* 接待会话入口。它在列表**之前**、并被选中时高亮 —— 因为「你现在在
            接待会话里」这件事必须看得见,否则用户会以为自己在一个项目里说话。 */}
        <button
          type="button"
          onClick={() => void startIntake()}
          className="text-left rounded-md px-2.5 py-1.5 transition-colors"
          style={{
            background: intakeActive ? "var(--ink-2)" : "transparent",
            border: intakeActive ? "1px solid var(--jade)" : "1px solid transparent",
            borderLeft: intakeActive ? undefined : "1px solid var(--ink-3)",
            cursor: "pointer",
          }}
          title="接待会话:第一个项目之前的那段对话。业务经理在这里与你对齐诉求,谈拢后由他立项"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span
              className="font-serif truncate"
              style={{ fontSize: 13, color: "var(--bone)", letterSpacing: ".04em" }}
            >
              接待 · 谈新项目
            </span>
            {intakeActive && <Pill tone="jade">进行中</Pill>}
          </div>
          <div className="truncate mt-0.5" style={{ fontSize: 11, color: "var(--bone-mute)" }}>
            和业务经理说想要什么 —— 立项由他执行
          </div>
        </button>

        {error && !intakeActive && (
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
        {!loading && projects.length === 0 && !error && !intakeActive && (
          <EmptyState text="还没有项目。点右上「+ 新建」和业务经理聊聊要做什么。" />
        )}

        {projects.map((p) => {
          const isActive = p.id === projectId && !intakeActive;
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
