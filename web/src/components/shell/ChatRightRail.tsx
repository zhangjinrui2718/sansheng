/**
 * 对话页右栏 —— **「等你表态」收件箱**(R-A,2026-11-17 IA v4)
 *
 * 待你验收 + 待答 + 收口提议融合成一个队列(见 `Inbox.tsx` 的文件头);
 * 这里负责**取数提升与空栏判据**:
 *
 *   · 详情与提问清单都拉在**这一层**(两块各拉一份会让同一份数据一处写
 *     「加载中」、另一处写「没有」);
 *   · **空栏整栏隐藏**:收件箱拿到终值且队列为空 ⇒ `return null`;
 *     加载中 / 读失败**不许隐藏**(那会把「还没查过」渲染成「没有」)。
 *
 * ⚠️ **只挂在 chat 路由下**(见 `App.tsx`)—— 5s 兜底轮询也只在对话页跑。
 */
import { InboxPanel, inboxCount } from "@/components/client/Inbox";
import { useClientQuestions, useProjectDetail } from "@/lib/data";
import { useChatStore } from "@/stores/chat";

export function ChatRightRail() {
  const projectId = useChatStore((s) => s.projectId);
  const state = useProjectDetail(projectId, { pollMs: 5000 });
  const questions = useClientQuestions();

  if (projectId === null) {
    return null;
  }

  const { knownEmpty } = inboxCount(state, questions, projectId);
  if (knownEmpty) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3" style={{ minHeight: 0 }}>
      <InboxPanel state={state} questions={questions} projectId={projectId} />
    </div>
  );
}
