/**
 * 项目工作区根目录 —— **一处**算式(设计 `docs/DESIGN-WORKSPACE.md` §2, P0)
 *
 * `root = <工作根>/projects/<projectId>`。抽成纯函数是为了让它**可测**:
 * 路径拼接写错时(`projects` 少一个 s、把 projectId 拼成文件名)读面会返回
 * 一个「不存在的目录」,而那在 `runtime: "unavailable"` 与「这个项目还没有目录」
 * 之间长得一模一样 —— 靠肉眼看一条端点的输出分辨不出来。
 *
 * ⚠️ **P0 只读。** 这个函数**不建目录**、不改任何会话的 `cwd` ——
 * `host/serve.ts` 的 `sessionCwd()`(P1 才动它)仍然按 `isolateProjectCwd`
 * 决定会话落在工作根还是项目目录里。两者今天可以指向同一个目录,但**语义不同**:
 * 一个是「会话在哪建」,一个是「观测面看哪里」。
 *
 * `resolve` 而不是 `join`:读面承诺 `root` 是**绝对路径**(`WorkspaceView.root`),
 * 而 `settings.cwd` 在配置里可以是相对的。
 */
import { resolve } from "node:path";

export function projectWorkspaceRoot(workRoot: string, projectId: string): string {
  return resolve(workRoot, "projects", projectId);
}
