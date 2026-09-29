/**
 * Sansheng MessageBus · M3c
 *
 * 设计要点(PLAN.md 行 383-413):
 * - 双向阻塞:worker 调 ask() 拿一个 Promise;Communicator 调 reply() resolve 它。
 * - timeout 通过 setTimeout + clearTimeout,超时 reject + 清理 pending。
 * - broadcast 不阻塞,推给所有 subscribers。
 * - snapshot()/restore() 用于持久化往返。
 *
 * 内部状态:
 *   stream  : BusMessage[]    完整消息流(append-only)
 *   pending : Map<questionId, PendingQuestion>
 *   listeners: Set<(msg: BusMessage) => void>
 *
 * 持久化:写入由调用方(ws 层 / kernel 层)通过 busPersister.appendBusMessage() 落 jsonl;
 * BusBus 不直接碰文件系统 → 单元测试不需要 mock fs。
 */
import { nanoid } from "nanoid";
import type { BusMessage, RoleId } from "@shared/types/agents";
import { log } from "../../shared/log.js";

export type { BusMessage };

export interface AskOptions {
  fromRole: RoleId | "user";
  conversationId: string;
  payload: string;
  context?: Record<string, unknown>;
  /** 默认 5 分钟,worker 阻塞问 Communicator 后用户长时间不答会 timeout。 */
  timeoutMs?: number;
}

export interface BroadcastOptions {
  fromRole: RoleId | "user";
  toRole?: RoleId | "user";
  conversationId: string;
  payload: string;
  context?: Record<string, unknown>;
}

interface PendingQuestion {
  questionId: string;
  resolve: (reply: BusMessage) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  fromRole: RoleId | "user";
  conversationId: string;
}

export type BusHandler = (msg: BusMessage) => void;

/**
 * 进程内 MessageBus。
 * - 单 conversationId 一般只有 1 个实例;但允许多 bus 并存(测试用)。
 * - pending questionMap<id, ...>;question id 与 BusMessage.id 同值,reply 也用同一 id。
 */
export class MessageBus {
  private stream: BusMessage[] = [];
  private pending = new Map<string, PendingQuestion>();
  private listeners = new Set<BusHandler>();
  private maxStreamSize = 5000;

  /**
   * Worker 端调用:发出问题,返回 Promise 等回话。
   * timeout 后 reject(new Error("timeout after Xms")) 并清理 pending。
   */
  ask(opts: AskOptions): Promise<string> {
    const questionId = nanoid();
    const conversationId = opts.conversationId;
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const direction = this.inferDirection(opts.fromRole, "ask");
    const msg: BusMessage = {
      id: questionId,
      ts: Date.now(),
      direction,
      fromRole: opts.fromRole,
      toRole: this.inferToRole("ask", opts.fromRole),
      conversationId,
      kind: "question",
      payload: opts.payload,
      ...(opts.context !== undefined ? { context: opts.context } : {}),
    };
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(questionId);
        const err = new Error(`MessageBus ask timeout after ${timeoutMs}ms`);
        log.warn(`bus.ask timeout questionId=${questionId} from=${opts.fromRole}`);
        reject(err);
      }, timeoutMs);
      this.pending.set(questionId, {
        questionId,
        resolve: (reply) => resolve(reply.payload),
        reject,
        timer,
        fromRole: opts.fromRole,
        conversationId,
      });
      this.append(msg);
    });
  }

  /**
   * Communicator 端调用:对 question 做出回应。
   * 找不到原 question 不抛,只 log warn(避免阻塞 caller;producer 会被 timeout 兜住)。
   */
  reply(originalQuestionId: string, payload: string): boolean {
    const pending = this.pending.get(originalQuestionId);
    if (!pending) {
      log.warn(`bus.reply: no pending question ${originalQuestionId}`);
      return false;
    }
    clearTimeout(pending.timer);
    this.pending.delete(originalQuestionId);
    const replyMsg: BusMessage = {
      id: nanoid(),
      ts: Date.now(),
      direction: this.inferReplyDirection(pending.fromRole),
      fromRole: "communicator",
      toRole: pending.fromRole === "communicator" ? "user" : pending.fromRole,
      conversationId: pending.conversationId,
      kind: "reply",
      questionId: originalQuestionId,
      payload,
    };
    this.append(replyMsg);
    pending.resolve(replyMsg);
    return true;
  }

  /**
   * 不需回应的单向消息(状态更新、reflection 摘要等)。
   */
  broadcast(opts: BroadcastOptions): BusMessage {
    const id = nanoid();
    const toRole = opts.toRole ?? "user";
    const msg: BusMessage = {
      id,
      ts: Date.now(),
      direction: this.inferDirection(opts.fromRole, "broadcast"),
      fromRole: opts.fromRole,
      toRole,
      conversationId: opts.conversationId,
      kind: "broadcast",
      payload: opts.payload,
      ...(opts.context !== undefined ? { context: opts.context } : {}),
    };
    this.append(msg);
    return msg;
  }

  /**
   * 浏览器/timeline 订阅:每条新 BusMessage 触发一次 handler。
   * 返回 unsubscribe 函数。
   */
  subscribe(handler: BusHandler): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  /** 全部流式消息快照(供持久化)。 */
  snapshot(): BusMessage[] {
    return this.stream.slice();
  }

  /**
   * 从 jsonl 恢复:重新填 stream;不重建 pending(persistent pending 不恢复,避免 double-resolve)。
   * 如需恢复 pending,caller 应在 restore 后根据 stream 自己重排。
   */
  restore(messages: BusMessage[]): void {
    this.stream = messages.slice();
    this.pending.clear();
  }

  /** 测试用:清空所有状态。 */
  clear(): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("bus cleared"));
    }
    this.pending.clear();
    this.stream = [];
    this.listeners.clear();
  }

  /** 测试/调试用:当前 pending 数量。 */
  pendingSize(): number {
    return this.pending.size;
  }

  /** 测试/调试用:stream 当前长度。 */
  size(): number {
    return this.stream.length;
  }

  // ----- 内部 -----

  private append(msg: BusMessage): void {
    this.stream.push(msg);
    if (this.stream.length > this.maxStreamSize) {
      // ring buffer:丢最老的 100 条
      this.stream.splice(0, this.stream.length - this.maxStreamSize + 100);
    }
    for (const l of this.listeners) {
      try {
        l(msg);
      } catch (err) {
        log.warn("bus.subscribe handler threw:", err);
      }
    }
  }

  /**
   * 简化方向推断:
   * - ask:toRole=communicator,方向 user→comm 或 worker→comm
   * - reply:方向 comm→worker / comm→user
   * - broadcast:方向 from 当前 role → toRole
   */
  private inferDirection(
    fromRole: RoleId | "user",
    _kind: "ask" | "broadcast" | "reply",
  ): BusMessage["direction"] {
    if (fromRole === "user") return "user→comm";
    if (fromRole === "communicator") return "comm→user";
    return "worker→comm";
  }

  private inferToRole(
    _kind: "ask",
    _fromRole: RoleId | "user",
  ): RoleId | "user" {
    return "communicator";
  }

  /** reply 方向永远 comm→原 asker */
  private inferReplyDirection(
    originalAsker: RoleId | "user",
  ): BusMessage["direction"] {
    return originalAsker === "user" ? "comm→user" : "comm→worker";
  }
}