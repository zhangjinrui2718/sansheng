/**
 * 等甲方拍板的问题卡(待办队列 / 项目详情共用)
 *
 * ── 它回答的三个问题 ────────────────────────────────────────────
 *
 *   1. **谁在问**(`askedByName` + 项目名)—— 不问清主体就没法判断该不该点头;
 *   2. **问什么**(`question`)+ **建议怎么答**(`lean`,提问者的倾向与理由)——
 *      lean 是「让我只需点个头」的关键,所以它和问题同级显示,不折叠;
 *   3. **可以怎么答**(`options`)—— 选项是可点的:点一下填进输入框,再由用户
 *      确认发出。**不点一下就直接提交** —— 选项常是「A / B」这种短语,直接当答案
 *      发出去会丢掉用户想补的话。
 *
 * ── 落地方式 ────────────────────────────────────────────────────
 *
 * 走 `POST /api/client-questions/:id/answer`(经 store.answerQuestion)。契约里
 * WS 也有等价的 `answer_client_question` 命令,但这是一个**表单**:HTTP 有回执,
 * 失败能告诉用户「没答上」;WS 发出去只能靠后续事件猜。
 */
import { useState } from "react";
import type { ClientQuestionView } from "@shared/types/platform";
import { Disclosure, Flag, Pill } from "@/components/ui/primitives";
import { useChatStore } from "@/stores/chat";
import { fmtTime } from "@/lib/vocab";

export function ClientQuestionCard({
  q,
  showProject = false,
}: {
  q: ClientQuestionView;
  showProject?: boolean;
}) {
  const answerQuestion = useChatStore((s) => s.answerQuestion);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function submit() {
    const value = text.trim();
    if (!value || busy || done) return;
    setBusy(true);
    setFailed(null);
    const ok = await answerQuestion(q.id, value);
    setBusy(false);
    if (ok) setDone(true);
    else setFailed("没能提交答案 —— 答案没有落库,请重试。");
  }

  return (
    <article className="sansheng-card p-3">
      <div className="flex items-center gap-2 flex-wrap">
        {showProject && (
          <Pill tone="bone" title={q.projectId}>
            {q.projectName}
          </Pill>
        )}
        <span className="ss-meta">{q.askedByName} 提问</span>
        <span className="ss-meta ml-auto">{fmtTime(q.createdAt)}</span>
      </div>

      <div className="ss-body mt-1" style={{ color: "var(--bone)" }}>
        {q.question}
      </div>

      {/* 倾向与理由是「点头前最该看的一行」,所以它不折叠、不隐藏。 */}
      {q.lean !== null && q.lean.length > 0 && (
        <Flag tone="amber">
          <span className="ss-meta">建议</span>
          <span className="ss-body" style={{ color: "var(--bone-dim)" }}>
            {q.lean}
          </span>
        </Flag>
      )}

      {q.options.length > 0 && (
        <div className="mt-2 flex items-center gap-1.5 flex-wrap">
          {q.options.map((opt) => (
            <button
              key={opt}
              type="button"
              className="sansheng-button"
              style={{ padding: "2px 8px", fontSize: 11 }}
              title="填进下面的输入框,可以再补充说明"
              onClick={() => setText(opt)}
            >
              {opt}
            </button>
          ))}
        </div>
      )}

      {done ? (
        <div className="mt-2">
          <Pill tone="bamboo">已回答 · 已落成决策工件</Pill>
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-1.5">
          <textarea
            className="ss-question-input"
            rows={2}
            value={text}
            placeholder="回答甲方的问题…(可点上面的选项快速填入)"
            onChange={(e) => setText(e.target.value)}
            style={{
              background: "var(--ink-1)",
              border: "1px solid var(--ink-3)",
              borderRadius: 6,
              padding: "6px 8px",
              fontSize: 13,
              color: "var(--bone)",
              outline: "none",
              resize: "vertical",
            }}
          />
          {failed !== null && (
            <span className="ss-meta" style={{ color: "var(--cinnabar)" }}>
              {failed}
            </span>
          )}
          <div className="flex items-center gap-2">
            <button
              className="sansheng-button-primary"
              style={{ padding: "4px 12px", fontSize: 12 }}
              disabled={busy || text.trim().length === 0}
              onClick={() => void submit()}
            >
              {busy ? "提交中…" : "提交答案"}
            </button>
            <span className="ss-meta">答完会生成一条 decision 工件</span>
          </div>
        </div>
      )}

      <Disclosure summary="原始字段">
        <div className="flex flex-col gap-0.5">
          <span>问题 id:{q.id}</span>
          <span>项目 id:{q.projectId}</span>
          <span>提问者 id:{q.askedByAgentId}</span>
          <span>状态:{q.status}</span>
        </div>
      </Disclosure>
    </article>
  );
}
