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

/**
 * **连接状态** —— 传输层的事实,不是界面状态。
 *
 * ⚠️ **它必须能被读到**,因为「连接断了」这件事此前**在整个界面上没有任何一处
 * 看得见**:WS 断了之后 `PlatformSocket` 只是自己按指数退避重连,而界面:
 *
 *   · 那盏灯照样写着「推演中」(它读的是服务端那份运行态 —— 而那份**可能过期**);
 *   · 输入框照样被禁用(它读的是**本地**那张轮表 —— 断线时那条 `agent_end`
 *     永远等不到,于是本地永远说「他在跑」)⇒ **输入框永久死锁**;
 *   · 「■ 中断」照样在(按下去的命令在非 OPEN 时被**静默丢弃**)⇒ **按了没反应**;
 *   · 发出去的消息照样**乐观上屏**然后被静默丢弃 ⇒ **用户以为消息到了**。
 *
 * ⇒ 「读不到 ≠ 没在跑」这条纪律在传输层也要有:**连接断了就是断了**,
 * 而界面必须**说这件事**(而不是装作一切正常)。
 */
export type SocketStatus = "connecting" | "open" | "closed";

export class PlatformSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<Handler>();
  private projectHandlers = new Map<string, Set<Handler>>();
  private statusHandlers = new Set<(s: SocketStatus) => void>();
  private status: SocketStatus = "connecting";
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

  /** 订阅连接状态。**立刻**回调一次当前状态;返回退订函数。 */
  onStatus(cb: (s: SocketStatus) => void): () => void {
    this.statusHandlers.add(cb);
    cb(this.status);
    return () => {
      this.statusHandlers.delete(cb);
    };
  }

  /** 此刻的连接状态。 */
  getStatus(): SocketStatus {
    return this.status;
  }

  private setStatus(s: SocketStatus): void {
    if (this.status === s) return;
    this.status = s;
    // ⚠️ 一个订阅者抛错**不许**拖垮别的订阅者(状态是给界面看的,不是关键路径)。
    this.statusHandlers.forEach((h) => {
      try {
        h(s);
      } catch {
        /* 忽略 */
      }
    });
  }

  private openSocket(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.setStatus("connecting");
    ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus("open");
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
      // ⚠️ **先报状态,再看是不是主动关的** —— 主动关也是「连接没了」。
      this.setStatus("closed");
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

  /**
   * 发一条命令。**返回它到底有没有发出去。**
   *
   * ⚠️ 此前它**静默丢弃**(连接不在 OPEN 时直接返回)⇒ 调用方以为消息到了,
   * 而服务端一条也没收到 —— 而乐观上屏已经让那句话**看起来发出去了**。
   * ⇒ 现在返回 `false`,由调用方**如实说「没发出去」**。
   */
  send(cmd: ClientCommand): boolean {
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(cmd));
      return true;
    }
    return false;
  }

  /**
   * 对某个项目的业务经理说一句话。
   *
   * **`null` = 接待会话**(第一个项目之前,见 `@shared/types/platform` 的
   * `ClientCommand`)。那一段里与你说话的是业务经理,它的工具面只有
   * `project_open` 与 `memory_*` —— 谈拢之后它自己立项并广播 `project_opened`。
   */
  /**
   * ⚠️ `sessionId` **可省**(migration 024):省略 = 落到该项目的主对话。
   *
   * 漏传的表现是「消息落到了主对话而不是你选的那条线」—— **看得见**的错
   * (它出现在另一条线上),所以它不像服务端那七条事件那样必填。
   */
  sendToProject(projectId: string | null, content: string, sessionId?: string): boolean {
    return this.send({
      type: "send", projectId, content,
      ...(sessionId !== undefined ? { sessionId } : {}),
    });
  }

  /**
   * 中断某个上下文正在跑的一轮(`null` = 接待会话)。`channel: "client"`
   * = 只停甲方通道(业务经理)的回合 —— 前端的停止入口一律带它(2026-11-10:
   * 「停止」是停这段对话,不是停整个项目)。
   */
  interrupt(projectId: string | null, channel?: "client"): boolean {
    return this.send({ type: "interrupt", projectId, ...(channel ? { channel } : {}) });
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
