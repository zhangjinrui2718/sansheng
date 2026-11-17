/**
 * 对话页右栏 —— **两块**:待你验收 + 待答,共用同一个项目详情实例
 *
 * ── v3 减法(S-A,2026-11-17):「本项目」块已删 ─────────────────────
 *
 * 「本项目」(`AgentPanel`)与项目页仪表盘**完全重复**(计数/成员/未完成工作项/
 * 阻塞)。用户裁决(2026-11-17「Apple 式简约」):删胜于收。2026-10-12 的三块
 * 结构随之退场,`AgentPanel.tsx` 已删除;项目概览的唯一落点是项目页。
 *
 * ⚠️ **一个实例,不是两个**:`useProjectDetail` 每个 hook 实例各自 fetch、各自维护
 * `loading`。两块各调一次 ⇒ 同一份数据可能一处写「加载中」、另一处写「没有等你
 * 验收的东西」。所以详情与提问清单都拉在**这一层**,两块只收 props。
 *
 * ⚠️ **空栏整栏隐藏**(S-A):两块都**真的空**(都拿到了终值:详情与提问清单都
 * 加载完、无错、均为空)⇒ 整栏 `return null`。**加载中/读失败不许隐藏** ——
 * 那会把「还没查过」渲染成「没有」(`acceptance-dock.test.ts` ① 那条纪律的
 * 反向应用)。已收口项目的计数行(`closedCount`)算「有事要看」,不许因此藏栏。
 *
 * ⚠️ **`ChatRightRail` 只挂在 chat 路由下**(见 `App.tsx`)—— 所以那个 5s 兜底轮询
 * 也只在对话页跑。把它提到 `App` 里看着更「统一」,代价是**其余五个页面也一起轮询**。
 */
import { AcceptanceDock } from "@/components/client/AcceptanceDock";
import { ClientQuestionDock } from "@/components/client/ClientQuestionDock";
import { useClientQuestions, useProjectDetail } from "@/lib/data";
import { scopeClientQuestions } from "@/lib/questionScope";
import { useChatStore } from "@/stores/chat";

export function ChatRightRail() {
  const projectId = useChatStore((s) => s.projectId);
  const state = useProjectDetail(projectId, { pollMs: 5000 });
  const questions = useClientQuestions();

  // ⚠️ 未选项目 ⇒ 整栏不出现。右栏只答「有什么在等我」;没选项目就没有可答的。
  if (projectId === null) {
    return null;
  }

  /* 空栏判据:两块都拿到**终值**且都空。任何一个还在加载或读失败,都不算「空」——
     此时保持右栏在,让 dock 自己的四态说话(「还没查到」≠「没有」)。 */
  const acceptanceKnownEmpty =
    state.error === null && state.detail !== null && state.detail.awaitingAcceptance.length === 0;
  const { items, closedCount } = scopeClientQuestions(
    questions.data,
    questions.closedProjectQuestions,
    projectId,
  );
  const questionsKnownEmpty =
    !questions.loading && questions.error === null && items.length === 0 && closedCount === 0;
  if (acceptanceKnownEmpty && questionsKnownEmpty) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3" style={{ minHeight: 0 }}>
      <AcceptanceDock state={state} />
      <ClientQuestionDock questions={questions} projectId={projectId} />
    </div>
  );
}
