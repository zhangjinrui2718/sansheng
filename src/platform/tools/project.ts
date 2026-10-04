/**
 * BC1 工具:project_* / work_* / report
 *
 * 每个工具都是**纯函数**:依赖全部从 `ctx` 取,不读模块级单例、不直接调时钟。
 * 参数校验失败返回结构化 `ToolResult` 而不是抛异常 —— 抛出去会把整轮对话打崩。
 */
import { Type } from "@sinclair/typebox";
import {
  insertProject, getProjectRow, updateProject, closeProject,
  addMember, loadProjectRoster,
} from "../storage/repo/projects.js";
import {
  insertWork, getWork, listWorks, updateWorkStatus, assignWork,
  addDep, listDeps, depState, isWorkStatus,
  WORK_STATUSES, type WorkStatus,
} from "../storage/repo/works.js";
import { getAgent } from "../storage/repo/agents.js";
import { ensureProjectOrg } from "../runtime/org.js";
import { resolveAssignee } from "./resolve.js";
import {
  fail, ok, requireProject, requireString, readString, readStringArray, readNumber,
  type PlatformTool, type ToolRunContext, type ToolResult,
} from "./types.js";

// ── 小工具 ──────────────────────────────────────────────────────

/** 校验 workId 存在,不存在时给可读错误(而不是让 FK 抛 SQLite 原文)。 */
function loadWorkOrFail(ctx: ToolRunContext, workId: string): { id: string } | ToolResult {
  const w = getWork(ctx.db, workId);
  if (w === null) return fail("not_found", `找不到工作项 ${workId}`);
  return { id: w.id };
}

function isToolResult(v: unknown): v is ToolResult {
  return typeof v === "object" && v !== null && "ok" in v;
}

/** 工作项摘要行 —— 列表与详情统一格式,避免两处漂移。
 *  `db` 显式传入而不是藏在模块级变量里:模块级可变状态既并发不安全,
 *  也正是这套设计要消灭的隐式耦合。 */
function renderWork(db: ToolRunContext["db"], w: {
  id: string; title: string; status: string; assigneeAgentId: string; parentWorkId: string | null;
}): string {
  const a = getAgent(db, w.assigneeAgentId);
  const who = a
    ? `${a.displayName}(${a.role}${a.specialization ? "/" + a.specialization : ""})`
    : w.assigneeAgentId;
  const parent = w.parentWorkId !== null ? ` ← ${w.parentWorkId}` : "";
  return `[${w.status}] ${w.id} · ${w.title}(负责 ${who})${parent}`;
}

// ── project_* ───────────────────────────────────────────────────

const projectOpen: PlatformTool = {
  name: "project_open",
  capability: "project.open",
  description:
    "立项。把一个已与甲方对齐的目标落成正式项目,产出项目根工件。**这是甲方诉求进入系统的唯一入口** —— 立项之后的一切都发生在项目内,不再需要甲方在场。**接待会话(还没有项目)里也带着它** —— 与甲方谈拢之后就用它,不要要求甲方去填任何表单。",
  parameters: Type.Object({
    name: Type.String({ description: "项目名(简短可辨识)" }),
    client: Type.String({ description: "甲方标识" }),
    goal: Type.String({ description: "要达成的目标(与甲方对齐后的结论,不是原始诉求)" }),
  }),
  run(args, ctx): ToolResult {
    const name = requireString(args, "name");
    if (!name.ok) return name.result;
    const client = requireString(args, "client");
    if (!client.ok) return client.result;
    const goal = requireString(args, "goal");
    if (!goal.ok) return goal.result;

    const id = ctx.newId("pj");
    const at = ctx.now();
    insertProject(ctx.db, {
      id, name: name.value, client: client.value, goal: goal.value,
      status: "active", createdAt: at,
    });
    // 立项人自动成为项目成员 —— 否则业务经理建完项目反而不在里面。
    addMember(ctx.db, id, ctx.agent.id, at);
    // **整个组织一起进来**,不是只进立项人。
    // 少了这一行,项目经理/worker/质检不是成员 → 他们的会话建不出来
    // (buildToolContext 的 agent_not_assigned)、`work_create` 也解析不出负责人
    // → 「立项之后组织接手」结构上不可能发生(见 runtime/org.ts 的注释)。
    ensureProjectOrg(ctx.db, id, at);
    // ── 结构化 id 走 `data`,不靠解析 `text` ──────────────────────
    //
    // 宿主必须知道「新项目叫什么 id」:它要把接待会话的消息迁进新项目、让前端
    // 切过去、并**丢掉接待会话**(否则那条会话还留着接待模式的工具面)。
    // 从下面这行文本里正则抠 id 是脆的(文案改一个字就静默失效),所以走
    // `ToolResult.data` → SDK `details` → `runTurn` 的既有结构化通道
    // (判工具成败本来就是读 details,见 runtime/turn.ts)。
    // 文本仍以 id 开头,人读日志时第一眼也能看到它。
    return ok(`已立项 ${id}「${name.value}」(甲方:${client.value})\n目标:${goal.value}`, {
      projectId: id,
      name: name.value,
      client: client.value,
      goal: goal.value,
    });
  },
};

const projectRead: PlatformTool = {
  name: "project_read",
  capability: "project.read",
  description:
    "读项目全貌:成员花名册、工作项分布、未解决阻塞、待决变更。**想了解「这个项目现在什么状况」先用它**,比逐个工具问一遍省得多。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
  }),
  run(args, ctx): ToolResult {
    const proj = requireProject(ctx, "project_read");
    if (!proj.ok) return proj.result;
    const pid = readString(args, "projectId") ?? proj.project.id;
    const row = getProjectRow(ctx.db, pid);
    if (row === null) return fail("not_found", `找不到项目 ${pid}`);

    const roster = loadProjectRoster(ctx.db, pid);
    const works = listWorks(ctx.db, pid);
    const byStatus = new Map<string, number>();
    for (const w of works) byStatus.set(w.status, (byStatus.get(w.status) ?? 0) + 1);

    const lines = [
      `# ${row.name}(${row.id})`,
      `- 甲方:${row.client}`,
      `- 状态:${row.status}`,
      `- 目标:${row.goal}`,
      "",
      `## 成员(${roster.length})`,
      ...roster.map((m) => `- ${m.displayName} · ${m.role}${m.specialization ? "/" + m.specialization : ""} (${m.id})`),
      "",
      `## 工作项(${works.length})`,
      ...(byStatus.size === 0
        ? ["- (暂无)"]
        : [...byStatus.entries()].map(([s, n]) => `- ${s}: ${n}`)),
    ];
    return ok(lines.join("\n"));
  },
};

const projectUpdate: PlatformTool = {
  name: "project_update",
  capability: "project.update",
  description:
    "改项目名 / 目标 / 状态(active|paused)。**终态要走 project_close**。注意:要改的是**范围**时应走 change_propose —— 变更管理存在的意义就是不让范围被顺手改掉。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    name: Type.Optional(Type.String()),
    goal: Type.Optional(Type.String()),
    status: Type.Optional(
      Type.Union([Type.Literal("active"), Type.Literal("paused")], {
        description: "只能在这两个非终态之间切",
      }),
    ),
  }),
  run(args, ctx): ToolResult {
    const proj = requireProject(ctx, "project_update");
    if (!proj.ok) return proj.result;
    const pid = readString(args, "projectId") ?? proj.project.id;
    if (getProjectRow(ctx.db, pid) === null) return fail("not_found", `找不到项目 ${pid}`);
    const status = readString(args, "status");
    if (status !== undefined && status !== "active" && status !== "paused") {
      return fail("invalid_args", `status 只能是 active 或 paused(收到「${status}」)`, [
        "active", "paused",
      ]);
    }
    // 项目不存在在 repo 层是静默 no-op(updateProject 的 sets 为空就 return),
    // 所以这里必须先确认它存在,否则「改了一个不存在的项目」看起来像成功。
    const fields: { name?: string; goal?: string; status?: "active" | "paused" } = {};
    const n = readString(args, "name");
    if (n !== undefined) fields.name = n;
    const g = readString(args, "goal");
    if (g !== undefined) fields.goal = g;
    if (status !== undefined) fields.status = status;
    updateProject(ctx.db, pid, fields);
    return ok(`已更新项目 ${pid}:${JSON.stringify(fields)}`);
  },
};

const projectClose: PlatformTool = {
  name: "project_close",
  capability: "project.close",
  description:
    "关闭项目(终态,不可逆)。done = 交付完成;abandoned = 放弃。**关掉之后项目内能力全部失效**,只剩记忆与代码工具可用。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    outcome: Type.Union([Type.Literal("done"), Type.Literal("abandoned")]),
    reason: Type.Optional(Type.String({ description: "放弃原因(abandoned 时应给)" })),
  }),
  run(args, ctx): ToolResult {
    const proj = requireProject(ctx, "project_close");
    if (!proj.ok) return proj.result;
    const pid = readString(args, "projectId") ?? proj.project.id;
    const outcome = readString(args, "outcome");
    if (outcome !== "done" && outcome !== "abandoned") {
      return fail("invalid_args", `outcome 只能是 done 或 abandoned(收到「${String(outcome)}」)`, [
        "done", "abandoned",
      ]);
    }
    if (getProjectRow(ctx.db, pid) === null) return fail("not_found", `找不到项目 ${pid}`);
    try {
      closeProject(ctx.db, pid, outcome, ctx.now());
    } catch (err) {
      return fail("conflict", err instanceof Error ? err.message : String(err));
    }
    const reason = readString(args, "reason");
    return ok(`项目 ${pid} 已关闭(${outcome})${reason ? ` — ${reason}` : ""}`);
  },
};

// ── work_* ──────────────────────────────────────────────────────

const workCreate: PlatformTool = {
  name: "work_create",
  capability: "work.create",
  description:
    "拆解出一个工作项并**指定负责人与依赖**。负责人必填 —— 没有主的工作项进度无从追问,所以 schema 层面就拒绝无主工作。开工前先 board_list 查重,重复拆解是最常见也最贵的失败。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    title: Type.String(),
    goal: Type.String({ description: "要产出什么 + 怎么算做完(可验证的判据)" }),
    assigneeRole: Type.String({ description: "负责人角色:business_manager | project_manager | worker | quality_reviewer" }),
    assigneeSpec: Type.Optional(Type.String({ description: "worker 的细分:engineering | algorithm | data" })),
    dependsOn: Type.Optional(Type.Array(Type.String(), { description: "前置工作项 id" })),
    parentWorkId: Type.Optional(Type.String({ description: "父工作项(做工作分解树时给)" })),
  }),
  run(args, ctx): ToolResult {
    const proj = requireProject(ctx, "work_create");
    if (!proj.ok) return proj.result;
    const pid = readString(args, "projectId") ?? proj.project.id;
    const title = requireString(args, "title");
    if (!title.ok) return title.result;
    const goal = requireString(args, "goal");
    if (!goal.ok) return goal.result;

    const resolved = resolveAssignee(
      ctx.db, pid, args["assigneeRole"], args["assigneeSpec"],
    );
    if (!resolved.ok) {
      return fail("not_found", `无法确定负责人:${resolved.message}`, resolved.alternatives);
    }

    const parentWorkId = readString(args, "parentWorkId");
    if (parentWorkId !== undefined && getWork(ctx.db, parentWorkId) === null) {
      return fail("not_found", `找不到父工作项 ${parentWorkId}`);
    }

    const id = ctx.newId("wk");
    const at = ctx.now();
    try {
      insertWork(ctx.db, {
        id, projectId: pid, parentWorkId: parentWorkId ?? null,
        title: title.value, goal: goal.value, status: "open",
        assigneeAgentId: resolved.agentId, createdAt: at, updatedAt: at,
      });
    } catch (err) {
      return fail("internal", err instanceof Error ? err.message : String(err));
    }

    // 依赖逐条加,**环检测在 repo 层**。成环时把已加的回滚掉,不留半成品。
    const deps = readStringArray(args, "dependsOn") ?? [];
    const added: string[] = [];
    for (const d of deps) {
      const r = addDep(ctx.db, id, d);
      if (!r.ok) {
        for (const a of added) {
          ctx.db.prepare(`DELETE FROM work_deps WHERE work_id = ? AND depends_on_work_id = ?`).run(id, a);
        }
        const why =
          r.reason === "cycle" ? `依赖 ${d} 会成环`
          : r.reason === "self" ? `不能依赖自己`
          : r.reason === "duplicate" ? `依赖 ${d} 重复`
          : `找不到前置工作项 ${d}`;
        ctx.db.prepare(`DELETE FROM works WHERE id = ?`).run(id);
        return fail("conflict", `创建工作项失败:${why}(已回滚)`);
      }
      added.push(d);
    }

    return ok(
      `已创建 ${id}「${title.value}」→ 负责 ${resolved.agentId}` +
        (added.length > 0 ? `\n前置:${added.join(", ")}` : ""),
    );
  },
};

const workUpdate: PlatformTool = {
  name: "work_update",
  capability: "work.update",
  description:
    "改工作项状态。open → in_progress → (blocked) → done|failed|cancelled。**状态变更是 report 的前置** —— 只口头汇报不落库,进度就只存在于对话里。",
  parameters: Type.Object({
    workId: Type.String(),
    status: Type.String({ description: WORK_STATUSES.join(" | ") }),
  }),
  run(args, ctx): ToolResult {
    const workId = requireString(args, "workId");
    if (!workId.ok) return workId.result;
    const found = loadWorkOrFail(ctx, workId.value);
    if (isToolResult(found)) return found;
    const status = readString(args, "status");
    if (status === undefined || !isWorkStatus(status)) {
      return fail("invalid_args", `未知状态「${String(status)}」`, WORK_STATUSES);
    }
    updateWorkStatus(ctx.db, workId.value, status as WorkStatus, ctx.now());
    return ok(`工作项 ${workId.value} → ${status}`);
  },
};

const workAssign: PlatformTool = {
  name: "work_assign",
  capability: "work.assign",
  description:
    "改派工作项。与 work_create 走同一套负责人解析,所以改派也会做歧义检查 —— 不会因为「改派是个小操作」就绕过它。",
  parameters: Type.Object({
    workId: Type.String(),
    assigneeRole: Type.String(),
    assigneeSpec: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
  }),
  run(args, ctx): ToolResult {
    const workId = requireString(args, "workId");
    if (!workId.ok) return workId.result;
    const found = loadWorkOrFail(ctx, workId.value);
    if (isToolResult(found)) return found;
    const w = getWork(ctx.db, workId.value)!;

    const resolved = resolveAssignee(ctx.db, w.projectId, args["assigneeRole"], args["assigneeSpec"]);
    if (!resolved.ok) {
      return fail("not_found", `无法确定改派目标:${resolved.message}`, resolved.alternatives);
    }
    assignWork(ctx.db, workId.value, resolved.agentId, ctx.now());
    const reason = readString(args, "reason");
    return ok(`工作项 ${workId.value} 已改派给 ${resolved.agentId}${reason ? `(${reason})` : ""}`);
  },
};

const workList: PlatformTool = {
  name: "work_list",
  capability: "work.list",
  description: "列工作项,可按状态与负责人过滤。开工前查重用它。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    status: Type.Optional(Type.String({ description: WORK_STATUSES.join(" | ") })),
    assigneeRole: Type.Optional(Type.String()),
    assigneeSpec: Type.Optional(Type.String()),
    rootsOnly: Type.Optional(Type.Boolean({ description: "只要顶层工作项" })),
    limit: Type.Optional(Type.Number()),
  }),
  run(args, ctx): ToolResult {
    const proj = requireProject(ctx, "work_list");
    if (!proj.ok) return proj.result;
    {
      const pid = readString(args, "projectId") ?? proj.project.id;
      const status = readString(args, "status");
      if (status !== undefined && !isWorkStatus(status)) {
        return fail("invalid_args", `未知状态「${status}」`, WORK_STATUSES);
      }
      let assigneeAgentId: string | undefined;
      if (args["assigneeRole"] !== undefined) {
        const r = resolveAssignee(ctx.db, pid, args["assigneeRole"], args["assigneeSpec"]);
        if (!r.ok) return fail("not_found", r.message, r.alternatives);
        assigneeAgentId = r.agentId;
      }
      const rows = listWorks(ctx.db, pid, {
        ...(status !== undefined ? { status: status as WorkStatus } : {}),
        ...(assigneeAgentId !== undefined ? { assigneeAgentId } : {}),
        ...(args["rootsOnly"] === true ? { rootsOnly: true } : {}),
      });
      const limit = readNumber(args, "limit") ?? 50;
      const shown = rows.slice(0, Math.min(Math.max(limit, 1), 200));
      if (shown.length === 0) return ok(`项目 ${pid} 没有匹配的工作项`);
      return ok(
        `共 ${rows.length} 条(显示 ${shown.length}):\n` +
          shown.map((w) => renderWork(ctx.db, w)).join("\n"),
      );
    }
  },
};

const workRead: PlatformTool = {
  name: "work_read",
  capability: "work.read",
  description: "读工作项详情:目标、负责人、前置依赖的三种状态(满足/失败/仍在跑)。",
  parameters: Type.Object({ workId: Type.String() }),
  run(args, ctx): ToolResult {
    {
      const workId = requireString(args, "workId");
      if (!workId.ok) return workId.result;
      const found = loadWorkOrFail(ctx, workId.value);
      if (isToolResult(found)) return found;
      const w = getWork(ctx.db, workId.value)!;
      const deps = listDeps(ctx.db, workId.value);
      const st = depState(ctx.db, workId.value);
      return ok(
        [
          `# ${w.title}(${w.id})`,
          `- 状态:${w.status}`,
          `- 项目:${w.projectId}`,
          `- 负责:${w.assigneeAgentId}`,
          `- 父项:${w.parentWorkId ?? "(顶层)"}`,
          `- 目标:${w.goal}`,
          "",
          `## 前置依赖(${deps.length})`,
          `- 已满足:${st.satisfied.join(", ") || "(无)"}`,
          `- **已失败(永远等不到)**:${st.failed.join(", ") || "(无)"}`,
          `- 仍在跑:${st.pending.join(", ") || "(无)"}`,
          ...(st.missing.length > 0 ? [`- ⚠️ 依赖的目标不存在:${st.missing.join(", ")}`] : []),
        ].join("\n"),
      );
    }
  },
};

const report: PlatformTool = {
  name: "report",
  capability: "work.report",
  description:
    "汇报进度。**这是向上同步的标准动作** —— 它把状态写进库里,而口头汇报只存在于对话中。",
  parameters: Type.Object({
    workId: Type.String(),
    summary: Type.String({ description: "进展摘要(要能被事后读懂)" }),
    status: Type.Optional(Type.String({ description: WORK_STATUSES.join(" | ") })),
  }),
  run(args, ctx): ToolResult {
    const workId = requireString(args, "workId");
    if (!workId.ok) return workId.result;
    const found = loadWorkOrFail(ctx, workId.value);
    if (isToolResult(found)) return found;
    const summary = requireString(args, "summary");
    if (!summary.ok) return summary.result;

    const status = readString(args, "status");
    if (status !== undefined) {
      if (!isWorkStatus(status)) return fail("invalid_args", `未知状态「${status}」`, WORK_STATUSES);
      updateWorkStatus(ctx.db, workId.value, status as WorkStatus, ctx.now());
    }
    return ok(`已记录 ${workId.value} 的进度报告:${summary.value}`);
  },
};

export const PROJECT_WORK_TOOLS: readonly PlatformTool[] = [
  projectOpen, projectRead, projectUpdate, projectClose,
  workCreate, workUpdate, workAssign, workList, workRead, report,
];
