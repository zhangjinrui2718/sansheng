/**
 * `?` —— 把「这是怎么算出来的」从悬停正文收成一个可点的小标记
 *
 * ── 为什么不是 `title=`(这一层存在的全部理由)────────────────────────
 *
 * 上一版把解释放在 `hintTitle=` → 渲染成 `title=`(悬停)。三个硬伤:
 *   - **触屏不触发** —— 而这套界面的甲方有一半时间在手机上;
 *   - **不可选中、不可复制**,读不完就得重新悬停;
 *   - **屏幕阅读器行为不一致**,等于对一部分读者根本不存在。
 * 结果就是 2465 字的解释**理论上存在、实际上没人读完**。
 *
 * ── 为什么是 `<button>`,**不是** `<details>`(踩过一次)────────────────
 *
 * 第一版用原生 `<details>`(零状态)。它当场弄红了 6 条已有判据:
 * `tests/web/harness-by-role.test.ts` 与 `artifact-timeline.test.ts` 用
 * 「**第一个 `<details>` 之前**」来切「卡片头」/ 判「这一块没有默认收起」——
 * 而本组件在页头就渲染了一个 `<details>`。**那是仪器读到的真实冲突**:
 * 在这套代码里 `<details>` 的约定含义就是「**可折叠的内容**」,拿它装一个 tooltip
 * 等于借用了那个含义。所以改成 `button` + 受控浮层:语义不混,判据不用改。
 *
 * ⚠️ 内容全部来自 `lib/glossary.ts`(唯一一份)。**不许在调用点再写一遍解释** ——
 * 那样就回到了「同一句话被抄 N 遍」(`routes/Members.tsx` 里同一段 133 字曾被逐字
 * 抄两遍的现场)。`tests/web/annotation-budget.test.ts` 会盯住 `helpId` 的使用。
 */
import { useEffect, useState } from "react";
import { GLOSSARY, type GlossaryId } from "@/lib/glossary";

export function Help({ id }: { id: GlossaryId }) {
  const entry = GLOSSARY[id];
  const [open, setOpen] = useState(false);

  // Escape / 点别处收起 —— 一个说明不该在屏幕上赖着不走。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <span className="ss-help" data-glossary={id}>
      <button
        type="button"
        className="ss-help-btn"
        aria-expanded={open}
        aria-label={`这是怎么算出来的:${entry.line}`}
        title={entry.line}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open ? (
        <span className="ss-help-body" role="note">
          <span className="ss-help-line">{entry.line}</span>
          <span>
            <span className="ss-help-key">判据</span>
            {entry.basis}
          </span>
          <span>
            <span className="ss-help-key">来源</span>
            {entry.source}
          </span>
        </span>
      ) : null}
    </span>
  );
}
