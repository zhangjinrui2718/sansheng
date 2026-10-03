/**
 * BC2 Collaboration · asks 仓储(含升级链)
 *
 * ── 升级链是这一层的核心,不是附带功能 ─────────────────────────────
 *
 * 7-L 的教训原文:「`onEscalate` 里要把 `pendingExecutorCallbacks` 改挂到新 id
 * 并摘掉 `q-exec-*`,否则一次迟到的 cancel 能再杀一遍已恢复的 executor。」
 *
 * 那句话的抽象形态是:**升级时不能让链上留下两条活问**。本仓储用
 * `parent_ask_id` + `escalated` 状态保证这一点:
 *
 *   提问者 ──ask_1──► 项目经理(判不了)──escalate──► ask_2 ──► 业务经理
 *                        ask_1.status = escalated        │
 *                                                        │ answer
 *                                                        ▼
 *                        ask_1.status = answered ◄── 沿 parent 链回填
 *
 * 任何时刻链上只有最末端那条是 `open`。迟到的 cancel 打不到已经回填过的父问。
 */
import type Database from "better-sqlite3";

export type AskStatus = "open" | "answered" | "escalated" | "cancelled" | "expired";

export const ASK_STATUSES: readonly AskStatus[] = [
  "open",
  "answered",
  "escalated",
  "cancelled",
  "expired",
];

export function isAskStatus(v: unknown): v is AskStatus {
  return typeof v === "string" && (ASK_STATUSES as readonly string[]).includes(v);
}

export interface AskRow {
  id: string;
  projectId: string;
  fromAgentId: string;
  toAgentId: string;
  parentAskId: string | null;
  question: string;
  hypothesis: string;
  optionsJson: string | null;
  needs: string | null;
  status: AskStatus;
  createdAt: number;
  deadlineAt: number | null;
  resolvedAt: number | null;
  resolutionArtifactId: string | null;
}

interface RawAsk {
  id: string;
  project_id: string;
  from_agent_id: string;
  to_agent_id: string;
  parent_ask_id: string | null;
  question: string;
  hypothesis: string;
  options_json: string | null;
  needs: string | null;
  status: string;
  created_at: number;
  deadline_at: number | null;
  resolved_at: number | null;
  resolution_artifact_id: string | null;
}

function rowToAsk(raw: RawAsk): AskRow {
  if (!isAskStatus(raw.status)) {
    throw new Error(`asks 表里出现未定义状态「${raw.status}」(id=${raw.id})`);
  }
  return {
    id: raw.id,
    projectId: raw.project_id,
    fromAgentId: raw.from_agent_id,
    toAgentId: raw.to_agent_id,
    parentAskId: raw.parent_ask_id,
    question: raw.question,
    hypothesis: raw.hypothesis,
    optionsJson: raw.options_json,
    needs: raw.needs,
    status: raw.status,
    createdAt: raw.created_at,
    deadlineAt: raw.deadline_at,
    resolvedAt: raw.resolved_at,
    resolutionArtifactId: raw.resolution_artifact_id,
  };
}

// ── 写入 ────────────────────────────────────────────────────────

export interface NewAsk {
  id: string;
  projectId: string;
  fromAgentId: string;
  toAgentId: string;
  parentAskId?: string | null;
  question: string;
  /** 7-L 约束①:**必填且非空**。schema 也拦,这里给出更早、更可读的失败。 */
  hypothesis: string;
  optionsJson?: string | null;
  needs?: string | null;
  createdAt: number;
  deadlineAt?: number | null;
}

export function insertAsk(db: Database.Database, a: NewAsk): void {
  if (a.hypothesis.trim() === "") {
    throw new Error(
      "提问必须带 hypothesis(非空)—— 7-L 教训:没有它,对方无从判断,只能把问题原样推给用户",
    );
  }
  if (a.fromAgentId === a.toAgentId) {
    throw new Error("不能向自己提问");
  }
  db.prepare(
    `INSERT INTO asks (id, project_id, from_agent_id, to_agent_id, parent_ask_id,
                       question, hypothesis, options_json, needs, status,
                       created_at, deadline_at, resolved_at, resolution_artifact_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL)`,
  ).run(
    a.id, a.projectId, a.fromAgentId, a.toAgentId, a.parentAskId ?? null,
    a.question, a.hypothesis, a.optionsJson ?? null, a.needs ?? null,
    a.createdAt, a.deadlineAt ?? null,
  );
}

export function getAsk(db: Database.Database, id: string): AskRow | null {
  const raw = db.prepare(`SELECT * FROM asks WHERE id = ?`).get(id) as RawAsk | undefined;
  return raw ? rowToAsk(raw) : null;
}

export interface ListAsksFilter {
  status?: AskStatus;
  /** 只列「问我的」—— agent 判断该不该回应时用 */
  toAgentId?: string;
  /** 只列「我问的」—— 看自己卡在哪 */
  fromAgentId?: string;
  /** 只要还活着(open | escalated 不算 —— escalated 已转交出去,不该我来答) */
  actionableOnly?: boolean;
  limit?: number;
}

export function listAsks(
  db: Database.Database,
  projectId: string,
  filter: ListAsksFilter = {},
): AskRow[] {
  const where = ["project_id = ?"];
  const vals: unknown[] = [projectId];
  if (filter.status !== undefined) { where.push("status = ?"); vals.push(filter.status); }
  if (filter.toAgentId !== undefined) { where.push("to_agent_id = ?"); vals.push(filter.toAgentId); }
  if (filter.fromAgentId !== undefined) { where.push("from_agent_id = ?"); vals.push(filter.fromAgentId); }
  // actionable = 真正需要「收到方」回应的:只剩 open。
  // escalated 已转交上级,answered/cancelled/expired 已了结。
  if (filter.actionableOnly === true) where.push("status = 'open'");
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  vals.push(limit);
  const rows = db
    .prepare(`SELECT * FROM asks WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
    .all(...vals) as RawAsk[];
  return rows.map(rowToAsk);
}

// ── 状态迁移 ────────────────────────────────────────────────────

export type AskTransitionResult =
  | { ok: true; alsoResolved: string[] }
  | { ok: false; reason: "not_found" | "not_open" };

/**
 * 回答问题。落 resolution 工件,并**沿 parent 链一路回填** ——
 * 这样最初那个提问者才真正解除 blocked。
 *
 * 回填是这条链最容易被漏掉的一步:只把末端那条标 answered,原始提问者会永远
 * 停在 blocked 上,而且没有任何报错。
 */
export function answerAsk(
  db: Database.Database,
  askId: string,
  at: number,
  resolutionArtifactId: string | null,
): AskTransitionResult {
  const ask = getAsk(db, askId);
  if (!ask) return { ok: false, reason: "not_found" };
  if (ask.status !== "open") return { ok: false, reason: "not_open" };

  const alsoResolved: string[] = [];
  db.transaction(() => {
    db.prepare(
      `UPDATE asks SET status = 'answered', resolved_at = ?, resolution_artifact_id = ? WHERE id = ?`,
    ).run(at, resolutionArtifactId, askId);

    // 沿 parent 链向上回填:父问是 escalated 状态,它等的就是这条子问的结论
    let cur = ask.parentAskId;
    const seen = new Set<string>([askId]);
    while (cur !== null && !seen.has(cur)) {
      seen.add(cur);
      const parent = getAsk(db, cur);
      if (parent === null) break;
      if (parent.status === "escalated") {
        db.prepare(
          `UPDATE asks SET status = 'answered', resolved_at = ?, resolution_artifact_id = ? WHERE id = ?`,
        ).run(at, resolutionArtifactId, parent.id);
        alsoResolved.push(parent.id);
      }
      cur = parent.parentAskId;
    }
  })();

  return { ok: true, alsoResolved };
}

export type EscalateResult =
  | { ok: true; parentAskId: string; toAgentId: string }
  | { ok: false; reason: "not_found" | "not_open" | "no_parent_available" };

/**
 * 把一条问升级给上一级:**父问转 escalated,同时建一条子问**。
 *
 * 这两件事必须在**同一个事务**里 —— 分开做就会出现「父问已 escalated 但子问
 * 没建成」的悬空状态,而那个状态没有任何人会发现。
 */
export function escalateAsk(
  db: Database.Database,
  parentAskId: string,
  child: NewAsk,
  at: number,
): EscalateResult {
  const parent = getAsk(db, parentAskId);
  if (!parent) return { ok: false, reason: "not_found" };
  if (parent.status !== "open") return { ok: false, reason: "not_open" };
  if (child.fromAgentId === child.toAgentId) return { ok: false, reason: "no_parent_available" };
  if (child.hypothesis.trim() === "") {
    throw new Error("升级同样必须带 hypothesis —— 上级比下级更需要这份判断依据");
  }

  db.transaction(() => {
    db.prepare(`UPDATE asks SET status = 'escalated' WHERE id = ?`).run(parentAskId);
    db.prepare(
      `INSERT INTO asks (id, project_id, from_agent_id, to_agent_id, parent_ask_id,
                         question, hypothesis, options_json, needs, status,
                         created_at, deadline_at, resolved_at, resolution_artifact_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, NULL, NULL)`,
    ).run(
      child.id, child.projectId, child.fromAgentId, child.toAgentId, parentAskId,
      child.question, child.hypothesis, child.optionsJson ?? null, child.needs ?? null,
      child.createdAt, child.deadlineAt ?? null,
    );
  })();

  void at;
  return { ok: true, parentAskId, toAgentId: child.toAgentId };
}

/**
 * 取消提问。**只对 open 生效** —— 这正是 7-L 教训②要防的:
 * 一条已经 answered 的父问不该被后来迟到的 cancel 再改一次状态。
 */
export function cancelAsk(db: Database.Database, askId: string, at: number): AskTransitionResult {
  const ask = getAsk(db, askId);
  if (!ask) return { ok: false, reason: "not_found" };
  if (ask.status !== "open") return { ok: false, reason: "not_open" };
  db.prepare(`UPDATE asks SET status = 'cancelled', resolved_at = ? WHERE id = ?`).run(at, askId);
  return { ok: true, alsoResolved: [] };
}

/** 超时。同样只对 open 生效。 */
export function expireAsk(db: Database.Database, askId: string, at: number): AskTransitionResult {
  const ask = getAsk(db, askId);
  if (!ask) return { ok: false, reason: "not_found" };
  if (ask.status !== "open") return { ok: false, reason: "not_open" };
  db.prepare(`UPDATE asks SET status = 'expired', resolved_at = ? WHERE id = ?`).run(at, askId);
  return { ok: true, alsoResolved: [] };
}

// ── 巡检:谁卡住了 ───────────────────────────────────────────────

/** 已过期但还挂着 open 的问 —— 调用方(调度器)据此 expire 或催办。 */
export function listOverdueAsks(db: Database.Database, now: number, projectId?: string): AskRow[] {
  const rows = (
    projectId === undefined
      ? db.prepare(
          `SELECT * FROM asks WHERE status = 'open' AND deadline_at IS NOT NULL AND deadline_at <= ?
           ORDER BY deadline_at`,
        ).all(now)
      : db.prepare(
          `SELECT * FROM asks WHERE status = 'open' AND deadline_at IS NOT NULL AND deadline_at <= ?
             AND project_id = ? ORDER BY deadline_at`,
        ).all(now, projectId)
  ) as RawAsk[];
  return rows.map(rowToAsk);
}

/**
 * 一个 agent 当前被卡住的所有问(它是提问者且还没结论)。
 *
 * 这是「谁在等谁」的查询入口 —— 没有它,一个 blocked 的 agent 只能靠人肉排查。
 */
export function askedByMeOpen(db: Database.Database, agentId: string): AskRow[] {
  const rows = db
    .prepare(
      `SELECT * FROM asks WHERE from_agent_id = ? AND status IN ('open', 'escalated')
       ORDER BY created_at`,
    )
    .all(agentId) as RawAsk[];
  return rows.map(rowToAsk);
}

/** 一条升级链的完整路径(从链首到末端),用于审计展示。 */
export function askChain(db: Database.Database, askId: string): AskRow[] {
  const tip = getAsk(db, askId);
  if (!tip) return [];
  // 先走到链首
  let head = tip;
  const guard = new Set<string>([head.id]);
  while (head.parentAskId !== null) {
    const p = getAsk(db, head.parentAskId);
    if (p === null || guard.has(p.id)) break;
    guard.add(p.id);
    head = p;
  }
  // 再从链首往下收集
  const out: AskRow[] = [];
  const byParent = new Map<string, AskRow[]>();
  const all = db
    .prepare(`SELECT * FROM asks WHERE project_id = ?`)
    .all(head.projectId) as RawAsk[];
  for (const raw of all) {
    const a = rowToAsk(raw);
    if (a.parentAskId === null) continue;
    const list = byParent.get(a.parentAskId) ?? [];
    list.push(a);
    byParent.set(a.parentAskId, list);
  }
  const stack = [head];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const cur = stack.shift()!;
    if (seen.has(cur.id)) continue;
    seen.add(cur.id);
    out.push(cur);
    for (const child of byParent.get(cur.id) ?? []) stack.push(child);
  }
  return out;
}
