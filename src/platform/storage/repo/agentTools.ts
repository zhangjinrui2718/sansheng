/**
 * 自己的工具 · 停用记录(`agent_tool_disables`,migration 040)· 仓储
 *
 * ── 为什么只有「停用」一张表 ─────────────────────────────────────
 *
 * 用户裁决(2026-11-28):「自己的 rag 和代码仓库不需要我放行」。所以这里**没有**
 * 待审 / 通过 / 退回那套状态机 —— 角色写进自己仓库的工具直接进他自己的会话。
 * 人唯一需要落库的动作是踩刹车:停用某一条。
 *
 * 「有哪些工具」不从这张表读 —— 它是**扫仓库**扫出来的(`harness/ownTools.ts`),
 * 仓库就是真相;这张表只回答「其中哪几条被人停了」。
 *
 * ⚠️ 停用**不因文件挪动而失效**:目录删了又回来,那一行还在,它仍是停用的
 * (停用是人的决定,不是文件的状态)。
 */
import type Database from "better-sqlite3";

export interface AgentToolDisableRow {
  readonly id: string;
  readonly agentId: string;
  readonly toolName: string;
  readonly disabledAt: number;
}

type RawDisable = { id: string; agent_id: string; tool_name: string; disabled_at: number };

function rowToDisable(r: RawDisable): AgentToolDisableRow {
  return { id: r.id, agentId: r.agent_id, toolName: r.tool_name, disabledAt: r.disabled_at };
}

/** 某个人被停用的工具名(工具面与人读面都用它过滤)。 */
export function listDisabledOwnTools(db: Database.Database, agentId: string): string[] {
  const rows = db
    .prepare(`SELECT tool_name FROM agent_tool_disables WHERE agent_id = ? ORDER BY disabled_at ASC`)
    .all(agentId) as Array<{ tool_name: string }>;
  return rows.map((r) => r.tool_name);
}

export function isOwnToolDisabled(db: Database.Database, agentId: string, toolName: string): boolean {
  return listDisabledOwnTools(db, agentId).includes(toolName);
}

/**
 * 按下 / 松开刹车。
 *
 * @returns 这次调用**是否改动了行**(幂等调用:停用一条已停用的 ⇒ `false`)。
 *   调用方靠它决定「要不要换会话」—— 没改动却丢会话,是把一个空操作说成了生效。
 */
export function setOwnToolDisabled(
  db: Database.Database,
  args: {
    readonly id: string;
    readonly agentId: string;
    readonly toolName: string;
    readonly disabled: boolean;
    readonly now: number;
  },
): boolean {
  if (!args.disabled) {
    return db
      .prepare(`DELETE FROM agent_tool_disables WHERE agent_id = ? AND tool_name = ?`)
      .run(args.agentId, args.toolName).changes > 0;
  }
  return (
    db
      .prepare(
        `INSERT INTO agent_tool_disables (id, agent_id, tool_name, disabled_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (agent_id, tool_name) DO NOTHING`,
      )
      .run(args.id, args.agentId, args.toolName, args.now).changes > 0
  );
}

/** 全部停用记录(重置清库后的核对与测试用)。 */
export function listAllAgentToolDisables(db: Database.Database): AgentToolDisableRow[] {
  const rows = db
    .prepare(`SELECT id, agent_id, tool_name, disabled_at FROM agent_tool_disables`)
    .all() as RawDisable[];
  return rows.map(rowToDisable);
}
