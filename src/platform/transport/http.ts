/**
 * 传输层 · HTTP 路由
 *
 * ── 这份实现的两条约束 ──────────────────────────────────────────
 *
 * **① 只读 harness。** 2026-10-04 经 jev 校准(p=0.990):本次只提供只读视图,
 * 写面(编辑提示词 / 改工具集合 / 备份 / 恢复出厂)留到单独一批。
 * 理由是它要重新实现旧系统 7-O 的四条规矩(闭合注册表防路径穿越、备份是写的
 * 前置、报成功=真生效、恢复出厂≠删文件)—— 那不是「顺手做」的量。
 * 用户可以**直接编辑** `~/.sansheng/harness/system_prompts/*.md`,不是能力缺失。
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
  listProjects, getProjectRow, insertProject, addMember,
} from "../storage/repo/projects.js";
import { getWork } from "../storage/repo/works.js";
import { getArtifact } from "../storage/repo/artifacts.js";
import { resolveClientQuestion } from "../tools/client.js";
import { ORG, ensureOrg, orgReady } from "../runtime/org.js";
import { loadPromptUnits, unitPath } from "../runtime/promptAssembly.js";
import { solveToolset } from "../harness/authorize.js";
import { loadProjectForAuthz } from "../storage/repo/projects.js";
import { ROLE_SPECS, PROJECT_ROLES, type ProjectRole } from "../identity/role.js";
import { listAgents } from "../storage/repo/agents.js";
import {
  listAllClientQuestions,
  listProjectArtifacts, listProjectAsks, listProjectBlockers,
  listProjectChanges, toProjectDetail, listProjectMembers,
  listProjectMessages, listProjectSummaries, toArtifactView, toProjectSummary,
  toWorkView,
} from "./views.js";
import type { HarnessView, PromptUnitView, RoleHarnessView } from "@shared/types/platform.js";

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
    for (const m of ORG) addMember(db, id, m.id, at);

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
    return c.json({ artifact: toArtifactView(db, row, (id) => id) });
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
 * 两件事必须如实呈现,它们是这个项目反复栽过的地方:
 *
 *  - `loaded: false` 的提示词单元 = **这条职责从没告诉过 agent**。
 *    它会照常工作,只是不知道那条规矩 —— 用户必须看得见(7-B 那一课的守卫)。
 *  - `ceiling` 是**代码内常量**,不是可编辑文件。前端要标注这一点,
 *    否则用户会以为改界面就能放开权限(7-E 的架构裁决:集合文件突破不了上界)。
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

    // 工具面:取一个"最宽松"的项目来求解,只为了展示 ceiling 的效果
    const anyProject = listProjects(db)[0];
    const project = anyProject !== undefined ? loadProjectForAuthz(db, anyProject.id) : null;
    const agent = listAgents(db).find((a) => a.role === role);
    const solved =
      project !== null && agent !== undefined
        ? solveToolset(
            {
              id: agent.id, role, displayName: agent.displayName,
              ...(agent.specialization !== null ? { specialization: agent.specialization } : {}),
            },
            project,
          )
        : null;

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
    });
  }

  return { roles, promptDir: join(dataDir, "harness", "system_prompts"), writable: false };
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
