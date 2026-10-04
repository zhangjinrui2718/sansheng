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
import { getArtifact, type ArtifactRow } from "../storage/repo/artifacts.js";
import { listSessions, insertSession, appendSessionMessage } from "../storage/repo/sessions.js";
import { getProjectRow } from "../storage/repo/projects.js";
import { toArtifactView, toClientQuestionView, toWorkView } from "./views.js";
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
  /** 用户在一个项目里说了句话 —— host 负责建会话 / 跑回合 */
  readonly onUserMessage: (projectId: string, content: string) => Promise<void>;
  /** 用户答了一个 client_question */
  readonly onAnswerQuestion: (questionId: string, answer: string) => Promise<void>;
  readonly onInterrupt: (projectId: string) => void;
}

export class PlatformHub {
  private readonly clients = new Set<WebSocket>();
  /** 每个项目当前正在跑的回合(用于 interrupt 与「忙」状态) */
  private readonly busy = new Set<string>();

  constructor(
    private readonly deps: HubDeps,
    private readonly handlers: HubHandlers,
  ) {}

  clientCount(): number {
    return this.clients.size;
  }

  isBusy(projectId: string): boolean {
    return this.busy.has(projectId);
  }

  setBusy(projectId: string, v: boolean): void {
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
      const projectId = "projectId" in cmd && typeof cmd.projectId === "string" ? cmd.projectId : undefined;
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

  emitMessageStart(projectId: string, messageId: string, role: "user" | "assistant"): void {
    this.broadcast({ type: "message_start", projectId, messageId, role });
  }
  emitDelta(projectId: string, messageId: string, text: string): void {
    this.broadcast({ type: "delta", projectId, messageId, text });
  }
  /** 内部推理走**独立**事件 —— 与 delta 永不混流(7-I 的现场)。 */
  emitThinking(projectId: string, messageId: string, text: string): void {
    this.broadcast({ type: "thinking_delta", projectId, messageId, text });
  }
  emitMessageEnd(projectId: string, messageId: string, usage?: { input: number; output: number }): void {
    this.broadcast({ type: "message_end", projectId, messageId, ...(usage !== undefined ? { usage } : {}) });
  }
  emitToolStart(projectId: string, messageId: string, tool: WsToolInfo): void {
    this.broadcast({ type: "tool_start", projectId, messageId, tool });
  }
  emitToolEnd(projectId: string, messageId: string, tool: WsToolInfo): void {
    this.broadcast({ type: "tool_end", projectId, messageId, tool });
  }
  emitAgentEnd(projectId: string): void {
    this.broadcast({ type: "agent_end", projectId, ts: this.deps.now() });
  }

  /** 新工件落库后调用 —— 前端据此刷新黑板。 */
  emitArtifactCreated(row: ArtifactRow): void {
    this.broadcast({ type: "artifact_created", artifact: toArtifactView(this.deps.db, row, (id) => id) });
  }

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

      tell: async ({ projectId, message }) => {
        // 播报也要落库:项目活过会话,只广播的话刷新就没了
        const at = this.deps.now();
        const sessionId = ensureSession(this.deps.db, projectId, at, this.deps.newId);
        appendSessionMessage(this.deps.db, {
          id: this.deps.newId("m"),
          sessionId,
          agentId: "bm",
          kind: "assistant",
          content: message,
          createdAt: at,
        });
        const messageId = this.deps.newId("msg");
        this.emitMessageStart(projectId, messageId, "assistant");
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

/** 拿该项目的第一条会话,没有就建一条。**每个项目一条连续对话**(经校准的裁决)。 */
export function ensureSession(
  db: Database.Database,
  projectId: string,
  at: number,
  newId: (p: string) => string,
): string {
  if (getProjectRow(db, projectId) === null) {
    throw new Error(`项目 ${projectId} 不存在 —— 不能往不存在的项目里写消息`);
  }
  const existing = listSessions(db, projectId);
  if (existing.length > 0) return existing[0]!.id;
  const id = newId("s");
  insertSession(db, { id, projectId, createdAt: at });
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
