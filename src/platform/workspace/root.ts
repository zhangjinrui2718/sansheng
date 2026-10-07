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
