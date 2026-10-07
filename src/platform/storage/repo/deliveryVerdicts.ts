/**
 * 甲方的验收裁决(029 的 `delivery_verdicts` 表)。
 *
 * ── 它存在的理由:把「甲方认可了没有」变成一行事实 ──────────────
 *
 * 在此之前,「甲方验收」这件事在库里**根本不存在**。收口与交付两道门的资格判据
 * 都是「存在 `status='accepted'` 的 `deliverable`」,而那个 `accepted` 是
 * **申请人自己写的**(`project_manager.core.md` 逐字教它「`status` 用 `accepted`,
 * 因为交付那一环的资格判据是『已验收的交付物』」)。真机库 7 份交付物全部
 * `accepted`,作者是 `wk` / `pm` 自己 —— 门的判据等于「我说我验过了」。
 *
 * 本表补的就是那一半:**只有甲方能写**。它不是工具、不在任何角色的 ceiling 里,
 * 唯一的写入口是 HTTP 面(`POST /api/artifacts/:id/verdict`)—— 与
 * `client-questions/:id/answer` 同一条纪律(甲方的话由甲方点出来,模型不能代笔)。
 *
 * ── 与 `artifacts.status` 的分工(两个词,两件事)──────────────────
 *
 *   · `artifacts.status = 'accepted'` = **定稿**(作者整合完了,可以交给甲方了);
 *   · `delivery_verdicts.verdict`     = **甲方收不收**。
 *
 * ⇒ 收口门读的是后者。这条分工写在 029 的文件头,改这里之前先读那一段。
 *
 * ── 三条纪律 ────────────────────────────────────────────────────
 *
 *   ① **append-only**:改判(「拒收」→ 作者返工 → 「接受」)必须留痕,
 *      所以只追加行、绝不 UPDATE;读面取 `(created_at, seq)` 最大的那条。
 *   ② **本模块只做读写,不做判定**。「这个项目在等甲方收货吗」那条判据是
 *      {@link deliveryAcceptance},消费者(规则表 / 读面 / 收口门)读的是**同一个答案**。
 *   ③ **读不到不等于「通过了」**:没有裁决行 = `verdict: null`,读面必须如实写
 *      「等你验收」,不许渲染成「已接受」(本项目通用纪律:读不到不是空)。
 */
import type Database from "better-sqlite3";

export type DeliveryVerdict = "accept" | "reject";

export const DELIVERY_VERDICTS: readonly DeliveryVerdict[] = ["accept", "reject"];

export function isDeliveryVerdict(v: unknown): v is DeliveryVerdict {
  return typeof v === "string" && (DELIVERY_VERDICTS as readonly string[]).includes(v);
}

export interface DeliveryVerdictRow {
  readonly seq: number;
  readonly projectId: string;
  readonly artifactId: string;
  readonly verdict: DeliveryVerdict;
  /** 甲方写的那句话(拒收时「哪里不行」)。可以没有 —— 不逼甲方写小作文 */
  readonly note: string | null;
  readonly createdAt: number;
}

interface RawDeliveryVerdict {
  seq: number;
  project_id: string;
  artifact_id: string;
  verdict: string;
  note: string | null;
  created_at: number;
}

function rowToVerdict(raw: RawDeliveryVerdict): DeliveryVerdictRow {
  // 闭集**硬抛**而不是回落成默认值:一个读不出来的 verdict 被当成 `accept`
  // 就是「把一次读故障说成甲方同意了」—— 与 021 的 `rowToVerdict` 同一条理由。
  if (!isDeliveryVerdict(raw.verdict)) {
    throw new Error(
      `delivery_verdicts 表里出现未定义 verdict「${raw.verdict}」(seq=${raw.seq})—— ` +
        `闭集是 ${DELIVERY_VERDICTS.join(" | ")},schema 的 CHECK 本该拦住它`,
    );
  }
  return {
    seq: raw.seq,
    projectId: raw.project_id,
    artifactId: raw.artifact_id,
    verdict: raw.verdict,
    note: raw.note,
    createdAt: raw.created_at,
  };
}

/** 追加一条裁决。**不改已有的行** —— 改判是新写一条(见文件头 ①)。 */
export function insertDeliveryVerdict(
  db: Database.Database,
  row: {
    projectId: string;
    artifactId: string;
    verdict: DeliveryVerdict;
    note: string | null;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO delivery_verdicts (project_id, artifact_id, verdict, note, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.projectId, row.artifactId, row.verdict, row.note, row.createdAt);
}

/** 这个项目里的**全部**裁决,时间升序(第一次裁决在前)。审计面用。 */
export function listDeliveryVerdicts(
  db: Database.Database,
  projectId: string,
): DeliveryVerdictRow[] {
  const rows = db
    .prepare(`SELECT * FROM delivery_verdicts WHERE project_id = ? ORDER BY created_at, seq`)
    .all(projectId) as RawDeliveryVerdict[];
  return rows.map(rowToVerdict);
}

/**
 * 这份交付物**最新**一次裁决;甲方还没验过则 `null`。
 *
 * 「最新」按 `(created_at, seq)` 取 —— `created_at` 单独不够:同一毫秒写两条时
 * 并列,取哪一条就成了未定义行为,而**判据不能有未定义分支**(与 021 同)。
 */
export function latestDeliveryVerdict(
  db: Database.Database,
  artifactId: string,
): DeliveryVerdictRow | null {
  const raw = db
    .prepare(
      `SELECT * FROM delivery_verdicts WHERE artifact_id = ?
       ORDER BY created_at DESC, seq DESC LIMIT 1`,
    )
    .get(artifactId) as RawDeliveryVerdict | undefined;
  return raw === undefined ? null : rowToVerdict(raw);
}

/** 这个项目里每份交付物的**最新**裁决(按 `artifact_id` 分组)。 */
export function latestVerdictsByArtifact(
  db: Database.Database,
  projectId: string,
): Map<string, DeliveryVerdictRow> {
  const rows = db
    .prepare(
      `SELECT artifact_id, MAX(created_at) AS created_at FROM delivery_verdicts
       WHERE project_id = ? GROUP BY artifact_id`,
    )
    .all(projectId) as Array<{ artifact_id: string; created_at: number }>;
  const out = new Map<string, DeliveryVerdictRow>();
  for (const r of rows) {
    const one = db
      .prepare(
        `SELECT * FROM delivery_verdicts WHERE artifact_id = ? AND created_at = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(r.artifact_id, r.created_at) as RawDeliveryVerdict | undefined;
    if (one !== undefined) out.set(r.artifact_id, rowToVerdict(one));
  }
  return out;
}

/**
 * 一条「货已经交出去了」的记录:哪份交付物、哪条交付线、什么时候开的。
 *
 * `deliveredAt` 是**平台把货交出去的时刻**(`handover` 回合成功结束后平台开的那条
 * 交付会话的 `created_at`)—— 读面上「等你验收多久了」用的就是它,而不是甲方
 * 什么时候看到的(那个平台不知道)。
 */
export interface DeliveredDeliverable {
  readonly artifactId: string;
  readonly sessionId: string;
  readonly deliveredAt: number;
}

/**
 * **已经交付给甲方的**交付物(设计 1 §2.11.6 那条边的读面)。
 *
 * 「交付」= `handover` 回合成功结束后平台开的交付会话
 * (`project_sessions.deliverable_artifact_id`,migration 017)。
 *
 * ⚠️ **这一列的读法只有这一份定义** —— `runtime/dispatcher.ts` 的
 * `handover` 终止判据、收口门与验收判据、读面的「待收货」清单共用它。
 * 两份定义会漂,而这个项目为「两份定义会漂」已经付过好几次代价。
 *
 * ⚠️ **先问 schema 再查**(`PRAGMA table_info`):列不在(017 之前的库、
 * 手工搭的测试库)⇒ 返回空集,含义是「还没有任何交付会话」。
 * 不用 `try { … } catch { return [] }`:一条 SQL 报错被吞掉之后,「列还没迁移」
 * 与「查询写错了」在结果上长得一模一样(本项目最贵的失败形态)。
 */
export function deliveredDeliverables(
  db: Database.Database,
  projectId: string,
): DeliveredDeliverable[] {
  const columns = db.pragma("table_info(project_sessions)") as ReadonlyArray<{ name: string }>;
  if (!columns.some((c) => c.name === "deliverable_artifact_id")) return [];
  const rows = db
    .prepare(
      `SELECT id, deliverable_artifact_id AS artifact_id, created_at FROM project_sessions
       WHERE project_id = ? AND deliverable_artifact_id IS NOT NULL
       ORDER BY created_at ASC`,
    )
    .all(projectId) as ReadonlyArray<{ id: string; artifact_id: string; created_at: number }>;
  return rows.map((r) => ({
    artifactId: r.artifact_id,
    sessionId: r.id,
    deliveredAt: r.created_at,
  }));
}

/** 只要 id 的那些调用方(判据 / 集合运算)用这一条。 */
export function deliveredDeliverableIds(
  db: Database.Database,
  projectId: string,
): string[] {
  return deliveredDeliverables(db, projectId).map((d) => d.artifactId);
}

/**
 * 「这个项目的货,甲方收了没有」—— **唯一的那条判据**。
 *
 * 三个消费者读的是同一个答案(少一处就会漂):
 *   · `runtime/dispatcher.ts` 的收口门与「甲方拒收」返工规则;
 *   · `transport/views.ts` 的派生状态「待收货」与交付物卡上的裁决标记;
 *   · `tools/project.ts` 的 `project_close` 门(模型调它也不能绕过)。
 *
 * ⚠️ 它只回答「已交付的那些」:一份**还没交付**的交付物不在 `delivered` 里 ——
 * 甲方没收到货,谈不上验收。所以 `pending` 的完整含义是
 * **「已经交到你手上、你还没表态」**。
 *
 * ⚠️ `pending` 非空就是「待收货」的判据。它与 `projects.status` 无关:
 * 项目在库里仍然是 `active`(见 029 文件头那段「为什么不加 status 取值」)。
 */
export interface DeliveryAcceptance {
  /** 有交付会话的交付物 id(平台已经把货交出去了) */
  readonly delivered: readonly string[];
  /** 其中还没有裁决的 —— 「待收货」的判据就是它非空 */
  readonly pending: readonly string[];
  /** 最新裁决是 `accept` 的 */
  readonly accepted: readonly string[];
  /** 最新裁决是 `reject` 的(甲方要改) */
  readonly rejected: readonly string[];
}

export function deliveryAcceptance(
  db: Database.Database,
  projectId: string,
): DeliveryAcceptance {
  const delivered = deliveredDeliverableIds(db, projectId);
  const latest = latestVerdictsByArtifact(db, projectId);
  const accepted: string[] = [];
  const rejected: string[] = [];
  const pending: string[] = [];
  for (const id of delivered) {
    const v = latest.get(id);
    if (v === undefined) pending.push(id);
    else if (v.verdict === "accept") accepted.push(id);
    else rejected.push(id);
  }
  return { delivered, pending, accepted, rejected };
}
