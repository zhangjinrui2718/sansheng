/**
 * 「此刻状态」那一格(v5 Wave D,2026-11-20 从 `routes/Members.tsx` 抽出)。
 *
 * 抽出的理由:全员并发板的每张卡与成员面板要读**同一份**三态判据 ——
 * 两处各写一份,「读不到」迟早在一处被说成「空闲」。三种「不知道」不许长得像
 * 「一切正常」(原判据逐字继承,顺序也是判据的一部分):
 *
 *   1. 没拿到快照(`activity === null` 或 `runtime === null`)—— 连「读不到」都
 *      还不能断言 ⇒ 「正在读取运行态…」;
 *   2. `runtime === "unavailable"` —— **这个进程没接上运行期快照**,不是「它停着」
 *      ⇒ 灰点 + 「运行态读不到」(库里的部分照常显示);
 *   3. `turn !== null` —— 在跑,给会走的秒数;
 *   4. 其余 —— 才允许说「此刻没有回合在跑」(刻意不说「空闲」:空闲还要看活与待办)。
 */
import type { MemberActivityView, ProjectLiveView } from "@shared/types/platform";
import { triggerText } from "./activity";
import { Help } from "@/components/ui/Help";

export function TurnStatus({
  runtime,
  activity,
  age,
}: {
  /** 这份快照的运行期来源;`null` = 还没拿到过快照 */
  runtime: ProjectLiveView["runtime"] | null;
  /** 这个人在快照里的那一条;`null` = 还没拿到(或快照里没有他) */
  activity: MemberActivityView | null;
  /** 快照值 → 屏上此刻的年龄(见 `activity.ts` 的 elapsedSinceFetch) */
  age: (ms: number) => string;
}) {
  if (activity === null || runtime === null) {
    return (
      <>
        <span className="ss-live-dot" data-state="unknown" />
        <span className="ss-meta" style={{ color: "var(--bone-dim)" }}>
          正在读取运行态…
        </span>
      </>
    );
  }
  if (runtime === "unavailable") {
    return (
      <>
        <span className="ss-live-dot" data-state="unknown" />
        <span
          className="ss-meta"
          style={{ color: "var(--amber)" }}
          title="读不到运行态,不是「它停着」"
        >
          运行态读不到
        </span>
        <Help id="member.runtime" />
      </>
    );
  }
  if (activity.turn !== null) {
    return (
      <>
        <span className="ss-live-dot" />
        <span className="ss-body" style={{ color: "var(--jade)" }}>
          在跑 · 已跑 {age(activity.turn.elapsedMs)}
        </span>
        <span className="ss-meta">{triggerText(activity.turn.trigger)}</span>
      </>
    );
  }
  return (
    <span className="ss-meta" title="没有回合在跑 ≠ 它没事 · 看手上的活与待办">
      此刻没有回合在跑
    </span>
  );
}
