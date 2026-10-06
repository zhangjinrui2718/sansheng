/**
 * 真机探针用的小工具(只被 `.probe/2026-10-06-close-rule.mts` 引用)。
 *
 * ⚠️ `close_project_witness` 把收口规则的**八格判据**逐条读出来,让探针能证明
 * 「它成立不是因为条件写空了」。它**只读**,不改任何状态。
 */
import type Database from "better-sqlite3";
import { collectTodos, renderTask } from "../src/platform/runtime/dispatcher.js";
import { getProjectRow } from "../src/platform/storage/repo/projects.js";
import { listWorks, isTerminalWorkStatus } from "../src/platform/storage/repo/works.js";
import { listArtifacts, listPendingDispatchEvents } from "../src/platform/storage/index.js";
import { listBlockers } from "../src/platform/storage/repo/blockers.js";
import { listUnconsumedClientAnswers } from "../src/platform/storage/repo/clientQuestions.js";

export { collectTodos, renderTask };

export interface CloseWitness {
  projectStatus: string;
  nonTerminalWorkCount: number;
  pendingReviewCount: number;
  unconsumedEventCount: number;
  awaitingClient: boolean;
  unconsumedClientAnswers: number;
  unresolvedBlockerCount: number;
  acceptedDeliverableCount: number;
  undeliveredAcceptedCount: number;
}

export function close_project_witness(db: Database.Database, projectId: string): CloseWitness {
  const works = listWorks(db, projectId);
  const accepted = listArtifacts(db, projectId, { kind: "deliverable", status: "accepted", limit: 500 });
  const delivered = new Set(
    (db.prepare(
      `SELECT deliverable_artifact_id AS id FROM project_sessions
        WHERE project_id = ? AND deliverable_artifact_id IS NOT NULL`,
    ).all(projectId) as Array<{ id: string }>).map((r) => r.id),
  );
  return {
    projectStatus: getProjectRow(db, projectId)?.status ?? "(查不到)",
    nonTerminalWorkCount: works.filter((w) => !isTerminalWorkStatus(w.status)).length,
    pendingReviewCount: works.filter((w) => w.status === "done" && w.reviewState === "pending").length,
    unconsumedEventCount: listPendingDispatchEvents(db, projectId).length,
    awaitingClient: listArtifacts(db, projectId, { kind: "client_question", status: "open", limit: 500 }).length > 0,
    unconsumedClientAnswers: listUnconsumedClientAnswers(db, projectId).length,
    unresolvedBlockerCount: listBlockers(db, projectId, { unresolvedOnly: true }).length,
    acceptedDeliverableCount: accepted.length,
    undeliveredAcceptedCount: accepted.filter((a) => !delivered.has(a.id)).length,
  };
}