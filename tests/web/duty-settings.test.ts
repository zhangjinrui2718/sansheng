/**
 * 职责 · 设置页那一段(039,2026-11-27)· 前端回归
 *
 * ── 这一文件守什么 ───────────────────────────────────────────────
 *
 *   ① **照两个状态的组合说话**:职责启用、工作间却不在进行中 ⇒ 说「不会开工」,
 *      不说成「启用中」;已暂停就是已暂停。上一轮「平台收掉的」与「模型自己收的」说法不同。
 *   ② **不报满**:只数「做成几步、共几步」,不折成百分比;缺口照抄(没有就不摆一行)。
 *   ③ **表单翻出来的节奏,服务端的校验认** —— 两边各写一份校验就会一边放行一边拒收,
 *      所以这里跨边界对一遍(`validateCadence` 是服务端那份)。
 *   ④ 读失败由 `DataState` 说(「加载失败」),不渲染成「还没有职责」—— 外壳那一层
 *      没法静态渲染,用源码级哨兵钉住;列表与表单是只收参数的,真渲染。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DutyView } from "@shared/types/platform";
import { DutyFormBody, DutyList } from "@/components/settings/DutySection";
import {
  EMPTY_DUTY_FORM, createBody, dutyToForm, formCadence, formProblem, runLine, scheduleLine,
  statusPill, updateBody,
} from "@/components/settings/dutyStatus";
import { validateCadence } from "../../src/platform/runtime/duty";
import { projectStatusLabel } from "@/lib/vocab";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(join(here, "..", "..", rel), "utf8");

/** 只留**可见正文**:去掉标签(属性跟在一起一起走)与 SSR 插的 `<!-- -->`。 */
const visible = (html: string): string =>
  html.replace(/ title="[^"]*"/g, "").replace(/<!-- -->/g, "").replace(/<[^>]*>/g, "");

const NOW = new Date(2026, 10, 27, 9, 1).getTime(); // 2026-11-27 09:01(本地)
const HOUR = 60 * 60 * 1000;

function duty(over: Partial<DutyView> = {}): DutyView {
  return {
    id: "du_1", projectId: "pj_1", name: "行业简报", goal: "每天一份三行简报", boundaries: "",
    cadence: { kind: "daily", at: "09:00", weekday: null, hours: null }, cadenceLabel: "每天 09:00",
    formal: false, status: "active", projectStatus: "active",
    nextDueAt: NOW + 23 * HOUR, lastRunAt: null, createdAt: NOW - 7 * 24 * HOUR, updatedAt: NOW,
    lastRun: null,
    ...over,
  };
}

const noop = (): void => undefined;
const renderList = (rows: readonly DutyView[], now = NOW): string =>
  renderToStaticMarkup(createElement(DutyList, { rows, now, busy: false, onEdit: noop, onToggle: noop, onRunNow: noop }));
const renderForm = (form: Parameters<typeof DutyFormBody>[0]["form"], isNew: boolean): string =>
  renderToStaticMarkup(createElement(DutyFormBody, { form, isNew, busy: false, onChange: noop, onSave: noop, onCancel: noop }));

// ── ① 照状态的组合说话 ──────────────────────────────────────────

describe("职责 · 「下次什么时候开工」照两个状态的组合说", () => {
  it("启用 + 工作间进行中 + 没到点 ⇒ 下次开工几点(绝对时刻,不是倒计时)", () => {
    expect(scheduleLine(duty(), NOW)).toMatch(/^下次开工 /);
  });

  it("到点了 ⇒ 「马上开工」", () => {
    expect(scheduleLine(duty({ nextDueAt: NOW }), NOW)).toBe("到点了,马上开工");
    expect(scheduleLine(duty({ nextDueAt: NOW - HOUR }), NOW)).toBe("到点了,马上开工");
  });

  it("已暂停 ⇒ 就是「已暂停」(哪怕库里还留着排定)", () => {
    expect(scheduleLine(duty({ status: "paused" }), NOW)).toBe("已暂停");
    expect(statusPill(duty({ status: "paused" }))).toEqual({ tone: "mute", label: "已暂停" });
  });

  it("⚠️ 职责是启用的、工作间却不在进行中 ⇒ 说「不会开工」,不说成「启用中」", () => {
    const d = duty({ projectStatus: "paused" });
    expect(scheduleLine(d, NOW)).toBe(`工作间${projectStatusLabel("paused")},不会开工`);
    expect(statusPill(d)).toEqual({ tone: "amber", label: `工作间${projectStatusLabel("paused")}` });
    // 卡上如实渲染出来
    const text = visible(renderList([d]));
    expect(text).toContain("不会开工");
    expect(text).not.toContain("启用中");
  });

  it("启用却没有排定(不该出现的形状)⇒ 如实说「没有排定」,不编一个时刻", () => {
    expect(scheduleLine(duty({ nextDueAt: null }), NOW)).toBe("没有排定");
  });

  it("启用 + 进行中 ⇒ 绿标「启用中」", () => {
    expect(statusPill(duty())).toEqual({ tone: "jade", label: "启用中" });
  });
});

// ── ② 最近一轮:不报满 ──────────────────────────────────────────

describe("职责 · 「最近一轮怎么样」", () => {
  const steps = [
    { title: "读三份来源", criterion: "各一句结论", done: true, note: "都读到了" },
    { title: "写成三行", criterion: "不超过 200 字", done: false, note: "有一份打不开" },
  ];

  it("从没开过工 / 这一轮开着", () => {
    expect(runLine(duty())).toBe("还没开过工");
    expect(runLine(duty({ lastRun: { id: "dr_1", dutyId: "du_1", scheduledFor: NOW - MIN, startedAt: NOW - MIN, finishedAt: null, status: "open", steps, doneSummary: null, notDone: null, cause: null, nextChange: null, gaps: null, learned: null, failures: [] } })))
      .toContain("这一轮开着");
  });

  it("模型自己收的:几步做成、共几步;缺口照抄;没有就不摆一行;**不折成百分比**", () => {
    const base = { id: "dr_1", dutyId: "du_1", scheduledFor: NOW - HOUR, startedAt: NOW - HOUR, finishedAt: NOW, status: "done" as const, steps, doneSummary: "x", notDone: "y", cause: null, nextChange: "z", learned: "w", failures: [] };
    expect(runLine(duty({ lastRun: { ...base, gaps: "只覆盖了三家公司" } }))).toContain("1/2 步做成 · 缺口:只覆盖了三家公司");
    expect(runLine(duty({ lastRun: { ...base, gaps: "无" } }))).not.toContain("缺口");
    expect(runLine(duty({ lastRun: { ...base, gaps: null } }))).not.toContain("缺口");
    expect(visible(renderList([duty({ lastRun: { ...base, gaps: "无" } })]))).not.toContain("%");
  });

  it("⚠️ 平台收掉的与模型自己收的说法不一样(没有自省的那一轮不能像反省过)", () => {
    const abandoned = { id: "dr_1", dutyId: "du_1", scheduledFor: NOW - HOUR, startedAt: NOW - HOUR, finishedAt: NOW, status: "abandoned" as const, steps: [{ ...steps[0]!, done: null, note: null }], doneSummary: null, notDone: null, cause: null, nextChange: null, gaps: "这一轮没能收工…", learned: null, failures: [] };
    const line = runLine(duty({ lastRun: abandoned }));
    expect(line).toContain("上一轮没能收工(平台收掉)");
    expect(line).not.toContain("步做成");
  });
});

const MIN = 60_000;

// ── ③ 表单 → 请求体 → 服务端认 ──────────────────────────────────

describe("职责 · 表单翻出来的东西服务端认", () => {
  it("三种节奏各翻各的:只带选中的那一种的两个字段", () => {
    expect(formCadence({ kind: "daily", at: "09:30", weekday: 3, hours: "" })).toEqual({ kind: "daily", at: "09:30" });
    // ⚠️ 样本别用周一:变异 Q8 把星期写死成 1,样本也是 1 的话它照样绿(第一轮就这么漏的)。
    expect(formCadence({ kind: "weekly", at: "08:00", weekday: 3, hours: "" })).toEqual({ kind: "weekly", at: "08:00", weekday: 3 });
    expect(formCadence({ kind: "hourly", at: "", weekday: 1, hours: "6" })).toEqual({ kind: "hourly", hours: 6 });
  });

  it("⚠️ 跨边界:表单翻出来的每种节奏,服务端那份校验都放行(两边各写一份就会一边放行一边拒收)", () => {
    const filled = { ...EMPTY_DUTY_FORM, name: "行业简报", goal: "每天一份三行简报" };
    const forms = [
      { ...filled },
      { ...filled, kind: "weekly" as const, at: "08:00", weekday: 0 },
      { ...filled, kind: "weekly" as const, at: "23:59", weekday: 6 },
      { ...filled, kind: "hourly" as const, hours: "1" },
      { ...filled, kind: "hourly" as const, hours: "168" },
    ];
    for (const f of forms) {
      expect(formProblem(f), JSON.stringify(f)).toBeNull();
      expect(validateCadence(formCadence(f)).ok, JSON.stringify(f)).toBe(true);
    }
  });

  it("只拦「空得没法建」:空名字 / 空目标 / 间隔不是正整数", () => {
    expect(formProblem({ ...EMPTY_DUTY_FORM, name: "  " })).toBe("先起个名字");
    expect(formProblem({ ...EMPTY_DUTY_FORM, name: "x", goal: "" })).toBe("先写清什么算做好了");
    for (const hours of ["", "0", "abc", "1.5"]) {
      expect(formProblem({ ...EMPTY_DUTY_FORM, name: "x", goal: "y", kind: "hourly", hours }), hours).toBe("间隔要是 1 小时以上的整数");
    }
  });

  it("⚠️ 每天 / 每周的表单不看「间隔」那一格(它根本没显示)—— 第一版把它一起判了,每天的职责也存不了", () => {
    expect(formProblem({ ...EMPTY_DUTY_FORM, name: "x", goal: "y", kind: "daily", hours: "" })).toBeNull();
    expect(formProblem({ ...EMPTY_DUTY_FORM, name: "x", goal: "y", kind: "weekly", hours: "0" })).toBeNull();
  });

  it("请求体:前后空白去掉;新建带「暂不启用」,改已有的不带状态", () => {
    const filled = { ...EMPTY_DUTY_FORM, name: "  行业简报 ", goal: " 每天一份 ", boundaries: " 付费先问我 ", startPaused: true, formal: true };
    expect(createBody(filled)).toEqual({
      name: "行业简报", goal: "每天一份", boundaries: "付费先问我",
      cadence: { kind: "daily", at: "09:00" }, formal: true, startPaused: true,
    });
    const body: Record<string, unknown> = updateBody(filled);
    expect(body).not.toHaveProperty("startPaused");
    expect(body).not.toHaveProperty("status");
  });

  it("改一条已有的职责:表单从读面翻回来(每周 / 每小时的格子都对得上)", () => {
    const weekly = duty({ cadence: { kind: "weekly", at: "08:00", weekday: 3, hours: null }, formal: true });
    expect(dutyToForm(weekly)).toMatchObject({ name: "行业简报", kind: "weekly", at: "08:00", weekday: 3, formal: true, startPaused: false });
    const hourly = duty({ cadence: { kind: "hourly", at: null, weekday: null, hours: 4 } });
    expect(dutyToForm(hourly)).toMatchObject({ kind: "hourly", hours: "4" });
    // 翻回来再翻过去,还是服务端认的那一份
    expect(validateCadence(formCadence(dutyToForm(weekly))).ok).toBe(true);
  });
});

// ── 真渲染:列表与表单 ───────────────────────────────────────────

describe("职责 · 设置页那一段(真渲染)", () => {
  it("空列表:真的是拉过之后 0 条才说「还没有职责」", () => {
    expect(visible(renderList([]))).toContain("还没有职责");
  });

  it("一张卡:名字、目标、节奏、下次开工、产出形态;三个按钮", () => {
    const text = visible(renderList([duty()]));
    for (const s of ["行业简报", "目标:每天一份三行简报", "每天 09:00", "下次开工", "还没开过工", "启用中", "例行产出", "编辑", "暂停", "现在做一次"]) {
      expect(text, s).toContain(s);
    }
    expect(text).not.toContain("必须先问你"); // 没写边界就不摆一行空的
  });

  it("写了边界就摆出来;正式交付物的职责标出来", () => {
    const text = visible(renderList([duty({ boundaries: "付费来源先问我", formal: true })]));
    expect(text).toContain("必须先问你:付费来源先问我");
    expect(text).toContain("正式交付物");
  });

  it("已暂停的职责:按钮是「启用」,「现在做一次」是灰的", () => {
    const html = renderList([duty({ status: "paused", nextDueAt: null })]);
    expect(visible(html)).toContain("启用");
    expect(html).toMatch(/<button[^>]*class="sansheng-button"[^>]*disabled[^>]*>现在做一次<\/button>/);
  });

  it("启用的职责:「现在做一次」能按", () => {
    const html = renderList([duty()]);
    expect(html).toMatch(/<button[^>]*class="sansheng-button"[^>]*>现在做一次<\/button>/);
    expect(html).not.toMatch(/<button[^>]*disabled[^>]*>现在做一次<\/button>/);
  });

  it("新建表单:空的存不了,原因写在按钮旁;有「先建着,暂不启用」", () => {
    const html = renderForm(EMPTY_DUTY_FORM, true);
    expect(visible(html)).toContain("先起个名字");
    expect(html).toMatch(/<button[^>]*class="sansheng-button-primary"[^>]*disabled[^>]*>保存<\/button>/);
    expect(visible(html)).toContain("先建着,暂不启用");
  });

  it("填好了能存;改已有的职责不带「暂不启用」;每周 / 每小时各显示自己那一格", () => {
    const filled = { ...EMPTY_DUTY_FORM, name: "x", goal: "y" };
    const html = renderForm(filled, false);
    expect(visible(html)).not.toContain("先起个名字");
    expect(html).not.toMatch(/<button[^>]*class="sansheng-button-primary"[^>]*disabled[^>]*>保存<\/button>/);
    expect(visible(html)).not.toContain("先建着,暂不启用");

    const weekly = visible(renderForm({ ...filled, kind: "weekly" }, true));
    for (const d of ["周日", "周一", "周六"]) expect(weekly, d).toContain(d);
    expect(weekly, "每周的表单不摆「间隔」那一格的说明").not.toContain("22:00–08:00");
    const hourly = visible(renderForm({ ...filled, kind: "hourly" }, true));
    expect(hourly).toContain("22:00–08:00 不开新工");
    expect(hourly).not.toContain("周一");
  });
});

// ── 接线哨兵(外壳那一层没法静态渲染)──────────────────────────────

describe("职责 · 接线(源码级哨兵)", () => {
  const section = read("web/src/components/settings/DutySection.tsx");

  it("外壳走四态:读失败说「加载失败」,不说成「还没有职责」", () => {
    expect(section).toContain("<DataState");
    expect(section).toContain("remoteListOf(");
    expect(section).toContain("这不是「还没有职责」");
    // 四态的字面量只许住在 DataState.tsx 里
    expect(section).not.toMatch(/kind: "(loading|error|unavailable|ready)"/);
  });

  it("取数走 `useDuties`;它跟着回合重拉,也跟着你自己刚做过的操作重拉", () => {
    expect(section).toContain("useDuties(");
    const data = read("web/src/lib/data.ts");
    const hook = data.slice(data.indexOf("export function useDuties("));
    expect(hook.slice(0, hook.indexOf("}\n}"))).toContain("useChatStore((s) => s.projectRevision)");
    expect(hook.slice(0, hook.indexOf("}\n}"))).toContain("[revision, extra]");
  });

  it("服务端拒收的原话原样上屏(红壳),不改写成「操作失败」", () => {
    expect(section).toContain("<RedInline");
    expect(section).toContain("setProblem(errorMessage(e))");
    // ⚠️ 先剥注释:这条判据本身写在组件的头注释里(「不改写成『操作失败』」),不剥就等于判据把自己判红了。
    expect(section.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")).not.toContain("操作失败");
  });

  it("四个写接口都在,路径与服务端一致", () => {
    const api = read("web/src/lib/api.ts");
    expect(api).toContain('request("/duties")');
    expect(api).toContain('request("/duties", { method: "POST"');
    expect(api).toContain("`/duties/${encodeURIComponent(id)}`");
    expect(api).toContain("`/duties/${encodeURIComponent(id)}/run-now`");
  });

  it("挂在设置页上,且只挂一次", () => {
    const panel = read("web/src/components/settings/SettingsPanel.tsx");
    expect(panel.match(/<DutySection \/>/g)).toHaveLength(1);
  });

  it("词汇表那一条有读者;这一段没有悬停、没有 hint(说明都在 `?` 里)", () => {
    expect(section).toContain('<Help id="settings.duties" />');
    expect(section).not.toMatch(/\btitle=/);
    expect(section).not.toMatch(/\bhint=/);
  });

  it("左栏:职责的工作间项目带「职责」标记;普通项目不带这个字段", () => {
    const rail = read("web/src/components/shell/HistoryRail.tsx");
    expect(rail).toContain('p.duty !== undefined && <Pill tone="mute">职责</Pill>');
  });
});
