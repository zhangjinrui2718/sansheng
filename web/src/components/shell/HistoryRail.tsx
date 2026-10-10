/**
 * 项目左栏 —— **项目(一级) + 对话线(二级)**。
 *
 * ── 为什么是两层 ───────────────────────────────────────────────
 *
 * ① **数据模型就是两层**:`project_sessions.project_id` + `kind='main'|'thread'`
 *   (migration 024)。左栏原先只有一层,是因为它写在 **024 之前** —— 本文件头
 *   曾逐字写着「新模型里『对话不再独立存在』」。024 把对话恢复成一等实体之后,
 *   那一层就**只存在于对话页里的一条横向页签**(`SessionPicker`,已删)。
 *
 * ② **横向页签的规模不可控,而纵向列表天然可滚动。** 真机上某个项目底下有 9 条线,
 *   页签被压成「一个字一行」,右边几个**渲染了但点不到**(被父级 `overflow-hidden`
 *   裁出可视区)—— 看着像「样式没加载」和「按钮失效」,真因只是**一行放不下**。
 *
 * ③ **主对话不是「众多线程之一」**。它是排空器触发的回合默认落点(待办是
 *   项目级的,不属于任何一条线),在页签里和交付线平级会让人以为它是随便哪条。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────
 *
 * · **接待会话不在二级里**(`GET /api/sessions` 明确不含 `project_id IS NULL`),
 *   它在上面有独立一行 —— 混进来会让它在界面上出现两次,而两次点进去是不同的对话。
 * · **默认只展开当前项目**,其余折叠并显示线数 —— 项目多了左栏会长。
 * · **「待你回答 N 个问题」按项目分组**:`counts.pendingQuestions` 那个字段就是
 *   为本栏徽标准备的(契约注释原话),而校准后的裁决是按项目分组呈现,
 *   不是把全仓问题混成一条流水账。
 *
 * 数据源:`projects`(`GET /api/projects`)+ `sessionsByProject`(`GET /api/sessions`),
 * 二者都随 `projectsRevision` 重拉 —— WS 的提问 / 工作项 / 工件事件都会递增它。
 */
import { useState } from "react";
import { useChatStore } from "@/stores/chat";
import { Pill } from "@/components/ui/primitives";
import { projectStatusLabel, projectStatusTone, excerpt } from "@/lib/vocab";
import type { ProjectSummary, SessionSummaryView } from "@shared/types/platform";

export function HistoryRail() {
  const projects = useChatStore((s) => s.projects);
  const projectId = useChatStore((s) => s.projectId);
  const intakeActive = useChatStore((s) => s.intakeActive);
  const sessionId = useChatStore((s) => s.sessionId);
  const loading = useChatStore((s) => s.projectsLoading);
  const error = useChatStore((s) => s.error);
  const sessionIndexError = useChatStore((s) => s.sessionIndexError);
  const selectProject = useChatStore((s) => s.selectProject);
  const startIntake = useChatStore((s) => s.startIntake);

  /**
   * 手动折叠/展开。**没表态过的项目按「是不是当前项目」定** ——
   * `expanded[id] ?? isActive`,而不是把初值抄进 state(那会让「切项目」时
   * 展开状态不跟着走,而它是切项目这个动作的一部分)。
   */
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  /** 正在起名的项目 id —— 同时只有一个表单,免得左栏被输入框撑开。 */
  const [namingFor, setNamingFor] = useState<string | null>(null);

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
          // ⚠️ `?? isActive` 而非 `|| isActive` —— 后者会把「显式折叠当前项目」
          // 也吃掉(折叠是 false,`false || true` 又是 true),于是那个箭头按不动。
          const isOpen = expanded[p.id] ?? isActive;
          return (
            <ProjectNode
              key={p.id}
              project={p}
              isActive={isActive}
              isOpen={isOpen}
              pending={pending}
              sessionId={isActive ? sessionId : null}
              naming={namingFor === p.id}
              onToggle={() => setExpanded((prev) => ({ ...prev, [p.id]: !isOpen }))}
              onSelectProject={() => void selectProject(p.id)}
              onSelectSession={(sid) => void selectProject(p.id, { sessionId: sid })}
              onStartNaming={() => setNamingFor(p.id)}
              onCancelNaming={() => setNamingFor(null)}
              onSubmitNaming={(title) => {
                setNamingFor(null);
                void createThread(p.id, title);
              }}
            />
          );
        })}

        {/* ⚠️ 索引读不到**不**升级成整栏错误 —— 项目列表仍然是真的,
            只是第二层暂时没有。⚠️ 它也**不是**「所有项目都没有线」:
            那与 `sessionIndexError === null` 且每个项目都 0 条是两件事。 */}
        {sessionIndexError !== null && (
          <div
            className="rounded-md px-3 py-2"
            style={{
              background: "var(--ink-2)",
              border: "1px dashed var(--ink-3)",
              color: "var(--bone-mute)",
              fontSize: 11,
            }}
          >
            对话线读不到: {sessionIndexError}
          </div>
        )}
      </div>
    </aside>
  );
}

/**
 * 另开一条线。**先切项目再开线** —— `newThread` 用的是**当前**项目的 id,
 * 而「＋」出现在每个项目下面(含没展开的那个),直接调会在上一个项目里开线。
 */
async function createThread(projectId: string, title: string | undefined): Promise<void> {
  const store = useChatStore.getState();
  if (store.projectId !== projectId || store.intakeActive) {
    await store.selectProject(projectId);
  }
  if (useChatStore.getState().projectId !== projectId) return;
  await useChatStore.getState().newThread(title);
}

/** 一级节点 + 它下面的线。拆出来是为了让 `projects.map` 本身保持可读。 */
function ProjectNode(props: {
  project: ProjectSummary;
  isActive: boolean;
  isOpen: boolean;
  pending: number;
  /** 只有当前项目才有「哪条线被选中」可言 —— 别的项目那一条状态在这里是空的。 */
  sessionId: string | null;
  naming: boolean;
  onToggle(): void;
  onSelectProject(): void;
  onSelectSession(sessionId: string): void;
  onStartNaming(): void;
  onCancelNaming(): void;
  onSubmitNaming(title: string | undefined): void;
}) {
  const { project: p, isActive, isOpen, pending } = props;
  const sessions = useChatStore((s) => s.sessionsByProject[p.id]);
  const lines = sessions ?? [];

  return (
    <div
      className="rounded-md"
      style={{
        background: isActive ? "var(--ink-2)" : "transparent",
        border: `1px solid ${isActive ? "var(--jade)" : "transparent"}`,
        borderLeft: isActive ? undefined : "1px solid var(--ink-3)",
      }}
    >
      <div className="flex items-start gap-1 px-2 py-1.5">
        {/*
          展开箭头与项目名**分开两个按钮**:箭头只管展开/收起(不发任何请求),
          名字才是「切到这个项目」。合成一个按钮的话,想收起当前项目就只能
          先切走 —— 而「看一眼这个项目有几条线」是一个正当的、不该改变上下文的动作。
        */}
        <button
          type="button"
          onClick={props.onToggle}
          aria-expanded={isOpen}
          aria-label={isOpen ? `收起 ${p.name}` : `展开 ${p.name} 的对话线`}
          style={{
            flex: "none", width: 14, marginTop: 2, padding: 0,
            background: "none", border: "none", cursor: "pointer",
            color: "var(--bone-mute)", fontSize: 10, lineHeight: "1.4",
          }}
          title={isOpen ? "收起对话线" : `展开 ${lines.length} 条对话线`}
        >
          {isOpen ? "▾" : lines.length > 0 ? `(${lines.length})` : "▸"}
        </button>

        <button
          type="button"
          onClick={props.onSelectProject}
          className="text-left flex-1 min-w-0"
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer" }}
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
      </div>

      {isOpen && (
        <div className="pb-1" style={{ paddingLeft: 20, paddingRight: 8 }}>
          {/*
            ⚠️ **零条线不渲染「(无对话线)」** —— `GET /api/sessions` 是纯读面,
            不 `ensureSession`,所以一个刚立项还没说过话的项目**真的**是空的。
            而它随后第一次发消息时主对话才被建出来(见 `hub.ts` 的 `ensureSession`)。
            空列表在这里是**正常状态**,而摆一个「无」字会把正常显示成故障。
          */}
          {lines.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              active={props.sessionId === s.id}
              onSelect={() => props.onSelectSession(s.id)}
            />
          ))}

          {props.naming ? (
            <NewThreadForm
              onCancel={props.onCancelNaming}
              onSubmit={props.onSubmitNaming}
            />
          ) : (
            <button
              type="button"
              onClick={props.onStartNaming}
              style={{
                display: "block", width: "100%", textAlign: "left",
                fontSize: 11, whiteSpace: "nowrap",
                color: "var(--bone-mute)", background: "none",
                border: "none", padding: "2px 4px", cursor: "pointer",
              }}
              title="另开一条对话线:同一件事的不同侧面各走一条,上下文不互相污染"
            >
              + 新对话线
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 二级节点:一条对话线。
 *
 * ⚠️ 标题**过长要截断**而不是撑宽左栏 —— 一级节点右边已经站着状态徽标与
 * 「待答 N」,而左栏本身是固定宽的;标题撑开会把徽标推出可视区,那个症状
 * 在旧页签版本上已经出现过一次。
 */
function SessionRow(props: { session: SessionSummaryView; active: boolean; onSelect(): void }) {
  const { session: s, active } = props;
  const label = s.title ?? (s.kind === "main" ? "主对话" : "对话");
  return (
    <button
      type="button"
      onClick={props.onSelect}
      className="text-left truncate"
      style={{
        display: "block", width: "100%",
        fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
        color: active ? "var(--bone)" : "var(--bone-mute)",
        background: active ? "var(--ink-1)" : "none",
        border: "none",
        borderLeft: active ? "2px solid var(--jade)" : "2px solid transparent",
        padding: "2px 4px", cursor: "pointer",
      }}
      title={
        s.kind === "main"
          ? "主对话:平台叫醒业务经理的回合落在这里"
          : "另开的对话线:只有你在这里说的话会进来"
      }
    >
      {label}
    </button>
  );
}

/**
 * 起名框。**留空就开** —— 平台不猜这条线该叫什么(§2.11:规则不做语义猜测),
 * 编一个「对话 2」出来会让人以为甲方真的这么命名过。
 *
 * ⚠️ 它是**受控**的:值在本地 state 里,`onSubmit` 把它交出去。
 * 上一版把它写成了一个 `value={propsTitleValue()}` 的占位(永远空串)——
 * 那看起来能输入,实际一个字都留不住,而**界面表现完全正常**。
 */
function NewThreadForm(props: { onCancel(): void; onSubmit(title: string | undefined): void }) {
  const [value, setValue] = useState("");
  return (
    <div className="flex items-center gap-1" style={{ flexWrap: "nowrap" }}>
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="这条线聊什么(可留空)"
        style={{
          fontSize: 11, flex: 1, minWidth: 0, padding: "2px 6px",
          background: "var(--ink-1)", color: "var(--bone)",
          border: "1px solid var(--ink-3)", borderRadius: 4,
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            const t = value.trim();
            props.onSubmit(t === "" ? undefined : t);
          }
          if (e.key === "Escape") props.onCancel();
        }}
      />
      <button
        type="button"
        style={{ fontSize: 11, whiteSpace: "nowrap", cursor: "pointer", flex: "none" }}
        onClick={() => {
          const t = value.trim();
          props.onSubmit(t === "" ? undefined : t);
        }}
      >
        开
      </button>
      <button
        type="button"
        style={{ fontSize: 11, whiteSpace: "nowrap", cursor: "pointer", flex: "none" }}
        onClick={props.onCancel}
      >
        取消
      </button>
    </div>
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