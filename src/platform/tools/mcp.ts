/**
 * MCP 平台工具:mcp_list / mcp_grant / mcp_revoke(2026-10-16,Wave 1)
 *
 * ── ⚠️ 这里**刻意没有**「新增 / 修改 server 定义」的工具 ────────────
 *
 * 一条 MCP server 定义 = **一条任意命令,或一个任意出网地址 + 一份凭据**。
 * 做成工具就意味着「某个模型能替甲方决定平台可以执行什么」——
 * 这与 `POST /api/artifacts/:id/verdict` 是同一个量级的决定,同款处置:
 * **它不是工具,不在任何角色的 `ceiling` 里**。只有 HTTP 写面能写定义。
 *
 * 而**授权**(在已定义的名字里开关)可以做,是因为它**不能扩权** ——
 * 名字必须在目录里存在,否则拒绝并列出可用名(`mcp_grant` 的实现里就是这么写的)。
 * 「谁授权」与「谁能用」分开,权限方向才不冲突:
 *
 *   定义  人 / HTTP      能扩权   → 只能人做
 *   授权  agent 可做      不能扩权 → 可以代理执行
 *
 * ── 三个工具各自在做什么 ────────────────────────────────────────
 *
 *   mcp_list     列目录 + 每个角色当前的授权状态(只读,`mcp.read`)
 *   mcp_grant    给某角色开一个已定义的 server(`mcp.grant`)
 *   mcp_revoke   关掉(`mcp.grant`)
 *
 * ⚠️ **`mcp.grant` 不在 `NUDGE_CAPABILITIES` 里**(2026-10-16 刻意):
 * 授权只影响**新建的会话**(会话池键是 `(项目, 会话, agent)`),而改授权去
 * 叫醒所有 agent 只会是噪音 —— 它们醒来之后手上的授权还是旧的。
 * 「改完授权要对已存在的会话重建才生效」这句话写进了 `mcp_grant` 的返回文本。
 */
import { Type } from "@sinclair/typebox";
import { PROJECT_ROLES, isProjectRole, type ProjectRole } from "../identity/role.js";
import { resolveMcpCatalog, catalogNames, isValidServerName, serversPath } from "../mcp/config.js";
import { readGrantFile, grantedRolesOf, writeGrantFile, type McpGrantFile } from "../mcp/grants.js";
import { hasSecrets } from "../mcp/secrets.js";
import { fail, ok, requireString,
  type PlatformTool, type ToolResult, type ToolRunContext } from "./types.js";

/** 没有装配数据目录时的统一回答 —— 不是空清单(那是「没有 server」)。 */
function noDataDir(tool: string): ToolResult {
  return fail(
    "internal",
    `装配错误:${tool} 需要 RuntimeDeps.dataDir(它读 <dataDir>/harness/mcp/servers.json),但这次调用没有拿到。` +
      `生产由 bootPlatform 注入 —— 这不是一个「没有 MCP」的状态,而是一个装错了的状态`,
  );
}

/** `role` 参数的收窄 —— 错误信息里必须带闭合集(8-F:拒绝要让模型能自纠)。 */
function readRole(args: Readonly<Record<string, unknown>>): { ok: true; value: ProjectRole } | { ok: false; result: ToolResult } {
  const raw = args["role"];
  if (typeof raw !== "string" || raw === "") {
    return { ok: false, result: fail("invalid_args", "缺少必填参数 role(必须是角色 id)", [...PROJECT_ROLES]) };
  }
  if (!isProjectRole(raw)) {
    return {
      ok: false,
      result: fail("invalid_args", `未知角色「${raw}」—— 角色来自闭合集 PROJECT_ROLES`, [...PROJECT_ROLES]),
    };
  }
  return { ok: true, value: raw };
}

const mcpList: PlatformTool = {
  name: "mcp_list",
  capability: "mcp.read",
  description:
    "列出平台的外部工具(MCP)目录,以及每个角色当前拿到了哪些。" +
    "**你只会看到自己工具面里存在的那部分** —— 外部 server 的工具在会话建立时就绑定了," +
    "授权改了要**新建的会话**才生效(对已经在跑的会话无效)。" +
    "一个 server 定义 = 一条命令或一个地址,**它只能由人配置(平台没有提供新增 server 的工具)**;" +
    "你能做的是在已定义的名字里开关某个角色能不能用。",
  parameters: Type.Object({}),
  async run(_args, ctx: ToolRunContext): Promise<ToolResult> {
    if (ctx.dataDir === undefined) return noDataDir("mcp_list");
    const dataDir = ctx.dataDir;
    const catalog = resolveMcpCatalog(dataDir);

    if (catalog.state === "invalid") {
      return fail(
        "internal",
        `server 目录读不了(${catalog.path}):${catalog.problem ?? ""}\n` +
          `没有任何 server 被接上 —— 请让人在 HTTP 写面修好 ${serversPath(dataDir)}`,
      );
    }
    if (catalog.servers.length === 0) {
      return ok(
        `外部工具目录是空的(共 0 条,${catalog.path})。\n` +
          `本平台当前不接任何外部工具 —— 这不是故障,是还没配。` +
          `定义一个 server 需要人通过 HTTP 写面做(POST /api/mcp/servers),平台**不提供**这个工具。`,
      );
    }

    const lines: string[] = [`外部工具目录(${catalog.servers.length} 条,${catalog.path}):`];
    for (const s of catalog.servers) {
      const granted = grantedRolesOf(dataDir, s.name);
      const where = s.transport === "stdio" ? `stdio ${s.command}` : `http ${s.url}`;
      const mine = granted.includes(ctx.agent.role) ? " · **你当前有这个**" : "";
      lines.push(
        `- ${s.name} · ${where}${s.description !== undefined ? ` · ${s.description}` : ""}` +
          `${hasSecrets(dataDir, s.name) ? " · 已配凭据" : ""}${mine}`,
      );
      lines.push(`  授权给:${granted.length > 0 ? granted.join(", ") : "(无 —— 没有任何角色拿到它)"}`);
    }
    const mine = catalog.servers.filter((s) => grantedRolesOf(dataDir, s.name).includes(ctx.agent.role));
    lines.push("");
    lines.push(
      mine.length === 0
        ? "你当前**没有任何**外部工具授权 —— 这一条会话里也不会有(授权只对新建会话生效)。"
        : `你当前有 ${mine.length} 条:${mine.map((s) => s.name).join(", ")} —— ` +
          `它们在本次会话建立时就绑定了;授权改动要新建会话才生效。`,
    );
    return ok(lines.join("\n"));
  },
};

/**
 * 授权的写面 —— 与 `harness/write.ts` 同四条规矩。
 *
 * ⚠️ 本文件**不重复实现**那四条(备份/原子写/回读),而是调 `mcp/grants.ts` 的
 * `writeGrantFile`,因为那一份已经把它们实现好了(备份落
 * `<dataDir>/harness/backups/mcp/`,保留 10 份,报成功 = 回读)。
 * 在这里再写一遍 = 两份实现迟早漂。
 */
const mcpGrant: PlatformTool = {
  name: "mcp_grant",
  capability: "mcp.grant",
  description:
    "把一个**已定义**的外部工具(MCP server)授权给某个角色。" +
    "**你不能新增 server 定义** —— 定义一条 server 就是让平台执行任意命令或向任意地址出网," +
    "那是人的决定,平台刻意不给你这个工具。" +
    "改名会写进 `<dataDir>/harness/mcp/<role>.json`。⚠️ **只对新建的会话生效**:" +
    "已经在跑的会话手上的授权不会变(授权只在会话建立那一刻被读)。",
  parameters: Type.Object({
    server: Type.String({ description: "server 名(必须是目录里已存在的那一条)" }),
    role: Type.String({ description: `角色 id,合法取值:${PROJECT_ROLES.join(" | ")}` }),
  }),
  async run(args, ctx: ToolRunContext): Promise<ToolResult> {
    if (ctx.dataDir === undefined) return noDataDir("mcp_grant");
    const dataDir = ctx.dataDir;

    const srv = requireString(args, "server");
    if (!srv.ok) return srv.result;
    const roleR = readRole(args);
    if (!roleR.ok) return roleR.result;

    const catalog = resolveMcpCatalog(dataDir);
    const names = catalogNames(catalog);
    if (!names.includes(srv.value)) {
      // 名字不存在 —— 拒,并列出可用名。**不静默创建**:那等于给平台造一个定义。
      return fail(
        "invalid_args",
        catalog.state === "invalid"
          ? `server 目录读不了(${catalog.path}),所以无法确认「${srv.value}」存不存在。${catalog.problem ?? ""}`
          : `目录里没有名为「${srv.value}」的 server。新增定义是**人的决定**,平台不提供这个工具 —— ` +
            `请让人通过 HTTP 写面创建它(POST /api/mcp/servers)。`,
        names,
      );
    }
    if (!isValidServerName(srv.value)) {
      return fail("invalid_args", `server 名「${srv.value}」不合法(只允许字母 / 数字 / _ / -)`, names);
    }

    const cur = readGrantFile(dataDir, roleR.value);
    if (cur.state === "invalid") {
      return fail(
        "internal",
        `${roleR.value} 的授权文件当前无效(${cur.path}):${cur.problem ?? ""}\n` +
          `请让人先修好它 —— 在坏文件上叠加授权只会把「零授权」变成「猜出来的授权」。`,
      );
    }
    const file: McpGrantFile = cur.file ?? { allow: [], deny: [] };
    if (file.allow.includes(srv.value)) {
      return ok(`${roleR.value} 本来就有「${srv.value}」,没写任何东西。`);
    }
    const next: McpGrantFile = {
      allow: [...file.allow, srv.value],
      deny: [...file.deny.filter((d) => d !== srv.value)],
    };
    const w = writeGrantFile(dataDir, roleR.value, next, ctx.now());
    if (!w.ok) {
      return fail("internal", `写授权文件失败:${w.detail ?? "未知原因"}`);
    }
    return ok(
      `已把「${srv.value}」授权给 ${roleR.value}(回读确认,allow ${w.file?.allow.length ?? 0} 条)。\n` +
        `⚠️ **只对新建的会话生效** —— 已经在跑的 ${roleR.value} 会话手上的工具面不会变。\n` +
        `现在授权给:${grantedRolesOf(dataDir, srv.value).join(", ")}`,
    );
  },
};

const mcpRevoke: PlatformTool = {
  name: "mcp_revoke",
  capability: "mcp.grant",
  description:
    "收回某个角色对某个外部工具(MCP server)的授权。**不影响 server 定义本身**" +
    "(那是人的资产)。⚠️ 同样**只对新建的会话生效**。",
  parameters: Type.Object({
    server: Type.String({ description: "server 名" }),
    role: Type.String({ description: `角色 id,合法取值:${PROJECT_ROLES.join(" | ")}` }),
  }),
  async run(args, ctx: ToolRunContext): Promise<ToolResult> {
    if (ctx.dataDir === undefined) return noDataDir("mcp_revoke");
    const dataDir = ctx.dataDir;

    const srv = requireString(args, "server");
    if (!srv.ok) return srv.result;
    const roleR = readRole(args);
    if (!roleR.ok) return roleR.result;

    const catalog = resolveMcpCatalog(dataDir);
    const names = catalogNames(catalog);
    if (names.length > 0 && !names.includes(srv.value)) {
      return fail("invalid_args", `目录里没有名为「${srv.value}」的 server`, names);
    }
    const cur = readGrantFile(dataDir, roleR.value);
    const file: McpGrantFile = cur.file ?? { allow: [], deny: [] };
    if (!file.allow.includes(srv.value)) {
      return ok(`${roleR.value} 本来就没有「${srv.value}」,没写任何东西。`);
    }
    const next: McpGrantFile = {
      allow: file.allow.filter((n) => n !== srv.value),
      deny: file.deny,
    };
    const w = writeGrantFile(dataDir, roleR.value, next, ctx.now());
    if (!w.ok) {
      return fail("internal", `写授权文件失败:${w.detail ?? "未知原因"}`);
    }
    return ok(
      `已收回 ${roleR.value} 对「${srv.value}」的授权(回读确认,allow ${w.file?.allow.length ?? 0} 条)。\n` +
        `⚠️ **只对新建的会话生效**。现在授权给:` +
        `${grantedRolesOf(dataDir, srv.value).join(", ") || "(无)"}`,
    );
  },
};

export const MCP_TOOLS: readonly PlatformTool[] = [mcpList, mcpGrant, mcpRevoke];
