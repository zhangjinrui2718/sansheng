/**
 * 批次 4b · C6 —— 无 WS 心跳:半开连接不触发 close
 * (docs/CODE-REVIEW-2026-10-01.md §C6)
 *
 * 旧实现:ws.ts 全文无 ping/pong。半开连接(对端断电/网络黑洞)不会触发 `close` →
 * `wss.clients` 与 per-connection busUnsubs 泄漏;broadcast 持续向死 socket 缓冲。
 *
 * 修复契约:
 *  - 周期性 ping;两拍没有 pong → terminate(强制回收,close 事件随之触发,
 *    现有 ws.ts close handler 的 detachSink / busUnsubs 退订照常执行);
 *  - 间隔可配、可在测试里关小(attachWebSocket opts.heartbeat.intervalMs);
 *  - 定时器 unref + wss close 时停止(不吊住进程,不影响 ws-lifecycle 6 场景
 *    与 bus_replay 语义)。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startWsHeartbeat, WS_HEARTBEAT_INTERVAL_MS, type HeartbeatSocket } from "../../src/server/ws.js";

class FakeSocket implements HeartbeatSocket {
  pings = 0;
  terminated = 0;
  alive = true;
  ping(): void {
    this.pings += 1;
  }
  terminate(): void {
    this.terminated += 1;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("C6 · WS 心跳 ping/pong + 超时 terminate", () => {
  it("默认间隔是常量(可配,便于运维与测试)", () => {
    expect(WS_HEARTBEAT_INTERVAL_MS).toBeGreaterThan(0);
  });

  it("正常回 pong 的连接不会被打断", () => {
    const s = new FakeSocket();
    const clients = [s];
    const hb = startWsHeartbeat(() => clients, { intervalMs: 1000 });
    hb.markAlive(s);
    vi.advanceTimersByTime(1000);
    expect(s.pings).toBe(1);
    // 对端回 pong
    hb.markAlive(s);
    vi.advanceTimersByTime(1000);
    expect(s.terminated).toBe(0);
    expect(s.pings).toBe(2);
    hb.stop();
  });

  it("两拍没有 pong → terminate(半开连接被强制回收)", () => {
    const s = new FakeSocket();
    const clients = [s];
    const hb = startWsHeartbeat(() => clients, { intervalMs: 1000 });
    hb.markAlive(s);
    vi.advanceTimersByTime(1000); // 第 1 拍:ping
    vi.advanceTimersByTime(1000); // 第 2 拍:仍无 pong → terminate
    expect(s.terminated).toBe(1);
    hb.stop();
  });

  it("terminate 之后不再继续 ping(已回收的 socket 不被反复戳)", () => {
    const s = new FakeSocket();
    const clients = [s];
    const hb = startWsHeartbeat(() => clients, { intervalMs: 1000 });
    hb.markAlive(s);
    vi.advanceTimersByTime(1000);
    vi.advanceTimersByTime(1000);
    const pingsAtKill = s.pings;
    vi.advanceTimersByTime(5000);
    expect(s.pings).toBe(pingsAtKill);
    hb.stop();
  });

  it("从 clients 列表消失的连接不会残留心跳状态", () => {
    const s = new FakeSocket();
    const clients: FakeSocket[] = [s];
    const hb = startWsHeartbeat(() => clients, { intervalMs: 1000 });
    hb.markAlive(s);
    clients.length = 0;
    vi.advanceTimersByTime(5000);
    expect(s.terminated).toBe(0);
    expect(s.pings).toBe(0);
    hb.stop();
  });

  it("stop() 之后定时器不再触发(不吊住进程)", () => {
    const s = new FakeSocket();
    const clients = [s];
    const hb = startWsHeartbeat(() => clients, { intervalMs: 1000 });
    hb.markAlive(s);
    hb.stop();
    vi.advanceTimersByTime(10_000);
    expect(s.pings).toBe(0);
  });
});
