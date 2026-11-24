/**
 * 执行日志仓储(`turn_events`,migration 035)
 *
 * ── 粒度:一个回合 N 行 ──────────────────────────────────────────
 *
 * 一行 = 一次工具调用(`kind='tool'`)/ 一条 provider 故障(`kind='provider_error'`)
 * / 一个回合级标记(`kind='marker'`:到点打断、无下文)/ 回合收口行
 * (`kind='turn_end'`)。同回合各行共用 `turn_id`,`seq` 回合内单调 ——
 * **读面按 `seq` 排,不按 `created_at`**(同一毫秒可以写入多行,
 * 时间戳排不出写入顺序)。
 *
 * ── 写入时机:逐条写 + 收口行(2026-11-25)────────────────────────
 *
 * 工具行在**那次调用结束时**就落库(回合还在跑也读得到);故障与标记行在
 * 回合收口时补在后面;最后一行 `turn_end` 是「这一回合已经结束」的**库里凭据**
 * —— 没有它的回合要么还在跑,要么是进程在它结束前退出过。读面据此给
 * `finished`,不把半截回合读成「它就干到这」。
 *
 * ── 与另两张表不混装(035 的裁决)────────────────────────────────
 *
 * 正文在 `session_messages`(他说了什么)、账在 `turn_usage`(烧了多少):
 * 本表只管「做了什么」。三方靠 `(session_id, agent_id, created_at)` 的邻接
 * 对上,不硬接外键 —— 用量是账、轨迹是现场,各自的查询路径不同。
 *
 * ── 三条纪律(照抄 `repo/usage.ts`)──────────────────────────────
 *
 *   ① **NULL 用 `IS ?`**:`project_id` / `session_id` / `work_id` 都可空;
 *   ② **闭合集不认识就抛**:`kind` 读出 `TURN_EVENT_KINDS` 外的值 ⇒ 抛错,
 *      不给「当它不存在」的兜底(那会把脏数据读成正常轨迹);
 *   ③ **不在这里拼给人看的名字**:装配是 `transport/views.ts` 的事。
 */
import type Database from "better-sqlite3";

// ── 形状 ────────────────────────────────────────────────────────

/**
 * 轨迹行的类别。闭集(035 不建 CHECK,取值域在这里)。
 *
 * `turn_end`(2026-11-25):回合收口行 —— 只当凭据,读面不把它列进事件。
 */
export const TURN_EVENT_KINDS = ["tool", "provider_error", "marker", "turn_end"] as const;

export type TurnEventKind = (typeof TURN_EVENT_KINDS)[number];

export function isTurnEventKind(v: unknown): v is TurnEventKind {
  return typeof v === "string" && (TURN_EVENT_KINDS as readonly string[]).includes(v);
}

/**
 * `turn_events` 的一行(写入形状)。
 *
 * `argsSummary` / `resultSummary` 已是**截断后的摘要**(`runtime/turn.ts` 的
 * `argsSummary` / `truncate(resultText, 300)`)—— 本表要的是「排查时够看」,
 * 不是工件正文的第二个家。
 */
export interface TurnEventRow {
  id: string;
  /** 分组键:一回合一组。由 `runTurn` 生成一次,不是任何表的行 id。 */
  turnId: string;
  /** NULL = 接待会话(与 018 同一条理由:最早的回合也有轨迹)。 */
  projectId: string | null;
  /** NULL = 接待会话或那条会话已被删(刻意无外键)。 */
  sessionId: string | null;
  agentId: string;
  /** NULL = 聊天 / 汇报 / 评审的回合。 */
  workId: string | null;
  seq: number;
  kind: TurnEventKind;
  /** `kind='tool'` 时的工具名;其余 null。 */
  tool: string | null;
  argsSummary: string;
  resultSummary: string;
  isError: boolean;
  /** `kind='tool'` 时的调用时长(毫秒);其余 null。 */
  durationMs: number | null;
  createdAt: number;
}

interface RawTurnEvent {
  id: string;
  turn_id: string;
  project_id: string | null;
  session_id: string | null;
  agent_id: string;
  work_id: string | null;
  seq: number;
  kind: string;
  tool: string | null;
  args_summary: string;
  result_summary: string;
  is_error: number;
  duration_ms: number | null;
  created_at: number;
}

function toRow(raw: RawTurnEvent): TurnEventRow {
  if (!isTurnEventKind(raw.kind)) {
    throw new Error(
      `turn_events 表里出现未定义 kind「${raw.kind}」(id=${raw.id},turn=${raw.turn_id})`,
    );
  }
  return {
    id: raw.id,
    turnId: raw.turn_id,
    projectId: raw.project_id,
    sessionId: raw.session_id,
    agentId: raw.agent_id,
    workId: raw.work_id,
    seq: raw.seq,
    kind: raw.kind,
    tool: raw.tool,
    argsSummary: raw.args_summary,
    resultSummary: raw.result_summary,
    isError: raw.is_error !== 0,
    durationMs: raw.duration_ms,
    createdAt: raw.created_at,
  };
}

// ── 写 ──────────────────────────────────────────────────────────

/**
 * 一批轨迹行落库(这批行,一次事务;全成或全不成)。
 *
 * **写入点只有一处**:`runtime/turn.ts` —— 工具行每次调用结束写一批(通常一行),
 * 故障 / 标记 / 收口行在回合收口的 `finally` 里写最后一批。与 `insertTurnUsage`
 * 同一条纪律(失败不毁回合但不静默)。空数组直接返回(一个什么都没发生的回合
 * 不写轨迹,也不假装写过)。
 */
export function insertTurnEvents(db: Database.Database, rows: readonly TurnEventRow[]): void {
  if (rows.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO turn_events (id, turn_id, project_id, session_id, agent_id, work_id,
                              seq, kind, tool, args_summary, result_summary,
                              is_error, duration_ms, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    for (const r of rows) stmt.run(
      r.id, r.turnId, r.projectId, r.sessionId, r.agentId, r.workId,
      r.seq, r.kind, r.tool, r.argsSummary, r.resultSummary,
      r.isError ? 1 : 0, r.durationMs, r.createdAt,
    );
  })();
}

// ── 读 ──────────────────────────────────────────────────────────

/**
 * 一个项目里某个成员最近 `maxTurns` 个回合的**全部已落库行**(成员页
 * 「他做了什么」的数据源)。
 *
 * 两步查询,语义可预测:先取最近 `maxTurns` 个 `turn_id`(按回合内最大
 * `created_at` 倒序),再取这些回合的全部行 —— **整回合一起出**。
 * 逐条写入之后,正在跑的回合也会出现在这里(它的行还在增加):有没有
 * `turn_end` 行由读面 `transport/http.ts` 的 `agentTurnEvents` 翻成
 * `finished`,半截回合因此**被标出来**,而不是被读成「它就干到这」。
 */
export function listTurnEventsByAgent(
  db: Database.Database,
  projectId: string,
  agentId: string,
  maxTurns = 50,
): TurnEventRow[] {
  const turnIds = db
    .prepare(
      `SELECT turn_id FROM turn_events
       WHERE project_id = ? AND agent_id = ?
       GROUP BY turn_id
       ORDER BY MAX(created_at) DESC, turn_id DESC
       LIMIT ?`,
    )
    .all(projectId, agentId, maxTurns) as Array<{ turn_id: string }>;
  if (turnIds.length === 0) return [];
  const placeholders = turnIds.map(() => "?").join(",");
  const raw = db
    .prepare(
      `SELECT * FROM turn_events
       WHERE project_id = ? AND agent_id = ? AND turn_id IN (${placeholders})
       ORDER BY created_at DESC, turn_id DESC, seq ASC`,
    )
    .all(projectId, agentId, ...turnIds.map((t) => t.turn_id)) as RawTurnEvent[];
  return raw.map(toRow);
}

/** 单个回合的完整轨迹(点开一个回合看全程,按 `seq` 升序)。 */
export function listTurnEventsByTurn(db: Database.Database, turnId: string): TurnEventRow[] {
  const raw = db
    .prepare(`SELECT * FROM turn_events WHERE turn_id = ? ORDER BY seq ASC`)
    .all(turnId) as RawTurnEvent[];
  return raw.map(toRow);
}
