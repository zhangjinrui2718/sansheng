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
  ARTIFACT_STATUSES, ARTIFACT_LINK_RELS, DELIVERABLE_TYPES,
  isArtifactStatus, isArtifactLinkRel, isDeliverableType,
  validateDeliverableBody,
  type ArtifactStatus, type ArtifactLinkRel, type DeliverableType,
} from "../storage/repo/artifacts.js";
import { isArtifactKind, ARTIFACT_KINDS, type ArtifactKind } from "../identity/role.js";
import { CODE_SERVICE_REQUIRED_META, type CodeServiceFacts } from "../codeservice/port.js";
import { getWork } from "../storage/repo/works.js";
import {
  fail, ok, requireString, requireProject, readString, readStringArray,
  type PlatformTool, type ToolRunContext, type ToolResult,
} from "./types.js";

const boardList: PlatformTool = {
  name: "board_list",
  capability: "blackboard.read",
  description:
    "列项目黑板上的工件(decision / evidence / hypothesis / note / 各类简报)。**这是你了解「别人已经做了什么」的主要途径** —— 同项目里其他人的产出都在这里。作用域是项目,不是当前对话。要问「某条工作项产出了什么」就传 workId。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    kind: Type.Optional(Type.String({ description: ARTIFACT_KINDS.join(" | ") })),
    status: Type.Optional(Type.String({ description: ARTIFACT_STATUSES.join(" | ") })),
    authorAgentId: Type.Optional(Type.String()),
    workId: Type.Optional(
      Type.String({
        description: "只要这条工作项产出的工件(产出边,见 board_write 的 workId)",
      }),
    ),
    limit: Type.Optional(Type.Number()),
  }),
  run(args, ctx): ToolResult {
    const proj = requireProject(ctx, "board_list");
    if (!proj.ok) return proj.result;
    const pid = readString(args, "projectId") ?? proj.project.id;
    // **跨项目写要拦**。首跑真机实测:模型对着一个可选参数**自己猜了一个
    // projectId**,撞上 project_id 外键,报出来的却是一句裸的
    // "FOREIGN KEY constraint failed" —— 既没说哪条外键,也没说猜错了。
    //
    // 一次会话属于一个项目(ctx.project),往别的项目写几乎总是错的:
    // 要么是猜的(本例),要么是拿错了 id。真需要跨项目时那该是另一个会话。
    if (pid !== proj.project.id) {
      // 拒绝而不是「查一下你够不够格」:一次会话属于一个项目,往别的项目写
      // 几乎总是拿错了 id。真需要跨项目时那该是另一个会话 —— 让这条约束
      // 简单到不需要解释,比给它开一个需要判断的例外更安全。
      return fail(
        "denied",
        `本次会话属于项目 ${proj.project.id},不能往 ${pid} 写。` +
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
      ...(readString(args, "workId") !== undefined
        ? { workId: readString(args, "workId")! }
        : {}),
      ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
    });
    if (rows.length === 0) return ok(`项目 ${pid} 的黑板上没有匹配的工件`);

    const counts = countArtifactsByKind(ctx.db, pid);
    const summary = Object.entries(counts).map(([k, n]) => `${k}:${n}`).join(" · ");
    // 交付物那条行**额外标出类型** —— 甲方的技术方案与一份代码仓库在 kind 上
// 完全一样,`board_read` 之前拿不到区分(读 `body` 开头是不是 `<html` 是猜测)。
const lines = rows.map((a) =>
      `[${a.status}] ${a.kind} ${a.id} · ${a.title}(作者 ${a.authorAgentId}` +
      `${a.deliverableType !== null ? ` · 类型:${a.deliverableType}` : ""})`,
    );
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
        ...(a.kind === "deliverable"
          ? [`- 交付物类型:${a.deliverableType ?? "(存量 · 未声明类型,正文按 markdown 读)"}`]
          : []),
        `- 项目:${a.projectId}`,
        `- 作者:${a.authorAgentId}`,
        `- 创建:${new Date(a.createdAt).toISOString()}`,
        ...(a.workId !== null ? [`- 产出工作项:${a.workId}`] : []),
        ...(out.length > 0 ? [`- 指向:${out.join(", ")}`] : []),
        ...(inb.length > 0 ? [`- 被指向:${inb.join(", ")}`] : []),
        ...(a.metadataJson !== null ? [`- metadata:${a.metadataJson}`] : []),
        "",
        a.body,
      ].join("\n"),
    );
  },
};

/**
 * 核对一份 `code_service` 交付物的坐标,并把它**翻译成平台读到的事实**。
 *
 * 返回的 `metadata` 是「模型给的键 ∪ 平台核实到的键」,而**重叠的键以平台为准**:
 *   · `repoPath`  → 解析 + 包含性校验之后的绝对路径(realpath)
 *   · `branch`    → 已确认存在于 `refs/heads/`
 *   · `headCommit`→ 40 位全 sha(模型给短 sha 也接受,存进去的是全的)
 *   · 另补 `repoName` / `headSubject` / `commitCount` / `files` / `verifiedAt`
 *
 * 模型自己给的其它键(比如 `image` / `env` / 部署备注)**原样保留** ——
 * 平台只覆盖它能核实的那几个,不替模型删它说过的话。
 */
function verifyCodeService(
  ctx: ToolRunContext,
  rawMetadata: unknown,
): { ok: true; metadata: Record<string, unknown> } | { ok: false; result: ToolResult } {
  const md: Record<string, unknown> =
    rawMetadata !== null && typeof rawMetadata === "object" && !Array.isArray(rawMetadata)
      ? { ...(rawMetadata as Record<string, unknown>) }
      : {};

  // ① 坐标键必须齐。缺哪个**点名**哪个(8-F:拒绝必须让模型能据此自纠)。
  const missing = CODE_SERVICE_REQUIRED_META.filter((k) => {
    const v = md[k];
    if (v === undefined || v === null) return true;
    return typeof v === "string" && v.trim() === "";
  });
  if (missing.length > 0) {
    return {
      ok: false,
      result: fail(
        "invalid_args",
        `\`code_service\` 交付物的 metadata 缺这几项:${missing.join(" / ")}。` +
          `一份代码服务必须把坐标写清楚 —— 甲方靠它找到仓库、构建镜像、跑起来:\n` +
          "  · `repoPath`   仓库在磁盘上的路径(工作根之下)\n" +
          "  · `branch`     分支名(HEAD 必须是它的顶端)\n" +
          "  · `headCommit` 这次交付的提交 sha(在仓库里跑 \`git rev-parse HEAD\`)\n" +
          "  · `service`    服务名(镜像名 / 容器名,例如 `billing-api`)\n" +
          "  · `port`       容器暴露的端口(数字)\n" +
          "平台会**当场去盘上核对**这几项,核对不过这条交付物写不进去。",
        [...CODE_SERVICE_REQUIRED_META],
      ),
    };
  }

  const port = md["port"];
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0 || port > 65535) {
    return {
      ok: false,
      result: fail(
        "invalid_args",
        `\`port\` 必须是 1–65535 的整数(收到 ${JSON.stringify(md["port"])})。` +
          "它是容器暴露的端口,甲方 `docker run -p` 要用它。",
      ),
    };
  }

  // ② 没有核对面 = 装配错误。**拒绝,不放行** —— 见上面那段注释。
  const svc = ctx.codeService;
  if (svc === undefined) {
    return {
      ok: false,
      result: fail(
        "internal",
        "本次装配没有接上**代码服务核对面**(`codeService` 端口),所以平台无法核对这份 " +
          "`code_service` 的仓库坐标。这是**装配错误**,不是你的参数问题 —— " +
          "在修好之前不要把交付物写成 `code_service`:若你手上只有信息,写成 " +
          "`html_report`;若确实交了一个仓库,请把这件事登记成阻塞(`blocker_open`)让平台修。",
      ),
    };
  }

  // ③ 去盘上读事实。
  const inspected = svc.inspect({
    repoPath: String(md["repoPath"]),
    branch: String(md["branch"]),
    headCommit: String(md["headCommit"]),
  });
  if (!inspected.ok) return { ok: false, result: fail("invalid_args", inspected.reason) };

  const facts: CodeServiceFacts = inspected.facts;
  return {
    ok: true,
    metadata: {
      ...md,
      repoPath: facts.repoPath,
      repoName: facts.repoName,
      branch: facts.branch,
      headCommit: facts.headCommit,
      headSubject: facts.headSubject,
      commitCount: facts.commitCount,
      dockerfile: facts.dockerfile,
      files: [...facts.files],
      verifiedAt: ctx.now(),
    },
  };
}

const boardWrite: PlatformTool = {
  name: "board_write",
  capability: "blackboard.write",
  description:
    "写一条工件。**结论必须落这里才算数** —— 只在对话里说是不可审计的。能写哪些 kind 取决于你的角色(例如质检审查员只能写 review_finding)。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    kind: Type.String({ description: ARTIFACT_KINDS.join(" | ") }),
    deliverableType: Type.Optional(
      Type.String({
        description:
          `**kind='deliverable' 时必填**,其余 kind 不许传。` +
          `合法值:${DELIVERABLE_TYPES.join(" | ")}。` +
          "`html_report` = 只有信息交付的东西(技术方案 / 架构图 / 汇报材料 / " +
          "评审结论 / 说明书):正文写**一份自包含的 HTML 文档**(内联 <style>," +
          "架构图用内联 SVG),平台在禁用脚本的沙箱里把它渲染成给甲方看的网页。" +
          "`code_service` = **代码服务**:一个真的 git 仓库,能独立部署到 Docker。" +
          "正文写 markdown 说明(怎么构建/怎么跑/端口),并在 `metadata` 里给齐坐标 —— " +
          "`repoPath` / `branch` / `headCommit` / `service` / `port`。" +
          "⚠️ 平台会**当场去盘上核对**那个仓库(存在吗 / 是 git 吗 / HEAD 与记的一致吗 / " +
          "分支顶端就是它吗 / 根目录有 Dockerfile 吗),核对不过写不进去 —— " +
          "所以先把仓库建好、提交好、Dockerfile 写好,再来写这条交付物。",
      }),
    ),
    title: Type.String(),
    body: Type.String({
      description:
        "正文。要能被事后独立读懂 —— 见不到现场等于没有现场。" +
        "`html_report` 时它是一份 HTML 文档;`code_service` 时它是一份 markdown " +
        "说明(这个服务是什么 / 怎么构建 / 怎么部署到 Docker / 端口与外部依赖)。",
    }),
    status: Type.Optional(Type.String({ description: `${ARTIFACT_STATUSES.join(" | ")}(默认 open)` })),
    metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    workId: Type.Optional(
      Type.String({
        description:
          "产出这条工件的工作项 id(产出边)。**每次调用自己显式给** —— 平台不提供" +
          "「当前工作项」默认值:一次会话会连跑多个工作项,那个默认值会过期。" +
          "不传 = 这条工件不是任何工作项的执行产出(立项书 / 纪要 / 变更记录 /" +
          "甲方问答 / 质检意见),这是合法状态。必须与本次会话同项目。",
      }),
    ),
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
    const proj = requireProject(ctx, "board_write");
    if (!proj.ok) return proj.result;
    const pid = readString(args, "projectId") ?? proj.project.id;
    // **跨项目写要拦**。首跑真机实测:模型对着一个可选参数**自己猜了一个
    // projectId**,撞上 project_id 外键,报出来的却是一句裸的
    // "FOREIGN KEY constraint failed" —— 既没说哪条外键,也没说猜错了。
    //
    // 一次会话属于一个项目(ctx.project),往别的项目写几乎总是错的:
    // 要么是猜的(本例),要么是拿错了 id。真需要跨项目时那该是另一个会话。
    if (pid !== proj.project.id) {
      // 拒绝而不是「查一下你够不够格」:一次会话属于一个项目,往别的项目写
      // 几乎总是拿错了 id。真需要跨项目时那该是另一个会话 —— 让这条约束
      // 简单到不需要解释,比给它开一个需要判断的例外更安全。
      return fail(
        "denied",
        `本次会话属于项目 ${proj.project.id},不能往 ${pid} 写。` +
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

    // ── 交付物类型(migration 025)───────────────────────────────────
    //
    // 两条纪律,方向相反:
    //
    //   ① `kind='deliverable'` **必须**给类型 —— 交付物没有类型,读面就只能靠
    //      `body` 开头是不是 `<html` 去猜(本项目反复拒绝的启发式代理)。存量
    //      那 23 条 NULL 是历史事实,不该让**新**写入继续欠账。
    //   ② 非交付物工件**不许**给类型 —— 静默丢掉一个参数就是「不携带错误信息
    //      的偏差」被平台替模型抹平(7-D):模型会以为类型落库了,而库里没有。
    const deliverableTypeRaw = readString(args, "deliverableType");
    let deliverableType: DeliverableType | null = null;
    if (kind === "deliverable") {
      if (deliverableTypeRaw === undefined) {
        return fail(
          "invalid_args",
          `写交付物必须给 deliverableType(合法值:${DELIVERABLE_TYPES.join(" | ")})。` +
            "现在只有 html_report —— 凡是只有信息交付的东西(技术方案 / 架构图 / " +
            "汇报材料 / 评审结论 / 说明书)都写成一份自包含的 HTML 文档," +
            "平台会把它渲染成给甲方看的网页。",
          DELIVERABLE_TYPES,
        );
      }
      if (!isDeliverableType(deliverableTypeRaw)) {
        return fail(
          "invalid_args",
          `未知交付物类型「${deliverableTypeRaw}」。合法值:${DELIVERABLE_TYPES.join(" | ")}。`,
          DELIVERABLE_TYPES,
        );
      }
      deliverableType = deliverableTypeRaw;
      const bad = validateDeliverableBody(deliverableType, body.value);
      if (bad !== null) return fail("invalid_args", bad, DELIVERABLE_TYPES);
    } else if (deliverableTypeRaw !== undefined) {
      return fail(
        "invalid_args",
        `只有 kind='deliverable' 的工件能带 deliverableType,你写的是 kind='${kind}'。` +
          "不要传 —— 平台不会静默丢掉它(那样你会以为类型落库了)。",
      );
    }

    // ── `code_service`:**去盘上把坐标核对一遍**(migration 026)────────
    //
    // 这是「交付物类型」这件事第一次长出**牙齿**:`html_report` 的判据只能看
    // 正文本身(是不是 HTML),而一份代码服务的真假只有磁盘知道。
    //
    // 三条判据,缺一条这条交付物就是假的:
    //   ① `metadata` 必须带齐坐标(repoPath / branch / headCommit / service / port);
    //   ② 端口去核对仓库**真的存在、真的是 git、HEAD 与记的一致、分支顶端就是它、
    //      根目录有 Dockerfile**;
    //   ③ 核对通过之后,写进库的坐标是**平台读到的值**,不是模型写的值 ——
    //      模型把 headCommit 写成短 sha,库里就存全 sha;模型写错路径,
    //      压根进不来。
    //
    // ⚠️ **没有注入端口时拒绝,不放行。** 缺省放行等于「在这台机器上写一条
    // 假交付物是合法的」,而那种环境差异不会有人发现。
    let metadata = args["metadata"];
    if (deliverableType === "code_service") {
      const verified = verifyCodeService(ctx, metadata);
      if (!verified.ok) return verified.result;
      metadata = verified.metadata;
    }

    const statusRaw = readString(args, "status") ?? "open";
    if (!isArtifactStatus(statusRaw)) {
      return fail("invalid_args", `未知状态「${statusRaw}」`, ARTIFACT_STATUSES);
    }

    // ── 产出边(migration 014)─────────────────────────────────────
    //
    // **每次调用显式指名**。不用会话级的「当前工作项」默认值:一条会话会连跑
    // 多个工作项(`runtime/execution.ts` 的注释),而 `ToolRunContext` 是建会话时
    // 构造一次的 —— 放了默认值它会过期,于是产出边会记到**上一条**工作项头上。
    // 一条填错的边比一条空边糟得多:空边是「不知道」,错边是「知道错了」。
    //
    // 平台校验两件事:存在、且同项目 —— 写进去的外键只保证前者(`works(id)`),
    // 而跨项目引用在库里完全合法,只能在这里拦。
    const workIdRaw = readString(args, "workId");
    let workId: string | null = null;
    if (workIdRaw !== undefined) {
      const w = getWork(ctx.db, workIdRaw);
      if (w === null) {
        return fail(
          "not_found",
          `找不到工作项 ${workIdRaw} —— 产出边不能指向不存在的工作项。` +
            `要么改成正确的工作项 id,要么不传 workId(表示这条工件不是任何工作项的执行产出)。`,
        );
      }
      if (w.projectId !== pid) {
        return fail(
          "not_found",
          `工作项 ${workIdRaw} 属于项目 ${w.projectId},不是本次会话的项目 ${pid}。` +
            `产出边只记同一项目内的工作项;不传 workId 表示这条工件不是任何工作项的执行产出。`,
        );
      }
      workId = workIdRaw;
    }

    const id = ctx.newId("art");
    const at = ctx.now();
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
        workId,
        deliverableType,
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

    // 代码服务的坐标**如实回灌**:模型看不到自己写进去的是什么的话,它无法确认
    // 「平台核实到的 HEAD」是哪一个 —— 而下一轮它可能照着记忆再写一遍(7-D)。
    const csEcho = (() => {
      if (deliverableType !== "code_service" || metadata === null || typeof metadata !== "object") return "";
      const m = metadata as Record<string, unknown>;
      return (
        `\n· 仓库:${String(m["repoPath"] ?? "?")}(分支 ${String(m["branch"] ?? "?")})` +
        `\n· HEAD:${String(m["headCommit"] ?? "?")} · ${String(m["headSubject"] ?? "")}` +
        `\n· 提交数:${String(m["commitCount"] ?? "?")} · Dockerfile:${String(m["dockerfile"] ?? "?")}` +
        `\n· 服务名/端口:${String(m["service"] ?? "?")}:${String(m["port"] ?? "?")}` +
        `\n(以上是平台去盘上**核实过**的值,不是你写进来的原话)`
      );
    })();
    return ok(
      `已写工件 ${id}(${kind} · ${statusRaw})「${title.value}」` +
        (deliverableType !== null ? ` · 交付物类型:${deliverableType}` : "") +
        csEcho +
        (warnings.length > 0 ? `\n⚠️ 部分关联未建立:${warnings.join(";")}` : "") +
        // 把产出边如实回灌给模型 —— 否则它无法从工具输出里确认自己填对了,
        // 而下一次「这条工作项产出了什么」正是靠这行字。
        (workId !== null ? `\n产出工作项:${workId}` : ""),
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
