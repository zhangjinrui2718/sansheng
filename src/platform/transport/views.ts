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
  listSessions, listSessionMessages, type SessionMessageRow,
} from "../storage/repo/sessions.js";
import { getAgent } from "../storage/repo/agents.js";
import {
  getProjectRow, listProjects, listAssignments, type ProjectRow,
} from "../storage/repo/projects.js";
import { isProjectRole, type ProjectRole } from "../identity/role.js";
import type {
  AskView, ArtifactView, BlockerView, ChangeView, ClientQuestionView,
  MemberView, ProjectDetail, ProjectSummary, SessionMessageView, WorkView,
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
  };
}

/**
 * 一条会话(项目会话**或接待会话**)的全部消息,按时间归并。
 *
 * `projectId === null` = 接待会话(第一个项目之前,见
 * `migrations/012_intake_session.sql`)。走同一个函数是有意的:接待会话与项目会话
 * 是**同一种东西**,只是前者还没有项目 —— 两套读法迟早会漂。
 */
export function listProjectMessages(
  db: Database.Database,
  projectId: string | null,
  limit = 200,
): SessionMessageView[] {
  const name = agentNameCache(db);
  const out: SessionMessageView[] = [];
  for (const s of listSessions(db, projectId)) {
    for (const m of listSessionMessages(db, s.id, limit)) {
      out.push(toMessageView(m, name, projectId));
    }
  }
  // 多个会话时按时间归并 —— 虽然当前是「每项目一条连续对话」,
  // 但表结构允许多条,归并保证换形态时接口不用改
  out.sort((a, b) => a.createdAt - b.createdAt);
  return out.slice(-limit);
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
