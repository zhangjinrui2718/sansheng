/**
 * `DashboardCards` —— 项目页的**仪表盘**
 *
 * ── 它是什么 ──────────────────────────────────────────────────────
 *
 * 一排**能点的计数卡** + 一张「**现在最要紧的一件事**」卡。
 *
 * 改版前的项目页是**一叠清单**:工作项、提问、变更、阻塞各一段,每段一份,
 * 读者要自己在四段里比出「哪件最要紧」;而「工作项」那一段又与工作项页
 * **各渲染一遍同一个实体** —— 两处各渲染一遍的地方,**关联必然丢**。
 *
 * ⇒ 现在:工作项**只住在工作项页**(那边有图、有依赖、有推进);
 * 这一页只留**计数**与**一条要紧的事**,并且**每一张卡都是一个地址**。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────
 *
 * 1. **数字不许自己数** —— 一律读 `detail.counts`(服务端算好的真值)。
 *    自己数一遍会与左栏的徽标漂开,而「两个地方显示不同的数字」是最难查的一类病。
 * 2. **链接是真 `<a href>`** —— 右键复制地址 / 中键开新标签 / 浏览器后退三件全靠它。
 * 3. **「最要紧」是排序不是评价** —— 判据在 `lib/dashboard.ts`,
 *    全部来自库里读到的状态,一条也不来自模型。
 */
import { toHash } from "@/lib/route";
import type { AppLocation } from "@/lib/route";
import type { CountCard, NextThing } from "@/lib/dashboard";

export function DashboardCards({
  cards,
  next,
}: {
  cards: readonly CountCard[];
  next: NextThing;
}) {
  return (
    <div className="ss-dashboard">
      <div className="ss-dashboard-cards">
        {cards.map((c) => (
          <CountCardView key={c.key} card={c} />
        ))}
      </div>
      <NextThingView next={next} />
    </div>
  );
}

function CountCardView({ card }: { card: CountCard }) {
  const body = (
    <>
      <span className="ss-dashboard-card-value">{card.value === null ? "读不到" : card.value}</span>
      <span className="ss-dashboard-card-label">{card.label}</span>
    </>
  );
  if (card.to === null) {
    return (
      <span className="ss-dashboard-card" title={card.title}>
        {body}
      </span>
    );
  }
  return (
    <a className="ss-dashboard-card" href={toHash(card.to)} title={card.title}>
      {body}
    </a>
  );
}

function NextThingView({ next }: { next: NextThing }) {
  return (
    <div className="ss-dashboard-next" data-next-key={next.key}>
      <span className="ss-dashboard-next-label">现在最要紧的一件事</span>
      <span className="ss-dashboard-next-title">{next.label}</span>
      {/*
        ⚠️ **判据与「要不要你动作」都印出来** —— 一句话的判断如果不带理由,
        读者只能信不信;而「读不到运行态」那一档尤其需要说清**为什么不能断言没事**。
      */}
      <span className="ss-meta">{next.why}</span>
      <span className="ss-meta">{next.action}</span>
      {next.to !== null && (
        <a className="ss-link" href={toHash(next.to)}>
          过去看一眼 →
        </a>
      )}
    </div>
  );
}

/** 一张卡片的地址(给别处做链接用)。 */
export function cardAddress(card: CountCard): AppLocation | null {
  return card.to;
}
