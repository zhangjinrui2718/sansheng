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
import {
  getArtifact,
  listIndexedBodyPaths,
  type IndexedBodyPathList,
} from "../storage/repo/artifacts.js";
import { projectWorkspaceRoot } from "../workspace/root.js";
import { scanWorkspace, type WorkspaceScan } from "../workspace/scan.js";
import type { CodeServicePort } from "../codeservice/port.js";
import { resolveClientQuestion } from "../tools/client.js";
import { ensureOrg, ensureProjectOrg, orgReady, roleDisplayName } from "../runtime/org.js";
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
  listProjectMessages, listProjectSummaries, toArtifactView, toProjectLiveView,
  toIntakeLiveView,
  toProjectSummary,
  toMessageView, toProjectUsageView,
  toWorkView,
  type LiveCollectOptions, type LiveRuntimeSnapshot,
} from "./views.js";
import {
  aggregateProjectUsage, normalizeUsageDayLimit, normalizeUsageDays,
} from "../storage/repo/usage.js";
import { ensureSession } from "../transport/hub.js";
import {
  getSession, insertSession, listSessions, listSessionMessages,
  isSessionMessageKind, isSessionMessageSource, isSessionMessageTodoKind, isSessionMessageTriggerKind,
} from "../storage/repo/sessions.js";
import type { SessionMessageKind, SessionMessageRow } from "../storage/repo/sessions.js";
import type {
  HarnessView, MemberConversationView, MemberConversationsResponse,
  PromptUnitView, RoleHarnessView, SessionMessageView, WorkspaceView,
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
  /**
   * **宿主运行期快照**(忙闩 + 兜底定时器心跳 + 正在排空的项目)—— 只读。
   *
   * 它回答的是**「现在」**,而这件事只有宿主的内存知道:`works` 里没有「正在跑」
   * 这一列,`turn_usage` 是回合**结束**时才落的行。所以这条依赖是**可选**的 ——
   * 只挂 HTTP 的装配(测试、诊断)拿不到它,那时 `GET /api/projects/:id/live`
   * 会如实返回 `runtime: "unavailable"`,而**不是**把「读不到」显示成「没在跑」。
   */
  readonly live?: {
    /** 此刻占着忙闩的回合 */
    readonly turns: () => LiveRuntimeSnapshot["turns"];
    /** 兜底定时器的心跳 */
    readonly dispatch: () => LiveRuntimeSnapshot["dispatch"];
    /** 此刻正在排空的项目 id */
    readonly drainingProjects: () => readonly string[];
    /**
     * `collectTodos` 的旋钮 —— **与宿主排空时用的是同一份**(见
     * `views.ts` 的 `LiveCollectOptions`)。少了这一项,命令行改了合并窗口之后
     * 页面会继续按缺省值说「现在就该跑」。
     */
    readonly collect: LiveCollectOptions;
  };
  /** 清空平台数据(宿主注入 —— 它还要顺带丢掉常驻会话) */
  readonly reset: () => ResetReport;
  /** harness 写面的两个目录(数据目录 + 出厂副本目录) */
  readonly harnessDirs: FactoryDirs;
  /**
   * **代码服务的核对面**(migration 026)。用来读一个代码服务交付物的**最近提交**
   * —— 那是「这一版到底改了什么」的唯一现场,而它只有在盘上才读得到。
   *
   * ⚠️ **可选**:只挂 HTTP 的装配(测试、诊断)拿不到它,那时端点返回
   * `runtime: "unavailable"`,而**不是**把读不到渲染成「没有提交」——
   * 与 `live` 那条同源:读不到不是空。
   */
  readonly codeService?: CodeServicePort;
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

/**
 * 把「一次扫描 + 索引侧状态」装配成 `WorkspaceView`(设计 §4.4)。
 *
 * 抽成**纯函数**而不是写在路由里:三件容易做错的事都发生在这几行 ——
 *   ① `indexed` 标记必须来自**这次扫描**的对账结果,不是「索引里有这条路径」
 *      (索引里有、盘上无的那种是 `missing`,不是 `indexed`);
 *   ② `counts` 与三个数组必须同源(各算一遍迟早会出现「计数说 3、列表两条」);
 *   ③ `missing` 要带回工件身份(只给路径的话,用户还得自己去库里找是哪件工件)。
 *
 * ⚠️ `index.runtime === "not_migrated"` 时 `missing` **必然是空** —— 不是
 * 「没有不一致」,是「没有索引可以比」。所以 `runtime` 是那个必须被渲染出来的
 * 字段,而空数组不能替它说话。
 */
function toWorkspaceView(opts: {
  projectId: string;
  root: string;
  scan: WorkspaceScan;
  index: IndexedBodyPathList;
}): WorkspaceView {
  const { projectId, root, scan, index } = opts;
  const indexedPaths = new Set(scan.indexed.map((e) => e.path));
  const byPath = new Map(index.paths.map((p) => [p.path, p]));
  return {
    projectId,
    root,
    runtime: scan.runtime,
    problem: scan.problem,
    entries: scan.entries.map((e) => ({
      path: e.path,
      kind: e.kind,
      bytes: e.bytes,
      mtimeMs: e.mtimeMs,
      indexed: indexedPaths.has(e.path),
    })),
    truncated: scan.truncated,
    counts: {
      entries: scan.entries.length,
      indexed: scan.indexed.length,
      orphanFile: scan.orphanFile.length,
    },
    missing: scan.missing.map((path) => {
      const hit = byPath.get(path);
      // `scan.missing` 是按索引路径算出来的,所以这里必然命中;命中不了说明两处
      // 对账用的是两份输入 —— 那时**照实报空 title**,不编一个(7-D)。
      return { path, artifactId: hit?.artifactId ?? "", title: hit?.title ?? "" };
    }),
    index: { runtime: index.runtime, paths: index.paths.length },
  };
}

export function createPlatformApp(deps: HttpDeps): Hono {
  const app = new Hono();
  const { db } = deps;

  /**
   * 用量视图的装配(两条端点共用)。
   *
   * ── `days` / `limit` 的边界(定清楚,不留「看情况」)──────────────
   *
   *   `days`  窗口长度,**含今日**共 `days` 个**本地日历日**。
   *           默认 7、上界 365;**非有限值 / ≤ 0 一律取默认**
   *           (与 `runTurn.wallClockTimeoutMs` 同一条规矩:坏值取默认,
   *            而不是「0 = 不设上界」—— 那等于把唯一的上界悄悄拆掉)。
   *   `limit` **只截 `byDay` 的天数**,默认 = `days`。它**绝不截** `totals` /
   *           `allTime` / `byAgent` —— 拿行数上限去截合计会让数字**静默变小**
   *           (历史一长,「今日花了多少」就开始撒谎),而那种数字看起来完全正常。
   *           截断时响应里 `byDayTruncated: true`,不静默。
   *
   * `now` 取 `deps.now()`(注入的时钟)—— 窗口与「今日」都以它为准,所以
   * 测试能穷举跨零点这类边界,而不必等真实的午夜。
   */
  function usageView(projectId: string | null, daysRaw: string | undefined, limitRaw: string | undefined) {
    const days = normalizeUsageDays(Number(daysRaw));
    const dayLimit = normalizeUsageDayLimit(Number(limitRaw), days);
    const agg = aggregateProjectUsage(db, projectId, { now: deps.now(), days, dayLimit });
    return toProjectUsageView(db, agg);
  }

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

  /**
   * **项目工作区 · 只读观测面**(设计 `docs/DESIGN-WORKSPACE.md` §4.4,**P0**)。
   *
   * 三块事实一次端出来:盘上有什么(`scanWorkspace` 的 entries)、索引引用了什么
   * (此刻 `body_path` 列还不存在 ⇒ `index.runtime: "not_migrated"`),以及两边
   * 的不一致(`missing` / `orphanFile`)。
   *
   * ⚠️ **`root` 现在与 `sessionCwd()` 无关。** `sessionCwd` 只在
   * `--isolate-project-cwd` 打开时才把会话放到项目目录里(P1 才动它),而这条
   * 读面问的是「这个项目的目录里有什么」—— 两件事今天可以指向同一个路径,
   * 但**判据不同**,所以这里走 `projectWorkspaceRoot` 而不是去复用会话那一个。
   *
   * ⚠️ **它不建目录**(`sessionCwd` 会 `mkdirSync`)。一个 GET 不该在盘上留东西
   * —— 目录不存在是**读不到**,由 `runtime: "unavailable"` 如实承载。
   */
  app.get("/api/projects/:id/workspace", (c) => {
    const id = c.req.param("id");
    if (getProjectRow(db, id) === null) {
      return c.json(err("not_found", "项目不存在", 404).body, 404);
    }
    const root = projectWorkspaceRoot(deps.cwd, id);
    const index = listIndexedBodyPaths(db, id);
    const scan = scanWorkspace({ root, indexedPaths: index.paths.map((p) => p.path) });
    return c.json({ workspace: toWorkspaceView({ projectId: id, root, scan, index }) });
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
    // ⚠️ `?sessionId=` —— 对话页**必须**传(migration 024):一个项目下面有多条
    // 对话线,不传就是**归并**(把所有的线混成一条),那在 1:1 的年代是对的。
    // ⚠️ 传了但那条线**不属于这个项目** ⇒ 404 而不是空列表 —— 空列表在界面上
    // 与「这条线还没有消息」**长得一模一样**(7-N:见不到的现场等于没有现场)。
    const sid = c.req.query("sessionId");
    if (sid !== undefined && getSession(db, sid)?.projectId !== id) {
      return c.json(err("not_found", `对话 ${sid} 不属于项目 ${id}`, 404).body, 404);
    }
    return c.json({ projectId: id, messages: listProjectMessages(db, id, 200, sid) });
  });

  /**
   * **这个项目下面有哪几条对话线**(migration 024)。
   *
   * ⚠️ 对话页的「我在看哪条线」是**单指针**,而项目底下现在可以有多条 ——
   * 所以前端必须有地方知道「有哪些」。`kind='main'` 那条排在最前:它是排空器
   * 触发的回合落的地方(待办是项目级的),也是不指定时的默认落点。
   */
  app.get("/api/projects/:id/sessions", (c) => {
    const id = c.req.param("id");
    if (getProjectRow(db, id) === null) return c.json(err("not_found", "项目不存在", 404).body, 404);
    // ⚠️ **保证主对话存在**(`ensureSession` 的语义,幂等)。不做这一步,一个
    // **刚立项、还没说过一句话**的项目会返回空列表 —— 而前端的对话页正是靠
    // 这个列表决定「我在看哪条线」的,空列表 ⇒ 没有线可看 ⇒ **既没有历史也
    // 发不出消息**(那条项目看上去像坏了)。
    //
    // 为什么一个 GET 会有副作用:`ensureSession` **本来就**是幂等的惰性建会话,
    // 而它的返回值在旧路径里是**必然有**的(前端从不问「有哪些会话」)。
    // 现在前端问了,就得有人回答「至少有主对话这一条」。
    ensureSession(db, id, deps.now(), deps.newId, "client");
    const rows = listSessions(db, id)
      .map((s) => {
        const last = listSessionMessages(db, s.id, 1);
        const lastAt = last.length > 0 ? last[0]!.createdAt : s.createdAt;
        // ⚠️ **交付会话的名字来自它交付的那份工件**(`handover` 开出来的那条)。
        //
        // 真机实测:一个跑完的项目底下有 **8 条**会话 —— 7 场交付各一条 + 1 条
        // 项目内部会话(C4 的设计:交付一条线,不让「哪条对话是哪场交付开的」
        // 变成猜的)。024 之后它们都叫 `main` 且没有 title,于是页签上会是
        // **8 个一模一样的「主对话」** —— 那不是信息,是噪音。
        //
        // 这里**不重写库里的 title**,只在读面兜底:工件的标题是**真数据**
        // (不是编的),而存量行改写 title 属于「为了好看去改事实」。
        const deliverable = s.deliverableArtifactId === null
          ? null
          : getArtifact(db, s.deliverableArtifactId);
        return {
          id: s.id,
          kind: s.kind,
          title: s.title ?? deliverable?.title ?? null,
          channel: s.channel,
          deliverableArtifactId: s.deliverableArtifactId,
          createdAt: s.createdAt,
          lastMessageAt: lastAt,
        };
      })
      // 主对话在前,其余按最近活跃度
      .sort((a, b) =>
        (a.kind === "main" ? 0 : 1) - (b.kind === "main" ? 0 : 1) || b.lastMessageAt - a.lastMessageAt,
      );
    return c.json({ projectId: id, sessions: rows });
  });

  /**
   * **另开一条对话线**。
   *
   * ⚠️ **谁起名由调用点决定,但平台不猜**:不传 `title` 就是 `null`,读面显示
   * 「对话」—— 编一个「对话 2」出来会让人以为甲方真的这么叫过。
   *
   * ⚠️ 开线是**可逆**的(没有「删线」之前它只增不减),所以这里没有确认门;
   * 而**关项目**不可逆,那一条才需要确认(见 `project_close`)。
   */
  app.post("/api/projects/:id/sessions", async (c) => {
    const id = c.req.param("id");
    if (getProjectRow(db, id) === null) return c.json(err("not_found", "项目不存在", 404).body, 404);
    let body: { title?: unknown } = {};
    try {
      body = (await c.req.json()) as { title?: unknown };
    } catch {
      body = {};
    }
    // ⚠️ **query 也认**(两种传法都试过,body 优先)。写这一行是因为**实测踩过**:
    // 前端 `createProjectSession` 当时把 title 放在 query 上,而这里只读 body ——
    // 开出来的线**永远没有名字**,而界面上它看起来只是「没起名」,不像接线断了。
    // 两种都收的成本是一行,而漏一种的代价是「功能看起来正常、实际不工作」。
    const qTitle = c.req.query("title");
    if (body.title === undefined && qTitle !== undefined) body.title = qTitle;
    if (body.title !== undefined && typeof body.title !== "string") {
      return c.json(err("invalid_args", "title 必须是字符串", 400).body, 400);
    }
    const title = typeof body.title === "string" && body.title.trim() !== ""
      ? body.title.trim()
      : null;
    const sid = deps.newId("s");
    insertSession(db, {
      id: sid,
      projectId: id,
      createdAt: deps.now(),
      // ⚠️ **`channel` 用 `internal`,不是 `client`** —— 与 `ensureSession` 的
      // 惰性建会话同一条纪律:甲方通道的会话只由平台在 `handover` 成功后开。
      // 在这里造一条 `client` 会话,会让「哪条对话是哪场交付开的」重新变成猜的。
      channel: "internal",
      kind: "thread",
      title,
    });
    return c.json({ sessionId: sid, projectId: id, kind: "thread", title }, 201);
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

  // ── 用量(回合烧了多少 token;migration 018 的 turn_usage)────────
  //
  // 两条端点,**同一个读函数**:项目 (`:id`) 与接待会话 (`null`)。
  // ⚠️ 接待会话那一条不是对称强迫症 —— 它是**产品里第一个花钱的回合**
  // (新用户第一次与业务经理说话)。只写不读等于「数据在手边却没有读者」,
  // 而那正是 018 文件头记着的那类缺陷。
  //
  // 没有接待会话时返回全零视图而不是 404(与 `/intake/messages` 同一条理由:
  // 404 会让首屏显示成一次错误,而「还没花过钱」是一个正常的答案)。
  app.get("/api/projects/:id/usage", (c) => {
    const id = c.req.param("id");
    if (getProjectRow(db, id) === null) {
      return c.json(err("not_found", "项目不存在", 404).body, 404);
    }
    return c.json({ usage: usageView(id, c.req.query("days"), c.req.query("limit")) });
  });

  app.get("/api/intake/usage", (c) =>
    c.json({ usage: usageView(null, c.req.query("days"), c.req.query("limit")) }),
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

  /**
   * 「**此刻**在做什么」—— 成员页的「正在做什么」区 + 工件页 DAG 的在跑标记。
   *
   * ── 为什么它是新的一条端点,而不是并进 `/members` ──────────────────
   *
   * 两个读者、两种代价:`/members` 是**身份**(四个角色,几乎不变,缓存友好),
   * 这一条是**运行态**(每次都在变,而且它读宿主内存 ⇒ 天然不可缓存)。并在一起
   * 会让「谁是这个项目的成员」这个稳定问题的答案每次都被重新算一遍。
   *
   * ── 三个来源,以及「读不到」为什么不等于「没在跑」────────────────
   *
   * 库(工作项 / 最近消息 / 待办)+ 宿主内存(忙闩 / 定时器心跳)。`deps.live`
   * 缺失时(只挂 HTTP 的装配)读面返回 `runtime: "unavailable"`,`turn` 与
   * `dispatch.lastRunAgeMs` 为 `null` —— **它不是「空闲」**,前端必须分开显示。
   *
   * ⚠️ 它**不参与任何判定**:没有一条流水线规则读这个视图。判定只有一处
   * (`runtime/dispatcher.ts` 的 `collectTodos`),这里只是把它的结果端出来。
   */
  app.get("/api/projects/:id/live", (c) => {
    const row = getProjectRow(db, c.req.param("id"));
    if (row === null) return c.json(err("not_found", "项目不存在", 404).body, 404);
    const runtime: LiveRuntimeSnapshot | null =
      deps.live === undefined
        ? null
        : {
            turns: deps.live.turns(),
            dispatch: deps.live.dispatch(),
            drainingProjects: deps.live.drainingProjects(),
          };
    const collect: LiveCollectOptions = deps.live?.collect ?? {};
    return c.json({ live: toProjectLiveView(db, row, deps.now(), runtime, collect) });
  });

  /**
   * **接待会话**的运行态 —— 与上面那条同源、同一份内存快照,只是上下文是 `null`。
   *
   * ⚠️ **没有它是 404**(2026-10-07 真机):对话页顶部那盏灯只由 WS 实时事件推出来,
   * 而 WS 没有回放 ⇒ 刷新或切走再切回来之后,一个**还在跑**的回合在接待里显示成
   * 「就绪」。项目那条有 `/live` 可查,接待连端点都没有。
   *
   * 与 `/api/intake/messages` 同一条理由:**没有接待会话时返回「读得到但没人跑」,
   * 不是 404** —— 404 会让前端把首屏显示成一次错误。
   */
  app.get("/api/intake/live", (c) => {
    const runtime: LiveRuntimeSnapshot | null =
      deps.live === undefined
        ? null
        : {
            turns: deps.live.turns(),
            dispatch: deps.live.dispatch(),
            drainingProjects: deps.live.drainingProjects(),
          };
    return c.json({ live: toIntakeLiveView(deps.now(), runtime) });
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

  /**
   * 代码服务交付物的**最近提交**(migration 026)。
   *
   * ── 为什么它不是「交付物的一部分」,而是一条**现读**的边 ────────────
   *
   * 写进 `metadata_json` 的坐标是**交付那一刻**的事实(HEAD 是哪个提交)。
   * 而「这个仓库后来越改了什么」是**另一个问题**,它的答案是**现在**去盘上读 ——
   * 存进库就会过期,而过期的快照看起来与新鲜的一模一样。
   *
   * 三条如实(都对应一种「屏幕上看不出」的错):
   *   · 工件不存在 → 404;
   *   · 工件不是 `code_service` → 400 并说明(不是回一个空列表);
   *   · 没接核对面 / 坐标里没有 `repoPath` / git 读不出来 → `runtime: "unavailable"`
   *     且带 `problem`,**不是** `commits: []`。
   */
  app.get("/api/artifacts/:id/commits", (c) => {
    const row = getArtifact(db, c.req.param("id"));
    if (row === null) return c.json(err("not_found", "工件不存在", 404).body, 404);
    if (row.deliverableType !== "code_service") {
      return c.json(
        err(
          "invalid_args",
          `工件 ${row.id} 的 deliverableType 是 ${row.deliverableType ?? "null"},不是 code_service —— ` +
            `只有代码服务交付物才有仓库提交可读。`,
        ).body,
        400,
      );
    }
    const limitRaw = Number(c.req.query("limit"));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
    const cs = deps.codeService;
    const view = toArtifactView(db, row, (id) => getAgent(db, id)?.displayName ?? id);
    if (cs === undefined || view.codeService?.repoPath == null) {
      return c.json({
        runtime: "unavailable" as const,
        commits: null,
        head: view.codeService?.headCommit ?? null,
        branch: view.codeService?.branch ?? null,
        problem:
          cs === undefined
            ? "本次装配没有接上代码服务核对面(HTTP 侧拿不到磁盘)"
            : "这条交付物的坐标里没有 repoPath,读不到仓库",
      });
    }
    const commits = cs.recentCommits(view.codeService.repoPath, limit);
    if (commits === null) {
      return c.json({
        runtime: "unavailable" as const,
        commits: null,
        head: view.codeService.headCommit,
        branch: view.codeService.branch,
        problem: `读不到仓库 ${view.codeService.repoPath} 的提交(目录被移走 / 删掉,或 git 不可用)`,
      });
    }
    return c.json({
      runtime: "ok" as const,
      commits,
      head: view.codeService.headCommit,
      branch: view.codeService.branch,
    });
  });

  // ── 等甲方答的问题(全项目)────────────────────────────────────

  // 载荷形状就是 `listAllClientQuestions` 的返回值(含 `fromClosedProjects`)——
// 那条计数必须**一起**出去,前端才可能显示「为什么不在这队列里」,而不是静默少几条。
app.get("/api/client-questions", (c) => c.json(listAllClientQuestions(db)));

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
      // 「这一栏求解过了没有」——没有 agent 行时 `tools: []` **不是「0 个」,是
      // 「算不出来」**。两者在界面上必须分开,否则成员页会显示一个看起来很正常的
      // 「实得工具 0 个」(2026-10-05 真机现场)。
      toolsSolved: solved !== null,
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

/**
 * ⚠️ 这里**不再**有自己的名字表(2026-10-06)。它原来写着
 * `worker: "Worker(执行者)"` —— 同一个角色在 harness 页与成员页各有一个名字,
 * 而且其中一个还带括号解释。用户的原话:「四个角色的命名统一一下,就不要有解释了」。
 *
 * 现在只有一处:`runtime/org.ts` 的 `ORG`(`roleDisplayName`),与组织播种共用
 * 同一张表 —— 界面显示名与 `agents.display_name` 从而**结构上**不会漂。
 */
function displayNameOf(role: ProjectRole): string {
  return roleDisplayName(role);
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
    //
    // ⚠️ 两列封套(`origin_source` / `trigger_kind`,migration 019)**必须显式
    // 列出**:这条 SQL 不是 `SELECT *` —— 漏了它们,成员页拿到的那一页消息就
    // 全是 `unknown`,而这与「存量行」在类型上长得一模一样(见
    // `views.ts` 的 `messageOriginOf`)。
    `SELECT m.id, m.session_id, m.agent_id, m.kind, m.content, m.created_at,
            m.origin_source, m.trigger_kind, m.todo_kind
       FROM session_messages m
       JOIN project_sessions s ON s.id = m.session_id
      WHERE s.project_id = ? AND m.agent_id IS ?
      ORDER BY m.created_at DESC, m.id DESC
      LIMIT ?`,
  );

  const groups: MemberConversationView[] = [];
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
    // `agents.role` / 显示名的读时解析(角色只在库里存一处 —— 与 `MemberView.role` 同源;
    // `getAgent` 在角色越界时抛错,所以拿到的已经是 `ProjectRole`)。
    // **每组只查一次**:一组里的每一行都是同一个 agent(`views.ts` 的
    // `agentNameCache` 是为同一件事而存在的),逐条查是把「几十次」变成「几百次」。
    const agent = agentId === null ? null : getAgent(db, agentId);
    // 查不到就回 id —— **不回空串**,空串在界面上看不出是缺失。
    const agentName = agentId === null ? null : (agent?.displayName ?? agentId);
    const nameOfGroup = (): string => agentName ?? "";
    const rows = msgStmt.all(projectId, agentId, limit) as Array<{
      id: string; session_id: string; agent_id: string | null;
      kind: string; content: string; created_at: number;
      origin_source: string | null; trigger_kind: string | null; todo_kind: string | null;
    }>;
    const messages: SessionMessageView[] = rows.map((r) => {
      if (!isSessionMessageKind(r.kind)) {
        throw new Error(`session_messages 表里出现未定义 kind「${r.kind}」(id=${r.id})`);
      }
      // 封套闭集的校验与映射**只有一处**(`repo/sessions.ts` 的
      // `listSessionMessages` + `views.ts` 的 `messageOriginOf`)—— 这里复用同
      // 两个守卫,不复制闭集、也不用断言糊过去。
      if (r.origin_source !== null && !isSessionMessageSource(r.origin_source)) {
        throw new Error(
          `session_messages 表里出现未定义 origin_source「${r.origin_source}」(id=${r.id})`,
        );
      }
      if (r.trigger_kind !== null && !isSessionMessageTriggerKind(r.trigger_kind)) {
        throw new Error(
          `session_messages 表里出现未定义 trigger_kind「${r.trigger_kind}」(id=${r.id})`,
        );
      }
      if (r.todo_kind !== null && !isSessionMessageTodoKind(r.todo_kind)) {
        throw new Error(
          `session_messages 表里出现非法的 todo_kind「${r.todo_kind}」(id=${r.id})`,
        );
      }
      const row: SessionMessageRow = {
        id: r.id, sessionId: r.session_id, agentId: r.agent_id,
        kind: r.kind, content: r.content, createdAt: r.created_at,
        originSource: r.origin_source,
        triggerKind: r.trigger_kind,
        todoKind: r.todo_kind,
      };
      return toMessageView(row, nameOfGroup, projectId);
    });
    groups.push({
      agentId,
      agentName,
      role: agent === null ? null : agent.role,
      total: c.total,
      byKind: c.byKind,
      messages,
      truncated: c.total > messages.length,
    });
  }

  return { projectId, limit, groups };
}
