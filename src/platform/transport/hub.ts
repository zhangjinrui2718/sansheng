/**
 * 传输层 · WS 枢纽
 *
 * ── 它是什么 ────────────────────────────────────────────────────
 *
 * 一个进程内的广播点:所有浏览器连接登记在这里,服务端事件从这里扇出。
 * 它同时是 `ClientChannel` 的真实实现 —— 也就是说,业务经理调 `ask_client`
 * 时,那条问题**经由这里**到达用户屏幕。
 *
 * 旧系统对应物是 `kernel.attachSink` + `wss` 的组合,但那时 sink 被捕获进
 * kernel 闭包,于是**首个连接的死亡会切断所有输出**(旧代码注释里的 S1/A7
 * 记着这个事故)。这里用集合 + 逐连接发送,某个连接死了只影响它自己。
 *
 * ── 为什么事件要带 projectId ─────────────────────────────────────
 *
 * 「按项目分组呈现」是经校准的裁决:项目即上下文容器,用户切项目 = 切上下文。
 * 所以前端拿到一条事件时,必须能判断它属于哪个项目 —— 否则多项目并行时
 * 两条流会混在一起。
 *
 * ── `tell` 为什么落库 ────────────────────────────────────────────
 *
 * `tell_client` 是播报,**不替代落库** —— 这是 `business_manager.protocol`
 * 里明写的规则(「播报过的话在会话里、在甲方的记忆里,但不在项目上」)。
 * 所以播报同时做两件事:写一条 session message(项目活过会话),广播三个事件
 * (用户立刻看见)。只广播不落库的话,刷新页面它就没了。
 */
import { WebSocketServer, type WebSocket } from "ws";
import type { Server as HttpServer } from "node:http";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type Database from "better-sqlite3";
import type { ClientChannel, ClientQuestion } from "../client/port.js";
import { getArtifact } from "../storage/repo/artifacts.js";
import {
  listSessions, insertSession, appendSessionMessage, findSessionByChannel,
  type SessionChannel,
} from "../storage/repo/sessions.js";
import { getProjectRow } from "../storage/repo/projects.js";
import { toClientQuestionView, toWorkView } from "./views.js";
import { getAgent } from "../storage/repo/agents.js";
import type {
  ClientCommand, ClientQuestionView, ServerEvent, WsToolInfo,
} from "@shared/types/platform.js";

export interface HubDeps {
  readonly db: Database.Database;
  readonly now: () => number;
  readonly newId: (prefix: string) => string;
}

export interface HubHandlers {
  /**
   * 用户在一个项目(或**接待会话**,`null`)里说了句话 —— host 负责建会话 / 跑回合。
   */
  readonly onUserMessage: (projectId: string | null, content: string) => Promise<void>;
  /** 用户答了一个 client_question */
  readonly onAnswerQuestion: (questionId: string, answer: string) => Promise<void>;
  readonly onInterrupt: (projectId: string | null) => void;
}

export class PlatformHub {
  private readonly clients = new Set<WebSocket>();
  /**
   * 每个上下文当前正在跑的回合(用于 interrupt 与「忙」状态)。
   *
   * 键是 `string | null` —— `null` 就是**接待会话**。不引入哨兵字符串是有意的:
   * 哨兵要么在前后端各写一份字面量(迟早漂),要么得从 `@shared` 值导入
   * (server 侧禁止,见 AGENTS.md)。`null` 本身就是「还没有项目」的诚实表示。
   */
  private readonly busy = new Set<string | null>();

  constructor(
    private readonly deps: HubDeps,
    private readonly handlers: HubHandlers,
  ) {}

  clientCount(): number {
    return this.clients.size;
  }

  isBusy(projectId: string | null): boolean {
    return this.busy.has(projectId);
  }

  setBusy(projectId: string | null, v: boolean): void {
    if (v) this.busy.add(projectId);
    else this.busy.delete(projectId);
  }

  // ── 连接管理 ──────────────────────────────────────────────────

  addClient(ws: WebSocket): void {
    this.clients.add(ws);
    ws.on("close", () => this.clients.delete(ws));
    ws.on("error", () => this.clients.delete(ws));

    this.sendTo(ws, {
      type: "ready",
      modelId: null,
      provider: null,
      cwd: "",
    });

    ws.on("message", (raw: unknown) => {
      void this.handleRaw(ws, raw);
    });
  }

  private async handleRaw(ws: WebSocket, raw: unknown): Promise<void> {
    let cmd: ClientCommand;
    try {
      const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : String(raw);
      cmd = JSON.parse(text) as ClientCommand;
    } catch {
      this.sendTo(ws, { type: "error", error: { code: "bad_json", message: "消息不是合法 JSON" } });
      return;
    }
    if (cmd === null || typeof cmd !== "object" || typeof cmd.type !== "string") {
      this.sendTo(ws, { type: "error", error: { code: "bad_command", message: "缺少 type" } });
      return;
    }

    try {
      switch (cmd.type) {
        case "ping":
          this.sendTo(ws, { type: "pong", ts: this.deps.now() });
          return;
        case "send":
          if (this.busy.has(cmd.projectId)) {
            this.sendTo(ws, {
              type: "error", projectId: cmd.projectId,
              error: { code: "busy", message: "这个项目正在跑一个回合,等它结束或先中断" },
            });
            return;
          }
          await this.handlers.onUserMessage(cmd.projectId, cmd.content);
          return;
        case "answer_client_question":
          await this.handlers.onAnswerQuestion(cmd.questionId, cmd.answer);
          return;
        case "interrupt":
          this.handlers.onInterrupt(cmd.projectId);
          return;
        default: {
          // 穷尽性检查:新增 ClientCommand 时这里会编译失败
          const never: never = cmd;
          this.sendTo(ws, {
            type: "error",
            error: { code: "unknown_command", message: `未知指令 ${JSON.stringify(never)}` },
          });
        }
      }
    } catch (e) {
      // 错误要带上下文。`projectId: null` 是**接待会话**;字段整个缺席是
      // 「与任何上下文无关」(如 JSON 解析失败)—— 前端据此决定弹在哪。
      const projectId =
        "projectId" in cmd && (typeof cmd.projectId === "string" || cmd.projectId === null)
          ? cmd.projectId
          : undefined;
      this.sendTo(ws, {
        type: "error",
        ...(projectId !== undefined ? { projectId } : {}),
        error: { code: "handler_failed", message: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  // ── 广播 ──────────────────────────────────────────────────────

  broadcast(ev: ServerEvent): void {
    for (const ws of [...this.clients]) this.sendTo(ws, ev);
  }

  private sendTo(ws: WebSocket, ev: ServerEvent): void {
    try {
      ws.send(JSON.stringify(ev));
    } catch {
      // 写失败说明这条连接坏了 —— 摘掉它,但**不影响别的连接**
      // (旧系统的 S1/A7 事故就是 sink 被单连接捕获)
      this.clients.delete(ws);
    }
  }

  // ── 事件发射(host 与工具共用)────────────────────────────────

  /**
   * 「某条消息开始流了」——**它同时是前端唯一能建轮的事件之一**,所以
   * `agentId` 必填(见 `shared/types/platform.ts` 的 ServerEvent 说明):
   * 漏填不会报错,只会让前端把这条流当成一个**无名助手**(静默)。
   *
   * `agentId === null` = **甲方**(用户在说话),与 `session_messages.agent_id`
   * 同义。**不给默认值**是刻意的:默认值会让漏传的调用点编译通过。
   */
  emitMessageStart(
    projectId: string | null,
    messageId: string,
    role: "user" | "assistant",
    agentId: string | null,
  ): void {
    this.broadcast({ type: "message_start", projectId, messageId, role, agentId });
  }
  emitDelta(projectId: string | null, messageId: string, text: string): void {
    this.broadcast({ type: "delta", projectId, messageId, text });
  }
  /** 内部推理走**独立**事件 —— 与 delta 永不混流(7-I 的现场)。 */
  emitThinking(projectId: string | null, messageId: string, text: string): void {
    this.broadcast({ type: "thinking_delta", projectId, messageId, text });
  }
  emitMessageEnd(projectId: string | null, messageId: string, usage?: { input: number; output: number }): void {
    this.broadcast({ type: "message_end", projectId, messageId, ...(usage !== undefined ? { usage } : {}) });
  }
  /**
   * 「某个工具开始跑了」。`tool_start` **自己也能建轮**
   * (`get().currentTurn ?? newTurn(e.messageId, ...)`)⇒ 同样必填 `agentId`。
   */
  emitToolStart(
    projectId: string | null,
    messageId: string,
    tool: WsToolInfo,
    agentId: string | null,
  ): void {
    this.broadcast({ type: "tool_start", projectId, messageId, agentId, tool });
  }
  emitToolEnd(projectId: string | null, messageId: string, tool: WsToolInfo): void {
    this.broadcast({ type: "tool_end", projectId, messageId, tool });
  }
  emitAgentEnd(projectId: string | null): void {
    this.broadcast({ type: "agent_end", projectId, ts: this.deps.now() });
  }

  /**
   * 业务经理刚在接待会话里立起了项目。
   *
   * **由 host 在回合结束后调用**,不由工具直接广播:工具在回合中间执行,
   * 那时候广播会让前端在一条正在流的回合里换上下文(半个回合的输出落错面板)。
   */
  emitProjectOpened(projectId: string, name: string): void {
    this.broadcast({ type: "project_opened", projectId, name });
  }

  // ⚠️ 这里**没有** `emitArtifactCreated`:它自批次 12 引入起就没有任何调用方
  // (工件变化目前只经 HTTP 回查到达前端),于 B3 死代码清理删除。
  // 与之配套的 `artifact_created` 契约成员 / 前端 handler 由各自的持有者处置。

  emitWorkChanged(projectId: string, workId: string, status: string): void {
    this.broadcast({ type: "work_changed", projectId, workId, status: status as never });
  }

  /** 把它转成 `client_question` 事件(工具落库之后由 channel.ask 触发)。 */
  emitClientQuestion(q: ClientQuestionView): void {
    this.broadcast({ type: "client_question", question: q });
  }

  // ── ClientChannel 实现 ────────────────────────────────────────

  /**
   * 真实的甲方通道。
   *
   * 它**不做落库** —— 提问工件由 `ask_client` 工具在调用本方法**之前**已经写好
   * (顺序反了会出现「问题已经发给用户但库里没有记录」,用户答完之后无处回填)。
   * 这里只负责把已有的那条工件广播出去。
   */
  get clientChannel(): ClientChannel {
    return {
      ask: async (input: ClientQuestion & { questionId: string; projectId: string }) => {
        const row = getArtifact(this.deps.db, input.questionId);
        if (row === null) {
          throw new Error(
            `channel.ask 收到的 questionId ${input.questionId} 在库里不存在 —— ` +
              `提问必须**先落库再投递**(见 ask_client 工具的注释)`,
          );
        }
        this.emitClientQuestion(toClientQuestionView(this.deps.db, row, (id) => nameOf(this.deps.db, id)));
      },

      tell: async ({ projectId, message, agentId }) => {
        // 播报也要落库:项目活过会话,只广播的话刷新就没了。
        // **作者是调用方给的真实 agent id** —— 从前这里写死成业务经理的 id,
        // 今天恰好对(只有它会播报),但组织表换 id 的那一刻就**静默归错人**。
        const at = this.deps.now();
        // **通道 = `client`(调用点显式声明)**:`tell_client` 就是「业务经理对
        // 甲方说话」,它属于**甲方通道**。交付对话开出来之后(C4),播报落在
        // 那场交付的对话里;开出来之前,`ensureSession` 明确回退到项目内部会话
        // (那条会话此刻就是甲方看得到的对话)—— 见 `ensureSession` 的注释。
        const sessionId = ensureSession(
          this.deps.db, projectId, at, this.deps.newId, "client",
        );
        appendSessionMessage(this.deps.db, {
          id: this.deps.newId("m"),
          sessionId,
          agentId,
          kind: "assistant",
          content: message,
          createdAt: at,
        });
        const messageId = this.deps.newId("msg");
        this.emitMessageStart(projectId, messageId, "assistant", agentId);
        this.emitDelta(projectId, messageId, message);
        this.emitMessageEnd(projectId, messageId);
      },
    };
  }
}

// ── 辅助 ────────────────────────────────────────────────────────

function nameOf(db: Database.Database, agentId: string): string {
  const a = getAgent(db, agentId);
  return a !== null ? a.displayName : agentId;
}

/**
 * 拿**这个通道**的那条会话,没有就建一条。**每个项目一条连续对话**(经校准的裁决)。
 *
 * `projectId === null` = **接待会话**:全局只有那一条(`project_id IS NULL`)。
 * 这里不额外做「只能有一条」的判定 —— 那条不变量在 **schema 层**由
 * `idx_session_single_intake` 机械保证(见 `migrations/012_intake_session.sql`),
 * 应用层再判一次只会多一处会漂的真相。
 *
 * ── ⚠️ `channel` 是**必填实参**,这就是 C4 拆的那条地雷 ─────────────
 *
 * 旧写法没有通道参数,于是只能 `listSessions(db, projectId)[0]` —— **挑项目里最新
 * 那条会话**。它今天恰好对(每项目一条),但交付会话(C4)一建出来,六处调用点就会
 * 把**所有角色**的消息都写进那条交付对话:消息一条不少,只是**分错了会话**,而
 * 表现是静默的(设计 1 §2.11.6)。现在每处调用点各自声明自己写的是内部通道还是
 * 甲方通道,库里的判据是 `(project_id, channel)`。
 *
 * **`client` 有一条明确回退(不是「挑最新的」)**:这条项目**还没有**交付对话时,
 * 落回项目内部会话。理由是可查的 —— 交付之前**不存在第二条对话**,那条内部会话
 * 就是甲方此刻能看到的对话。回退目标是唯一的(每个项目至多一条 `internal`),
 * 与旧写法那种「谁最新是谁」的含糊有本质区别。没有这条回退,任何一个 `client`
 * 调用点都会给项目**凭空造出**一条会话,于是「拆地雷不改行为」当场为假。
 *
 * ⚠️ 惰性建出来的会话**一律是 `internal`**:`client` 通道的会话只由平台在
 * `handover` 回合成功后开(`repo/sessions.ts` 的 `openDeliverableSession`)。
 * 让「甲方通道」可以由一次用户消息凭空产生,等于把「哪条对话是哪场交付开的」
 * 这个问题重新变成猜的。
 *
 * ⚠️ 接待会话**不校验项目存在**(没有项目可校验);项目会话必须校验 —— 往不存在的
 * 项目里写消息会让那条对话永远读不出来。
 */
export function ensureSession(
  db: Database.Database,
  projectId: string | null,
  at: number,
  newId: (p: string) => string,
  channel: SessionChannel,
): string {
  // 接待会话:通道对它没有意义(它既不是项目主会话,也不是交付对话)。
  // schema 的 `DEFAULT 'internal'` 就是它的通道。
  if (projectId === null) {
    const intake = listSessions(db, null);
    if (intake.length > 0) return intake[0]!.id;
    const id = newId("s");
    insertSession(db, { id, projectId: null, createdAt: at, channel: "internal" });
    return id;
  }
  if (getProjectRow(db, projectId) === null) {
    throw new Error(`项目 ${projectId} 不存在 —— 不能往不存在的项目里写消息`);
  }
  const picked =
    findSessionByChannel(db, projectId, channel) ??
    (channel === "client" ? findSessionByChannel(db, projectId, "internal") : null);
  if (picked !== null) return picked.id;
  const id = newId("s");
  insertSession(db, { id, projectId, createdAt: at, channel: "internal" });
  return id;
}

// ── 挂到 http.Server 上 ─────────────────────────────────────────

/** 只放行本机 Origin(与旧系统 B4 的处置一致;无 Origin 的客户端放行)。 */
function isAllowedOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return false;
  }
}

export function attachHub(server: HttpServer, hub: PlatformHub): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    const originRaw = req.headers.origin;
    const origin = Array.isArray(originRaw) ? originRaw[0] : originRaw;
    if (typeof origin === "string" && !isAllowedOrigin(origin)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => hub.addClient(ws));

  // 心跳:30 秒 ping 一次,没 pong 的判定为死连接
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.ping();
    }
  }, 30_000);
  timer.unref?.();

  return wss;
}
