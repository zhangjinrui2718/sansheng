/**
 * 结构化唤醒工具(038,2026-11-22):`wakeup_create` / `wakeup_list` / `wakeup_cancel`
 * (能力 `schedule.manage`,只给业务经理)
 *
 * ── 为什么是工具而不是约定 ────────────────────────────────────────
 *
 * 「过两小时再查一次」「每天早上汇报进展」此前只能**说**给模型听 —— 说过就忘,
 * 库里没有任何一行能表达「时间」。工具调用是显式的、结构化的:一行 `wakeups`,
 * 排空器的 `wakeup_due` 规则每次 tick 重查它(到期谓词是纯函数,重启后照常补跑)。
 *
 * ⚠️ **判据铁律与批次 21 同一条**:唤醒只是「到点 ⇒ 多一类待办」,不携带任何
 * 跨排空状态;消费(`markWakeupFired`)在回合成功结束之后(at-least-once)。
 *
 * ⚠️ **保险丝(⑤)在仓储与宿主侧,不在这里**:`every` 错过 N 个周期只产生一条
 * 待办(错过折叠);预算烧穿的唤醒由 `cancelExhaustedWakeups` 自动熔断并播报。
 * 工具层不背这些 —— 它只管把行写对。
 */
import { Type } from "@sinclair/typebox";
import {
  insertWakeup, getWakeup, listWakeups, cancelWakeup,
  type WakeupKind,
} from "../storage/repo/wakeups.js";
import {
  fail, ok, requireProject, requireString,
  type PlatformTool,
} from "./types.js";

/** 时间参数的共用形状说明(描述文本两处共用,不另立常量 —— 描述是给人看的)。 */
const KIND_DESC =
  "at = 到点叫醒一次(一次性);every = 周期性(每 intervalMs 毫秒一次," +
  "从上一次点火续期)。二选一,参数要配对(atMs / intervalMs)。";

const wakeupCreate: PlatformTool = {
  name: "wakeup_create",
  capability: "schedule.manage",
  description:
    "排一个**定时唤醒**:到点平台会叫醒你,把你写下的 note 原样带回。" +
    "适用「稍后再查一次」(at)与「每天/每周例行汇报」(every)。" +
    "⚠️ 它不是给执行角色排活的工具 —— 排活用 work_create;这是**你自己的**时间锚。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
    note: Type.String({
      description:
        "到点那一次要做什么(原样带回任务正文):写清楚「查什么 / 向谁交代什么」," +
        "到点的你只看得到这一句",
    }),
    kind: Type.String({ description: KIND_DESC }),
    atMs: Type.Optional(Type.Number({ description: "kind='at':到点的毫秒时间戳" })),
    intervalMs: Type.Optional(Type.Number({
      description: "kind='every':周期(毫秒)。如每天 = 86400000;建议不小于 600000(10 分钟)",
    })),
  }),
  run(args, ctx) {
    const proj = requireProject(ctx, "wakeup_create");
    if (!proj.ok) return proj.result;
    const pid = args["projectId"] !== undefined ? String(args["projectId"]) : proj.project.id;
    const note = requireString(args, "note");
    if (!note.ok) return note.result;
    // requireString 的值包装:解出字符串再进库。

    const kind = args["kind"];
    if (kind !== "at" && kind !== "every") {
      return fail("invalid_args", `kind 只能是 at 或 every(收到「${String(kind)}」)`, ["at", "every"]);
    }
    // 形状配对:kind 与时间参数一一对应 —— 不配对就是「排了个永远不会响的闹钟」。
    if (kind === "at" && typeof args["atMs"] !== "number") {
      return fail("invalid_args", "kind='at' 必须给 atMs(毫秒时间戳)");
    }
    if (kind === "every" && typeof args["intervalMs"] !== "number") {
      return fail("invalid_args", "kind='every' 必须给 intervalMs(毫秒)");
    }
    const intervalMs = kind === "every" ? (args["intervalMs"] as number) : null;
    if (intervalMs !== null && intervalMs < 60_000) {
      return fail(
        "invalid_args",
        `intervalMs 最小 60000(10 分钟),收到 ${intervalMs} —— 更密的周期是排空器 10s 轮询` +
          "该管的事,不是定时唤醒该管的事(防热循环)",
      );
    }
    const atMs = kind === "at" ? (args["atMs"] as number) : null;
    if (atMs !== null && atMs <= ctx.now()) {
      return fail(
        "invalid_args",
        `atMs 必须是将来的时间(收到 ${atMs},现在 ${ctx.now()})—— 排一个已经到点的` +
          "唤醒等于立刻叫醒自己,直接说要做的事即可",
      );
    }

    const id = ctx.newId("wu");
    insertWakeup(ctx.db, {
      id, projectId: pid, createdByAgentId: ctx.agent.id,
      note: note.value, kind,
      at: atMs, intervalMs,
      status: "pending", lastFiredAt: null, firedCount: 0,
      createdAt: ctx.now(),
    });
    const when = kind === "at"
      ? new Date(atMs!).toISOString()
      : `每 ${Math.round(intervalMs! / 60_000)} 分钟`;
    return ok(
      `已排定 ${id}:${when} 会叫醒你,note 原样带回。` +
        "(at 一次性;every 从每次点火续期,错过会折叠成一次)",
    );
  },
};

const wakeupList: PlatformTool = {
  name: "wakeup_list",
  capability: "schedule.manage",
  description: "列出本项目排的定时唤醒(含已点火/已取消的历史)。",
  parameters: Type.Object({
    projectId: Type.Optional(Type.String({ description: "缺省 = 当前项目" })),
  }),
  run(args, ctx) {
    const proj = requireProject(ctx, "wakeup_list");
    if (!proj.ok) return proj.result;
    const pid = args["projectId"] !== undefined ? String(args["projectId"]) : proj.project.id;
    const rows = listWakeups(ctx.db, pid);
    if (rows.length === 0) return ok("本项目还没有排过定时唤醒。");
    const lines = rows.map((w) => {
      const when = w.kind === "at"
        ? `at ${new Date(w.at ?? 0).toISOString()}`
        : `every ${Math.round((w.intervalMs ?? 0) / 60_000)}min`;
      const fired = w.firedCount > 0
        ? `(已点火 ${w.firedCount} 次,最近 ${w.lastFiredAt === null ? "—" : new Date(w.lastFiredAt).toISOString()})`
        : "";
      return `- [${w.status}] ${w.id} ${when}${fired}:${w.note}`;
    });
    return ok(lines.join("\n"));
  },
};

const wakeupCancel: PlatformTool = {
  name: "wakeup_cancel",
  capability: "schedule.manage",
  description: "取消一个还没点火的定时唤醒(`cancelled` 是终态;已点火过的 every 也能停)。",
  parameters: Type.Object({
    wakeupId: Type.String(),
  }),
  run(args, ctx) {
    const id = requireString(args, "wakeupId");
    if (!id.ok) return id.result;
    const w = getWakeup(ctx.db, id.value);
    if (w === null) return fail("not_found", `找不到唤醒 ${id.value}`);
    if (w.status !== "pending") {
      return fail(
        "conflict",
        `${id.value} 已经是 ${w.status}(终态),不用再取消`,
      );
    }
    return cancelWakeup(ctx.db, id.value)
      ? ok(`已取消 ${id.value}:${w.note}(此后不再点火)`)
      : fail("conflict", `${id.value} 刚被别处取消`);
  },
};

export const SCHEDULE_TOOLS: readonly PlatformTool[] = [wakeupCreate, wakeupList, wakeupCancel];
export type { WakeupKind };
