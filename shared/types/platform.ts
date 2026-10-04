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
  | "client_question"
  // 交付物:项目经理在根工作项上写下的整合产物(设计 1 §2.11.5,C2 新增)。
  // 顺序与 `identity/role.ts` 的 `ARTIFACT_KINDS` / `migrations/016` 的 CHECK 末尾一致。
  | "deliverable";

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

/**
 * 会话消息的种类(与 `session_messages.kind` 的 CHECK 闭集逐个对齐)。
 *
 * ⚠️ **它与 `agent_id` 一起才定得住「谁在说话」**:`agent_id IS NULL` 有**两个**
 * 作者 —— `kind='user'` 是甲方,`kind='system'` 是平台通知(`host/serve.ts` 的
 * `announceDrain` 在排空器异常停下时落的那条)。**只看 `agentId` 会把平台通知
 * 算成甲方说的话**(设计 1 §2.10)。
 */
export type SessionMessageKind = "user" | "assistant" | "thinking" | "tool" | "system";

export interface SessionMessageView {
  id: string;
  /**
   * 这条消息属于哪个项目;**`null` = 接待会话**。
   *
   * 接待会话是那条 `project_id IS NULL` 的会话(全局唯一一条,见
   * `migrations/012_intake_session.sql`):甲方在第一个项目存在之前先与业务经理
   * 在这里把诉求谈清楚。它不是「没有项目的消息」,而是一个**有身份的**会话 ——
   * 只是它的身份不是项目。
   */
  projectId: string | null;
  /** null = 甲方说的话 */
  agentId: string | null;
  agentName: string | null;
  kind: SessionMessageKind;
  content: string;
  createdAt: number;
}

/**
 * 一个**作者**在某个项目里产生的会话消息(成员页「他产生了什么对话」的数据源,
 * 设计 1 §2.10 / §2.12 的 A3)。
 *
 * 分组键是 `session_messages.agent_id`(**身份**),不是 `role`(**属性**)——
 * 与 §2.4.2 的 M:N 基数一致:两个 worker 是两组,不是一组。
 *
 * ⚠️ **`agentId: null` 不等于「甲方」**,它是「没有角色作者」:甲方(`kind='user'`)
 * 与平台通知(`kind='system'`)都落在这里,所以这一组必须靠 `byKind` 把两者分开。
 *
 * ⚠️ **`total` 是 SQL `GROUP BY` 的真值,不是 `messages.length`** ——
 * `messages` 只是这一组最新的一页。拿 `messages.length` 冒充总数会在消息量增长时
 * **静默少数**,而界面上看不出来。
 */
export interface MemberConversationView {
  /** 分组键 = `session_messages.agent_id`;`null` = 没有角色作者(甲方 / 平台通知) */
  agentId: string | null;
  /** `agentId` 非空时解析出来的显示名;`null` 组也为 `null` */
  agentName: string | null;
  /**
   * 该 agent 在 `agents` 表里的角色(**读时解析**,与 `MemberView.role` 同一个真相
   * 来源:`agents.role`)。`agentId === null` 或查不到时为 `null`。
   */
  role: ProjectRole | null;
  /** 这一组的真实条数(SQL `GROUP BY`) */
  total: number;
  /** 按 kind 分列的条数 —— `agentId === null` 那一组靠它区分甲方与平台通知 */
  byKind: Partial<Record<SessionMessageKind, number>>;
  /** 这一组的消息,**新的在前**,最多 `MemberConversationsResponse.limit` 条 */
  messages: SessionMessageView[];
  /** `total > messages.length` —— 截断了就如实说,不许拿返回条数冒充总数 */
  truncated: boolean;
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

// ── harness(只读视图 + 提示词单元写面)────────────────────────────

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

/**
 * 用户工具集合文件(L2,`<dataDir>/harness/tools/{role}.json`)在某个角色上的**真实状态**。
 *
 * 为什么要单独一块:在批次 19 之前这个文件**零读者**,而界面上只显示 ceiling ——
 * 用户改了 JSON 却看不到任何变化,只能怀疑自己改错了地方。这一块把
 * 「L1 给了什么 / L2 收掉了什么 / L2 有没有生效」三件事摆在同一张卡上。
 */
export interface ToolSetFileView {
  /** 文件路径(让用户知道去哪编辑) */
  path: string;
  /**
   * `absent`  没有这个文件 → 出厂行为(按 ceiling 全集)
   * `ok`      生效中 —— **只有这一种状态会真的收窄工具面**
   * `invalid` 文件在但坏 → 退化成出厂行为(方向上是**放宽**),`problem` 说明原因
   */
  state: "absent" | "ok" | "invalid";
  /** state==="ok" 时:文件原样声明的名单(便于用户对照自己写了什么) */
  allow: string[];
  deny: string[];
  /**
   * 相对 L1 上界被集合文件**收掉**的工具 —— ceiling + scope 本来会给,文件没要。
   * 这就是「集合文件真的生效了」的可视证据。
   */
  removedByToolSet: string[];
  /** state==="invalid" 时:为什么没生效(必须可见 —— 此时权限回落到 ceiling 全集) */
  problem?: string;
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
  /** 该角色实际拿到的工具名(已过三重门控,**含 L2 集合文件**) */
  tools: string[];
  blockedByCeiling: string[];
  /** 集合文件里**不存在**的工具名(拼写错误不静默生效) */
  unknownTools: string[];
  /** L2 集合文件的真实状态(见 ToolSetFileView) */
  toolSet: ToolSetFileView;
}

export interface HarnessView {
  roles: RoleHarnessView[];
  /** 提示词单元所在目录(让用户知道去哪编辑) */
  promptDir: string;
  /** 工具集合文件所在目录(让用户知道去哪编辑) */
  toolsDir: string;
  /**
   * 工具目录里存在、但文件名不属于任何角色的 `.json`(例如写成了 `workers.json`)
   * —— 它们不会被读取。必须报出来,否则用户会以为已经生效。
   */
  strayToolSetFiles: string[];
  /**
   * 写面已就位。四条规矩见 `src/platform/harness/write.ts` 文件头:
   * 闭合注册表防路径穿越、备份是写的前置、报成功=真生效、恢复出厂≠删文件。
   *
   * 可以改的是**提示词单元**(`harness/system_prompts/*.md`)与**工具集合文件**
   * (`harness/tools/*.json` —— 直接编辑文件,本批未提供集合文件的写面,见报告)。
   * 不可以改的是 `ceiling` / `writeKinds` —— 它们是 `ROLE_SPECS` 里的**代码内
   * 常量**,改它们要走代码评审(7-E 的架构裁决:集合文件突破不了上界)。
   */
  writable: true;
}

// ── HTTP 响应 ────────────────────────────────────────────────────

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    detail?: string;
    /** 仅 `unknown_unit` 时出现:合法 id 清单(帮调用方自纠,而非去猜) */
    validIds?: readonly string[];
  };
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

/**
 * `GET /api/intake/messages` —— **接待会话**(第一个项目之前)的一条连续对话。
 *
 * `projectId` 恒为 `null`:那不是「缺失」,而是这条会话的身份(它还不属于任何项目)。
 * 前端据此把这段对话渲染在接待面板里,而不是某个项目面板里。
 */
export interface IntakeMessagesResponse {
  projectId: null;
  messages: SessionMessageView[];
}

/**
 * `GET /api/projects/:id/member-conversations` —— 成员页的「他产生了什么对话」清单。
 *
 * **为什么需要它(而不是拿 `/messages` 在客户端分组)**:`/messages` 走
 * `listProjectMessages`(`transport/views.ts`),它**没有** agent 谓词,而且每条会话
 * 取的是 `ORDER BY created_at LIMIT n` 的**最早** n 条、再 `slice(-n)` ——
 * 消息一多,按项目整体分出来的组会**静默少数**(界面上看不出来)。
 * 所以条数必须由 SQL `GROUP BY agent_id` 给出,那是这一节唯一能采信的数。
 */
export interface MemberConversationsResponse {
  projectId: string;
  /** 每组最多带回多少条消息(可用 `?limit=` 调,上限 500) */
  limit: number;
  /** 按 agent 分组。**顺序不定** —— 呈现顺序是页面的事(成员页按角色排) */
  groups: MemberConversationView[];
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
  /**
   * 对某个项目的业务经理说一句话。
   *
   * **`projectId: null` = 接待会话**(第一个项目之前)。此时与你说话的是业务经理,
   * 它的工具面只有 `project_open` 与 `memory_*` —— 谈拢之后它自己立项,
   * 服务端随即广播 `project_opened`。**不需要用户先填一张「创建项目」表单**:
   * 立项是业务经理的动作,不是甲方的动作。
   */
  | { type: "send"; projectId: string | null; content: string }
  /** 回答一个等甲方拍板的问题 —— 走 resolveClientQuestion,落 decision 工件 */
  | { type: "answer_client_question"; questionId: string; answer: string }
  /** `null` = 中断接待会话正在跑的那一轮 */
  | { type: "interrupt"; projectId: string | null }
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
 *
 * ⚠️ **`projectId: null` 的含义是「接待会话」,不是「没有项目」** ——
 * 无项目上下文的事件(`ready` / `pong` / `client_question`)根本没有这个字段。
 * 这个区分是刻意的:接待会话是**一条真的会话**(它的消息落库、它有自己的历史),
 * 只是它还不属于任何项目;把它与「没有项目上下文」混成一个值,前端就再也分不清
 * 「这条流是接待对话」还是「这条流不属于任何对话」。
 * `eventProjectId()` 对接待会话返回 `null`(与无项目事件一致)—— 因为前端对
 * 接待流的处置与「无项目」是一致的:它只按当前上下文累积,不做项目分派。
 *
 * ── 说话者身份(`agentId`)只出现在**能建轮**的两个事件上 ──────────
 *
 * `message_start` 与 `tool_start` 带**必填**的 `agentId`;`delta` /
 * `thinking_delta` / `message_end` / `tool_end` **不带** —— 它们全部追加到
 * 「当前那一轮」,而那一轮是被前两个事件建出来的 ⇒ **身份在建轮那一刻就定了**,
 * 再加一遍没有读者。
 *
 * 语义与取值域**不新造**:`agentId: string | null`,`null` = 甲方 ——
 * 与 `SessionMessageView.agentId`(本文件)以及 `session_messages.agent_id`
 * 的注释逐字同义(`migrations/009_collaboration.sql:45`:「NULL = 甲方(用户)
 * 说的话」)。
 *
 * **类型上必填,不是可选**:可选 = 漏填也编译得过,而漏填的表现是前端把它当成
 * 一个**无名助手**(静默);必填之后每个构造点都必须显式说清是谁,TS 会把它们
 * 全部点出来。为什么不加 `speakerRole` / `channel`、以及 §2.10.3 那条
 * 「回合中途播报吞字」的已知缺陷(与本字段无关,靠它救不了),
 * 见 `docs/DESIGN-PLATFORM.md` §2.10.2 / §2.10.3。
 */
export type ServerEvent =
  | { type: "ready"; modelId: string | null; provider: string | null; cwd: string }
  | { type: "pong"; ts: number }
  | {
      type: "message_start";
      projectId: string | null;
      messageId: string;
      role: "user" | "assistant";
      /** 谁在说话。**`null` = 甲方**(与 `SessionMessageView.agentId` 同义) */
      agentId: string | null;
    }
  | { type: "delta"; projectId: string | null; messageId: string; text: string }
  /**
   * 内部推理。**与 delta 是两条流,永不混流** ——
   * 7-I 的现场:判据写成了不存在的 "thinking",1853 字符推理落进 content
   * 被当成正式回复展示给用户。
   */
  | { type: "thinking_delta"; projectId: string | null; messageId: string; text: string }
  | {
      type: "message_end";
      projectId: string | null;
      messageId: string;
      usage?: { input: number; output: number };
    }
  | {
      type: "tool_start";
      projectId: string | null;
      messageId: string;
      /** 谁在调这个工具。取值域与 `message_start` 同源(`null` = 甲方);实际调用方总是某个角色 */
      agentId: string | null;
      tool: WsToolInfo;
    }
  | { type: "tool_end"; projectId: string | null; messageId: string; tool: WsToolInfo }
  | { type: "agent_end"; projectId: string | null; ts: number }
  /**
   * **业务经理在接待会话里把项目立起来了** —— 前端应刷新项目列表并切到它。
   *
   * 这条事件是「第一个项目之前」那段流程的收口:接待会话的使命到此结束
   * (它已把消息迁进新项目),之后在 `projectId` 那条流上继续。
   * 它由**服务端**在回合结束后发出 —— 不是工具直接广播:
   * 中途广播会让前端在一条正在流的回合里换上下文,半个回合的输出会落错面板。
   */
  | { type: "project_opened"; projectId: string; name: string }
  /** 业务经理向甲方提了一个问题 —— 前端应弹出来让用户答 */
  | { type: "client_question"; question: ClientQuestionView }
  /** 该问题已被回答(可能是本端答的,也可能是别处答的) */
  | { type: "client_question_answered"; projectId: string; questionId: string; decisionArtifactId: string }
  /** 黑板上多了一条工件 */
  | { type: "artifact_created"; artifact: ArtifactView }
  | { type: "work_changed"; projectId: string; workId: string; status: WorkStatus }
  | { type: "blocker_changed"; projectId: string; blockerId: string; status: BlockerView["status"] }
  /**
   * 该有提问已过截止时间仍未答复。
   *
   * **调度器只做这一件事:如实告诉你。** 它**不会**自动升级 —— 2026-10-04 经
   * jev 校准(p=0.81):单人本地服务里「人暂时没回」是常态而不是故障,
   * 自动升级会把组织图变成噪音放大器,而噪音的代价是用户学会忽略通知。
   *
   * 收到它该做的是:前端把该项目的待办标注为超时并置顶。**不自动替用户决定。**
   */
  | { type: "overdue_asks"; projectId: string; askIds: readonly string[]; count: number }
  /**
   * **驱动者循环停在了异常的位置** —— 撞上单次级联上限,或检测到「同一个待办
   * 在项目状态没变的情况下被反复唤醒」。
   *
   * 为什么必须有这条事件:级联到界时**不能静默停** —— 界面会回到 `idle`,而用户
   * 会以为「还在跑」或者「已经做完了」。这两种误解都会让他在错误的时刻做决定。
   *
   * `reason`:
   *   - `max_rounds`:跑得动但没跑完(项目太大,或某个角色原地打转)
   *   - `no_progress`:同一个待办重复出现而项目状态没变 —— 再叫也不会不同
   *
   * 收到它该做的是让用户看见,由他判断继续还是插手。
   * **平台不替他决定再跑一轮。**
   */
  | {
      type: "cascade_stopped";
      projectId: string;
      rounds: number;
      reason: "max_rounds" | "no_progress";
      detail: string;
    }
  /**
   * `projectId` 三态:字符串 = 该项目;**`null` = 接待会话**;
   * 缺省 = 与任何上下文无关(如 JSON 解析失败)。
   */
  | { type: "error"; projectId?: string | null; error: { code: string; message: string } };

/**
 * 事件属于哪个上下文。返回 `null` = 不属于任何项目
 * (无项目事件,或**接待会话** —— 见上面 `ServerEvent` 的说明)。
 */
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
//     **唯一的例外是 `GET /api/intake/messages`** —— 它是「第一个项目之前」那条
//     接待会话的历史。它没有项目可以挂,所以不能走 `/api/projects/:id/messages`;
//     但它也不是「对话可以独立于项目存在」的翻案:全局**只有一条**接待会话
//     (由迁移 012 的部分唯一索引机械保证),项目一旦立起来它就结束了。
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
//   POST   /api/projects                      → { project: ProjectSummary } [201]
//                                                ⚠️ **不是 UI 的立项路径**。立项的
//                                                正常动作是业务经理在接待会话里调
//                                                `project_open`(见 WS 的 project_opened)。
//                                                这条端点留着供 API/维护用途,前端不调它。
//   GET    /api/projects/:id                  → { project: ProjectDetail }
//   GET    /api/projects/:id/works            → { works: WorkView[] }
//   GET    /api/projects/:id/artifacts        → { artifacts: ArtifactView[] }
//   GET    /api/projects/:id/messages         → MessagesResponse
//   GET    /api/projects/:id/member-conversations → MemberConversationsResponse
//                                                「谁产生了什么对话」:按 agent_id
//                                                **在 SQL 里** GROUP BY(条数是真值,
//                                                不是「返回了多少条」)。
//   GET    /api/projects/:id/asks             → { asks: AskView[] }
//   GET    /api/projects/:id/blockers         → { blockers: BlockerView[] }
//   GET    /api/projects/:id/changes          → { changes: ChangeView[] }
//   GET    /api/projects/:id/members          → { members: MemberView[] }
//   ── 接待会话(第一个项目之前)──
//   GET    /api/intake/messages               → IntakeMessagesResponse
//                                                无需先建项目就能拉到与业务经理的
//                                                那一段对话历史(刷新不丢上下文)。
//   ── 工件 ──
//   GET    /api/artifacts/:id                 → { artifact: ArtifactView }
//   ── 待甲方答的问题(跨项目;左栏徽标用它)──
//   GET    /api/client-questions              → { questions: ClientQuestionView[] }
//   POST   /api/client-questions/:id/answer   → { ok, decisionArtifactId }
//   ── harness ──
//   GET    /api/harness                       → HarnessView
//   PUT    /api/harness/units/:unitId         { content }        → { ok, content, backupPath? }
//   POST   /api/harness/units/:unitId/reset   { confirm:"reset" } → { ok, content }
//   GET    /api/harness/units/:unitId/backups → { backups: [{file,path}] }
//   ── 记忆画像(结构化摘要;与 fragments 互补)──
//   GET    /api/profile                       → { entries: Record<string, unknown> }
//   PUT    /api/profile/:key                  { value }           → { ok, key, value, updatedAt }
//   ── 记忆 ──
//   GET    /api/memory/fragments              → { fragments: MemoryFragmentView[] }
//
// 查询参数:
//   /api/projects?status=draft|active|paused|done|abandoned
//   /api/projects/:id/artifacts?kind=&status=&limit=
//   /api/projects/:id/member-conversations?limit=   (每组消息条数,默认 200,上限 500)
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
//         not_a_question | settings_write_failed | internal |
//         unknown_unit | confirmation_required | write_failed | no_factory_copy
//
// `unknown_unit` 的响应里**额外带 `validIds`**(在 `error` 对象**里面**,
// 不是 body 顶层)—— 让调用方知道合法 id 有哪些,而不是去猜。

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
