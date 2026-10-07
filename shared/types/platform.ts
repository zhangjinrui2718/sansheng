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
  // 2026-10-08:执行角色按**产出形态**一分为二(原 `worker`)。
  // `research_worker` 交信息(文档 / 伪代码 / 架构图 / 汇报材料),
  // `coding_worker` 交能跑的东西(可独立部署到 Docker 的代码服务)。
  | "research_worker"
  | "coding_worker"
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

/**
 * 交付物类型(migration 025 / 026)。**只有真正有写入口的类型才在这里。**
 *
 * 与 `src/platform/storage/repo/artifacts.ts` 的 `DELIVERABLE_TYPES` 逐项相同 ——
 * 由 `tests/platform/deliverable-types.test.ts` 的跨边界对照钉住。
 *
 *   · `html_report`  —— 「凡是只有信息交付的」:技术方案 / 架构图 / 汇报材料 /
 *     评审结论 / 说明书。正文是一份自包含 HTML,读面在禁用脚本的沙箱 iframe 里渲染。
 *   · `code_service` —— **代码服务**(026 新增,用户原话:「一个 git 仓库,
 *     然后这个仓库可以独立部署到 docker 上面」)。交付物的坐标(仓库路径 / 分支 /
 *     HEAD / Dockerfile / 服务名与端口)写在 `metadata`,而**写入口是带校验的**:
 *     平台当场去盘上核对那个仓库真的存在、真的是 git 仓库、HEAD 就是记的那个提交、
 *     根目录真的有 Dockerfile(`src/platform/codeservice/`)。所以「写个字段就算交付」
 *     这条路是不通的。
 *
 * 更远的类型(仓库上的某几个提交、镜像、部署实例)**刻意不在这里**:预留靠的是
 * `artifacts.deliverable_type` 这一列的结构(加一种类型 = 纯加法),
 * 不是提前往闭集里塞一个平台造不出来的值(7-E:`enabledTools` 那四个名字)。
 */
export type DeliverableType = "html_report" | "code_service";

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
  /**
   * **产出这条工件的工作项**(provenance,migration 014 的 `artifacts.work_id`)。
   *
   * 工件页的 DAG 靠这条边把「工件」挂回「产出它的那个环节」——没有它,页面只能
   * 按 kind 平铺,读者看不出这些工件其实是同一条流水线上不同步骤的产物。
   *
   * ⚠️ **`null` 是合法状态,不是缺参数**:立项书 / 会议纪要 / 变更记录 /
   * 甲方问答(**决策工件**)不是任何工作项的执行产出。它们**不挂在任何环节上**,
   * 页面必须把它们**另立一处列出**,而不是丢进某个节点假装是自己产的。
   *
   * ⚠️ 这条边**一条边两个语义**(生产 ∩ 关于):worker 写 `evidence` 是产出,
   * 质检把 `review_finding` 挂到被审的那条上表达的是「审的是哪一条」。两者都该
   * 显示在同一个节点上 —— 节点的语义是「这一步上留下了什么」,不是「谁生产的」。
   * 判据与取舍见 `docs/DESIGN-PLATFORM.md` 与 `runtime/execution.ts`。
   */
  workId: string | null;
  /**
   * **这条交付物是哪种类型**(migration 025 的 `artifacts.deliverable_type`)。
   *
   * ⚠️ **`null` 覆盖两种不同的情形,读面必须分开处理**:
   *   · `kind !== 'deliverable'` → 非交付物没有类型,这是**唯一合法取值**;
   *   · `kind === 'deliverable'` 且为 `null` → **存量交付物**(真机 23 条,
   *     全部是 016 之后写的 markdown 正文),正文按**普通正文**呈现。
   *
   * ⚠️ 把它当 `html_report` 渲染那 23 条会得到 23 片空白 —— 页面必须先看
   * `kind` 再看类型,不能只按类型分支。
   */
  deliverableType: DeliverableType | null;
  /**
   * **代码服务的坐标**(`deliverableType === 'code_service'` 时非 null)。
   *
   * ⚠️ 这几个值是**平台在现场核实过的事实**,不是模型写的字符串 ——
   * 写入那一刻 `codeservice` 端口去盘上读过一遍(存在 / 是 git / HEAD 一致 /
   * 分支顶端 / 有 Dockerfile,见 `src/platform/codeservice/git.ts`)。
   *
   * ⚠️ **仍然可空**:`metadata_json` 里可能缺项(老行、手改的行)。缺的那一项
   * 在 `CodeServiceView` 里是 `null`,读面如实写「读不到」—— **不猜、不编默认值**。
   * 把它们都塞进字符串并拼上一句「大概是这样」,正是本项目反复拒绝的那种做法。
   */
  codeService: CodeServiceView | null;
}

/**
 * 代码服务的坐标(读面用的形状)。每个字段都可空 —— 见 `ArtifactView.codeService`。
 */
export interface CodeServiceView {
  readonly repoPath: string | null;
  readonly repoName: string | null;
  readonly branch: string | null;
  readonly headCommit: string | null;
  readonly headSubject: string | null;
  readonly commitCount: number | null;
  readonly dockerfile: string | null;
  readonly service: string | null;
  readonly port: number | null;
  readonly files: readonly string[];
}

/**
 * 代码服务交付物的**最近提交**(`GET /api/artifacts/:id/commits`)。
 *
 * ⚠️ **这是现读的,不是交付物的一部分**:写进 `metadata_json` 的 HEAD 是**交付
 * 那一刻**的事实,而「这个仓库后来改了什么」只能现在去盘上读 —— 存进库就会过期,
 * 而过期的快照看起来与新鲜的一模一样。
 *
 * ⚠️ `runtime: "unavailable"` 是**读不到**,不是「没有提交」。界面上**必须**
 * 分开渲染:读不到渲染成空列表 = 把一次读失败说成「这个仓库是空的」。
 * (与 `ProjectLiveView.runtime` 同一条纪律。)
 */
export interface RepoCommitsView {
  readonly runtime: "ok" | "unavailable";
  readonly commits: readonly {
    readonly sha: string;
    readonly shortSha: string;
    readonly subject: string;
    readonly committedAt: number;
    readonly author: string;
  }[] | null;
  /** 交付物记下的 HEAD(不是当前 HEAD —— 那是**交付那一刻**的事实) */
  readonly head: string | null;
  readonly branch: string | null;
  /** `runtime === "unavailable"` 时说明为什么读不到 */
  readonly problem?: string;
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

/**
 * 一个封套的**来源闭集** —— 与 `message_start` 那两条契约的判别键逐个对齐
 * (`TurnMessageStart.source: "turn"` / `BroadcastMessageStart.source: "broadcast"`,
 * 由本文件末尾的 `_MessageStartHasExactlyTwoSources` 钉住「只有这两种」)。
 *
 * 不加第三种是刻意的:每一条新封套都必须**显式**表态「它进哪条通道」,
 * 不许有东西静默落进「既不是回合、也不是播报」的缝隙里。
 */
export type MessageOriginSource = "turn" | "broadcast";

/**
 * 一条消息 / 一轮**从哪个封套来** —— WS 封套、落库行、前端轮**共用的同一个形状**。
 *
 * ── 为什么它同时出现在三处(而不是各写一份)──────────────────────
 *
 * 这个类型是为了闭合 W3-① 那个缺口而抽出来的:显示判据是
 * `source === "broadcast"` ∨ `trigger.kind === "user"`(见
 * `web/src/lib/data.ts` 的 `channelOf`),而这两维此前**只在 WS 封套上**
 * (内存里),库里一条都没有 ⇒ **一刷新,判据就没了**:
 *
 *   - 流式那一路:封套到了 ⇒ 判据成立;
 *   - REST 回填那一路(`messageToTurn`):`SessionMessageView` 上读不到任何一维
 *     ⇒ 只能给 `"unknown"` ⇒ 回退到「按角色的两跳」判据;
 *   - 而回退判据把**业务经理**判进甲方通道(它是 `clientFacing`)⇒ 它被工件/待办
 *     叫醒的那一轮正文,**刷新之后又出现在对话页上**。
 *
 * 现在封套落库了(`session_messages.origin_source` / `trigger_kind`,
 * migration 019),`SessionMessageView.origin` 就是它的读侧形状;前端那条
 * `TurnOrigin` 直接复用本类型 ⇒ **同一条判据只有一个形状**,
 * 「REST 回填拿不到判据」在类型上不再可能。
 *
 * ── 三个取值 ────────────────────────────────────────────────────
 *
 *   - `turn`      —— 回合封套。带 `trigger.kind`:`user` 的正文进甲方通道,
 *     `todo`(排空器按待办叫醒)的正文**不进**(甲方要看的是成员页那份工作记录)。
 *   - `broadcast` —— 播报封套(`tell_client`)。**无条件**进甲方通道,所以它
 *     **结构上没有** `trigger` 这一维 —— 与契约里的 `_BroadcastMustNotCarryTrigger`
 *     同一条纪律:「顺手用 trigger 判一下播报」这个错误在类型上写不出来。
 *   - `unknown`   —— **判据缺失**,不是「内部」。两个来源:① REST 回填一条
 *     **019 之前写入的存量行**(那两列当时没被记录,回填就是编造 ——
 *     `migrations/019_message_origin.sql` 记着为什么不回填);② 前端 `tool_start`
 *     抢在 `message_start` 前面建轮。**折成 `null` 会让一个 `??` 把它静默当成
 *     某一侧**,所以显式留第三个取值,逼每个读者表态。
 *
 * ⚠️ `unknown` 的处置**不是**「fail-closed 一律隐藏」:隐藏会让甲方刷新一次就
 * 失去与业务经理的整段对话。前端的选择是**回退到有据可依的最好判据**(按角色
 * 两跳,fail-open),并把这条路写在 `channelOf` 的注释里 —— 见设计 1 §2.10。
 */
export type MessageOrigin =
  /**
   * 回合封套。
   *
   * ⚠️ **`todoKind` 是可选的**(2026-10-06,migration 022)。它此前**不在这个类型
   * 里**,而它的缺席不是「还没有读者」那么简单 —— 它让通道判据第二次出现「刷新之后
   * 判据消失」:流式那一路从 WS 封套拿得到完整 `TurnTrigger`,刷新那一路只拿得到
   * `trigger_kind='todo'` 分不清是哪一类。019 的文件头已经把这个坑写成教训了
   * (「落库的是输入,判据怎么改都只是读侧的事」)。
   *
   * 可选而不是必填:`session_messages.todo_kind` 是**可空列**,022 之前的存量行
   * 永远是 `null`。必填就等于逼读侧**编造**一个值(`migrations/022_todo_kind.sql`
   * 记了为什么不能回填)。缺失时 `todoKindReachesClient` 返回 `false`,
   * 方向是 fail-closed —— 那条消息留在内部通道,而不是本该给甲方的正文上屏。
   */
  | { source: "turn"; trigger: { kind: TurnTriggerKind; todoKind?: TriggerTodoKind } }
  | { source: "broadcast" }
  | { source: "unknown" };

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
  /**
   * 这条消息落在**哪条对话线**上(migration 024)。
   *
   * ⚠️ **前端必须按它过滤**:一个项目下面可以有多条线,而按 `projectId` 过滤会
   * 把**所有线**混进同一个面板 —— 那在「一个项目一条对话」的年代是对的。
   */
  sessionId: string;
  /** null = 甲方说的话 */
  agentId: string | null;
  agentName: string | null;
  kind: SessionMessageKind;
  content: string;
  createdAt: number;
  /**
   * 这条消息**从哪个封套来**(migration 019 落库的两列)。
   *
   * **必填,不是可选** —— 与 `message_start` 的 `source` / `trigger` 同一条纪律:
   * 可选 = 漏填也编译得过,而漏填的表现是**这条消息悄悄走回退判据**(W3-① 那个
   * bug 原样复发),界面上看不出来。
   *
   * 019 之前的存量行是 `{ source: "unknown" }`(那两列当时没被记录)——
   * 前端的回退判据对它们继续有效,这是有意的处置,不是遗漏。
   */
  origin: MessageOrigin;
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

/**
 * 一个角色**此刻**在做什么 —— 成员页「正在做什么」这一区的数据源。
 *
 * ── 为什么需要它(这不是「再加一个页面」,是补一条读面)──────────────
 *
 * 在此之前成员页只有「他产生了什么对话」(过去时)。用户的原话是
 * 「现在只有做了些什么,没有正在做什么……我担心系统已经挂了,而实际还在运行」。
 * 过去的记录**结构上**回答不了「现在」:一个正在跑 16 分钟回合的 worker 与一个
 * 已经停了三小时的 worker,在「他产生了什么对话」里长得一模一样。
 *
 * ── 三个来源,刻意分开(它们**不是**同一件事)────────────────────────
 *
 *   ① `turn`      —— 宿主内存的忙闩(`transport/hub.ts` 的 `busy`)。它答的是
 *      「**此刻**有一个回合在它身上跑」。这是唯一能回答「现在」的来源,代价是
 *      **进程重启即清零** —— 所以它单独一个字段,绝不与②混在一起。
 *   ② `currentWorks` / `todos` —— **库里的真状态**:`works.status='in_progress'`
 *      与 `collectTodos` 的待办。重启后照样成立,而且**与排空器看到的是同一个判据**
 *      (不在这里重写一份「谁该跑」)。
 *   ③ `lastMessage` / `lastTool` —— 最近一次的**落库**痕迹,用来回答「它最后一次
 *      动是什么时候」。`ageMs` 由**服务端**算(同一台机器也在同一时钟上,
 *      但由服务端算就不必让前端去担心时钟偏移)。
 *
 * ⚠️ **`turn === null` 不等于「空闲」**:它只说「宿主此刻没有登记这条闩」。
 * 真正该被读成「空闲」的判据是三者合起来(没有回合、没有进行中的工作项、
 * 没有待办)。前端**不许**把 `turn === null` 单独渲染成「空闲」——
 * 那正好是「系统挂了而看起来正常」的镜像形态。
 */
export interface MemberActivityView {
  agentId: string;
  /**
   * 此刻在这个角色身上跑的回合。`null` = 宿主没有登记闩。
   *
   * `elapsedMs` 是**服务端**算的(快照时刻 − 闩的占用时刻);前端要让它继续走,
   * 就把「本地收到这份快照之后经过的时间」加上去(同一台机器,这个加法成立)。
   * `trigger` 是**这一轮为什么存在** —— 用户触发 / 排空器按某条待办叫醒
   * (`TurnTrigger`,与 `message_start.trigger` 同源同形)。
   */
  turn: { elapsedMs: number; trigger: TurnTrigger } | null;
  /** 库里派给它的活:`in_progress` / `blocked`(重启后仍成立的真状态) */
  currentWorks: Array<{ id: string; title: string; status: WorkStatus; ageMs: number }>;
  /**
   * 派给它、前置已满足、还没终态的活 —— `collectPendingWork().myOpenWorks` 的条数
   * (判据是 `open` ∪ `in_progress`,且**容器不算**:有子项的那种工作项由子项推动)
   * 。
   *
   * 与 `todos` 的区别:待办是**排空器现在还愿不愿意叫它**(受尝试预算约束),
   * 这个是**它手上真实欠着多少活**。两个都对,问的是不同的问题。
   */
  readyWorks: number;
  /** 派给它、但前置还没满足的工作项数 —— 「它为什么还没动」的答案 */
  waitingWorks: number;
  /**
   * 平台判定「现在该它跑」的待办 —— 直接来自 `collectTodos` 的 `runnable`,
   * 按 `agentId` 分组。这里是**排空器自己的判据**,不是前端重算的一份。
   *
   * `attempts` 是尝试预算已经用掉的次数(默认上界 3):用满的条目不在
   * `runnable` 里,而在 `exhaustedTodos` 的计数里 —— 「排空器不再叫它了」
   * 必须看得见,否则与「它马上就会跑」长得一样。
   */
  todos: Array<{
    kind: TriggerTodoKind;
    label: string;
    attempts: number;
    maxAttempts: number;
    target: string | null;
  }>;
  /** 预算用尽、**不再被叫醒**的待办数(静默放弃是禁止的,所以它必须显示) */
  exhaustedTodos: number;
  /**
   * 最近一条**落库**的会话消息(任何 kind)。
   *
   * ⚠️ 库里实际会出现的 kind 只有 `user` / `assistant` / `system`(**`tool` 从不
   * 落库** —— 工具调用只走 WS 广播,见 `host/serve.ts` 的 `bridge`)。所以这一格
   * 答的是「它最后一次**留下痕迹**是什么时候」,不是「它最后一次调了什么工具」。
   * 正在调什么工具由**前端**从 WS 的在飞轮里读(`stores/chat.ts` 的 `inFlight`
   * 里那些 `kind: "tool"` 的块)—— 那是唯一有这个信息的地方。
   *
   * 曾经这里有一个 `lastTool` 字段,在真机库上**恒为 `null`**(没有写入方),
   * 属于「有声明没读者」的反面形态:有声明没**写**方。已删。
   */
  lastMessage: { kind: SessionMessageKind; excerpt: string; ageMs: number } | null;
}

/**
 * 一个项目**此刻**的运行态快照(`GET /api/projects/:id/live`)。
 *
 * ── 它为什么存在,以及它**不是**什么 ──────────────────────────────
 *
 * 它存在的理由只有一个:**回答「现在」**。工件页的 DAG 靠它给正在跑的节点点亮,
 * 成员页靠它显示「正在做什么」,页首靠它显示排空器的心跳 —— 用户要能看出
 * 「系统还活着」而不是「界面停在最后一帧上」。
 *
 * 它**不参与任何判定**:没有一条流水线规则读这个视图,它是纯粹的读面投影。
 * 判定仍然是 `collectTodos` 那一份(见 `runtime/dispatcher.ts`),这里只是把它的
 * 结果**连同**运行期两个内存事实(忙闩、定时器心跳)一起端出来。
 *
 * ⚠️ **它是一次性的快照,不带 revision 语义** —— 调用方按自己的节奏重取
 * (成员页轮询 + WS 事件触发),权威值永远以**这次响应**为准。
 */
export interface ProjectLiveView {
  projectId: string;
  /** 这份快照算出来的时刻(服务端时钟)。所有 `ageMs` 都是相对它算的 */
  at: number;
  /**
   * 运行期数据的来源:
   *   - `host`        —— 宿主把内存快照接上了(`turn` / `dispatch` 都是真值);
   *   - `unavailable` —— **这个进程没接上运行期快照**(例如只挂 HTTP 的测试装配)。
   *     此时 `turn` 一律为 `null` 且 `dispatch.lastRunAgeMs` 为 `null` ——
   *     它**不是**「没在跑」,是「读不到」。两种状态在界面上**必须**分开显示,
   *     否则「读不到」会被读成「空闲」,那正是这次要修的那类谎。
   */
  runtime: "host" | "unavailable";
  /** 排空器兜底定时器的心跳 */
  dispatch: {
    /** 兜底周期(默认 10s) */
    intervalMs: number;
    /** 上一次兜底触发距今多久;`null` = 本进程还没触发过 */
    lastRunAgeMs: number | null;
    /** 此刻正在排空这个项目 */
    draining: boolean;
  };
  /** 此刻在**这个项目**里跑着的回合数(四个角色加起来) */
  runningTurns: number;
  /** 未终态的工作项数(`open` / `in_progress` / `blocked`) */
  openWorks: number;
  /** 等甲方答的问题数(它们是流水线停下来的原因) */
  pendingQuestions: number;
  /** 本项目四个角色,一人一条(`MemberView` 的顺序) */
  agents: MemberActivityView[];
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

/**
 * `GET /api/client-questions` 的载荷。
 *
 * ⚠️ `fromClosedProjects` **必须被显示,不许静默丢弃**(2026-10-07 真机事故)。
 *
 * 「待答」承诺的是「你答了会有人处理」。而**已收口项目的提问兑现不了**:
 * `host/serve.ts` 的 `drainAll` 排的是 `listProjects(db, "active")`,终态项目
 * 永远不进排空器 ⇒ 那些提问永远没人被叫醒去处置。真机上有 3 条这样的提问
 * (项目 00:27 收口,提问发生在 09:03/09:13)常驻在队列里。
 *
 * 所以它们不进 `questions`;但**事实一条都不删**(工件与 `client_questions` 行
 * 原样在库里,项目页照常显示,答复接口仍然可用)。前端**必须**把这条计数说出来 ——
 * 悄悄少三条会让用户以为「问题自己消失了」,那正是 7-N。
 */
export interface ClientQuestionList {
  questions: ClientQuestionView[];
  /** 因项目已收口(`done`/`abandoned`)而没有进入待答队列的条数。 */
  fromClosedProjects: number;
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
  /**
   * `tools` 这一栏**求解过了没有**。
   *
   * `false` = 库里**连这个角色的 agent 行都没有**(组织还没播种,或刚被重置)⇒
   * `tools` 是空数组,但它**不是「0 个工具」,而是「算不出来」**。
   *
   * ⚠️ 为什么必须单列一个字段(2026-10-05 真机现场):这两种状态在界面上**长得
   * 一模一样** —— 成员页读的是同一个响应,于是显示「能力 22 项 · 可写 3 类 ·
   * 实得工具 **0** 个」。用户看到 0 会以为「这个角色没有工具」,而真相是
   * 「那一刻组织没播种」;更糟的是它**看起来完全正常**(本项目反复栽的形态)。
   * 有了这个字段,界面就能把「0」与「不知道」分开说。
   *
   * ⚠️ 注意 `toolsSolved: true` 而 `tools: []` 是**合法**的:接待阶段(还没有项目)
   * 有些角色在 scope 门下确实一个工具都拿不到。
   */
  toolsSolved: boolean;
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
 * `GET /api/projects/:id/sessions` —— **这个项目下面有哪几条对话线**
 * (migration 024)。
 *
 * ⚠️ 一个项目下面可以有多条对话线,而对话页的「我在看哪条」是**单指针** ——
 * 所以前端必须有一个地方知道「有哪些」。`kind='main'` 那条排在最前:它是
 * 排空器触发的回合落的地方(待办是**项目级**的,不属于任何一条甲方开的线),
 * 也是不指定时的默认落点。
 */
export interface SessionSummaryView {
  id: string;
  /** `main` = 主对话;`thread` = 甲方另开的线 */
  kind: "main" | "thread";
  /** 这条线叫什么。**`null` = 甲方没起名** —— 读面显示「对话」,不编一个出来 */
  title: string | null;
  channel: "internal" | "client";
  /** 它是不是某场交付开出来的(`handover` 的终止判据就在这一列) */
  deliverableArtifactId: string | null;
  createdAt: number;
  lastMessageAt: number;
}

export interface ProjectSessionsResponse {
  projectId: string;
  sessions: SessionSummaryView[];
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

// ── 用量(回合烧了多少 token;migration 018 的 `turn_usage`)────────
//
// ⚠️ **只报 token 数,不报金额** —— SDK 的 `Usage` 上有 `cost`,但用户已定
// 「不显示金额」,所以 `cost` **既不落库、也不进这份契约**。将来要破例必须先
// 解决「单价/汇率会变」这件事:今天存下来的金额不是明天那份钱。
//
// 粒度:**一个回合一行**(`turn_usage` 是回合级的)。一次 LLM 调用结一次账,
// 一个回合可能调 N 次工具 ⇒ N+1 次调用,写入侧求和成一行。

/** 一组用量(合计 / 今日 / 某角色 / 某一天)。 */
export interface UsageBucketView {
  input: number;
  output: number;
  cacheRead: number;
  /** 有花费的回合数(没买到任何 LLM 输出的回合不写账,也不计在这里) */
  turns: number;
}

export interface UsageByAgentView extends UsageBucketView {
  agentId: string;
  /** 显示名 —— 由视图层解析(`agent_id → agents.display_name`) */
  agentName: string;
  role: ProjectRole;
}

export interface UsageByDayView extends UsageBucketView {
  /** 本地日历日 `YYYY-MM-DD` */
  day: string;
}

/**
 * 项目(**或接待会话**)的用量聚合 ——「合计 / 今日 / 按角色 / 最近 7 天」都由它支撑。
 *
 * ── 为什么 `totals` 与 `allTime` 是两件事 ─────────────────────────
 *
 * `totals` 是**窗口内**的合计(`window` 那一栏自证窗口在哪),`allTime` 是**全历史**。
 * 只留窗口合计会让「这个项目总共花了多少」在窗口外**静默变小** —— 而那个数字
 * 看起来完全正常。
 *
 * ── `byDayTruncated` 为什么必须存在 ──────────────────────────────
 *
 * `byDay` 可以被 `?limit=` 截短(它只是展示用的日桶),但**截短不许静默**:
 * 少几天与「那几天没花钱」在数组上长得一样,所以截断时这一位为 `true`。
 * ⚠️ `?limit=` **只截 `byDay`**,`totals` / `allTime` / `byAgent` 永远是窗口内/全历史的真值。
 */
export interface ProjectUsageView {
  /** `null` = **接待会话**(还没有项目)—— 那笔账也是真的,必须读得到 */
  projectId: string | null;
  /** 窗口:含今日共 `days` 个本地日历日,`[since, until]` 闭区间(毫秒) */
  window: { days: number; since: number; until: number };
  /** 窗口内合计 */
  totals: UsageBucketView;
  /** **全历史**合计(不受窗口影响) */
  allTime: UsageBucketView;
  /** 今日(本地日历日) */
  today: UsageBucketView;
  /** 按角色,量的降序(同量按 agentId 字典序 —— 次序固定,两次读可比对) */
  byAgent: UsageByAgentView[];
  /** 按本地日历日**升序**(旧的在前),最多 `?limit=` 天 */
  byDay: UsageByDayView[];
  /** `byDay` 是否因为 `?limit=` 被截断(**不许静默少几天**) */
  byDayTruncated: boolean;
  /** 窗口内最近一行的时刻;**窗口内没有任何记录时为 `null`**(不拿「现在」冒充) */
  updatedAt: number | null;
}

/** `GET /api/projects/:id/usage` 与 `GET /api/intake/usage` 的响应。 */
export interface ProjectUsageResponse {
  usage: ProjectUsageView;
}

/**
 * 一个回合的用量行(`turn_usage` 的一行 + 显示名)。
 *
 * 它是 WS `usage_recorded` 事件的载荷 —— 让前端在**不轮询**的前提下当天数字能
 * 立刻动。纪律与 `work_changed` / `blocker_changed` 一致:事件只递增 revision,
 * 权威值仍以 `GET .../usage` 为准(这里带上行只是让首屏不必等下一次回查)。
 */
export interface TurnUsageView {
  id: string;
  projectId: string | null;
  sessionId: string | null;
  agentId: string;
  agentName: string;
  workId: string | null;
  model: string | null;
  input: number;
  output: number;
  cacheRead: number;
  createdAt: number;
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
  | {
      type: "send";
      projectId: string | null;
      content: string;
      /**
       * 发到**哪条对话线**(migration 024)。**可省** —— 省略时服务端按
       * `(projectId, channel)` 解析出该项目的主对话,那是旧行为。
       *
       * ⚠️ **为什么它是可选的而不是必填**:可省 = 「不传也能跑」,而漏传的表现是
       * 「消息落到了主对话而不是你选的那条线」—— 那是**看得见**的错(消息出现在
       * 另一条线上),不是静默的。而必填会让**每一个**旧调用点当场编译失败,
       * 包括还没迁到多会话的那些。
       *
       * ⚠️ 服务端**校验它属于这个项目** —— 不校验就是「一条线可以被任意项目引用」,
       * 那会让消息落进一个甲方看不见的会话(7-N:见不到的现场等于没有现场)。
       */
      sessionId?: string;
    }
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

// ── 一个回合**为什么存在**(`trigger`)与这个封套**是谁发的**(`source`)─────
//
// 「用户要的不只是页面上那条由用户触发的通道」这件事(2026-10-06)在契约上
// 落成两个**互相独立**的维度,加上已有的 `agentId`,一共三个:
//
//   | 维度 | 答的问题 | 取值 |
//   |---|---|---|
//   | `agentId`(已有,§2.10.2) | **谁**在说话 | 角色 id / `null`(= 甲方) |
//   | `trigger`(本节)          | 这一轮**为什么**存在 | 用户发起 / 某条待办发起 |
//   | `source`(本节)           | 这个封套**是谁发的** | 回合驱动流程 / 播报 |
//
// **为什么 `trigger` 不能代替 `agentId`,也不能被 `agentId` 代替**:排空器叫醒
// 业务经理时说话人仍然是业务经理(`agentId` 不变),但那一轮**不是对甲方说的话**
// —— 它是 `report_downstream` / `answer_ask` 这类待办驱动的正文。
// **为什么 `source` 不能并进 `trigger`**:播报是 `tell_client` **无条件**投递的
// 一条独立消息,它不属于任何一个回合;把「显示与否」压在 `trigger` 这一维上,
// 「工件触发的汇报」那一轮里的播报会被连坐判掉(见 `BroadcastMessageStart`)。

/**
 * **待办类**触发的闭合集。
 *
 * ⚠️ **这是 `src/platform/runtime/dispatcher.ts` 的 `TodoKind`(`TODO_KINDS`)的
 * 逐字副本,不是 import。** 理由是一条分层纪律:`shared/` 是**跨端契约面**,
 * web 的 `tsconfig.web.json` 只 include `web/src` 与 `shared/` —— 连 **type-only**
 * import 一条 `src/platform/runtime/dispatcher.js` 都会把 runtime(及其
 * `better-sqlite3` 依赖)拖进 web 的类型程序。契约面**不得**反向依赖 `src/`。
 *
 * 副本的代价是「可能漂」,所以它**不靠人同步**:`src/platform/transport/hub.ts`
 * 有一对**双向互相可赋值**的编译期对账断言(`_TodoKindParity`)——
 * `TODO_KINDS` 增删一个取值时 `tsc -p tsconfig.server.json` 会当场报错。
 *
 * ⚠️ 另一个选项是 `todoKind: string`:那是把闭合集换成「什么都收」,
 * 而漏填 / 拼错的表现会退化成「这条线被判错」而**静默**(与可选字段同一条纪律)。
 */
export type TriggerTodoKind =
  | "answer_ask"
  | "attend_meeting"
  | "review_change"
  | "fix_work_assignment"
  | "resolve_blocked_work"
  /** 有工作项停在 `failed`,项目经理要重新划范围(2026-10-06 静默停摆补) */
  | "recover_failed_work"
  | "decompose_project"
  | "execute_work"
  | "review_work"
  | "integrate"
  | "handover"
  | "report_downstream"
  /** 甲方答复了业务经理的提问、而他还没处置(020 + `resume_client` 规则) */
  | "resume_client"
  /**
   * 项目里**没有一件没做完的事**了,该业务经理判断要不要收口了(022 + 规则
   * `close_finished_project`)。
   *
   * ⚠️ 它存在理由是一次**真机观察**(2026-10-06 17:2x,项目「美股自动化交易平台
   * 方案设计」):11 条工作全部 `done` + `review_state='done'`、6 条 `review_verdict`
   * 全部 `pass`、outbox 空、`openWorks=0` —— 而 `projects.status` 永远是 `active`。
   * `project_close` 工具**一直有生产调用方**(`tools/project.ts`),但**没有任何规则
   * 叫醒谁去调它**,于是「组织已经把活干完了」与「这个项目还没结束」在界面上
   * 长得一模一样。
   */
  | "close_project";

/**
 * **这几类待办回合的正文,就是给甲方看的话** —— 与「是不是 `todo` 触发」无关。
 *
 * ── 它补的是什么 ─────────────────────────────────────────────────
 *
 * 真机现场(同一个项目,2026-10-06):业务经理在**24 次**平台叫醒的回合里
 * `tell_client` 调用次数是 **0**。客户通道会话里他一共 33 条消息,按封套拆开是
 * `broadcast 8` / `turn+todo 24` / `turn+user 1` —— 而 `turn+todo` 的那 24 条
 * **甲方一条都没看到**(读面判据见 `web/src/lib/data.ts` 的 `channelOf` 第 4 步)。
 *
 * 后果不是「少了几条消息」。14:52:07 那一条 BM 写着:
 *
 * > 「这里有**一个关键张力**我必须当面说清:**live_aggressive 与 W3-Q2 已定的
 * > Cash account + < $25k 账户不匹配** …… 按业务经理纪律:冲突要当面说清。」
 *
 * 那条正文被第 4 步整条滤掉。甲方从头到尾不知道自己的两个拍板互相打架。
 *
 * ── 为什么改判据而不是改提示词 ─────────────────────────────────────
 *
 * 提示词里**已经**写着「没播报就要留一行 `[未播报]`」,而业务经理 24 次都没留
 * (其中 8 次留了 —— 恰恰说明他知道这条规矩,只是把「要交代」误当成了内部义务)。
 * **靠模型自觉的约定已经被真机证伪过一次**,所以判据这一侧必须自己站得住。
 *
 * ── 为什么这三个取值不算「语义猜测」(§2.11.3)─────────────────────
 *
 * 它是 `TriggerTodoKind` 这个**闭合集**上的一个子集,每个取值的名字本身就是它的
 * 定义:`handover` = 把交付物交付给甲方、`report_downstream` = 向下游/甲方交代、
 * `resume_client` = 处置甲方的答复。**这三件事没有一件是「组织内部在动」** ——
 * 它们按定义就是冲着甲方去的。规则仍然**不读任何正文**,判据全在闭合集上。
 *
 * ⚠️ **唯一真相在这里**:读面(`web/src/lib/data.ts`)与写面
 * (`src/platform/host/serve.ts` 的 `detectUnannouncedTurn`)都从这里取,
 * 两边各抄一份就是本项目付过好几次代价的「两份定义迟早漂」。
 */
export const CLIENT_FACING_TODO_KINDS: ReadonlySet<TriggerTodoKind> = new Set<TriggerTodoKind>([
  "handover",
  "report_downstream",
  "resume_client",
]);

/**
 * 这一类待办叫醒的回合,正文**自动**进甲方通道(说话人是 `clientFacing` 时)。
 *
 * ⚠️ **参数接受 `undefined`** —— 不是一个可以省的细节:`session_messages.todo_kind`
 * 是可空列,migration 022 之前的存量行、以及任何**没落**这一列的行,读到的都是
 * `undefined`。把 `undefined` 收进签名,就让「缺这一维」在**类型上**就是
 * `false`(fail-closed:正文留在内部通道,不上屏),而不是让每个调用点自己写一遍
 * `!== undefined` 判断 —— 漏一处就是一个静默的上屏。
 *
 * 说话人是不是 `clientFacing` **不由这个函数回答** —— 它只回答「这一轮为什么存在」。
 * 两半都成立才进甲方通道,拼装在读面(`web/src/lib/data.ts` 的 `channelOf`)。
 */
export function todoKindReachesClient(kind: TriggerTodoKind | undefined): boolean {
  return kind !== undefined && CLIENT_FACING_TODO_KINDS.has(kind);
}

/**
 * 这一轮**为什么存在**。判据只有两半(设计 1 §2.10 的通道分离):
 *
 *   - `user`  —— 甲方亲口发起的那一轮(以及在对话里回显他自己那句话的封套)。
 *     **这一轮的正文对甲方可见。**
 *   - `todo`  —— 排空器按 `collectTodos` 的待办叫醒的回合(`todoKind` 说清是哪条,
 *     取值域是**闭合集**)。**这一轮的正文不是对甲方说的话** —— 它是组织内部
 *     在动,甲方要看的是成员页里那份「他产生了什么对话」。
 *
 * ⚠️ **它不表达「播报显不显示」** —— 那是 `source` 的事(见下)。
 */
export type TurnTrigger =
  | { kind: "user" }
  | { kind: "todo"; todoKind: TriggerTodoKind };

/**
 * `TurnTrigger` 的**判别那一维**(前端 / 读面只需要它)。
 *
 * 判据只读 `kind`:通道分离问的是「这一轮为什么存在」,而 `todoKind` 是「哪一类
 * 待办」—— 后者既不参与判定,也没有任何一个前端读者(`web/src/stores/chat.ts` 的
 * `isTurnTrigger` 与 `web/src/lib/data.ts` 的 `channelOf` 都只读 `kind`)。
 * 所以它**不落库**(`migrations/019_message_origin.sql` 只存 `trigger_kind`),
 * 前端那条 `TurnOrigin` 也收窄到这一维 —— 契约上的三段联合(WS 封套 / 落库行 /
 * 前端轮)因此是**同一个形状**,`web/src/stores/chat.ts` 的 `TurnOrigin` 直接
 * 就是下面那个 `MessageOrigin`。
 */
export type TurnTriggerKind = TurnTrigger["kind"];

/**
 * 一个**回合封套**的建轮事件(`source: "turn"`)。
 *
 * 用户消息的回显与某条助手正文都走它 —— 判据是「**它由回合驱动流程发出**」,
 * 与 role / agentId 无关(那两维说的是「谁在说话」)。
 *
 * ⚠️ `trigger` **必填,不是可选** —— 与 `agentId` 同一条纪律(§2.10.2):
 * 可选 = 漏填也编译得过,而漏填的表现是「工件触发的回合正文」被当成「甲方
 * 触发的」照样进对话页(**静默判错**)。必填之后每个构造点都必须显式说清这一轮
 * 为什么存在,TS 会把它们全部点出来。
 *
 * ⚠️ `role: "user"` 的那条**也带** `trigger: { kind: "user" }`,不是冗余:
 * 「谁在说话」与「为什么有这一轮」是两个维度(见本文件 `TurnTrigger` 上方那张
 * 表)。若按 role 把它拆成「assistant 必填 / user 免填」,契约会按 role 分成两半,
 * 而「漏填」在那半边重新变成可能 —— 那正是这条纪律要关掉的门。
 *
 * 形状由下面两条编译期断言守着(`_TriggerMustBeRequired` /
 * `_MessageStartHasExactlyTwoSources`)。
 */
export interface TurnMessageStart {
  type: "message_start";
  projectId: string | null;
  messageId: string;
  role: "user" | "assistant";
  /** 谁在说话。**`null` = 甲方**(与 `SessionMessageView.agentId` 同义) */
  agentId: string | null;
  /** 这个封套是**回合驱动流程**发的(用户消息回显 + 助手正文) */
  source: "turn";
  /** 这一轮为什么存在。**必填** —— 见本接口的说明 */
  trigger: TurnTrigger;
  /** 这一轮发生在**哪条对话线**上(migration 024)。**必填** —— 见 `ServerEvent` 那段说明 */
  sessionId: string;
}

/**
 * 一个**播报封套**的建轮事件(`source: "broadcast"`)。
 *
 * **只有一处发它**:`src/platform/transport/hub.ts` 的 `clientChannel.tell`
 * (即 `tell_client` 工具投递给甲方的那条播报)。它与普通回合的三个信封
 * (`message_start` / `delta` / `message_end`)**长得一模一样**,这里是它们唯一的
 * 可分判之处。
 *
 * ⚠️ **它没有 `trigger`,这是结构性的,不是遗漏。** 播报是**无条件**投递给甲方的
 * 一条**独立消息**(它自己落库、有自己的 `messageId`,见 `hub.ts` 文件头),不属于
 * 任何一个回合。所以:
 *   - 「工件触发的汇报」那一轮里,业务经理的**正文**带
 *     `trigger.todoKind = "report_downstream"`(该被收进内部视图),
 *     而它在同一轮里做的**播报**是**另一条封套** —— 这条无条件显示。
 *   - 显示判据因此只能落在 `source` 上;`trigger` 那一维**根本不参与**播报的判定,
 *     这正是「正交」在类型上的表达:**播报封套上读不到任何 `trigger` 信息**,
 *     想「顺手用 trigger 判一下」的代码在这一支上**编译不过**。
 *
 * ⚠️ 把 `trigger` 抄到这一支上(哪怕只是为了「对称」)会让上面那条推理重新变得
 * 可写错:`_BroadcastMustNotCarryTrigger` 是一条编译期断言,加了就红。
 */
export interface BroadcastMessageStart {
  type: "message_start";
  projectId: string | null;
  messageId: string;
  role: "user" | "assistant";
  agentId: string | null;
  /** 这个封套是**播报**(`tell_client`),不是任何回合的正文 */
  source: "broadcast";
  /** 播报落在**哪条对话线**上(migration 024)。**必填** —— 同上 */
  sessionId: string;
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
 *
 * ── `message_start` 上的**另外两维**(2026-10-06 新增)─────────────────
 *
 * `message_start` 因此有三个互相独立的维度:`agentId`(谁在说)、`trigger`
 * (这一轮为什么存在)、`source`(这个封套是谁发的)。两条纪律与 `agentId` 同源:
 *
 *   ① **`trigger` 必填**(只在回合封套上)—— `todoKind` 是**闭合集**
 *      (`TriggerTodoKind`,与 `runtime/dispatcher.ts` 的 `TodoKind` 有编译期对账)。
 *   ② **播报封套(`source: "broadcast"`)不带 `trigger`** —— 播报无条件显示,
 *      它不能被任何「回合级」判据连坐。
 *
 * 三条编译期断言把这两条钉在本文件末尾(`_TriggerMustBeRequired` /
 * `_BroadcastMustNotCarryTrigger` / `_MessageStartHasExactlyTwoSources`):
 * 破坏契约的那一次 `tsc` 会红,而不是等到界面上少了一条线才被发现。
 */
export type ServerEvent =
  | { type: "ready"; modelId: string | null; provider: string | null; cwd: string }
  | { type: "pong"; ts: number }
  | TurnMessageStart
  | BroadcastMessageStart

  /**
   * ⚠️ **七条消息类事件都带 `sessionId`**(migration 024)。
   *
   * 一个项目下面现在可以有多条对话线,而前端此前**按 `projectId` 过滤**消息 ——
   * 那在 1:1 的年代是对的,现在它会把**所有线**的消息混进同一个面板。
   *
   * 为什么逐条加而不是「合成一个 message 事件」:这些事件是**流式**的,
   * `delta` / `thinking_delta` 走的是同一条 WS 连接(7-I 的两条流分离不许合并),
   * 而 `tool_start` / `tool_end` 还要带 `agentId`。
   *
   * ⚠️ **`sessionId` 是必填,不是可选** —— 与 `send` 那侧相反。理由:
   * 一个事件**落错会话**的表现是「模型在 A 线说的话出现在 B 线的面板里」,
   * 而那种错在界面上**看不出来**(它就是一段正常的回复)。漏填必须编译失败,
   * 哪怕代价是逐个改所有发射点(那个列表是封闭的:下面这七条)。
   */
  | { type: "delta"; projectId: string | null; sessionId: string; messageId: string; text: string }
  /**
   * 内部推理。**与 delta 是两条流,永不混流** ——
   * 7-I 的现场:判据写成了不存在的 "thinking",1853 字符推理落进 content
   * 被当成正式回复展示给用户。
   */
  | { type: "thinking_delta"; projectId: string | null; sessionId: string; messageId: string; text: string }
  | {
      type: "message_end";
      projectId: string | null;
      sessionId: string;
      messageId: string;
      /**
       * 这一次 LLM 调用的用量。**可选**:调用点不传时整个字段缺席
       * (与「传了一个全零的对象」不是一回事)。
       *
       * ⚠️ **2026-10-05 契约扩展:`cacheRead` 进来了。** 起因是实测:
       *
       *   call#1  input=10063  cacheRead=128
       *   call#2  input=335    cacheRead=10112     ← cacheRead 是 input 的 30 倍
       *
       * 旧契约只有 `{ input, output }`,而前端 `currentUsage` **只累加 input+output**
       * ⇒ **缓存命中的那部分完全不计** —— 而 `cacheRead` 恰恰是省钱的那一块。
       * 字段名以 `pi-ai/dist/types.d.ts` 的 `Usage` 为准:**没有** `inputTokens` /
       * `outputTokens`。
       *
       * ⚠️ **前端要跟着改**(`web/src/stores/chat.ts` 的 `currentUsage` 只累加
       * input+output,`web/src/components/chat/MessageList.tsx` 只显示 in/out)
       * —— 那两个文件不在本次改动的可碰清单里,所以本契约先行、界面在 T5 跟上。
       *
       * `cost` **刻意不在这里**(只显示 token 数,不显示金额,用户已定)。
       */
      usage?: { input: number; output: number; cacheRead: number };
    }
  | {
      type: "tool_start";
      projectId: string | null;
      sessionId: string;
      messageId: string;
      /** 谁在调这个工具。取值域与 `message_start` 同源(`null` = 甲方);实际调用方总是某个角色 */
      agentId: string | null;
      tool: WsToolInfo;
    }
  | { type: "tool_end"; projectId: string | null; sessionId: string; messageId: string; tool: WsToolInfo }
  | { type: "agent_end"; projectId: string | null; sessionId: string; ts: number }
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
   * **一个回合的用量刚落库**(`turn_usage` 多了一行)。
   *
   * ── 为什么 `projectId` 是**必填**(这类坑踩过一次)──────────────────
   *
   * 「按项目分组呈现」是这个界面的基本裁决,而一条**不带 `projectId`** 的实时
   * 事件在多项目并行时会被前端按当前上下文累积 —— 于是 A 项目花的 token 会被
   * 记到 B 项目头上(bug② 那一类跨项目污染)。所以这里**必须**带 `projectId`,
   * 而**`null` 是它的一种合法取值**(接待会话:那笔账还没有项目,见 018)。
   *
   * 这与 `message_start` / `tool_start` 的 `agentId` 是同一条纪律:
   * **类型上必填,不是可选** —— 可选 = 漏填也编译得过,而漏填的表现是静默的。
   *
   * 收到它该做的是:递增该项目的 revision(或直接把 `usage` 并进首屏数字),
   * **权威值仍以 `GET /api/projects/:id/usage` 为准** —— 事件会丢(断流),
   * 而库不会。
   */
  | { type: "usage_recorded"; projectId: string | null; usage: TurnUsageView }
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
      /**
       * **派发次数**(attempts)。⚠️ 它**不是**「跑了几个 agent 回合」:
       * 拒绝执行(工作项已是终态 / 负责人不是 worker)与建会话失败都算一次派发,
       * 却没有叫醒任何 agent。真回合数见 `turns`。
       *
       * 2026-10-05 真机:一条 `max_rounds` 告警写着「8 个 agent 回合」,而 8 次派发
       * 里只有 2 个真回合 —— 只报一个数就是**假现场**。
       */
      rounds: number;
      /** 其中**真的叫醒了一个 agent** 的次数(`≤ rounds`) */
      turns: number;
      reason: "max_rounds" | "no_progress";
      detail: string;
    }
  /**
   * `projectId` 三态:字符串 = 该项目;**`null` = 接待会话**;
   * 缺省 = 与任何上下文无关(如 JSON 解析失败)。
   */
  | { type: "error"; projectId?: string | null; error: { code: string; message: string } };

// ── 契约纪律的**编译期**断言(2026-10-06)────────────────────────────
//
// 「必填」与「正交」这两条不能只写在注释里 —— 注释不会红。这里把它们写成
// 类型层面的断言:违反时 `tsc -p tsconfig.server.json` 与
// `tsc -p tsconfig.web.json` **都会在本文件报错**(两份 tsconfig 的 include
// 都含 `shared/**`)。纯类型,不产生任何运行时代码。
//
// 负样本(已实跑,原文见报告):
//   · 把 `TurnMessageStart.trigger` 改成 `trigger?: TurnTrigger`
//     ⇒ `Type 'false' does not satisfy the constraint 'true'.`
//   · 给 `BroadcastMessageStart` 加回 `trigger`
//     ⇒ 同样报错。
// 改回来 ⇒ 两条 typecheck 都是 0 error。

/** `T` 必须**恰好**是 `true`;算出来是 `false` 时**在断言处**编译失败。 */
type AssertTrue<T extends true> = T;

/** ① `trigger` **必填**(不是可选)—— 回合封套漏填必须编译不过。 */
type _TriggerMustBeRequired = AssertTrue<
  undefined extends TurnMessageStart["trigger"] ? false : true
>;

/** ② 播报封套**不得**带 `trigger` —— 播报的显示判据与 `trigger` 那一维正交。 */
type _BroadcastMustNotCarryTrigger = AssertTrue<
  "trigger" extends keyof BroadcastMessageStart ? false : true
>;

/**
 * ③ `message_start` 的 `source` **只有两种**。
 *
 * 加第三种(例如将来某条「系统提示流」)时这一行会红 —— 那是刻意留的门:
 * 每一处「显示与否」的判据都必须显式表态,不许有一条新封套**静默地**
 * 落进「既不是回合、也不是播报」的缝隙里。
 */
type _MessageStartHasExactlyTwoSources = AssertTrue<
  Extract<ServerEvent, { type: "message_start" }>["source"] extends "turn" | "broadcast"
    ? true
    : false
>;

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
//   GET    /api/projects/:id/usage            → ProjectUsageResponse
//                                                「这个项目花了多少 token」——
//                                                合计 / 今日 / 按角色 / 最近 N 天。
//                                                **只有 token,没有金额**(见
//                                                `ProjectUsageView` 那一段)。
//                                                `?days=`(默认 7,上限 365)定窗口,
//                                                `?limit=` 只截 `byDay`(截断时
//                                                `byDayTruncated: true`)。
//   GET    /api/projects/:id/messages         → MessagesResponse
//   GET    /api/projects/:id/member-conversations → MemberConversationsResponse
//                                                「谁产生了什么对话」:按 agent_id
//                                                **在 SQL 里** GROUP BY(条数是真值,
//                                                不是「返回了多少条」)。
//   GET    /api/projects/:id/asks             → { asks: AskView[] }
//   GET    /api/projects/:id/blockers         → { blockers: BlockerView[] }
//   GET    /api/projects/:id/changes          → { changes: ChangeView[] }
//   GET    /api/projects/:id/members          → { members: MemberView[] }
//   GET    /api/projects/:id/live             → { live: ProjectLiveView }
//                                                「**此刻**在做什么」——成员页的
//                                                「正在做什么」区与工件页 DAG 的
//                                                「在跑」标记共用这一条。
//                                                它**不参与判定**:判定仍是
//                                                `collectTodos`(`?` 无查询参数)。
//                                                运行期两项(忙闩 / 定时器心跳)来自
//                                                宿主内存,接不上时 `runtime:
//                                                "unavailable"` —— 那时 `turn`
//                                                一律 null 且**不是**「没在跑」。
//   ── 接待会话(第一个项目之前)──
//   GET    /api/intake/messages               → IntakeMessagesResponse
//                                                无需先建项目就能拉到与业务经理的
//                                                那一段对话历史(刷新不丢上下文)。
//   GET    /api/intake/usage                  → ProjectUsageResponse
//                                                **接待会话那笔账**(`project_id`
//                                                为 NULL,`usage.projectId` 也是
//                                                `null`)。与上面同一条理由:
//                                                它是产品里**第一个花钱的回合**,
//                                                只写不读等于「数据在手边没有读者」。
//                                                没有接待会话时返回全零,不是 404。
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
//   /api/projects/:id/usage?days=&limit=            (days 默认 7、上限 365;
//                                                    limit 只截 byDay,默认 = days)
//   /api/intake/usage?days=&limit=                  (同上)
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
