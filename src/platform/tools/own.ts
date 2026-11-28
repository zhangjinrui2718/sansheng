/**
 * 自己的仓库工具:own_read / own_write(migration 040,2026-11-28)
 *
 * ── 它们只够得着一个地方 ────────────────────────────────────────
 *
 *   <工作目录>/roles/<调用者的角色>/
 *
 * 路径经 `WorkspacePort.resolveInside` 限定在那个根之内(绝对路径、`..`、软链逃逸
 * 一律拒)。于是:
 *
 *   · 研究员不必再靠 shell 重定向往自己仓库里写文件 ——「不产出产品代码」(无
 *     `code.write`)这条边界原样成立;
 *   · 质检能写自己的仓库,而**读不到、更改不了被审的产出** ——「质检不碰代码」只开
 *     这一个口子,它仍然没有 `code.*`。
 *
 * ⚠️ 这不是沙箱:`code.exec` 里的 `bash` 本来就够得着盘上任何文件(`identity/role.ts`
 * 写明了那条边界是「表达意图的」)。这两个工具的意思是「**有一对够用且被限定范围的
 * 读写口**」,轨迹里看得见(`turn_events` 记每次调用),不是「别的路都被堵上了」。
 *
 * ── 写完当场告诉它成没成 ────────────────────────────────────────
 *
 * 写的是 `tools/<名字>/…` 时,`own_write` 会**立刻扫一遍那个工具**并把结果回给模型:
 * 合法的说明类工具「下一轮起列在你面前」;MCP 服务「下一轮起出现在工具面上」;格式
 * 不对就把原因说清。没有这一句,模型要等到下一轮才发现自己写的说明书缺了
 * `description` —— 而下一轮它只会看到一条不认识的提示。
 */
import { Type } from "@sinclair/typebox";
import { sep } from "node:path";
import { agentWorkspaceRoot } from "../workspace/root.js";
import { canRunOwnMcp, OWN_TOOLS_DIR, scanOwnTools } from "../harness/ownTools.js";
import { listDisabledOwnTools } from "../storage/repo/agentTools.js";
import {
  fail, ok, requireString,
  type PlatformTool, type ToolResult, type ToolRunContext,
} from "./types.js";

/** 单次写入的字符上限。经验与说明书、小脚本都远用不到;大数据集不该经工具参数进仓。 */
const WRITE_MAX = 200 * 1024;
/** 单次读取的字符上限(提示词预算)。 */
const READ_MAX = 40_000;

type OwnAccess = { readonly ok: true; readonly root: string } | { readonly ok: false; readonly result: ToolResult };

/** 自己仓库的根。装配缺一半(没有 `workspace` / `workspaceRoot`)⇒ 如实报装配错误。 */
function ownAccess(ctx: ToolRunContext, toolName: string): OwnAccess {
  if (ctx.workspace === undefined || ctx.workspaceRoot === undefined) {
    return {
      ok: false,
      result: fail("internal", `工具「${toolName}」需要工作区,而这次运行没有装配它 —— 你的仓库此刻读不到也写不了。`),
    };
  }
  return { ok: true, root: agentWorkspaceRoot(ctx.workspaceRoot, ctx.agent.role) };
}

/**
 * 把模型给的路径翻成「仓库根相对路径」。
 *
 * 模型很可能直接贴绝对路径(上下文里给的就是绝对路径)—— `resolveInside` 对绝对路径
 * 一律拒;这里先把「根自己」剥掉,其余照旧交给端口判越界。
 */
function relativeTo(root: string, p: string): string {
  const trimmed = p.trim();
  return trimmed.startsWith(`${root}${sep}`) ? trimmed.slice(root.length + 1) : trimmed;
}

/** 写进 `.git/` 里等于直接改版本库内部 —— 那不是「我的文件」,拒。 */
function isGitInternal(rel: string): boolean {
  return rel === ".git" || rel.startsWith(`.git${sep}`) || rel.startsWith(".git/");
}

function resolveOwn(ctx: ToolRunContext, root: string, rawPath: string, toolName: string): { readonly ok: true; readonly abs: string; readonly rel: string } | { readonly ok: false; readonly result: ToolResult } {
  const rel = relativeTo(root, rawPath);
  const r = ctx.workspace?.resolveInside({ root, path: rel });
  if (r === undefined || !r.ok) {
    return {
      ok: false,
      result: fail(
        "denied",
        `路径不在你的仓库里:${r === undefined ? "工作区没有装配" : r.problem}。` +
          `你的仓库是 \`${root}\`,path 写它下面的相对路径(例如 \`${OWN_TOOLS_DIR}/<名字>/SKILL.md\`)。`,
      ),
    };
  }
  return { ok: true, abs: r.value.abs, rel: r.value.path };
}

const ownRead: PlatformTool = {
  name: "own_read",
  capability: "own.read",
  description:
    "读**你自己仓库**里的一个文件(`<工作目录>/roles/<你的角色>/` 之下)。" +
    "读你自己工具的 `SKILL.md` 说明书、以前写过的脚本与资料都用它。" +
    "**只够得着自己的仓库**:项目里的文件用 read / board_read,读不到的不在这里。" +
    `一次最多读 ${READ_MAX} 个字符,超出截断并注明。`,
  parameters: Type.Object({
    path: Type.String({ description: "仓库根相对路径,例如 tools/<名字>/SKILL.md(贴绝对路径也认)" }),
  }),
  run(args, ctx): ToolResult {
    const p = requireString(args, "path");
    if (!p.ok) return p.result;
    const access = ownAccess(ctx, "own_read");
    if (!access.ok) return access.result;
    const at = resolveOwn(ctx, access.root, p.value, "own_read");
    if (!at.ok) return at.result;
    const r = ctx.workspace?.read({ root: access.root, path: at.rel });
    if (r === undefined || !r.ok) {
      return fail("not_found", `读不到 \`${at.rel}\`:${r === undefined ? "工作区没有装配" : r.problem}。核对一遍路径与目录名拼写。`);
    }
    if (r.value.length > READ_MAX) {
      return ok(
        `⚠️ 文件共 ${r.value.length} 字符,只读了前 ${READ_MAX} 个 —— 要后面的部分,把文件拆小再读。\n\n${r.value.slice(0, READ_MAX)}`,
      );
    }
    return ok(r.value);
  },
};

const ownWrite: PlatformTool = {
  name: "own_write",
  capability: "own.write",
  description:
    "往**你自己仓库**里写一个文件(整份覆盖;父目录按需建)。" +
    "一个工具一个目录:`tools/<名字>/SKILL.md` 是说明书(frontmatter 里必须有 `description`)," +
    "可带脚本与数据;多放一个 `mcp.json`(command / args)它就是一个 MCP 服务。" +
    "**只够得着自己的仓库** —— 项目里的文件不在这里写。" +
    `单个文件最多 ${WRITE_MAX} 个字符。写的是 \`tools/<名字>/…\` 时会当场告诉你这个工具现在合不合法。`,
  parameters: Type.Object({
    path: Type.String({ description: "仓库根相对路径,例如 tools/<名字>/SKILL.md" }),
    content: Type.String({ description: "文件全文" }),
  }),
  run(args, ctx): ToolResult {
    const p = requireString(args, "path");
    if (!p.ok) return p.result;
    const content = requireString(args, "content");
    if (!content.ok) return content.result;
    if (content.value.length > WRITE_MAX) {
      return fail("invalid_args", `content 太长(${content.value.length} > ${WRITE_MAX} 字符)—— 拆成几个文件,或把大数据放进项目工作目录用别的办法处理。`);
    }
    const access = ownAccess(ctx, "own_write");
    if (!access.ok) return access.result;
    const at = resolveOwn(ctx, access.root, p.value, "own_write");
    if (!at.ok) return at.result;
    if (isGitInternal(at.rel)) {
      return fail("denied", "不许往 `.git/` 里写 —— 那是版本库内部,不是你的文件。");
    }
    const r = ctx.workspace?.writeAtomic({ root: access.root, path: at.rel, content: content.value });
    if (r === undefined || !r.ok) {
      return fail("internal", `写不进 \`${at.rel}\`:${r === undefined ? "工作区没有装配" : r.problem}`);
    }
    const head = `已写入 \`${at.rel}\`(${r.value.bytes} 字节)。`;
    const feedback = toolFeedback(ctx, access.root, at.rel);
    return ok(feedback === null ? head : `${head}\n${feedback}`);
  },
};

/**
 * 写的是某个工具目录里的文件 ⇒ 扫一遍,回一句它的现状。不是工具目录 ⇒ `null`。
 *
 * 判据来自 `scanOwnTools`(仓库就是真相)与停用记录(人踩的刹车)—— 这里不另判。
 */
function toolFeedback(ctx: ToolRunContext, root: string, rel: string): string | null {
  const parts = rel.split(sep);
  if (parts[0] !== OWN_TOOLS_DIR || parts.length < 3) return null;
  const name = parts[1] ?? "";
  const tool = scanOwnTools(root, { canExec: canRunOwnMcp(ctx.agent.role) }).tools.find((t) => t.name === name);
  if (tool === undefined) return null;
  const disabled = listDisabledOwnTools(ctx.db, ctx.agent.id).includes(name);
  const brake = disabled ? "\n⚠️ 甲方停用了这个工具 —— 你改它不会让它重新生效;要恢复得由甲方在界面上操作。" : "";
  if (tool.problem !== null) {
    return `⚠️ 工具 \`${name}\` 现在不可用:${tool.problem}${brake}`;
  }
  const usable = tool.kind === "mcp"
    ? `MCP 服务 \`${name}\` 合法:**从你的下一轮起**,它的工具会出现在你的工具面上(名字形如 \`mcp__own_${ctx.agent.role.replace(/-/g, "_")}_${name}__*\`)。这一轮先自己用命令行把它跑起来试一次。`
    : `工具 \`${name}\` 现在可用:下一轮起会列在你面前,要用时读 \`tools/${name}/SKILL.md\`。`;
  return `${usable}${brake}`;
}

export const OWN_TOOLS: readonly PlatformTool[] = [ownRead, ownWrite];
