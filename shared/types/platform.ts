/**
 * 平台 HTTP / WS 协议(前后端共同契约)
 *
 * ── 与旧 `shared/types/ws.ts` 的关系 ──────────────────────────────
 *
 * 旧协议是**会话为中心**的:`conversationId` 出现在几乎每一条事件里,34 个
 * ServerEvent 覆盖了 MessageBus / executor 回调 / orchestrator plan 这些
 * **在新架构里已经不存在**的机制。
 *
 * 新协议是**项目为中心**的:
 *   - 「项目」是一等实体(设计 1 §0.1 问题三:一切以对话为界 = 项目活不过一轮对话)
 *   - 每个项目**一条连续对话**(2026-10-04 经 jev 校准,p=0.82)——
 *     项目即上下文容器,用户切项目 = 切上下文
 *   - `client_question` 取代旧的 `pending_question`:它是**工件**,不是瞬态消息
 *
 * 事件从 34 个收敛到 12 个。
 *
 * ── 这份文件是单一真相 ──────────────────────────────────────────
 *
 * server 侧**只允许 type-only import** 它(不得 value-import `@shared/*`,
 * 否则会把 shared 拉进 server 的运行时依赖图 —— 见项目 AGENTS.md)。
 * 前端正常 value-import。
 *
 * ⚠️ 与旧 `shared/types/ws.ts` 的一大区别:旧文件头部写着「server 侧真身在
 * agentKernel.ts,两边各自定义,字段必须逐字一致」—— 那是**靠人同步**。
 * 新协议不这么干:两边共用这一份,类型不一致会**编译失败**。
 */

// ── 领域闭集 ────────────────────────────────────────────────────
//
// ⚠️ **这些取值不是我凭印象写的,是从代码里的常量逐个核出来的**
// (authorize.ProjectStatus / BLOCKER_STATUSES / CHANGE_STATUSES /
//  ARTIFACT_STATUSES / ARTIFACT_KINDS)。
//
// ProjectStatus 的真身在 `src/platform/harness/authorize.ts` —— 它同时被
// storage/repo/projects.ts 与 migrations/007 的 CHECK 引用,**平台侧只有这一处
// 定义**。第一版我在这里写成了 `active | paused | closed`,三个里有两个是错的
// (`closed` 根本不存在,真实的是 `done` / `abandoned`)。
// 第一版我把 BlockerStatus 写成了 `open | resolved | wontfix` —— 那三个里
// 有两个根本不存在。前端拿到不存在的取值只会静默显示成未知状态,
// 而这类"契约与实现不符"的缺陷在联调时最难定位。
//
// 改动这里的任何一条之前,先去 src/platform/storage/repo/ 与
// src/platform/identity/role.ts 核对常量。

export type ProjectRole =
  | "business_manager"
  | "project_manager"
  | "worker"
  | "quality_reviewer";

export type Specialization = "engineering" | "algorithm" | "data";

export type ProjectStatus = "draft" | "active" | "paused" | "done" | "abandoned";

export type WorkStatus =
  | "open"
  | "in_progress"
  | "blocked"
  | "done"
  | "failed"
  | "cancelled";

export type ArtifactKind =
  | "decision"
  | "note"
  | "evidence"
  | "hypothesis"
  | "project_brief"
  | "work_brief"
  | "meeting_note"
  | "review_finding"
  | "change_record"
  | "client_question";

export type ArtifactStatus = "open" | "accepted" | "rejected" | "superseded";

export type AskStatus =
  | "open"
  | "answered"
  | "escalated"
  | "cancelled"
  | "expired";

export type BlockerSeverity = "low" | "medium" | "high" | "critical";

export type BlockerStatus =
  | "open"
  | "acknowledged"
  | "resolved"
  | "deferred"
  | "rejected";

export type ChangeStatus =
  | "proposed"
  | "under_review"
  | "accepted"
  | "implemented"
  | "rejected";

// ── 视图对象(前端读到的形状;不是数据库行,字段已解析成人话)──────────

export interface MemberView {
  id: string;
  role: ProjectRole;
  displayName: string;
  specialization: Specialization | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  client: string;
  goal: string;
  status: ProjectStatus;
  createdAt: number;
  /** 该项目的规模概览 —— 列表页直接用,不必再拉详情 */
  counts: {
    works: number;
    openWorks: number;
    artifacts: number;
    /** **等甲方答的**问题数。这是左栏徽标的来源。 */
    pendingQuestions: number;
    openBlockers: number;
  };
}

export interface ProjectDetail extends ProjectSummary {
  members: MemberView[];
  works: WorkView[];
  /** 待甲方答的问题(本项目) */
  pendingQuestions: ClientQuestionView[];
}

export interface WorkView {
  id: string;
  projectId: string;
  parentWorkId: string | null;
  title: string;
  goal: string;
  status: WorkStatus;
  assigneeAgentId: string;
  /** 解析后的负责人名(前端不再自己拼 agent id → 名字) */
  assigneeName: string;
  createdAt: number;
  updatedAt: number;
  /** 被哪些工作项依赖(用于画 DAG 的入边) */
  dependsOn: string[];
}

export interface ArtifactView {
  id: string;
  projectId: string;
  kind: ArtifactKind;
  status: ArtifactStatus;
  title: string;
  body: string;
  authorAgentId: string;
  authorName: string;
  createdAt: number;
  updatedAt: number;
  /** 出边:本工件 → 别的工件 */
  links: Array<{ rel: "parent" | "depends_on" | "answers"; targetId: string }>;
}

export interface SessionMessageView {
  id: string;
  projectId: string;
  /** null = 甲方说的话 */
  agentId: string | null;
  agentName: string | null;
  kind: "user" | "assistant" | "thinking" | "tool" | "system";
  content: string;
  createdAt: number;
}

/** 项目内的提问(角色之间,或对角色的)。**甲方看不到横向沟通**,只看发给自己那部分。 */
export interface AskView {
  id: string;
  projectId: string;
  fromAgentId: string;
  fromName: string;
  toAgentId: string;
  toName: string;
  question: string;
  hypothesis: string;
  options: string[];
  needs: string | null;
  status: AskStatus;
  parentAskId: string | null;
  createdAt: number;
  resolvedAt: number | null;
  deadlineAt: number | null;
}

/**
 * 等甲方拍板的问题。
 *
 * 它**是一个工件**(kind = `client_question`),不是瞬态消息 —— 所以会话结束
 * 它仍然在,用户下次打开还看得见。这正是旧 `pending_question` 事件做不到的。
 */
export interface ClientQuestionView {
  id: string;
  projectId: string;
  projectName: string;
  question: string;
  options: string[];
  /** 提问者的倾向与理由 —— 「让我只需点个头」的关键 */
  lean: string | null;
  askedByAgentId: string;
  askedByName: string;
  createdAt: number;
  status: ArtifactStatus;
}

export interface BlockerView {
  id: string;
  projectId: string;
  title: string;
  detail: string;
  severity: BlockerSeverity;
  status: BlockerStatus;
  raisedByName: string;
  createdAt: number;
  /** 它卡住了哪些工作项 —— 「哪件事被卡住了」才是甲方要的答案 */
  blockedWorkIds: string[];
}

export interface ChangeView {
  id: string;
  projectId: string;
  title: string;
  rationale: string;
  status: ChangeStatus;
  createdAt: number;
}

// ── harness(本次**只读**)────────────────────────────────────────

/**
 * 一个提示词单元在前端的呈现。
 *
 * `loaded` 为 false 表示:角色声明了这个单元,但盘上没有对应文件 ——
 * **这条职责从没告诉过 agent**。必须让用户看得见,这是 7-B 那一课的守卫。
 */
export interface PromptUnitView {
  id: string;
  loaded: boolean;
  chars: number;
  /** 单元正文(只读展示) */
  content: string;
  /** 文件路径,方便用户直接去改 */
  path: string;
}

export interface RoleHarnessView {
  role: ProjectRole;
  displayName: string;
  clientFacing: boolean;
  /** 代码内常量,不是可编辑文件 —— 前端要如实标注这一点 */
  ceiling: string[];
  writeKinds: string[];
  boundaryDeny: string[];
  promptUnits: PromptUnitView[];
  /** 该角色实际拿到的工具名(已过三重门控) */
  tools: string[];
  blockedByCeiling: string[];
}

export interface HarnessView {
  roles: RoleHarnessView[];
  /** 提示词单元所在目录(让用户知道去哪编辑) */
  promptDir: string;
  /**
   * 本次只提供只读视图。
   *
   * 写面(编辑提示词 / 改工具集合 / 备份 / 恢复出厂)是单独一批的工作 ——
   * 它要重新实现旧系统 7-O 的四条规矩(闭合注册表防路径穿越、备份是写的前置、
   * 报成功=真生效、恢复出厂≠删文件),不顺手做。
   */
  writable: false;
}

// ── HTTP 响应 ────────────────────────────────────────────────────

export interface ApiErrorBody {
  error: { code: string; message: string; detail?: string };
}

export interface HealthResponse {
  ok: boolean;
  version: string;
  modelId: string | null;
  provider: string | null;
  cwd: string;
  dataDir: string;
}

/** `/api/projects/:id/messages` —— 项目的一条连续对话 */
export interface MessagesResponse {
  projectId: string;
  messages: SessionMessageView[];
}

// ── WS 协议 ─────────────────────────────────────────────────────

/**
 * 客户端 → 服务端。
 *
 * 只有 4 个。旧协议有 10 个,其中 `plan` / `abort_plan` / `bus_replay` /
 * `cancel_question` / `load_conversation` 对应的机制在新架构里都不存在了
 * (计划由项目经理拆成工作项、总线已删、对话就是项目)。
 */
export type ClientCommand =
  /** 对某个项目的业务经理说一句话 */
  | { type: "send"; projectId: string; content: string }
  /** 回答一个等甲方拍板的问题 —— 走 resolveClientQuestion,落 decision 工件 */
  | { type: "answer_client_question"; questionId: string; answer: string }
  | { type: "interrupt"; projectId: string }
  | { type: "ping" };

export interface WsToolInfo {
  id: string;
  name: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  durationMs?: number;
}

/**
 * 服务端 → 客户端。
 *
 * 每条带项目的事件都有 `projectId` —— 前端据此把流分派到正确的项目面板
 * (jev:按项目分组呈现)。
 */
export type ServerEvent =
  | { type: "ready"; modelId: string | null; provider: string | null; cwd: string }
  | { type: "pong"; ts: number }
  | { type: "message_start"; projectId: string; messageId: string; role: "user" | "assistant" }
  | { type: "delta"; projectId: string; messageId: string; text: string }
  /**
   * 内部推理。**与 delta 是两条流,永不混流** ——
   * 7-I 的现场:判据写成了不存在的 "thinking",1853 字符推理落进 content
   * 被当成正式回复展示给用户。
   */
  | { type: "thinking_delta"; projectId: string; messageId: string; text: string }
  | {
      type: "message_end";
      projectId: string;
      messageId: string;
      usage?: { input: number; output: number };
    }
  | { type: "tool_start"; projectId: string; messageId: string; tool: WsToolInfo }
  | { type: "tool_end"; projectId: string; messageId: string; tool: WsToolInfo }
  | { type: "agent_end"; projectId: string; ts: number }
  /** 业务经理向甲方提了一个问题 —— 前端应弹出来让用户答 */
  | { type: "client_question"; question: ClientQuestionView }
  /** 该问题已被回答(可能是本端答的,也可能是别处答的) */
  | { type: "client_question_answered"; projectId: string; questionId: string; decisionArtifactId: string }
  /** 黑板上多了一条工件 */
  | { type: "artifact_created"; artifact: ArtifactView }
  | { type: "work_changed"; projectId: string; workId: string; status: WorkStatus }
  | { type: "blocker_changed"; projectId: string; blockerId: string; status: BlockerView["status"] }
  | { type: "error"; projectId?: string; error: { code: string; message: string } };

/** 事件是否属于某个项目(前端分派用)。 */
export function eventProjectId(ev: ServerEvent): string | null {
  return "projectId" in ev && typeof ev.projectId === "string" ? ev.projectId : null;
}

// ── HTTP 接口面(冻结于 2026-10-04)────────────────────────────────
//
// 这份表是**前后端的共同约定**:前端照它写 `lib/api.ts`,后端照它实现路由。
// 任何一方要改,改的是这里 —— 然后两边各自编译会立刻报错。
//
// 设计原则(与两条经校准的裁决一致):
//   - **项目为中心**:没有 `/api/conversations*`。对话就是项目的。
//   - **harness 只读**(scope=readonly,p=0.990):只有 GET,没有 PUT / reset。
//   - **每项目一条连续对话**(chat=one,p=0.82):没有「新建会话」这个动作。
//
//   GET    /api/health                        → HealthResponse
//   GET    /api/config                        → AppConfigResponse
//   GET    /api/settings                      → SettingsPublic       (shared/types/settings.ts)
//   PUT    /api/settings                      → { ok, settings }
//   GET    /api/providers                     → { providers: ProviderInfo[] } (shared/types/settings.ts)
//   ── 项目 ──
//   GET    /api/projects                      → { projects: ProjectSummary[] }
//   POST   /api/projects                      → { project: ProjectSummary } [201] ← 立项唯一出口
//   GET    /api/projects/:id                  → { project: ProjectDetail }
//   GET    /api/projects/:id/works            → { works: WorkView[] }
//   GET    /api/projects/:id/artifacts        → { artifacts: ArtifactView[] }
//   GET    /api/projects/:id/messages         → MessagesResponse
//   GET    /api/projects/:id/asks             → { asks: AskView[] }
//   GET    /api/projects/:id/blockers         → { blockers: BlockerView[] }
//   GET    /api/projects/:id/changes          → { changes: ChangeView[] }
//   GET    /api/projects/:id/members          → { members: MemberView[] }
//   ── 工件 ──
//   GET    /api/artifacts/:id                 → { artifact: ArtifactView }
//   ── 待甲方答的问题(跨项目;左栏徽标用它)──
//   GET    /api/client-questions              → { questions: ClientQuestionView[] }
//   POST   /api/client-questions/:id/answer   → { ok, decisionArtifactId }
//   ── harness(只读)──
//   GET    /api/harness                       → HarnessView
//   ── 记忆 ──
//   GET    /api/memory/fragments              → { fragments: MemoryFragmentView[] }
//
// 查询参数:
//   /api/projects?status=draft|active|paused|done|abandoned
//   /api/projects/:id/artifacts?kind=&status=&limit=
//   /api/memory/fragments?limit=
//
// **没有** `/api/works` 与 `/api/artifacts`(不带项目)这两个平级列表 ——
// 工作项与工件**总是属于某个项目**,跨项目的同类列表没有使用场景,而提供
// 一个就等于邀请调用方绕过项目这个组织维度。
//
// 列表类接口**一律返回具名键**(`{ projects: [...] }`)而不是裸数组:
// 裸数组以后加不了分页元数据,只能破坏性改接口。
//
// 错误形状(所有非 2xx):`{ error: { code, message } }`
//   code: invalid_body | invalid_args | not_found | already_resolved |
//         not_a_question | settings_write_failed | internal

export interface AppConfigResponse {
  cwd: string;
  personaName: string;
  hasAnyProvider: boolean;
}

export interface MemoryFragmentView {
  id: string;
  kind: "fact" | "preference" | "project" | "context" | "summary";
  content: string;
  importance: number;
  accessCount: number;
  createdAt: number;
}

// 注意:`SettingsPublic` / `ProviderInfo` **不在这里重定义** —— 它们在
// `shared/types/settings.ts`,平台沿用同一份。
//
// 第一版我确实在本文件里又写了一遍(而且那次追加还因为 shell `&&` 短路
// **根本没落盘**,却在下一行打印了「API 表已冻结」)—— 两份定义迟早会漂,
// 而且漂了不会有任何编译错误提醒。需要时:
//   import type { SettingsPublic, ProviderInfo } from "./settings.js";
