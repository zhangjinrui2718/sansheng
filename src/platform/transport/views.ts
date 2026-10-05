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
  listWorks, listDeps, type WorkRow,
} from "../storage/repo/works.js";
import {
  listArtifacts, listLinkEdges, type ArtifactRow,
} from "../storage/repo/artifacts.js";
import { listAsks, type AskRow } from "../storage/repo/asks.js";
import {
  listBlockers, listBlockedWorks, isUnresolvedBlocker, type BlockerRow,
} from "../storage/repo/blockers.js";
import { listChanges, type ChangeRequestRow } from "../storage/repo/changes.js";
import {
  listSessions, listSessionMessages, normalizeMessageLimit, type SessionMessageRow,
} from "../storage/repo/sessions.js";
import { getAgent } from "../storage/repo/agents.js";
import {
  getProjectRow, listProjects, listAssignments, type ProjectRow,
} from "../storage/repo/projects.js";
import { isProjectRole, type ProjectRole } from "../identity/role.js";
import type { ProjectUsageAggregate, TurnUsageRow } from "../storage/repo/usage.js";
import type {
  AskView, ArtifactView, BlockerView, ChangeView, ClientQuestionView,
  MemberView, MessageOrigin, ProjectDetail, ProjectSummary, ProjectUsageView,
  SessionMessageView, TurnUsageView, UsageByAgentView, WorkView,
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
  return isProjectRole(raw) ? raw : "worker";
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
    body: row.body,
    authorAgentId: row.authorAgentId,
    authorName: name(row.authorAgentId),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    links: listLinkEdges(db, row.id),
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
    return { source: "turn", trigger: { kind: row.triggerKind } };
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
): SessionMessageView[] {
  const perSession = normalizeMessageLimit(limit);
  // `0` = 「一条都不要」。别把它喂给 SQL:`LIMIT NULL` 在 SQLite 里是不设上限。
  if (perSession === 0) return [];
  const name = agentNameCache(db);
  const out: SessionMessageView[] = [];
  for (const s of listSessions(db, projectId)) {
    for (const m of listSessionMessages(db, s.id, perSession)) {
      out.push(toMessageView(m, name, projectId));
    }
  }
  // 多个会话时按时间归并 —— 虽然当前是「每项目一条连续对话」,
  // 但表结构允许多条(交付会话),归并保证接口不用改
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

  return {
    projectId: agg.projectId,
    window: agg.window,
    totals: { ...agg.totals },
    allTime: { ...agg.allTime },
    today: { ...agg.today },
    byAgent,
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

export function toProjectSummary(db: Database.Database, row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    client: row.client,
    goal: row.goal,
    status: row.status,
    createdAt: row.createdAt,
    counts: countsOf(db, row.id),
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
  return {
    ...toProjectSummary(db, row),
    members: listProjectMembers(db, row.id),
    works,
    pendingQuestions: questions,
  };
}

/** 全项目等甲方答的问题(左栏徽标 + 待办列表)。 */
export function listAllClientQuestions(db: Database.Database): ClientQuestionView[] {
  const name = agentNameCache(db);
  const out: ClientQuestionView[] = [];
  for (const p of listProjects(db)) {
    for (const a of listArtifacts(db, p.id, { kind: "client_question", status: "open" })) {
      out.push(toClientQuestionView(db, a, name));
    }
  }
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out;
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
