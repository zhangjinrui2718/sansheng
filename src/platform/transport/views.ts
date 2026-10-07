/**
 * 传输层 · 行 → 视图映射
 *
 * ── 为什么单独一层 ──────────────────────────────────────────────
 *
 * 数据库行是**存储形状**,前端要的是**给人看的形状**。两者的差异不是格式,
 * 是内容:
 *
 *   - 行里是 `author_agent_id: "wk"`,前端要 `authorName: "工程师"`
 *   - 行里是 `options_json: "[\"A\",\"B\"]"`,前端要 `options: ["A","B"]`
 *   - 行里没有「这个项目有几个待答问题」,而列表页需要它
 *
 * 把解析散在每个路由里,结果是十几个路由各自 `JSON.parse` 一次、各自查一次
 * agent 名 —— 迟早有一个忘了,而表现出来只是「某个页面某个字段是空的」。
 *
 * 所以集中在这一层,并且**每个解析都容错**:坏掉的 `options_json` 不该让
 * 整个项目的接口 500。
 */
import type Database from "better-sqlite3";
import {
  listWorks, listDeps, getWork, type WorkRow,
} from "../storage/repo/works.js";
import {
  getArtifact, listArtifacts, listLinkEdges, type ArtifactRow,
} from "../storage/repo/artifacts.js";
import { listAsks, type AskRow } from "../storage/repo/asks.js";
import {
  listBlockers, listBlockedWorks, isUnresolvedBlocker, type BlockerRow,
} from "../storage/repo/blockers.js";
import { listChanges, type ChangeRequestRow } from "../storage/repo/changes.js";
import {
  listSessions, listSessionMessages, normalizeMessageLimit, isSessionMessageKind,
  type SessionMessageRow,
} from "../storage/repo/sessions.js";
import { getAgent } from "../storage/repo/agents.js";
import {
  deliveryAcceptance, deliveredDeliverables, latestDeliveryVerdict,
  type DeliveryAcceptance,
} from "../storage/repo/deliveryVerdicts.js";
import {
  getProjectRow, listProjects, listAssignments, type ProjectRow,
} from "../storage/repo/projects.js";
import { isProjectRole, type ProjectRole } from "../identity/role.js";
import type { ProjectUsageAggregate, TurnUsageRow } from "../storage/repo/usage.js";
import { collectPendingWork } from "../runtime/pendingWork.js";
import {
  collectTodos, DEFAULT_MAX_ATTEMPTS, type DriverTodo,
} from "../runtime/dispatcher.js";
import {
  getKnowledgeChunk, knowledgeOverviewStats, listPendingSources, listProjectKnowledgeStats,
  listRecentKnowledgeChunks, searchKnowledgeChunks,
  type KnowledgeChunkRow,
} from "../storage/repo/knowledge.js";
import { makeArtifactTextReader, materializeChunk, type Materialization } from "../knowledge/sources.js";
import { buildMatchQuery } from "../knowledge/query.js";
import type { WorkspacePort } from "../workspace/port.js";
import type {
  ArtifactAcceptanceView, AskView, ArtifactView, AwaitingAcceptanceView, BlockerView,
  ChangeView, ClientQuestionView, CodeServiceView,
  IntakeLiveView,
  KnowledgeChunkView, KnowledgeOverviewView, KnowledgePendingSourceView, KnowledgeProjectStatsView,
  MemberActivityView, MemberView, MessageOrigin, ProjectDetail, ProjectLifecycleStatus,
  ProjectLiveView,
  ProjectStatus,
  ProjectSummary, ProjectUsageView, UsageByWorkView,
  SessionMessageView, TurnTrigger, TurnUsageView,
  UsageByAgentView, WorkView,
} from "@shared/types/platform.js";

// ── 小工具 ──────────────────────────────────────────────────────

/** 角色名缓存。一次请求里同一个 agent 可能被查几十次。 */
function agentNameCache(db: Database.Database) {
  const cache = new Map<string, string>();
  return (id: string): string => {
    const hit = cache.get(id);
    if (hit !== undefined) return hit;
    const a = getAgent(db, id);
    const name = a !== null ? a.displayName : id;
    cache.set(id, name);
    return name;
  };
}

/** 坏掉的 JSON 不该让整个接口 500 —— 退化成空数组,并保留原始串供排查。 */
function parseStringArray(json: string | null): string[] {
  if (json === null || json.trim() === "") return [];
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function parseObject(json: string | null): Record<string, unknown> {
  if (json === null || json.trim() === "") return {};
  try {
    const v: unknown = JSON.parse(json);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function roleOf(raw: string): ProjectRole {
  // 兜底值不是「随便挑一个角色」,而是**最容易看出来的那一个**:库里出现
  // 未定义角色时,仓储层 `rowToAgent` 已经会硬抛,所以这里几乎不可达;
  // 真到了这里,返回一个真实存在的角色名比返回空串好 —— 屏幕上出现
  // `research_worker` 是「这个字段没配上」,空串只是一片空白。
  return isProjectRole(raw) ? raw : "research_worker";
}

// ── 工作项 ──────────────────────────────────────────────────────

export function toWorkView(db: Database.Database, row: WorkRow, name: (id: string) => string): WorkView {
  return {
    id: row.id,
    projectId: row.projectId,
    parentWorkId: row.parentWorkId,
    title: row.title,
    goal: row.goal,
    status: row.status,
    assigneeAgentId: row.assigneeAgentId,
    assigneeName: name(row.assigneeAgentId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    dependsOn: listDeps(db, row.id),
  };
}

// ── 工件 ────────────────────────────────────────────────────────

export function toArtifactView(
  db: Database.Database,
  row: ArtifactRow,
  name: (id: string) => string,
): ArtifactView {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    status: row.status,
    title: row.title,
    // migration 027:正文**不住库**了,这里只给**落点与写入时的快照**
    // (`bodyPath` / `bodyBytes` / `commitSha`),内容走
    // `GET /api/artifacts/:id/content` 现读(设计 §4.2)。
    //
    // ⚠️ 这里**不 stat 文件**:列表端点的载荷最多 500 条,而「文件还在不在」
    // 是读面的判断(要碰盘、要 git)。`bodyPath` 非空**不代表文件还在盘上** ——
    // 把「读不到」在这里提前编出来(比如回一个 `exists: false`)等于让列表端点
    // 替 content 端点下一个它下不了的结论。
    bodyPath: row.bodyPath,
    bodyBytes: row.bodyBytes,
    // `null` = 还没提交过(行先落库、提交在回合边界,设计 §3.4)—— 合法状态,原样透出。
    commitSha: row.commitSha,
    authorAgentId: row.authorAgentId,
    authorName: name(row.authorAgentId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    links: listLinkEdges(db, row.id),
    // migration 014 的产出边。**`null` 原样透出** —— 「不挂在任何环节上」是
    // 合法状态(决策 / 会议 / 变更 / 甲方问答),前端据此把它列在「无环节」区,
    // 这里不许拿 authorAgentId 之类去猜一个环节出来(那是编造 provenance)。
    workId: row.workId,
    // migration 025。**`null` 原样透出** —— 非交付物工件没有类型,
    // 交付物也可能是存量 NULL(016 之后写的 markdown 正文)。
    deliverableType: row.deliverableType,
    // migration 026。**只有 `code_service` 才有坐标**,其余一律 null
    // (不给一个「空对象」—— 空对象在界面上会被读成「有坐标但全是空」,
    //  而 `null` 读成「这不是代码服务」,两者是不同的信息)。
    codeService:
      row.deliverableType === "code_service" ? parseCodeServiceView(row.metadataJson) : null,
    // 甲方收货(029)。**只有交付物才有这一项** —— 非交付物给它一个空对象,
    // 读面会把「有一份在等验收」读出来(空对象 ≠ 没有)。
    acceptance: row.kind === "deliverable" ? acceptanceOfArtifact(db, row) : null,
  };
}

/**
 * 一份交付物的**收货**进展(029) —— `ArtifactView.acceptance` 的唯一来源。
 *
 * 两件事各查一次,都很便宜(交付物数量级是个位数):
 *   · `handedOver` / 交付时间 —— `project_sessions.deliverable_artifact_id`;
 *   · `verdict` / `note` / `at` —— `delivery_verdicts` 里最新的那条。
 *
 * ⚠️ **`verdict: null` 与 `handedOver: false` 是两件不同的事**,读面必须分开处置:
 *   · 没交付 → 等业务经理(他还没把货交出去);
 *   · 交付了没表态 → 等甲方(球在他那边)。
 * 混成一个「未完成」,页面就没法告诉用户该等谁 —— 而「等谁」正是这次改动的全部内容。
 */
function acceptanceOfArtifact(
  db: Database.Database,
  row: ArtifactRow,
): ArtifactAcceptanceView {
  const delivered = db
    .prepare(`SELECT created_at FROM project_sessions WHERE deliverable_artifact_id = ? LIMIT 1`)
    .get(row.id) as { created_at: number } | undefined;
  const verdict = latestDeliveryVerdict(db, row.id);
  const project = getProjectRow(db, row.projectId);
  return {
    handedOver: delivered !== undefined,
    verdict: verdict?.verdict ?? null,
    note: verdict?.note ?? null,
    at: verdict?.createdAt ?? null,
    // ⚠️ 项目读不到时按**收口**处理(fail-closed):给一排一定会 409 的按钮,
    // 比少给一个按钮坏得多(前者是「平台让我点了又拒」)。
    projectClosed: project === null || isTerminalProjectStatus(project.status),
  };
}

/**
 * 项目是不是**终态**(收口不可逆)`done` / `abandoned`。
 *
 * 判据只有这一处 —— 收口门、验收读面、`pendingAcceptance` 的口径都从它来。
 * 写两遍就会出现「状态说已结项、而页面还在等你验收」这种自相矛盾。
 */
export function isTerminalProjectStatus(s: ProjectStatus): boolean {
  return s === "done" || s === "abandoned";
}

/**
 * `metadata_json` → 代码服务坐标(migration 026)。
 *
 * ── 为什么在**服务端**解析,而不是把 `metadata_json` 原样丢给前端 ──────
 *
 *   ① `ArtifactView` 是列表端点的载荷(单次最多 500 条)。把原始 JSON 透出去
 *      等于让每条工件都背一段没人读的字符串;
 *   ② `metadata_json` 里有什么取决于**调用方传了什么**,把它原样交给前端就等于
 *      让前端消费一个没有契约的形状 —— 而这份契约(`CodeServiceView`)只有一个
 *      消费点,值得在边界处收口;
 *   ③ 解析规则只有一处:老行 / 手改的行里可能有缺项或错类型,收口之后
 *      「读不到」这件事只有一种说法。
 *
 * ⚠️ **缺一项就是 `null`,不许填默认值、不许抛。** 一条读不出来坐标的交付物
 * 在界面上应当显示「读不到」—— 而编一个默认端口会让人照着一条错的命令去部署。
 *
 * ⚠️ **2026-10-08 起坐标是六项**(设计 §3.2):`servicePath` 是交付物的**边界**
 * (构建上下文),`deliverableCommit` / `deliverableSubject` 是**这版交付物**
 * (≠ `headCommit`:平台每回合写工件都会让 HEAD 动,而交付物可能没变),
 * `ignoredFiles` 是「交付物会缺这些」(被 `.gitignore` 吃掉 ⇒ 甲方 clone 不到)。
 * 四者都**按同一套规矩**解析:缺项给 `null`(数组给 `[]`),不猜、不编。
 */
function parseCodeServiceView(metadataJson: string | null): CodeServiceView {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v : null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const strs = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const empty: CodeServiceView = {
    repoPath: null, repoName: null, servicePath: null, branch: null,
    headCommit: null, headSubject: null,
    deliverableCommit: null, deliverableSubject: null,
    commitCount: null, dockerfile: null, service: null, port: null,
    files: [], ignoredFiles: [],
  };
  if (metadataJson === null || metadataJson.trim() === "") return empty;
  let raw: unknown;
  try {
    raw = JSON.parse(metadataJson);
  } catch {
    return empty;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return empty;
  const m = raw as Record<string, unknown>;
  return {
    repoPath: str(m["repoPath"]),
    repoName: str(m["repoName"]),
    servicePath: str(m["servicePath"]),
    branch: str(m["branch"]),
    headCommit: str(m["headCommit"]),
    headSubject: str(m["headSubject"]),
    deliverableCommit: str(m["deliverableCommit"]),
    deliverableSubject: str(m["deliverableSubject"]),
    commitCount: num(m["commitCount"]),
    dockerfile: str(m["dockerfile"]),
    service: str(m["service"]),
    port: num(m["port"]),
    files: strs(m["files"]),
    // 空数组 = **没有**被忽略的文件(不是「读不到」);整条坐标读不到由
    // `service === null` / `codeService === null` 表达。两者是不同的信息:
    // 「交付物是完整的」与「这件事我没读到」。
    ignoredFiles: strs(m["ignoredFiles"]),
  };
}

/**
 * `client_question` 工件 → 给甲方看的问题。
 *
 * 问题正文在 `title`,候选与倾向在 `metadata_json`(由 `ask_client` 工具写入)。
 * **不能只读 body** —— 那个字段是渲染好给人看的散文,解析不出结构。
 */
export function toClientQuestionView(
  db: Database.Database,
  row: ArtifactRow,
  name: (id: string) => string,
): ClientQuestionView {
  const meta = parseObject(row.metadataJson);
  const options = Array.isArray(meta["options"])
    ? (meta["options"] as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  const lean = typeof meta["lean"] === "string" ? meta["lean"] : null;
  const project = getProjectRow(db, row.projectId);

  return {
    id: row.id,
    projectId: row.projectId,
    projectName: project?.name ?? row.projectId,
    question: row.title,
    options,
    lean,
    askedByAgentId: row.authorAgentId,
    askedByName: name(row.authorAgentId),
    createdAt: row.createdAt,
    status: row.status,
  };
}

// ── 提问 ────────────────────────────────────────────────────────

export function toAskView(db: Database.Database, row: AskRow, name: (id: string) => string): AskView {
  return {
    id: row.id,
    projectId: row.projectId,
    fromAgentId: row.fromAgentId,
    fromName: name(row.fromAgentId),
    toAgentId: row.toAgentId,
    toName: name(row.toAgentId),
    question: row.question,
    hypothesis: row.hypothesis,
    options: parseStringArray(row.optionsJson),
    needs: row.needs,
    status: row.status,
    parentAskId: row.parentAskId,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt,
    deadlineAt: row.deadlineAt,
  };
}

// ── 阻塞与变更 ──────────────────────────────────────────────────

export function toBlockerView(
  db: Database.Database,
  row: BlockerRow,
  name: (id: string) => string,
): BlockerView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    detail: row.detail,
    severity: row.severity,
    status: row.status,
    raisedByName: name(row.raisedByAgentId),
    createdAt: row.createdAt,
    // 「它卡住了哪些工作项」—— 只说「项目有 3 个阻塞」是说不出甲方案要的答案的
    blockedWorkIds: listBlockedWorks(db, row.id),
  };
}

export function toChangeView(row: ChangeRequestRow): ChangeView {
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    rationale: row.rationale,
    status: row.status,
    createdAt: row.createdAt,
  };
}

// ── 会话消息 ────────────────────────────────────────────────────

/**
 * 把库里那两列(`origin_source` / `trigger_kind`,migration 019)合成
 * `MessageOrigin` —— **封套形状的唯一合成点**。
 *
 * 放在这一层(读面)而不是仓储:仓储交出的是「库里有什么」,把两列**合成一个
 * 判别联合**(以及「哪两种组合是合法的」)是读面的事 —— 与 `toWorkView` /
 * `toAskView` 同一条分工。
 *
 * ── 三个分支的顺序就是判据的顺序 ─────────────────────────────────
 *
 *   1. `broadcast` ⇒ 播报封套。**无条件**进甲方通道,所以这里**不读**
 *      `triggerKind`(契约上它也不该有值:写口的守卫在
 *      `appendSessionMessage` 里拒了那种形状);
 *   2. `turn` + 触发维度 ⇒ 回合封套,前端按 `trigger.kind` 分流;
 *   3. 两列都为 `NULL` ⇒ `unknown`。**这是 019 之前写入的存量行**,也是
 *      `kind='system'` 的平台通知 —— 前端对 `unknown` 的回退判据(按角色两跳)
 *      对它们继续有效,这是有意的处置,不是遗漏。
 *
 * ⚠️ 剩下的组合(`turn` 缺 `trigger_kind`、或没有来源却有触发维度)是**写口的
 * 不变式拒绝过的形状** ⇒ 走到这里说明库被绕过写口写过。**抛**,不静默降级成一个
 * 猜的封套:猜错的方向正好是这次要修的 bug(把内部回合当成甲方的)。
 */
export function messageOriginOf(row: SessionMessageRow): MessageOrigin {
  if (row.originSource === "broadcast") return { source: "broadcast" };
  if (row.originSource === "turn" && row.triggerKind !== null) {
    // ⚠️ `todoKind` **只在真的读到值时才带上**(migration 022):它是可空列,
    // 022 之前的存量行永远是 `null`,而**回填是编造**(该迁移文件头记了为什么)。
    // 缺它的那一批继续走「一律进内部通道」的旧判据 —— 方向是 fail-closed:
    // 宁可甲方少看一条,也不把一条内部推演永久上屏。
    return row.todoKind === null
      ? { source: "turn", trigger: { kind: row.triggerKind } }
      : { source: "turn", trigger: { kind: row.triggerKind, todoKind: row.todoKind } };
  }
  if (row.originSource === null && row.triggerKind === null) {
    return { source: "unknown" };
  }
  throw new Error(
    `session_messages 行上的封套形状不合法(id=${row.id}:origin_source=` +
      `${String(row.originSource)}, trigger_kind=${String(row.triggerKind)})—— ` +
      `写口(appendSessionMessage)只接受 (turn,+trigger) / (broadcast,null) / (null,null)`,
  );
}

export function toMessageView(
  row: SessionMessageRow,
  name: (id: string) => string,
  /** 这条消息属于哪个项目;`null` = 接待会话。**必须显式传入** —— 行里只有 sessionId */
  projectId: string | null,
): SessionMessageView {
  return {
    id: row.id,
    projectId,
    // ⚠️ `sessionId` **行里就有**(列名 `session_id`),不像 `projectId` 要调用点
    // 传进来 —— 那是消息属于哪个项目,而它能从行里推出的只有 session。
    // 前端按它把消息分流到对应的那条对话线(migration 024)。
    sessionId: row.sessionId,
    agentId: row.agentId,
    agentName: row.agentId !== null ? name(row.agentId) : null,
    kind: row.kind,
    content: row.content,
    createdAt: row.createdAt,
    // **封套跟着走**(W3-①):不带上它,REST 回填那条路上前端只能编一个
    // `unknown` —— 而 `unknown` 会走回退判据,把工件触发的业务经理回合放进
    // 对话页。判据从此**流式与刷新后是同一个**。
    origin: messageOriginOf(row),
  };
}

/**
 * 一条会话(项目会话**或接待会话**)的最新消息,按时间归并。
 *
 * `projectId === null` = 接待会话(第一个项目之前,见
 * `migrations/012_intake_session.sql`)。走同一个函数是有意的:接待会话与项目会话
 * 是**同一种东西**,只是前者还没有项目 —— 两套读法迟早会漂。
 *
 * ── `limit` 的语义:**每个会话各取最新 `limit` 条**(不是「全体最新 limit 条」)──
 *
 * 调用方是对话页(HTTP 的两条路由 + `web/src/lib/data.ts` 的通道分流),它一次
 * 拿回全部消息再按通道分开渲染。所以 `limit` 是**一条对话**的窗口,不是整个
 * 项目的配额:
 *
 *   - `thinking` / `tool` 也落库,内部会话轻易超过 `limit`。若 `limit` 是**全体**
 *     的,甲方那场交付对话(设计 1 §2.11.6 的可见性不变量:交付会话与内部会话
 *     是两条)会被内部刷屏整段挤出窗口;
 *   - 而被挤掉这件事**在页面上看不出来** —— `partitionTurns().hidden` 数的是
 *     「拿到的轮里被通道滤掉几条」,数不出「压根没拿到的那些」。
 *
 * 代价(如实写在这里):单次响应最多 `limit × 会话数` 条。项目里会话数在结构上
 * 很少 —— 一条 `internal`(每项目至多一条)+ **每场交付一条 `client`**。
 *
 * ── 为什么没有「归并后再切一刀」──────────────────────────────────
 *
 * 这里曾经在归并之后 `out.slice(-limit)`:输入是「每个会话各取**最早** limit 条」,
 * 那一刀切出来的就不是「最新的 limit 条」,而是「最早那批里较晚的一部分」——
 * 与上面「按时间归并」的注释自相矛盾。它与最早的 `ORDER BY created_at LIMIT`
 * 是 bug① 的两层,只修一层等于没修:若保留这一刀,每会话窗口(它必然**是**
 * 全体最新 limit 条的父集)又会被削回全体最新 limit 条,「每会话」当场失效。
 *
 * ── 次序:`(createdAt, id)` 全序 ────────────────────────────────
 *
 * 同一毫秒的消息本来就不可排序,`id` 只做第二键 —— 要的是**全序**(两次调用
 * 结果一样、换 `limit` 不换行),不是「真实发生次序」的断言。它与
 * `listSessionMessages` 的 `ORDER BY created_at DESC, id DESC` 是同一把尺,
 * 所以「每会话取最新 N 条」的截断与这里的归并同序。
 */
export function listProjectMessages(
  db: Database.Database,
  projectId: string | null,
  limit = 200,
  /**
   * **只看哪一条对话线**(migration 024)。`null` = 全部会话归并(旧行为)。
   *
   * ⚠️ 归并模式在多会话下**仍然可用但不该用在对话页**:一个项目下面现在有多条
   * 线,把它们按时间混成一条会让「模型在 A 线说的话出现在 B 线的面板里」。
   * 对话页**必须**传 `sessionId`;归并留给「这个项目一共说过什么」这类
   * 全景视图(成员页的 `memberConversations` 就是另一条读面)。
   */
  sessionId?: string,
): SessionMessageView[] {
  const perSession = normalizeMessageLimit(limit);
  // `0` = 「一条都不要」。别把它喂给 SQL:`LIMIT NULL` 在 SQLite 里是不设上限。
  if (perSession === 0) return [];
  const name = agentNameCache(db);
  const sessions = sessionId === undefined
    ? listSessions(db, projectId)
    : listSessions(db, projectId).filter((s) => s.id === sessionId);
  const out: SessionMessageView[] = [];
  for (const s of sessions) {
    for (const m of listSessionMessages(db, s.id, perSession)) {
      out.push(toMessageView(m, name, projectId));
    }
  }
  // 多个会话时按时间归并 —— `(created_at, id)` 是全序(第二键见下面那句注释)。
  // 对话页传了 `sessionId` 时这里只有一条会话,归并是恒等操作。
  out.sort((a, b) => a.createdAt - b.createdAt || compareId(a.id, b.id));
  return out;
}

/**
 * 全序的第二键(见 `listProjectMessages` 的次序说明)。
 *
 * 用码点比较而不是 `localeCompare` —— 后者随 locale 变,而「全序」的全部价值
 * 就在于它对同一份数据永远给同一个答案。
 */
function compareId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── 用量(回合烧了多少 token)────────────────────────────────────
//
// 仓储(`repo/usage.ts`)交出的是**纯数字 + agent_id**;「谁」与「给人看的名字」
// 在这一层补 —— 与 `toWorkView` / `toAskView` 同一条分工。这一层**不查二次聚合**:
// 窗口、按天分桶、截断标记全在仓储里定完,这里只做映射。

/**
 * 解析用量行上的 agent。
 *
 * ── 为什么**抛错而不兜底** ──────────────────────────────────────
 *
 * `turn_usage.agent_id` 有外键指向 `agents(id)`,所以正常路径上**一定查得到**。
 * 查不到只可能是「有人绕过外键写进来的坏数据」,而那种情况按本仓纪律要**响亮**
 * (`getAgent` 对未知 role 本来也抛,见 `agents.ts` 的 `rowToAgent`)。
 * 静默回一个像名字的 id 会让「账上出现了一个不存在的人」在页面上看起来完全正常
 * —— 那正是最难查的一类。
 */
function usageAgentOrThrow(db: Database.Database, agentId: string): { displayName: string; role: ProjectRole } {
  const agent = getAgent(db, agentId);
  if (agent === null) {
    throw new Error(
      `turn_usage 里出现不存在于 agents 表的 agent_id「${agentId}」—— 外键本该拦住它`,
    );
  }
  return { displayName: agent.displayName, role: agent.role };
}

/**
 * 一条 `turn_usage` 行 → WS `usage_recorded` 的载荷。
 *
 * 只映射一行(不含聚合):实时事件要的是「刚刚多了一笔」,而**权威的合计仍由
 * `GET .../usage` 给出** —— 事件会丢(断流),库不会。
 */
export function toTurnUsageView(db: Database.Database, row: TurnUsageRow): TurnUsageView {
  const agent = usageAgentOrThrow(db, row.agentId);
  return {
    id: row.id,
    projectId: row.projectId,
    sessionId: row.sessionId,
    agentId: row.agentId,
    agentName: agent.displayName,
    workId: row.workId,
    model: row.model,
    input: row.inputTokens,
    output: row.outputTokens,
    cacheRead: row.cacheRead,
    createdAt: row.createdAt,
  };
}

/**
 * 把用量聚合映射成协议里的 `ProjectUsageView`。
 *
 * 空 `byAgent`(项目一分钱没花)是**合法**的,返回空数组,不是错误。
 */
export function toProjectUsageView(
  db: Database.Database,
  agg: ProjectUsageAggregate,
): ProjectUsageView {
  const byAgent: UsageByAgentView[] = agg.byAgent.map((b) => {
    const agent = usageAgentOrThrow(db, b.agentId);
    return {
      agentId: b.agentId,
      agentName: agent.displayName,
      role: agent.role,
      input: b.input,
      output: b.output,
      cacheRead: b.cacheRead,
      turns: b.turns,
    };
  });

  // 工作项标题:仓储只交 id(`agentId` 同一条规矩),名字在这一层解析。
  // 查不到就是 `null`(工作项被删过 / id 拼错)—— **不许拿 id 冒充标题**。
  const byWork: UsageByWorkView[] = agg.byWork.map((b) => ({
    workId: b.workId,
    workTitle: b.workId === null ? null : (getWork(db, b.workId)?.title ?? null),
    input: b.input,
    output: b.output,
    cacheRead: b.cacheRead,
    turns: b.turns,
  }));

  return {
    projectId: agg.projectId,
    window: agg.window,
    totals: { ...agg.totals },
    allTime: { ...agg.allTime },
    today: { ...agg.today },
    byAgent,
    byWork,
    byDay: agg.byDay.map((d) => ({
      day: d.day,
      input: d.input,
      output: d.output,
      cacheRead: d.cacheRead,
      turns: d.turns,
    })),
    byDayTruncated: agg.byDayTruncated,
    updatedAt: agg.updatedAt,
  };
}

// ── 项目 ────────────────────────────────────────────────────────

function countsOf(db: Database.Database, projectId: string) {
  const works = listWorks(db, projectId);
  const artifacts = listArtifacts(db, projectId);
  const questions = artifacts.filter((a) => a.kind === "client_question" && a.status === "open");
  const blockers = listBlockers(db, projectId).filter((b) => isUnresolvedBlocker(b.status));
  return {
    works: works.length,
    openWorks: works.filter((w) => w.status !== "done" && w.status !== "failed" && w.status !== "cancelled").length,
    artifacts: artifacts.length,
    pendingQuestions: questions.length,
    openBlockers: blockers.length,
  };
}

/**
 * 读面上的**生命周期状态** = 库里的 `projects.status` + 派生值「待收货」(029)。
 *
 * 判据只有一条(用户裁决 2026-10-08:「业务经理把交付物给到甲方之后,项目进入
 * 『待收货』状态」):**存在已交付、甲方还没表态的交付物**。
 *
 * ⚠️ **只精化 `active`**:`paused` 是组织/用户显式按下的暂停,`done`/`abandoned`
 * 是终态 —— 那三种状态下「还有货没验收」是另一件事(它是收不了口的原因,不是
 * 项目此刻的状态)。混进去会让「我按了暂停」在屏幕上变成「等收货」。
 *
 * ⚠️ 它**不进数据库**(理由:重建 `projects` 要动 14 张 CASCADE 子表,
 * 见 `migrations/029_delivery_verdicts.sql` 文件头)。所以读面是它唯一的出口 ——
 * 任何新读面都必须调这个函数,不许自己写一份判断。
 */
function lifecycleOf(
  row: ProjectRow,
  acceptance: DeliveryAcceptance,
): ProjectLifecycleStatus {
  if (row.status !== "active") return row.status;
  return acceptance.pending.length > 0 ? "awaiting_acceptance" : row.status;
}

/**
 * **能不能真的验收**(= 有没有可行动的「待收货」)。
 *
 * ⚠️ 与 `lifecycleOf` 分开:那个说的是「项目此刻是什么状态」,**这个说的是
 * 「有没有一件甲方能动手的事」**。终态项目两种都不是 —— 它既不是待收货,
 * 也不该给按钮(`POST /api/artifacts/:id/verdict` 会回 409,理由:收口不可逆)。
 *
 * 收口项目上「某份交付物从没被验收过」是**历史事实**,它由该交付物自己的卡片
 * 如实说出(`ArtifactAcceptanceView.projectClosed`),**不进这张待办清单** ——
 * 兑现不了的队列不是队列(2026-10-07 那条裁决的同一条推理)。
 */
function actionableAcceptance(
  row: ProjectRow,
  acceptance: DeliveryAcceptance,
): readonly string[] {
  if (isTerminalProjectStatus(row.status)) return [];
  return acceptance.pending;
}

export function toProjectSummary(db: Database.Database, row: ProjectRow): ProjectSummary {
  // ⚠️ **判据只算一次**:派生状态与计数来自**同一次** `deliveryAcceptance` 调用 ——
  // 算两次会让「状态显示待收货、计数写 0」这种自相矛盾的读面有机会出现。
  const acceptance = deliveryAcceptance(db, row.id);
  return {
    id: row.id,
    name: row.name,
    client: row.client,
    goal: row.goal,
    status: lifecycleOf(row, acceptance),
    createdAt: row.createdAt,
    counts: {
      ...countsOf(db, row.id),
      // 终态项目恒 0:计数与下面那张清单必须**同口径**,否则会得到
      // 「徽标写着 7、清单是空」这种自相矛盾的页面。
      pendingAcceptance: actionableAcceptance(row, acceptance).length,
    },
  };
}

export function listProjectSummaries(
  db: Database.Database,
  status?: ProjectRow["status"],
): ProjectSummary[] {
  return listProjects(db, status).map((r) => toProjectSummary(db, r));
}

export function listProjectMembers(db: Database.Database, projectId: string): MemberView[] {
  const out: MemberView[] = [];
  for (const a of listAssignments(db, projectId)) {
    const agent = getAgent(db, a.agentId);
    if (agent === null) continue;
    out.push({
      id: agent.id,
      role: roleOf(agent.role),
      displayName: agent.displayName,
      specialization: agent.specialization,
    });
  }
  return out;
}

export function toProjectDetail(db: Database.Database, row: ProjectRow): ProjectDetail | null {
  const name = agentNameCache(db);
  const works = listWorks(db, row.id).map((w) => toWorkView(db, w, name));
  const questions = listArtifacts(db, row.id, { kind: "client_question", status: "open" })
    .map((a) => toClientQuestionView(db, a, name));
  // ⚠️ `toProjectSummary` 里已经算过一次收货判据 —— 这里再算一次是**同一个纯函数**,
  // 不是第二份定义(它只读库、没有副作用)。写成共享变量会让 `...toProjectSummary`
  // 与这一行之间多一个必须保持同步的隐形耦合,而这个函数本身足够便宜。
  const acceptance = deliveryAcceptance(db, row.id);
  return {
    ...toProjectSummary(db, row),
    members: listProjectMembers(db, row.id),
    works,
    pendingQuestions: questions,
    awaitingAcceptance: awaitingAcceptanceOf(db, row, acceptance),
  };
}

/**
 * 「等你验收」的清单(029)—— 已交付、甲方还没表态的交付物。
 *
 * ⚠️ **与收口门同源**:两边都走 `deliveryAcceptance`(`repo/deliveryVerdicts.ts`)。
 * 页面说「还有 2 份等你验收」而收口门认为可以收口,是本项目最忌的那种自相矛盾 ——
 * 两份判据长得像、结论相反,而屏幕上看起来一切正常。
 *
 * ⚠️ **读不到就跳过这一条**,不编一个标题:交付物被删掉(库被清理过)时,
 * 列表里少一条而**计数照样来自同一次判据** —— 少的那条在项目页的计数里仍看得见。
 * 反过来给它编一个「(未知交付物)」的标题,是让读面替库里不存在的东西说话。
 */
function awaitingAcceptanceOf(
  db: Database.Database,
  row: ProjectRow,
  acceptance: DeliveryAcceptance,
): AwaitingAcceptanceView[] {
  const projectId = row.id;
  // ⚠️ **终态项目没有「待收货」这件事**:收口不可逆,验收接口会 409。
  // 把那些交付物列进「待你验收」= 给用户一件做不到的事(2026-10-07
  // 「收口项目的提问不进待答队列」是同一条处置)。它们**没有被删掉** ——
  // 交付物自己的卡片会如实写「项目已收口 · 这一版没有被验收过」。
  if (isTerminalProjectStatus(row.status)) return [];
  if (acceptance.pending.length === 0) return [];
  const deliveredAt = new Map(
    deliveredDeliverables(db, projectId).map((d) => [d.artifactId, d.deliveredAt]),
  );
  const out: AwaitingAcceptanceView[] = [];
  for (const id of acceptance.pending) {
    const a = getArtifact(db, id);
    if (a === null) continue;
    out.push({
      artifactId: a.id,
      title: a.title,
      deliveredAt: deliveredAt.get(id) ?? a.updatedAt,
      deliverableType: a.deliverableType,
    });
  }
  return out;
}

/** 全项目等甲方答的问题(左栏徽标 + 待办列表)。 */
/**
 * 全局「待答」队列 —— **跨项目是有意的**,但**收口项目的提问不算待答**。
 *
 * ── 为什么跨项目 ──────────────────────────────────────────────────
 *
 * 甲方可能在任何一条对话线里被业务经理问到「W3 那个结论还成立吗」。若这一块
 * 只显示当前项目的,别处的提问就又变成没人知道 —— 那正是这个面板存在的理由。
 * 所以:**当前项目的不标项目名**(它在「本项目」底下,归属不言自明),别的项目
 * 的带一行暗色项目名(`ClientQuestionDock` 的 `DockCard`)。跨项目的事实如实显示。
 *
 * ── 为什么排除收口的项目(2026-10-07 真机事故)──────────────────────
 *
 * 真机现场:项目「美股自动化交易平台方案设计·单报告合并版」于 2026-10-07 00:27
 * 收口(`done`),业务经理在**收口之后 8.5 小时**(09:03 / 09:13)又提了 3 个问题。
 * 三件事凑成一个**兑现不了的承诺**:
 *
 *   ① 提得到 —— `authorize.ts` 的 `PROJECT_SCOPED_PREFIXES` **不含 `client.`**,
 *      所以收口后 `ask_client` 仍然可用。这是**有意**的(「豁免的是说话,不是改」)。
 *   ② 没人会处理 —— `host/serve.ts` 的 `drainAll` 排的是
 *      `listProjects(db, "active")`,**终态项目永远不进排空器**。
 *   ③ 所以那 3 条 `status='open'` + `consumed_at=NULL` **永远不会有人被叫醒去处置**,
 *      却一直挂在「待答」里 —— 用户点「回答」会落一条 `decision` 工件,然后**没有任何
 *      人被叫醒**,而这一条仍然挂着。
 *
 * 「待答」这个词承诺的是「你答了会有人处理」。兑现不了的队列不是队列,是噪音,
 * 而且是**看起来很正常**的噪音(它是「零待办」与「有人欠你三个回答」长得一模一样
 * 的那种)。⇒ 收口项目的提问**不再是待答**,它属于历史。
 *
 * ⚠️ **事实一条都不删**:工件与 `client_questions` 行原样留在库里,项目页
 * (`ProjectDetail` 的「待答问题」,那个读面本来就是项目内的)照常显示,答复接口
 * 也仍然可用(它落一条 `decision` 工件,那是审计事实)。这里只决定**「待答」这个词
 * 覆盖哪一批**。
 *
 * ⚠️ **不静默丢弃**:被排除的条数由 `fromClosedProjects` 一并返回,前端必须显示出来。
 * 悄悄少三条会让用户以为「问题自己消失了」—— 那正是 7-N(见不到现场等于没有现场)。
 */
export function listAllClientQuestions(db: Database.Database): {
  questions: ClientQuestionView[];
  /** 因项目已收口而**没有**进入待答队列的条数。⚠️ 必须被显示,不许静默丢弃。 */
  fromClosedProjects: number;
} {
  const name = agentNameCache(db);
  const out: ClientQuestionView[] = [];
  let fromClosedProjects = 0;
  for (const p of listProjects(db)) {
    const closed = p.status === "done" || p.status === "abandoned";
    for (const a of listArtifacts(db, p.id, { kind: "client_question", status: "open" })) {
      if (closed) {
        fromClosedProjects += 1;
        continue;
      }
      out.push(toClientQuestionView(db, a, name));
    }
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return { questions: out, fromClosedProjects };
}

export function listProjectAsks(db: Database.Database, projectId: string): AskView[] {
  const name = agentNameCache(db);
  return listAsks(db, projectId).map((a) => toAskView(db, a, name));
}

export function listProjectBlockers(db: Database.Database, projectId: string): BlockerView[] {
  const name = agentNameCache(db);
  return listBlockers(db, projectId).map((b) => toBlockerView(db, b, name));
}

export function listProjectChanges(db: Database.Database, projectId: string): ChangeView[] {
  return listChanges(db, projectId).map(toChangeView);
}

export function listProjectArtifacts(
  db: Database.Database,
  projectId: string,
  filter: { kind?: ArtifactRow["kind"]; status?: ArtifactRow["status"]; limit?: number } = {},
): ArtifactView[] {
  const name = agentNameCache(db);
  return listArtifacts(db, projectId, filter).map((a) => toArtifactView(db, a, name));
}

// ── 运行态(「此刻在做什么」)───────────────────────────────────────
//
// 这一节的读者只有一个:**成员页的「正在做什么」区 + 工件页 DAG 的在跑标记**。
// 它**不参与任何判定** —— 判定仍然只有一处(`runtime/dispatcher.ts` 的
// `collectTodos`),这里只是把它的结果连同两个**内存事实**端出来。
//
// 为什么把它放在 views 层而不是 http 层:与其它视图同一条理由 —— 行 / 内存
// 片段 → 给人看的形状。放在路由里,「哪几个来源拼成了这个视图」就散在路由函数体
// 里,而它正是这一节最需要看得清的东西(三个来源语义完全不同,见下)。

/**
 * 宿主运行期快照 —— **只读,而且只用于如实报告**。
 *
 * 三项都是**内存**事实(`host/serve.ts` 持有),因此有一个结构性的性质:
 * **进程一重启就清零**。这正是它必须与库里的真状态(工作项 / 待办)**分开**
 * 呈现的原因 —— 混成一个字段之后,「重启后还没跑过任何回合」与「一切正常但没有
 * 在跑的回合」在界面上会长得一样。
 *
 * `null`(没接上)时读面如实返回 `runtime: "unavailable"`,而不是把
 * `turn: null` 冒充成「空闲」。
 */
export interface LiveRuntimeSnapshot {
  /** 此刻占着忙闩的回合(`transport/hub.ts` 的 `busy`)。`trigger` 是这一轮为什么存在 */
  readonly turns: ReadonlyArray<{
    readonly projectId: string | null;
    readonly agentId: string;
    readonly startedAt: number;
    readonly trigger: TurnTrigger;
  }>;
  /** 排空器兜底定时器(`host/scheduler.ts` 的 fixed-delay)的心跳 */
  readonly dispatch: { readonly intervalMs: number; readonly lastRunAt: number | null };
  /** 此刻正在排空的项目 id */
  readonly drainingProjects: readonly string[];
}

/**
 * `collectTodos` 的那几个旋钮 —— **必须与宿主排空时用的是同一份**。
 *
 * 不这么接的后果很具体:用户用 `--report-batch-size 10` 起了服务,排空器要攒够
 * 10 条才叫醒业务经理,而页面按缺省的 3 条显示「它现在就该跑」—— 界面开始
 * **自信地说一个排空器不会做的动作**。这类谎与「显示 0 个工具」是同一类,
 * 所以这几个旋钮由宿主原样交给读面,不由读面自己填默认值。
 */
export interface LiveCollectOptions {
  readonly maxAttemptsPerTodo?: number;
  readonly reportBatchSize?: number;
  readonly reportMaxDelayMs?: number;
}

/**
 * 接待会话的运行态 —— 与 `toProjectLiveView` 读**同一份** `runtime` 快照,
 * 只是按上下文过滤(`projectId === null`)。
 *
 * ── 为什么接待需要它(2026-10-07 真机)──────────────────────────
 *
 * 对话页顶部那盏灯此前**只**由 WS 实时事件推出来,而 WS **没有回放** ⇒
 * 刷新、或切走再切回来(`selectProject` 清 `inFlight`)之后,一个**还在跑**的
 * 回合在屏幕上变成「就绪」。项目那条有 `GET /live` 可查,接待此前连端点都没有
 * (404)⇒ 这条洞在接待里没有任何补救机会。
 *
 * **这里不读库**:接待没有项目行,而这条要回答的只有「此刻有没有人在跑」。
 * `runtime === null` ⇒ 如实报 `unavailable`,**不是** `runningTurns: 0` 而不加区分
 * ——「读不到」与「没在跑」不许长得一样(与 `ProjectLiveView.runtime` 同源)。
 */
export function toIntakeLiveView(
  now: number,
  runtime: LiveRuntimeSnapshot | null,
): IntakeLiveView {
  if (runtime === null) {
    return { at: now, runtime: "unavailable", runningTurns: 0, turns: [] };
  }
  const turns = runtime.turns
    .filter((t) => t.projectId === null)
    .map((t) => ({
      agentId: t.agentId,
      // 负数不该出现;真出现也只报 0,不把「时钟倒退」显示成「已经跑了负几秒」。
      elapsedMs: Math.max(0, now - t.startedAt),
      trigger: t.trigger,
    }));
  return { at: now, runtime: "host", runningTurns: turns.length, turns };
}

/** 一条待办在人读层面的最小形状 —— 字段与 `DriverTodo` 一一对应(**不重算**)。 */function todoView(t: DriverTodo, max: number): MemberActivityView["todos"][number] {
  return {
    kind: t.kind,
    label: t.label,
    attempts: t.attempts,
    maxAttempts: max,
    target: t.target,
  };
}

/**
 * 装配一个项目的运行态视图。
 *
 * ── 三个来源,逐条对应契约里的字段 ─────────────────────────────
 *
 *   ① **内存**:`turn`(忙闩 + 这一轮为什么存在)、`dispatch`(兜底心跳)、
 *      `draining`。`runtime === null` ⇒ 三项一律退化成「读不到」并标
 *      `runtime: "unavailable"`。
 *   ② **库**:`currentWorks`(`in_progress` / `blocked` 的工作项)、
 *      `readyWorks` / `waitingWorks`(`collectPendingWork` —— 与注入面
 *      **同一个**判据)、`lastMessage` / `lastTool`(落库痕迹)。
 *   ③ **`collectTodos`**:`todos` / `exhaustedTodos`。它是排空器自己的判据 ——
 *      这里**绝不**重写一遍「谁该跑」,否则页面与排空器会有两个说法,
 *      而它们漂了之后不会有任何东西红。
 *
 * `ageMs` 全部由 `now - 时间戳` 在**服务端**算:同一台机器上时钟无偏移,
 * 但把减法收在一处之后,前端就不必自己决定「以谁的时钟为准」。
 */
export function toProjectLiveView(
  db: Database.Database,
  row: ProjectRow,
  now: number,
  runtime: LiveRuntimeSnapshot | null,
  collect: LiveCollectOptions = {},
): ProjectLiveView {
  const members = listProjectMembers(db, row.id);
  const maxAttempts = collect.maxAttemptsPerTodo ?? DEFAULT_MAX_ATTEMPTS;

  // ③ 待办 —— **排空器的判据**,按 agent 分组。缺省旋钮与宿主一致(见
  //    `LiveCollectOptions`);`collectTodos` 本身是纯查询(不写库)。
  const board = collectTodos({
    db,
    projectId: row.id,
    now,
    ...collect,
  });
  const todosByAgent = new Map<string, DriverTodo[]>();
  for (const t of board.runnable) {
    const cur = todosByAgent.get(t.agentId);
    if (cur === undefined) todosByAgent.set(t.agentId, [t]);
    else cur.push(t);
  }
  const exhaustedByAgent = new Map<string, number>();
  for (const t of board.exhausted) {
    exhaustedByAgent.set(t.agentId, (exhaustedByAgent.get(t.agentId) ?? 0) + 1);
  }

  // ① 内存:这个项目里在跑的回合,按 agentId 索引。
  const turns = new Map<string, { startedAt: number; trigger: TurnTrigger }>();
  if (runtime !== null) {
    for (const t of runtime.turns) {
      if (t.projectId !== row.id) continue;
      turns.set(t.agentId, { startedAt: t.startedAt, trigger: t.trigger });
    }
  }

  // ② 库:最近一条落库消息(每个角色一次查询)。
  //
  // ⚠️ **只有一条查询,没有「最近一次工具调用」** —— 真机库实测 `session_messages`
  // 里 `kind='tool'` 的行数是 **0**(工具调用只走 WS 广播,不落库)。曾经这里也
  // 查了 `kind='tool'`,于是那个字段在真机上**恒为 null**:一个没有写入方的字段
  // 比没有读者更坏,它会让人以为「这个角色从没动过手」。已在契约里删掉;
  // 「现在正在调什么工具」由前端从 WS 的在飞轮读(那是唯一有的地方)。
  const lastMsgStmt = db.prepare(
    `SELECT m.kind AS kind, m.content AS content, m.created_at AS createdAt
       FROM session_messages m
       JOIN project_sessions s ON s.id = m.session_id
      WHERE s.project_id = ? AND m.agent_id = ?
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT 1`,
  );

  const works = listWorks(db, row.id);
  const agents: MemberActivityView[] = members.map((m) => {
    const turn = turns.get(m.id) ?? null;
    const currentWorks = works
      .filter((w) => w.assigneeAgentId === m.id && (w.status === "in_progress" || w.status === "blocked"))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((w) => ({
        id: w.id,
        title: w.title,
        status: w.status,
        ageMs: Math.max(0, now - w.updatedAt),
      }));

    const pending = collectPendingWork(db, m.id, row.id, now);

    const lastRow = lastMsgStmt.get(row.id, m.id) as
      | { kind: string; content: string; createdAt: number }
      | undefined;
    // 表里出现未定义 kind 是**数据错误**,不是「这条没有消息」—— 与
    // `http.ts` 的 `memberConversations` 同一条纪律:不认识的 kind 不静默跳过,
    // 而是让 `isSessionMessageKind` 判假 ⇒ 这里如实显示 `null`(「读不到最近活动」),
    // 而**不是**编一个 kind 出来。判据与 `repo/sessions.ts` 的 CHECK 闭集同源。
    const lastKind: string | undefined = lastRow?.kind;
    const lastMessage: MemberActivityView["lastMessage"] =
      lastRow !== undefined && isSessionMessageKind(lastKind)
        ? {
            kind: lastKind,
            excerpt: excerpt(lastRow.content, 90),
            ageMs: Math.max(0, now - lastRow.createdAt),
          }
        : null;

    return {
      agentId: m.id,
      turn:
        turn === null
          ? null
          : { elapsedMs: Math.max(0, now - turn.startedAt), trigger: turn.trigger },
      currentWorks,
      readyWorks: pending.myOpenWorks.length,
      waitingWorks: pending.myWaitingWorks.length,
      todos: (todosByAgent.get(m.id) ?? []).map((t) => todoView(t, maxAttempts)),
      exhaustedTodos: exhaustedByAgent.get(m.id) ?? 0,
      lastMessage,
    };
  });

  const openWorks = works.filter(
    (w) => w.status === "open" || w.status === "in_progress" || w.status === "blocked",
  ).length;

  return {
    projectId: row.id,
    at: now,
    runtime: runtime === null ? "unavailable" : "host",
    dispatch: {
      intervalMs: runtime?.dispatch.intervalMs ?? 0,
      lastRunAgeMs:
        runtime?.dispatch.lastRunAt == null ? null : Math.max(0, now - runtime.dispatch.lastRunAt),
      draining: runtime !== null && runtime.drainingProjects.includes(row.id),
    },
    runningTurns: turns.size,
    openWorks,
    pendingQuestions: listArtifacts(db, row.id, { kind: "client_question", status: "open" }).length,
    agents,
  };
}

/** 单行截断(与前端 `lib/vocab.ts` 的 `excerpt` 同语义:折行 + 省略号)。 */
function excerpt(text: string, n: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

// ── 知识语料(只读检索;设计 `docs/DESIGN-KNOWLEDGE.md`)──────────────
//
// 这一族视图服务的是**记忆页的「知识语料」段**:用户要在这里看到
// 「现在构建的状态 / 量级 / 时效性,以及这个机制有没有在正常运行」。
// 所以概览里给的全是**能判定的数字**(计数、时间戳、行数差),不是装饰。

/**
 * 概览。**读不到就是读不到**:
 * 迁移没跑(表不在)、库损坏这类情况一律回 `runtime: "unavailable"` + `problem`,
 * 前端必须如实显示 —— 把「读不到」渲染成「0 条语料」正是这个项目反复栽的那类错。
 */
export function toKnowledgeOverview(db: Database.Database, at: number): KnowledgeOverviewView {
  try {
    const stats = knowledgeOverviewStats(db);
    const projects: KnowledgeProjectStatsView[] = listProjectKnowledgeStats(db).map((p) => ({
      projectId: p.projectId,
      name: p.name,
      status: (p.status as KnowledgeProjectStatsView["status"]) ?? "active",
      chunks: p.chunks,
      sourcesIndexed: p.sourcesIndexed,
      pending: p.pending,
      lastIndexedAt: p.lastIndexedAt,
    }));
    const preview: KnowledgePendingSourceView[] = listPendingSources(db, 5).map((r) => ({
      sourceKind: r.sourceKind,
      sourceId: r.sourceId,
      projectId: r.projectId,
      label: r.label,
    }));
    const lagMs =
      stats.lastIndexedAt === null || stats.newestSourceAt === null
        ? null
        : Math.max(0, stats.newestSourceAt - stats.lastIndexedAt);
    return {
      runtime: "ok",
      problem: null,
      at,
      chunks: stats.chunks,
      ftsRows: stats.ftsRows,
      sourcesIndexed: stats.sourcesIndexed,
      pending: { ...stats.pending, preview },
      lastIndexedAt: stats.lastIndexedAt,
      newestSourceAt: stats.newestSourceAt,
      lagMs,
      projects,
    };
  } catch (e) {
    return {
      runtime: "unavailable",
      problem:
        `${e instanceof Error ? e.message : String(e)} —— ` +
        "语料表读不到(迁移 028 没应用 / 库损坏)。这是**读不到**,不是「语料是空的」: " +
        "重启一次 `platform-serve` 会把它应用上。",
      at,
      chunks: 0,
      ftsRows: 0,
      sourcesIndexed: { artifacts: 0, messages: 0 },
      pending: { artifacts: 0, messages: 0, preview: [] },
      lastIndexedAt: null,
      newestSourceAt: null,
      lagMs: null,
      projects: [],
    };
  }
}

/** 一条块的视图。`state !== "ok"` 时把 `problem` 一起带出去(前端必须显示)。 */
export function toKnowledgeChunkView(
  db: Database.Database,
  chunk: KnowledgeChunkRow,
  m: Materialization,
  projectName: (id: string) => string | null = () => null,
): KnowledgeChunkView {
  const artifact = chunk.artifactId === null ? null : getArtifact(db, chunk.artifactId);
  return {
    id: chunk.id,
    sourceKind: chunk.sourceKind,
    sourceId: chunk.sourceId,
    projectId: chunk.projectId,
    projectName: chunk.projectId === null ? null : projectName(chunk.projectId),
    artifactId: chunk.artifactId,
    artifactTitle: artifact?.title ?? null,
    bodyPath: artifact?.bodyPath ?? null,
    commitSha: artifact?.commitSha ?? null,
    messageId: chunk.messageId,
    seq: chunk.seq,
    offset: chunk.offset,
    length: chunk.length,
    updatedAt: chunk.updatedAt,
    state: m.state,
    problem: m.problem,
    excerpt: excerpt(m.slice, 200),
    text: m.state === "unavailable" ? "" : m.slice,
    // 030:分级**直接来自索引行**(不是现算的)。`null` = 这一行还没算过 ——
    // 如实透出,不许渲染成 `material`(读不到不是取值)。
    tier: chunk.tier,
    tierNote: chunk.tier === null ? KNOWLEDGE_TIER_UNCOMPUTED_NOTE : null,
  };
}

/**
 * `tier === null` 时那一句人话说明。
 *
 * 它只解释「为什么没有值 + 怎么才会有」,**不对这一行做任何分类断言** ——
 * 一句「大概算低权重吧」就是把读故障说成一次分类结论。
 */
export const KNOWLEDGE_TIER_UNCOMPUTED_NOTE =
  "这一行还没有分级 —— 它是 030 之前索引的(那时平台还没算过分级),重扫之后就会有。" +
  "它现在**既不是 primary 也不是 material**。";

export interface KnowledgeChunkQuery {
  /** 空 / 缺省 = 按时间浏览;有值 = FTS 检索(切不出词由调用方拒收,见 http) */
  readonly q?: string;
  readonly projectId?: string;
  readonly limit?: number;
}

/**
 * 明细列表。`q` 有值走检索(按相关度),没有值走最近索引(按时间)——
 * 两条路的**排序语义不同**,所以不能合成一条 SQL。
 */
export function listKnowledgeChunkViews(
  db: Database.Database,
  query: KnowledgeChunkQuery,
  workspace: { readonly workspace?: WorkspacePort; readonly workspaceRoot?: string },
): KnowledgeChunkView[] {
  const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
  const reader = makeArtifactTextReader(workspace);
  const q = query.q?.trim() ?? "";

  const rows: KnowledgeChunkRow[] =
    q === ""
      ? listRecentKnowledgeChunks(db, {
          ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
          limit,
        })
      : searchKnowledgeChunks(db, buildMatchQuery(q) ?? "", {
          limit,
          ...(query.projectId !== undefined ? { projectId: query.projectId } : {}),
        })
          .map((h) => h.chunk);

  const nameCache = new Map<string, string | null>();
  const projectName = (id: string): string | null => {
    if (!nameCache.has(id)) nameCache.set(id, getProjectRow(db, id)?.name ?? null);
    return nameCache.get(id) ?? null;
  };
  return rows.map((c) => toKnowledgeChunkView(db, c, materializeChunk(db, reader, c), projectName));
}
