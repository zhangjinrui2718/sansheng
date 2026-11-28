/**
 * 自己的工具 · 扫描与校验(`harness/ownTools.ts`)—— **仓库就是真相**
 *
 * ── 背景(用户原话 2026-11-28)────────────────────────────────────
 *
 * 「给工程师、质检员、研究员两类专属的 harness 内容 …… 一个独立的代码仓库,
 * 这个代码仓库他可以自己开发 tools 或者 mcp 放进去,他能够根据要经常解决的问题
 * 或者职责,去拓宽自己的能力。」与裁决:「自己的 rag 和代码仓库不需要我放行」。
 *
 * ── 一个工具长什么样 ────────────────────────────────────────────
 *
 *   <工作目录>/roles/<角色>/
 *   ├── README.md                 ← 平台写:这个仓库是什么、怎么放
 *   └── tools/
 *       └── <名字>/
 *           ├── SKILL.md          ← 说明书(必需):什么时候用、怎么用
 *           ├── ……               ← 可选的脚本、数据
 *           └── mcp.json          ← 可选:有它 = 这是一个 MCP 服务(平台来启动)
 *
 * 「说明 + 脚本」类(`skill`):平台每轮把已启用的列在角色面前,他要用时读 `SKILL.md`,
 * 脚本用他自己已有的跑命令能力执行。**没有任何新进程由平台启动。**
 * 「MCP 服务」类(`mcp`):平台在**他自己的**会话里启动它,工具从下一轮起出现在
 * 他的工具面上(`mcp/solve.ts` 多这一个来源)。
 *
 * ── 判据只有一处 ───────────────────────────────────────────────
 *
 * 「有哪些工具、合不合法」**全部由扫仓库得出**(`scanOwnTools`),没有任何一张
 * 「工具登记表」会与仓库漂开。人唯一的动作是停用(`storage/repo/agentTools.ts`),
 * 停用只过滤、不改写扫描结果。
 *
 * ── 格式不对不等于没有 ──────────────────────────────────────────
 *
 * 缺说明书、`mcp.json` 不合法 —— 这些**如实报出原因**(`problem`),既给他下一轮的
 * 上下文(好去修),也给人读面(看得见)。悄悄跳过 = 一个静默失效的工具。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseMcpCatalog, type McpServerDef } from "../mcp/config.js";
import { PROJECT_ROLES, ROLE_SPECS, type ProjectRole } from "../identity/role.js";

/** 仓库里放工具的目录(相对仓库根)。 */
export const OWN_TOOLS_DIR = "tools";
/** 说明书文件名。 */
export const OWN_SKILL_FILE = "SKILL.md";
/** MCP 服务声明文件名。 */
export const OWN_MCP_FILE = "mcp.json";
/** 自己的 MCP 服务在 pi 侧的名字前缀 —— 与人登记的目录(`servers.json`)不撞名。 */
export const OWN_MCP_PREFIX = "own";

/**
 * 工具目录名:字母 / 数字开头,之后允许 `_` 与 `-`,最长 48。
 *
 * 它同时是 `agent_tool_disables.tool_name`、pi 侧 server 名的一段
 * (`own-<角色>-<名字>`)—— 所以不许有 `.`、`/`、空格与中文。
 */
export const OWN_TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

/** 说明书 frontmatter 里 `description` 的上限(与 SDK 的技能规格同一个数)。 */
const DESCRIPTION_MAX = 1024;

/** 算文件数时跳过的目录(依赖与缓存不是工具的「内容」)。 */
const SKIP_DIRS = new Set(["node_modules", ".venv", "venv", "__pycache__", ".git", ".mypy_cache", ".pytest_cache"]);

export type OwnToolKind = "skill" | "mcp";

/** 一条合法的 MCP 服务声明(已经过 `validateOwnMcp`)。 */
export interface OwnMcpDef {
  readonly def: McpServerDef;
}

export interface OwnToolScan {
  readonly name: string;
  readonly kind: OwnToolKind;
  /** 说明书里的 `description`;读不到时为空串(此时 `problem` 一定非空)。 */
  readonly description: string;
  /** 工具目录的绝对路径。 */
  readonly dir: string;
  /** `null` = 合法可用;否则是一句**可执行**的原因。 */
  readonly problem: string | null;
  /** 只在 `kind === "mcp"` 且 `problem === null` 时有。 */
  readonly mcp?: OwnMcpDef;
  /** 工具目录下的文件数(不含依赖与缓存目录)。 */
  readonly fileCount: number;
}

export interface OwnRepoScan {
  /** 仓库根的绝对路径。 */
  readonly root: string;
  /** `ready` = 目录在;`missing` = 目录不存在(从没建过,或工作目录配置变了)。 */
  readonly state: "ready" | "missing";
  readonly tools: readonly OwnToolScan[];
}

/**
 * 这个角色有没有自己的仓库。
 *
 * **判据 = ceiling 里有没有 `own.write`** —— 与授权用同一份事实,不另写一张角色表
 * (写死一张「哪些角色有仓库」的名单,在角色集变化时会静默漏掉新角色)。
 */
export function ownsRepo(role: ProjectRole): boolean {
  return ROLE_SPECS[role].ceiling.includes("own.write");
}

/** 有自己仓库的全部角色(宿主启动时按它建仓)。 */
export const OWN_REPO_ROLES: readonly ProjectRole[] = PROJECT_ROLES.filter(ownsRepo);

/**
 * 这个角色能不能提交 MCP 服务。
 *
 * 判据 = ceiling 里有没有 `code.exec`:**能跑命令的人才试跑得了**它。没有的人
 * (质检)写了 `mcp.json` 记为格式不对 —— 平台不会替他启动一个他从没跑通过的进程。
 */
export function canRunOwnMcp(role: ProjectRole): boolean {
  return ROLE_SPECS[role].ceiling.includes("code.exec");
}

// ── 解析(纯函数)────────────────────────────────────────────────

export type SkillMeta = { readonly ok: true; readonly name: string; readonly description: string } |
  { readonly ok: false; readonly problem: string };

/**
 * 解析 `SKILL.md` 的 frontmatter。
 *
 * 只认最简单的 `key: value` 行(与 SDK 技能规格同款字段)。**工具的名字 = 目录名**,这是
 * 唯一的事实来源(停用记录、pi 侧的 server 名都按它记)—— frontmatter 里写不写 `name`
 * 都不管,写了也不改名字(两处都能定名字,就一定会漂)。
 * `description` **必需**:它就是平台每轮列给角色看的那一句,没有它这个工具等于不存在。
 */
export function parseSkillFrontmatter(text: string, dirName: string): SkillMeta {
  const norm = text.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(norm);
  if (m === null) {
    return { ok: false, problem: "SKILL.md 开头缺 frontmatter —— 第一行应是 `---`,然后是 `description: 一句话`,再一行 `---`" };
  }
  const fields = new Map<string, string>();
  for (const line of (m[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (key !== "" && value !== "") fields.set(key, value);
  }
  const description = fields.get("description") ?? "";
  if (description === "") {
    return { ok: false, problem: "SKILL.md 缺 `description` —— 写一行「这个工具什么时候用」,平台靠它决定什么时候把你引到这个工具上" };
  }
  if (description.length > DESCRIPTION_MAX) {
    return { ok: false, problem: `SKILL.md 的 description 太长(${description.length} > ${DESCRIPTION_MAX} 字符)—— 压成一两句话` };
  }
  return { ok: true, name: dirName, description };
}

export type McpCheck = { readonly ok: true; readonly def: McpServerDef } | { readonly ok: false; readonly problem: string };

/**
 * 校验一份 `mcp.json`(一个工具目录里的那一份,形状 = 一条 server 定义)。
 *
 * 复用人的目录那一套校验(`parseMcpCatalog`:command / args / env 的形状、`!cmd` 硬拒绝),
 * 另加三条 —— 它们是「这份声明是模型写的」带来的:
 *   ① 只许 stdio(有 `url` 就是一个出网地址 —— 那是人的目录里才有的东西);
 *   ② 不许 `headers`;
 *   ③ `env` 的值不许引用 `${变量}` —— 自己的服务不带凭据;需要密钥的工具走人登记的那条路。
 * 外加一条按角色的:提交者得能跑命令(`canRunOwnMcp`)。
 */
export function validateOwnMcp(raw: unknown, opts: { readonly canExec: boolean }): McpCheck {
  if (!opts.canExec) {
    return {
      ok: false,
      problem: "你没有跑命令的能力,试跑不了 MCP 服务 —— 这个工具只保留说明与脚本部分即可:删掉 mcp.json。需要能跑的工具,提一条工作项请工程师做。",
    };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, problem: "mcp.json 必须是一个 JSON 对象" };
  }
  const obj = raw as Record<string, unknown>;
  const parsed = parseMcpCatalog({ servers: { own: raw } });
  if (!parsed.ok) {
    return { ok: false, problem: `mcp.json 不合法:${parsed.detail}` };
  }
  const def = parsed.servers[0];
  if (def === undefined) return { ok: false, problem: "mcp.json 不合法:解析不出 server 定义" };
  if (def.transport === "http" || obj["url"] !== undefined) {
    return { ok: false, problem: "mcp.json 里不许有 `url` —— 自己的 MCP 服务只能是本地进程(stdio:给 command 与 args)" };
  }
  if (obj["headers"] !== undefined) {
    return { ok: false, problem: "mcp.json 里不许有 `headers`" };
  }
  for (const [k, v] of Object.entries(def.env ?? {})) {
    if (v.includes("${")) {
      return { ok: false, problem: `mcp.json 的 env.${k} 引用了环境变量(\`\${…}\`)—— 自己的服务不带凭据;需要密钥的工具请走人登记的 MCP 目录` };
    }
  }
  return { ok: true, def };
}

/** 自己的 MCP 服务在 pi 侧的 server 名:`own-<角色>-<工具名>`(pi 把 `-` 换成 `_`)。 */
export function ownMcpServerName(role: string, toolName: string): string {
  return `${OWN_MCP_PREFIX}-${role}-${toolName}`;
}

// ── 扫描(薄 IO)─────────────────────────────────────────────────

function countFiles(dir: string): number {
  let n = 0;
  let ents;
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of ents) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) n += countFiles(join(dir, e.name));
    } else {
      n += 1;
    }
  }
  return n;
}

function readText(p: string): string | null {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

type JsonLoad = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly problem: string };

/** 读一份 JSON 文件。读不到、解析不了都落成一句原因(文件名写死为自己的那份声明)。 */
function readJson(p: string): JsonLoad {
  const text = readText(p);
  if (text === null) return { ok: false, problem: `${basename(p)} 读不到(不是文件,或没有读权限)` };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, problem: `${basename(p)} 不是合法的 JSON:${err instanceof Error ? err.message : String(err)}` };
  }
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 扫一个仓库,列出里面的工具与每一条的状态。
 *
 * **不抛**:读不到的文件、坏掉的 JSON 都落成那一条的 `problem`。仓库目录不在 ⇒
 * `state: "missing"` 且 `tools: []` —— 调用方必须把「读不到」与「没有工具」分开说。
 */
export function scanOwnTools(root: string, opts: { readonly canExec: boolean }): OwnRepoScan {
  const toolsDir = join(root, OWN_TOOLS_DIR);
  // 仓库目录本身在不在,决定 state;tools/ 不存在只是「还没有工具」。
  if (!isDirectory(toolsDir)) {
    return { root, state: existsSync(root) ? "ready" : "missing", tools: [] };
  }
  let ents;
  try {
    ents = readdirSync(toolsDir, { withFileTypes: true });
  } catch {
    return { root, state: "ready", tools: [] };
  }
  const out: OwnToolScan[] = [];
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = join(toolsDir, e.name);
    if (!OWN_TOOL_NAME_RE.test(e.name)) {
      out.push({
        name: e.name, kind: "skill", description: "", dir,
        problem: `目录名「${e.name}」不合法 —— 只能用字母、数字、\`-\`、\`_\`,且以字母或数字开头(改名后自动生效)`,
        fileCount: countFiles(dir),
      });
      continue;
    }
    const skill = parseSkillFrontmatter(readText(join(dir, OWN_SKILL_FILE)) ?? "", e.name);
    const hasMcp = existsSync(join(dir, OWN_MCP_FILE));
    let problem: string | null = skill.ok ? null : skill.problem;
    let mcp: OwnMcpDef | undefined;
    if (hasMcp) {
      const json = readJson(join(dir, OWN_MCP_FILE));
      if (!json.ok) {
        problem = json.problem;
      } else {
        const check = validateOwnMcp(json.value, opts);
        if (check.ok) mcp = { def: check.def };
        else problem = check.problem;
      }
    }
    out.push({
      name: e.name,
      kind: hasMcp ? "mcp" : "skill",
      description: skill.ok ? skill.description : "",
      dir,
      problem,
      ...(mcp !== undefined ? { mcp } : {}),
      fileCount: countFiles(dir),
    });
  }
  return { root, state: "ready", tools: out };
}
