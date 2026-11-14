/**
 * 提示词单元的**编辑器**(2026-11-14 从 `components/members/RoleHarness.tsx` 搬出)。
 *
 * ── 为什么搬 ─────────────────────────────────────────────────────
 *
 * 「Harness 管理」页(`routes/HarnessManage.tsx`)与成员页的「角色 harness」卡
 * 用的是**同一个写面、同一个编辑器** —— 写面规矩(保存用后端回读值、恢复出厂
 * 二次确认、失败原样显示)在 `RoleHarness.tsx` 的文件头,这里一条都不重新发明。
 * 编辑器只有这一份:两个页面各画一份的话,改一处忘另一处,写面规矩就漂了。
 *
 * 逐字搬来的东西(判据都在 `tests/web/harness-by-role.test.ts` 判据 ⑨):
 *   - `UNIT_PREVIEW_CHARS` / `unitPreview` —— 默认只画前 500 个字,边界
 *     (499 / 500 / 501)由纯函数钉住;
 *   - `PromptUnitEditor` —— 摘要行(已加载/缺失 · 字数 · 备份数 · 共用于)+
 *     预览 + 两个按钮(展开全部 / 编辑);编辑区默认不出现;
 *   - `PromptUnitEditForm` —— 纯 props 的编辑区(不取数、不持状态、不调接口),
 *     「回读值当状态」「两段式确认」「失败原样显示」三条老行为一条没变。
 */
import { useState } from "react";
import type { PromptUnitView } from "@shared/types/platform";
import { Pill, RedInline } from "@/components/ui/primitives";
import { resetPromptUnit, updatePromptUnit } from "@/lib/api";
import { failureOf, type OpState } from "@/components/harness/judgments";

/**
 * 提示词单元默认画多少个字(超过就只给前这么多,由「展开全部」补全)。
 *
 * 用户点名的数字(原话:「可以截断前 500 个字」)。**按字数**而不是按行数:
 * 旧形状的 `Clamp lines={2}` 在不同窗口宽度下截掉的内容不一样,而「截掉的是哪一截」
 * 正是用户判断要不要展开的唯一依据。
 */
export const UNIT_PREVIEW_CHARS = 500;

/**
 * 一个单元的**正文预览读数**(纯函数)。
 *
 * 判据只有一条:**默认只画前 {@link UNIT_PREVIEW_CHARS} 个字**,而且「被截掉了多少」
 * 是算出来的、不是猜的(`hidden`)。抽成纯函数是为了能在 SSR 之外直接断言 500 这个
 * 边界(499 / 500 / 501 三个样本),而不是只看一个长正文的渲染结果。
 */
export function unitPreview(content: string): {
  /** 折叠态该画的正文 */
  text: string;
  /** 是不是真的被截断了(= 该不该出现「展开全部」) */
  truncated: boolean;
  /** 没显示出来的字符数 */
  hidden: number;
} {
  if (content.length <= UNIT_PREVIEW_CHARS) return { text: content, truncated: false, hidden: 0 };
  return {
    text: content.slice(0, UNIT_PREVIEW_CHARS),
    truncated: true,
    hidden: content.length - UNIT_PREVIEW_CHARS,
  };
}

export function PromptUnitEditor({
  unit,
  value,
  backups,
  sharedWith,
  onChange,
  onApplied,
}: {
  unit: PromptUnitView;
  /** 当前草稿(父层持有,同一个 unit id 的多个角色共用一份) */
  value: string;
  /** 备份份数;undefined = 还没查到,-1 = 查不到 */
  backups: number | undefined;
  /** 声明了这个单元的**全部**角色显示名(多于一个 = 共用同一个文件) */
  sharedWith: readonly string[];
  onChange: (next: string) => void;
  /** 保存 / 恢复成功 —— 参数是后端**回读**到的正文 */
  onApplied: (content: string) => void;
}) {
  const [op, setOp] = useState<OpState>({ kind: "idle" });
  const [confirming, setConfirming] = useState(false);
  /** 「展开全部」:默认只给前 {@link UNIT_PREVIEW_CHARS} 个字 */
  const [expanded, setExpanded] = useState(false);
  /** 「编辑」:默认不给 textarea —— 一屏里不再有十几段长正文 */
  const [editing, setEditing] = useState(false);

  const edited = value !== unit.content;
  const busy = op.kind === "busy";
  /** 预览读数(纯函数,500 字边界在 `tests/web/harness-by-role.test.ts` 里钉住)。 */
  const preview = unitPreview(unit.content);

  async function save() {
    if (busy) return;
    setOp({ kind: "busy", what: "save" });
    try {
      const res = await updatePromptUnit(unit.id, value);
      // 只认响应里的 content(回读值),不认刚才发出去的那份。
      onApplied(res.content);
      setOp({
        kind: "ok",
        text:
          `已保存 · 盘上 ${res.content.length} 字符` +
          (res.backupPath !== undefined ? " · 已备份" : " · 首次创建,无旧文件可备份"),
      });
    } catch (e) {
      setOp(failureOf(e));
    }
  }

  async function doReset() {
    if (busy) return;
    setConfirming(false);
    setOp({ kind: "busy", what: "reset" });
    try {
      const res = await resetPromptUnit(unit.id);
      onApplied(res.content);
      setOp({ kind: "ok", text: `已恢复出厂 · 盘上 ${res.content.length} 字符` });
    } catch (e) {
      setOp(failureOf(e));
    }
  }

  return (
    <div className="py-1.5" style={{ borderTop: "1px solid var(--ink-3)" }}>
      {/* ── 摘要行:默认只显示这一行(以前每个单元都摊开一个 textarea)── */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* loaded=false 是最重要的一个信号:红色,不是灰色。 */}
        {unit.loaded ? (
          <Pill tone="bamboo">已加载</Pill>
        ) : (
          <Pill tone="cinnabar" title="声明了这个单元,但盘上没有对应文件 —— 这条职责从没告诉过 agent">
            缺失
          </Pill>
        )}
        <span className="ss-body" style={{ color: "var(--bone-dim)" }}>
          {unit.id}
        </span>
        {/* 共用文件:改了会影响这几个角色 —— 写在用户看得见的地方 */}
        {sharedWith.length > 1 && (
          <Pill
            tone="cyan"
            title={`这是同一个文件,被 ${sharedWith.length} 个角色声明:${sharedWith.join(" · ")}。改它会影响这几个角色。`}
          >
            共用于 {sharedWith.length} 个角色
          </Pill>
        )}
        {edited && <Pill tone="amber" title="编辑框里的内容和盘上的不一致">未保存</Pill>}
        <span className="ss-meta ml-auto" title="盘上正文的字符数(GET /api/harness 报的)">
          {unit.chars} 字符
        </span>
        <span
          className="ss-meta"
          title="历史备份份数 · 后端只留最近 10 份"
        >
          备份 {backups === undefined ? "…" : backups < 0 ? "—" : backups}
        </span>
      </div>

      {/* ── 正文预览:默认只给**前 500 个字** ────────────────────────────
          用户的原话:「提示词单元可以收起,不要展示那么长,我觉得可以截断前 500 个
          字,然后两个按钮,一个按钮展开全部,一个按钮编辑」。

          为什么按**字数**而不是按行数(旧形状是 `Clamp lines={2}`):提示词单元是
          markdown 段落,「两行」在不同窗口宽度下截掉的内容不一样 —— 而「截掉的是哪
          一截」正是用户判断要不要展开的唯一依据。按字数截断在哪都一样。
          正文按**原文**画(mono + pre-wrap):它是盘上那个 .md 的字节,
          渲染成 markdown 会把 `#` / `**` 这些「单元里到底写了什么」的痕迹抹掉。 */}
      {unit.content.length > 0 && !editing && (
        <div
          style={{
            marginTop: 2,
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            fontFamily: "monospace",
            fontSize: 11,
            lineHeight: 1.6,
            color: "var(--bone-dim)",
          }}
        >
          {expanded ? unit.content : preview.text}
          {!expanded && preview.truncated && (
            <span className="ss-meta">
              {"\n"}… 还有 {preview.hidden} 字符没显示(上面是前 {UNIT_PREVIEW_CHARS} 个)
            </span>
          )}
        </div>
      )}

      {/* ── 两个按钮:展开全部 / 编辑 ──────────────────────────────────
          ⚠️ 「展开全部」只在真被截断时出现 —— 短正文上给一个按了没反应的按钮
          是装饰,不是入口(负样本在 `tests/web/harness-by-role.test.ts`)。 */}
      <div className="flex items-center gap-2 flex-wrap" style={{ marginTop: 4 }}>
        {preview.truncated && (
          <button
            type="button"
            className="sansheng-button"
            style={{ padding: "2px 10px", fontSize: 11 }}
            title={
              expanded
                ? `收起到前 ${UNIT_PREVIEW_CHARS} 个字`
                : `展开全部 ${unit.chars} 字符`
            }
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "收起" : "展开全部"}
          </button>
        )}
        <button
          type="button"
          className="sansheng-button"
          style={{ padding: "2px 10px", fontSize: 11 }}
          title={
            editing
              ? "收起编辑区(改动会留在上面)"
              : unit.loaded
                ? "直接改正文;改完要点保存才写盘"
                : "盘上还没有这个文件;存下去即首次创建"
          }
          onClick={() => setEditing((v) => !v)}
        >
          {editing ? "收起编辑" : "编辑"}
        </button>
        {!editing && !unit.loaded && (
          <span className="ss-meta">盘上还没有这个文件 —— 点「编辑」写下它的第一条正文</span>
        )}
      </div>

      {/* 编辑区**默认不出现** —— 一屏里不再有十几段长正文。
          打开后仍是完整的老行为(回读值当状态、两段式确认、失败原样显示)。 */}
      {editing && (
        <PromptUnitEditForm
          unit={unit}
          value={value}
          busy={busy}
          confirming={confirming}
          op={op}
          edited={edited}
          onChange={onChange}
          onSave={() => void save()}
          onReset={() => void doReset()}
          onConfirmReset={() => setConfirming(true)}
          onCancelConfirm={() => setConfirming(false)}
          onDiscard={() => {
            onChange(unit.content);
            setOp({ kind: "idle" });
          }}
        />
      )}
    </div>
  );
}

/**
 * 编辑区(纯 props:不取数、不持状态、不调接口)。
 *
 * 为什么把它从 `PromptUnitEditor` 里**分出来并导出**:默认态**不该出现 textarea**,
 * 而「不该出现」这条断言在 SSR 里很容易变成空转(整块没渲染也照样通过)。
 * 分出来之后,同一个渲染路径可以被单独喂一份「编辑中」的 props ⇒ 那条负样本
 * 有一个**真会画出 textarea 的正样本**作对照(本项目对空转检查的固定处置,
 * 同 `HarnessRolePane` / `RoleHarnessDisclosure` 那一刀)。
 *
 * 异步与确认态仍在 `PromptUnitEditor` 里(`op` / `confirming` 作为 props 传进来),
 * 所以「回读值当状态」「两段式确认」「失败原样显示」三条老行为一条都没变。
 */
export function PromptUnitEditForm({
  unit,
  value,
  busy,
  confirming,
  op,
  edited,
  onChange,
  onSave,
  onReset,
  onConfirmReset,
  onCancelConfirm,
  onDiscard,
}: {
  unit: PromptUnitView;
  value: string;
  busy: boolean;
  confirming: boolean;
  op: OpState;
  /** 编辑框里的内容与盘上不一致(「未保存」pill 与「放弃改动」按钮的判据) */
  edited: boolean;
  onChange: (next: string) => void;
  onSave: () => void;
  onReset: () => void;
  onConfirmReset: () => void;
  onCancelConfirm: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5" style={{ marginTop: 6 }}>
      <div className="ss-meta font-mono truncate" title={unit.path}>
        {unit.path}
      </div>
      <textarea
        value={value}
        rows={12}
        spellCheck={false}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`${unit.id} 正文`}
        placeholder={
          unit.loaded ? undefined : "这个单元在盘上还没有文件 —— 存下去就是它的第一次创建(没有旧内容可备份)。"
        }
        style={{
          background: "var(--ink-1)",
          border: "1px solid var(--ink-3)",
          borderRadius: 6,
          padding: "6px 8px",
          fontFamily: "monospace",
          fontSize: 11,
          lineHeight: 1.6,
          color: "var(--bone)",
          outline: "none",
          resize: "vertical",
          width: "100%",
          minHeight: 160,
        }}
      />

      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          className="sansheng-button-primary"
          style={{ padding: "4px 12px", fontSize: 12 }}
          disabled={busy || !edited}
          title={edited ? "写盘(改前自动备份;保存后显示后端回读的正文)" : "内容与盘上一致,无需保存"}
          onClick={onSave}
        >
          {op.kind === "busy" && op.what === "save" ? "保存中…" : "保存"}
        </button>

        {confirming ? (
          <>
            <button
              type="button"
              className="sansheng-button"
              style={{ padding: "4px 12px", fontSize: 12, color: "var(--cinnabar)", borderColor: "var(--cinnabar)" }}
              disabled={busy}
              onClick={onReset}
            >
              {op.kind === "busy" && op.what === "reset" ? "恢复中…" : "确认恢复出厂"}
            </button>
            <button
              type="button"
              className="sansheng-button"
              style={{ padding: "4px 12px", fontSize: 12 }}
              disabled={busy}
              onClick={onCancelConfirm}
            >
              取消
            </button>
            <RedInline>会丢弃本单元的全部改动(当前内容先落一份备份)</RedInline>
          </>
        ) : (
          <button
            type="button"
            className="sansheng-button"
            style={{ padding: "4px 12px", fontSize: 12 }}
            disabled={busy}
            title="写回出厂副本 · 不是删文件(删了单元会「未装载」)"
            onClick={onConfirmReset}
          >
            恢复出厂
          </button>
        )}

        {edited && (
          <button
            type="button"
            className="sansheng-button"
            style={{ padding: "4px 12px", fontSize: 12 }}
            disabled={busy}
            onClick={onDiscard}
          >
            放弃改动
          </button>
        )}

        <span className="ss-meta ml-auto">
          单次请求,没有自动保存 —— 不点保存就不会写盘
        </span>
      </div>

      {op.kind === "ok" && (
        <span className="ss-meta" style={{ color: "var(--jade)" }}>
          {op.text}
        </span>
      )}

      {op.kind === "failed" && (
        // ⚠️ 同样的理由:这里在卡片本体的 `article` 里,不再套第二层
        // `sansheng-card`(失败提示本来就该是红色小字,不是另一张卡)。
        <RedInline>
          <div>操作失败:{op.message}</div>
          {op.validIds !== undefined && op.validIds.length > 0 && (
            <div style={{ marginTop: 4 }}>
              后端说这个 id 不认识。合法 id:{op.validIds.join(" · ")}
            </div>
          )}
        </RedInline>
      )}
    </div>
  );
}
