/**
 * 平台宿主 · `sansheng platform serve`
 *
 * ── 它补的是设计里漏掉的那个阶段 ──────────────────────────────
 *
 * 前 12 个批次把机制建扎实了,但平台**没有长驻进程** —— `bootPlatform` 只有
 * CLI 一个调用方,`src/platform/` 内没有任何 daemon。后果是三件事同时被卡:
 *
 *   1. 界面用不了(只能命令行驱动)
 *   2. `client.*` 不闭环(`ClientChannel` 只有日志实现,问题到不了用户)
 *   3. 调度器没地方待(写出来就是死代码)
 *
 * 这个文件是那三件事的公共前置。
 *
 * ── 会话生命周期 ────────────────────────────────────────────────
 *
 * 每个项目一条连续对话(经校准的裁决),所以每个项目**常驻一个 Pi 会话**。
 * 每条用户消息都重建会话会丢掉 `toolLoop` 的历史,而历史正是「它已经查过
 * 什么」的来源(7-N:每轮重拼 transcript 导致模型原地打转)。
 *
 * ── 事件桥 ──────────────────────────────────────────────────────
 *
 * `runTurn` 给的是 SDK 的 `AgentSessionEvent`,前端要的是 `ServerEvent`。
 * 桥接在这里做,而且**text 与 thinking 分两条流**(7-I 的现场:判据写错导致
 * 1853 字符内部推理被当成正式回复展示给用户)。
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { bootPlatform, type BootedPlatform } from "../runtime/boot.js";
import { createPlatformSession, type CreateSessionFn } from "../runtime/session.js";
import { runTurn } from "../runtime/turn.js";
import { ORG, ensureOrg, orgReady } from "../runtime/org.js";
import { createPlatformApp } from "../transport/http.js";
import { attachHub, ensureSession, PlatformHub } from "../transport/hub.js";
import { startScheduler, type Scheduler } from "./scheduler.js";
import { resetPlatformData } from "./reset.js";
import { appendSessionMessage } from "../storage/repo/sessions.js";
import { resolveClientQuestion } from "../tools/client.js";
import { listProjectSummaries } from "../transport/views.js";
import { getProjectRow } from "../storage/repo/projects.js";
import { getAgent } from "../storage/repo/agents.js";
import { log } from "../../shared/log.js";
import { applySettingsPatch, toPublicSettings } from "../infra/settingsApply.js";
import { listProviders, resolveModel, syncActiveProviderApiKeyEnv } from "../infra/providers.js";
import type { ServerEvent } from "@shared/types/platform.js";

export interface ServeOptions {
  readonly dataDir: string;
  readonly host: string;
  readonly port: number;
  readonly cwd?: string;
  readonly version: string;
  /** 打开浏览器 */
  readonly open?: boolean;
  /**
   * 测试 seam:替换真实的 `createAgentSession`(与 `session.ts` 的 DI 同一条理由 ——
   * 「到底把什么交给了 SDK」/「中断有没有到达会话」这类断言不该需要 provider 与网络)。
   * 生产不传。
   */
  readonly createSession?: CreateSessionFn;
}

const HERE = fileURLToPath(new URL(".", import.meta.url));

export interface PlatformHost {
  readonly app: Hono;
  readonly hub: PlatformHub;
  readonly booted: BootedPlatform;
  readonly scheduler: Scheduler;
  /** 关掉所有常驻会话与库 */
  close(): void;
  /** 当前常驻会话数(诊断用) */
  sessionCount(): number;
}

/**
 * 装配宿主(不监听)。测试可以直接拿 `app` 打请求,不必占端口。
 */
export function createPlatformHost(opts: ServeOptions): PlatformHost {
  const booted = bootPlatform({ dataDir: opts.dataDir, clientLog: (l) => log.muted(l) });
  const db = booted.deps.db;
  const now = booted.now;
  const newId = booted.newId;

  const cwd = opts.cwd ?? booted.settings.cwd;

  /**
   * 当前模型。**可变** —— 用户在界面上改了 provider 之后必须换掉,
   * 否则会用 boot 时那个一直跑下去(而且他改了却没有效果,最难排查)。
   */
  let currentModel = booted.model;

  /** 重新按当前设置解析模型。写设置后调用。 */
  async function reResolveModel(): Promise<void> {
    const p = booted.settingsStore.activeProvider();
    if (p === undefined) {
      currentModel = null;
      return;
    }
    // 凭据要先同步到 env 再解析 —— 与 bootPlatform 里同一条理由
    syncActiveProviderApiKeyEnv(p.provider, p.apiKey);
    currentModel = resolveModel({
      provider: p.provider,
      modelId: p.modelId,
      apiKey: p.apiKey,
      baseUrl: p.baseUrl ?? null,
    });
    log.muted(`platform: 模型已重新解析 → ${currentModel !== null ? `${p.provider}/${p.modelId}` : "(失败)"}`);
  }

  // ── 常驻会话(每个项目一个 + 接待会话那一个)──────────────────
  //
  // 键是 `string | null`:**`null` 就是接待会话**(第一个项目之前)。
  // 不引入哨兵字符串 —— 见 transport/hub.ts 里 busy 集合的说明。
  const sessions = new Map<string | null, AgentSession>();

  /**
   * **正在跑的回合**的登记表 —— `onInterrupt` 唯一能到达「那个回合」的路径。
   *
   * ⚠️ 这里曾经是一个 `Map<string | null, AbortController>`,而**从来没有人
   * `set` 过它**(只有声明 / `get` / `delete`)。后果是前端的中断按钮与 Esc
   * 一直是 no-op:`get()` 恒 undefined,可选链把整条链路吞得一声不响。
   * 那是「死接线」的教科书形态 —— 代码看起来齐全,功能从来没有过。
   *
   * 修法不是「给 AbortController 加一个 set」:SDK 的取消入口是
   * `AgentSession.abort()`(`AbortController` 根本传不进 `session.prompt`),
   * 所以登记的就是**那个会话自己的 abort**。
   */
  const inflight = new Map<string | null, () => void>();

  const hub = new PlatformHub(
    { db, now, newId },
    {
      onUserMessage: async (projectId, content) => {
        await handleUserMessage(projectId, content);
      },
      onAnswerQuestion: async (questionId, answer) => {
        const r = resolveClientQuestion(db, questionId, answer, now(), {
          newId,
          answeredByAgentId: "bm",
        });
        if (!r.ok) {
          hub.broadcast({
            type: "error",
            error: { code: r.reason ?? "internal", message: `答复失败:${r.reason}` },
          });
          return;
        }
        // 项目从提问工件上取 —— 答复事件也要带 projectId,否则前端不知道该
        // 更新哪个项目面板(按项目分组呈现)
        const projectId = getClientQuestionProject(questionId);
        if (projectId !== null) {
          hub.broadcast({
            type: "client_question_answered",
            projectId,
            questionId,
            decisionArtifactId: r.decisionArtifactId ?? "",
          });
        }
      },
      onInterrupt: (projectId) => {
        const abort = inflight.get(projectId);
        if (abort === undefined) {
          // 幂等:没有正在跑的回合(用户连点两次、或回合刚好结束)不是错误。
          // 但**必须留一行日志** —— 否则「中断按钮没反应」和「真的没有活可停」
          // 在事后完全无法区分(7-N:见不到的现场等于没有现场)。
          log.muted(`platform: 收到中断,但${channelLabel(projectId)}上没有正在跑的回合 —— 忽略`);
          return;
        }
        log.ok(`platform: 中断${channelLabel(projectId)}正在跑的回合`);
        abort();
      },
    },
  );

  function getClientQuestionProject(questionId: string): string | null {
    const row = db
      .prepare(`SELECT project_id AS p FROM artifacts WHERE id = ?`)
      .get(questionId) as { p: string } | undefined;
    return row?.p ?? null;
  }

  /**
   * 用户在某个上下文里说了一句话 → 业务经理跑一个回合,全程流式推给前端。
   *
   * `projectId === null` = **接待会话**(第一个项目之前)。此时没有项目可校验,
   * 那条会话就是 `project_id IS NULL` 的全局唯一会话(见
   * `migrations/012_intake_session.sql`)。业务经理在这里与甲方谈诉求 ——
   * 谈拢之后由**它**调 `project_open`,本函数在回合结束后收口:
   * 把接待会话的消息迁进新项目、丢掉接待会话、广播 `project_opened` 让前端切过去。
   * **用户从不需要填「创建项目」表单**:立项是业务经理的动作。
   */
  async function handleUserMessage(projectId: string | null, content: string): Promise<void> {
    if (projectId !== null) {
      const project = getProjectRow(db, projectId);
      if (project === null) {
        hub.broadcast({ type: "error", projectId, error: { code: "not_found", message: "项目不存在" } });
        return;
      }
      if (project.status === "done" || project.status === "abandoned") {
        hub.broadcast({
          type: "error", projectId,
          error: { code: "project_closed", message: `项目已${project.status === "done" ? "完成" : "废弃"},不能再对话` },
        });
        return;
      }
    }

    ensureOrg(db, now());
    const at = now();
    const sessionId = ensureSession(db, projectId, at, newId);

    // 1. 用户消息先落库 —— 落库和广播的顺序反了会出现「用户看见自己说了话,
    //    刷新后它没了」
    const userMessageId = newId("m");
    appendSessionMessage(db, {
      id: userMessageId, sessionId, agentId: null, kind: "user", content, createdAt: at,
    });
    hub.emitMessageStart(projectId, userMessageId, "user");
    hub.emitDelta(projectId, userMessageId, content);
    hub.emitMessageEnd(projectId, userMessageId);

    // 2. 拿(或建)业务经理的常驻会话
    let session = sessions.get(projectId);
    if (session === undefined) {
      if (currentModel === null) {
        hub.broadcast({
          type: "error", projectId,
          error: { code: "no_model", message: "没有可用的 provider —— 先在设置里配一个" },
        });
        return;
      }
      const bm = ORG.find((m) => m.role === "business_manager")!;
      // **必须用 hub 的 channel**,不能用 booted.deps 里那个日志通道 ——
      // 后者只打日志,问题到不了用户(真机验证时就是这样:工具跑了、工件建了、
      // 投递去了 stdout)。
      const created = await createPlatformSession(
        { ...booted.deps, client: hub.clientChannel },
        bm.id, projectId, {
        cwd,
        agentDir: booted.settings.agentDir ?? join(opts.dataDir, "agent"),
        model: currentModel,
          dataDir: opts.dataDir,
          ...(opts.createSession !== undefined ? { createSession: opts.createSession } : {}),
        },
      );
      if (!created.ok) {
        hub.broadcast({
          type: "error", projectId,
          error: { code: "session_failed", message: `${created.reason}:${created.detail}` },
        });
        return;
      }
      session = created.session;
      sessions.set(projectId, session);
      log.muted(
        projectId === null
          ? `platform: 建了业务经理的**接待会话**(工具面 ${created.plan.tools.join(", ")})`
          : `platform: 为项目 ${projectId} 建了业务经理会话`,
      );
    }

    // 3. 跑回合,事件桥到前端
    const messageId = newId("msg");
    hub.setBusy(projectId, true);
    hub.emitMessageStart(projectId, messageId, "assistant");
    const textBuf: string[] = [];
    const thinkBuf: string[] = [];
    /** 这一回合立起来的项目(按调用顺序)。**来自工具的结构化结果,不是解析文本** */
    let openedProjectIds: readonly string[] = [];

    /**
     * 用户是否按了中断。必须在这里就位 —— `onInterrupt` 要能区分
     * 「这一回合是用户停的」和「这一回合自己炸了」,两者的呈现完全不同。
     */
    let aborted = false;

    // **登记必须发生在第一次 await 之前。** 放在 `await runTurn(...)` 之后等于
    // 永远登记不上:WS 的每一条消息是各自 fire-and-forget 处理的,中断消息会在
    // 这个回合还卡在 await 里的时候就被处理掉。这正是「死接线」得以藏身的缝隙。
    inflight.set(projectId, () => {
      aborted = true;
      // `AgentSession.abort()` 是 async 且会等到 agent 真正 idle。这里**不 await**:
      // WS 的消息处理器不该被一次取消阻塞住。但失败要留现场(7-N),不许静默。
      void session.abort().catch((err: unknown) => {
        log.error(
          `platform: 中断${channelLabel(projectId)}的回合失败:` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    try {
      const turn = await runTurn({
        session,
        db,
        agentId: ORG.find((m) => m.role === "business_manager")!.id,
        projectId,
        message: content,
        onEvent: (ev) => {
          bridge(ev, projectId, messageId, hub, textBuf, thinkBuf);
        },
      });
      openedProjectIds = turn.openedProjectIds;

      // 4. 助手消息落库(项目活过会话)
      const text = turn.text.trim() !== "" ? turn.text : textBuf.join("");
      if (text.trim() !== "") {
        appendSessionMessage(db, {
          id: newId("m"), sessionId, agentId: "bm", kind: "assistant",
          content: text, createdAt: now(),
        });
      }
      hub.emitMessageEnd(projectId, messageId);
      hub.emitAgentEnd(projectId);
      if (aborted) {
        // 用户主动中断,但 SDK 的 prompt() 正常返回了(abort 让回合收敛)。
        // 已经拿到的正文照样落库 —— 中断不是丢弃,是「到此为止」。
        log.muted(`platform: ${channelLabel(projectId)}的回合被用户中断(已产出 ${text.length} 字符)`);
      }
      if (turn.timedOut) {
        hub.broadcast({
          type: "error", projectId,
          error: { code: "turn_timeout", message: "回合超时收尾,结果可能不完整" },
        });
      }
    } catch (e) {
      // **中断不是故障。** 把一次「停止」报成 `turn_failed` 会让用户以为出了错,
      // 而他要的只是停下来。两条路径呈现不同,但都要收尾(前端还挂着流式气泡)。
      if (aborted) {
        log.muted(
          `platform: ${channelLabel(projectId)}的回合被用户中断:` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
        hub.emitMessageEnd(projectId, messageId);
        hub.emitAgentEnd(projectId);
      } else {
        hub.broadcast({
          type: "error", projectId,
          error: { code: "turn_failed", message: e instanceof Error ? e.message : String(e) },
        });
        hub.emitAgentEnd(projectId);
      }
    } finally {
      hub.setBusy(projectId, false);
      inflight.delete(projectId);
    }

    // 5. 立项 → 收口。**必须在回合结束之后做** —— 回合中途换上下文会让半个
    //    回合的输出落进另一个面板(前端此刻还在接待流上)。
    if (openedProjectIds.length > 0) {
      // 一个回合里立了多个项目是病态输入;如实记账,并只迁到最后一个
      // (不静默挑一个:事后要能看出当时发生了什么)。
      const newProjectId = openedProjectIds[openedProjectIds.length - 1]!;
      if (openedProjectIds.length > 1) {
        log.warn(
          `platform: 一个回合里立了 ${openedProjectIds.length} 个项目 ` +
            `(${openedProjectIds.join(", ")})—— 接待会话只迁进最后那个 ${newProjectId}`,
        );
      }
      const row = getProjectRow(db, newProjectId);
      if (row === null) {
        // 工具说立项成功、库里却没有 —— 这是装配/写入事故,必须响亮
        log.error(`platform: project_open 报回 ${newProjectId},但库里读不到它 —— 不切换`);
      } else {
        const fromIntake = projectId === null;
        if (fromIntake) {
          // 顺序有讲究:**先迁消息,再广播,最后才丢会话**。
          //   迁 → 前端收到事件后立刻拉新项目的 messages,那时消息必须已经在了
          //       (否则用户会看到一段空对话)
          //   广播 → 放在 dispose 之前:dispose 是 SDK 的调用,不该由它决定
          //       用户多久才看到切换
          //   丢 → 接待会话的工具面是接待模式的,留着会让下一条消息继续用它
          adoptIntakeMessages(sessionId, newProjectId);
        }
        hub.emitProjectOpened(newProjectId, row.name);
        if (fromIntake) disposeSession(null, "立项后接待会话结束");
        log.ok(
          `platform: 已立项 ${newProjectId}「${row.name}」` +
            (fromIntake ? "(接待会话的消息已迁入)" : `(在项目 ${projectId} 的会话里立的)`),
        );
      }
    }
  }

  /**
   * 把接待会话的消息迁进新项目的会话,然后删掉接待会话行。
   *
   * **迁而不是留**:那段对话就是新项目的立项背景,它该跟着项目走 —— 甲方刷新
   * 之后在新项目里还看得见当初说过什么。删掉接待会话行是有意的:留着它就是一条
   * 空会话,而「全局只有一条接待会话」由 schema 的部分唯一索引保证
   * (见 migrations/012);下次点「新建项目」时会建一条干净的。
   */
  function adoptIntakeMessages(intakeSessionId: string, newProjectId: string): void {
    const target = ensureSession(db, newProjectId, now(), newId);
    const moved = db
      .prepare(`UPDATE session_messages SET session_id = ? WHERE session_id = ?`)
      .run(target, intakeSessionId).changes;
    // 消息已经全部迁走,这里删掉的只是一条空会话(级联删不到东西)
    db.prepare(`DELETE FROM project_sessions WHERE id = ?`).run(intakeSessionId);
    log.muted(`platform: 接待会话 ${intakeSessionId} 的 ${moved} 条消息 → 项目 ${newProjectId} 的会话 ${target}`);
  }

  /** 丢掉某个上下文的常驻会话(不存在时静默 —— 幂等调用点用它)。 */
  function disposeSession(projectId: string | null, why: string): void {
    const s = sessions.get(projectId);
    if (s === undefined) return;
    try {
      s.dispose();
    } catch {
      /* dispose 失败不影响「这条会话已经不该再用」这个事实 */
    }
    sessions.delete(projectId);
    log.muted(`platform: 已丢弃${projectId === null ? "接待" : `项目 ${projectId}`}会话(${why})`);
  }

  // ── HTTP ──────────────────────────────────────────────────────

  const app = createPlatformApp({
    db,
    dataDir: opts.dataDir,
    cwd,
    personaName: booted.settings.personaName,
    version: opts.version,
    modelId: booted.provider?.modelId ?? null,
    provider: booted.provider?.provider ?? null,
    hasAnyProvider: booted.provider !== null,
    now,
    newId,
    settings: {
      // 每次都重新 load —— store 内部有缓存,但语义上要表达「读的是当前值」
      read: () => toPublicSettings(booted.settingsStore.load()),
      write: async (body) => {
        const r = applySettingsPatch(booted.settingsStore, body);
        if (!r.ok) return { ok: false as const, error: r.error };
        // **写成功之后必须重新解析模型** —— 用户改 provider 之后,
        // 下一次建会话要用新的那个;沿用 boot 时解析的会一直用旧模型。
        await reResolveModel();
        // 已建的常驻会话带着旧模型,必须丢掉重建
        for (const [pid, sess] of sessions) {
          try {
            sess.dispose();
          } catch {
            /* dispose 失败不影响设置已保存这个事实 */
          }
          sessions.delete(pid);
          log.muted(`platform: 设置变更,已丢弃${channelLabel(pid)}的常驻会话(下次对话用新模型重建)`);
        }
        return { ok: true as const, settings: toPublicSettings(r.settings) };
      },
      providers: () => listProviders(),
    },
    harnessDirs: {
      dataDir: opts.dataDir,
      // 出厂副本:`dist/src/platform/host/` 上三级是 `dist/`,再进 `harness/system_prompts/`
      // (构建时由 package.json 的 build:server 从仓库 harness/ 拷过去)
      factoryDir: resolve(HERE, "../../../harness/system_prompts"),
    },
    reset: () => {
      // 常驻会话必须丢掉:它们绑着已被删掉的项目,继续用会往空项目里写消息
      for (const [pid, sess] of sessions) {
        try {
          sess.dispose();
        } catch {
          /* dispose 失败不影响数据已清空这个事实 */
        }
        sessions.delete(pid);
        log.muted(`platform: 重置,已丢弃${channelLabel(pid)}的常驻会话`);
      }
      const report = resetPlatformData(db);
      log.ok(`platform: 数据已重置,清空 ${report.totalRows} 行(${report.cleared.length} 张表)`);
      return report;
    },
  });

  // 静态前端:生产构建产物。**放在所有 API 路由之后**注册,
  // 否则 serveStatic 的 `/*` 会把 API 请求也吞掉。
  // HERE = dist/src/platform/host/ → 上三级是 dist/ → 再进 web
  // (第一版写成 "../../../dist/web",算出来是 dist/dist/web,于是前端永远"找不到")
  const webRoot = resolve(HERE, "../../../web");
  if (existsSync(webRoot)) {
    const staticApp = serveStatic({ root: webRoot });
    app.use("/*", staticApp);
    log.muted(`platform: 托管前端 ${webRoot}`);
  } else {
    log.warn(`platform: 没找到前端产物(${webRoot})—— 先跑 npm run build:web`);
  }

  // ── 调度器 ────────────────────────────────────────────────────
  //
  // 只做一件事:扫超时提问并推给前端。**不自动升级** —— 经 jev 校准,
  // 单人本地服务里「人暂时没回」是常态而不是故障(见 scheduler.ts 文件头)。
  const scheduler: Scheduler = startScheduler({
    db,
    now,
    broadcast: (ev) => hub.broadcast(ev),
    log: (l) => log.muted(l),
  });

  return {
    app,
    hub,
    booted,
    scheduler,
    sessionCount: () => sessions.size,
    close: () => {
      scheduler.stop();
      for (const s of sessions.values()) {
        try {
          s.dispose();
        } catch {
          /* dispose 失败不该影响退出 */
        }
      }
      sessions.clear();
      booted.close();
    },
  };
}

// ── 事件桥 ──────────────────────────────────────────────────────

/** 日志里怎么称呼一个上下文通道。`null` = 接待会话(见 migrations/012)。 */
function channelLabel(projectId: string | null): string {
  return projectId === null ? "接待会话" : `项目 ${projectId}`;
}

function bridge(
  ev: AgentSessionEvent,
  projectId: string | null,
  messageId: string,
  hub: PlatformHub,
  textBuf: string[],
  thinkBuf: string[],
): void {
  if (ev.type === "message_update") {
    const u = ev.assistantMessageEvent;
    // **两条流永不混流** —— 7-I 的现场是判据写成了不存在的 "thinking",
    // 于是内部推理落进了正文被展示给用户
    if (u.type === "text_delta" && typeof u.delta === "string") {
      textBuf.push(u.delta);
      hub.emitDelta(projectId, messageId, u.delta);
    } else if (u.type === "thinking_delta" && typeof u.delta === "string") {
      thinkBuf.push(u.delta);
      hub.emitThinking(projectId, messageId, u.delta);
    }
    return;
  }
  if (ev.type === "tool_execution_start") {
    hub.emitToolStart(projectId, messageId, {
      id: ev.toolCallId, name: ev.toolName, args: ev.args,
    });
    return;
  }
  if (ev.type === "tool_execution_end") {
    hub.emitToolEnd(projectId, messageId, {
      id: ev.toolCallId, name: ev.toolName, result: ev.result, isError: ev.isError === true,
    });
  }
}


// ── CLI 入口 ────────────────────────────────────────────────────

/** 起服务并阻塞。返回一个 close 句柄(SIGTERM 时调)。 */
export async function runPlatformServe(opts: ServeOptions): Promise<{ close: () => void }> {
  const host = createPlatformHost(opts);

  log.ok(`Sansheng 平台服务`);
  log.muted(`  数据目录: ${opts.dataDir}`);
  if (!orgReady(host.booted.deps.db)) {
    log.muted(`  组织未就绪 —— 第一次收到消息或建项目时会自动播种`);
  }
  const projects = listProjectSummaries(host.booted.deps.db);
  log.muted(`  项目: ${projects.length} 个`);

  const server = serve(
    { fetch: host.app.fetch, port: opts.port, hostname: opts.host },
    (info) => {
      log.ok(`listening on http://${info.address}:${info.port}`);
      if (opts.open === true) {
        void import("open")
          .then(({ default: opener }) => opener(`http://${opts.host}:${info.port}`))
          .catch(() => {});
      }
    },
  ) as unknown as Server;

  attachHub(server, host.hub);

  const shutdown = () => {
    log.muted("平台服务收到退出信号,正在关闭");
    host.close();
    server.close();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  return { close: shutdown };
}

// 让 `ServerEvent` 的 import 不被 tree-shake 掉(类型只在编译期存在,
// 这里显式引用一次以免 lint 报未使用)
export type { ServerEvent };
