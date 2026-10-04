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
import { runTurn, type TurnResult, type ToolCallRecord } from "../runtime/turn.js";
import { runWorkItem } from "../runtime/execution.js";
import { ORG, ensureOrg, orgReady } from "../runtime/org.js";
import {
  drainProject,
  type DrainResult, type DrainTurnReport, type DrainWorkReport,
} from "../runtime/dispatcher.js";
import { createPlatformApp } from "../transport/http.js";
import { attachHub, ensureSession, PlatformHub } from "../transport/hub.js";
import { startFixedDelay, startScheduler, type FixedDelayLoop, type Scheduler } from "./scheduler.js";
import { resetPlatformData } from "./reset.js";
import { appendSessionMessage } from "../storage/repo/sessions.js";
import { resolveClientQuestion } from "../tools/client.js";
import { listProjectSummaries } from "../transport/views.js";
import { getProjectRow, listProjects } from "../storage/repo/projects.js";
import { getWork } from "../storage/repo/works.js";
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
   * **单次级联最多跑几个 agent 回合**。默认 8。
   *
   * 这是烧 token 的硬上界(见 `runtime/driver.ts` 的 ③)。单用户本地服务里
   * 「一次用户消息引爆 20 个回合」既贵又难排查,所以默认值刻意保守,而它**可配**:
   * 项目大、链子长时把它调大,而不是把上界从代码里拿掉。
   */
  readonly maxCascadeRounds?: number;
  /**
   * 调度器扫描间隔(毫秒)。默认 60 秒。
   *
   * 它是**超时提问**那条周期的间隔,与排空器无关(排空的兜底有自己的
   * `dispatchIntervalMs`)。测试里调小它,就能在合理时间内观察到超时提示。
   */
  readonly schedulerIntervalMs?: number;
  /**
   * **排空器兜底定时器的间隔(毫秒)**。默认 10 秒,fixed-delay 语义
   * (上一轮排空跑完再等这么久,所以两轮永不重叠)。
   *
   * 它的职责是兜底:重启恢复、事件 nudge 漏掉的、以及外部直接改库的场合。
   * 调小它 = 兜底更及时、空转更频繁;调大它 = 更省,但状态迁移后要等更久。
   */
  readonly dispatchIntervalMs?: number;
  /**
   * **执行类回合**的超时上限(毫秒)。缺省交给 `runTurn` 自己的默认值(5 分钟)。
   *
   * 执行一个工作项会真的读代码 / 跑命令,所以它与「聊天回合」的合理上限不是
   * 同一个数 —— 这里给它一个独立的旋钮,而不是让两件事共用一个默认。
   */
  readonly turnTimeoutMs?: number;
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
  /** 排空器的兜底触发(fixed-delay) */
  readonly dispatchTimer: FixedDelayLoop;
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

  // ── 常驻会话(键 = 上下文 + agent)────────────────────────────
  //
  // 原先键只是 `string | null`(一个上下文一个会话),因为**只有业务经理**
  // 会跑回合。驱动者循环一接上,同一个项目里项目经理 / worker / 质检**各要
  // 一条自己的会话**(工具面不同、提示词不同),所以键必须落到
  // `(上下文, agent)` 上 —— 否则三个角色会抢同一条会话,而那种错会表现成
  // 「项目经理用 worker 的工具面说话」。
  //
  // 上下文里的 `null` 仍然是**接待会话**(第一个项目之前),不引入哨兵值;
  // 编码成键只在池子内部用。
  const sessions = new Map<string, AgentSession>();

  /** 会话池的键。上下文 `null` = 接待会话。 */
  function pooledKey(projectId: string | null, agentId: string): string {
    return `${projectId ?? "<intake>"}::${agentId}`;
  }
  function contextPrefix(projectId: string | null): string {
    return `${projectId ?? "<intake>"}::`;
  }

  /** 丢掉某个上下文里**所有角色**的常驻会话(不存在时静默 —— 幂等调用点用它)。 */
  function disposeSessionsFor(projectId: string | null, why: string): void {
    const prefix = contextPrefix(projectId);
    let n = 0;
    for (const [key, s] of [...sessions]) {
      if (!key.startsWith(prefix)) continue;
      try {
        s.dispose();
      } catch {
        /* dispose 失败不影响「这条会话已经不该再用」这个事实 */
      }
      sessions.delete(key);
      n++;
    }
    if (n > 0) {
      log.muted(`platform: 已丢弃${channelLabel(projectId)}的 ${n} 条常驻会话(${why})`);
    }
  }

  /** 丢掉全部常驻会话(设置变更 / 数据重置 / 关闭)。 */
  function disposeAllSessions(why: string): void {
    const n = sessions.size;
    for (const s of sessions.values()) {
      try {
        s.dispose();
      } catch {
        /* dispose 失败不影响「它们已经不该再用」这个事实 */
      }
    }
    sessions.clear();
    if (n > 0) log.muted(`platform: 已丢弃全部 ${n} 条常驻会话(${why})`);
  }

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

    // 2. 拿(或建)业务经理的常驻会话,跑一个回合,事件桥到前端
    const bm = ORG.find((m) => m.role === "business_manager")!;
    let openedProjectIds: readonly string[] = [];
    /** 这一回合结束后要不要敲一下门铃(排空哪个项目)。`null` = 不敲。 */
    let nudgeTarget: string | null = null;

    hub.setBusy(projectId, true);
    try {
      const out = await runAgentTurn(projectId, bm.id, content);
      openedProjectIds = out.openedProjectIds;

      // 3. 立项 → 收口。**必须在回合结束之后做** —— 回合中途换上下文会让半个
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
          if (fromIntake) disposeSessionsFor(null, "立项后接待会话结束");
          log.ok(
            `platform: 已立项 ${newProjectId}「${row.name}」` +
              (fromIntake ? "(接待会话的消息已迁入)" : `(在项目 ${projectId} 的会话里立的)`),
          );
        }
      }

      // 4. 用户消息的回合结束后 → **敲一下门铃**(排空器的触发点之一)。
      //
      // ── 为什么**只在项目内**敲,接待会话里那次立项不敲 ──────────────────
      //
      // 接待会话里立起项目,用户此刻刚被切进那个新项目:他还没看过目标对不对,
      // 系统的第一个动作却已经是「项目经理拆解 + worker 开工 + 质检 + 业务经理
      // 汇报」—— 那是**在用户确认目标之前就花他的 token**。而且 `project_opened`
      // 之后紧接着一串流式输出,前端会在用户还没读完切换动作时就开始滚屏。
      //
      // 代价是明的:那一次立项之后,项目经理的「还没拆解」要等到用户下一次说话、
      // 或定时器下一次 fire 才被捡起来。这两条路都在,不是漏掉。
      if (projectId !== null) nudgeTarget = projectId;
    } finally {
      hub.setBusy(projectId, false);
      inflight.delete(projectId);
    }

    // 门铃**不 await**:排空是平台自己的循环,用户那条消息的回合到这儿就结束了。
    // 同一个项目的排空由 `drainOne` 的 busy 闩挡住重叠(这里 busy 刚放开)。
    if (nudgeTarget !== null) nudge();
  }

  // ── 会话池(上下文 + agent)──────────────────────────────────

  /**
   * 把接待会话的消息迁进新项目的会话,然后删掉接待会话行。
   *
   * **迁而不是留**:那段对话就是新项目的立项背景,它该跟着项目走 —— 甲方刷新
   * 之后在新项目里还看得见当初说过什么。删掉接待会话行是有意的:留着它就是一条
   * 空会话,而「全局只有一条接待会话」由 schema 的部分唯一索引保证
   * (见 migrations/012);下次点「新建项目」时会建一条干净的。
   *
   * ⚠️ 这里删的是 `project_sessions` 一行,**不是 DROP TABLE** ——
   * `session_messages` 对它有 `ON DELETE CASCADE`,所以顺序必须是
   * 「先把消息 UPDATE 走,再 DELETE 那条空会话」。反过来做会连消息一起级联删掉,
   * 而 `DROP TABLE` 那条路更糟(见 migrations/012 文件头:foreign_key_check 一声不响)。
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

  type SessionAcquire =
    | { readonly ok: true; readonly session: AgentSession }
    | { readonly ok: false; readonly code: string; readonly message: string };

  /**
   * 取(或建)某个 agent 在某个上下文里的常驻会话。
   *
   * **必须用 hub 的 channel**,不能用 `booted.deps` 里那个日志通道 —— 后者只打
   * 日志,问题到不了用户(真机验证时就是这样:工具跑了、工件建了、投递去了 stdout)。
   *
   * ── 为什么**接待会话不装门铃**(真机 E2E 抓到的洞)────────────────
   *
   * 门铃挂在工具调用上,而门铃一响 `drainAll` 会扫**全部活跃项目**。接待会话里
   * `project_open` 刚把项目建出来的那一刻,新项目就已经是 active —— 于是门铃
   * 会在用户**还没看过项目目标**之前就叫醒项目经理去拆解、worker 去开工。
   * 这正是批次 20 明确定为**不该发生**的事(在他确认之前花他的 token)。
   *
   * 修法在**装配层**:接待会话的会话不带门铃(`projectId === null`)。项目内的
   * 迁移照旧敲门 —— 那里用户已经在项目里了。用户被切进新项目之后的第一句话
   * (`handleUserMessage` 末尾的 nudge)才是那条流水线的起点。
   */
  async function getOrCreateSession(
    projectId: string | null,
    agentId: string,
  ): Promise<SessionAcquire> {
    const key = pooledKey(projectId, agentId);
    const cached = sessions.get(key);
    if (cached !== undefined) return { ok: true, session: cached };
    if (currentModel === null) {
      return { ok: false, code: "no_model", message: "没有可用的 provider —— 先在设置里配一个" };
    }
    const created = await createPlatformSession(
      // `onStateChange` = 门铃:任何**可能改变流水线状态**的工具调用成功后,
      // 平台立刻去查一次「现在该谁动」(见 runtime/dispatcher.ts)。
      // 它不携带状态,判定永远重新查库 —— 所以这里给一个无参回调就够了。
      // **接待会话不装**(理由见本函数上面那一段):否则立项当场就把组织叫起来了。
      {
        ...booted.deps,
        client: hub.clientChannel,
        ...(projectId !== null ? { onStateChange: () => nudge() } : {}),
      },
      agentId, projectId, {
        cwd,
        agentDir: booted.settings.agentDir ?? join(opts.dataDir, "agent"),
        model: currentModel,
        dataDir: opts.dataDir,
        ...(opts.createSession !== undefined ? { createSession: opts.createSession } : {}),
      },
    );
    if (!created.ok) {
      return { ok: false, code: "session_failed", message: `${created.reason}:${created.detail}` };
    }
    sessions.set(key, created.session);
    log.muted(
      `platform: 建了 ${agentId} 在${channelLabel(projectId)}的会话` +
        `(工具面 ${created.plan.tools.length} 个 · 系统提示 ${created.wiring.systemPromptChars} 字符` +
        (created.wiring.missingPromptUnits.length > 0
          ? ` · ⚠️ 未落地单元 ${created.wiring.missingPromptUnits.join(",")}`
          : "") +
        ")",
    );
    return { ok: true, session: created.session };
  }

  /** 一次 agent 回合的返回形态(内部用)。 */
  interface AgentTurnOutcome {
    readonly aborted: boolean;
    readonly timedOut: boolean;
    readonly text: string;
    readonly toolCalls: readonly ToolCallRecord[];
    readonly openedProjectIds: readonly string[];
    /** 会话建不出来 / 抛错 —— 这一回合什么都做不了 */
    readonly failed: boolean;
  }

  /**
   * 跑一个 agent 回合:建(或取)会话 → 流式桥事件 → 落库 → 收尾。
   *
   * **它不碰 `busy`** —— busy 的粒度是「一次交互」(用户消息那一下,或一整次级联),
   * 由调用方持有。放进这里会让级联的回合之间出现一个「用户消息可以插进来」的窗口,
   * 而两条流打在同一条常驻会话上就是一次真正的竞态。
   *
   * `inflight` 的登记**每回合一次**,这是刻意的:中断要能准确地停住**正在跑的那一个**,
   * 而不是「这个项目里随便哪个角色」。
   */
  async function runAgentTurn(
    projectId: string | null,
    agentId: string,
    task: string,
  ): Promise<AgentTurnOutcome> {
    const got = await getOrCreateSession(projectId, agentId);
    if (!got.ok) {
      hub.broadcast({
        type: "error", projectId,
        error: { code: got.code, message: `${agentId}:${got.message}` },
      });
      return {
        aborted: false, timedOut: false, text: "", toolCalls: [],
        openedProjectIds: [], failed: true,
      };
    }
    const session = got.session;
    const sessionId = ensureSession(db, projectId, now(), newId);
    const messageId = newId("msg");
    hub.emitMessageStart(projectId, messageId, "assistant");
    const textBuf: string[] = [];
    const thinkBuf: string[] = [];

    /** 用户是否按了中断。区分「用户停的」与「自己炸了」—— 两者呈现完全不同。 */
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
          `platform: 中断${channelLabel(projectId)}上 ${agentId} 的回合失败:` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    try {
      const turn = await runTurn({
        session,
        db,
        agentId,
        projectId,
        message: task,
        onEvent: (ev) => {
          bridge(ev, projectId, messageId, hub, textBuf, thinkBuf);
        },
      });
      // 助手消息落库(项目活过会话)。落的是**真正说话的那个 agent**,不是写死 bm。
      const text = turn.text.trim() !== "" ? turn.text : textBuf.join("");
      if (text.trim() !== "") {
        appendSessionMessage(db, {
          id: newId("m"), sessionId, agentId, kind: "assistant",
          content: text, createdAt: now(),
        });
      }
      hub.emitMessageEnd(projectId, messageId);
      hub.emitAgentEnd(projectId);
      if (aborted) {
        // 用户主动中断,但 SDK 的 prompt() 正常返回了(abort 让回合收敛)。
        // 已经拿到的正文照样落库 —— 中断不是丢弃,是「到此为止」。
        log.muted(
          `platform: ${channelLabel(projectId)}上 ${agentId} 的回合被用户中断` +
            `(已产出 ${text.length} 字符)`,
        );
      }
      if (turn.timedOut) {
        hub.broadcast({
          type: "error", projectId,
          error: { code: "turn_timeout", message: `${agentId} 的回合超时收尾,结果可能不完整` },
        });
      }
      return {
        aborted, timedOut: turn.timedOut, text, toolCalls: turn.toolCalls,
        openedProjectIds: turn.openedProjectIds, failed: false,
      };
    } catch (e) {
      // **中断不是故障。** 把一次「停止」报成 `turn_failed` 会让用户以为出了错,
      // 而他要的只是停下来。两条路径呈现不同,但都要收尾(前端还挂着流式气泡)。
      if (aborted) {
        log.muted(
          `platform: ${channelLabel(projectId)}上 ${agentId} 的回合被用户中断:` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
        hub.emitMessageEnd(projectId, messageId);
        hub.emitAgentEnd(projectId);
      } else {
        hub.broadcast({
          type: "error", projectId,
          error: {
            code: "turn_failed",
            message: `${agentId}:${e instanceof Error ? e.message : String(e)}`,
          },
        });
        hub.emitAgentEnd(projectId);
      }
      return {
        aborted, timedOut: false, text: textBuf.join(""), toolCalls: [],
        openedProjectIds: [], failed: true,
      };
    } finally {
      inflight.delete(projectId);
    }
  }

  /**
   * 跑一个工作项(走现成的 `runWorkItem` —— 它自己拼 `composeWorkPrompt`)。
   *
   * 这条路与 `runAgentTurn` 分开是有意的:**工作项的「任务描述」由 BC6 决定,
   * 不由驱动者循环决定**。驱动循环只负责「谁该动、动哪一个」。
   */
  async function runWorkInSession(
    projectId: string,
    agentId: string,
    workId: string,
  ): Promise<DrainWorkReport> {
    const before = getWork(db, workId);
    const title = before?.title ?? workId;
    const got = await getOrCreateSession(projectId, agentId);
    if (!got.ok) {
      hub.broadcast({
        type: "error", projectId,
        error: { code: got.code, message: `${agentId}:${got.message}` },
      });
      return {
        workId, title, status: before?.status ?? "open",
        aborted: false, timedOut: false, text: "", toolCalls: [],
      };
    }
    const session = got.session;
    const sessionId = ensureSession(db, projectId, now(), newId);
    const messageId = newId("msg");
    hub.emitMessageStart(projectId, messageId, "assistant");
    const textBuf: string[] = [];
    const thinkBuf: string[] = [];
    let aborted = false;
    inflight.set(projectId, () => {
      aborted = true;
      void session.abort().catch((err: unknown) => {
        log.error(
          `platform: 中断${channelLabel(projectId)}上 ${agentId} 的执行失败:` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    try {
      const execution = await runWorkItem({
        session, db, workId,
        ...(opts.turnTimeoutMs !== undefined ? { timeoutMs: opts.turnTimeoutMs } : {}),
        // 让 worker 这一回合也流式上屏 —— 否则它在界面上是一段没有反应的等待
        onEvent: (ev) => {
          bridge(ev, projectId, messageId, hub, textBuf, thinkBuf);
        },
      });
      const text = execution.turn.text.trim() !== ""
        ? execution.turn.text
        : textBuf.join("");
      if (text.trim() !== "") {
        appendSessionMessage(db, {
          id: newId("m"), sessionId, agentId, kind: "assistant",
          content: text, createdAt: now(),
        });
      }
      hub.emitMessageEnd(projectId, messageId);
      hub.emitAgentEnd(projectId);
      if (execution.work.status !== before?.status) {
        hub.emitWorkChanged(projectId, workId, execution.work.status);
      }
      if (execution.turn.timedOut) {
        hub.broadcast({
          type: "error", projectId,
          error: { code: "turn_timeout", message: `工作项 ${workId} 的回合超时收尾` },
        });
      }
      return {
        workId,
        title: execution.work.title,
        status: execution.work.status,
        aborted,
        timedOut: execution.turn.timedOut,
        text,
        toolCalls: execution.turn.toolCalls,
      };
    } catch (e) {
      hub.broadcast({
        type: "error", projectId,
        error: {
          code: "work_failed",
          message: `执行 ${workId} 时抛错:${e instanceof Error ? e.message : String(e)}`,
        },
      });
      hub.emitMessageEnd(projectId, messageId);
      hub.emitAgentEnd(projectId);
      return {
        workId, title, status: getWork(db, workId)?.status ?? before?.status ?? "open",
        aborted, timedOut: false, text: textBuf.join(""), toolCalls: [],
      };
    } finally {
      inflight.delete(projectId);
    }
  }

  // ── 排空器接线(判定在 runtime/dispatcher.ts)─────────────────
  //
  // 这里**只有接线**:两个触发点(门铃 / 定时器)都不携带状态,判定与排空
  // 全在 `drainProject`。宿主**不再持有任何跨排空的状态** —— 批次 20 的
  // `stallStore` 与 `cascadeStates` 整块消失:它们要挡的两件事(「同一个待办
  // 被反复叫醒」与「撞上界时下游结果不丢」)现在分别由库里的尝试预算
  // (`dispatch_attempts`)与 outbox(`dispatch_events`)承担。

  let draining = false;
  /**
   * 「排空进行中有人敲过门」。
   *
   * 这不是「刚才发生了什么」的记忆 —— 它不参与任何判定(`collectTodos` 永远
   * 重新查库)。它只是门铃的打点:排空跑到「没有待办」为止,所以门铃在忙碌期间
   * 响过就再跑一遍外层循环,免得刚查完那一刻落地的状态要等下一次定时器。
   */
  let nudgedWhileBusy = false;

  /** 门铃:状态迁移后敲一下。**不携带任何状态**,只说「现在去查一下」。 */
  function nudge(): void {
    if (draining) {
      nudgedWhileBusy = true;
      return;
    }
    void drainAll("nudge").catch((err: unknown) => {
      log.error(`platform: 排空失败 —— ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * 扫一遍全部活跃项目,每个排空到没有待办为止。
   *
   * `source` 只用于**留痕**(门铃 / 定时器)—— 两个触发点的行为完全一样,
   * 判定与排空都不因它改变。没有这一行,事后就无法回答「这一步是谁触发的」,
   * 而「哪条路径在工作」正是这次重构最需要能看见的事(7-N:见不到的现场等于没有现场)。
   *
   * ⚠️ **一条待办都没跑的时候不打日志。** 定时器是 10 秒一次,而绝大多数 tick
   * 都是「没有待办」—— 每次都打一行「排空开始/结束」会在几小时里刷满日志,
   * 把真正有信息量的行淹掉(与超时扫描「只在集合变化时广播」同一条理由)。
   * 有回合数才留痕:`排空收尾(触发=… · N 回合 · 路径 …)`。
   */
  async function drainAll(source: "nudge" | "timer"): Promise<void> {
    if (draining) {
      nudgedWhileBusy = true;
      return;
    }
    draining = true;
    let projects = 0;
    let rounds = 0;
    let path: string[] = [];
    let deliberateStop = false;
    try {
      do {
        nudgedWhileBusy = false;
        projects = 0;
        rounds = 0;
        path = [];
        deliberateStop = false;
        for (const p of listProjects(db, "active")) {
          projects++;
          const r = await drainOne(p.id);
          if (r === null) continue;
          rounds += r.rounds;
          path.push(...r.visited.map((v) => v.agentId));
          if (r.stopReason === "max_rounds" || r.stopReason === "no_progress") {
            deliberateStop = true;
          }
        }
        /**
         * ── 重跑一次的条件(真机跑出来的一个洞)──────────────────────────
         *
         * 「排空进行中有人敲过门」时再查一遍:否则刚查完那一刻落地的状态要等
         * 下一次定时器。**但不许绕过硬上界**:排空自己跑出来的工具门铃
         * (`work_update` / `work_create` …)也会把 `nudgedWhileBusy` 置真,
         * 于是一次 `maxRounds=1` 的排空会「1 回合 → 重跑 → 1 回合 → 重跑 …」
         * 一直跑下去 —— `maxRounds` 从「单次排空的上界」退化成「每趟的上界」,
         * 而它唯一的用途就是**烧 token 的闸**(真机实测:设 1 之后仍然一路跑完
         * 了 wk → qa → bm)。
         *
         * 所以:**故意停下(max_rounds / 预算用尽)就不再重跑**。该等下一次
         * 定时器 —— 那是它存在的理由(兜底),而不是把上界让给门铃。
         */
      } while (nudgedWhileBusy && !deliberateStop);
    } finally {
      draining = false;
      if (rounds > 0) {
        log.muted(
          `platform: 排空收尾(触发=${source} · ${projects} 个项目 · ${rounds} 回合` +
            (path.length > 0 ? ` · 路径 ${path.join("→")}` : "") +
            ")",
        );
      }
    }
  }

  /**
   * 排空一个项目。返回它的结果(`null` = 因为正在跑别的回合而让开)。
   *
   * `hub.isBusy` 是**重入闩**的一半:用户消息那条路正在跑同一个项目的回合时,
   * 排空让开(那条路自己会在回合结束后敲门)。另一半是上面的 `draining` ——
   * 一次排空可能比定时器间隔还长,不加闩就会叠起来跑(而每一层都在花 token)。
   */
  async function drainOne(projectId: string): Promise<DrainResult | null> {
    if (hub.isBusy(projectId)) {
      log.muted(`platform: ${channelLabel(projectId)}正在跑一个回合,跳过本次排空`);
      return null;
    }
    hub.setBusy(projectId, true);
    /** 这一轮排空被用户中断过 —— 传进 dispatcher 让它立刻停 */
    let cancelled = false;
    try {
      const result = await drainProject({
        db,
        projectId,
        now,
        log: (l) => log.muted(l),
        ...(opts.maxCascadeRounds !== undefined ? { maxRounds: opts.maxCascadeRounds } : {}),
        isCancelled: () => cancelled,
        runAgentTurn: async (agentId, task): Promise<DrainTurnReport> => {
          const r = await runAgentTurn(projectId, agentId, task);
          if (r.aborted) cancelled = true;
          return {
            aborted: r.aborted, timedOut: r.timedOut, text: r.text, toolCalls: r.toolCalls,
            failed: r.failed,
          };
        },
        runWork: async (agentId, workId): Promise<DrainWorkReport> => {
          const r = await runWorkInSession(projectId, agentId, workId);
          if (r.aborted) cancelled = true;
          return r;
        },
      });
      announceDrain(projectId, result);
      return result;
    } finally {
      hub.setBusy(projectId, false);
      inflight.delete(projectId);
    }
  }

  /**
   * 排空停下来之后**如实告诉用户它是怎么停的**。
   *
   * ⚠️ 异常停止(`max_rounds` / 预算用尽)**不能静默** —— 界面会回到 idle,
   * 而用户会以为「还在跑」或「已经做完了」。两种误解都会让他在错误的时刻做决定。
   * 所以做两件事:广播一条 `cascade_stopped`(前端立刻看见)+ 落一条 `system`
   * 会话消息(刷新之后还在)。正常的 `exhausted` / `cancelled` 不打扰他。
   *
   * 「预算用尽」只在**第一次**用尽时播报(`newlyExhausted`)—— 否则每 10 秒一条
   * system 消息,那也是一种静默。
   */
  function announceDrain(projectId: string, r: DrainResult): void {
    const who = r.visited.map((v) => v.agentId).join(" → ");
    const reason = r.stopReason;
    const reportable =
      reason === "max_rounds" || (reason === "no_progress" && r.newlyExhausted.length > 0);
    // 什么都没跑的安静停(没有待办 / 已经报过的预算用尽)不刷日志 ——
    // 每 10 秒一行「排空结束」会把真正有信息量的行淹掉
    if (r.rounds === 0 && !reportable) return;
    log.muted(
      `platform: ${channelLabel(projectId)}排空结束 —— ${r.rounds} 回合,` +
        `停止原因 ${reason}(${r.stopDetail})` +
        (who !== "" ? `\n        路径:${who}` : ""),
    );
    if (!reportable) return;
    hub.broadcast({
      type: "cascade_stopped",
      projectId,
      rounds: r.rounds,
      reason,
      detail: r.stopDetail,
    });
    const sessionId = ensureSession(db, projectId, now(), newId);
    appendSessionMessage(db, {
      id: newId("m"),
      sessionId,
      agentId: null,
      kind: "system",
      content:
        `⚠️ 组织停止推进(${r.rounds} 个回合后):${r.stopDetail}` +
        (who !== "" ? `\n本轮路径:${who}` : ""),
      createdAt: now(),
    });
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
        disposeAllSessions("设置变更 —— 下次对话用新模型重建");
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
      disposeAllSessions("数据重置");
      // ⚠️ 这里**没有**任何排空器状态要清 —— 那是这次重构的要点:
      // 判定与状态全在库里(works.review_state / dispatch_events /
      // dispatch_attempts 都是平台表,由 `resetPlatformData` 一起清),
      // 进程内存里一份都不留。批次 20 在这里清 `cascadeStates` 与 `stallStore`
      // 的那两行,正是因为当时状态漏进了内存。
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

  // ── 两个周期入口(职责不同,分开)─────────────────────────────
  //
  //   ① 调度器(60s):扫超时提问并推给前端。**不自动升级** —— 经 jev 校准,
  //      单人本地服务里「人暂时没回」是常态而不是故障(见 scheduler.ts 文件头)。
  //   ② 排空定时器(**fixed-delay,默认 10s**):排空器的兜底触发 ——
  //      重启恢复、事件漏掉的、以及外部直接改库的场合。
  //
  // 为什么分成两条而不是继续挂在调度器上:两条周期的**语义**不同。超时扫描是
  // 「每 60 秒看一眼有没有人没回」,而排空是「有活就干、没活就什么都不做」的
  // 兜底 —— 它们的合理间隔差一个数量级(10s vs 60s),合成一条必然要迁就其中
  // 一个。fixed-delay(上一轮跑完再等 10s)还顺带保证了两轮排空不重叠。
  const scheduler: Scheduler = startScheduler({
    db,
    now,
    broadcast: (ev) => hub.broadcast(ev),
    log: (l) => log.muted(l),
    ...(opts.schedulerIntervalMs !== undefined
      ? { intervalMs: opts.schedulerIntervalMs }
      : {}),
  });

  const dispatchTimer: FixedDelayLoop = startFixedDelay({
    intervalMs: opts.dispatchIntervalMs ?? DEFAULT_DISPATCH_INTERVAL_MS,
    run: () => drainAll("timer"),
    log: (l) => log.error(l),
  });

  return {
    app,
    hub,
    booted,
    scheduler,
    dispatchTimer,
    sessionCount: () => sessions.size,
    close: () => {
      scheduler.stop();
      dispatchTimer.stop();
      disposeAllSessions("服务关闭");
      booted.close();
    },
  };
}

/** 排空定时器的默认间隔:**fixed-delay 10 秒**(上一轮跑完再等 10 秒)。 */
const DEFAULT_DISPATCH_INTERVAL_MS = 10_000;

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

  const wss = attachHub(server, host.hub);

  /**
   * 优雅关闭。
   *
   * ── 为什么这段曾经关不掉(真机:用户连按 8 次 Ctrl-C 无反应)────────
   *
   * 原实现只有三行:`打印 → host.close() → server.close()`。三个问题叠在一起:
   *
   * ① **`server.close()` 不关闭已建立的连接** —— 它只停止接受新连接,然后等现有
   *    连接结束。而浏览器那条 **WebSocket 是长连接**,永远不结束,于是它永远等下去。
   * ② **没有 `process.exit()`** —— 所以「正在关闭」打完就卡在那儿。
   * ③ **没有幂等保护** —— 每按一次 Ctrl-C 就重跑一遍,于是同一句话打印 8 次,
   *    而观感上「它在响应」,实际什么也没推进。
   *
   * 现在:主动 terminate WS → 关宿主与 HTTP → **兜底超时自己退** →
   * 第二次信号**立刻退**(连按 Ctrl-C 就是标准的「别等了」表达)。
   */
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) {
      // 第二次信号 = 「别优雅了」。这条必须存在,否则一旦兜底也失效,
      // 用户就只剩 kill -9 一条路。
      log.muted(`再收到一次 ${signal} —— 直接退出`);
      process.exit(130);
    }
    closing = true;
    log.muted("平台服务收到退出信号,正在关闭");

    // ① 主动断开所有 WS。不做这一步,server.close() 的回调永远不会触发。
    for (const ws of wss.clients) ws.terminate();

    host.close();
    server.close();

    // ② 兜底:优雅关闭仍可能被别的东西撑着(三方库自己的句柄等)。
    //    到点自己退 —— 不把「能不能关掉」这件事交回给用户。
    setTimeout(() => {
      log.muted("优雅关闭超时(3s),直接退出");
      process.exit(130);
    }, 3000).unref();

    // ③ 关干净了也显式退。让「关掉了」与「卡住了」在观感上可区分 ——
    //    两者都只打印一行 muted 日志的话,用户分不出来。
    server.on("close", () => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return { close: () => shutdown("close()") };
}

// 让 `ServerEvent` 的 import 不被 tree-shake 掉(类型只在编译期存在,
// 这里显式引用一次以免 lint 报未使用)
export type { ServerEvent };
