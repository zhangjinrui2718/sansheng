/**
 * 传输层 · HTTP 路由
 *
 * ── 这份实现的两条约束 ──────────────────────────────────────────
 *
 * **① harness 只读视图 + 提示词单元写面。**
 * `GET /api/harness` 是只读视图(能力面 / 提示词装载情况 / **L2 集合文件状态**)。
 * 写面目前只有**提示词单元**(`PUT /api/harness/units/:id` 等三条,规矩见
 * `harness/write.ts` 文件头:闭合注册表防路径穿越、备份是写的前置、报成功=真生效、
 * 恢复出厂≠删文件)。
 * **工具集合文件(`harness/tools/{role}.json`)本批不提供写面** —— 用户直接编辑
 * 那个文件即可,它现在是**有读者的**(见 `harness/toolSet.ts`);视图会如实报出
 * 它的状态与它收掉了什么。给它加写面要重新实现同四条规矩,不是顺手做的量。
 *
 * **② 项目为中心。** 没有 `/api/conversations*`。对话就是项目的。
 * 这是设计 1 §0.1 问题三(「一切以对话为界,项目活不过一轮对话」)的接口面落点。
 *
 * ── 与旧 http.ts 的关系 ─────────────────────────────────────────
 *
 * 旧系统 31 条路由,其中一半服务于已删机制(blackboard 多实例、executors 状态、
 * tools/invoke 沙箱调用、facets 写面)。新路由 19 条,全部围绕新模型。
 * 两者并存直到阶段 15 清场。
 */
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import {
  listProjects, getProjectRow, insertProject,
} from "../storage/repo/projects.js";
import { getWork } from "../storage/repo/works.js";
import { getArtifact } from "../storage/repo/artifacts.js";
import { resolveClientQuestion } from "../tools/client.js";
import { ensureOrg, ensureProjectOrg, orgReady } from "../runtime/org.js";
import { loadPromptUnits, unitPath } from "../runtime/promptAssembly.js";
import { solveToolset } from "../harness/authorize.js";
import { resolveToolSet, strayToolSetFiles, toolSetDir } from "../harness/toolSet.js";
import { loadProjectForAuthz } from "../storage/repo/projects.js";
import { ROLE_SPECS, PROJECT_ROLES, type ProjectRole } from "../identity/role.js";
import { getAgent, listAgents } from "../storage/repo/agents.js";
import {
  listAllClientQuestions,
  listProjectArtifacts, listProjectAsks, listProjectBlockers,
  listProjectChanges, toProjectDetail, listProjectMembers,
  listProjectMessages, listProjectSummaries, toArtifactView, toProjectSummary,
  toMessageView,
  toWorkView,
} from "./views.js";
import { isSessionMessageKind } from "../storage/repo/sessions.js";
import type { SessionMessageKind, SessionMessageRow } from "../storage/repo/sessions.js";
import type {
  HarnessView, MemberConversationView, MemberConversationsResponse,
  PromptUnitView, RoleHarnessView, SessionMessageView,
} from "@shared/types/platform.js";
import type { ResetReport } from "../host/reset.js";
import {
  listBackups, promptUnitIds, resetPromptUnit, writePromptUnit, type FactoryDirs,
} from "../harness/write.js";

export interface HttpDeps {
  readonly db: Database.Database;
  readonly dataDir: string;
  readonly cwd: string;
  readonly personaName: string;
  readonly version: string;
  /** 当前 provider / model(健康检查与首屏用) */
  readonly modelId: string | null;
  readonly provider: string | null;
  readonly hasAnyProvider: boolean;
  /** 注入时钟 / id(测试可控) */
  readonly now: () => number;
  readonly newId: (prefix: string) => string;
  /** 清空平台数据(宿主注入 —— 它还要顺带丢掉常驻会话) */
  readonly reset: () => ResetReport;
  /** harness 写面的两个目录(数据目录 + 出厂副本目录) */
  readonly harnessDirs: FactoryDirs;
  /** 设置读写(复用旧 store —— 它是基础设施,不是旧系统的领域逻辑) */
  readonly settings: {
    read: () => unknown;
    write: (body: unknown) => Promise<{ ok: true; settings: unknown } | { ok: false; error: string }>;
    providers: () => unknown;
  };
}

const err = (code: string, message: string, status: 400 | 404 | 409 | 500 = 400) => ({
  body: { error: { code, message } },
  status,
});

export function createPlatformApp(deps: HttpDeps): Hono {
  const app = new Hono();
  const { db } = deps;

  // ── 基础 ──────────────────────────────────────────────────────

  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      version: deps.version,
      modelId: deps.modelId,
      provider: deps.provider,
      cwd: deps.cwd,
      dataDir: deps.dataDir,
    }),
  );

  app.get("/api/config", (c) =>
    c.json({ cwd: deps.cwd, personaName: deps.personaName, hasAnyProvider: deps.hasAnyProvider }),
  );

  app.get("/api/settings", (c) => c.json(deps.settings.read()));

  app.put("/api/settings", async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    if (body === null) return c.json(err("invalid_body", "请求体不是合法 JSON").body, 400);
    const r = await deps.settings.write(body);
    return r.ok ? c.json(r) : c.json(err("settings_write_failed", r.error).body, 400);
  });

  app.get("/api/providers", (c) => c.json({ providers: deps.settings.providers() }));

  // ── 项目 ──────────────────────────────────────────────────────

  app.get("/api/projects", (c) => {
    const status = c.req.query("status");
    const allowed = ["draft", "active", "paused", "done", "abandoned"] as const;
    const filter = allowed.find((s) => s === status);
    return c.json({ projects: listProjectSummaries(db, filter) });
  });

  app.post("/api/projects", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      name?: unknown; client?: unknown; goal?: unknown;
    } | null;
    if (body === null) return c.json(err("invalid_body", "请求体不是合法 JSON").body, 400);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const goal = typeof body.goal === "string" ? body.goal.trim() : "";
    if (name === "") return c.json(err("invalid_args", "name 不能为空").body, 400);
    if (goal === "") {
      // 立项而不写目标 = 下游所有人都会做出一堆自感觉良好但甲方不要的东西。
      // 这不是格式校验,是设计 1 §1「收敛诉求」那条规矩的接口面落点。
      return c.json(err("invalid_args", "goal 不能为空 —— 立项必须说清做成什么样算成").body, 400);
    }

    const at = deps.now();
    // 组织不在就建 —— 用户第一次打开界面时不该先去命令行跑一遍
    const createdOrg = ensureOrg(db, at);
    const id = deps.newId("pj");
    insertProject(db, {
      id,
      name,
      client: typeof body.client === "string" && body.client.trim() !== "" ? body.client.trim() : "(未指定)",
      goal,
      status: "active",
      createdAt: at,
    });
    // 整个组织一起进来 —— 单一落点,与 project_open 走同一个 helper
    ensureProjectOrg(db, id, at);

    const row = getProjectRow(db, id);
    if (row === null) return c.json(err("internal", "项目刚建好却读不到", 500).body, 500);
    return c.json({ project: toProjectSummary(db, row), createdOrg }, 201);
  });

  app.get("/api/projects/:id", (c) => {
    const row = getProjectRow(db, c.req.param("id"));
    if (row === null) return c.json(err("not_found", "项目不存在", 404).body, 404);
    const detail = toProjectDetail(db, row);
    return detail === null
      ? c.json(err("internal", "项目详情装配失败", 500).body, 500)
      : c.json({ project: detail });
  });

  app.get("/api/projects/:id/works", (c) => {
    const row = getProjectRow(db, c.req.param("id"));
    if (row === null) return c.json(err("not_found", "项目不存在", 404).body, 404);
    const detail = toProjectDetail(db, row);
    return c.json({ works: detail?.works ?? [] });
  });

  app.get("/api/projects/:id/artifacts", (c) => {
    const id = c.req.param("id");
    if (getProjectRow(db, id) === null) return c.json(err("not_found", "项目不存在", 404).body, 404);
    const kind = c.req.query("kind");
    const status = c.req.query("status");
    const limitRaw = Number(c.req.query("limit"));
    const artifacts = listProjectArtifacts(db, id, {
      ...(kind !== undefined ? { kind: kind as never } : {}),
      ...(status !== undefined ? { status: status as never } : {}),
      ...(Number.isFinite(limitRaw) && limitRaw > 0 ? { limit: Math.min(limitRaw, 500) } : {}),
    });
    return c.json({ artifacts });
  });

  app.get("/api/projects/:id/messages", (c) => {
    const id = c.req.param("id");
    if (getProjectRow(db, id) === null) return c.json(err("not_found", "项目不存在", 404).body, 404);
    return c.json({ projectId: id, messages: listProjectMessages(db, id) });
  });

  /**
   * 「谁产生了什么对话」—— 成员页的清单(设计 1 §2.10 / §2.12 的 A3)。
   *
   * ⚠️ **为什么不能让客户端拿 `/messages` 自己分组**:那条读函数是
   * `listProjectMessages`(`views.ts`),它**没有** agent 谓词,而每条会话取的是
   * `ORDER BY created_at LIMIT n` 的**最早** n 条、最后再 `slice(-n)` ——
   * 于是「消息多的项目」会**静默少数**:界面上显示「业务经理 3 条」而库里是 30 条,
   * 两边都长得一样正常。条数只能由 SQL `GROUP BY agent_id` 给出。
   */
  app.get("/api/projects/:id/member-conversations", (c) => {
    const id = c.req.param("id");
    if (getProjectRow(db, id) === null) return c.json(err("not_found", "项目不存在", 404).body, 404);
    const raw = Number(c.req.query("limit"));
    const limit = Number.isFinite(raw) && raw > 0
      ? Math.min(Math.floor(raw), MEMBER_GROUP_LIMIT_MAX)
      : MEMBER_GROUP_LIMIT;
    return c.json(memberConversations(db, id, limit));
  });

  // ── 接待会话(第一个项目之前)──────────────────────────────────
  //
  // 与 `/api/projects/:id/messages` **同一个读函数**,只是 projectId 传 null。
  // 接待会话没有项目可挂,所以它不能走上面那条带 :id 的路由;但它也不是
  // 「对话可以脱离项目独立存在」的翻案 —— 全局只有一条接待会话,项目一立起来
  // 它就结束(消息迁进新项目)。
  //
  // 没有接待会话时返回空列表而不是 404:那正是「还没聊过」的如实回答,
  // 而 404 会让前端把首屏显示成一次错误。
  app.get("/api/intake/messages", (c) =>
    c.json({ projectId: null, messages: listProjectMessages(db, null) }),
  );

  app.get("/api/projects/:id/asks", (c) => {
    const id = c.req.param("id");
    if (getProjectRow(db, id) === null) return c.json(err("not_found", "项目不存在", 404).body, 404);
    return c.json({ asks: listProjectAsks(db, id) });
  });

  app.get("/api/projects/:id/blockers", (c) => {
    const id = c.req.param("id");
    if (getProjectRow(db, id) === null) return c.json(err("not_found", "项目不存在", 404).body, 404);
    return c.json({ blockers: listProjectBlockers(db, id) });
  });

  app.get("/api/projects/:id/changes", (c) => {
    const id = c.req.param("id");
    if (getProjectRow(db, id) === null) return c.json(err("not_found", "项目不存在", 404).body, 404);
    return c.json({ changes: listProjectChanges(db, id) });
  });

  app.get("/api/projects/:id/members", (c) => {
    const id = c.req.param("id");
    if (getProjectRow(db, id) === null) return c.json(err("not_found", "项目不存在", 404).body, 404);
    return c.json({ members: listProjectMembers(db, id) });
  });

  // ── 工件 ──────────────────────────────────────────────────────

  app.get("/api/artifacts/:id", (c) => {
    const row = getArtifact(db, c.req.param("id"));
    if (row === null) return c.json(err("not_found", "工件不存在", 404).body, 404);
    // authorName 要**解析**,不能回 agent id —— 同一个工件,列表端点回
    // 「工程师」而详情端点回「wk」,前端只能照实显示一个不像名字的东西。
    // (这个 bug 是并行 subagent 逐字段比对两个端点时发现的。)
    return c.json({
      artifact: toArtifactView(db, row, (id) => getAgent(db, id)?.displayName ?? id),
    });
  });

  // ── 等甲方答的问题(全项目)────────────────────────────────────

  app.get("/api/client-questions", (c) => c.json({ questions: listAllClientQuestions(db) }));

  app.post("/api/client-questions/:id/answer", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { answer?: unknown } | null;
    if (body === null) return c.json(err("invalid_body", "请求体不是合法 JSON").body, 400);
    const answer = typeof body.answer === "string" ? body.answer.trim() : "";
    if (answer === "") return c.json(err("invalid_args", "answer 不能为空").body, 400);

    // 答复由业务经理署名 —— 它是唯一与甲方对话的角色,用户答的话在语义上
    // 就是「业务经理记录下的甲方答复」
    const r = resolveClientQuestion(db, c.req.param("id"), answer, deps.now(), {
      newId: deps.newId,
      answeredByAgentId: "bm",
    });
    if (!r.ok) {
      const map: Record<string, [string, 400 | 404 | 409]> = {
        not_found: ["not_found", 404],
        not_a_question: ["not_a_question", 400],
        already_resolved: ["already_resolved", 409],
      };
      const [code, status] = map[r.reason ?? "not_found"] ?? ["internal", 400];
      const msg: Record<string, string> = {
        not_found: "问题不存在",
        not_a_question: "该工件不是一个对甲方的提问",
        already_resolved: "这个问题已经答过了",
      };
      return c.json(err(code, msg[r.reason ?? "not_found"] ?? "答复失败", status).body, status);
    }
    return c.json({ ok: true, decisionArtifactId: r.decisionArtifactId });
  });

  // ── harness(只读)────────────────────────────────────────────

  app.get("/api/harness", (c) => c.json(buildHarnessView(db, deps.dataDir)));

  // ── 重置(维护端点)────────────────────────────────────────────
  //
  // 按最新的设计实现:**清数据**,不是删文件。旧系统删 .db 文件是因为它的
  // kernel/storage/ws 生命周期纠缠在一起、关连接重开比清表更容易写对;
  // 新架构没有这个理由(仓储是纯函数,schema 由 migration 拥有)。
  // 所以这里不关连接、不重建宿主、WebSocket 不断。
  //
  // `confirm` 约定保留 —— 那是防误触,**不是兼容性**。
  app.post("/api/reset", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
    if (body?.confirm !== "reset") {
      return c.json(
        err("confirmation_required", '需要确认:请求体传 {"confirm":"reset"}').body,
        400,
      );
    }
    const report = deps.reset();
    return c.json({ ok: true, cleared: report.cleared, totalRows: report.totalRows });
  });

  // ── harness 写面(7-O 的四条规矩见 harness/write.ts 文件头)──────

  app.put("/api/harness/units/:unitId", async (c) => {
    const unitId = c.req.param("unitId");
    const body = (await c.req.json().catch(() => null)) as { content?: unknown } | null;
    if (body === null || typeof body.content !== "string") {
      return c.json(err("invalid_args", "请求体需要 { content: string }").body, 400);
    }
    const r = writePromptUnit(deps.harnessDirs, unitId, body.content, deps.now());
    if (!r.ok) {
      const code = r.reason === "unknown_unit" ? "unknown_unit" : "write_failed";
      const status = r.reason === "unknown_unit" ? 404 : 500;
      return c.json(
        {
          error: {
            code,
            message: r.detail ?? "写入失败",
            // 让调用方知道合法 id 有哪些(而不是去猜)
            ...(r.reason === "unknown_unit" ? { validIds: promptUnitIds() } : {}),
          },
        },
        status,
      );
    }
    // 规矩③:返回的是**回读**到的正文
    return c.json({
      ok: true,
      content: r.content,
      ...(r.backupPath !== undefined ? { backupPath: r.backupPath } : {}),
    });
  });

  app.post("/api/harness/units/:unitId/reset", async (c) => {
    const unitId = c.req.param("unitId");
    const body = (await c.req.json().catch(() => null)) as { confirm?: unknown } | null;
    if (body?.confirm !== "reset") {
      return c.json(err("confirmation_required", '需要确认:{"confirm":"reset"}').body, 400);
    }
    const r = resetPromptUnit(deps.harnessDirs, unitId, deps.now());
    if (!r.ok) {
      return c.json(
        { error: { code: r.reason ?? "reset_failed", message: r.detail ?? "恢复出厂失败" } },
        r.reason === "unknown_unit" ? 404 : 500,
      );
    }
    return c.json({ ok: true, content: r.content });
  });

  app.get("/api/harness/units/:unitId/backups", (c) =>
    c.json({ backups: listBackups(deps.dataDir, c.req.param("unitId")) }),
  );

  // ── 记忆画像(结构化摘要,与片段互补)──────────────────────────
  //
  // 旧系统有 `/api/profile`(读)与 `/api/profile/:key`(写)。新架构里画像与
  // 片段是**两层**:片段是流水式记录(「用户说过 X」),画像是当前的结构化摘要
  // (「用户是谁」)。两者都在 BC7,都经 MemoryPort 的存储层。
  app.get("/api/profile", (c) => {
    const rows = db
      .prepare(`SELECT id, payload_json, updated_at FROM memory_profile ORDER BY id`)
      .all() as Array<{ id: string; payload_json: string; updated_at: number }>;
    const entries: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        entries[r.id] = JSON.parse(r.payload_json);
      } catch {
        // 坏掉的画像项不该让整个接口 500 —— 如实回一个标记
        entries[r.id] = { __unparsable: true };
      }
    }
    return c.json({ entries });
  });

  app.put("/api/profile/:key", async (c) => {
    const key = c.req.param("key");
    if (key.trim() === "" || key.includes("/")) {
      return c.json(err("invalid_args", "key 不合法").body, 400);
    }
    const body = (await c.req.json().catch(() => null)) as { value?: unknown } | null;
    if (body === null || body.value === undefined) {
      return c.json(err("invalid_args", "请求体需要 { value }").body, 400);
    }
    const at = deps.now();
    db.prepare(
      `INSERT INTO memory_profile (id, payload_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
    ).run(key, JSON.stringify(body.value), at);
    // 回读 —— 「报成功 = 真生效」这条在写面上处处适用
    const row = db.prepare(`SELECT payload_json, updated_at FROM memory_profile WHERE id = ?`)
      .get(key) as { payload_json: string; updated_at: number };
    return c.json({ ok: true, key, value: JSON.parse(row.payload_json), updatedAt: row.updated_at });
  });

  // ── 记忆 ──────────────────────────────────────────────────────

  app.get("/api/memory/fragments", (c) => {
    const limitRaw = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
    const rows = db
      .prepare(
        `SELECT id, kind, content, importance, access_count, created_at
         FROM memory_fragments ORDER BY importance DESC, created_at DESC LIMIT ?`,
      )
      .all(limit) as Array<{
        id: string; kind: string; content: string;
        importance: number; access_count: number; created_at: number;
      }>;
    return c.json({
      fragments: rows.map((r) => ({
        id: r.id, kind: r.kind, content: r.content,
        importance: r.importance, accessCount: r.access_count, createdAt: r.created_at,
      })),
    });
  });

  return app;
}

// ── harness 只读视图 ────────────────────────────────────────────

/**
 * 拼出四个角色的 harness 视图。
 *
 * 三件事必须如实呈现,它们是这个项目反复栽过的地方:
 *
 *  - `loaded: false` 的提示词单元 = **这条职责从没告诉过 agent**。
 *    它会照常工作,只是不知道那条规矩 —— 用户必须看得见(7-B 那一课的守卫)。
 *  - `ceiling` 是**代码内常量**,不是可编辑文件。前端要标注这一点,
 *    否则用户会以为改界面就能放开权限(7-E 的架构裁决:集合文件突破不了上界)。
 *  - `toolSet` 是 **L2 集合文件的真实状态**,`removedByToolSet` 是它生效的**证据**。
 *    在此之前这个视图只显示 ceiling,于是「用户改了 `harness/tools/*.json` 却看不到
 *    任何变化」在界面上无法与「已经生效」区分 —— 又一个「声称有、实际没有」。
 */
export function buildHarnessView(db: Database.Database, dataDir: string): HarnessView {
  const roles: RoleHarnessView[] = [];

  for (const role of PROJECT_ROLES) {
    const spec = ROLE_SPECS[role];
    const units = loadPromptUnits(dataDir, spec.promptUnits);
    const loadedSet = new Set(units.loaded);

    const promptUnits: PromptUnitView[] = spec.promptUnits.map((unitId) => {
      const path = unitPath(dataDir, unitId);
      const isLoaded = loadedSet.has(unitId);
      // 只读已装载的那些 —— 读失败就当没装载,不让整个接口 500
      const content = isLoaded ? unitContent(dataDir, unitId) : "";
      return { id: unitId, loaded: isLoaded, chars: content.length, content, path };
    });

    // ── 有效工具面 = L1 上界 ∩ scope ∩ L2 集合文件 ────────────────
    //
    // 有项目就取第一个项目求解(展示 ceiling 在项目内的效果);
    // **一个项目都没有时按接待模式求解**(project = null),而不是报一个空工具面 ——
    // 那时候业务经理确实拿得到 `project_open` 与记忆工具(见
    // harness/authorize.ts 的 INTAKE_CAPABILITIES),报 0 个工具会让用户以为
    // 它在第一个项目之前什么都做不了。
    const anyProject = listProjects(db)[0];
    const project = anyProject !== undefined ? loadProjectForAuthz(db, anyProject.id) : null;
    const agent = listAgents(db).find((a) => a.role === role);
    const authzAgent =
      agent !== undefined
        ? {
            id: agent.id,
            role,
            displayName: agent.displayName,
            ...(agent.specialization !== null ? { specialization: agent.specialization } : {}),
          }
        : null;

    const toolSet = resolveToolSet(dataDir, role);

    // 两个解:**出厂面**(不过集合文件)与**有效面**(过集合文件)。
    // 两者之差就是「这份 JSON 收掉了什么」—— 用户看得见自己改动的效果。
    const factorySolved = authzAgent !== null ? solveToolset(authzAgent, project) : null;
    const solved = authzAgent !== null ? solveToolset(authzAgent, project, toolSet.file) : null;

    const effective = new Set(solved?.tools ?? []);
    const removedByToolSet =
      factorySolved !== null
        ? factorySolved.tools.filter((t) => !effective.has(t))
        : [];

    roles.push({
      role,
      displayName: displayNameOf(role),
      clientFacing: spec.clientFacing,
      ceiling: [...spec.ceiling],
      writeKinds: [...spec.writeKinds],
      boundaryDeny: [...spec.boundaryDeny],
      promptUnits,
      tools: solved !== null ? [...solved.tools] : [],
      blockedByCeiling: solved !== null ? solved.blockedByCeiling.map((d) => d.subject) : [],
      unknownTools: solved !== null ? solved.unknownTools.map((d) => d.subject) : [],
      toolSet: {
        path: toolSet.path,
        state: toolSet.state,
        allow: toolSet.file !== undefined ? [...toolSet.file.allow] : [],
        deny: toolSet.file !== undefined ? [...toolSet.file.deny] : [],
        removedByToolSet: [...removedByToolSet].sort(),
        ...(toolSet.problem !== undefined ? { problem: toolSet.problem.detail } : {}),
      },
    });
  }

  return {
    roles,
    promptDir: join(dataDir, "harness", "system_prompts"),
    toolsDir: toolSetDir(dataDir),
    strayToolSetFiles: [...strayToolSetFiles(dataDir)],
    writable: true,
  };
}

/**
 * 读单元正文。**失败返回空串而不是抛** —— 一个坏掉的提示词文件不该让
 * 整个 harness 页面打不开(用户正是为了排查它才打开那个页面的)。
 */
function unitContent(dataDir: string, unitId: string): string {
  try {
    return readFileSync(unitPath(dataDir, unitId), "utf8");
  } catch {
    return "";
  }
}

const DISPLAY: Readonly<Record<ProjectRole, string>> = {
  business_manager: "业务经理",
  project_manager: "项目经理",
  worker: "Worker(执行者)",
  quality_reviewer: "质检审查员",
};

function displayNameOf(role: ProjectRole): string {
  return DISPLAY[role];
}

// ── 成员页的「他产生了什么对话」清单 ──────────────────────────────
//
// ⚠️ **这段 SQL 落在 transport 层是 A3 的一处已知层次妥协**:它本该在
// `storage/repo/sessions.ts`(查询)与 `transport/views.ts`(行 → 视图)里,
// 但这两个文件**不在本批次的可碰清单内**。纪律照抄 repo 那层的写法:
//   · 未知 `kind` **抛错**(`isSessionMessageKind`),不静默透出一个没定义的种类;
//   · `agent_id` 的 NULL 用 `IS ?` 匹配(`= NULL` 恒为 unknown,一条也查不出来);
//   · 条数来自 `GROUP BY`,消息只是「每组的最近一页」。

/** 每组默认带多少条消息(与 `/messages` 的 200 同量级)—— **不影响 `total`**。 */
const MEMBER_GROUP_LIMIT = 200;
const MEMBER_GROUP_LIMIT_MAX = 500;

interface AgentKindCount {
  total: number;
  byKind: Partial<Record<SessionMessageKind, number>>;
}

/**
 * 按 `agent_id` 分组的会话消息。
 *
 * `total` 与 `byKind` 来自一次 `GROUP BY agent_id, kind`;`messages` 是每组
 * **新的在前**的最多 `limit` 条。两者分开取是有意的:`LIMIT` 是分页,
 * 不是计数 —— 混在一起的那一版会在消息变多时静默少数。
 */
export function memberConversations(
  db: Database.Database,
  projectId: string,
  limit: number,
): MemberConversationsResponse {
  const counts = db
    .prepare(
      `SELECT m.agent_id AS agentId, m.kind AS kind, COUNT(*) AS n
         FROM session_messages m
         JOIN project_sessions s ON s.id = m.session_id
        WHERE s.project_id = ?
        GROUP BY m.agent_id, m.kind`,
    )
    .all(projectId) as Array<{ agentId: string | null; kind: string; n: number }>;

  const agg = new Map<string | null, AgentKindCount>();
  for (const row of counts) {
    if (!isSessionMessageKind(row.kind)) {
      // 与 repo 同一条纪律:表里出现未定义 kind 是数据错误,不是「跳过它」
      throw new Error(`session_messages 表里出现未定义 kind「${row.kind}」`);
    }
    const cur = agg.get(row.agentId) ?? { total: 0, byKind: {} };
    cur.total += row.n;
    cur.byKind[row.kind] = (cur.byKind[row.kind] ?? 0) + row.n;
    agg.set(row.agentId, cur);
  }

  const msgStmt = db.prepare(
    // `IS ?` 而不是 `= ?`:接待/系统那条 agent_id 为 NULL,`= NULL` 永远查不出来
    `SELECT m.id, m.session_id, m.agent_id, m.kind, m.content, m.created_at
       FROM session_messages m
       JOIN project_sessions s ON s.id = m.session_id
      WHERE s.project_id = ? AND m.agent_id IS ?
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?`,
  );

  const groups: MemberConversationView[] = [];
  // 名字解析与 `/messages` 同判据(agentNameCache 未导出,这里内联同一件事):
  // 查得到用 displayName,查不到回 id —— **不回空串**,空串在界面上看不出是缺失。
  const name = (id: string): string => getAgent(db, id)?.displayName ?? id;
  // 顺序固定(agentId 字典序、NULL 最后)—— 呈现顺序是页面的事,但接口不能
  // 每次返回不同顺序,否则「同一份数据两次请求不一样」无法比对。
  const agentIds = [...agg.keys()].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  for (const agentId of agentIds) {
    const c = agg.get(agentId);
    if (c === undefined) continue;
    const rows = msgStmt.all(projectId, agentId, limit) as Array<{
      id: string; session_id: string; agent_id: string | null;
      kind: string; content: string; created_at: number;
    }>;
    const messages: SessionMessageView[] = rows.map((r) => {
      if (!isSessionMessageKind(r.kind)) {
        throw new Error(`session_messages 表里出现未定义 kind「${r.kind}」(id=${r.id})`);
      }
      const row: SessionMessageRow = {
        id: r.id, sessionId: r.session_id, agentId: r.agent_id,
        kind: r.kind, content: r.content, createdAt: r.created_at,
      };
      return toMessageView(row, name, projectId);
    });
    // `agents.role` 的读时解析(角色只在库里存一处 —— 与 `MemberView.role` 同源)。
    // `getAgent` 在角色越界时抛错,所以这里拿到的已经是 `ProjectRole`。
    const agent = agentId === null ? null : getAgent(db, agentId);
    groups.push({
      agentId,
      agentName: agentId === null ? null : name(agentId),
      role: agent === null ? null : agent.role,
      total: c.total,
      byKind: c.byKind,
      messages,
      truncated: c.total > messages.length,
    });
  }

  return { projectId, limit, groups };
}
