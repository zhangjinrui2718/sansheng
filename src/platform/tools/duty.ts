/**
 * 职责功课工具(039,2026-11-27):`duty_run_open` / `duty_run_close`
 * (能力 `duty.run`,只给业务经理)
 *
 * ── 为什么是工具而不是约定 ────────────────────────────────────────
 *
 * 「先列功课、收工写自省」如果只写在提示词里,它取决于模型当下想不想做。做成
 * 工具调用,平台就能**要求**它:
 *   · 开工时必须先把这一轮的功课写下来(1–3 步,每步一条可检验的标准)——
 *     写不出就还没想清这一轮做什么;
 *   · 收工时每一步都要交代做成没做成,自省五项都要填;这一轮里出了失败,
 *     「原因在自己哪一步」不许为空。
 * 两次调用写的都是**结构化的行**(`duty_runs`),不是说过就忘的一段话。
 *
 * ⚠️ 职责本身(目标 / 节奏 / 边界 / 产出形态)**只有人能建、能改**(HTTP `/api/duties`):
 * 设一条职责 = 预先授权这个范围内的活自动开工,而预先授权必须出自甲方本人。
 * 模型这一侧只写「每一轮怎么做、做得怎么样」。
 *
 * ⚠️ 「到点该不该开工」的判据不在工具里,在规则(`dispatcher.ts` 的 `duty_due`)。
 * 这里只做**状态冲突**的拒收(已暂停 / 上一轮没收工 / 今天开满了),判据与规则同源。
 */
import { Type } from "@sinclair/typebox";
import {
  failuresSince, dutyOfProject, insertDutyRun, openDutyRunOf,
  updateDuty, updateDutyRun,
  type DutyRunStep,
} from "../storage/repo/duties.js";
import {
  DUTY_DAILY_START_CAP, DUTY_MAX_STEPS, dutyStartCapReached, formatClock, formatDuration,
  slotsAfter,
} from "../runtime/duty.js";
import {
  fail, ok, requireProject,
  type PlatformTool, type ToolResult,
} from "./types.js";

type StepsArg = { readonly ok: true; readonly steps: DutyRunStep[] }
  | { readonly ok: false; readonly result: ToolResult };

/** 开课时的功课参数:数组、1–`DUTY_MAX_STEPS` 步、每步标题与标准都非空。 */
function readPlanSteps(raw: unknown): StepsArg {
  if (!Array.isArray(raw)) {
    return { ok: false, result: fail("invalid_args", "steps 必须是数组:这一轮的功课,每步 { title, criterion }") };
  }
  if (raw.length < 1) {
    return {
      ok: false,
      result: fail("invalid_args", "功课至少一步 —— 写不出功课说明还没想清这一轮做什么:先看现状,再想朝着职责目标的最小一步"),
    };
  }
  if (raw.length > DUTY_MAX_STEPS) {
    return {
      ok: false,
      result: fail(
        "invalid_args",
        `一轮最多 ${DUTY_MAX_STEPS} 步(收到 ${raw.length})—— 一轮只推进一小步,剩下的留给下一轮`,
      ),
    };
  }
  const steps: DutyRunStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const o = (raw[i] ?? {}) as Record<string, unknown>;
    const title = typeof o["title"] === "string" ? o["title"].trim() : "";
    const criterion = typeof o["criterion"] === "string" ? o["criterion"].trim() : "";
    if (title === "" || criterion === "") {
      return {
        ok: false,
        result: fail(
          "invalid_args",
          `第 ${i + 1} 步的标题和可检验标准都不能为空 —— 标准要写「做到什么算这一步成了」(数字 / 动作 / 能打开验证)`,
        ),
      };
    }
    steps.push({ title, criterion, done: null, note: null });
  }
  return { ok: true, steps };
}

type AccountingArg = { readonly ok: true; readonly steps: DutyRunStep[] }
  | { readonly ok: false; readonly result: ToolResult };

/** 收工时的逐步交代:条数与开工时一致,每步标了做成没做成。 */
function readAccounting(raw: unknown, plan: readonly DutyRunStep[]): AccountingArg {
  if (!Array.isArray(raw)) {
    return { ok: false, result: fail("invalid_args", "steps 必须是数组:每一步功课的交代 { done, note? },顺序与开工时一致") };
  }
  if (raw.length !== plan.length) {
    return {
      ok: false,
      result: fail(
        "invalid_args",
        `开工时列了 ${plan.length} 步,收工时交代了 ${raw.length} 步 —— 每一步都要有交代(没做的也要标「没做成」并写原因)`,
      ),
    };
  }
  const steps: DutyRunStep[] = [];
  for (let i = 0; i < raw.length; i++) {
    const o = (raw[i] ?? {}) as Record<string, unknown>;
    if (typeof o["done"] !== "boolean") {
      return { ok: false, result: fail("invalid_args", `第 ${i + 1} 步缺 done(true / false):这一步到底做成没做成`) };
    }
    steps.push({
      ...plan[i]!,
      done: o["done"],
      note: typeof o["note"] === "string" && o["note"].trim() !== "" ? o["note"].trim() : null,
    });
  }
  return { ok: true, steps };
}

type TextArg = { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly result: ToolResult };

/** 非空的文本项。自省的每一项都**不许空着** —— 没有就写「无」,那是一个表态。 */
function readText(args: Readonly<Record<string, unknown>>, key: string, hint: string): TextArg {
  const v = args[key];
  const s = typeof v === "string" ? v.trim() : "";
  if (s === "") {
    return { ok: false, result: fail("invalid_args", `${key} 不许为空:${hint}`) };
  }
  return { ok: true, value: s };
}

const dutyRunOpen: PlatformTool = {
  name: "duty_run_open",
  capability: "duty.run",
  description:
    "职责到点开工:**先把这一轮的功课写下来**,再动手派活。" +
    "1–3 步,每步一条可检验的标准 —— 写不出功课,说明还没想清这一轮做什么。" +
    "写完之后这一轮**先不收工**:去派活(`ask_role` 请项目经理拆),等活落定平台会再叫你 `duty_run_close`。" +
    "⚠️ 它不是「立刻把活做完」—— 一轮只推进朝着职责目标的一小步。",
  parameters: Type.Object({
    steps: Type.Array(Type.Object({
      title: Type.String({ description: "这一步做什么(一句话)" }),
      criterion: Type.String({ description: "做到什么算这一步成了 —— 可检验:数字 / 动作 / 能打开验证" }),
    }), {
      description: "这一轮的功课:1–3 步,只推进朝着职责目标的一小步",
      minItems: 1,
      maxItems: DUTY_MAX_STEPS,
    }),
  }),
  run(args, ctx) {
    const proj = requireProject(ctx, "duty_run_open");
    if (!proj.ok) return proj.result;
    // ⚠️ 调用期的授权门**不重判**「项目在进行中」(那是建会话时算工具面的事),而旧会话里的
    // 工具在项目被暂停之后仍然调得动 ⇒ 工具自己看一眼,不指望会话一定是新的。
    if (proj.project.status !== "active") {
      return fail(
        "conflict",
        `这个职责的工作间项目此刻不在进行中(状态 ${proj.project.status})—— 不开新工也不收工`,
      );
    }
    const duty = dutyOfProject(ctx.db, proj.project.id);
    if (duty === null) {
      return fail("not_found", "当前项目不是任何职责的工作间 —— 这个工具只在职责的那一轮里用");
    }
    if (duty.status !== "active") {
      return fail("conflict", `职责「${duty.name}」已暂停 —— 暂停的职责不开新工(到设置页启用)`);
    }
    const open = openDutyRunOf(ctx.db, duty.id);
    if (open !== null) {
      return fail(
        "conflict",
        `上一轮(${open.id})还没收工 —— 先用 duty_run_close 把它收了;同一职责同时只有一轮`,
        ["duty_run_close"],
      );
    }
    const plan = readPlanSteps(args["steps"]);
    if (!plan.ok) return plan.result;

    const now = ctx.now();
    // 每天上限:规则那一层已经拦了,这里是第二道 —— 两处读的是同一个判据。
    if (dutyStartCapReached(ctx.db, now)) {
      return fail(
        "conflict",
        `今天全系统已经开了 ${DUTY_DAILY_START_CAP} 轮工 —— 到上限了,明天再开`,
      );
    }

    // 这一轮服务的排定点:职责排定的那一个(补做时它已经过去);没排定就按此刻。
    const slot = duty.nextDueAt ?? now;
    const { missed, nextDueAt } = slotsAfter(duty.cadence, slot, now);
    const id = ctx.newId("dr");
    insertDutyRun(ctx.db, {
      id, dutyId: duty.id, scheduledFor: slot, startedAt: now, finishedAt: null,
      status: "open", steps: plan.steps,
      doneSummary: null, notDone: null, cause: null, nextChange: null, gaps: null, learned: null,
      failures: [],
    });
    // 下一次从此刻之后的第一个排定点起算(不是「排定点 + 一格」—— 补做时那一格可能也已经过去了)。
    updateDuty(ctx.db, duty.id, { nextDueAt, lastRunAt: now }, now);

    const late = Math.max(0, now - slot);
    return ok(
      `已开工:这一轮 ${id},服务的是 ${formatClock(slot)} 那个排定点` +
        (late > 0 ? `(晚了 ${formatDuration(late)}` + (missed > 0 ? `,期间错过 ${missed} 轮` : "") + ")" : "") +
        `。\n功课 ${plan.steps.length} 步:${plan.steps.map((s, i) => `\n  ${i + 1}. ${s.title} —— ${s.criterion}`).join("")}` +
        `\n下一次开工:${formatClock(nextDueAt)}。\n现在去派活;这一轮先不收工,等活落定平台会叫你 duty_run_close。`,
      { dutyRunId: id, dutyId: duty.id, scheduledFor: slot, missed },
    );
  },
};

const dutyRunClose: PlatformTool = {
  name: "duty_run_close",
  capability: "duty.run",
  description:
    "职责这一轮收工:**逐步交代 + 写自省**。每一步功课标做成没做成;" +
    "做成 / 没做成 / 下一轮怎么改 / 缺口 / 新知五项都要填(没有就写「无」,不许空着)。" +
    "这一轮里出过失败(工作项失败 / 质检不通过 / 甲方拒收)时,`cause`(原因在自己哪一步)必填。" +
    "⚠️ 不报百分比、不说「一切顺利」;没做成的照实写。收工后你写的正文就是给甲方的日报。",
  parameters: Type.Object({
    done: Type.String({ description: "做成了什么(对着功课逐步说;有产出就说出它在哪)" }),
    notDone: Type.String({ description: "没做成什么。没有就写「无」" }),
    nextChange: Type.String({ description: "下一轮怎么改:具体到动作" }),
    gaps: Type.String({ description: "没做到 / 缺口 / 存疑:哪些结论不够实、哪些没覆盖。没有就写「无」" }),
    learned: Type.String({ description: "这一轮新知:以前不知道、现在知道的事。没有就写「无」" }),
    cause: Type.Optional(Type.String({
      description: "原因在自己哪一步(目标没写清 / 判据没给 / 没先看现状 / 派活没说清 …)。这一轮里有失败时必填",
    })),
    steps: Type.Array(Type.Object({
      done: Type.Boolean({ description: "这一步做成没做成" }),
      note: Type.Optional(Type.String({ description: "一句说明:做成了什么 / 为什么没做成" })),
    }), { description: "每一步功课的交代,顺序与开工时一致" }),
  }),
  run(args, ctx) {
    const proj = requireProject(ctx, "duty_run_close");
    if (!proj.ok) return proj.result;
    // ⚠️ 调用期的授权门**不重判**「项目在进行中」(那是建会话时算工具面的事),而旧会话里的
    // 工具在项目被暂停之后仍然调得动 ⇒ 工具自己看一眼,不指望会话一定是新的。
    if (proj.project.status !== "active") {
      return fail(
        "conflict",
        `这个职责的工作间项目此刻不在进行中(状态 ${proj.project.status})—— 不开新工也不收工`,
      );
    }
    const duty = dutyOfProject(ctx.db, proj.project.id);
    if (duty === null) {
      return fail("not_found", "当前项目不是任何职责的工作间 —— 这个工具只在职责的那一轮里用");
    }
    const run = openDutyRunOf(ctx.db, duty.id);
    if (run === null) {
      return fail("conflict", `职责「${duty.name}」没有未收工的一轮 —— 先 duty_run_open`, ["duty_run_open"]);
    }
    const done = readText(args, "done", "对着功课说做成了什么;有产出就说出它在哪");
    if (!done.ok) return done.result;
    const notDone = readText(args, "notDone", "没做成什么;没有就写「无」");
    if (!notDone.ok) return notDone.result;
    const nextChange = readText(args, "nextChange", "下一轮怎么改,具体到动作");
    if (!nextChange.ok) return nextChange.result;
    const gaps = readText(args, "gaps", "没做到 / 缺口 / 存疑;没有就写「无」");
    if (!gaps.ok) return gaps.result;
    const learned = readText(args, "learned", "这一轮新知;没有就写「无」");
    if (!learned.ok) return learned.result;
    const accounting = readAccounting(args["steps"], run.steps);
    if (!accounting.ok) return accounting.result;

    const causeRaw = args["cause"];
    const cause = typeof causeRaw === "string" && causeRaw.trim() !== "" ? causeRaw.trim() : null;

    // ── 屡败屡战 · 反求诸己:出了失败,先写自己的原因 ──────────────
    const now = ctx.now();
    const failures = failuresSince(ctx.db, proj.project.id, run.startedAt);
    if (failures.length > 0 && cause === null) {
      return fail(
        "invalid_args",
        `这一轮里有 ${failures.length} 件事没成:${failures.map((f) => `\n  · [${f.kind}] ${f.id}${f.title !== "" ? `「${f.title}」` : ""}`).join("")}` +
          `\ncause(原因在自己哪一步)不许为空 —— 先想自己哪一步没做实(目标没写清 / 判据没给 / 没先看现状 / 派活没说清),` +
          `再想怎么改;不要归因于外部就完事`,
        ["cause"],
      );
    }

    updateDutyRun(ctx.db, run.id, {
      status: "done", finishedAt: now, steps: accounting.steps,
      doneSummary: done.value, notDone: notDone.value, cause,
      nextChange: nextChange.value, gaps: gaps.value, learned: learned.value, failures,
    });
    const made = accounting.steps.filter((s) => s.done).length;
    return ok(
      `已收工:${made}/${accounting.steps.length} 步做成` +
        (failures.length > 0 ? `,这一轮有 ${failures.length} 件事没成` : "") +
        `。\n正文就是给甲方的日报 —— 把做成 / 没做成 / 缺口写给他看,不用再 tell_client 一遍。`,
      { dutyRunId: run.id, dutyId: duty.id, doneSteps: made, totalSteps: accounting.steps.length, failures: failures.length },
    );
  },
};

export const DUTY_TOOLS: readonly PlatformTool[] = [dutyRunOpen, dutyRunClose];
