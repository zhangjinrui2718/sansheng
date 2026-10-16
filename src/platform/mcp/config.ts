/**
 * Sansheng 平台 · MCP · **server 目录**(`<dataDir>/harness/mcp/servers.json`)
 *
 * ── 这一层是什么、为什么它是「人的资产」──────────────────────────
 *
 * 一条 MCP server 定义 = **一条命令或一个出网地址 + 一份凭据**。
 * 谁有权写它,答案只有一个:**人**(HTTP 写面 `POST /api/mcp/servers`)。
 * ⚠️ **它不在任何角色的 `ceiling` 里,也没有对应的平台工具** —— 与
 * `POST /api/artifacts/:id/verdict` 完全同款处置(那是甲方裁决,做成工具就
 * 意味着某个模型能替甲方拍板)。「让平台去执行一条任意命令 / 向任意地址出网」
 * 是同一个量级的决定,同一条处置。
 *
 * 与「授权」那一层(`grants.ts`)的分界是本模块存在的全部理由:
 *
 *   定义(本文件)  谁的资产  人 / HTTP      能扩权(执行什么、连到哪)
 *   授权(grants)   谁能用    agent 可做     不能扩权(只在已定义的名字里开关)
 *
 * ── 为什么落文件而不是建表 ──────────────────────────────────────
 *
 * ① 它**不是组织数据**,是**这台机器的配置** —— 与 `harness/tools/{role}.json`
 *    同一类东西,同一目录树下。
 * ② 加一张表就要挂进 `projects` 的 `ON DELETE CASCADE` 子表族(实测 14 张),
 *    而它与项目**毫无关系**(MCP 是全局的,不按项目分)。
 * ③ 它可以在服务跑着的时候直接编辑 —— 与集合文件同理由,用户改完不必重启。
 *
 * ── 坏文件不许静默 ──────────────────────────────────────────────
 *
 * 与 `resolveToolSet` 同规格:`absent` / `ok` / `invalid` 三态 + `problem`。
 * 方向上同样要注意:这里坏掉的**不是**一次提权(那在 `grants.ts`,方向相反),
 * 而是「一份写着 `!rm -rf …` 的文件没被读」—— 所以处置是**整份不生效**
 * 并把原因报出来,而不是「挑几条能解析的继续用」。
 *
 * ── 两条硬拒绝 ──────────────────────────────────────────────────
 *
 * ① **`env` / `headers` 里以 `!` 开头的值一律拒收。**
 *    pi 的 `!cmd` 语法是「执行这条命令,取它的输出当值」—— 那是一条**任意命令
 *    执行**通道,而且是**用户在配置里就能打开**的。所以本平台只允许 `${VAR}`
 *    引用(由进程环境解析);要注入动态值走 `secrets.ts`(Keyring 加密)。
 * ② **`command` 与 `url` 必须有且只有一个。**
 *    两个都有 = 形状自相矛盾,按哪边算都是猜;猜错的后果是「连到另一个地址」。
 */
import { existsSync, readFileSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 目录文件所在路径(`<dataDir>/harness/mcp`)。 */
export function mcpDir(dataDir: string): string {
  return join(dataDir, "harness", "mcp");
}

/** server 目录文件路径。 */
export function serversPath(dataDir: string): string {
  return join(mcpDir(dataDir), "servers.json");
}

/** server 名的合法字符(pi 的规则:字母 / 数字 / `_` / `-`)。 */
const NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * server 名是否合法。
 *
 * ⚠️ 它同时是**文件名之外的唯一身份**:授权文件里写的、allowlist 里展开成
 * `mcp__<name>__*` 的、pi 那边注册用的,都是这个名字。所以它必须先过这一关 ——
 * 一个带 `/` 或 `.` 的名字会同时污染路径与 `mcp__` 模式。
 */
export function isValidServerName(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 64 && NAME_RE.test(v);
}

/** 一条 server 定义(人的输入,已经过校验)。 */
export interface McpServerDef {
  readonly name: string;
  /** `stdio` = 起一个本地进程;`http` = 连一个远端 MCP 端点 */
  readonly transport: "stdio" | "http";
  /** stdio 专用 */
  readonly command?: string;
  readonly args?: readonly string[];
  /**
   * 进程环境变量。**值只允许 `${VAR}` 引用**(`!command` 被硬拒绝,见文件头 ①)。
   * 明文值走 `secrets.ts`,它在这里被替换进去的位置同样是键 —— 所以
   * 「这个键的明文在哪」只有一个答案。
   */
  readonly env?: Readonly<Record<string, string>>;
  /** http 专用 */
  readonly url?: string;
  /** http 专用。同样只允许 `${VAR}` 引用 / 明文(后者在 secrets 里)。 */
  readonly headers?: Readonly<Record<string, string>>;
  /** 单次请求超时(秒) */
  readonly timeout?: number;
  readonly description?: string;
}

/** 目录文件的形状。 */
export interface McpCatalog {
  readonly servers: readonly McpServerDef[];
  /** 文件状态。`invalid` ⇒ `servers` 必为空(整份不生效) */
  readonly state: "absent" | "ok" | "invalid";
  readonly path: string;
  /** `state === "invalid"` 时非空,必须对用户可见 */
  readonly problem: string | undefined;
}

const EMPTY_CATALOG_STATE = { state: "absent" as const, problem: undefined };

function invalid(path: string, detail: string): McpCatalog {
  return {
    servers: [],
    state: "invalid",
    path,
    problem:
      `${detail} —— 整份 server 目录**没有生效**(没有任何 MCP server 被接上)。` +
      `修好它或删掉它;坏掉的目录不会「挑几条能解析的继续用」`,
  };
}

/** 形状判定结果。 */
type Parsed = { readonly ok: true; readonly servers: McpServerDef[] } | { readonly ok: false; readonly detail: string };

/**
 * 校验一份目录文件。
 *
 * **整份判定**:任何一条 server 不合法 ⇒ 整份 invalid。理由见文件头最后一段 ——
 * 半份生效的目录意味着「你以为接上的和实际接上的不一样」,那比全不生效更难查。
 */
export function parseMcpCatalog(raw: unknown): Parsed {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: "顶层必须是一个 JSON 对象" };
  }
  const obj = raw as Record<string, unknown>;
  const serversRaw = obj["servers"];
  if (serversRaw === null || typeof serversRaw !== "object" || Array.isArray(serversRaw)) {
    return { ok: false, detail: `字段 servers 缺失或不是一个对象(实际:${describe(serversRaw)})` };
  }
  const out: McpServerDef[] = [];
  for (const [name, defRaw] of Object.entries(serversRaw as Record<string, unknown>)) {
    if (!isValidServerName(name)) {
      return {
        ok: false,
        detail:
          `server 名「${name}」不合法 —— 只允许字母、数字、下划线与连字符(pi 的规则)。` +
          `它同时是授权文件里的键与 allowlist 里 \`mcp__<name>__*\` 的名字,所以不能含路径字符`,
      };
    }
    const one = parseServerDef(name, defRaw);
    if (!one.ok) return one;
    out.push(one.def);
  }
  return { ok: true, servers: out };
}

type OneParsed = { readonly ok: true; readonly def: McpServerDef } | { readonly ok: false; readonly detail: string };

function parseServerDef(name: string, raw: unknown): OneParsed {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: `server「${name}」必须是一个 JSON 对象` };
  }
  const o = raw as Record<string, unknown>;
  const command = o["command"];
  const url = o["url"];

  // ② command 与 url 有且只有一个
  const hasCommand = command !== undefined && command !== null;
  const hasUrl = url !== undefined && url !== null;
  if (hasCommand && hasUrl) {
    return {
      ok: false,
      detail: `server「${name}」同时给了 command 与 url —— stdio 与 http 是两种传输,按哪边算都是猜`,
    };
  }
  if (!hasCommand && !hasUrl) {
    return { ok: false, detail: `server「${name}」既没有 command(stdio)也没有 url(http),无法确定传输方式` };
  }
  if (hasCommand && typeof command !== "string") {
    return { ok: false, detail: `server「${name}」的 command 必须是字符串` };
  }
  if (hasUrl && typeof url !== "string") {
    return { ok: false, detail: `server「${name}」的 url 必须是字符串` };
  }

  const transport: "stdio" | "http" = hasUrl ? "http" : "stdio";
  if (transport === "http" && (url as string).trim() === "") {
    return { ok: false, detail: `server「${name}」的 url 是空串` };
  }
  if (transport === "stdio" && (command as string).trim() === "") {
    return { ok: false, detail: `server「${name}」的 command 是空串` };
  }

  const argsRaw = o["args"];
  let args: string[] | undefined;
  if (argsRaw !== undefined && argsRaw !== null) {
    if (!Array.isArray(argsRaw)) {
      return { ok: false, detail: `server「${name}」的 args 必须是字符串数组` };
    }
    const a: string[] = [];
    for (const v of argsRaw) {
      if (typeof v !== "string") return { ok: false, detail: `server「${name}」的 args 里有非字符串项` };
      a.push(v);
    }
    args = a;
  }

  const envP = parseStringMap(o["env"], name, "env");
  if (!envP.ok) return envP;
  const headersP = parseStringMap(o["headers"], name, "headers");
  if (!headersP.ok) return headersP;

  const timeoutRaw = o["timeout"];
  let timeout: number | undefined;
  if (timeoutRaw !== undefined && timeoutRaw !== null) {
    if (typeof timeoutRaw !== "number" || !Number.isFinite(timeoutRaw) || timeoutRaw <= 0) {
      return { ok: false, detail: `server「${name}」的 timeout 必须是正数(秒)` };
    }
    timeout = timeoutRaw;
  }

  const descRaw = o["description"];
  if (descRaw !== undefined && descRaw !== null && typeof descRaw !== "string") {
    return { ok: false, detail: `server「${name}」的 description 必须是字符串` };
  }

  return {
    ok: true,
    def: {
      name,
      transport,
      ...(transport === "stdio" ? { command: command as string } : {}),
      ...(args !== undefined ? { args } : {}),
      ...(envP.value !== undefined ? { env: envP.value } : {}),
      ...(transport === "http" ? { url: url as string } : {}),
      ...(headersP.value !== undefined ? { headers: headersP.value } : {}),
      ...(timeout !== undefined ? { timeout } : {}),
      ...(typeof descRaw === "string" && descRaw !== "" ? { description: descRaw } : {}),
    },
  };
}

/**
 * `env` / `headers` 的逐项判定。
 *
 * ⚠️ **`!` 开头的值被硬拒绝**(文件头 ①):pi 的 `!cmd` 是「执行这条命令并取其
 * 输出」。它是配置里就能打开的任意命令执行通道,而且**平台无法在求解期知道
 * 它会执行什么** —— 所以这里连收都不收,给可执行的处置而不是一句「不支持」。
 */
function parseStringMap(
  raw: unknown,
  serverName: string,
  field: "env" | "headers",
): { ok: true; value: Record<string, string> | undefined } | { ok: false; detail: string } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: `server「${serverName}」的 ${field} 必须是一个对象` };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) {
      return { ok: false, detail: `server「${serverName}」的 ${field} 键「${k}」不合法(只允许环境变量名那种字符)` };
    }
    if (typeof v !== "string") {
      return { ok: false, detail: `server「${serverName}」的 ${field} 键「${k}」的值必须是字符串` };
    }
    if (v.startsWith("!")) {
      return {
        ok: false,
        detail:
          `server「${serverName}」的 ${field}.${k} 以 "!" 开头 —— pi 的 "!<命令>" 语法会**执行这条命令**并取它的输出,` +
          `那是配置里就能打开的任意命令执行通道,平台一律不收。` +
          `要注入动态值请用 PUT /api/mcp/servers/${serverName}/secrets(走 Keyring 加密),` +
          `或改成 \${VAR} 引用进程里已有的环境变量`,
      };
    }
    out[k] = v;
  }
  return { ok: true, value: out };
}

function describe(v: unknown): string {
  if (v === undefined) return "缺失";
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  return typeof v;
}

/** 读目录文件。**永不抛异常** —— 与 `resolveToolSet` 同一条理由(坏 JSON 不该让平台起不来)。 */
export function resolveMcpCatalog(dataDir: string): McpCatalog {
  const path = serversPath(dataDir);
  if (!existsSync(path)) return { servers: [], path, ...EMPTY_CATALOG_STATE };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return invalid(path, `读不到文件:${err instanceof Error ? err.message : String(err)}`);
  }
  if (text.trim() === "") {
    return invalid(path, "文件是空的(空文件 ≠ 空目录;要清空请写 { \"servers\": {} })");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return invalid(path, `不是合法 JSON:${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = parseMcpCatalog(raw);
  if (!parsed.ok) return invalid(path, parsed.detail);
  return { servers: parsed.servers, state: "ok", path, problem: undefined };
}

/** 目录里的 server 名(顺序 = 文件里的顺序;读面用它回灌「可用名」)。 */
export function catalogNames(catalog: McpCatalog): string[] {
  return catalog.servers.map((s) => s.name);
}

/**
 * 目录里是否存在这个 server。
 *
 * ⚠️ **它只在 `state === "ok"` 时为真。** 坏掉的目录里不存在任何 server ——
 * `mcp_grant` 因此会拒绝并列出「可用名」,而那一列会是空的并说明原因。
 */
export function hasServer(catalog: McpCatalog, name: string): boolean {
  return catalog.state === "ok" && catalog.servers.some((s) => s.name === name);
}

/**
 * 目录里存在、且**被至少一个角色授权**的角色名清单(读面 `grantedTo`)。
 *
 * ⚠️ **它住在 `grants.ts` 而不是本文件** —— 本文件是 `grants.ts` 的依赖
 * (`mcpDir` / `isValidServerName` / `serversPath`),反过来再 import 一次就成了一条
 * 加载环。读面从 `grants.ts` 的 `grantedRolesOf()` 取。
 */

/** 写面结果(与 `grants.ts` 的 `GrantWriteResult` 同形状,理由见那里)。 */
export interface CatalogWriteResult {
  readonly ok: boolean;
  readonly reason?: "backup_failed" | "write_failed";
  readonly detail?: string;
  /** **回读**到的目录(规矩③) */
  readonly catalog?: McpCatalog;
  readonly backupPath?: string;
}

const KEEP_CATALOG_BACKUPS = 10;

function catalogBackupDir(dataDir: string): string {
  return join(dataDir, "harness", "backups", "mcp");
}

/**
 * 写 server 目录(整体替换)。四规矩见 `harness/write.ts` 文件头。
 *
 * ⚠️ 目录文件**不加密**、权限是普通的 0644 —— secret 不在它里面(在
 * `secrets.json`,那个才是 0600)。合成一个文件的话,「看一眼配置」也得 root。
 */
export function writeMcpCatalog(dataDir: string, catalog: McpCatalog, now: number): CatalogWriteResult {
  const path = serversPath(dataDir);
  const entries: Record<string, unknown> = {};
  for (const s of catalog.servers) entries[s.name] = toCatalogEntry(s);
  const payload = `${JSON.stringify({ servers: entries }, null, 2)}\n`;

  let backupPath: string | undefined;
  if (existsSync(path)) {
    const b = backupCatalog(dataDir, now);
    if (b === null) {
      return { ok: false, reason: "backup_failed", detail: "备份失败,已中止写入(不留没有退路的修改)" };
    }
    if (b !== undefined) backupPath = b;
  }

  const tmp = `${path}.tmp`;
  try {
    mkdirSync(mcpDir(dataDir), { recursive: true });
    writeFileSync(tmp, payload, "utf8");
    renameSync(tmp, path);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败无所谓 */
    }
    return { ok: false, reason: "write_failed", detail: err instanceof Error ? err.message : String(err) };
  }

  const readBack = resolveMcpCatalog(dataDir);
  if (readBack.state !== "ok") {
    return { ok: false, reason: "write_failed", detail: `写后回读失败:${readBack.problem ?? "未知原因"}` };
  }
  return { ok: true, catalog: readBack, ...(backupPath !== undefined ? { backupPath } : {}) };
}

function backupCatalog(dataDir: string, now: number): string | null | undefined {
  const src = serversPath(dataDir);
  if (!existsSync(src)) return undefined;
  const dir = catalogBackupDir(dataDir);
  try {
    mkdirSync(dir, { recursive: true });
    let t = join(dir, `servers.${now}.bak`);
    let n = 1;
    while (existsSync(t)) t = join(dir, `servers.${now}.${n++}.bak`);
    writeFileSync(t, readFileSync(src));
    const mine = readdirSync(dir)
      .filter((f) => f.startsWith("servers.") && f.endsWith(".bak"))
      .sort();
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_CATALOG_BACKUPS))) {
      rmSync(join(dir, old), { force: true });
    }
    return t;
  } catch {
    return null;
  }
}

/**
 * 一条 server 定义 → 落进 `servers.json` 的那一块(**去掉 name**,因为键就是名字)。
 *
 * 写面用它造请求体;它**不含**明文 secret(secret 只经 `secrets.ts`)。
 */
export function toCatalogEntry(def: McpServerDef): Record<string, unknown> {
  return {
    ...(def.command !== undefined ? { command: def.command } : {}),
    ...(def.args !== undefined ? { args: [...def.args] } : {}),
    ...(def.env !== undefined ? { env: { ...def.env } } : {}),
    ...(def.url !== undefined ? { url: def.url } : {}),
    ...(def.headers !== undefined ? { headers: { ...def.headers } } : {}),
    ...(def.timeout !== undefined ? { timeout: def.timeout } : {}),
    ...(def.description !== undefined ? { description: def.description } : {}),
  };
}
