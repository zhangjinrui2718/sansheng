/**
 * 桌面通知 · 测试(2026-11-13)
 *
 * ── 钉住的三条纪律(见 src/platform/host/notify.ts 文件头)──────────
 *
 *   ① fire-and-forget:同步抛错 / 回调报错都只落日志,绝不打挂调用方;
 *   ② 同 key 去重:窗口期内同一 key 只弹一次(刹车是进程级的,播报点是
 *      每个项目各自第一次撞上 —— 没有这层,三个项目会弹三张一样的卡片);
 *   ③ key 不同不误伤:调度器的超时通知用一次性 key,永不被去重吞掉。
 *
 * node-notifier 用 vi.mock 替掉 —— 测试绝不真的弹系统通知。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const notifyMock = vi.hoisted(() => vi.fn());
vi.mock("node-notifier", () => ({ default: { notify: notifyMock } }));

import { createNotifier } from "../../src/platform/host/notify.js";

let t = 1_700_000_000_000;
const tick = (ms: number) => { t += ms; };

beforeEach(() => {
  notifyMock.mockReset();
  t = 1_700_000_000_000;
});

describe("桌面通知 · fire-and-forget 与同 key 去重", () => {
  it("① 标题与正文原样传给 notifier", () => {
    const notify = createNotifier({ now: () => t });
    notify("k", "三生 · 测试", "正文内容");
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock.mock.calls[0]![0]).toMatchObject({ title: "三生 · 测试", message: "正文内容" });
  });

  it("② 同 key 在窗口期内只弹一次;窗口过了再弹", () => {
    const notify = createNotifier({ now: () => t, windowMs: 600_000 });
    notify("brake", "a", "1"); tick(60_000);
    notify("brake", "a", "2");
    expect(notifyMock).toHaveBeenCalledTimes(1);
    tick(600_001);
    notify("brake", "a", "3");
    expect(notifyMock).toHaveBeenCalledTimes(2);
    expect(notifyMock.mock.calls[1]![0]).toMatchObject({ message: "3" });
  });

  it("③ key 不同不误伤(调度器用一次性 key,永不被去重吞掉)", () => {
    const notify = createNotifier({ now: () => t });
    notify("scheduler:1", "t", "第一条");
    notify("scheduler:2", "t", "第二条");
    expect(notifyMock).toHaveBeenCalledTimes(2);
  });

  it("④ 同步抛错只落日志,不打挂调用方", () => {
    notifyMock.mockImplementation(() => { throw new Error("no notification backend"); });
    const notify = createNotifier({ now: () => t });
    const logs: string[] = [];
    expect(() => notify("k", "t", "m", (l) => logs.push(l))).not.toThrow();
    expect(logs.join("\n")).toContain("桌面通知不可用");
  });

  it("⑤ 回调报错也只落日志", async () => {
    notifyMock.mockImplementation((_opts, cb) => { cb?.(new Error("osascript failed")); });
    const notify = createNotifier({ now: () => t });
    const logs: string[] = [];
    notify("k", "t", "m", (l) => logs.push(l));
    await vi.waitFor(() => { expect(logs.join("\n")).toContain("桌面通知失败"); });
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });
});
