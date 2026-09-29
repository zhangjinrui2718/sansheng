/**
 * Sansheng · BlackboardArtifact Event Bus (M3+)
 *
 * 进程内单例(subscribe + publish),与 MessageBus(BusMessage 通信)正交。
 *
 * 用法:
 *   import { artifactBus, makeArtifact } from "../bus/index.js";
 *
 *   artifactBus.subscribe("artifact_created", (e) => { ... });
 *   artifactBus.publish({ type: "artifact_created", artifact });
 *   artifactBus.publish("artifact_created", { artifact });  // type 前缀可选
 *
 * 设计点:
 *   - 模块级单例(`__sanshengArtifactBus` via globalThis 守护单进程热重载)
 *   - typed subscribe<T>(type, handler) 推导 payload 类型
 *   - publish 支持裸 payload 或带 type 字段
 *   - 不可变 snapshot 给 HTTP/WS 转发用
 */

import { nanoid } from "nanoid";
import type {
  BusEvent,
  BusEventType,
  BusEventHandlerOf,
  BusEventPayload,
  BlackboardArtifact,
} from "../../../shared/types/bus.js";
import type { HandlerMap } from "./events.js";

class ArtifactBus {
  private handlers: HandlerMap = {};

  /**
   * 订阅某 eventType 的 handler。
   * 返回 unsubscribe()。
   */
  subscribe<T extends BusEventType>(
    type: T,
    handler: BusEventHandlerOf<T>,
  ): () => void {
    let set = this.handlers[type] as Set<BusEventHandlerOf<T>> | undefined;
    if (!set) {
      set = new Set<BusEventHandlerOf<T>>();
      this.handlers[type] = set as unknown as HandlerMap[T];
    }
    set.add(handler);
    return () => {
      const s = this.handlers[type] as Set<BusEventHandlerOf<T>> | undefined;
      if (s) s.delete(handler);
    };
  }

  /**
   * 发布事件。
   * 支持两种签名:
   *   publish(event)        // 完整 BusEvent
   *   publish(type, payload) // 分开传
   */
  publish(event: BusEvent): void;
  publish<T extends BusEventType>(type: T, payload: BusEventPayload<T>): void;
  publish(
    a: BusEvent | BusEventType,
    b?: BusEventPayload<BusEventType>,
  ): void {
    let event: BusEvent;
    if (typeof a === "string") {
      // overload: (type, payload)
      event = { type: a, ...(b as object) } as BusEvent;
    } else {
      event = a;
    }
    const set = this.handlers[event.type];
    if (!set) return;
    // 拷贝后再调,handler 内部 unsubscribe 不影响本次 fan-out
    const snapshot = Array.from(set as Set<(p: BusEvent) => void>);
    for (const h of snapshot) {
      try {
        (h as (p: BusEvent) => void)(event);
      } catch (err) {
        // 单个 handler 抛错不阻塞其它 handler
        // eslint-disable-next-line no-console
        console.error(`[artifactBus] handler for ${event.type} threw:`, err);
      }
    }
  }

  /** 清空所有订阅(测试 / dispose 用) */
  clear(): void {
    this.handlers = {};
  }

  /** 调试用:统计订阅数 */
  listenerCount(type?: BusEventType): number {
    if (type) return this.handlers[type]?.size ?? 0;
    return Object.values(this.handlers).reduce(
      (acc, s) => acc + (s?.size ?? 0),
      0,
    );
  }
}

/* ── 进程内单例 ───────────────────────────────────────────── */

declare global {
  // eslint-disable-next-line no-var
  var __sanshengArtifactBus: ArtifactBus | undefined;
}

export const artifactBus: ArtifactBus =
  globalThis.__sanshengArtifactBus ?? new ArtifactBus();

if (!globalThis.__sanshengArtifactBus) {
  globalThis.__sanshengArtifactBus = artifactBus;
}

/* ── Helpers ────────────────────────────────────────────── */

/** helper:构造 BlackboardArtifact 默认字段 */
export function makeArtifact(
  partial: Partial<BlackboardArtifact> &
    Pick<BlackboardArtifact, "kind" | "title" | "body" | "author">,
): BlackboardArtifact {
  const now = Date.now();
  return {
    id: partial.id ?? `art-${nanoid(10)}`,
    scope: partial.scope ?? "global",
    conversationId: partial.conversationId,
    kind: partial.kind,
    title: partial.title,
    body: partial.body,
    refs: partial.refs,
    author: partial.author,
    status: partial.status ?? "open",
    executors: partial.executors,
    dependsOn: partial.dependsOn,
    parentIntent: partial.parentIntent,
    metadata: partial.metadata,
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now,
  };
}