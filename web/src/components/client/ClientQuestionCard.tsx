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
import { Disclosure, Flag, Pill, RedMeta } from "@/components/ui/primitives";
import { useChatStore } from "@/stores/chat";
import { closeConsent } from "@/lib/api";
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

  // ── D6:收口提议卡(intent="close")──────────────────────────────
  // 两个固定动作走 `POST /api/projects/:id/close/consent`:「同意收口」会写
  // `close_consented_at`(此后 project_close 才放行)**并**把提议答复成 decision;
  // 「先不收」只答复、不写同意。答完卡片消失(问题已 resolved)。
  // ⚠️ 刻意**不给自由文本框**:收口是一句话的裁决,不是讨论 —— 讨论走对话。
  if (q.intent === "close") {
    return (
      <article className="sansheng-card p-3" data-role="close-proposal">
        <div className="flex items-center gap-2 flex-wrap">
          {showProject && (
            <Pill tone="bone" title={q.projectId}>
              {q.projectName}
            </Pill>
          )}
          <Pill tone="amber" title="收口不可逆 —— 同意必须来自你点的那一下">
            收口提议
          </Pill>
          <span className="ss-meta">{q.askedByName} 提议</span>
          <span className="ss-meta ml-auto">{fmtTime(q.createdAt)}</span>
        </div>

        <div className="ss-body mt-1" style={{ color: "var(--bone)" }}>
          {q.question}
        </div>

        {done ? (
          <div className="mt-2">
            <Pill tone="bamboo">已表态 · 已落成决策工件</Pill>
          </div>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="sansheng-button-primary"
                style={{ padding: "4px 12px", fontSize: 12 }}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setFailed(null);
                  try {
                    await closeConsent(q.projectId, "accept");
                    setDone(true);
                    // 左栏分组 / 项目页计数靠 projectsRevision 重拉(同意后收口门放行)。
                    void useChatStore.getState().loadProjects();
                  } catch {
                    setFailed("没能提交表态 —— 没有落库,请重试。");
                  } finally {
                    setBusy(false);
                  }
                }}
                title="同意后这个项目可以收口(project_close 放行)"
              >
                同意收口
              </button>
              <button
                type="button"
                className="sansheng-button"
                style={{ padding: "4px 12px", fontSize: 12 }}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setFailed(null);
                  try {
                    await closeConsent(q.projectId, "decline");
                    setDone(true);
                    void useChatStore.getState().loadProjects();
                  } catch {
                    setFailed("没能提交表态 —— 没有落库,请重试。");
                  } finally {
                    setBusy(false);
                  }
                }}
                title="先不收:项目继续,哪里不满意直接在对话里说"
              >
                先不收
              </button>
            </div>
            {failed !== null && <RedMeta>{failed}</RedMeta>}
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
            placeholder="回答…"
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
          {failed !== null && <RedMeta>{failed}</RedMeta>}
          <div className="flex items-center gap-2">
            <button
              className="sansheng-button-primary"
              style={{ padding: "4px 12px", fontSize: 12 }}
              disabled={busy || text.trim().length === 0}
              onClick={() => void submit()}
            >
              {busy ? "提交中…" : "提交答案"}
            </button>
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
