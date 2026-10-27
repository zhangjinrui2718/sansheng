/**
 * `EntityInspector` —— 实体抽屉(右侧)。
 *
 * ── 它是什么 ──────────────────────────────────────────────────────
 *
 * 三段:**事实 / 关系 / 内容**。
 * 「系统性关联」的**可见形态**:一个实体在抽屉里待着,你从它的关系项点到邻居,
 * 抽屉**换内容但一直在场** —— 而内联展开会把人推走(页面滚到别处,
 * 图被顶出屏幕),于是「关联」这件事只存在于**看得见的关联**里。
 *
 * ── 它不许做的事(三条) ──────────────────────────────────────────
 *
 * 1. **不许自己决定事实** —— 事实条由调用点给(`items`),
 *    而**那些 items 必须来自 `lib/entityMeta.ts` 的构造器**
 *    (`artifactMeta` / `workMeta` / `blockerMeta`)。
 *    ⚠️ 这条是本组件存在的**理由**:抽屉是新的渲染面,
 *    而「同一实体全站只有一种渲染方式」是这一整层的硬前提 ——
 *    两处各渲染一遍,关联必然丢(你在 A 处点中它,B 处不知道)。
 *    ⇒ 哨兵在 `tests/web/entity-inspector.test.ts`(源码级:
 *    抽屉文件里不许出现 `fmtTime(` / `artifactKindLabel(` 这类格式化调用)。
 *
 * 2. **不许自己算关系** —— 关系栏是 `components/relations/RelationsRail.tsx`,
 *    判据在 `lib/relations.ts`。抽屉只是把它摆进来。
 *
 * 3. **不许变成第二个地址来源** —— 关系项与事实条里的链接都由
 *    `lib/entityMeta.ts` / `lib/relations.ts` 给地址。
 *
 * ── 为什么是「抽屉」而不是内联展开 ────────────────────────────────
 *
 * 2026-10-26 的裁决(设计 §7 第 2 条):抽屉省滚动,而且**切换实体时保持在场** ——
 * 「关联」要求它在切换时还在。内联展开会把图顶出屏幕,
 * 于是读者在「看图」与「看详情」之间来回滚,关联就断了。
 */
import { useEffect, type ReactNode } from "react";
import { MetadataStrip } from "@/components/ui/MetadataStrip";
import type { MetaItem } from "@/lib/entityMeta";
import { RelationsRail } from "@/components/relations/RelationsRail";
import type { RelationContext, RelationSubject } from "@/lib/relations";

export interface EntityInspectorProps {
  /** 实体名(抽屉头的标题)。 */
  title: string;
  /**
   * 事实条 —— **必须**来自 `lib/entityMeta.ts` 的构造器。
   * ⚠️ 空数组 = 「这一类实体没有事实条」(不是「事实是空的」)。
   */
  items: readonly MetaItem[];
  /** 关系的主体(带实体本身)。`null` = **这一段整段不出现**(不是「没有关系」)。 */
  subject: RelationSubject | null;
  /** 算关系需要的别的实体。 */
  context: RelationContext;
  /** 关掉抽屉(点关闭按钮 / 点遮罩 / 按 ESC 都走它)。 */
  onClose: () => void;
  /** 实体自己的内容(正文、原始字段…)。 */
  children?: ReactNode;
}

export function EntityInspector({
  title,
  items,
  subject,
  context,
  onClose,
  children,
}: EntityInspectorProps) {
  /**
   * ⚠️ **ESC 关抽屉** —— 键盘用户没有「点遮罩」这条路。
   * 监听挂在 window 上、只在这一只抽屉活着的时候挂
   * (组件卸载即撤)—— 不留一个「按 ESC 会报错的全局监听」。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="ss-inspector-overlay"
      role="presentation"
      // ⚠️ 点遮罩关抽屉;点在面板里**不许**关(否则读一半就被关了)。
      onClick={onClose}
    >
      <aside
        className="ss-inspector"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="ss-inspector-head">
          <span className="ss-title truncate">{title}</span>
          <button type="button" className="sansheng-button" aria-label="关闭" onClick={onClose}>
            关闭
          </button>
        </header>

        {items.length > 0 && (
          <section className="ss-inspector-section">
            <div className="ss-section">事实</div>
            <MetadataStrip items={items} />
          </section>
        )}

        {subject !== null && (
          <section className="ss-inspector-section">
            <div className="ss-section">关系</div>
            <RelationsRail subject={subject} context={context} />
          </section>
        )}

        {children !== undefined && (
          <section className="ss-inspector-section">{children}</section>
        )}
      </aside>
    </div>
  );
}
