/**
 * Sansheng Hono app factory.
 * M0 健康检查 + 静态文件。
 * M1 /api/settings、/api/providers、WS。
 * M1.5 多 provider + 新建对话。
 * M3+ 注入多 agent / blackboard / artifacts 路由。
 */
import { Hono } from "hono";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { log } from "../shared/log.js";
import { SettingsStore, genProviderId, isMaskedApiKey, type ProviderConfig, type ThinkingLevel } from "./settings/store.js";
import { listProviders } from "./providers/registry.js";
import type { AgentKernel } from "./kernel/agentKernel.js";
import { attachWebSocket } from "./ws.js";
import { Storage } from "./storage/index.js";
import {
  getConversation,
  listConversations,
  listMessagesByConversation,
  listProfile,
  upsertProfile,
  getActiveBlackboard,
  listBlackboards,
  listFragmentsByKind,
  listFragmentsAll,
  listArtifacts,
  isVecAvailable,
} from "./storage/index.js";
import {
  createToolRegistry,
  type CreateToolRegistryOptions,
} from "./tools/integration.js";
import { registerBlackboardArtifactRoutes } from "./http/blackboardRoutes.js";
import { createSecurityMiddleware } from "./http/security.js";
// 批次 5b-2 T2:Harness 状态 API(manager 运行态 + prompts 摘要 + proposals/previews)
import { loadHarness, describePrompts, describeToolSets } from "./harness/loader.js";
import { describeHarness } from "./harness/facet.js";
import { FALLBACK_HARNESS_PROMPT, getHarnessManager } from "./agents/harnessManager.js";
import { getHarnessBootMeta } from "./agents/harnessBoot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = import.meta.dirname ?? join(__filename, "..");

export interface AppOptions {
  dataDir: string;
  kernel: AgentKernel;
  httpServer: Server;
  settingsStore: SettingsStore;
  storage: Storage;
  /**
   * 可选:把外部已建好的 ToolRegistry opts 传入(如显式 sandbox / netPolicy)。
   * 不传 → createApp 在初始化时自动调用 createToolRegistry()(异步,加载默认 sandbox + net policy)。
   */
  toolRegistryOptions?: CreateToolRegistryOptions;
}

/** 从任意 throw 值取可读错误信息。 */
function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// C9-4(审查 §C9)+ 4b 4a-OQ2:统一 ?limit= 解析。实现搬到 src/server/http/query.ts,
// 让 blackboardRoutes.ts(4a 当时显式留作 OQ 的静默回退点)也能共用同一契约
// —— 放进本文件会形成 blackboardRoutes → http 的循环依赖。
import { parseLimitQuery } from "./http/query.js";

/** 把内部 Settings 转成对外(掩码 apiKey)的 SettingsPublic */
function toPublic(s: ReturnType<SettingsStore["load"]>) {
  return {
    providers: s.providers.map((p) => ({
      id: p.id,
      label: p.label,
      provider: p.provider,
      modelId: p.modelId,
      apiKey: maskApiKey(p.apiKey),
      hasApiKey: p.apiKey.length > 0,
      baseUrl: p.baseUrl,
      thinkingLevel: p.thinkingLevel,
    })),
    activeProviderId: s.activeProviderId,
    cwd: s.cwd,
    personaName: s.personaName,
    costBudgetUsd: s.costBudgetUsd,
  };
}

export async function createApp(opts: AppOptions): Promise<Hono> {
  const app = new Hono();
  // —— B4: 安全守卫(Host + Origin/Sec-Fetch-Site 校验)——
  // 必须注册在所有中间件(含下方 logger)与路由之前:Hono 按注册顺序执行,
  // 之后注册的任何处理路径(含 serveStatic 兜底)都先过校验。
  // (docs/CODE-REVIEW-2026-10-01.md §B4:CSRF 删库面 + DNS rebinding)
  app.use("*", createSecurityMiddleware());
  const settingsStore = opts.settingsStore;
  // M4: ToolRegistry(fs+http 6 件套)全局单例,每次 HTTP request 复用。
  // 创建可能涉及 ~/.sansheng/{sandbox,net}.json 读盘,所以是 async;直接 await。
  const tools = await createToolRegistry(opts.toolRegistryOptions);

  // —— Logger middleware ——
  app.use("*", async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    log.muted(`${c.req.method} ${c.req.path} → ${c.res.status} (${ms}ms)`);
  });

  // —— 健康检查 ——
  // 批次 UI U3(4a-OQ5「vec 降级态用户不可见」):vecLoaded 是**真实**能力面 ——
  // 用 isVecAvailable(storage.db)(fragments repo 自己的探测,碎片检索实际走的就是
  // 它),而不是 Storage.vecLoaded 那个「构造器是否加载成功」的历史标志:后者在
  // B5 的 reopen() 之后仍是**首次**构造时的值(db.ts 字段注释自述「诊断用」),
  // 与当前连接的真实可用性会脱节。降级时 fragments 检索自动退回 text/importance
  // 排序(功能不受影响),但用户此前完全看不到这件事。
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      name: "sansheng",
      version: "0.1.0",
      ts: Date.now(),
      dataDir: opts.dataDir,
      vecLoaded: isVecAvailable(opts.storage.db),
    }),
  );

  // —— 配置(meta) ——
  app.get("/api/config", (c) => {
    const cfg = settingsStore.load();
    const active = settingsStore.activeProvider();
    return c.json({
      name: "sansheng",
      version: "0.1.0",
      host: process.env.SANSHENG_HOST ?? "127.0.0.1",
      port: Number(process.env.SANSHENG_PORT ?? 2718),
      features: { multiAgent: false, persistence: false, artifacts: false, harness: false, scheduler: false, chat: true },
      kernelReady: opts.kernel.isReady(),
      conversationId: opts.kernel.getConversationId(),
      personaName: cfg.personaName,
      activeProvider: active ? { label: active.label, provider: active.provider, modelId: active.modelId } : null,
      hasAnyProvider: cfg.providers.length > 0,
    });
  });

  // —— Settings: GET(掩码 apiKey) ——
  app.get("/api/settings", (c) => c.json(toPublic(settingsStore.load())));

  // —— Settings: PUT(整体替换 providers + 全局字段) ——
  app.put("/api/settings", async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      providers?: Array<Partial<ProviderConfig>>;
      activeProviderId?: string;
      cwd?: string;
      personaName?: string;
      costBudgetUsd?: number;
    } | null;
    if (!body) return c.json({ error: "invalid body" }, 400);

    const cur = settingsStore.load();
    const curById = new Map(cur.providers.map((p) => [p.id, p]));

    const nextProviders: ProviderConfig[] = (body.providers ?? []).map((p) => {
      const existing = p.id ? curById.get(p.id) : undefined;
      // apiKey: 用户没填(undefined)或填的是掩码串 → 保留旧真值;填了新真值 → 用它
      let apiKey = existing?.apiKey ?? "";
      if (p.apiKey !== undefined && !isMaskedApiKey(p.apiKey)) apiKey = p.apiKey;
      return {
        id: p.id || genProviderId(),
        label: p.label || p.provider || "未命名",
        provider: p.provider || "",
        modelId: p.modelId || "",
        apiKey,
        baseUrl: p.baseUrl || undefined,
        thinkingLevel: (p.thinkingLevel as ThinkingLevel) ?? "medium",
      };
    });

    let activeProviderId = body.activeProviderId ?? cur.activeProviderId;
    if (!nextProviders.find((p) => p.id === activeProviderId)) {
      activeProviderId = nextProviders[0]?.id ?? "";
    }

    const next = {
      ...cur,
      providers: nextProviders,
      activeProviderId,
      cwd: body.cwd ?? cur.cwd,
      personaName: body.personaName ?? cur.personaName,
      costBudgetUsd: body.costBudgetUsd ?? cur.costBudgetUsd,
    };
    settingsStore.save(next);

    // provider 配置变了 → 让 kernel 下次重新 start
    opts.kernel.invalidate();
    return c.json({ ok: true, settings: toPublic(next) });
  });

  // —— Providers catalog(Pi builtin) ——
  app.get("/api/providers", (c) => c.json({ providers: listProviders() }));

  // —— 新建对话 ——
  app.post("/api/conversation/new", (c) => {
    // S1(A7 根因之一):不再传 log-stub sink 劫持事件 —— newConversation 经
    // kernel.emit 多播到当前 attachSink 的活 WS 连接(浏览器实时看到 conversation_reset)。
    // newConversation 是同步逻辑(dispose + 换 id),用 void 触发即可。
    void opts.kernel.newConversation();
    return c.json({ ok: true, conversationId: opts.kernel.getConversationId() });
  });

  // —— 强制重置 kernel(stuck 恢复用) ——
  app.post("/api/kernel/reset", async (c) => {
    // S1(A7 根因之一):reset 不再被 log-stub sink 劫持 —— interrupt/ready 经 emit
    // 到达活连接(reset 后浏览器继续收流,旧代码从此进死 stub 永久静默)。
    await opts.kernel.reset();
    return c.json({ ok: true, conversationId: opts.kernel.getConversationId() });
  });

  // —— M3b: Blackboard / Agents / Memory 读路由 ——
  // 全部 try/catch 兑底:storage 缺失表 / sqlite-vec 未加载 / 任意 throw 都返回 JSON 500,不走 SPA fallback HTML。
  app.get("/api/blackboard/:id", (c) => {
    const conversationId = c.req.param("id");
    try {
      const bb = getActiveBlackboard(opts.storage.db, conversationId);
      return c.json({ blackboard: bb });
    } catch (err) {
      log.warn(`blackboard[${conversationId}] failed:`, err);
      return c.json({ blackboard: null, error: "storage_error", message: errMsg(err) }, 500);
    }
  });

  app.get("/api/blackboards/:id", (c) => {
    const conversationId = c.req.param("id");
    try {
      const list = listBlackboards(opts.storage.db, conversationId, 20);
      return c.json({ blackboards: list });
    } catch (err) {
      log.warn(`blackboards[${conversationId}] failed:`, err);
      return c.json({ blackboards: [], error: "storage_error", message: errMsg(err) }, 500);
    }
  });

  app.get("/api/agents/:id", (c) => {
    // M3b 占位:M3c 会接 ws 推送的 agents 快照/数据库中 agent_states 聚合
    return c.json({ agents: [] });
  });

  // —— M3+ B1: BlackboardArtifact v3 路由(extracted to blackboardRoutes.ts) ——
  registerBlackboardArtifactRoutes(app, opts.storage);

  // —— 批次 5b-2 T2:Harness 状态(只读;UI Harness tab 数据源)——
  // 自动落在 B4 安全中间件之后:createApp 顶部 app.use("*", createSecurityMiddleware())
  // 最先注册(Hono 按注册顺序执行)→ 本路由先过 Host 校验(evil Host → 421);
  // GET 豁免 Origin 校验(§B4 既有语义,与其它 /api/* GET 一致)。
  // 本批**只读**:无 POST /api/harness —— manager v0 无 apply 语义(D15:v0=只读
  // preview 生成器),无可安全暴露的 mutation;preview 生成由 bus 事件驱动
  // (artifact_created),不是 HTTP 面。apply/mutation 留给后续批次论证。
  app.get("/api/harness", (c) => {
    try {
      const mgr = getHarnessManager();
      const boot = getHarnessBootMeta();
      const cfg = loadHarness(opts.dataDir);
      // manager 自身无持久化(seen/inFlight/计数器 = 内存态,重启清零)→
      // proposals/previews 从 blackboard storage 读真实数据(scope=global),
      // notes 说明字段如实交代两套语义,不造假数据。
      const proposals = listArtifacts(opts.storage.db, {
        scope: "global",
        kind: "harness_proposal",
        limit: 100,
      });
      const previews = listArtifacts(opts.storage.db, {
        scope: "global",
        kind: "implementation_preview",
        limit: 100,
      });
      const notes = [
        "manager received/processed 等计数器为内存态(重启清零);proposals/previews 持久化于 blackboard storage(scope=global)",
        "本端点只读:无 apply/mutation(HarnessManager v0 = 只读 preview 生成器,D15;真 apply 属后续批次)",
      ];
      if (proposals.length === 0) {
        notes.push(
          "当前无 harness_proposal 生产发射点(executor D13 发射路径待 5c 修复;沉淀服务 kind 白名单刻意不含 harness_proposal)— manager 已订阅 artifact_created 待命",
        );
      }
      return c.json({
        manager: {
          running: mgr ? mgr.isRunning() : false,
          stats: mgr ? mgr.getStats() : null,
          decideSource: mgr && boot ? boot.decideSource : null,
          startedAt: mgr && boot ? boot.startedAt : null,
        },
        // ── 批次 7-G:统一管理面 ────────────────────────────────────────
        // `facets` 是**唯一数据源**:tools / prompts / skills / rag 四个面
        // 各自的条目都由 src/server/harness/facet.ts 的注册表算出,manager /
        // API / UI / diagnose 共用同一形状。加第五个面 = 写一个模块 + 注册
        // 一行,这四处**都不用改**。
        //   id / title / implemented / notImplementedNote
        //   entries[]: { id, enforced, basis, chars?, lines?, source, warnings, detail }
        // `implemented: false` 的面**照样出现在数组里**并说明缺什么 ——
        // 「有一行写着未实现」与「根本没这一行」对用户的意义完全不同。
        // 优先走 manager(7-G:消灭「manager 被绕过」);未 boot 时退回直调 ——
        // 两条路读同一份数据,不会分叉。
        facets: mgr?.describeFacets() ?? describeHarness(opts.dataDir),

        // 以下两个字段是 `facets` 的**派生视图**(同一份计算,不是第二个真相源),
        // 为尚未迁移到 facets 渲染的 UI 保留。批次 7-H 之后可以删。
        //   prompts  : 每单元 行数/字符数/state(含 7-G 新增的 orphan)
        //              + enforced/consumer/apply/sensitivity
        //   toolSets : per-agent 工具集合。字段语义见 src/server/harness/tools.ts
        prompts: describePrompts(opts.dataDir),
        toolSets: describeToolSets(opts.dataDir),
        harnessManagerPrompt: {
          // 7-G 起不再是「编译内置,尚未纳入版本链」—— harness/system_prompts/
          // harness_manager.md 已进版本链,这里的 source 随文件状态变化。
          source: describePrompts(opts.dataDir).find((p) => p.role === "harness_manager")?.state ?? "empty",
          lines: FALLBACK_HARNESS_PROMPT.split("\n").length,
          editable: true,
          note: "批次 7-G 已纳入 dataDir harness 版本链(harness/system_prompts/harness_manager.md);文件为空时回退内置 FALLBACK_HARNESS_PROMPT。",
        },
        config: {
          // enabledTools 已删除(批次 7-E):它是 M3c 的扁平占位
          // ["fs_read","fs_write","shell","http"],四个名字在 SDK 工具闭合联合里
          // 不存在,且零执行点读取。真实工具面见顶层 toolSets。
          redLines: cfg.redLines,
          budget: cfg.budget,
        },
        proposals,
        previews,
        notes,
      });
    } catch (err) {
      log.warn("/api/harness failed:", err);
      return c.json({ error: "storage_error", message: errMsg(err) }, 500);
    }
  });

  app.get("/api/memory/fragments", (c) => {
    const kind = c.req.query("kind");
    // C9-4:非法 limit → 400(旧实现 NaN 直达 SQL → better-sqlite3 throw → 500)
    const limit = parseLimitQuery(c.req.query("limit"), 100, 500);
    if (limit === null) {
      return c.json({ error: "invalid_limit", message: "limit must be a finite number" }, 400);
    }
    try {
      // listFragmentsByKind validates internally; passing the raw query string
      // (no `as never` cast) is safe — invalid kinds yield an empty array.
      const fragments = kind
        ? listFragmentsByKind(opts.storage.db, kind, limit)
        : listFragmentsAll(opts.storage.db, limit);
      return c.json({ fragments });
    } catch (err) {
      log.warn(`memory/fragments failed:`, err);
      return c.json({ fragments: [], error: "storage_error", message: errMsg(err) }, 500);
    }
  });

  // ============== M2:持久化路由 ==============

  // 列出最近会话(供 HistoryRail 用)
  app.get("/api/conversations", (c) => {
    // C9-4:与 fragments 统一 —— 非法 limit → 400(旧实现静默回退 50 → 200)
    const safeLimit = parseLimitQuery(c.req.query("limit"), 50, 200);
    if (safeLimit === null) {
      return c.json({ error: "invalid_limit", message: "limit must be a finite number" }, 400);
    }
    try {
      const conversations = listConversations(opts.storage.db, safeLimit);
      return c.json({ conversations });
    } catch (err) {
      log.warn("list conversations failed:", err);
      return c.json({ error: "storage_error" }, 500);
    }
  });

  // 获取单个会话 + 它的全部 messages
  app.get("/api/conversations/:id", (c) => {
    const id = c.req.param("id");
    try {
      const conversation = getConversation(opts.storage.db, id);
      if (!conversation) return c.json({ error: "not_found" }, 404);
      const messages = listMessagesByConversation(opts.storage.db, id);
      return c.json({ conversation, messages });
    } catch (err) {
      log.warn("get conversation failed:", err);
      return c.json({ error: "storage_error" }, 500);
    }
  });

  // 列出 user profile(全部键值;M5/M7 才会用到,这里先暴露)
  app.get("/api/profile", (c) => {
    try {
      const profile = listProfile(opts.storage.db);
      return c.json({ profile });
    } catch (err) {
      log.warn("list profile failed:", err);
      return c.json({ error: "storage_error" }, 500);
    }
  });

  // upsert 一条 profile
  app.put("/api/profile/:key", async (c) => {
    const key = c.req.param("key");
    const body = (await c.req.json().catch(() => null)) as {
      value?: string;
      confidence?: number;
    } | null;
    if (!body || typeof body.value !== "string" || !body.value) {
      return c.json({ error: "value required" }, 400);
    }
    try {
      const confidence =
        typeof body.confidence === "number" && body.confidence >= 0 && body.confidence <= 1
          ? body.confidence
          : 0.7;
      upsertProfile(opts.storage.db, key, body.value, confidence);
      return c.json({ ok: true });
    } catch (err) {
      log.warn("upsert profile failed:", err);
      return c.json({ error: "storage_error" }, 500);
    }
  });

  // —— M4:ToolRegistry endpoints ——
  // 列出已注册工具的 { name, description }(不暴露 fn)。
  app.get("/api/tools/list", (c) => {
    return c.json({
      tools: tools.entries().map((e) => ({
        name: e.name,
        description: e.description ?? "",
      })),
    });
  });

  // 调用工具。
  //   body: { name, args? }
  //   resp 200: { ok: true, value }
  //   resp 400: { ok: false, error: { name: "TypeError", message, code?: "invalid_body" } }
  //   resp 404: { ok: false, error: { name: "ToolNotFoundError", message, code?: "tool_not_found" } }
  //   resp 500(由全局 onError 兜):工具 throw 原始 SandboxError/NetSandboxError,栈完整保留。
  app.post("/api/tools/invoke", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: unknown; args?: unknown } | null;
    if (!body || typeof body.name !== "string" || body.name.length === 0) {
      return c.json(
        {
          ok: false,
          error: {
            name: "TypeError",
            code: "invalid_body",
            message: "request body must be { name: string, args?: unknown }",
          },
        },
        400,
      );
    }
    const reg = tools.get(body.name);
    if (!reg) {
      return c.json(
        {
          ok: false,
          error: {
            name: "ToolNotFoundError",
            code: "tool_not_found",
            message: `tool not registered: ${body.name}`,
          },
        },
        404,
      );
    }
    // 不 wrap try/catch:让原始 SandboxError/NetSandboxError 抛出,走全局 onError 兜底成 500 JSON。
    // 这保留了 instance + stack trace,instanceof 检查在客户端仍有效。
    const value = await reg.fn(body.args);
    return c.json({ ok: true, value });
  });

  // 重置 Sansheng:**只清会话数据**,保留配置(.keyring / settings.json)
  //
  // 批次 4b B5(审查 §B5「/api/reset 后 server 变僵尸 + 密钥丢失链」)。旧实现两实锤:
  //  1. `storage.close()` + rmSync 之后**无任何重开逻辑** → 除 health 外全部 API
  //     500(use-after-close 被 try/catch 兜住),kernel 落库全失败,server 变僵尸,
  //     必须手动重启。
  //  2. targets 里连带 `.keyring` + `settings.json` —— 两者都不是会话数据而是
  //     **配置**。删掉后 SettingsStore 内存 cache 与 Keyring 内存 masterKey 仍指向
  //     已删文件;此后任何一次 save() 用旧 masterKey 把 settings.json 写回来,重启时
  //     Keyring 生成**新随机 key** → 已存 apiKey 全部解密失败被静默清空
  //     (store.ts 逐个 catch 后置 apiKey: "")。这比僵尸更隐蔽:用户只是清了个会话,
  //     回来发现所有 provider 的 key 都没了。
  //
  // 新契约:
  //  - 只删**会话数据**(sansheng.db/-wal/-shm、pi agentDir);`.keyring` 与
  //    `settings.json` 显式列入 preserved(要彻底重置请手删整个 dataDir ——
  //    那是用户明确的手工动作,不是这个 API 的语义);
  //  - 删除**之前** prepareForDataReset():停掉在飞 plan / 在飞 chat 回合 /
  //    挂起的 executor 提问,否则它们会在数据被删之后继续烧 token、写空库,
  //    或者挂着 1 小时 watchdog;
  //  - 删除之后 `storage.reopen()` 在**同一 Storage 实例**上换新连接并重跑
  //    migrations —— 所有注入方(kernel/ws/orchestrator/harness)持有的是 Storage
  //    实例,换连接对它们透明,server 立刻恢复可用,不需要重启;
  //  - reopen 不跑 B8 boot 孤儿对账(同进程语义,论证见 Storage.reopen 注释)。
  app.post("/api/reset", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { confirm?: string } | null;
    if (body?.confirm !== "reset") {
      return c.json({ error: "confirmation required (pass {confirm:\"reset\"})" }, 400);
    }
    // 配置类文件:不删(删了就是上面的密钥丢失链)。
    const preserved = [join(opts.dataDir, ".keyring"), join(opts.dataDir, "settings.json")];
    const targets = [
      join(opts.dataDir, "sansheng.db"),
      join(opts.dataDir, "sansheng.db-wal"),
      join(opts.dataDir, "sansheng.db-shm"),
      join(opts.dataDir, "pi"),
    ];

    // 1. 先停进程内的活。
    opts.kernel.prepareForDataReset();

    // 2. 关连接再删文件(不关的话 WAL 句柄会让某些平台上的 rm 失败)。
    const removed: string[] = [];
    const failed: string[] = [];
    try {
      opts.storage.close();
    } catch (err) {
      log.warn("storage close before reset:", err);
    }
    for (const t of targets) {
      try {
        if (existsSync(t)) {
          rmSync(t, { recursive: true, force: true });
          removed.push(t);
        }
      } catch (err) {
        failed.push(t);
        log.warn(`reset: failed to remove ${t}:`, err);
      }
    }

    // 3. 同一实例重开 —— server 保持存活(B5 核心)。
    let reopened = true;
    try {
      opts.storage.reopen();
    } catch (err) {
      reopened = false;
      failed.push(join(opts.dataDir, "sansheng.db"));
      log.error("reset: storage reopen failed — SQLite-backed APIs will 500 until restart:", err);
    }
    // 4. 配置缓存失效:强制下一次 load() 重新读盘(正常是 no-op;万一 rm 波及到
    //    配置,也不会拿内存里的旧副本继续往磁盘写)。
    try {
      opts.settingsStore.invalidate();
    } catch (err) {
      log.warn("reset: settings invalidate failed:", err);
    }

    log.warn(
      `reset via /api/reset: removed=${removed.length} failed=${failed.length} preserved=${preserved.length} reopened=${reopened}`,
    );
    return c.json({ ok: reopened, removed, failed, preserved });
  });

  // —— 静态文件:生产构建产物(dist/web) ——
  // tsc rootDir=. → dist/src/server/http.js,需走三级上级到工程根
  const webRoot = resolve(__dirname, "../../../dist/web");
  if (existsSync(webRoot)) {
    app.use("/*", serveStatic({ root: webRoot }));
    app.get("*", (c) => {
      const htmlPath = join(webRoot, "index.html");
      if (existsSync(htmlPath)) return c.html(readFileSync(htmlPath, "utf-8"));
      return c.text("not built", 404);
    });
  } else {
    app.get("/", (c) =>
      c.html(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>Sansheng · 三生</title></head>
<body style="background:#0B0F14;color:#E8E4D9;font-family:Inter,sans-serif;padding:48px;">
  <h1 style="font-weight:300;letter-spacing:.06em;color:#5E8B7E;">三生 · Sansheng</h1>
  <p style="color:#B7AE9D;">Web UI not built. <code style="color:#C76B4A">npm run build:web</code> first.</p>
</body></html>`),
    );
  }

  app.notFound((c) => c.json({ error: "not_found", path: c.req.path }, 404));

  // —— 全局错误处理:任何 route handler 抛出的未捕获错误都返回 JSON,而不是 HTML —— 
  // 避免前端 fetch().json() 拿到 <!doctype... 抛 SyntaxError。
  // (例如 /api/memory/fragments 在 fragments 表缺失 / sqlite-vec 加载失败时会出错)
  app.onError((err, c) => {
    log.error(`unhandled route error on ${c.req.method} ${c.req.path}:`, err);
    return c.json(
      {
        error: "internal_error",
        message: err instanceof Error ? err.message : String(err),
        path: c.req.path,
      },
      500,
    );
  });

  // —— Attach WebSocket ——
  attachWebSocket(opts.httpServer, opts.kernel, {
    storage: opts.storage,
    settingsStore: opts.settingsStore,
    dataDir: opts.dataDir,
  });

  return app;
}

function maskApiKey(k: string): string {
  if (!k) return "";
  if (k.length <= 8) return "****";
  return `${k.slice(0, 4)}****${k.slice(-4)}`;
}