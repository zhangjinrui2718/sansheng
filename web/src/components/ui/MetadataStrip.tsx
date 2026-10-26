/**
 * 身份条 —— 一行「标签 + 值」,值可以是**另一批实体的地址**
 *
 * ── 为什么不是一个组件、而是「一个组件 + 一份数据」 ────────────────
 *
 * 组件只负责**排版**;「这个实体是哪些事实」在 `lib/entityMeta.ts`。
 * 拆开的理由是可测:判据是「同一个工件在两个地方给出同一组事实」,
 * 而这条判据**测数据**比测渲染便宜得多,也可靠得多
 * (渲染要 DOM、要 jsdom、要样式表;数据只要比对两个数组)。
 *
 * ⚠️ **值里不许放「要展开才看得懂」的东西** —— 身份条是扫一眼用的。
 * 需要展开的进 `Disclosure`。
 *
 * ⚠️ **链接是真 `<a href>`**,不是 `onClick`:
 *   · 右键「复制链接地址」能给出**这一格的地址**;
 *   · 中键 / Cmd+点击能开新标签(而不是把当前页换掉);
 *   · 浏览器「后退」能退回去 —— 这在 hash 路由下是白送的。
 * 用 `onClick` 改 hash 的话,上面三件全部做不到,而它们正是
 * 「地址是唯一真相」这个决定的意义所在。
 */
import type { ReactNode } from "react";
import type { MetaItem } from "@/lib/entityMeta";
import { toHash } from "@/lib/route";
import type { AppLocation } from "@/lib/route";
import { Pill, toneColor } from "./primitives";

function MetaCell({ item }: { item: MetaItem }) {
  if (item.links !== undefined && item.links.length > 0) {
    return (
      <span className="flex items-baseline gap-1.5 min-w-0">
        <span className="ss-meta flex-none">{item.label}</span>
        <span className="flex items-baseline gap-1.5 min-w-0 flex-wrap">
          {item.links.map((l) => (
            <a key={l.to.route + JSON.stringify(l.to.params)} className="ss-link truncate" href={toHash(l.to)}>
              {l.label}
            </a>
          ))}
        </span>
      </span>
    );
  }
  if (item.pill === true) {
    return (
      <span className="flex items-baseline gap-1.5 min-w-0">
        <span className="ss-meta flex-none">{item.label}</span>
        <Pill tone={item.tone}>{item.value}</Pill>
      </span>
    );
  }
  return (
    <span className="flex items-baseline gap-1.5 min-w-0">
      <span className="ss-meta flex-none">{item.label}</span>
      <span className="truncate" style={{ color: toneColor(item.tone) }} title={item.title}>
        {item.value}
      </span>
    </span>
  );
}

export function MetadataStrip({
  items,
  className,
}: {
  items: readonly MetaItem[];
  className?: string;
}) {
  if (items.length === 0) return null;
  return (
    <div className={`flex items-baseline gap-x-3 gap-y-1 flex-wrap ${className ?? ""}`}>
      {items.map((it) => (
        <span key={it.label} title={it.title}>
          <MetaCell item={it} />
        </span>
      ))}
    </div>
  );
}

/**
 * 一格**可点的身份** —— 单独抽出来给「卡片标题」用。
 *
 * ⚠️ 它**不自己**改 hash:真 `<a href>` 让浏览器去改,
 * `lib/route.ts` 的 `useAppLocation` 监听 `hashchange` 接手 ——
 * 于是「后退键」与「分享链接」是同一套机制的两个好处,不是两套代码。
 */
export function EntityLink({
  to,
  children,
  title,
  className,
}: {
  to: AppLocation;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <a className={`ss-link ${className ?? ""}`} href={toHash(to)} title={title}>
      {children}
    </a>
  );
}
