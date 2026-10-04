/**
 * Sansheng WebSocket client · 单连接、双向 JSON 协议(项目为中心)
 *
 * ── 与旧实现的区别(整份重写,不是改几行)────────────────────────────
 *
 * 旧 `ChatSocket` 绑在 `shared/types/ws.ts` 上:10 个 ClientCommand、34 个
 * ServerEvent,命令里带着 `conversationId`,`load_conversation` / `bus_replay` /
 * `plan` / `abort_plan` 这些机制**在新架构里都不存在了**(对话就是项目、总线已删、
 * 计划由项目经理拆成工作项)。继续在旧 union 上打补丁,只会让类型说一套、
 * 后端做另一套。
 *
 * 现在直接消费冻结契约 `@shared/types/platform` 的 `ClientCommand` / `ServerEvent`:
 *   - 命令从 10 个收敛到 4 个;
 *   - 每条带项目的事件都有 `projectId`,前端用契约导出的 `eventProjectId()`
 *     把流分派到正确的项目面板(jev:按项目分组呈现)。
 *
 * ── 分派纪律 ────────────────────────────────────────────────────
 *
 * `on()` 的订阅者收**全部**事件(store 需要 ready/error 这类无项目事件);
 * 需要「只关心某个项目」的调用方用 `onProject(projectId, h)` —— 它内部就是
 * `eventProjectId(ev) === projectId` 的过滤,**不在 store 里再写一遍判断**。
 *
 * 无 `projectId` 的事件(`ready` / `pong` / `client_question` / `error?`)由
 * `eventProjectId()` 返回 null,`onProject` 一律不派发 —— 这是有意的:
 * 项目面板不该被别的项目的事件刷新。
 */
import {
  eventProjectId,
  type ClientCommand,
  type ServerEvent,
} from "@shared/types/platform";

type Handler = (e: ServerEvent) => void;

export class PlatformSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private projectHandlers = new Map<string, Set<Handler>>();
  private readonly url: string;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitlyClosed = false;

  constructor(url = "/ws") {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    this.url = `${proto}//${window.location.host}${url}`;
  }

  connect(): void {
    this.explicitlyClosed = false;
    this.openSocket();
  }

  private openSocket(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.reconnectAttempts = 0;
    };
    ws.onmessage = (ev) => {
      let data: ServerEvent;
      try {
        data = JSON.parse(String(ev.data)) as ServerEvent;
      } catch {
        return; // 坏帧丢弃,不断连接
      }
      this.handlers.forEach((h) => h(data));
      const pid = eventProjectId(data);
      if (pid !== null) {
        const set = this.projectHandlers.get(pid);
        if (set) set.forEach((h) => h(data));
      }
    };
    ws.onclose = () => {
      if (this.explicitlyClosed) return;
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 8000);
      this.reconnectAttempts++;
      this.reconnectTimer = setTimeout(() => this.openSocket(), delay);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* 关闭失败无需处理,onclose 会走重连 */
      }
    };
  }

  send(cmd: ClientCommand): void {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd));
    }
  }

  /** 对某个项目的业务经理说一句话。 */
  sendToProject(projectId: string, content: string): void {
    this.send({ type: "send", projectId, content });
  }

  /** 中断某个项目正在跑的一轮。 */
  interrupt(projectId: string): void {
    this.send({ type: "interrupt", projectId });
  }

  /** 经 WS 回答一个等甲方拍板的问题(与 HTTP POST answer 等价,前端统一走 HTTP)。 */
  answerClientQuestion(questionId: string, answer: string): void {
    this.send({ type: "answer_client_question", questionId, answer });
  }

  ping(): void {
    this.send({ type: "ping" });
  }

  /** 订阅全部事件。返回退订函数。 */
  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  /** 只订阅某个项目的事件。返回退订函数。 */
  onProject(projectId: string, h: Handler): () => void {
    let set = this.projectHandlers.get(projectId);
    if (!set) {
      set = new Set();
      this.projectHandlers.set(projectId, set);
    }
    set.add(h);
    return () => {
      const cur = this.projectHandlers.get(projectId);
      if (!cur) return;
      cur.delete(h);
      if (cur.size === 0) this.projectHandlers.delete(projectId);
    };
  }

  close(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try {
      this.ws?.close();
    } catch {
      /* 已关闭 */
    }
  }
}
