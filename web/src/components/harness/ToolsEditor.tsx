/**
 * Sansheng · 工具集合编辑器(批次 7-O)
 *
 * 挂在「工具集合」一节每一行后面。集合 = 权限面,所以这个面板的第一职责不是
 * 「好改」,是**不骗人**:矩阵里画出来的每一个勾,要么真能勾,要么明说勾了不生效。
 *
 * ── 上界外的工具行怎么画(本项目反造假纪律的重点)────────────────────────
 * 后端 detail.catalog 给每一行标了 inCeiling:
 *   inCeiling === false  → 复选框 **disabled** + 工具名划线 + 一句
 *     「不在该角色的架构上界内,勾了也不会生效(放开上界要改代码)」。
 * 绝不能画成一个能勾、勾了没用的假控件 —— 那是把 ROLE_CEILING 这道架构裁决
 * 悄悄降级成一句 UI 提示。
 *
 * 有一个例外必须处理:**已经在 allow 里、但被上界挡住**的条目(用户手改文件留下
 * 的,或 ROLE_CEILING 收紧后的存量)。它的复选框按上面的规则仍然是 disabled ——
 * 但那样用户就永远删不掉它了。所以这类行额外给一个「从 allow 移除」按钮:
 * 移除是**真的**写盘动作(下一条 allow 里就不含它了),不是假控件。
 *
 * ── 排序:保存时保持原顺序 ─────────────────────────────────────────────
 * 后端 commit() 用**字节相等**判 changed(normalizeNames 只去重、不排序)。
 * 如果本面板按 catalog 顺序重排 allow,用户什么都没改也会得到 changed:true。
 * 所以 allow 的输出顺序 = 原 allow 的相对顺序 + 新追加项(catalog 顺序)。
 */
import { useCallback, useState } from "react";
import { Disclosure, EmptyState, Flag, KV, Pill } from "@/components/ui/primitives";
import {
  blockedByCeilingOf,
  fetchToolEntry,
  putToolEntry,
  resetEntry,
  type ApplyOk,
  type ToolCatalogItem,
  type ToolPayload,
} from "./facetClient";
import { ApiErrorNote, ApplyResultNote, InvalidateCheckbox, ResetButton, RiskPill } from "./shared";

/**
 * 输出 allow 的顺序:先是原 allow 里仍被勾选的(保持相对顺序),再是新增项
 * (按 catalog 顺序)。这样「只加一个」和「只删一个」都不会引发无意义的 diff。
 */
function orderedAllow(
  selection: ReadonlySet<string>,
  original: readonly string[],
  catalog: readonly ToolCatalogItem[],
): string[] {
  const kept = original.filter((n) => selection.has(n));
  const keptSet = new Set(kept);
  const added = catalog.map((c) => c.name).filter((n) => selection.has(n) && !keptSet.has(n));
  return [...kept, ...added];
}

export function ToolsEditor({
  role,
  onSaved,
}: {
  role: string;
  /** 写成功后的整页刷新:GET /api/harness 重拉一次,徽章 / 划线 pill 必须变。 */
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [payload, setPayload] = useState<ToolPayload | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [invalidate, setInvalidate] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "reset">(null);
  const [result, setResult] = useState<ApplyOk | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [writeError, setWriteError] = useState<unknown>(null);

  const pull = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchToolEntry(role);
      const p = res.detail.payload;
      setPayload(p);
      setSelection(new Set(p.allow));
      setLoadError(null);
    } catch (e) {
      setPayload(null);
      setLoadError(e);
    } finally {
      setLoading(false);
    }
  }, [role]);

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false);
      setPayload(null);
      setResult(null);
      setWriteError(null);
      setLoadError(null);
      setInvalidate(false);
      return;
    }
    setOpen(true);
    void pull();
  }, [open, pull]);

  const flip = useCallback((name: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  /**
   * 保存后先摆结果,再重拉整页 + 本单元。重拉失败**不覆盖**写入结果 ——
   * 「写成功了但页面没刷新」和「写失败了」是两件事,混起来就成了撒谎。
   */
  const afterWrite = useCallback(
    async (r: ApplyOk) => {
      setResult(r);
      setWriteError(null);
      try {
        await pull();
      } catch {
        /* pull 内部已落到 loadError */
      }
      onSaved();
    },
    [pull, onSaved],
  );

  const save = useCallback(async () => {
    if (payload === null) return;
    setBusy("save");
    setWriteError(null);
    try {
      // deny **原样回传**:本 UI 不提供编辑 deny 的控件,但更不能把它吞掉 ——
      // 吞掉等于保存一次就把用户的 deny 名单清空。
      await afterWrite(
        await putToolEntry(
          role,
          orderedAllow(selection, payload.allow, payload.catalog),
          payload.deny,
          invalidate,
        ),
      );
    } catch (e) {
      setWriteError(e);
    } finally {
      setBusy(null);
    }
  }, [afterWrite, invalidate, payload, role, selection]);

  const reset = useCallback(async () => {
    setBusy("reset");
    setWriteError(null);
    try {
      await afterWrite(await resetEntry("tools", role, invalidate));
    } catch (e) {
      setWriteError(e);
    } finally {
      setBusy(null);
    }
  }, [afterWrite, invalidate, role]);

  if (!open) {
    return (
      <button
        type="button"
        className="sansheng-button"
        onClick={toggle}
        style={{ padding: "2px 8px" }}
      >
        编辑集合
      </button>
    );
  }

  return (
    <div className="sansheng-card-elevated p-3 grid gap-2" style={{ marginTop: 8 }}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="ss-meta">{role}</span>
        <button type="button" className="sansheng-button" onClick={toggle} disabled={!!busy}>
          收起
        </button>
      </div>

      {loading ? (
        <EmptyState>正在读取该角色的工具集合…</EmptyState>
      ) : loadError ? (
        <div className="grid gap-1.5">
          <ApiErrorNote error={loadError} />
          <div className="flex items-center gap-1.5">
            <button type="button" className="sansheng-button" onClick={() => void pull()}>
              重试
            </button>
          </div>
        </div>
      ) : payload === null ? (
        <EmptyState>没有可编辑的集合。</EmptyState>
      ) : (
        <>
          {/* ── 常驻事实:apply / 未接线 / deny / 真正生效的那份 ── */}
          <div className="grid gap-0.5">
            <KV label="生效时机" value={<span className="ss-note">{payload.apply}</span>} />
            {payload.enforced === false ? (
              <Flag tone="amber">
                <span className="ss-note">
                  集合已就位、未接线:该角色当前没有工具执行点(enforced=false)。
                  {payload.basis ? "依据:" + payload.basis + "。" : ""}
                  写进文件是对的,但这份名单此刻没有执行点会应用它。
                </span>
              </Flag>
            ) : null}
            {payload.deny.length > 0 ? (
              <KV
                label="deny"
                value={
                  <span className="flex items-center gap-1 flex-wrap">
                    {payload.deny.map((d) => (
                      <Pill key={d} tone="cinnabar">
                        {d}
                      </Pill>
                    ))}
                    <span className="ss-note">deny 由文件 / API 管理,本面板原样保留</span>
                  </span>
                }
              />
            ) : (
              <KV
                label="deny"
                value={<span className="ss-note">空(deny 由文件 / API 管理,本面板原样保留)</span>}
              />
            )}
            <KV
              label="真正生效"
              value={
                <span className="ss-note">
                  {payload.allowed.length > 0 ? payload.allowed.join("、") : "无"}
                </span>
              }
            />
            <KV
              label="上界"
              value={
                <span className="ss-meta">
                  {payload.ceiling.length} 项(代码内 ROLE_CEILING,集合文件突破不了)
                </span>
              }
            />
          </div>

          {/* ── 勾选矩阵 ── */}
          {payload.catalog.length === 0 ? (
            <EmptyState>
              该角色的架构上界内没有任何工具,allow / deny 也是空 —— 这里没有可勾的东西。
            </EmptyState>
          ) : (
            <div className="grid gap-0.5">
              {payload.catalog.map((c) => {
                const checked = selection.has(c.name);
                return (
                  <div
                    key={c.name}
                    className="flex items-start gap-2 py-1"
                    style={{
                      borderTop: "1px solid var(--ink-3)",
                      opacity: c.inCeiling ? 1 : 0.85,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!c.inCeiling || !!busy}
                      onChange={() => flip(c.name)}
                      title={c.summary}
                      style={{ accentColor: "var(--jade)", marginTop: 3 }}
                    />
                    <div className="min-w-0 grid gap-0.5" style={{ flex: 1 }}>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="ss-meta" style={{ minWidth: 108 }}>
                          {c.inCeiling ? c.name : <s>{c.name}</s>}
                        </span>
                        <RiskPill
                          risk={c.risk}
                          title={
                            c.summary +
                            "(" +
                            (c.origin === "sdk" ? "Pi SDK 原生工具" : "sansheng 自有工具") +
                            ")"
                          }
                        />
                        {c.inAllow ? (
                          <Pill tone="bone" title="当前 allow 集合文件里就有它">
                            已在 allow
                          </Pill>
                        ) : null}
                      </div>
                      {!c.inCeiling ? (
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="ss-note">
                            不在该角色的架构上界内,勾了也不会生效(放开上界要改代码
                            ROLE_CEILING)。
                          </span>
                          {c.inAllow ? (
                            <button
                              type="button"
                              className="sansheng-button"
                              style={{ padding: "2px 8px" }}
                              disabled={!!busy}
                              onClick={() => flip(c.name)}
                              title="把它从 allow 里去掉(下次保存写盘);这不会放开上界"
                            >
                              从 allow 移除
                            </button>
                          ) : null}
                        </div>
                      ) : (
                        <span className="ss-note">{c.summary}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className="sansheng-button sansheng-button-primary"
              onClick={() => void save()}
              disabled={!!busy}
            >
              {busy === "save" ? "保存中…" : "保存"}
            </button>
            <button type="button" className="sansheng-button" onClick={toggle} disabled={!!busy}>
              取消
            </button>
            <InvalidateCheckbox checked={invalidate} onChange={setInvalidate} disabled={!!busy} />
          </div>

          <ResetButton onConfirm={reset} busy={busy === "reset"} disabled={!!busy} />

          <Disclosure summary="对比出厂集合">
            <span className="ss-meta">
              出厂 allow {payload.factory.allow.length} 项 · deny {payload.factory.deny.length} 项。
              恢复出厂会把它写回去(含 deny),当前手笔会被备份后丢弃。
            </span>
          </Disclosure>

          {writeError ? <ApiErrorNote error={writeError} /> : null}
          {result ? <ApplyResultNote result={result} blockedByCeiling={blockedByCeilingOf(result.entry)} /> : null}
        </>
      )}
    </div>
  );
}
