/**
 * Sansheng · Harness 编辑器的共用件(批次 7-O)
 *
 * 提示词编辑器与工具集合编辑器共用四样东西,放一处是为了让**两个编辑器的诚实度
 * 完全一致**:失败怎么显示、成功怎么显示、invalidate 复选框怎么写、恢复出厂怎么
 * 二次确认。四个页面各写一遍的年代已经造成过「一边如实报 failed、一边报成功」。
 *
 * ── 本层的两条硬规矩 ───────────────────────────────────────────────────
 *  1. **后端的 message 一字不改**。FacetApiError.message 已经在里面说了人话
 *     (哪些工具名不认识 / 超过上限多少字符 / 角色不在注册表内),前端不翻译、不
 *     截断、不加「操作失败:」这种把信息埋掉的壳。
 *  2. **成功不等于生效**。changed=false 就要说「未写盘」;enforced=false 就要说
 *     「改了不会有任何效果」;invalidated=false 就要把 invalidateError 摆出来。
 *     一个绿色 toast 盖掉这三件事,是本项目反造假纪律最典型的破口。
 */
import { useState } from "react";
import { Flag, KV, Pill, type Tone } from "@/components/ui/primitives";
import { FacetApiError, unknownNamesOf, type ApplyOk, type ToolRisk } from "./facetClient";

/* ── 风险标签:三个值 → 三个既有 tone,不新增配色 ───────────────────────── */

const RISK_LABEL: Record<ToolRisk, string> = {
  readonly: "只读",
  mutating: "写入",
  exec: "执行",
};

/** 只读=骨(中性)· 写入=琥(警示)· 执行=朱(危险)。与页面其它语义色同源。 */
const RISK_TONE: Record<ToolRisk, Tone> = {
  readonly: "bone",
  mutating: "amber",
  exec: "cinnabar",
};

export function RiskPill({ risk, title }: { risk: ToolRisk; title?: string }) {
  return (
    <Pill tone={RISK_TONE[risk] ?? "bone"} title={title}>
      {RISK_LABEL[risk] ?? "未知风险"}
    </Pill>
  );
}

/* ── 失败 ─────────────────────────────────────────────────────────────── */

/**
 * 失败渲染。**第一行就是后端原话**,不加工。
 * 500(io_error)把 fileChanged:false 顶到最上面 ——「文件没被动过」这句话比
 * 「操作失败」重要一个数量级。
 */
export function ApiErrorNote({ error }: { error: unknown }) {
  if (error instanceof FacetApiError) {
    const unknownNames = unknownNamesOf(error);
    return (
      <div className="grid gap-1">
        {error.fileChanged === false ? (
          <Flag tone="jade">
            <span className="ss-note">文件未被改动。</span>
          </Flag>
        ) : null}
        <Flag tone="cinnabar">
          <span className="ss-note">
            {error.message}
            <span className="ss-meta">
              {" "}
              (HTTP {error.status} · {error.code})
            </span>
          </span>
        </Flag>
        {unknownNames.length > 0 ? (
          <div className="flex items-center gap-1 flex-wrap" style={{ paddingLeft: 8 }}>
            <span className="ss-meta">不认识的工具名</span>
            {unknownNames.map((n) => (
              <Pill key={n} tone="cinnabar">
                {n}
              </Pill>
            ))}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <Flag tone="cinnabar">
      <span className="ss-note">{error instanceof Error ? error.message : String(error)}</span>
    </Flag>
  );
}

/* ── 成功 ─────────────────────────────────────────────────────────────── */

/**
 * 写入结果。**changed / backupPath / warnings 全部原样上屏**,一个都不折叠:
 *「写了什么、备份在哪、有没有告警」是用户点保存之后唯一想知道的三件事。
 * blockedByCeiling 由 tools 编辑器额外传入(写完之后 entry.detail 现算的真实快照)。
 */
export function ApplyResultNote({
  result,
  blockedByCeiling,
}: {
  result: ApplyOk;
  blockedByCeiling?: string[];
}) {
  const blocked = blockedByCeiling ?? [];
  return (
    <div className="grid gap-1">
      <Flag tone={result.changed ? "jade" : "amber"}>
        <span className="ss-note">
          {result.changed
            ? "已写盘。"
            : "内容与现状一致,未写盘(没有备份,也没有任何副作用)。"}
        </span>
      </Flag>
      <div className="grid gap-0.5">
        <KV label="文件" value={<span className="ss-meta">{result.filePath}</span>} />
        <KV
          label="备份"
          value={
            <span className="ss-meta">
              {result.backupPath ?? "(无 —— 之前没有可备份的旧文件)"}
            </span>
          }
        />
        <KV label="生效时机" value={<span className="ss-note">{result.apply}</span>} />
      </div>
      {blocked.length > 0 ? (
        <Flag tone="amber">
          <span className="ss-note">
            {"这次写入里有上界外的名字:"}
            {blocked.join("、")}
            {" —— 已写进文件但不会生效。放开上界是改 ROLE_CEILING 的代码动作。"}
          </span>
        </Flag>
      ) : null}
      {result.warnings.map((w) => (
        <Flag key={w} tone="amber">
          <span className="ss-note">{w}</span>
        </Flag>
      ))}
      {result.invalidated === true ? (
        <Flag tone="jade">
          <span className="ss-note">已重建会话,新手册对当前回合生效。</span>
        </Flag>
      ) : null}
      {result.invalidateError ? (
        <Flag tone="amber">
          <span className="ss-note">{result.invalidateError}</span>
        </Flag>
      ) : null}
    </div>
  );
}

/* ── invalidate 复选框 ────────────────────────────────────────────────── */

/**
 *「写完立即重建会话」。**默认不勾** —— 保存一份配置不该顺手掐掉用户正在进行的
 * 对话,这个取舍要写在标签上让用户自己决定,而不是藏在代码默认值里。
 */
export function InvalidateCheckbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <label
      className="flex items-center gap-1.5"
      style={{ cursor: disabled ? "not-allowed" : "pointer" }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ accentColor: "var(--jade)" }}
      />
      <span className="ss-note">写完立即重建会话(会中断当前回合)</span>
    </label>
  );
}

/* ── 恢复出厂:二次确认 ────────────────────────────────────────────────── */

/**
 * 恢复出厂走**二次点击**,不用 window.confirm:后者没有样式、不能表达「备份在哪」,
 * 而且拦路拦的是整个页面。改成第一次点击进入武装态,按钮变朱红并把后果原话说出来,
 * 第二次点击才发 POST { confirm: "reset" }。
 *
 * 武装态在任何一次确认 / 取消之后立刻解除 —— 一次误点不该留下一颗等着炸的雷。
 */
export function ResetButton({
  onConfirm,
  disabled,
  busy,
}: {
  onConfirm: () => Promise<void>;
  disabled?: boolean;
  busy?: boolean;
}) {
  const [armed, setArmed] = useState(false);
  if (!armed) {
    return (
      <div className="flex items-center gap-1.5 flex-wrap">
        <button
          type="button"
          className="sansheng-button"
          disabled={disabled}
          onClick={() => setArmed(true)}
        >
          恢复出厂
        </button>
        <span className="ss-note">会丢掉你手写的内容(原文件已自动备份到 harness/backups/)</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      <button
        type="button"
        className="sansheng-button"
        disabled={busy}
        onClick={() => {
          setArmed(false);
          void onConfirm();
        }}
        style={{ borderColor: "var(--cinnabar)", color: "var(--cinnabar)" }}
      >
        {busy ? "恢复中…" : "确认恢复出厂?"}
      </button>
      <button
        type="button"
        className="sansheng-button"
        disabled={busy}
        onClick={() => setArmed(false)}
      >
        取消
      </button>
      <span className="ss-note" style={{ color: "var(--cinnabar)" }}>
        确认后会丢掉你手写的内容,原文件已自动备份到 harness/backups/
      </span>
    </div>
  );
}
