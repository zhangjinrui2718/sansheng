/**
 * 项目工作区根目录 —— **一处**算式(设计 `docs/DESIGN-WORKSPACE.md` §2, P0)
 *
 * `root = <工作根>/projects/<projectId>`。抽成纯函数是为了让它**可测**:
 * 路径拼接写错时(`projects` 少一个 s、把 projectId 拼成文件名)读面会返回
 * 一个「不存在的目录」,而那在 `runtime: "unavailable"` 与「这个项目还没有目录」
 * 之间长得一模一样 —— 靠肉眼看一条端点的输出分辨不出来。
 *
 * ⚠️ **这条算式现在有写侧的读者了**(2026-10-08,设计 §2/§6 第 9 步落地):
 * `host/serve.ts` 的 `sessionCwd()` **无条件**用它算会话 cwd(`isolateProjectCwd`
 * 开关已随「老数据不要」一起删),立项建仓、回合边界提交与 `work/<workId>/` 也都在
 * 这个根下面。接待会话(`projectId === null`)仍留在工作根、**不建仓**。
 *
 * `resolve` 而不是 `join`:读面承诺 `root` 是**绝对路径**(`WorkspaceView.root`),
 * 而 `settings.cwd` 在配置里可以是相对的。
 */
import { resolve } from "node:path";

export function projectWorkspaceRoot(workRoot: string, projectId: string): string {
  return resolve(workRoot, "projects", projectId);
}

/**
 * **角色自己的仓库**根目录 —— `<工作根>/roles/<role>`(migration 040,2026-11-28)
 *
 * 用户原话:「他可以有一个独立的代码仓库,这个代码仓库他可以自己开发 tools 或者
 * mcp 放进去」。它是 harness 内容(属于**这一个角色**、跨项目留着),不属于任何项目 ——
 * 所以与 `projects/` 平级,是**第二个根**,不嵌在项目仓里:
 *
 *   · 嵌在项目仓里 ⇒ `git add -A` 会把它记成一条 gitlink(设计 §5 记过这个坑);
 *   · 放数据目录的 `harness/` 下 ⇒ 会被 harness 仓库的 `commitAll` 整体吞进去,
 *     且 `/api/harness/restore` 能改写里面任意路径 —— 那等于绕过「看得见、停得了」;
 *   · 放工作根下 ⇒ 甲方在文件系统里看得见(设置页「工作目录」管得到),git 历史就是
 *     「他什么时候加了什么」的记录。
 *
 * ⚠️ 这是 `docs/DESIGN-WORKSPACE.md`「按项目分,不按角色分」那条裁决的**唯一例外**:
 * 那条说的是**项目的文件**(多个角色往同一个项目输出目录写各自的章节);这里放的是
 * 角色自己的工具箱,项目里的活一件都不落在这里。
 *
 * `resolve` 而不是 `join`:与 `projectWorkspaceRoot` 同一条理由(读面承诺绝对路径)。
 */
export function agentWorkspaceRoot(workRoot: string, role: string): string {
  return resolve(workRoot, "roles", role);
}
