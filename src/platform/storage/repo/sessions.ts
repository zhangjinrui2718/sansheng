/**
 * BC2 Collaboration · project_sessions / session_messages 仓储
 *
 * 对话是**项目的会话**,不是项目的边界 —— 这是本次升级最关键的一处作用域变更
 * 的落点:工件、工作项、阻塞、变更全部按 `project_id` 归属,对话只是它们的
 * 来源线索之一。
 *
 * 所以 `artifacts.conversation_id` **刻意不加外键**:工件必须比对话活得久。
 */
import type Database from "better-sqlite3";

export type SessionMessageKind = "user" | "assistant" | "thinking" | "tool" | "system";

export const MESSAGE_KINDS: readonly SessionMessageKind[] = [
  "user",
  "assistant",
  "thinking",
  "tool",
  "system",
];

export function isSessionMessageKind(v: unknown): v is SessionMessageKind {
  return typeof v === "string" && (MESSAGE_KINDS as readonly string[]).includes(v);
}

/**
 * 会话的**通道**(`project_sessions.channel`,migration 017)。
 *
 *   - `internal` = 项目的内部会话:角色回合 / 系统通知 / 工作项执行都写这里
 *   - `client`   = **交付对话**:平台在 `handover` 回合**成功结束后**开的那条
 *     (`runtime/dispatcher.ts` 的消费块第三支),它同时带
 *     `deliverable_artifact_id`
 *
 * ⚠️ **它与前端 `TurnChannel`(`web/src/lib/data.ts`)不是同一个东西**,只是
 * 名字撞了:那个是**渲染通道**(按 `agentId → role → clientFacing` 算出来的),
 * 这个是**会话的归属**。两者独立,所以「甲方视图里看得见」由前端那条判据保证,
 * 不需要读这一列(设计 1 §2.10 / §2.12 的 A3)。
 */
export type SessionChannel = "internal" | "client";

export const SESSION_CHANNELS: readonly SessionChannel[] = ["internal", "client"];

export function isSessionChannel(v: unknown): v is SessionChannel {
  return typeof v === "string" && (SESSION_CHANNELS as readonly string[]).includes(v);
}

export interface SessionRow {
  id: string;
  /**
   * `null` = **接待会话**(第一个项目之前,见 `migrations/012_intake_session.sql`)。
   * 全局只有一条 —— 由迁移里的部分唯一索引机械保证。
   */
  projectId: string | null;
  createdAt: number;
  /** 见 {@link SessionChannel}。接待会话是 `internal`(它不是交付开出来的)。 */
  channel: SessionChannel;
  /**
   * 这条对话是**哪条交付物**开出来的(`null` = 不是交付开出来的)。
   *
   * 它同时是 `handover` 规则的**终止判据** —— 读面在
   * `runtime/dispatcher.ts` 的 `deliveredArtifactIds`。
   */
  deliverableArtifactId: string | null;
}

export interface SessionMessageRow {
  id: string;
  sessionId: string;
  /** NULL = 甲方(用户)说的话。用户不是 agents 表里的角色。 */
  agentId: string | null;
  kind: SessionMessageKind;
  content: string;
  createdAt: number;
}

interface RawConversation {
  id: string;
  project_id: string | null;
  created_at: number;
  channel: string;
  deliverable_artifact_id: string | null;
}

interface RawMessage {
  id: string;
  session_id: string;
  agent_id: string | null;
  kind: string;
  content: string;
  created_at: number;
}

/**
 * 往 `project_sessions` 插一行。
 *
 * `channel` 缺省 `internal`(与 schema 的 `DEFAULT` 一致):**存量调用方**
 * (测试、接待会话、以及项目主会话)写的就是内部会话。交付会话**不**走缺省 ——
 * 它由 {@link openDeliverableSession} 显式带 `channel: "client"` 写。
 */
export function insertSession(
  db: Database.Database,
  row: {
    id: string;
    projectId: string | null;
    createdAt: number;
    channel?: SessionChannel;
    deliverableArtifactId?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO project_sessions (id, project_id, created_at, channel, deliverable_artifact_id)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.projectId,
    row.createdAt,
    row.channel ?? "internal",
    row.deliverableArtifactId ?? null,
  );
}

function toSessionRow(raw: RawConversation): SessionRow {
  if (!isSessionChannel(raw.channel)) {
    throw new Error(
      `project_sessions 表里出现未定义 channel「${raw.channel}」(id=${raw.id})—— ` +
        `闭集是 ${SESSION_CHANNELS.join(" | ")},schema 的 CHECK 本该拦住它`,
    );
  }
  return {
    id: raw.id,
    projectId: raw.project_id,
    createdAt: raw.created_at,
    channel: raw.channel,
    deliverableArtifactId: raw.deliverable_artifact_id,
  };
}

export function getSession(db: Database.Database, id: string): SessionRow | null {
  const raw = db.prepare(`SELECT * FROM project_sessions WHERE id = ?`).get(id) as
    | RawConversation
    | undefined;
  return raw ? toSessionRow(raw) : null;
}

/**
 * 某个项目(或接待会话)的全部会话,新的在前。
 *
 * `projectId === null` 要写成 `IS NULL` —— SQL 里 `project_id = NULL` 恒为
 * unknown,一条也查不出来。这不是风格问题:写成 `= ?` 的话接待会话的历史会
 * **静默变成空列表**,而「空列表」和「这段对话真的没有消息」在接口上长得一样。
 */
export function listSessions(db: Database.Database, projectId: string | null): SessionRow[] {
  const rows = (
    projectId === null
      ? db
          .prepare(`SELECT * FROM project_sessions WHERE project_id IS NULL ORDER BY created_at DESC`)
          .all()
      : db
          .prepare(`SELECT * FROM project_sessions WHERE project_id = ? ORDER BY created_at DESC`)
          .all(projectId)
  ) as RawConversation[];
  return rows.map(toSessionRow);
}

/**
 * **某个通道**的那条会话(设计 1 §2.11.6)。
 *
 * ⚠️ **这是 C4 拆地雷的落点:按 `(project_id, channel)` 取,不再挑「项目里最新
 * 那条会话」。** 旧写法(`listSessions(...)[0]`)的失败形态是静默的 —— 交付会话
 * 一建出来,六处调用点会把**所有角色**的消息都写进它(消息都在,只是分错了会话)。
 *
 * 多条同通道会话时取**最新**的那条,`id` 作次序的第二个键 —— 让选择是**全序**的,
 * 同一个 `created_at` 也不会漂。这条次序对 `internal` 无意义(每个项目至多一条,
 * 它只由 {@link ensureSession} 惰性建出),对 `client` 才是语义:每次交付开一条
 * 新对话,甲方接下来的话该落在**最新的那场**上。
 */
export function findSessionByChannel(
  db: Database.Database,
  projectId: string,
  channel: SessionChannel,
): SessionRow | null {
  const raw = db
    .prepare(
      `SELECT * FROM project_sessions
       WHERE project_id = ? AND channel = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(projectId, channel) as RawConversation | undefined;
  return raw ? toSessionRow(raw) : null;
}

/**
 * **交付会话的 id** —— 由交付物 id 派生(`s_deliv_<artifact>`),不是随机生成。
 *
 * 三个理由,都不是口味:
 *   1. 它就是「一条交付物**至多**一条交付会话」这条不变量的**可读形态** ——
 *      `SELECT id FROM project_sessions` 里一眼看得出哪条对话属于哪条交付物;
 *   2. 它让**并发**的第二次写入撞主键(响亮失败),而不是安静地开出第二条对话
 *      —— 幂等的第一道仍然是 {@link openDeliverableSession} 的 SELECT,但坏掉的
 *      检查不该变成「静默多一条」;
 *   3. 它不需要把 `newId` 塞进 `runtime/dispatcher.ts` 的 `DrainDeps`(那个接口
 *      被 26 处测试的依赖字面量实现着,加一个只为建会话服务的必填字段,是把
 *      「谁生成 id」这个与排空无关的事塞进排空的契约里)。
 */
export function deliverableSessionId(deliverableArtifactId: string): string {
  return `s_deliv_${deliverableArtifactId}`;
}

/**
 * 平台在 `handover` 回合**成功结束后**开一条交付对话(设计 1 §2.11.6)。
 *
 * **幂等 / at-least-once**:同一个交付物**只建一条**会话 —— 判据是
 * `deliverable_artifact_id` 那列(读**库**,不是读本次调用的入参)。第二次调用
 * 返回 `{ created: false }`,调用方据此决定要不要广播。
 *
 * ⚠️ 它**只建会话行**,不写任何消息:这场交付的正文由业务经理在随后的回合里
 * 用 `tell_client` 说 —— 平台替它说话就又成了「平台写一份自己的叙事」。
 *
 * ⚠️ 它**不校验**交付物存在:那条外键(`REFERENCES artifacts(id)`,NO ACTION)
 * 会替我们拒掉悬空引用,而且是**响亮**的。在这里再查一遍只会多一处会漂的真相。
 */
export function openDeliverableSession(
  db: Database.Database,
  input: {
    projectId: string;
    deliverableArtifactId: string;
    channel: "client";
    createdAt: number;
  },
): { created: boolean; sessionId: string } {
  const existing = db
    .prepare(
      `SELECT id FROM project_sessions WHERE deliverable_artifact_id = ? LIMIT 1`,
    )
    .get(input.deliverableArtifactId) as { id: string } | undefined;
  if (existing !== undefined) return { created: false, sessionId: existing.id };

  const sessionId = deliverableSessionId(input.deliverableArtifactId);
  insertSession(db, {
    id: sessionId,
    projectId: input.projectId,
    createdAt: input.createdAt,
    channel: input.channel,
    deliverableArtifactId: input.deliverableArtifactId,
  });
  return { created: true, sessionId };
}

export function appendSessionMessage(
  db: Database.Database,
  row: {
    id: string;
    sessionId: string;
    agentId: string | null;
    kind: SessionMessageKind;
    content: string;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO session_messages (id, session_id, agent_id, kind, content, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.sessionId, row.agentId, row.kind, row.content, row.createdAt);
}

/** 单次读回的**每会话**条数上限。见 {@link normalizeMessageLimit}。 */
export const MESSAGE_LIMIT_MAX = 2000;

/**
 * 把调用方给的 `limit` 规范化成 `[1, MESSAGE_LIMIT_MAX]` 的整数。
 *
 * **`0` 是唯一的例外**:它表示「一条都不要」,而不是「至少 1 条」——
 * `limit ≤ 0` 与 `NaN` / `Infinity` 一律归零(读面无界是失败,不是宽容)。
 * 调用方拿到 `0` 就该直接返回空,别把它喂给 SQL(`LIMIT NULL` 在 SQLite 里
 * 是**不设上限**,那正是这里要堵的路)。
 *
 * 规范化只写一处:`listSessionMessages` 与 `views.ts` 的 `listProjectMessages`
 * 都从这里取——两处各写一份 `Math.min(Math.max(...))` 迟早会漂。
 */
export function normalizeMessageLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 0;
  return Math.min(Math.max(Math.floor(limit), 0), MESSAGE_LIMIT_MAX);
}

/**
 * 某个会话的**最新** `limit` 条消息,按时间**升序**返回(`[0]` 是最旧的那条)。
 *
 * ── ⚠️ 这个 `LIMIT` 切的是**尾巴**,不是头(bug①)────────────────────
 *
 * 它曾经是 `ORDER BY created_at LIMIT ?` —— 没有 `DESC` 的 `LIMIT` 切的是
 * **最早** n 条,于是「第 201 条起永远取不到」:对话页刷新之后历史冻在旧窗口,
 * 而库里新消息一条不少。修法就是让 `LIMIT` 作用在**降序**结果上,再 `reverse()`
 * 交回升序 —— 返回顺序是本函数原有的契约,调用方(归并 / 逐条比对测试)依赖它。
 *
 * ── `(created_at, id)` 是**全序**,不是「真实写下次序」的断言 ──────────
 *
 * **同一毫秒内的消息本来就不可排序**(本项目已踩过)。`id` 在这里只做第二键,
 * 把「同毫秒」变成一个有稳定答案的位置:要的是「两次读一模一样、换 `limit`
 * 不换行」,不声称这就是它们真正被插入的顺序。第二键与
 * {@link findSessionByChannel} 用同一把尺(`id`),所以同一毫秒的次序在整个
 * 仓储层是一致的。
 *
 * `limit ≤ 0` / 非有限 ⇒ 空数组(见 {@link normalizeMessageLimit});上限 2000。
 */
export function listSessionMessages(
  db: Database.Database,
  sessionId: string,
  limit = 200,
): SessionMessageRow[] {
  const n = normalizeMessageLimit(limit);
  if (n === 0) return [];
  const rows = db
    .prepare(
      `SELECT * FROM session_messages WHERE session_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`,
    )
    .all(sessionId, n) as RawMessage[];
  // 降序取尾巴、升序交回去 —— 两件事分开写,免得下次有人把 DESC 当成返回顺序
  return rows.reverse().map((r) => {
    if (!isSessionMessageKind(r.kind)) {
      throw new Error(`session_messages 表里出现未定义 kind「${r.kind}」(id=${r.id})`);
    }
    return {
      id: r.id,
      sessionId: r.session_id,
      agentId: r.agent_id,
      kind: r.kind,
      content: r.content,
      createdAt: r.created_at,
    };
  });
}
