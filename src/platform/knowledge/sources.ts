/**
 * 知识语料 · 来源正文的**现读**(索引与引用共用)
 *
 * 语料不存正文(设计 `docs/DESIGN-KNOWLEDGE.md` §2),所以"这一块到底是什么字"
 * 每次都要回来源去取:
 *
 *   - `artifact` → 项目仓里的正文文件(`artifacts.body_path`,项目根相对路径)
 *   - `message` → `session_messages.content`
 *
 * ── 三态不是"ok 就都不是空正文" ──────────────────────────────────
 *
 * `materializeChunk` 返回的 `state` 是判据:
 *
 *   ok           现读文本与索引记的哈希一致
 *   drifted      读到了,但**与索引记的不是同一份**(文件被人改过 / 行被改过)——
 *                下一次 reindex 会收回一致;调用方要如实标出,不许装作正常
 *   unavailable  读不到(装配没接上工作区 / 文件不在 / 行不在)—— **不是空正文**
 *
 * 三者混同的代价:模型会拿一个空片段当"语料里写着没有",而真相是"这次读不到"。
 */
import type Database from "better-sqlite3";
import type { WorkspacePort } from "../workspace/port.js";
import { projectWorkspaceRoot } from "../workspace/root.js";
import { getArtifact } from "../storage/repo/artifacts.js";
import { chunkSha, type KnowledgeChunkRow } from "../storage/repo/knowledge.js";
import { htmlToText, isHtmlBodyPath } from "./chunk.js";

export type SourceRead =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly problem: string };

/**
 * 工件正文的读取器(注入工作区端口 + 工作根)。
 *
 * 装配缺一半 ⇒ 返回 `null`,调用方必须报**装配错误**并说清后果 ——
 * 不静默跳过(与 `tools/artifactBody.ts` 的 `workspaceAccess` 同一条纪律)。
 */
export function makeArtifactTextReader(deps: {
  readonly workspace?: WorkspacePort;
  readonly workspaceRoot?: string;
}): ((projectId: string, bodyPath: string) => SourceRead) | null {
  const { workspace, workspaceRoot } = deps;
  if (workspace === undefined || workspaceRoot === undefined) return null;
  return (projectId: string, bodyPath: string): SourceRead => {
    const root = projectWorkspaceRoot(workspaceRoot, projectId);
    const r = workspace.read({ root, path: bodyPath });
    if (!r.ok) return { ok: false, problem: r.problem };
    return { ok: true, text: isHtmlBodyPath(bodyPath) ? htmlToText(r.value) : r.value };
  };
}

/** 消息正文(`session_messages.content`)。行不在 ⇒ 读不到,不是空正文。 */
export function readMessageText(db: Database.Database, messageId: string): SourceRead {
  const row = db.prepare(`SELECT content FROM session_messages WHERE id = ?`).get(messageId) as
    | { content: string }
    | undefined;
  if (row === undefined) return { ok: false, problem: `消息 ${messageId} 不在库里(可能已被清理)` };
  return { ok: true, text: row.content };
}

export type MaterializedState = "ok" | "drifted" | "unavailable";

export interface Materialization {
  readonly state: MaterializedState;
  /** 只有在确定读到时才有值(`unavailable` 时是空串) */
  readonly slice: string;
  /** `unavailable` / `drifted` 的原因 —— 调用方必须把它显示出来 */
  readonly problem: string | null;
  /** 该来源现读到的**全文长度**(`unavailable` 时是 `null`) */
  readonly sourceLength: number | null;
}

/**
 * 取一条块的正文切片(按索引记的 `offset` / `length` 从来源现读)。
 *
 * 哈希不符 ⇒ `drifted`:仍然把切片交回去(它多半就是模型要的那段),
 * 但**带上状态**。返回空切片 + `ok` 是绝对不许出现的一种组合 ——
 * 那等于对模型说"这段正文是空的"。
 */
export function materializeChunk(
  db: Database.Database,
  reader: ((projectId: string, bodyPath: string) => SourceRead) | null,
  chunk: KnowledgeChunkRow,
): Materialization {
  let src: SourceRead;
  if (chunk.sourceKind === "message") {
    if (chunk.messageId === null) {
      return { state: "unavailable", slice: "", problem: "这条块的索引缺 message_id(索引行损坏)", sourceLength: null };
    }
    src = readMessageText(db, chunk.messageId);
  } else {
    if (chunk.artifactId === null || chunk.projectId === null) {
      return { state: "unavailable", slice: "", problem: "这条块的索引缺 artifact_id / project_id(索引行损坏)", sourceLength: null };
    }
    const artifact = getArtifact(db, chunk.artifactId);
    if (artifact === null) {
      return { state: "unavailable", slice: "", problem: `工件 ${chunk.artifactId} 不在库里(它可能已被删除)`, sourceLength: null };
    }
    if (reader === null) {
      return {
        state: "unavailable", slice: "", sourceLength: null,
        problem:
          "本次装配没有接上**工作区**(`workspace` + `workspaceRoot`),所以平台读不到项目仓里的工件正文。" +
          "这是装配错误,不是查询的问题 —— 请登记阻塞让平台修,不要反复重试同一次调用。",
      };
    }
    src = reader(chunk.projectId, artifact.bodyPath);
  }

  if (!src.ok) {
    return { state: "unavailable", slice: "", problem: src.problem, sourceLength: null };
  }
  const text = src.text;
  const slice = text.slice(chunk.offset, chunk.offset + chunk.length);
  if (chunkSha(slice) !== chunk.sha256) {
    return {
      state: "drifted",
      slice,
      sourceLength: text.length,
      problem:
        "索引记的那一段与来源现在的内容不一致(文件被人改过)。" +
        "下一次平台重扫(reindex)会收回一致;在此之前请以来源为准,或重新检索一次。",
    };
  }
  return { state: "ok", slice, problem: null, sourceLength: text.length };
}
