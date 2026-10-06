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
 * ── 跨项目:显示,但不假装它属于当前项目 ──────────────────────────
 *
 * 这一块长在「本项目」下面,但它的数据是**全局**的(`GET /api/client-questions`
 * 跨所有项目)。若只显示当前项目,别的项目的提问就又变成没人知道 —— 那正是这个
 * 页签当初存在的理由。所以:**当前项目的不标项目名**(它在「本项目」底下,归属
 * 不言自明),别的项目的那条上面带一行暗色项目名。跨项目的事实如实显示,不藏。
 *
 * ── 数据来源与刷新 ────────────────────────────────────────────────
 *
 * `GET /api/client-questions`(经 `useClientQuestions`),按 `projectsRevision` 重拉 ——
 * WS 的 `client_question` 事件会 bump 那个戳([stores/chat.ts:875]),所以新提问
 * 落地后这一块会自己刷新,不靠轮询。
 */
import { useMemo } from "react";
import { ClientQuestionCard } from "./ClientQuestionCard";
import { Pill } from "@/components/ui/primitives";
import { useClientQuestions } from "@/lib/data";
import { useChatStore } from "@/stores/chat";
import type { ClientQuestionView } from "@shared/types/platform";

export function ClientQuestionDock() {
  const { data: questions, loading, error } = useClientQuestions();
  /** 当前上下文 —— 只用来决定「要不要给这条标项目名」(见 `DockCard`)。 */
  const projectId = useChatStore((s) => s.projectId);

  // 早问的先答(FIFO)—— 队列的公平性比「最新的先看」重要。
  // ⚠️ 不按项目分组(原先「待办」页是分组标题):这一块要陪「本项目」一起滚,
  //   分组标题会把可答的区域压得太窄,而项目归属由 `DockCard` 那一行小字给出了。
  const items = useMemo(
    () => [...questions].sort((a, b) => a.createdAt - b.createdAt),
    [questions],
  );
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
          <span className="ss-meta">没有等你回答的问题</span>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {error !== null ? (
          <div className="ss-meta" style={{ color: "var(--cinnabar)" }}>
            加载失败:{error}
          </div>
        ) : loading && count === 0 ? (
          /* 「还没查过」与「查过了是空」在 hooks 里已分开(loading 初值 true),
             走到空态就真的是空队列。 */
          <div className="ss-meta">加载中…</div>
        ) : count === 0 ? (
          <div className="ss-meta">
            没有等你回答的问题 —— 各项目的业务经理都没卡在甲方这里。
          </div>
        ) : (
          items.map((q) => <DockCard key={q.id} q={q} currentProjectId={projectId} />)
        )}
      </div>

      {count > 0 && (
        <div
          className="px-3 py-1.5 flex-none"
          style={{ borderTop: "1px solid var(--ink-3)" }}
        >
          <span
            className="ss-meta"
            title="数据来源:GET /api/client-questions。回答走 POST /api/client-questions/:id/answer,落成 decision 工件。"
          >
            答案会落成 decision 工件,项目上留得下
          </span>
        </div>
      )}
    </section>
  );
}

/**
 * 一条提问。**当前项目的不标项目名** —— 它就在「本项目」下面,标出来是噪音;
 * 别的项目的那条必须标,否则它在右栏里会被读成当前项目欠你的活。
 */
function DockCard({ q, currentProjectId }: { q: ClientQuestionView; currentProjectId: string | null }) {
  const mine = q.projectId === currentProjectId;
  return (
    <div className="flex flex-col gap-1">
      {!mine && (
        <span className="ss-meta" style={{ color: "var(--ochre)" }} title="别的项目的问题">
          {q.projectName}
        </span>
      )}
      <ClientQuestionCard q={q} />
    </div>
  );
}
