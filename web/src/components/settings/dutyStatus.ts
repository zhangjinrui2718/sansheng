/**
 * 职责在设置页上的说法(039,2026-11-27)—— 纯逻辑,无 JSX
 *
 * 三件事收在这里,组件(`DutySection.tsx`)只管排版:
 *   · 「下次什么时候开工」—— 照职责状态与工作间状态的**组合**说话,不替它圆成「在跑」;
 *   · 「最近一轮怎么样」—— 开着 / 模型自己收的 / 平台收掉的 / 从没开过,四种说法不一样;
 *   · 表单 → 请求体 —— 节奏的说法不在前端拼(`DutyView.cadenceLabel` 是服务端算的),
 *     这里只把三选一的表单翻成结构化的那几个字段。
 */
import type { DutyView } from "@shared/types/platform";
import type { DutyCadenceInput, DutyCreateInput, DutyUpdateInput } from "@/lib/api";
import { excerpt, fmtTime, projectStatusLabel } from "@/lib/vocab";

/** 与服务端同一套编号(JS 的 `getDay`):0 = 周日。 */
export const WEEKDAY_LABELS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;

/** 表单里的一格:时刻 / 星期 / 间隔先当字符串存(输入框的本性),提交时才翻成数。 */
export interface DutyForm {
  name: string;
  goal: string;
  boundaries: string;
  kind: "daily" | "weekly" | "hourly";
  at: string;
  weekday: number;
  hours: string;
  formal: boolean;
  startPaused: boolean;
}

export const EMPTY_DUTY_FORM: DutyForm = {
  name: "", goal: "", boundaries: "",
  kind: "daily", at: "09:00", weekday: 1, hours: "6",
  formal: false, startPaused: false,
};

export function dutyToForm(d: DutyView): DutyForm {
  return {
    name: d.name, goal: d.goal, boundaries: d.boundaries,
    kind: d.cadence.kind,
    at: d.cadence.at ?? "09:00",
    weekday: d.cadence.weekday ?? 1,
    hours: d.cadence.hours !== null ? String(d.cadence.hours) : "6",
    formal: d.formal,
    // 「暂不启用」只对新建有意义:改一条已有的时,启停走它自己那个按钮
    startPaused: false,
  };
}

/** 表单 → 节奏。只带当前选中的那一种(另外两格不带 —— 服务端只认配对的那一格)。 */
export function formCadence(f: Pick<DutyForm, "kind" | "at" | "weekday" | "hours">): DutyCadenceInput {
  if (f.kind === "hourly") return { kind: "hourly", hours: Number(f.hours) };
  if (f.kind === "weekly") return { kind: "weekly", at: f.at, weekday: f.weekday };
  return { kind: "daily", at: f.at };
}

/** 新建的请求体:前后空白去掉;「暂不启用」只在这条路上有意义。 */
export function createBody(f: DutyForm): DutyCreateInput {
  return {
    name: f.name.trim(), goal: f.goal.trim(), boundaries: f.boundaries.trim(),
    cadence: formCadence(f), formal: f.formal, startPaused: f.startPaused,
  };
}

/** 改一条已有职责的请求体:不带状态 —— 启停走它自己那个按钮,不和改名混在一次提交里。 */
export function updateBody(f: DutyForm): DutyUpdateInput {
  return {
    name: f.name.trim(), goal: f.goal.trim(), boundaries: f.boundaries.trim(),
    cadence: formCadence(f), formal: f.formal,
  };
}

/**
 * 表单里连服务端都没法替你判的那几样;没有问题就 `null`。
 * ⚠️ 这里只拦「空得没法建」:节奏的形状对不对由服务端 `validateCadence` 说了算 ——
 * 同一条规则写两份,迟早一边放行一边拒收。
 */
export function formProblem(f: DutyForm): string | null {
  if (f.name.trim() === "") return "先起个名字";
  if (f.goal.trim() === "") return "先写清什么算做好了";
  if (f.kind === "hourly" && (!Number.isInteger(Number(f.hours)) || Number(f.hours) < 1)) {
    return "间隔要是 1 小时以上的整数";
  }
  return null;
}

/** 「下次什么时候开工」。 */
export function scheduleLine(
  d: Pick<DutyView, "status" | "projectStatus" | "nextDueAt">,
  now: number,
): string {
  if (d.status === "paused") return "已暂停";
  // 职责自己是启用的,工作间却不在进行中 —— 它不会开工。如实说,不说成「启用中」。
  if (d.projectStatus !== "active") {
    return `工作间${projectStatusLabel(d.projectStatus)},不会开工`;
  }
  if (d.nextDueAt === null) return "没有排定";
  if (d.nextDueAt <= now) return "到点了,马上开工";
  return `下次开工 ${fmtTime(d.nextDueAt)}`;
}

/** 状态标签与它的语气(启用 / 不在进行中 / 已暂停)。 */
export function statusPill(d: Pick<DutyView, "status" | "projectStatus">): {
  readonly tone: "jade" | "amber" | "mute";
  readonly label: string;
} {
  if (d.status === "paused") return { tone: "mute", label: "已暂停" };
  if (d.projectStatus !== "active") {
    return { tone: "amber", label: `工作间${projectStatusLabel(d.projectStatus)}` };
  }
  return { tone: "jade", label: "启用中" };
}

/** 「最近一轮怎么样」。只数做成几步、共几步 —— 不折成百分比(求缺:不报满)。 */
export function runLine(d: Pick<DutyView, "lastRun">): string {
  const r = d.lastRun;
  if (r === null) return "还没开过工";
  if (r.status === "open") return `这一轮开着 · ${fmtTime(r.startedAt)} 开工`;
  if (r.status === "abandoned") {
    return `上一轮没能收工(平台收掉)· ${fmtTime(r.finishedAt ?? r.startedAt)}`;
  }
  const made = r.steps.filter((s) => s.done === true).length;
  const gaps = r.gaps !== null && r.gaps.trim() !== "" && r.gaps.trim() !== "无"
    ? ` · 缺口:${excerpt(r.gaps, 40)}`
    : "";
  return `上一轮 ${fmtTime(r.finishedAt ?? r.startedAt)} · ${made}/${r.steps.length} 步做成${gaps}`;
}
