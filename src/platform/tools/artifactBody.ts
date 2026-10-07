/**
 * 工具层写工件正文的**唯一落点** —— 「先写文件、后插行」这条顺序纪律的实现处
 * (设计 `docs/DESIGN-WORKSPACE.md` §4.3)。
 *
 * ── 为什么顺序不能反 ────────────────────────────────────────────
 *
 *   · **先写文件、后插行**:最坏只留下一个**孤儿文件** —— 盘上有、索引里没有。
 *     它是可检测的(`GET /api/projects/:id/workspace` 的 `orphanFile`)、可回收的。
 *   · **先插行、后写文件**:写文件失败就得到「**有索引无内容**」—— 行在库里、
 *     `body_path` 指着一个不存在的文件。读面只会说「读不到」,而**没有任何判据**
 *     能把它与「文件被人工删了」区分开;正文永远读不回来。
 *
 * ⇒ 写文件失败必须让这次工具调用失败,并且**一行都不许插**。这条纪律在
 * `board_write` / `ask_client` / `answer` / `meeting_conclude` /
 * `resolveClientQuestion` 五处都成立,所以它只在这里实现一次 ——
 * 抄五遍的纪律在第六处一定会漏。
 *
 * ── 落点由平台生成,**不让模型编路径** ─────────────────────────
 *
 * `artifacts/<artifactId>-<slug>.<ext>`(`html_report` → `.html`,其余 → `.md`)。
 * slug 取标题里的 ASCII 词,去掉之后为空就只留 id —— 中文标题经过 slug 之后
 * 通常是空的,那是**正常**的:可读性排第二,「同一个 id 恒定映射到同一个路径」
 * 排第一(路径要能被索引、被对账、被 `git show` 找回来)。
 */
import { projectWorkspaceRoot } from "../workspace/root.js";
import type { WorkspacePort, WorkspaceResult } from "../workspace/port.js";
import type {
  ArtifactBodyPlacement,
  DeliverableType,
} from "../storage/repo/artifacts.js";
import type { ToolRunContext } from "./types.js";

/** 正文目录(设计 §2 的目录形态)。 */
export const ARTIFACT_BODY_DIR = "artifacts";

/**
 * 装配错误文案 —— **一处写,五处引用**(同一条纪律:同一件事不许有两种说法,
 * 否则模型对同一件事拿到两种解释时,下一步就变成猜)。
 */
export const WORKSPACE_ASSEMBLY_PROBLEM =
  "本次装配没有接上**工作区**(`ToolRunContext.workspace` + `workspaceRoot`)," +
  "所以平台不能把正文写到项目仓里。这是**装配错误**,不是你的参数问题 —— " +
  "2026-10-08 起工件正文**不再住数据库**(它落成项目仓里的一份文件)," +
  "没有工作区就没有落点。请把这件事登记成阻塞(`blocker_open`)让平台修," +
  "不要反复重试同一次调用。";

/** 正文扩展名:唯一按交付物类型分派的一处(`html_report` → `.html`,其余 → `.md`)。 */
export function artifactBodyExtension(type: DeliverableType | null): "html" | "md" {
  return type === "html_report" ? "html" : "md";
}

/**
 * 标题 → slug。**只保留 ASCII 字母数字**,其余折成 `-`。
 *
 * 中文标题会得到空串(调用方按空处理,只留 id),这是刻意的:文件名参与
 * git 历史与跨平台路径,让它可预测比让它好看重要。
 */
export function slugifyTitle(title: string, max = 40): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** 平台生成的正文落点(**项目根相对路径**)。 */
export function artifactBodyPath(input: {
  readonly id: string;
  readonly title: string;
  readonly deliverableType: DeliverableType | null;
}): string {
  const slug = slugifyTitle(input.title);
  const stem = slug === "" ? input.id : `${input.id}-${slug}`;
  return `${ARTIFACT_BODY_DIR}/${stem}.${artifactBodyExtension(input.deliverableType)}`;
}

/** 这次调用可用的工作区能力(端口 + 已算好的项目根)。 */
export interface WorkspaceAccess {
  readonly workspace: WorkspacePort;
  /** 项目根的**绝对路径** —— `WorkspacePort` 的每个方法都要它 */
  readonly projectRoot: string;
}

/**
 * 从 ctx 取工作区。**缺任何一半 ⇒ `null`**(调用方必须如实报装配错误)。
 *
 * 接待会话(`project === null`)也回 `null`:没有项目就没有项目根,
 * 而写正文的工具本来就进不了接待模式的工具面 —— 这是纵深防御。
 */
export function workspaceAccess(ctx: ToolRunContext): WorkspaceAccess | null {
  const { workspace, workspaceRoot, project } = ctx;
  if (workspace === undefined || workspaceRoot === undefined || project === null) return null;
  return { workspace, projectRoot: projectWorkspaceRoot(workspaceRoot, project.id) };
}

/**
 * 非 ctx 调用方(`resolveClientQuestion`)拿到的工作区:端口 + 工作根。
 *
 * 入参写成**可选**是刻意的:`resolveClientQuestion` 的 opts 在类型上是必填的,
 * 但它也能被 JS / 测试直接调用 —— 那时缺装配不该变成一次 `TypeError`
 * (项目纪律:**不要惩罚不携带错误信息的偏差**),而该变成一次可读的拒绝。
 * 所以这里返回 `null`,由调用方翻成结构化失败。
 */
export function accessFromDeps(
  deps: { readonly workspace?: WorkspacePort; readonly workspaceRoot?: string },
  projectId: string,
): WorkspaceAccess | null {
  if (deps.workspace === undefined || deps.workspaceRoot === undefined) return null;
  return {
    workspace: deps.workspace,
    projectRoot: projectWorkspaceRoot(deps.workspaceRoot, projectId),
  };
}

/**
 * 写正文。**成功才返回落点**;失败把 `problem` 原样带出来给模型读。
 *
 * 返回值刻意不是 `ToolResult` —— 这一层不认识 `ok(code, message)` 那套;
 * 调用方(工具)才决定把它翻译成哪种拒绝。翻译只有一句话要说:
 * 「文件没写成 ⇒ 这次调用没落库」。
 */
export function writeArtifactBody(
  access: WorkspaceAccess,
  spec: {
    readonly id: string;
    readonly title: string;
    readonly deliverableType: DeliverableType | null;
    readonly content: string;
  },
): WorkspaceResult<ArtifactBodyPlacement> {
  const path = artifactBodyPath(spec);
  const written = access.workspace.writeAtomic({
    root: access.projectRoot,
    path,
    content: spec.content,
  });
  if (!written.ok) return written;
  return {
    ok: true,
    value: {
      // 用端口回给我们的路径(它归一化过),不是我们自己拼的那个字符串 ——
      // 索引里记的必须是**落盘时那条路径**,不是「我们以为写到的路径」。
      bodyPath: written.value.path,
      bodySha256: written.value.sha256,
      bodyBytes: written.value.bytes,
    },
  };
}

/** 现读正文。读不到 ⇒ `ok: false`(调用方要如实说「读不到」,**不是空正文**)。 */
export function readArtifactBody(
  access: WorkspaceAccess,
  path: string,
): WorkspaceResult<string> {
  return access.workspace.read({ root: access.projectRoot, path });
}
