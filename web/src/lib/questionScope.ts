/**
 * 「待答」面板的**显示作用域**(2026-10-12 用户裁决)
 *
 * ── 为什么是显示层的一道筛,而不是后端按项目查 ────────────────────
 *
 * 后端 `GET /api/client-questions` **仍然是全局的**:它一次给齐所有项目的待答,
 * 外加 `closedProjectQuestions`(来自已收口项目的那批,带项目坐标)。
 * 事实不因显示口径改变 —— 别处要用、要审计、要做别的读面,都还拿得到。
 *
 * 面板自己筛:`ClientQuestionDock` 挂在对话页右栏「本项目」下面,切到哪个项目
 * 才显示哪个项目的提问,与「待你验收」同一口径。
 *
 * ⚠️ **不藏的补偿是左栏**:`HistoryRail` 的项目节点上带 `counts.pendingQuestions`
 * (HistoryRail.tsx:125),「待你回答 N 个问题」标在**项目名下** ⇒ 别的项目有 N 件,
 * 仍然看得见、也知道去哪儿点。显示层筛掉的是「在这个面板里混着看」,不是那条事实。
 *
 * ⚠️ **`projectId === null` 返回空,而不是「全部」**:没选项目时「本项目的待答」
 *   这个问题是**无解**的,悄悄退化成全局面板 = 刚才那个矛盾(上面「本项目一切正常」,
 *   下面挂着别的项目的提问)又回来了,而且是**默默地**回来。空 + 一句「先选项目」
 *   才是如实的回答。
 */
import type { ClientQuestionView } from "@shared/types/platform";

export interface QuestionScope {
  /** 本项目的待答,早问的先答(FIFO)。`projectId === null` ⇒ 空数组。 */
  items: ClientQuestionView[];
  /**
   * 本项目里因**已收口**而不再等回复的条数。
   *
   * ⚠️ **只数,不渲染**:那批提问不在队列里正是因为兑现不了(排空器只跑 active 项目),
   * 渲染成可答的卡片就是给一排点了也没人处理的按钮。
   * ⚠️ 必须按项目数:后端那个 `fromClosedProjects` 是**全局**计数,直接显示会
   *   把别的项目的条数报在当前项目名下。
   */
  closedCount: number;
}

export function scopeClientQuestions(
  questions: readonly ClientQuestionView[],
  closedProjectQuestions: readonly ClientQuestionView[],
  projectId: string | null,
): QuestionScope {
  if (projectId === null) return { items: [], closedCount: 0 };
  const items = questions
    .filter((q) => q.projectId === projectId)
    .sort((a, b) => a.createdAt - b.createdAt);
  return {
    items,
    closedCount: closedProjectQuestions.filter((q) => q.projectId === projectId).length,
  };
}