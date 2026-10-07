/**
 * 知识语料 · 索引器(平台侧,确定性,**零模型调用**)
 *
 * 设计 `docs/DESIGN-KNOWLEDGE.md` §5。触发点是两个,全部由平台发起:
 *
 *   - **T3 回合边界**:`host/serve.ts` 的 `housekeepingCommit`(成功/失败/超时/被中断
 *     四条路都到)里对本项目重扫一次 —— 与它现有的"索引向盘收敛 + 提交 + 回填 sha"
 *     同一位置、同一纪律;
 *   - **T5 启动**:宿主启动时对所有项目跑一遍,补跑存量 + 检出 drift。
 *
 * ── 三条不许做错的事 ─────────────────────────────────────────────
 *
 * ① **幂等**:同一份来源重扫两次 ⇒ 块与 id 都不变(`sha256` 相同就跳过)。排空器会重试、
 *    宿主会重启,不幂等就会攒出一堆重复块。
 * ② **读不到不许删已有的块**:工件正文暂时读不到(盘上没了 / 装配没接上)是"这次读不到",
 *    不是"这份语料不存在"。删掉它 = 把一次读故障变成一次语料丢失,而两者在屏幕上
 *    长得一样。所以读失败的来源**原样保留旧块**,并进 `unreadable` 报告。
 * ③ **对账有上限时不许 prune**:`listArtifacts` 单次上限 500。真撞上上限时按来源对账
 *    会把 500 条之外的工件判成"来源已消失"从而删掉它们的块 —— 所以那种情况下
 *    **跳过 prune 并如实报出**(`pruneSkipped`),宁可留脏数据也不静默丢语料。
 */
import type Database from "better-sqlite3";
import type { WorkspacePort } from "../workspace/port.js";
import { listArtifacts } from "../storage/repo/artifacts.js";
import { listProjects } from "../storage/repo/projects.js";
import {
  countProjectKnowledge,
  pruneProjectKnowledge,
  replaceSourceChunks,
  sourceKey,
  type KnowledgeSourceKind,
} from "../storage/repo/knowledge.js";
import { indexTerms } from "../../shared/text.js";
import { chunkText, htmlToText, isHtmlBodyPath } from "./chunk.js";
import { makeArtifactTextReader } from "./sources.js";

/** `listArtifacts` 的单次上限(repo 层钳住的)。撞上它就说明"这次没扫全"。 */
const ARTIFACT_SCAN_LIMIT = 500;

export interface KnowledgeIndexDeps {
  readonly db: Database.Database;
  readonly now: () => number;
  readonly newId: (prefix: string) => string;
  readonly workspace?: WorkspacePort;
  readonly workspaceRoot?: string;
}

export interface UnreadableSource {
  readonly sourceKind: KnowledgeSourceKind;
  readonly sourceId: string;
  readonly problem: string;
}

export interface KnowledgeIndexReport {
  readonly projectId: string;
  readonly artifactsIndexed: number;
  readonly messagesIndexed: number;
  /** 重扫之后该项目的语料条数(不是本次新增数) */
  readonly chunks: number;
  readonly unreadable: readonly UnreadableSource[];
  readonly pruned: number;
  /** 非 null = 这次没做按来源对账,以及为什么 */
  readonly pruneSkipped: string | null;
}

interface MessageRow {
  id: string;
  content: string;
}

/**
 * 重扫一个项目的语料。
 *
 * 来源:P1 = 工件正文 + 甲方/角色的会话消息(`kind IN ('user','assistant')`)。
 * `system` 是平台通知(告警/停止推进),不是语料,刻意不收(设计 §3)。
 */
export function reindexProjectKnowledge(
  deps: KnowledgeIndexDeps,
  projectId: string,
): KnowledgeIndexReport {
  const { db, now, newId } = deps;
  const at = now();
  const reader = makeArtifactTextReader(deps);
  const seen = new Set<string>();
  const unreadable: UnreadableSource[] = [];
  let artifactsIndexed = 0;
  let messagesIndexed = 0;

  // ── 工件正文 ───────────────────────────────────────────────────
  const artifacts = listArtifacts(db, projectId, { limit: ARTIFACT_SCAN_LIMIT });
  for (const a of artifacts) {
    seen.add(sourceKey("artifact", a.id));
    if (reader === null) {
      unreadable.push({
        sourceKind: "artifact", sourceId: a.id,
        problem: "装配没有接上工作区(workspace + workspaceRoot),读不到项目仓里的正文",
      });
      continue;
    }
    const read = reader(projectId, a.bodyPath);
    if (!read.ok) {
      unreadable.push({ sourceKind: "artifact", sourceId: a.id, problem: read.problem });
      continue;
    }
    const text = isHtmlBodyPath(a.bodyPath) ? htmlToText(read.text) : read.text;
    const chunks = chunkText(text).map((c) => ({ seq: c.seq, offset: c.offset, length: c.length, text: c.text }));
    replaceSourceChunks(db, {
      sourceKind: "artifact", sourceId: a.id, projectId, artifactId: a.id, workId: a.workId,
      chunks, newId, now: at, segOf: indexTerms,
    });
    artifactsIndexed++;
  }

  // ── 会话消息(只收 user / assistant)─────────────────────────────
  const messages = db
    .prepare(
      `SELECT m.id AS id, m.content AS content
         FROM session_messages m
         JOIN project_sessions ps ON ps.id = m.session_id
        WHERE ps.project_id = ?
          AND m.kind IN ('user', 'assistant')
          AND length(trim(m.content)) > 0
        ORDER BY m.created_at ASC`,
    )
    .all(projectId) as MessageRow[];

  for (const m of messages) {
    seen.add(sourceKey("message", m.id));
    const chunks = chunkText(m.content).map((c) => ({ seq: c.seq, offset: c.offset, length: c.length, text: c.text }));
    replaceSourceChunks(db, {
      sourceKind: "message", sourceId: m.id, projectId, messageId: m.id,
      chunks, newId, now: at, segOf: indexTerms,
    });
    messagesIndexed++;
  }

  // ── 按来源对账(见文件头 ③)─────────────────────────────────────
  //
  // ⚠️ `seen` 收的是**从库里枚举到的来源 id**,不是"读成功的来源" —— 工件正文读不到
  // (装配缺工作区 / 文件被删)时它的旧块照样在 `seen` 里、不会被 prune。
  // 这条线就是"读故障不许变成语料丢失"的实现处(文件头 ②)。
  let pruned = 0;
  let pruneSkipped: string | null = null;
  if (artifacts.length >= ARTIFACT_SCAN_LIMIT) {
    pruneSkipped =
      `本次只扫到 ${ARTIFACT_SCAN_LIMIT} 条工件(单次上限),按来源对账被跳过 —— ` +
      `否则会把上限之外的工件误判成"来源已消失"并删掉它们的语料`;
  } else {
    pruned = pruneProjectKnowledge(db, projectId, seen);
  }

  return {
    projectId,
    artifactsIndexed,
    messagesIndexed,
    chunks: countProjectKnowledge(db, projectId),
    unreadable,
    pruned,
    pruneSkipped,
  };
}

/**
 * 所有项目的重扫(宿主启动时跑)。
 *
 * ⚠️ **不静默**:每个项目的报告都要能落到日志里(`describeReport`),
 * 尤其是 `unreadable` 与 `pruneSkipped` —— 它们正是"语料缺了一块"的现场。
 */
export function reindexAllKnowledge(deps: KnowledgeIndexDeps): KnowledgeIndexReport[] {
  return listProjects(deps.db).map((p) => reindexProjectKnowledge(deps, p.id));
}

/** 一行人类可读的索引报告(宿主日志用)。**只报事实,不美化**。 */
export function describeReport(r: KnowledgeIndexReport): string {
  const parts = [
    `项目 ${r.projectId}: 工件 ${r.artifactsIndexed} · 消息 ${r.messagesIndexed} · 语料 ${r.chunks}`,
  ];
  if (r.pruned > 0) parts.push(`清除失效语料 ${r.pruned}`);
  if (r.unreadable.length > 0) {
    const items = r.unreadable.map((u) => `${u.sourceKind}:${u.sourceId}(${u.problem})`).join("、");
    parts.push(`读不到 ${r.unreadable.length} 条:${items}`);
  }
  if (r.pruneSkipped !== null) parts.push(`对账跳过:${r.pruneSkipped}`);
  return parts.join(" · ");
}
