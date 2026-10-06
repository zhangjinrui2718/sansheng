/**
 * 质检的审查结论(021 的 `review_verdicts` 表)。
 *
 * ── 它存在的理由是「把散文变成一行」 ─────────────────────────────
 *
 * 事故(2026-10-06 08:57):质检判**不通过**,审查意见 3352 字落成工件,
 * 而那条工作项在库里是 `done` / `review_state='done'` —— **不会再审第二次**,
 * 不通过也没有任何读者。根因是 `markWorkReviewed` 的判据是「回合成功结束」
 * 而不是「判通过」,而「审出了什么」当时只以散文存在于工件正文里。
 *
 * 所以 verdict 必须是一**行**、由**一个工具调用**写入的结构化事实。
 * 解析 `review_finding.metadata_json` 不是替代方案:那是与模型约定的私有
 * 格式,模型忘了写就静默按通过处理 —— 与事故现场一模一样。
 *
 * ── 纪律 ────────────────────────────────────────────────────────
 *
 * 本模块只做读写,不做判定。「这条产出审过了没有」那条判据仍然在
 * `repo/works.ts` 的 `listWorksPendingReview`,而「判过了没有」由 021 之后
 * 的 `runtime/dispatcher.ts` 把两者合起来读。
 */
import type Database from "better-sqlite3";

export type ReviewVerdict = "pass" | "fail";
export type ReviewSeverity = "low" | "medium" | "high";

export const REVIEW_VERDICTS: readonly ReviewVerdict[] = ["pass", "fail"];
export const REVIEW_SEVERITIES: readonly ReviewSeverity[] = ["low", "medium", "high"];

export function isReviewVerdict(v: unknown): v is ReviewVerdict {
  return typeof v === "string" && (REVIEW_VERDICTS as readonly string[]).includes(v);
}

export function isReviewSeverity(v: unknown): v is ReviewSeverity {
  return typeof v === "string" && (REVIEW_SEVERITIES as readonly string[]).includes(v);
}

export interface ReviewVerdictRow {
  seq: number;
  workId: string;
  projectId: string;
  verdict: ReviewVerdict;
  severity: ReviewSeverity;
  findingArtifactId: string | null;
  note: string | null;
  reviewedBy: string;
  createdAt: number;
}

interface RawReviewVerdict {
  seq: number;
  work_id: string;
  project_id: string;
  verdict: string;
  severity: string;
  finding_artifact_id: string | null;
  note: string | null;
  reviewed_by: string;
  created_at: number;
}

function rowToVerdict(raw: RawReviewVerdict): ReviewVerdictRow {
  // 两个闭集**硬抛**而不是回落成默认值:`review_finding` 那种「status 不承载
  // 语义」的形态正是这次事故的旁证,含糊的读面会把同一个问题再造一次。
  if (!isReviewVerdict(raw.verdict)) {
    throw new Error(`review_verdicts 表里出现未定义 verdict「${raw.verdict}」(seq=${raw.seq})`);
  }
  if (!isReviewSeverity(raw.severity)) {
    throw new Error(`review_verdicts 表里出现未定义 severity「${raw.severity}」(seq=${raw.seq})`);
  }
  return {
    seq: raw.seq,
    workId: raw.work_id,
    projectId: raw.project_id,
    verdict: raw.verdict,
    severity: raw.severity,
    findingArtifactId: raw.finding_artifact_id,
    note: raw.note,
    reviewedBy: raw.reviewed_by,
    createdAt: raw.created_at,
  };
}

/** 写一条审查结论。append-only —— 改判必须留痕(只留最后一条 = 改判现场消失)。 */
export function insertReviewVerdict(
  db: Database.Database,
  row: {
    workId: string;
    projectId: string;
    verdict: ReviewVerdict;
    severity: ReviewSeverity;
    findingArtifactId: string | null;
    note: string | null;
    reviewedBy: string;
    createdAt: number;
  },
): void {
  db.prepare(
    `INSERT INTO review_verdicts
       (work_id, project_id, verdict, severity, finding_artifact_id, note, reviewed_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.workId, row.projectId, row.verdict, row.severity,
    row.findingArtifactId, row.note, row.reviewedBy, row.createdAt,
  );
}

/** 这条工作项的**全部**结论,时间升序(第一次审查在前)。 */
export function listReviewVerdicts(
  db: Database.Database,
  workId: string,
): ReviewVerdictRow[] {
  const rows = db
    .prepare(`SELECT * FROM review_verdicts WHERE work_id = ? ORDER BY created_at, seq`)
    .all(workId) as RawReviewVerdict[];
  return rows.map(rowToVerdict);
}

/**
 * 这条工作项**最新**一次审查结论;没审过则 `null`。
 *
 * 「最新」按 `(created_at, seq)` 取 —— `created_at` 单靠它不总够:同一毫秒里
 * 写两条时并列,取哪一条就成了未定义行为,而**判据不能有未定义分支**。
 */
export function latestReviewVerdict(
  db: Database.Database,
  workId: string,
): ReviewVerdictRow | null {
  const raw = db
    .prepare(
      `SELECT * FROM review_verdicts WHERE work_id = ?
       ORDER BY created_at DESC, seq DESC LIMIT 1`,
    )
    .get(workId) as RawReviewVerdict | undefined;
  return raw === undefined ? null : rowToVerdict(raw);
}

/** 这个项目里**最近一次**的结论,按工作项分组(消费块与告警用)。 */
export function latestVerdictsByWork(
  db: Database.Database,
  projectId: string,
): Map<string, ReviewVerdictRow> {
  // 窗口函数:每条 work_id 取 (created_at, seq) 最大的那条。
  // ⚠️ SQLite 3.25+ 才有窗口函数 —— better-sqlite3 内置的是 3.4x,可用;
  // 若将来换驱动,这一处是第一个要改的。
  const rows = db
    .prepare(
      `SELECT work_id, MAX(created_at) AS created_at FROM review_verdicts
       WHERE project_id = ? GROUP BY work_id`,
    )
    .all(projectId) as Array<{ work_id: string; created_at: number }>;
  const out = new Map<string, ReviewVerdictRow>();
  for (const r of rows) {
    const one = db
      .prepare(
        `SELECT * FROM review_verdicts WHERE work_id = ? AND created_at = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(r.work_id, r.created_at) as RawReviewVerdict | undefined;
    if (one !== undefined) out.set(r.work_id, rowToVerdict(one));
  }
  return out;
}
