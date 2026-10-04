/**
 * 待办 / 评审队列(新)
 *
 * **所有项目**里等甲方拍板的问题,一屏答完。这是旧系统给不了的一块:
 * 旧 `pending_question` 是**瞬态消息**(会话一关就没了),新的 `client_question`
 * 是**工件** —— 关掉页面下次打开还在,所以「攒着一起答」这件事才成立。
 *
 * 呈现:按项目分组(校准裁决),每组显示自己的问题;每张卡带候选项与提问者倾向,
 * 可直接回答(ClientQuestionCard → `POST /api/client-questions/:id/answer`)。
 *
 * 反造假:这是**队列**不是统计面板 —— 没有问题时是一句空态,不显示「今日已答 N」
 * 这类没有数据来源的数字。
 */
import { useMemo } from "react";
import { EmptyState, PageHeader, Section, StatStrip } from "@/components/ui/primitives";
import { ClientQuestionCard } from "@/components/client/ClientQuestionCard";
import { useClientQuestions } from "@/lib/data";
import type { ClientQuestionView } from "@shared/types/platform";

export function InboxPage() {
  const { data: questions, loading, error } = useClientQuestions();

  const groups = useMemo(() => {
    const byProject = new Map<string, { name: string; items: ClientQuestionView[] }>();
    for (const q of questions) {
      const g = byProject.get(q.projectId);
      if (g) g.items.push(q);
      else byProject.set(q.projectId, { name: q.projectName, items: [q] });
    }
    // 组内:早问的先答(FIFO)—— 队列的公平性比「最新的先看」重要。
    return [...byProject.entries()].map(([projectId, g]) => ({
      projectId,
      name: g.name,
      items: [...g.items].sort((a, b) => a.createdAt - b.createdAt),
    }));
  }, [questions]);

  return (
    <div className="ss-page">
      <PageHeader
        title="待办"
        hint={questions.length > 0 ? "所有项目里等你回答的问题" : undefined}
        hintTitle="数据来源:GET /api/client-questions。回答走 POST /api/client-questions/:id/answer,落成 decision 工件。"
        aside={
          questions.length > 0 ? (
            <StatStrip
              items={[
                { label: "待答", value: questions.length, tone: "amber" },
                { label: "涉及项目", value: groups.length },
              ]}
            />
          ) : undefined
        }
      />

      {error !== null ? (
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      ) : loading && questions.length === 0 ? (
        <EmptyState>加载中…</EmptyState>
      ) : questions.length === 0 ? (
        /* 「还没查过」与「查过了是空」在 hooks 里已分开(loading 初值 true),
           走到这里就真的是空队列。 */
        <EmptyState>没有等你回答的问题 —— 各项目的业务经理都没卡在甲方这里。</EmptyState>
      ) : (
        <div className="grid gap-5">
          {groups.map((g) => (
            <Section key={g.projectId} title={g.name} count={g.items.length} hint="按提问时间从早到晚">
              <div className="grid gap-2">
                {g.items.map((q) => (
                  <ClientQuestionCard key={q.id} q={q} />
                ))}
              </div>
            </Section>
          ))}
        </div>
      )}
    </div>
  );
}
