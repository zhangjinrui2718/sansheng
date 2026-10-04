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
import { createPlatformSession } from "../runtime/session.js";
import { runTurn } from "../runtime/turn.js";
import { ORG, ensureOrg, orgReady } from "../runtime/org.js";
import { createPlatformApp } from "../transport/http.js";
import { attachHub, ensureSession, PlatformHub } from "../transport/hub.js";
import { appendSessionMessage } from "../storage/repo/sessions.js";
import { resolveClientQuestion } from "../tools/client.js";
import { listProjectSummaries } from "../transport/views.js";
import { getProjectRow } from "../storage/repo/projects.js";
import { getAgent } from "../storage/repo/agents.js";
import { log } from "../../shared/log.js";
import { maskApiKey } from "../../server/storage/keyring.js";
import type { ServerEvent } from "@shared/types/platform.js";

export interface ServeOptions {
  readonly dataDir: string;
  readonly host: string;
  readonly port: number;
  readonly cwd?: string;
  readonly version: string;
  /** 打开浏览器 */
  readonly open?: boolean;
}

const HERE = fileURLToPath(new URL(".", import.meta.url));

export interface PlatformHost {
  readonly app: Hono;
  readonly hub: PlatformHub;
  readonly booted: BootedPlatform;
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

  // ── 常驻会话(每个项目一个)────────────────────────────────────
  const sessions = new Map<string, AgentSession>();
  const inflight = new Map<string, AbortController>();

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
        inflight.get(projectId)?.abort();
      },
    },
  );

  function getClientQuestionProject(questionId: string): string | null {
    const row = db
      .prepare(`SELECT project_id AS p FROM artifacts WHERE id = ?`)
      .get(questionId) as { p: string } | undefined;
    return row?.p ?? null;
  }

  /** 用户在一个项目里说了一句话 → 业务经理跑一个回合,全程流式推给前端。 */
  async function handleUserMessage(projectId: string, content: string): Promise<void> {
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
      if (booted.model === null) {
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
        model: booted.model,
          dataDir: opts.dataDir,
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
      log.muted(`platform: 为项目 ${projectId} 建了业务经理会话`);
    }

    // 3. 跑回合,事件桥到前端
    const messageId = newId("msg");
    hub.setBusy(projectId, true);
    hub.emitMessageStart(projectId, messageId, "assistant");
    const textBuf: string[] = [];
    const thinkBuf: string[] = [];

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
      if (turn.timedOut) {
        hub.broadcast({
          type: "error", projectId,
          error: { code: "turn_timeout", message: "回合超时收尾,结果可能不完整" },
        });
      }
    } catch (e) {
      hub.broadcast({
        type: "error", projectId,
        error: { code: "turn_failed", message: e instanceof Error ? e.message : String(e) },
      });
      hub.emitAgentEnd(projectId);
    } finally {
      hub.setBusy(projectId, false);
      inflight.delete(projectId);
    }
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
      read: () => shapeSettings(booted),
      write: async () => ({ ok: false as const, error: "设置写入尚未接到平台侧 —— 用旧的 /api/settings(旧服务运行时)" }),
      providers: () => [],
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

  return {
    app,
    hub,
    booted,
    sessionCount: () => sessions.size,
    close: () => {
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

function bridge(
  ev: AgentSessionEvent,
  projectId: string,
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

// ── 设置(沿用旧 store —— 它是基础设施,不是旧系统的领域逻辑)──────

function shapeSettings(booted: BootedPlatform): unknown {
  const s = booted.settings;
  return {
    providers: s.providers.map((p) => ({
      id: p.id, label: p.label, provider: p.provider, modelId: p.modelId,
      // 掩码而不是空串 —— 空串会让前端以为「没配 key」,
      // 而掩码是 isMaskedApiKey 认得的形态,回写时能正确保留旧真值
      apiKey: maskApiKey(p.apiKey), hasApiKey: p.apiKey.length > 0,
      baseUrl: p.baseUrl, thinkingLevel: p.thinkingLevel,
    })),
    activeProviderId: s.activeProviderId,
    cwd: s.cwd,
    personaName: s.personaName,
    costBudgetUsd: s.costBudgetUsd,
  };
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
