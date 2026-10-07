/**
 * 2026-10-07 真机 · **「正在推演中」在刷新 / 切页之后消失** —— 回归
 *
 * ── 现场(用户原话)──────────────────────────────────────────────
 *
 *   「如果是 正在推演中，我刷新了页面，或者我点到了其他页面，再次点回来，
 *     如果这个时候还没有推理完，我是看不到 正在推演中的这个状态的」
 *
 * ── 为什么它必然发生 ────────────────────────────────────────────
 *
 * 顶部那盏灯此前**只**由 WS 实时事件推出来(`message_start` 建轮 → `delta` 追加
 * → `agent_end` 收口),而 **WS 没有回放**;`selectProject` / `selectSession` 还会
 * 主动清 `inFlight`。⇒ 刷新或切走再切回来时,一个**还在跑**的回合在屏幕上变成
 * 「就绪」—— 甲方以为它没动,其实它正在动。
 *
 * 修法:把「此刻」的唯一读面(`GET /live` / `GET /api/intake/live`)接进判据的
 * **第三个参数**。它只在本地确实没有在飞的轮时才被读到,所以**永远不会盖过**本地证据。
 */
import { describe, expect, it } from "vitest";
import { surfaceStatusOf, type ChannelActivity } from "@/lib/data";
import type { Turn } from "@/stores/chat";

/** `surfaceStatusOf` 只读两边的**条数**,不看内容 —— 所以空壳够用。 */
function activity(client: number, internal: number): ChannelActivity {
  const mk = (n: number) => Array.from({ length: n }, () => ({}) as Turn);
  return { client: mk(client), internal: mk(internal), system: [] };
}

const NOTHING = activity(0, 0);

describe("surfaceStatusOf · 服务端那份运行态(刷新/切页之后补的那一位)", () => {
  it("本地没在飞,而服务端说甲方通道在跑 ⇒ streaming(修前是 idle)", () => {
    expect(surfaceStatusOf("idle", NOTHING, { client: true, internal: false })).toBe("streaming");
  });

  it("本地没在飞,而服务端说只有内部角色在跑 ⇒ internal(不是 streaming)", () => {
    // 这一档很关键:它是「输入框照常可用」那一档(bug A 的现场)
    expect(surfaceStatusOf("idle", NOTHING, { client: false, internal: true })).toBe("internal");
  });

  it("服务端说没人跑 ⇒ idle", () => {
    expect(surfaceStatusOf("idle", NOTHING, { client: false, internal: false })).toBe("idle");
  });

  // ↓↓↓ 负样本 / 纪律
  it("⚠️ `null` = **读不到**,不许当成「没在跑」以外的任何东西 —— 但它也不许伪造在跑", () => {
    // `null` 只说「没有服务端信息」,所以结果只能是 idle(本地也没在飞)。
    // 它的价值在下一组:它**不会**盖过本地证据。
    expect(surfaceStatusOf("idle", NOTHING, null)).toBe("idle");
    // 省略第三个参数 = 旧行为**逐字不变**(既有调用点/测试不受影响)
    expect(surfaceStatusOf("idle", NOTHING)).toBe("idle");
  });

  it("⚠️ 负样本:本地证据永远优先 —— 服务端说 idle 而本地在飞 ⇒ 仍是 streaming", () => {
    expect(surfaceStatusOf("idle", activity(1, 0), { client: false, internal: false })).toBe(
      "streaming",
    );
  });

  it("⚠️ 负样本:本地有内部轮、服务端说有甲方轮 ⇒ internal(本地那份更准,不被抬成 streaming)", () => {
    expect(surfaceStatusOf("idle", activity(0, 1), { client: true, internal: false })).toBe(
      "internal",
    );
  });

  it("error / connecting 两档不受影响(它们先判)", () => {
    expect(surfaceStatusOf("error", NOTHING, { client: true, internal: false })).toBe("error");
    expect(surfaceStatusOf("connecting", NOTHING, { client: true, internal: false })).toBe(
      "connecting",
    );
  });
});
