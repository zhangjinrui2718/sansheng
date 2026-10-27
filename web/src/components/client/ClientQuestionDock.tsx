/**
 * 待答面板 —— 原「待办」页的新落点(对话页右栏,「本项目」下方)
 *
 * ── 为什么它不再是第四个 tab(2026-10-06)───────────────────────────
 *
 * 它是**唯一需要甲方动手的数据**(等甲方拍板的问题),而甲方 90% 的时间在「对话」页。
 * 原来的形态是顶栏第 4 个页签:提问发生了、页签上**没有任何计数**,切过去之前
 * 用户完全不知道有事在等他 —— 于是它长期显示「没有等你回答的问题」,而那与
 * 「业务经理刚问过、只是没人告诉你」在屏幕上长得一模一样。
 *
 * 真机上这件事发生过:第一条 `client_question` 落库(2026-10-06 08:59「W1 数据源
 * 组合,您倾向哪种?」)时,页签还是那个不带计数的页签。
 *
 * ⇒ 所以它现在**常驻在右栏**,与「本项目」并列(**用户裁决**:「放到『本项目』下方
 * 并列的位置,**不要**做点击收起这种方式」)。它与右栏那一块读的是同一件事的
 * 两个面:上面那块答「本项目现在怎么样」,这一块答「本项目有什么在等我」。
 *
 * ⚠️ **常驻是有代价的,所以它不能占满右栏**:右栏高度有限,「本项目」要能滚。
 * 两块的配比写死在 `App.tsx` 的那层 `flex` 上 —— 上面 `flex-1`,这一块 `flex-none`
 * 且 `maxHeight` 封顶、内部自己滚。**不做折叠**是因为它平时就是空的(绝大多数时候
 * 0 件),折叠按钮会变成一个永远点得着却永远没用的控件。
 *
 * ── 承载的东西一个字都没重写 ─────────────────────────────────────
 *
 * 卡片是**同一个** `ClientQuestionCard`(原先被「待办」页与「项目」页共用,
 * 现在是第三次复用),答案仍走 `POST /api/client-questions/:id/answer` 落
 * `decision` 工件。**工件那一侧一个字都没动** —— `client_question` 工件同时是
 * 「提问者进入 blocked」的判据、`awaitingClient` 抑制条件的数据源、以及
 * `answers` 审计边的一端(见 `src/platform/tools/client.ts:19` 与
 * `src/platform/runtime/dispatcher.ts:1270`)。本页换的是**入口**,不是**记录**。
 *
 * ── 为什么不是「插进消息流里的一张卡」 ────────────────────────────
 *
 * 提问是**状态**(open → accepted),不是消息。插进消息流意味着答完之后要从
 * 历史里**删掉一条已经发生过的话** —— 而历史消息不该被追溯删除。放在面板里就
 * 自然:答完即从这一块消失、刷新还在、不会因为滚动位置找不到。
 *
 * ── 按项目显示:切到哪个项目,才看到哪个项目的提问(2026-10-12)─
 *
 * 这一块原先是**全局**的(`GET /api/client-questions` 跨所有项目):别的项目那条上
 * 面带一行暗色项目名,当前项目的不标。**用户裁决改成按项目显示**,与「待你验收」同一口径
 * —— 两块都在右栏、都答「本项目有什么在等我」,一块按项目一块不按,读起来是自相矛盾
 * 的:上面「本项目一切正常」,下面挂着别的项目的提问等它回答。
 *
 * ⚠️ **代价是明摆着的**:别的项目的提问在这里看不见了。不藏的补偿是**左栏** ——
 * `HistoryRail` 那个项目节点上带 `counts.pendingQuestions`,「待你回答 N 个问题」按项目
 * 标在项目名下(HistoryRail.tsx:125),所以「别处有 N 件」仍然看得见、知道去哪儿点。
 *
 * ⚠️ **随之而来的一个真问题**:已收口项目那几件原来报的是**全局**计数,按项目显示之后
 * 它会把别的项目的条数报在当前项目名下。后端因此补了 `closedProjectQuestions`
 * (带项目坐标),计数从那一份里按项目数出来 —— 见下面那一节。
 *
 * ── ⚠️ **已收口项目的提问不在这个队列里,而且必须说出来**(2026-10-07)─
 *
 * 「待答」承诺的是「你答了会有人处理」。**已收口项目的提问兑现不了**:排空器排的是
 * `listProjects(db, "active")`,终态项目永远不进排空 ⇒ 那些提问永远没人被叫醒。
 * 真机现场:项目 00:27 收口,业务经理在 09:03/09:13 又提了 3 个问题(收口后
 * `client.*` 仍可用 —— 「豁免的是说话,不是改」),三条就一直挂在「待答」里,
 * 而用户点「回答」只会多落一条 `decision`,**没有任何人会被叫醒**。
 *
 * 所以后端把它们排除,并**把条数一起返回**(`fromClosedProjects` + 带项目坐标的
 * `closedProjectQuestions`)。这里**必须显示**:悄悄少三条会让用户以为「问题自己
 * 消失了」—— 见不到现场等于没有现场(7-N)。⚠️ 只**数**、不渲染成可答的卡片:
 * 渲染了就是给一排点了也没人处理的按钮。
 * 事实一条都没删:项目页(那个读面本来就是项目内的)照常显示,答复接口仍然可用。
 *
 * ── 数据来源与刷新 ────────────────────────────────────────────────
 *
 * `GET /api/client-questions`(经 `useClientQuestions`),按 `projectsRevision` 重拉 ——
 * WS 的 `client_question` 事件会 bump 那个戳([stores/chat.ts:875]),所以新提问
 * 落地后这一块会自己刷新,不靠轮询。
 */
import { ClientQuestionCard } from "./ClientQuestionCard";
import { Pill } from "@/components/ui/primitives";
import { DataState, remoteListOf } from "@/components/ui/DataState";
import { Help } from "@/components/ui/Help";
import { useClientQuestions } from "@/lib/data";
import { scopeClientQuestions } from "@/lib/questionScope";
import { useChatStore } from "@/stores/chat";

export function ClientQuestionDock() {
  const { data: questions, loading, error, closedProjectQuestions } = useClientQuestions();
  const projectId = useChatStore((s) => s.projectId);

  // 早问的先答(FIFO)—— 队列的公平性比「最新的先看」重要。
  // ⚠️ 按项目筛选(见文件头与 `lib/questionScope.ts`):切到哪个项目才看到哪个项目的;
  //   没选项目 ⇒ 空(不退化成全局面板)。
  const { items, closedCount } = scopeClientQuestions(questions, closedProjectQuestions, projectId);
  const count = items.length;

  return (
    <section
      className="sansheng-card overflow-hidden flex flex-col flex-none"
      style={{ maxHeight: "45%" }}
    >
      <div
        className="px-3 py-2 flex items-center gap-2 flex-none"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <span style={{ fontSize: 12, color: "var(--bone-dim)" }}>待答</span>
        {count > 0 ? (
          <Pill tone="amber">{count} 件等你回答</Pill>
        ) : (
          /* ⚠️ 「还没查到」≠「查过了是空」——没选项目 / 读失败 / 还在加载都说「还没查到」,
             否则会把「没看」说成「没有」(见文件头)。 */
          projectId !== null && error === null && !loading ? (
            <span className="ss-meta">没有等你回答的问题</span>
          ) : null
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {projectId === null && error === null ? (
          <div className="ss-meta">先在左栏选一个项目 —— 这一块只看当前项目的提问。</div>
        ) : (
          /* 四态归 `DataState`(空态文案仍是这一块自己的领域语言)。 */
          <DataState
            what="待答清单"
            variant="note"
            unavailable="读不到待答清单。"
            state={remoteListOf(items, loading, error)}
          >
            {(rows) =>
              rows.length === 0 ? (
                <div className="ss-meta">
                  没有等你回答的问题 —— 本项目的业务经理没卡在你这里。
                </div>
              ) : (
                rows.map((q) => <ClientQuestionCard key={q.id} q={q} />)
              )
            }
          </DataState>
        )}
      </div>

      {count > 0 && (
        <div className="ss-meta px-3 py-1 flex-none" title="GET /api/client-questions">
          答案会落成 decision 工件,项目上留得下
        </div>
      )}

      {/*
        ⚠️ **不许静默丢弃**(见文件头那一节)。> 0 时必须有一行说明,否则用户会以为
        「那几件自己消失了」—— 而事实是它们属于已收口的项目,那里的业务经理永远
        不会被叫醒。⚠️ 数的是**本项目**那一份(后端那个 `fromClosedProjects` 是全局的)。
      */}
      {closedCount > 0 && (
        <div
          className="ss-meta px-3 py-1 flex-none flex items-center gap-1"
          style={{ borderTop: "1px solid var(--ink-3)", color: "var(--ochre)" }}
          data-from-closed-projects={closedCount}
          title="项目已收口 · 不会再有人来处理,事实仍在项目页"
        >
          <span>另有 {closedCount} 件来自已收口,不再等回复(项目页里还看得见)</span>
          <Help id="client-question.closed" />
        </div>
      )}
    </section>
  );
}
