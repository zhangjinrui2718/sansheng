/**
 * 自己的仓库与经验库 · 人读面(migration 040)
 *
 * ── 「有哪些工具」从哪来 ────────────────────────────────────────
 *
 * **扫仓库**,不读任何登记表(`harness/ownTools.ts` 的 `scanOwnTools`)—— 仓库就是真相。
 * 停用记录(`agent_tool_disables`)只回答「其中哪几条被人停了、什么时候停的」。
 *
 * ── 三种「不知道」与「真的没有」分开 ────────────────────────────
 *
 *   `repoState: "unavailable"` 没有装配工作区 / 扫描抛错 ⇒ 读不到;
 *   `repoState: "missing"`     目录还没建出来 ⇒ 读得到,里面确实没有;
 *   `repoState: "ready"`       正常。
 * `notes: null` 同理(经验库读不到 ≠ 0 条)。
 */
import type Database from "better-sqlite3";
import type { AgentNoteView, OwnKitView, OwnToolView } from "@shared/types/platform.js";
import type { ProjectRole } from "../identity/role.js";
import { agentWorkspaceRoot } from "../workspace/root.js";
import { canRunOwnMcp, scanOwnTools, type OwnToolScan } from "../harness/ownTools.js";
import { countAgentNotesByKind, type AgentNoteRow } from "../storage/repo/agentNotes.js";
import { listOwnToolDisableRows } from "../storage/repo/agentTools.js";

export function toAgentNoteView(n: AgentNoteRow): AgentNoteView {
  return {
    id: n.id,
    kind: n.kind,
    title: n.title,
    content: n.content,
    source: n.source,
    sourceProjectId: n.sourceProjectId,
    status: n.status,
    retireReason: n.retireReason,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
  };
}

/** 一条工具的视图:状态 = 扫描结果(合不合法)× 停用记录(人踩没踩刹车)。 */
export function toOwnToolView(t: OwnToolScan, disabledAt: number | null): OwnToolView {
  return {
    name: t.name,
    kind: t.kind,
    description: t.description,
    state: t.problem !== null ? "invalid" : disabledAt !== null ? "disabled" : "usable",
    problem: t.problem,
    disabledAt,
    fileCount: t.fileCount,
  };
}

/**
 * 一个角色的「自己的东西」。`workspaceRoot` 没给(只挂 HTTP 的装配)⇒ 仓库那半边
 * 如实回 `unavailable`,经验库那半边照常(它只要库)。
 */
export function toOwnKitView(
  db: Database.Database,
  args: { readonly agentId: string; readonly role: ProjectRole; readonly workspaceRoot: string | undefined },
): OwnKitView {
  let notes: OwnKitView["notes"];
  try {
    const c = countAgentNotesByKind(db, args.agentId);
    notes = { lesson: c.lesson, research: c.research };
  } catch {
    notes = null;
  }

  if (args.workspaceRoot === undefined) {
    return {
      repoDir: "",
      repoState: "unavailable",
      problem: "这次运行没有装配工作区 —— 自己的仓库读不到(不是「他没有工具」)",
      tools: [],
      notes,
    };
  }
  const repoDir = agentWorkspaceRoot(args.workspaceRoot, args.role);
  let scan: ReturnType<typeof scanOwnTools>;
  try {
    scan = scanOwnTools(repoDir, { canExec: canRunOwnMcp(args.role) });
  } catch (e) {
    return {
      repoDir,
      repoState: "unavailable",
      problem: `仓库扫不出来:${e instanceof Error ? e.message : String(e)}`,
      tools: [],
      notes,
    };
  }
  let disabled = new Map<string, number>();
  try {
    disabled = new Map(listOwnToolDisableRows(db, args.agentId).map((r) => [r.toolName, r.disabledAt]));
  } catch {
    // 停用记录读不到:工具照列,一律按「没停用」显示是不诚实的 —— 所以这里让整个读面
    // 落成 unavailable(读不到 ≠ 没停用)。
    return { repoDir, repoState: "unavailable", problem: "停用记录读不到", tools: [], notes };
  }
  return {
    repoDir,
    repoState: scan.state,
    tools: scan.tools.map((t) => toOwnToolView(t, disabled.get(t.name) ?? null)),
    notes,
  };
}
