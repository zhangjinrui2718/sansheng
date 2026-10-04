/**
 * BC3 工具:board_list / board_read / board_write
 *
 * ── 这里为什么还需要一次 kind 校验 ────────────────────────────────
 *
 * 派发器会执行 `WriteKindGate`(「这个**角色**能不能写这种 kind」),那是对的,
 * 但它是**角色相关**的判定。工具自身还要做一次**闭集校验**(「这个 kind 存在吗」)
 * —— 两者的失败语义不同:
 *
 *   不存在的 kind      → 模型把参数名记错了,要回灌合法值全集
 *   存在但本角色不能写  → 模型越权,要回灌**该角色**的合法值
 *
 * 合成一个检查会让错误信息失去区分度,而模型的下一步动作恰恰取决于这个区分。
 */
import { Type } from "@sinclair/typebox";
import {
  insertArtifact, getArtifact, listArtifacts, setArtifactStatus,
  addArtifactLink, listLinks, listBackLinks, countArtifactsByKind,
  ARTIFACT_STATUSES, ARTIFACT_LINK_RELS,
  isArtifactStatus, isArtifactLinkRel,
  type ArtifactStatus, type ArtifactLinkRel,
} from "../storage/repo/artifacts.js";
import { isArtifactKind, ARTIFACT_KINDS, type ArtifactKind } from "../identity/role.js";
import {
  fail, ok, requireString, readString, readStringArray,
  type PlatformTool, type ToolResult,
} from "./types.js";

const boardList: PlatformTool = {
  name: "board_list",
  capability: "blackboard.read",
  description:
    "列项目黑板上的工件(decision / evidence / hypothesis / note / 各类简报)。**这是你了解「别人已经做了什么」的主要途径** —— 同项目里其他人的产出都在这里。作用域是项目,不是当前对话。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    kind: Type.Optional(Type.String({ description: ARTIFACT_KINDS.join(" | ") })),
    status: Type.Optional(Type.String({ description: ARTIFACT_STATUSES.join(" | ") })),
    authorAgentId: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Number()),
  }),
  run(args, ctx): ToolResult {
    const pid = readString(args, "projectId") ?? ctx.project.id;
    // **跨项目写要拦**。首跑真机实测:模型对着一个可选参数**自己猜了一个
    // projectId**,撞上 project_id 外键,报出来的却是一句裸的
    // "FOREIGN KEY constraint failed" —— 既没说哪条外键,也没说猜错了。
    //
    // 一次会话属于一个项目(ctx.project),往别的项目写几乎总是错的:
    // 要么是猜的(本例),要么是拿错了 id。真需要跨项目时那该是另一个会话。
    if (pid !== ctx.project.id) {
      // 拒绝而不是「查一下你够不够格」:一次会话属于一个项目,往别的项目写
      // 几乎总是拿错了 id。真需要跨项目时那该是另一个会话 —— 让这条约束
      // 简单到不需要解释,比给它开一个需要判断的例外更安全。
      return fail(
        "denied",
        `本次会话属于项目 ${ctx.project.id},不能往 ${pid} 写。` +
          `要写当前项目就别传 projectId(它是可选的,缺省即当前项目)。`,
      );
    }
    const kind = readString(args, "kind");
    if (kind !== undefined && !isArtifactKind(kind)) {
      return fail("invalid_args", `未知工件 kind「${kind}」`, ARTIFACT_KINDS);
    }
    const status = readString(args, "status");
    if (status !== undefined && !isArtifactStatus(status)) {
      return fail("invalid_args", `未知工件状态「${status}」`, ARTIFACT_STATUSES);
    }
    const rows = listArtifacts(ctx.db, pid, {
      ...(kind !== undefined ? { kind: kind as ArtifactKind } : {}),
      ...(status !== undefined ? { status: status as ArtifactStatus } : {}),
      ...(readString(args, "authorAgentId") !== undefined
        ? { authorAgentId: readString(args, "authorAgentId")! }
        : {}),
      ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
    });
    if (rows.length === 0) return ok(`项目 ${pid} 的黑板上没有匹配的工件`);

    const counts = countArtifactsByKind(ctx.db, pid);
    const summary = Object.entries(counts).map(([k, n]) => `${k}:${n}`).join(" · ");
    const lines = rows.map((a) => `[${a.status}] ${a.kind} ${a.id} · ${a.title}(作者 ${a.authorAgentId})`);
    return ok(
      `项目 ${pid} 工件共 ${Object.values(counts).reduce((x, y) => x + y, 0)} 条(${summary})\n` +
        `显示 ${rows.length} 条:\n${lines.join("\n")}\n\n要读正文用 board_read 传 id。`,
    );
  },
};

const boardRead: PlatformTool = {
  name: "board_read",
  capability: "blackboard.read",
  description:
    "按 id 读一条工件的完整正文。**写结论前先读同题的已有结论** —— 复述别人的结论远好过凭空再写一份。",
  parameters: Type.Object({ artifactId: Type.String() }),
  run(args, ctx): ToolResult {
    const id = requireString(args, "artifactId");
    if (!id.ok) return id.result;
    const a = getArtifact(ctx.db, id.value);
    if (a === null) {
      return fail("not_found", `找不到工件 ${id.value}(可能已被清理,或 id 属于别的项目)`);
    }
    const out = listLinks(ctx.db, id.value);
    const inb = listBackLinks(ctx.db, id.value);
    return ok(
      [
        `# ${a.title}`,
        `- id:${a.id}`,
        `- kind:${a.kind} · status:${a.status}`,
        `- 项目:${a.projectId}`,
        `- 作者:${a.authorAgentId}`,
        `- 创建:${new Date(a.createdAt).toISOString()}`,
        ...(out.length > 0 ? [`- 指向:${out.join(", ")}`] : []),
        ...(inb.length > 0 ? [`- 被指向:${inb.join(", ")}`] : []),
        ...(a.metadataJson !== null ? [`- metadata:${a.metadataJson}`] : []),
        "",
        a.body,
      ].join("\n"),
    );
  },
};

const boardWrite: PlatformTool = {
  name: "board_write",
  capability: "blackboard.write",
  description:
    "写一条工件。**结论必须落这里才算数** —— 只在对话里说是不可审计的。能写哪些 kind 取决于你的角色(例如质检审查员只能写 review_finding)。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    kind: Type.String({ description: ARTIFACT_KINDS.join(" | ") }),
    title: Type.String(),
    body: Type.String({ description: "正文。要能被事后独立读懂 —— 见不到现场等于没有现场。" }),
    status: Type.Optional(Type.String({ description: `${ARTIFACT_STATUSES.join(" | ")}(默认 open)` })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    links: Type.Optional(
      Type.Array(
        Type.Object({
          rel: Type.String({ description: ARTIFACT_LINK_RELS.join(" | ") }),
          targetId: Type.String(),
        }),
      ),
    ),
  }),
  run(args, ctx): ToolResult {
    const pid = readString(args, "projectId") ?? ctx.project.id;
    // **跨项目写要拦**。首跑真机实测:模型对着一个可选参数**自己猜了一个
    // projectId**,撞上 project_id 外键,报出来的却是一句裸的
    // "FOREIGN KEY constraint failed" —— 既没说哪条外键,也没说猜错了。
    //
    // 一次会话属于一个项目(ctx.project),往别的项目写几乎总是错的:
    // 要么是猜的(本例),要么是拿错了 id。真需要跨项目时那该是另一个会话。
    if (pid !== ctx.project.id) {
      // 拒绝而不是「查一下你够不够格」:一次会话属于一个项目,往别的项目写
      // 几乎总是拿错了 id。真需要跨项目时那该是另一个会话 —— 让这条约束
      // 简单到不需要解释,比给它开一个需要判断的例外更安全。
      return fail(
        "denied",
        `本次会话属于项目 ${ctx.project.id},不能往 ${pid} 写。` +
          `要写当前项目就别传 projectId(它是可选的,缺省即当前项目)。`,
      );
    }
    const kind = readString(args, "kind");
    if (kind === undefined || !isArtifactKind(kind)) {
      return fail("invalid_args", `未知工件 kind「${String(kind)}」`, ARTIFACT_KINDS);
    }
    const title = requireString(args, "title");
    if (!title.ok) return title.result;
    const body = requireString(args, "body");
    if (!body.ok) return body.result;

    const statusRaw = readString(args, "status") ?? "open";
    if (!isArtifactStatus(statusRaw)) {
      return fail("invalid_args", `未知状态「${statusRaw}」`, ARTIFACT_STATUSES);
    }

    const id = ctx.newId("art");
    const at = ctx.now();
    const metadata = args["metadata"];
    try {
      insertArtifact(ctx.db, {
        id,
        projectId: pid,
        conversationId: null,
        kind: kind as ArtifactKind,
        status: statusRaw as ArtifactStatus,
        authorAgentId: ctx.agent.id,
        title: title.value,
        body: body.value,
        metadataJson: metadata !== undefined ? JSON.stringify(metadata) : null,
        createdAt: at,
        updatedAt: at,
      });
    } catch (err) {
      // 外键失败必须**指名道姓** —— 裸的 "FOREIGN KEY constraint failed" 不说是哪条,
      // 事后无从判断是项目不存在还是作者不存在(首跑实测就撞上这条,只能靠猜)。
      return fail(
        "internal",
        `${err instanceof Error ? err.message : String(err)}` +
          `(写入上下文:project_id=${pid} · author_agent_id=${ctx.agent.id} · kind=${kind})`,
      );
    }

    // 关联边逐条加。失败不回滚工件 —— 工件本身已经写成了,边是可选的补充;
    // 但必须把哪条边没加成如实报出来,不许静默忽略。
    const warnings: string[] = [];
    const links = Array.isArray(args["links"]) ? args["links"] : [];
    for (const raw of links) {
      if (typeof raw !== "object" || raw === null) continue;
      const rel = (raw as { rel?: unknown }).rel;
      const target = (raw as { targetId?: unknown }).targetId;
      if (typeof rel !== "string" || !isArtifactLinkRel(rel)) {
        warnings.push(`未知 rel「${String(rel)}」`);
        continue;
      }
      if (typeof target !== "string") {
        warnings.push(`rel=${rel} 缺少 targetId`);
        continue;
      }
      const r = addArtifactLink(ctx.db, id, rel as ArtifactLinkRel, target);
      if (!r.ok) warnings.push(`rel=${rel}→${target} 未建立(${r.reason})`);
    }

    return ok(
      `已写工件 ${id}(${kind} · ${statusRaw})「${title.value}」` +
        (warnings.length > 0 ? `\n⚠️ 部分关联未建立:${warnings.join(";")}` : ""),
    );
  },
};

/** 供派发器与测试引用:把工件状态改掉(带闭集校验)。 */
export function applyArtifactStatus(
  ctx: { db: Parameters<typeof setArtifactStatus>[0]; now: () => number },
  artifactId: string,
  status: unknown,
): ToolResult {
  if (!isArtifactStatus(status)) {
    return fail("invalid_args", `未知状态「${String(status)}」`, ARTIFACT_STATUSES);
  }
  setArtifactStatus(ctx.db, artifactId, status, ctx.now());
  return ok(`工件 ${artifactId} → ${status}`);
}

export const BLACKBOARD_TOOLS: readonly PlatformTool[] = [boardList, boardRead, boardWrite];
