/**
 * Sansheng 平台 · MCP · **角色授权**(`<dataDir>/harness/mcp/{role}.json`)
 *
 * ── 它与 server 定义的权限方向是**相反**的 ──────────────────────
 *
 *   定义(config.ts)   人 / HTTP 写    能扩权:执行什么命令、连到哪个地址
 *   授权(本文件)     agent 也可写    不能扩权:**只能在已定义的名字里开关**
 *
 * 所以本文件写的 `allow` 里的名字**必须**在目录里存在 —— 不存在的名字进
 * `unknownServers` 并如实报出,**不静默生效**。静默生效的话,删掉一条 server
 * 定义再重建同名的一条,授权就悄悄跟了过去(7-D:平台不许替模型抹平它没做的事)。
 *
 * ── ⚠️ 坏文件的退化方向与 `harness/toolSet.ts` **相反**,这是刻意的 ──
 *
 * `toolSet.ts` 坏文件 ⇒ 退化成 **ceiling 全集**(方向上**放宽**)。它之所以敢这么
 * 做,是因为集合文件是**收窄**机制:用户的意图是「少给几个」,坏文件退化成全集
 * 最坏也就是回到出厂状态,而 `problem` 会让这件事可见。
 *
 * **本文件是增量机制**:授权文件是「在已定义的 server 里再开几个」的那一份意图。
 * 若坏文件按「全放行」处置,一个笔误(`{"allow": [` / 改坏一个字符)就会
 * **一次性静默提权** —— 那个方向没有出厂状态可回落,只有更宽。
 *
 *   `harness/tools/{role}.json` 坏 ⇒ ceiling 全集(**更宽**,可见)
 *   `harness/mcp/{role}.json`   坏 ⇒ 零授权(**更严**,可见)
 *
 * 两条纪律里,「坏文件**绝不能静默**」是共同的;「退化到哪个方向」由机制性质决定。
 * 回归 `tests/platform/mcp-grants.test.ts` 里有断言把这两个方向钉在一起 ——
 * 它们必须**同时**存在,只改一边会静默地改变另一个的语义。
 *
 * ── 形状纪律直接复用 `parseToolSetFile` ──────────────────────────
 *
 * `allow` 与 `deny` **都必须显式存在且是字符串数组**,缺一整份判 invalid。
 * 理由一字不改地照抄:集合文件是**用户意图**,猜一半比不猜更危险。
 */
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { join, resolve, sep } from "node:path";
import { log } from "../../shared/log.js";
import { PROJECT_ROLES, isProjectRole, type ProjectRole } from "../identity/role.js";
import { mcpDir, isValidServerName } from "./config.js";
/** 一个角色的授权。`deny` 优先于 `allow`(与集合文件同一条)。 */
export interface McpGrantFile {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/** 机器可读状态 —— 与 `ToolSetState` 同规格的三态。 */
export type McpGrantState =
  /** 盘上没有这个角色的授权文件 —— **零授权**(不是错误,也不是「全放行」) */
  | "absent"
  /** 文件形状合法 —— 只有这一种状态会真的授权 */
  | "ok"
  /** 文件在但读不了 / 形状不对 —— **零授权**,且必须可见 */
  | "invalid";

export interface McpGrantResolution {
  readonly role: ProjectRole;
  readonly path: string;
  readonly state: McpGrantState;
  /**
   * 传给求解器的授权。**`absent` 与 `invalid` 都是 `undefined`** ——
   * 两者的效果相同(零授权),但 `problem` 让用户能区分「我没配」与「我配坏了」。
   */
  readonly file: McpGrantFile | undefined;
  readonly problem: string | undefined;
}

/**
 * 某角色的授权文件路径。
 *
 * 与 `toolSetPath` 同一套防线:`role` 先过 `PROJECT_ROLES` 运行期校验,
 * 再做一次目录归属断言。**id 来自闭合注册表**(写面规矩①)是路径穿越的唯一防线,
 * 读面也不能省 —— 它是将来有人把 `role` 从 HTTP 参数透传进来的那一道。
 */
export function grantPath(dataDir: string, role: ProjectRole): string {
  if (!isProjectRole(role)) {
    throw new Error(`未知角色「${String(role)}」—— MCP 授权文件名只能来自 PROJECT_ROLES`);
  }
  const dir = resolve(mcpDir(dataDir));
  const p = resolve(dir, `${role}.json`);
  if (p !== join(dir, `${role}.json`) || !p.startsWith(dir + sep)) {
    throw new Error(`MCP 授权文件路径越出了目录:${p}`);
  }
  return p;
}

type Parsed = { readonly ok: true; readonly file: McpGrantFile } | { readonly ok: false; readonly detail: string };

/**
 * 校验一份授权文件。**两个字段缺一即 invalid**(见文件头)。
 *
 * 名字本身**不在这里校验** —— 它得对着 server 目录才知道存不存在,那是
 * `solve.ts` 的 `unknownServers`(两处职责分开的理由:形状错 = 文件坏;
 * 名字不存在 = 内容与现实不符)。
 */
export function parseGrantFile(raw: unknown): Parsed {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: "顶层必须是一个 JSON 对象" };
  }
  const obj = raw as Record<string, unknown>;
  const allow = obj["allow"];
  const deny = obj["deny"];
  if (!Array.isArray(allow)) {
    return { ok: false, detail: `字段 allow 缺失或不是数组(实际:${describe(allow)})` };
  }
  if (!Array.isArray(deny)) {
    return { ok: false, detail: `字段 deny 缺失或不是数组(实际:${describe(deny)})` };
  }
  const allowOut: string[] = [];
  for (let i = 0; i < allow.length; i++) {
    const v: unknown = allow[i];
    if (typeof v !== "string") return { ok: false, detail: `allow[${i}] 不是字符串(实际:${describe(v)})` };
    allowOut.push(v);
  }
  const denyOut: string[] = [];
  for (let i = 0; i < deny.length; i++) {
    const v: unknown = deny[i];
    if (typeof v !== "string") return { ok: false, detail: `deny[${i}] 不是字符串(实际:${describe(v)})` };
    denyOut.push(v);
  }
  return { ok: true, file: { allow: allowOut, deny: denyOut } };
}

function describe(v: unknown): string {
  if (v === undefined) return "缺失";
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  return typeof v;
}

/** 读一个角色的授权文件。**永不抛异常**(坏 JSON 不该让整个平台起不来)。 */
export function readGrantFile(dataDir: string, role: ProjectRole): McpGrantResolution {
  const path = grantPath(dataDir, role);
  if (!existsSync(path)) {
    return { role, path, state: "absent", file: undefined, problem: undefined };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return invalid(role, path, `读不到文件:${err instanceof Error ? err.message : String(err)}`);
  }
  if (text.trim() === "") {
    return invalid(role, path, "文件是空的(空文件 ≠ 零授权;两者效果一样,但它是你没写完)");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return invalid(role, path, `不是合法 JSON:${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parseGrantFile(raw);
  if (!parsed.ok) return invalid(role, path, parsed.detail);
  return { role, path, state: "ok", file: parsed.file, problem: undefined };
}

function invalid(role: ProjectRole, path: string, detail: string): McpGrantResolution {
  return {
    role,
    path,
    state: "invalid",
    // ⚠️ **不给 file** ⇒ 零授权。方向与 `toolSet.ts` 相反,理由见文件头。
    file: undefined,
    problem:
      `${detail} —— 已退化成**零授权**,这份文件当前**没有生效**。` +
      `方向刻意与工具集合文件相反:集合文件是收窄机制,坏掉退回出厂全集只是回到默认;` +
      `授权文件是增量机制,按「全放行」处置一次笔误就是一次**静默提权**`,
  };
}

/** 五个角色的授权状态(顺序与 `PROJECT_ROLES` 一致)。 */
export function resolveAllGrants(dataDir: string): readonly McpGrantResolution[] {
  return PROJECT_ROLES.map((role) => readGrantFile(dataDir, role));
}

/**
 * 生产接线用的那一份:`RuntimeDeps.mcpFor`。
 *
 * **每次建会话现读盘**,与 `toolSetForDataDir` 同理由:用户改完授权不该需要
 * 重启服务(缓存正是「用户改了没效果」的来源,7-B 的同款)。
 *
 * 坏文件在这里留一行 warn。**这一行是必须的**:授权只在**新建的会话**里生效,
 * 而用户完全可能在服务跑着的时候改坏它 —— 那时既没有启动日志、也未必有人
 * 打开过界面(7-N:失败必须留现场)。
 */
export function mcpForDataDir(dataDir: string): (role: ProjectRole) => McpGrantFile | undefined {
  return (role) => {
    const r = readGrantFile(dataDir, role);
    if (r.state === "invalid") {
      log.warn(
        `mcp: 建会话时授权文件无效 ${role} ← ${r.path} —— 本次**零授权**(没有任何外部工具)\n` +
          `        ${r.problem ?? ""}`,
      );
    }
    return r.file;
  };
}

/**
 * 目录里**存在但不是合法角色名**的 `.json` 文件。
 *
 * 与 `strayToolSetFiles` 同一条纪律:用户很容易把文件写成 `pm.json.bak` 或
 * `roles.json` —— 那份文件会被安静地忽略,而他以为已经生效了。
 * 「落在空处的意图」必须被报出来。
 */
export function strayMcpFiles(dataDir: string): readonly string[] {
  const dir = mcpDir(dataDir);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const known = new Set([
    ...PROJECT_ROLES.map((r) => `${r}.json`),
    // 目录与 secret 两个文件是**平台自己的**,不是「落在空处的意图」。
    "servers.json",
    "secrets.json",
  ]);
  return names
    .filter((n) => {
      if (known.has(n)) return false;
      if (!n.toLowerCase().endsWith(".json")) return false;
      try {
        return statSync(join(dir, n)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}

/**
 * 目录里存在、且**被至少一个角色授权**的角色名清单(HTTP 读面的 `grantedTo`)。
 *
 * 它读的是**授权文件本身**,不是任何内存态 —— 所以这个字段不会说「已授权」
 * 而下一次建会话拿不到。
 */
export function grantedRolesOf(dataDir: string, serverName: string): ProjectRole[] {
  const out: ProjectRole[] = [];
  for (const role of PROJECT_ROLES) {
    const g = readGrantFile(dataDir, role);
    if (g.state === "ok" && g.file !== undefined && g.file.allow.includes(serverName)) out.push(role);
  }
  return out;
}

/** 一条 server 名是否合法(转发给 config 的那一条判据,避免读面各写一张正则)。 */
export { isValidServerName };

// ── 写面(7-O 的四条规矩见 `harness/write.ts` 文件头)──────────────

/** 写面结果。`reason` 与 `WriteResult` 同名同义,好让调用方一处判。 */
export interface GrantWriteResult {
  readonly ok: boolean;
  readonly reason?: "unknown_role" | "backup_failed" | "write_failed";
  readonly detail?: string;
  /** **回读**到的授权(规矩③:报成功 = 真生效) */
  readonly file?: McpGrantFile;
  readonly backupPath?: string;
}

/** 备份保留份数(与 `harness/write.ts` 的 `KEEP_BACKUPS` 同值、同理由)。 */
const KEEP_GRANT_BACKUPS = 10;

function grantBackupDir(dataDir: string): string {
  return join(dataDir, "harness", "backups", "mcp");
}

/**
 * 写一个角色的授权文件。
 *
 * 顺序:**校验 role → 备份 → 原子写(tmp + rename)→ 回读**,任何一步失败都不留半成品。
 * 逐条对应 `harness/write.ts` 的四条规矩:
 *   ① `role` 先过 `PROJECT_ROLES`(路径穿越的唯一防线,在 `grantPath` 里断言)
 *   ② 备份是写的前置,备份失败就不写
 *   ③ 报成功 = 回读磁盘上那份
 *   ④ (本层没有「恢复出厂」—— 删掉授权文件就是零授权,那是用户能直接做的事,
 *      不需要一条会与「清空」语义打架的专用端点)
 */
export function writeGrantFile(
  dataDir: string,
  role: ProjectRole,
  file: McpGrantFile,
  now: number,
): GrantWriteResult {
  if (!isProjectRole(role)) {
    return { ok: false, reason: "unknown_role", detail: `未知角色「${String(role)}」` };
  }
  const target = grantPath(dataDir, role);
  const payload = `${JSON.stringify({ allow: [...file.allow], deny: [...file.deny] }, null, 2)}\n`;

  // ② 备份是写的前置
  let backupPath: string | undefined;
  if (existsSync(target)) {
    const b = backupGrant(dataDir, role, now);
    if (b === null) {
      return {
        ok: false,
        reason: "backup_failed",
        detail: "备份失败,已中止写入(不留没有退路的修改)",
      };
    }
    if (b !== undefined) backupPath = b;
  }

  const tmp = `${target}.tmp`;
  try {
    // ⚠️ 建的是 `harness/mcp`(目标文件所在目录),不是备份目录 ——
    // 备份目录只在真的需要备份时才建。
    mkdirSync(mcpDir(dataDir), { recursive: true });
    writeFileSync(tmp, payload, "utf8");
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败无所谓 */
    }
    return { ok: false, reason: "write_failed", detail: err instanceof Error ? err.message : String(err) };
  }

  // ③ 回读 —— 报成功 = 真生效
  let readBack: string;
  try {
    readBack = readFileSync(target, "utf8");
  } catch (err) {
    return { ok: false, reason: "write_failed", detail: `写后回读失败:${err instanceof Error ? err.message : String(err)}` };
  }
  if (readBack !== payload) {
    return { ok: false, reason: "write_failed", detail: "写后回读的内容与提交的不一致" };
  }
  const parsed = parseGrantFile(JSON.parse(readBack));
  if (!parsed.ok) {
    return { ok: false, reason: "write_failed", detail: `写后回读的内容解析失败:${parsed.detail}` };
  }
  return { ok: true, file: parsed.file, ...(backupPath !== undefined ? { backupPath } : {}) };
}

/** `string` = 路径;`undefined` = 没有东西可备份(首次创建);`null` = 失败。 */
function backupGrant(dataDir: string, role: ProjectRole, now: number): string | null | undefined {
  const src = grantPath(dataDir, role);
  if (!existsSync(src)) return undefined;
  const dir = grantBackupDir(dataDir);
  try {
    mkdirSync(dir, { recursive: true });
    let target = join(dir, `${role}.${now}.bak`);
    let n = 1;
    while (existsSync(target)) target = join(dir, `${role}.${now}.${n++}.bak`);
    writeFileSync(target, readFileSync(src));
    pruneGrantBackups(dataDir, role);
    return target;
  } catch {
    return null;
  }
}

function pruneGrantBackups(dataDir: string, role: ProjectRole): void {
  try {
    const dir = grantBackupDir(dataDir);
    const mine = readdirSync(dir)
      .filter((f) => f.startsWith(`${role}.`) && f.endsWith(".bak"))
      .sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_GRANT_BACKUPS))) {
      rmSync(join(dir, old), { force: true });
    }
  } catch {
    /* 清理失败不影响写入 */
  }
}

/** 列出某角色的授权历史备份(新的在前)—— HTTP 面用。 */
export function listGrantBackups(dataDir: string, role: ProjectRole): Array<{ file: string; path: string }> {
  try {
    return readdirSync(grantBackupDir(dataDir))
      .filter((f) => f.startsWith(`${role}.`) && f.endsWith(".bak"))
      .sort()
      .reverse()
      .map((f) => ({ file: f, path: join(grantBackupDir(dataDir), f) }));
  } catch {
    return [];
  }
}
