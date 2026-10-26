/**
 * `RelationsRail` —— 「一圈邻居」的那一条
 *
 * ── 它是什么 ──────────────────────────────────────────────────────
 *
 * 一条窄窄的带子,列出**当前这个东西连着什么**:相关工件 / 子项 / 前置 / 阻塞 /
 * 负责的环节。每一项都是**一个可点的地址** —— 从一份工件一步走到产出它的环节,
 * 从一个成员一步走到他手上的活。
 *
 * 改版前,「它连着什么」散在三处、且**没有一处能点**:
 * 工件卡片印的是 `parent→art_x` 这样的**原始 id 与英文关系词**,
 * 工件详情那一节标题能读懂但不是链接,工作项的「前置」是纯文本,
 * 成员面板则根本没有这一面。
 *
 * ── 三条判据 ──────────────────────────────────────────────────────
 *
 * 1. **关系只有一个家** —— 判据在 `lib/relations.ts`(`relationsOf`),
 *    这里只负责把它**排版**。同一件东西在卡片上、详情里、面板里说的话
 *    **必须逐字相同** —— 不许某处自己写一遍。
 * 2. **「读不到」与「没有」分开** —— 上下文里没加载的那份数据 ⇒ 那一组显示
 *    「读不到」,**不显示成「没有」**。一次读失败被说成事实,是这套界面反复吃过的亏。
 *    还在拉的那一组显示「加载中…」—— **也不许先说「没有」**。
 * 3. **链接是真 `<a href>`** —— 右键复制地址 / 中键开新标签 / 浏览器后退三件全靠它。
 *
 * ⚠️ **`compact` 模式下「读不到」那几组不渲染** —— 卡片是**摘要**,
 *   摘要说「没有」是撒谎,但摘要什么都不说不是(细节在详情里)。
 *   ⇒ 摘要只说**已经算出来的东西**;详情把「哪些没算出来」也说出来。
 */
import { toHash } from "@/lib/route";
import type { AppLocation } from "@/lib/route";
import { relationsOf } from "@/lib/relations";
import type { RelationContext, RelationItem, RelationSubject } from "@/lib/relations";

export interface RelationsRailProps {
  subject: RelationSubject;
  context: RelationContext;
  /** 标题(默认「关系」)。 */
  title?: string;
  /**
   * 紧凑模式(用在卡片上):只渲染**算出来**的组,`ready` 且 0 条的组不出现,
   * `unavailable` 的组也不出现。
   */
  compact?: boolean;
  /**
   * 只要这几组(默认全要)。
   *
   * ⚠️ 存在的理由:卡片上只该说「相关工件」,而**详情里**才说「它所属环节的阻塞」——
   * 同一张卡片上塞两组,读者要分辨哪组是重点。
   */
  groups?: readonly string[];
}

const itemKey = (it: RelationItem, i: number): string =>
  `${it.rel}|${it.label}|${it.to ? toHash(it.to) : ""}|${i}`;

export function RelationsRail({
  subject,
  context,
  title = "关系",
  compact = false,
  groups,
}: RelationsRailProps) {
  const all = relationsOf(subject, context);
  const picked = groups === undefined ? all : all.filter((g) => groups.includes(g.key));
  const visible = compact
    ? picked.filter((g) => g.state === "ready" && g.items.length > 0)
    : picked;
  if (visible.length === 0) return null;

  return (
    <div className="ss-relations" data-relations-for={subject.kind}>
      <div className="ss-relations-title">{title}</div>
      {visible.map((g) => (
        <div
          key={g.key}
          className="ss-relations-group"
          data-relation-group={g.key}
          data-relation-state={g.state}
        >
          <span className="ss-meta">{g.title}</span>
          {g.state === "unavailable" ? (
            <span className="ss-meta" style={{ marginLeft: 6 }}>
              读不到
            </span>
          ) : g.state === "loading" ? (
            <span className="ss-meta" style={{ marginLeft: 6 }}>
              加载中…
            </span>
          ) : g.items.length === 0 ? (
            // ⚠️ 算出来了、真的没有 —— 这是**事实**,与「读不到」必须长得不一样。
            <span className="ss-meta" style={{ marginLeft: 6 }}>
              无
            </span>
          ) : (
            <div className="ss-relations-items">
              {g.items.map((it, i) =>
                it.to === null ? (
                  <span key={itemKey(it, i)} className="ss-meta" title={it.title}>
                    {it.rel === "" ? it.label : `${it.rel}·${it.label}`}
                  </span>
                ) : (
                  <a
                    key={itemKey(it, i)}
                    className="ss-link ss-relations-item"
                    href={toHash(it.to)}
                    title={it.title}
                    data-relation-to={toHash(it.to)}
                  >
                    {it.rel === "" ? it.label : `${it.rel}·${it.label}`}
                  </a>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 一条关系的地址(给别处做链接用)。 */
export function relationAddress(it: RelationItem): AppLocation | null {
  return it.to;
}
