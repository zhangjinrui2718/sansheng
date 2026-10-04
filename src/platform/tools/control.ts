/**
 * BC4 工具:blocker_* / change_*
 *
 * 阻塞与变更是**跨会话存活的一等实体**(设计 1 §2.2),所以它们的工具比工件
 * 多一层语义:状态机受控 + 影响面可追溯。
 *
 * 两个关键设计点:
 *   - **阻塞必须能定位到工作项**(blocker_blocks)。只能说「项目有 3 个阻塞」
 *     是说不出「哪件事被卡住了」的 —— 而后者才是甲方要的答案。
 *   - **变更状态迁移走白名单**。proposed 直接跳 implemented 是这类流程最典型
 *     的漏洞,它不会报错,只会以「验收时发现没人评过」的形式出现。
 */
import { Type } from "@sinclair/typebox";
import {
  insertBlocker, getBlocker, listBlockers, setBlockerStatus,
  blockWork, listBlockedWorks, blockersForWork,
  BLOCKER_SEVERITIES, BLOCKER_STATUSES,
  isBlockerSeverity, isBlockerStatus,
  type BlockerStatus, type BlockerSeverity,
} from "../storage/repo/blockers.js";
import {
  insertChange, getChange, listChanges, transitionChange,
  affectWork, listAffectedWorks, changesForWork,
  CHANGE_STATUSES, canTransition,
  isChangeStatus,
  type ChangeStatus,
} from "../storage/repo/changes.js";
import { getWork } from "../storage/repo/works.js";
import {
  fail, ok, requireProject, requireString, readString, readStringArray,
  type PlatformTool, type ToolResult,
} from "./types.js";

// ── blocker_* ───────────────────────────────────────────────────

const blockerOpen: PlatformTool = {
  name: "blocker_open",
  capability: "blocker.open",
  description:
    "登记一个阻塞,并指明它**挡住了哪些工作项**。带 blocksWorkIds 才有用 —— 只登记一个标题,事后只能得到「有 3 个阻塞」,说不出哪件事被卡住。detail 要写清现场:复现步骤、报错原文、已经试过什么。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    title: Type.String(),
    detail: Type.String({ description: "阻塞现场:现象、已排查、需要谁做什么决定" }),
    severity: Type.String({ description: BLOCKER_SEVERITIES.join(" | ") }),
    blocksWorkIds: Type.Optional(Type.Array(Type.String(), { description: "被挡住的工作项" })),
  }),
  run(args, ctx): ToolResult {
    const proj = requireProject(ctx, "blocker_open");
    if (!proj.ok) return proj.result;
    const pid = readString(args, "projectId") ?? proj.project.id;
    const title = requireString(args, "title");
    if (!title.ok) return title.result;
    const detail = requireString(args, "detail");
    if (!detail.ok) return detail.result;

    const severity = readString(args, "severity");
    if (severity === undefined || !isBlockerSeverity(severity)) {
      return fail("invalid_args", `未知严重度「${String(severity)}」`, BLOCKER_SEVERITIES);
    }

    // 先校验工作项都存在 —— 否则会登记一个「挡住不存在的东西」的阻塞
    const blockIds = readStringArray(args, "blocksWorkIds") ?? [];
    for (const w of blockIds) {
      if (getWork(ctx.db, w) === null) return fail("not_found", `找不到要挡的工作项 ${w}`);
    }

    const id = ctx.newId("blk");
    insertBlocker(ctx.db, {
      id, projectId: pid, raisedByAgentId: ctx.agent.id,
      title: title.value, detail: detail.value,
      severity: severity as BlockerSeverity, status: "open", createdAt: ctx.now(),
    });
    for (const w of blockIds) blockWork(ctx.db, id, w);

    return ok(
      `已登记阻塞 ${id}(${severity})「${title.value}」` +
        (blockIds.length > 0 ? `\n挡住 ${blockIds.length} 个工作项:${blockIds.join(", ")}` : ""),
    );
  },
};

const blockerUpdate: PlatformTool = {
  name: "blocker_update",
  capability: "blocker.update",
  description:
    "推进阻塞状态。**落终态(resolved / deferred / rejected)必须给 resolution** —— 一个「已解决」但没说怎么解决的阻塞,事后复盘时等于没记录。",
  parameters: Type.Object({
    blockerId: Type.String(),
    status: Type.String({ description: BLOCKER_STATUSES.join(" | ") }),
    resolution: Type.Optional(Type.String({ description: "落终态时必填:当时是怎么处理的" })),
  }),
  run(args, ctx): ToolResult {
    const id = requireString(args, "blockerId");
    if (!id.ok) return id.result;
    if (getBlocker(ctx.db, id.value) === null) {
      return fail("not_found", `找不到阻塞 ${id.value}`);
    }
    const status = readString(args, "status");
    if (status === undefined || !isBlockerStatus(status)) {
      return fail("invalid_args", `未知状态「${String(status)}」`, BLOCKER_STATUSES);
    }
    const resolution = readString(args, "resolution");
    try {
      setBlockerStatus(
        ctx.db, id.value, status as BlockerStatus, ctx.now(),
        ...(resolution !== undefined ? [resolution] : []),
      );
    } catch (err) {
      return fail("invalid_args", err instanceof Error ? err.message : String(err));
    }
    return ok(`阻塞 ${id.value} → ${status}${resolution ? `(${resolution})` : ""}`);
  },
};

const blockerList: PlatformTool = {
  name: "blocker_list",
  capability: "blocker.read",
  description:
    "列阻塞。**unresolvedOnly=true 是「还有什么没解决」的标准问法** —— 这是向甲方交代项目状况时必须能回答的一屏。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    unresolvedOnly: Type.Optional(Type.Boolean({ description: "只要 open | acknowledged" })),
    severity: Type.Optional(Type.String({ description: BLOCKER_SEVERITIES.join(" | ") })),
    limit: Type.Optional(Type.Number()),
  }),
  run(args, ctx): ToolResult {
    const proj = requireProject(ctx, "blocker_list");
    if (!proj.ok) return proj.result;
    const pid = readString(args, "projectId") ?? proj.project.id;
    const severity = readString(args, "severity");
    if (severity !== undefined && !isBlockerSeverity(severity)) {
      return fail("invalid_args", `未知严重度「${severity}」`, BLOCKER_SEVERITIES);
    }
    const unresolvedOnly = args["unresolvedOnly"] === true;
    const rows = listBlockers(ctx.db, pid, {
      ...(unresolvedOnly ? { unresolvedOnly: true } : {}),
      ...(severity !== undefined ? { severity: severity as BlockerSeverity } : {}),
      ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
    });
    if (rows.length === 0) {
      return ok(unresolvedOnly ? `项目 ${pid} 没有未解决的阻塞` : `项目 ${pid} 没有阻塞记录`);
    }
    const lines = rows.map((b) => {
      const blocks = listBlockedWorks(ctx.db, b.id);
      return (
        `[${b.severity}/${b.status}] ${b.id} · ${b.title}` +
        (blocks.length > 0 ? ` — 挡住:${blocks.join(", ")}` : "") +
        `\n    ${b.detail.split("\n")[0]}` +
        (b.resolution !== null ? `\n    处理:${b.resolution}` : "")
      );
    });
    return ok(
      `项目 ${pid} 共 ${rows.length} 条${unresolvedOnly ? "未解决" : ""}阻塞:\n${lines.join("\n")}`,
    );
  },
};

const blockerRead: PlatformTool = {
  name: "blocker_read",
  capability: "blocker.read",
  description: "读单个阻塞的完整现场与它挡住的工作项。",
  parameters: Type.Object({ blockerId: Type.String() }),
  run(args, ctx): ToolResult {
    const id = requireString(args, "blockerId");
    if (!id.ok) return id.result;
    const b = getBlocker(ctx.db, id.value);
    if (b === null) return fail("not_found", `找不到阻塞 ${id.value}`);
    const blocks = listBlockedWorks(ctx.db, b.id);
    return ok(
      [
        `# ${b.title}(${b.id})`,
        `- 严重度:${b.severity} · 状态:${b.status}`,
        `- 项目:${b.projectId} · 提出者:${b.raisedByAgentId}`,
        `- 登记:${new Date(b.createdAt).toISOString()}`,
        ...(b.resolvedAt !== null ? [`- 处理于:${new Date(b.resolvedAt).toISOString()}`] : []),
        ...(b.resolution !== null ? [`- 处理方式:${b.resolution}`] : []),
        `- 挡住的工作项:${blocks.join(", ") || "(未关联任何工作项 — 这样事后查不出它卡住了什么)"}`,
        "",
        b.detail,
      ].join("\n"),
    );
  },
};

// ── change_* ────────────────────────────────────────────────────

const changePropose: PlatformTool = {
  name: "change_propose",
  capability: "change.propose",
  description:
    "提出需求变更。**改范围必须走这里,不能直接改项目目标** —— 变更管理的全部意义就是让范围改动留下痕迹与评审。affectedWorkIds 指明这个变更波及哪些在跑的工作项。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    title: Type.String(),
    rationale: Type.String({ description: "为什么要改:谁提的、解决什么问题" }),
    impact: Type.Optional(Type.Array(Type.String(), { description: "影响面描述,如 schema / 前端 / 排期" })),
    affectedWorkIds: Type.Optional(Type.Array(Type.String(), { description: "波及的工作项" })),
  }),
  run(args, ctx): ToolResult {
    const proj = requireProject(ctx, "change_propose");
    if (!proj.ok) return proj.result;
    const pid = readString(args, "projectId") ?? proj.project.id;
    const title = requireString(args, "title");
    if (!title.ok) return title.result;
    const rationale = requireString(args, "rationale");
    if (!rationale.ok) return rationale.result;

    const affected = readStringArray(args, "affectedWorkIds") ?? [];
    for (const w of affected) {
      if (getWork(ctx.db, w) === null) return fail("not_found", `找不到受影响的工作项 ${w}`);
    }
    const impact = readStringArray(args, "impact") ?? [];

    const id = ctx.newId("chg");
    insertChange(ctx.db, {
      id, projectId: pid, title: title.value, rationale: rationale.value,
      impactJson: impact.length > 0 ? JSON.stringify(impact) : null,
      status: "proposed", createdAt: ctx.now(),
    });
    for (const w of affected) affectWork(ctx.db, id, w);

    return ok(
      `已提出变更 ${id}「${title.value}」(状态 proposed,待评审)` +
        (affected.length > 0 ? `\n影响工作项:${affected.join(", ")}` : ""),
    );
  },
};

const changeReview: PlatformTool = {
  name: "change_review",
  capability: "change.review",
  description:
    "评审变更并推进状态。**合法路径是白名单**:proposed → under_review → accepted → implemented,或任一步 → rejected。**proposed 不能直接跳 implemented** —— 没评审就实施是这类流程最典型的漏洞。评审类迁移必须记决定人。",
  parameters: Type.Object({
    changeId: Type.String(),
    verdict: Type.String({ description: `${CHANGE_STATUSES.join(" | ")}(常用 under_review / accepted / rejected / implemented)` }),
    comment: Type.Optional(Type.String({ description: "评审意见,建议写清理由" })),
  }),
  run(args, ctx): ToolResult {
    const id = requireString(args, "changeId");
    if (!id.ok) return id.result;
    const cur = getChange(ctx.db, id.value);
    if (cur === null) return fail("not_found", `找不到变更 ${id.value}`);

    const verdict = readString(args, "verdict");
    if (verdict === undefined || !isChangeStatus(verdict)) {
      return fail("invalid_args", `未知状态「${String(verdict)}」`, CHANGE_STATUSES);
    }
    const to = verdict as ChangeStatus;
    // 提前给出可读的「下一步能去哪」,而不是等 repo 回一个枚举值
    if (!canTransition(cur.status, to)) {
      const allowed = CHANGE_STATUSES.filter((s) => canTransition(cur.status, s));
      return fail(
        "conflict",
        `变更 ${id.value} 当前是 ${cur.status},不能直接转到 ${to}`,
        allowed.length > 0 ? allowed : ["(已是终态,无法再流转)"],
      );
    }

    const r = transitionChange(ctx.db, id.value, to, ctx.now(), ctx.agent.id);
    if (!r.ok) {
      if (r.reason === "illegal_transition") {
        return fail("conflict", `非法迁移:${r.from} → ${to}`);
      }
      if (r.reason === "missing_decider") {
        return fail("invalid_args", "评审类迁移必须记决定人");
      }
      return fail("not_found", `找不到变更 ${id.value}`);
    }
    const comment = readString(args, "comment");
    return ok(`变更 ${id.value}:${cur.status} → ${to}${comment ? `\n评审意见:${comment}` : ""}`);
  },
};

const changeList: PlatformTool = {
  name: "change_list",
  capability: "change.read",
  description: "列变更请求,可按状态过滤。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    status: Type.Optional(Type.String({ description: CHANGE_STATUSES.join(" | ") })),
    limit: Type.Optional(Type.Number()),
  }),
  run(args, ctx): ToolResult {
    const proj = requireProject(ctx, "change_list");
    if (!proj.ok) return proj.result;
    const pid = readString(args, "projectId") ?? proj.project.id;
    const status = readString(args, "status");
    if (status !== undefined && !isChangeStatus(status)) {
      return fail("invalid_args", `未知状态「${status}」`, CHANGE_STATUSES);
    }
    const rows = listChanges(ctx.db, pid, {
      ...(status !== undefined ? { status: status as ChangeStatus } : {}),
      ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
    });
    if (rows.length === 0) return ok(`项目 ${pid} 没有匹配的变更请求`);
    const lines = rows.map((c) => {
      const affected = listAffectedWorks(ctx.db, c.id);
      return (
        `[${c.status}] ${c.id} · ${c.title}` +
        (affected.length > 0 ? ` — 影响:${affected.join(", ")}` : "")
      );
    });
    return ok(`项目 ${pid} 共 ${rows.length} 条变更:\n${lines.join("\n")}`);
  },
};

const changeRead: PlatformTool = {
  name: "change_read",
  capability: "change.read",
  description: "读单个变更的完整理由、影响面与波及的工作项。",
  parameters: Type.Object({ changeId: Type.String() }),
  run(args, ctx): ToolResult {
    const id = requireString(args, "changeId");
    if (!id.ok) return id.result;
    const c = getChange(ctx.db, id.value);
    if (c === null) return fail("not_found", `找不到变更 ${id.value}`);
    const affected = listAffectedWorks(ctx.db, c.id);
    // impactJson 理论上是自己写进去的,但「理论上」不足以让工具抛异常 ——
    // 一次 JSON.parse 抛错会把整轮对话打崩,而这只影响一行展示。
    let impact: string[] = [];
    if (c.impactJson !== null) {
      try {
        const parsed: unknown = JSON.parse(c.impactJson);
        if (Array.isArray(parsed)) impact = parsed.filter((x): x is string => typeof x === "string");
      } catch {
        impact = ["(impact_json 已损坏,无法解析)"];
      }
    }
    return ok(
      [
        `# ${c.title}(${c.id})`,
        `- 状态:${c.status}`,
        `- 项目:${c.projectId}`,
        `- 决定人:${c.decidedByAgentId ?? "(待定)"}`,
        `- 提出:${new Date(c.createdAt).toISOString()}`,
        ...(c.decidedAt !== null ? [`- 裁定:${new Date(c.decidedAt).toISOString()}`] : []),
        `- 影响面:${impact.join(" · ") || "(未填)"}`,
        `- 波及工作项:${affected.join(", ") || "(未关联)"}`,
        "",
        `## 理由`,
        c.rationale,
      ].join("\n"),
    );
  },
};

export const CONTROL_TOOLS: readonly PlatformTool[] = [
  blockerOpen, blockerUpdate, blockerList, blockerRead,
  changePropose, changeReview, changeList, changeRead,
];
