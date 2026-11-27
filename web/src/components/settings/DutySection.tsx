/**
 * 职责 · 设置页那一段(039,2026-11-27)—— 职责在前端的**唯一写面**
 *
 * 职责只有人能建、能改:设一条职责 = 预先授权这个范围内的活自动开工,而预先授权
 * 必须出自甲方本人。所以它长在设置页,不做成对话里的一个动作。
 *
 * 这一段回答三个问题(顺序就是读的人会问的顺序):
 *   ① 我设过哪些职责 —— 每条一张卡:名字、目标、节奏、下次什么时候开工、最近一轮怎么样;
 *   ② 现在是什么状态 —— 启用 / 工作间不在进行中 / 已暂停,**照两个状态的组合说话**
 *      (判据在 `dutyStatus.ts` 的 `scheduleLine` / `statusPill`);
 *   ③ 我能做什么 —— 新建 / 编辑 / 暂停 / 启用 / 现在做一次。
 *
 * ⚠️ 日报不在这里:它是这条职责的对话里的消息 —— 打开左栏里那个项目就能看。
 * ⚠️ 读失败由 `DataState` 如实说(「加载失败」),不渲染成「还没有职责」。
 */
import { useEffect, useState, type ReactNode } from "react";
import { Help } from "@/components/ui/Help";
import { DataState, remoteListOf } from "@/components/ui/DataState";
import { EmptyState, Pill, RedInline } from "@/components/ui/primitives";
import { useChatStore } from "@/stores/chat";
import * as api from "@/lib/api";
import { errorMessage } from "@/lib/api";
import { useDuties } from "@/lib/data";
import type { DutyView } from "@shared/types/platform";
import {
  EMPTY_DUTY_FORM, WEEKDAY_LABELS, createBody, dutyToForm, formProblem, runLine, scheduleLine,
  statusPill, updateBody, type DutyForm,
} from "./dutyStatus";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="sansheng-text-mute" style={{ fontSize: 12 }}>{label}</span>
      {children}
    </label>
  );
}

const input = "sansheng-input";

/**
 * 表单(只收参数):新建与编辑共用 —— `isNew` 决定要不要「先建着,暂不启用」那一格。
 * 「保存」在表单自己都判不过的时候是灰的,原因就写在按钮旁边(不做成悬停)。
 */
export function DutyFormBody(props: {
  form: DutyForm;
  isNew: boolean;
  busy: boolean;
  onChange(next: DutyForm): void;
  onSave(): void;
  onCancel(): void;
}) {
  const { form, isNew } = props;
  const set = (patch: Partial<DutyForm>): void => props.onChange({ ...form, ...patch });
  const problem = formProblem(form);
  return (
    <div className="rounded-md p-3 mb-3 flex flex-col gap-3" style={{ border: "1px solid var(--ink-3)" }}>
      <Field label="名称">
        <input className={`${input} sansheng-input-block`} value={form.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <Field label="什么算做好了">
        <input className={`${input} sansheng-input-block`} value={form.goal} onChange={(e) => set({ goal: e.target.value })} />
      </Field>
      <Field label="必须先问你的事(可留空)">
        <input className={`${input} sansheng-input-block`} value={form.boundaries} onChange={(e) => set({ boundaries: e.target.value })} />
      </Field>
      <Field label="节奏">
        <span className="flex flex-wrap items-center gap-2">
          <select className={input} value={form.kind} onChange={(e) => set({ kind: e.target.value as DutyForm["kind"] })}>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="hourly">每隔几小时</option>
          </select>
          {form.kind !== "hourly" && (
            <input className={input} type="time" value={form.at} onChange={(e) => set({ at: e.target.value })} />
          )}
          {form.kind === "weekly" && (
            <select className={input} value={form.weekday} onChange={(e) => set({ weekday: Number(e.target.value) })}>
              {WEEKDAY_LABELS.map((label, i) => (
                <option key={label} value={i}>{label}</option>
              ))}
            </select>
          )}
          {form.kind === "hourly" && (
            <span className="flex items-center gap-1">
              <input className={input} type="number" min={1} style={{ width: 72 }} value={form.hours}
                onChange={(e) => set({ hours: e.target.value })} />
              <span className="sansheng-text-mute" style={{ fontSize: 12 }}>小时(22:00–08:00 不开新工)</span>
            </span>
          )}
        </span>
      </Field>
      <label className="flex items-center gap-2" style={{ fontSize: 13 }}>
        <input type="checkbox" checked={form.formal} onChange={(e) => set({ formal: e.target.checked })} />
        产出是正式交付物(要你验收);不勾就是例行产出,只看日报
      </label>
      {isNew && (
        <label className="flex items-center gap-2" style={{ fontSize: 13 }}>
          <input type="checkbox" checked={form.startPaused} onChange={(e) => set({ startPaused: e.target.checked })} />
          先建着,暂不启用
        </label>
      )}
      <span className="flex items-center gap-3">
        <button type="button" className="sansheng-button-primary" disabled={props.busy || problem !== null} onClick={props.onSave}>
          {props.busy ? "保存中…" : "保存"}
        </button>
        <button type="button" className="sansheng-button" disabled={props.busy} onClick={props.onCancel}>取消</button>
        {problem !== null && <span className="sansheng-text-cinnabar" style={{ fontSize: 12 }}>{problem}</span>}
      </span>
    </div>
  );
}

/**
 * 列表(只收参数):每条职责一张卡。读的人会按这个顺序问 —— 叫什么 / 什么算好 /
 * 多久一次、下次几点 / 上一轮怎么样 / 我能点什么,卡上的行就是这个顺序。
 * 「目标」照抄职责的目标原文(那是甲方自己写的);其余几行的话在 `dutyStatus.ts`。
 */
export function DutyList(props: {
  rows: readonly DutyView[];
  /** 「现在」由外壳给(它每半分钟更新一次)—— 列表自己不读时钟,测试才喂得进确定的值 */
  now: number;
  busy: boolean;
  onEdit(d: DutyView): void;
  onToggle(d: DutyView): void;
  onRunNow(d: DutyView): void;
}) {
  const { rows, now, busy } = props;
  if (rows.length === 0) return <EmptyState>还没有职责。设一条,到点他自己开工。</EmptyState>;
  return (
    <div className="flex flex-col gap-3">
      {rows.map((d) => {
        const pill = statusPill(d);
        return (
          <div key={d.id} className="rounded-md p-3" style={{ border: "1px solid var(--ink-3)" }}>
            <div className="flex items-center justify-between gap-2">
              <span className="font-serif truncate" style={{ fontSize: 14, color: "var(--bone)" }}>{d.name}</span>
              <span className="flex-none flex items-center gap-1.5">
                <Pill tone={pill.tone}>{pill.label}</Pill>
                <Pill tone="mute">{d.formal ? "正式交付物" : "例行产出"}</Pill>
              </span>
            </div>
            <div className="ss-meta">目标:{d.goal}</div>
            <div className="ss-meta">{d.cadenceLabel} · {scheduleLine(d, now)}</div>
            <div className="ss-meta">{runLine(d)}</div>
            {d.boundaries !== "" && <div className="ss-meta">必须先问你:{d.boundaries}</div>}
            <span className="flex gap-2 mt-2">
              <button type="button" className="sansheng-button" disabled={busy} onClick={() => props.onEdit(d)}>
                编辑
              </button>
              <button type="button" className="sansheng-button" disabled={busy} onClick={() => props.onToggle(d)}>
                {d.status === "active" ? "暂停" : "启用"}
              </button>
              <button
                type="button" className="sansheng-button"
                disabled={busy || d.status !== "active"} onClick={() => props.onRunNow(d)}
              >
                现在做一次
              </button>
            </span>
          </div>
        );
      })}
    </div>
  );
}

export function DutySection() {
  const [extra, setExtra] = useState(0);
  const duties = useDuties(extra);
  // 「到没到点」每半分钟就地重算一次 —— 只为那一行字,不重拉数据。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  /** `null` = 没在编辑;`id === null` = 新建。 */
  const [editing, setEditing] = useState<{ id: string | null; form: DutyForm } | null>(null);
  const [busy, setBusy] = useState(false);
  /** 服务端拒收的原话(或表单的问题)—— 原样给用户看,不改写成「操作失败」。 */
  const [problem, setProblem] = useState<string | null>(null);

  function refresh(): void {
    setExtra((n) => n + 1);
    // 新建会多出一个项目、暂停 / 启用会改项目状态 —— 左栏那份列表也要重拉
    useChatStore.setState((s) => ({ projectsRevision: s.projectsRevision + 1 }));
  }

  async function submit(): Promise<void> {
    if (editing === null) return;
    const { id, form } = editing;
    const invalid = formProblem(form);
    if (invalid !== null) {
      setProblem(invalid);
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      if (id === null) {
        const r = await api.createDuty(createBody(form));
        // 工作区没建出来的项目永远跑不起来 —— 服务端把它带在响应里,这里如实说
        if (!r.workspaceBootstrapped) setProblem(r.workspaceProblem ?? "工作间的工作区没有建出来");
      } else {
        await api.updateDuty(id, updateBody(form));
      }
      setEditing(null);
      refresh();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function act(run: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setProblem(null);
    try {
      await run();
      refresh();
    } catch (e) {
      setProblem(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const toggle = (d: DutyView): void => void act(() =>
    api.updateDuty(d.id, { status: d.status === "active" ? "paused" : "active" }));
  const runNow = (d: DutyView): void => void act(() => api.runDutyNow(d.id));

  return (
    <section className="sansheng-card-elevated p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="font-serif" style={{ color: "var(--bone)", fontSize: 14, letterSpacing: ".04em" }}>
          职责 <Help id="settings.duties" />
        </h2>
        <button
          type="button" className="sansheng-button" disabled={busy}
          onClick={() => { setProblem(null); setEditing({ id: null, form: EMPTY_DUTY_FORM }); }}
        >
          + 新建职责
        </button>
      </div>

      {editing !== null && (
        <DutyFormBody
          form={editing.form} isNew={editing.id === null} busy={busy}
          onChange={(next) => setEditing({ id: editing.id, form: next })}
          onSave={() => void submit()}
          onCancel={() => { setEditing(null); setProblem(null); }}
        />
      )}
      {problem !== null && <RedInline className="mb-3">{problem}</RedInline>}

      <DataState
        what="职责" state={remoteListOf(duties.data, duties.loading, duties.error)}
        errorNote=" —— 这不是「还没有职责」"
      >
        {(rows) => (
          <DutyList
            rows={rows} now={now} busy={busy}
            onEdit={(d) => { setProblem(null); setEditing({ id: d.id, form: dutyToForm(d) }); }}
            onToggle={toggle}
            onRunNow={runNow}
          />
        )}
      </DataState>
    </section>
  );
}
