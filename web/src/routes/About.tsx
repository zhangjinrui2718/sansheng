/**
 * 「关于」—— 这块界面的**说明书本身**
 *
 * ── 它为什么存在(以及为什么不是又一处注释)───────────────────────────
 *
 * 2026-10-26 用户原话:「去除掉现在页面上面过多的注释」。第一刀把 27 处悬停解释
 * 收进 `lib/glossary.ts`(每条一行话 + 判据落点 + 出处),于是**页面上看不见解释了**
 * —— 但解释不能凭空消失,它得有一个「想查的时候查得到」的地方。这一页就是那个地方。
 *
 * 判据上的差别很重要:**这不是把注释放到另一个页面**,而是把「每页 15–20 条散文」
 * 换成「三张可穷举的表」。区别在能不能穷举:
 *   - 散文注解:读者不知道有没有第 21 条,只能一条条读;
 *   - 这一页:`GLOSSARY` 的键是**闭合联合**(`GlossaryId`),`KNOWN_GAPS` 是一个数组
 *     —— 有几条、缺什么,在这里是数得出来的。
 *
 * ── 三段,各答一个问题 ─────────────────────────────────────────────
 *
 *   ① 四态:这个数字**到底是什么意思**(没拿到 / 拿失败 / 读不到 / 拿到了);
 *   ② 词汇表:`?` 点开的那 18 条全文(一条不落,与页面上是同一份数据);
 *   ③ 已知不实之处:这块界面现在**说不到**什么 —— 缺口写成清单,不留给读者猜。
 *
 * ⚠️ **不许在这里再写第三份解释文案**。①的正文在 `ui/DataState.tsx` 的文件头,
 * ②的数据是 `lib/glossary.ts`,③的数据是 `KNOWN_GAPS`。这一页只做**渲染**。
 */
import { PageHeader, Section } from "@/components/ui/primitives";
import { GLOSSARY, KNOWN_GAPS, type GlossaryId } from "@/lib/glossary";
import { excerpt } from "@/lib/vocab";

/**
 * 四态 —— **顺序就是判据**:先「拿到了吗」,再「为什么没拿到」。
 * ⚠️ 四态不许合一(`AGENTS.md` 的红线):合并任意两支都会造出一句自信的假话。
 */
const STATE_ROWS: ReadonlyArray<{ kind: string; mean: string; wrong: string }> = [
  {
    kind: "还没查过",
    mean: "请求还在路上。界面上写「加载中…」,不给任何结论。",
    wrong: "写成「没有」⇒ 一次慢请求被读成「这件事真的不存在」。",
  },
  {
    kind: "读失败",
    mean: "请求回了错。界面上把**错误原文**印出来,不吞。",
    wrong: "静默落进空态 ⇒ 现场消失,事后查不出当时发生了什么(7-N)。",
  },
  {
    kind: "查完了但读不到",
    mean: "后端说 `runtime: \"unavailable\"`。意思是「我读不到」,不是「没有」。",
    wrong: "渲染成「空闲」/「0 条」⇒ 把「不知道」说成「知道」(同 `ProjectLiveView`)。",
  },
  {
    kind: "拿到了",
    mean: "有数据。空数组这时才是真的「没有」。",
    wrong: "拿「现在」冒充窗口 —— 合计数字没有窗口时看起来永远是对的。",
  },
];

const GLOSSARY_IDS = Object.keys(GLOSSARY) as GlossaryId[];

export function AboutPage() {
  return (
    <div className="ss-page">
      <PageHeader
        title="关于"
        hint="这页是这块界面的说明书,不是设置"
      />

      <Section title="四态:这个数字到底什么意思">
        <div className="flex flex-col gap-2">
          {STATE_ROWS.map((r) => (
            <div key={r.kind} className="flex flex-col gap-0.5">
              <div className="ss-body" style={{ color: "var(--bone)" }}>
                {r.kind}
              </div>
              <div className="ss-note">{r.mean}</div>
              <div className="ss-meta" style={{ color: "var(--ochre)" }}>
                写错的代价:{r.wrong}
              </div>
            </div>
          ))}
          <div className="ss-meta">
            判据在 <span className="font-mono">web/src/components/ui/DataState.tsx</span>
            —— 四态是一个判别联合,没拿到数据就拿不到那个渲染参数。
          </div>
        </div>
      </Section>

      <Section title="词汇表" count={GLOSSARY_IDS.length}>
        <div className="flex flex-col gap-2">
          {GLOSSARY_IDS.map((id) => (
            <div key={id} className="flex flex-col gap-0.5">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="ss-body" style={{ color: "var(--bone)" }}>
                  {GLOSSARY[id].line}
                </span>
                <span className="ss-meta font-mono">{id}</span>
              </div>
              <div className="ss-note">判据:{GLOSSARY[id].basis}</div>
              <div className="ss-meta">出处:{excerpt(GLOSSARY[id].source, 120)}</div>
            </div>
          ))}
        </div>
      </Section>

      <Section title="已知不实之处" count={KNOWN_GAPS.length}>
        <div className="flex flex-col gap-2">
          <div className="ss-note">
            下面是这块界面**现在说不到**的地方。它们不是待办清单,是「读到这里别以为你知道了」。
          </div>
          {KNOWN_GAPS.map((g) => (
            <div key={g.what} className="flex flex-col gap-0.5">
              <div className="ss-body" style={{ color: "var(--ochre)" }}>
                {g.what}
              </div>
              <div className="ss-note">{g.why}</div>
              <div className="ss-meta font-mono">{g.where}</div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
