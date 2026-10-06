/**
 * 待答停靠位(右下角)—— 原「待办」页的新落点
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
 * ⇒ 所以它现在**长在对话页的右下角**:提问是打断,不打断当前阅读;
 * 收起时是一枚角标(0 件时是灰的,不假装有事),展开就能当场答。
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
 * ── 为什么是「右下角浮层」而不是消息流里的一张卡 ────────────────────
 *
 * 提问是**状态**(open → accepted),不是消息。插进消息流意味着答完之后要从
 * 历史里**删掉一条已经发生过的话** —— 而历史消息不该被追溯删除。做成浮层就
 * 自然:答完即消失、刷新还在、不会因为滚动位置找不到。
 *
 * ── 数据来源与刷新 ────────────────────────────────────────────────
 *
 * `GET /api/client-questions`(经 `useClientQuestions`),按 `projectsRevision` 重拉 ——
 * WS 的 `client_question` 事件会 bump 那个戳([stores/chat.ts:875]),所以新提问
 * 落地后这一页会自己刷新,不靠轮询。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ClientQuestionCard } from "./ClientQuestionCard";
import { useClientQuestions } from "@/lib/data";
import { useChatStore } from "@/stores/chat";
import type { ClientQuestionView } from "@shared/types/platform";

export function ClientQuestionDock() {
  const { data: questions, loading, error } = useClientQuestions();
  /** 当前上下文 —— 只用来把「当前项目的那条」高亮出来(见 `DockCard`)。 */
  const projectId = useChatStore((s) => s.projectId);
  const [open, setOpen] = useState(false);

  /**
   * 新提问落地时**自动展开一次**。
   *
   * 为什么需要:这个停靠位替代的是一个**从不提醒**的页签 —— 若仍然只在角标上
   * 加一个数字,用户还是得自己注意到右下角变了,那就等于把「去另一个 tab 看」
   * 换成了「去角落里看」。而提问是**唯一打断式的**数据(其余工件都不打断),
   * 所以它值得自己把面板打开。判据是**新出现的 id**,不是「数量变了」——
   * 答掉一条也会让数量变,那不该把刚答完的面板重新弹开。
   */
  const seen = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    if (loading) return;
    const ids = new Set(questions.map((q) => q.id));
    const prev = seen.current;
    seen.current = ids;
    // 首帧不算「新」(`prev === null`):那会把每个用户开场都弹一次面板。
    if (prev === null) return;
    if (ids.size > prev.size) setOpen(true);
  }, [questions, loading]);

  // 早问的先答(FIFO)—— 队列的公平性比「最新的先看」重要。
  // ⚠️ 不再按项目分组(原先「待办」页是分组标题):浮层是全局的,分组标题会把
  //   面板撑得很长,而项目归属已经由 `DockCard` 那一行小字给出了。
  const items = useMemo(
    () => [...questions].sort((a, b) => a.createdAt - b.createdAt),
    [questions],
  );

  const count = items.length;

  return (
    <div
      style={{ position: "fixed", right: 18, bottom: 18, zIndex: 40, width: open ? 420 : "auto" }}
    >
      {open ? (
        <section
          className="sansheng-card overflow-hidden flex flex-col"
          style={{ boxShadow: "0 12px 40px rgba(0,0,0,0.45)" }}
        >
          <header
            className="px-3 py-2 flex items-center gap-2 flex-none"
            style={{ borderBottom: "1px solid var(--ink-3)" }}
          >
            <span style={{ fontSize: 12, color: "var(--bone)" }}>待答</span>
            <span className="ss-meta">
              {count > 0 ? `${count} 件等你回答` : "没有等你回答的问题"}
            </span>
            <button
              type="button"
              className="sansheng-button ml-auto"
              style={{ padding: "2px 8px", fontSize: 11 }}
              onClick={() => setOpen(false)}
            >
              收起
            </button>
          </header>

          <div className="overflow-y-auto p-2 flex flex-col gap-2" style={{ maxHeight: "60vh" }}>
            {error !== null ? (
              <div className="ss-meta" style={{ color: "var(--cinnabar)" }}>
                加载失败:{error}
              </div>
            ) : loading && count === 0 ? (
              <div className="ss-meta">加载中…</div>
            ) : count === 0 ? (
              <div className="ss-meta">
                没有等你回答的问题 —— 各项目的业务经理都没卡在甲方这里。
              </div>
            ) : (
              items.map((q) => <DockCard key={q.id} q={q} currentProjectId={projectId} />)
            )}
          </div>

          <footer
            className="px-3 py-1.5 flex-none"
            style={{ borderTop: "1px solid var(--ink-3)" }}
          >
            <span
              className="ss-meta"
              title="数据来源:GET /api/client-questions。回答走 POST /api/client-questions/:id/answer,落成 decision 工件。"
            >
              答案会落成 decision 工件,项目上留得下
            </span>
          </footer>
        </section>
      ) : (
        <button
          type="button"
          className="sansheng-button"
          onClick={() => setOpen(true)}
          title={
            count > 0
              ? `${count} 件等你回答的问题 —— 数据来源:GET /api/client-questions`
              : "没有等你回答的问题 —— 数据来源:GET /api/client-questions"
          }
          style={{
            padding: "6px 12px",
            fontSize: 12,
            color: count > 0 ? "var(--amber)" : "var(--bone-dim)",
            borderColor: count > 0 ? "var(--amber)" : "var(--ink-4)",
            background: "var(--ink-1)",
            boxShadow: "0 6px 20px rgba(0,0,0,0.35)",
          }}
        >
          {count > 0 ? `待答 ${count}` : "待答"}
        </button>
      )}
    </div>
  );
}

/**
 * 一条提问。**跨项目的也要能答** —— 所以项目名在浮层里不能省(原先它在页面上
 * 是分组标题,这里只剩一行)。当前项目的那条用琥珀色标出:停靠位是**全局**的
 * (它长在窗口角上,不管你在哪个项目),而回答多半是给当前项目那条的。
 */
function DockCard({ q, currentProjectId }: { q: ClientQuestionView; currentProjectId: string | null }) {
  const mine = q.projectId === currentProjectId;
  return (
    <div className="flex flex-col gap-1">
      <span
        className="ss-meta"
        style={{ color: mine ? "var(--amber)" : "var(--bone-dim)" }}
        title={mine ? "当前项目" : "别的项目的问题"}
      >
        {q.projectName}
      </span>
      <ClientQuestionCard q={q} />
    </div>
  );
}
