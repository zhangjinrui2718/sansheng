/**
 * Sansheng · 提示词单元编辑器(批次 7-O)
 *
 * 挂在每张手册卡下面。点「编辑手册」才 GET 详情 —— 七个角色 × 十一个单元的全文
 * 动辄几十 KB,进总表毫无意义(后端也是这么设计的:总表只给摘要)。
 *
 * ── 面板上常驻的三行事实(缺一条就是在骗人)──────────────────────────────
 *   ① 生效时机 = payload.apply,**原样显示**。那是系统事实(src/server/harness/
 *      promptUnits.ts 的注册表),不是 UI 编的一句「保存即生效」。
 *   ② 风险提示:payload.sensitivity === "contract" 时必须说清「这份提示词本身
 *      就是输出协议」—— planner / executor / decide / align / worker_ask 改坏
 *      的后果不是「措辞变差」,是模型交回来的 JSON 不再能被解析。
 *   ③ payload.enforced === false:明写「零消费方,改了不会有任何效果」。orphan
 *      单元照样能写(它是一份合法的用户手笔),但绝不能让人以为改了会生效。
 *
 * ── 为什么「恢复出厂」不是保存的一种取值 ────────────────────────────────
 * 后端把它拆成独立的 POST + { confirm: "reset" }:丢用户手笔的动作不该被一个
 * 误触触发。本组件用二次点击(ResetButton)兑现这一层,后端的白名单是最后一道。
 */
import { useCallback, useState } from "react";
import { Disclosure, EmptyState, Flag, KV, Pill } from "@/components/ui/primitives";
import {
  FacetApiError,
  fetchPromptEntry,
  putPromptEntry,
  resetEntry,
  stateOf,
  type ApplyOk,
  type PromptPayload,
} from "./facetClient";
import { ApiErrorNote, ApplyResultNote, InvalidateCheckbox, ResetButton } from "./shared";

/** 与 src/server/harness/apply.ts 的 MAX_PROMPT_CHARS 同值(128 KiB)。 */
const MAX_PROMPT_CHARS = 128 * 1024;

/**
 * 单元状态的中文标签。**故意不复用 Harness.tsx 里的 STATE_LABEL** ——
 * 那个 map 属于只读视图那一层,往回 import 会让两个模块互相咬住(手册卡要 import
 * 本组件)。5 个值的重复比一个循环依赖便宜,而且改状态机时两处都会搜到。
 */
const STATE_LABEL: Record<string, string> = {
  default: "默认",
  legacy_factory: "旧出厂版",
  user_edited: "用户编辑过",
  empty: "空",
  orphan: "无消费方",
};

export function PromptEditor({
  unitId,
  onSaved,
}: {
  unitId: string;
  /** 写成功后的整页刷新:GET /api/harness 重拉一次,状态 pill 必须变成新状态。 */
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState<PromptPayload | null>(null);
  const [text, setText] = useState("");
  const [invalidate, setInvalidate] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "reset">(null);
  const [result, setResult] = useState<ApplyOk | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [writeError, setWriteError] = useState<unknown>(null);

  const pull = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchPromptEntry(unitId);
      setPayload(res.detail.payload);
      setText(res.detail.payload.content);
      setLoadError(null);
    } catch (e) {
      setPayload(null);
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }, [unitId]);

  const toggle = useCallback(() => {
    if (open) {
      // 收起时把编辑态清空:下次点开一定拉一次真盘内容,不留上一轮的草稿。
      setOpen(false);
      setPayload(null);
      setText("");
      setResult(null);
      setWriteError(null);
      setLoadError(null);
      setInvalidate(false);
      return;
    }
    setOpen(true);
    void pull();
  }, [open, pull]);

  /**
   * 写完之后做两件事,顺序不能反:
   *   1. 先把结果摆上屏(用户点保存,要立刻看到写了什么);
   *   2. 再重拉整页 + 重拉本单元 —— 写后 entry 是后端现算的快照,本地那份
   *      textarea 里的内容此刻已经过期。
   * 重拉失败**不覆盖**写入结果:「写成功了但页面没刷新」和「写失败了」是两件事。
   */
  const afterWrite = useCallback(
    async (r: ApplyOk) => {
      setResult(r);
      setWriteError(null);
      try {
        await pull();
      } catch {
        /* pull 内部已经落到 loadError,不覆盖写入结果 */
      }
      onSaved();
    },
    [pull, onSaved],
  );

  const save = useCallback(async () => {
    setBusy("save");
    setWriteError(null);
    try {
      await afterWrite(await putPromptEntry(unitId, text, invalidate));
    } catch (e) {
      setWriteError(e);
    } finally {
      setBusy(null);
    }
  }, [afterWrite, invalidate, text, unitId]);

  const reset = useCallback(async () => {
    setBusy("reset");
    setWriteError(null);
    try {
      await afterWrite(await resetEntry("prompts", unitId, invalidate));
    } catch (e) {
      setWriteError(e);
    } finally {
      setBusy(null);
    }
  }, [afterWrite, invalidate, unitId]);

  if (!open) {
    return (
      <div className="mt-2">
        <button type="button" className="sansheng-button" onClick={toggle}>
          编辑手册
        </button>
      </div>
    );
  }

  const over = text.length > MAX_PROMPT_CHARS;
  const dirty = payload !== null && text !== payload.content;

  return (
    <div className="sansheng-card p-3 grid gap-2" style={{ marginTop: 8 }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="ss-meta">
          {unitId} · {payload?.owner ?? "…"}
          {payload ? <Pill tone="bone">{STATE_LABEL[payload.state] ?? payload.state}</Pill> : null}
        </span>
        <button type="button" className="sansheng-button" onClick={toggle} disabled={!!busy}>
          收起
        </button>
      </div>

      {loading ? (
        <EmptyState>正在读取磁盘上的当前内容…</EmptyState>
      ) : loadError ? (
        <div className="grid gap-1.5">
          <ApiErrorNote error={loadError} />
          <div className="flex items-center gap-1.5">
            <button type="button" className="sansheng-button" onClick={() => void pull()}>
              重试
            </button>
            {loadError instanceof FacetApiError && loadError.status === 404 ? (
              <span className="ss-note">该单元不在后端注册表里(可能 server 版本旧于这页)。</span>
            ) : null}
          </div>
        </div>
      ) : payload === null ? (
        <EmptyState>没有可编辑的内容。</EmptyState>
      ) : (
        <>
          {/* ── 常驻事实三行 ── */}
          <div className="grid gap-0.5">
            <KV label="生效时机" value={<span className="ss-note">{payload.apply}</span>} />
            {payload.sensitivity === "contract" ? (
              <Flag tone="amber">
                <span className="ss-note">
                  这份提示词本身是输出协议的一部分(不是文案):改坏它,模型交回来的结果会直接
                  无法被系统解析,失败点出现在下游而不是这里。
                </span>
              </Flag>
            ) : null}
            {payload.enforced === false ? (
              <Flag tone="amber">
                <span className="ss-note">
                  零消费方,改了不会有任何效果。
                  {payload.orphanReason ? "原因:" + payload.orphanReason : ""}
                </span>
              </Flag>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap ss-meta">
            <span>消费点:{payload.consumer}</span>
            <span style={{ color: over ? "var(--cinnabar)" : "var(--bone-dim)" }}>
              {text.length} 字符 / 上限 {MAX_PROMPT_CHARS}
              {dirty ? " · 未保存" : ""}
            </span>
          </div>
          {over ? (
            <Flag tone="cinnabar">
              <span className="ss-note">
                已超过后端上限,提交会被 400 拒收(不做静默截断 —— 截出来的提示词语法完整、
                语义残缺)。先把内容删短。
              </span>
            </Flag>
          ) : null}

          <textarea
            className="sansheng-input sansheng-input-block"
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            disabled={!!busy}
            rows={16}
            style={{ fontFamily: "ui-monospace, monospace", fontSize: 12, lineHeight: "18px" }}
          />

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className="sansheng-button sansheng-button-primary"
              onClick={() => void save()}
              disabled={!!busy}
            >
              {busy === "save" ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              className="sansheng-button"
              onClick={toggle}
              disabled={!!busy}
            >
              取消
            </button>
            <InvalidateCheckbox
              checked={invalidate}
              onChange={setInvalidate}
              disabled={!!busy}
            />
          </div>

          <ResetButton onConfirm={reset} busy={busy === "reset"} disabled={!!busy} />

          <Disclosure summary="对比出厂默认">
            <div className="grid gap-1">
              <span className="ss-meta">
                当前出厂 {payload.factory.length} 字符 · 与当前内容
                {payload.factory === text ? "一致" : "不同"}。
              </span>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  maxHeight: 220,
                  overflow: "auto",
                  margin: 0,
                }}
              >
                {payload.factory}
              </pre>
            </div>
          </Disclosure>

          {writeError ? <ApiErrorNote error={writeError} /> : null}
          {result ? (
            <div className="grid gap-1">
              <ApplyResultNote result={result} />
              {stateOf(result.entry) ? (
                <span className="ss-meta">
                  写后状态:
                  {STATE_LABEL[stateOf(result.entry) ?? ""] ?? stateOf(result.entry)}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
