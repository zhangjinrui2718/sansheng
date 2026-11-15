/**
 * 单元历史面板(2026-11-15)—— git 化之后的「历史 / 查看旧版 / 回滚」三件套。
 *
 * 数据来自 `GET /api/harness/history?path=system_prompts/{unitId}.md`(只看触到
 * 这个单元的提交)。「回滚」调 `restoreHarnessFile`,成功后把回读正文交给
 * `onRestored` —— 由父级走 `applyContent`(回读值当状态,写面规矩③)。
 *
 * 纪律:
 *   · 失败(读不到历史 / 回滚被拒)在面板里**明说**,不静默收起整段;
 *   · 「查看」只读不写;「回滚」必须过确认;
 *   · 历史条目按时间倒序就是全部版本 —— 当前版不单独标。
 */
import { useEffect, useState } from "react";
import { getHarnessHistory, getHarnessFileAt, restoreHarnessFile, errorMessage } from "@/lib/api";
import { RedNote } from "@/components/ui/primitives";

export function UnitHistoryPanel({
  unitId,
  rev,
  onRestored,
}: {
  unitId: string;
  /** 变更代数 —— 保存 / 回滚后 +1,逼着重新拉历史 */
  rev: number;
  /** 回滚成功后回调(参数 = 回读的旧版正文) */
  onRestored?: (unitId: string, content: string) => void;
}) {
  const relPath = `system_prompts/${unitId}.md`;
  const [entries, setEntries] = useState<Array<{ sha: string; at: number; message: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<{ sha: string; content: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setError(null);
    getHarnessHistory(relPath)
      .then((r) => {
        if (alive) setEntries(r.entries);
      })
      .catch((e: unknown) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [unitId, rev]);

  if (entries !== null && entries.length === 0 && error === null) {
    return <div className="ss-note">还没有提交历史 —— 保存一次后这里会出现版本列表。</div>;
  }

  const viewOld = (sha: string) => {
    setBusy(`view:${sha}`);
    getHarnessFileAt(sha, relPath)
      .then((r) => {
        setViewing({ sha, content: r.content });
        setBusy(null);
      })
      .catch((e: unknown) => {
        setBusy(null);
        setError(errorMessage(e));
      });
  };

  const rollback = (sha: string) => {
    setBusy(`rollback:${sha}`);
    restoreHarnessFile(sha, relPath)
      .then((r) => {
        setBusy(null);
        onRestored?.(unitId, r.content);
      })
      .catch((e: unknown) => {
        setBusy(null);
        setError(errorMessage(e));
      });
  };

  return (
    <div className="flex flex-col gap-1">
      {error !== null && (
        <RedNote>历史读不到:{error}</RedNote>
      )}
      {(entries ?? []).map((e) => (
        <div key={e.sha} className="flex items-center gap-2 flex-wrap">
          <code className="ss-meta">{e.sha.slice(0, 8)}</code>
          <span className="ss-meta">{new Date(e.at * 1000).toLocaleString()}</span>
          <span
            className="ss-meta"
            style={{ maxWidth: 260, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {e.message}
          </span>
          <button
            type="button"
            className="sansheng-button ss-link"
            onClick={() => viewOld(e.sha)}
            disabled={busy !== null}
          >
            {busy === `view:${e.sha}` ? "读取中…" : "查看此版"}
          </button>
          <button
            type="button"
            className="sansheng-button ss-link"
            onClick={() => rollback(e.sha)}
            disabled={busy !== null}
          >
            {busy === `rollback:${e.sha}` ? "回滚中…" : "回滚到此版"}
          </button>
        </div>
      ))}
      {viewing !== null && (
        <pre
          className="ss-note"
          style={{
            whiteSpace: "pre-wrap",
            maxHeight: 240,
            overflowY: "auto",
            border: "1px solid var(--ink-4)",
            padding: 8,
          }}
        >
          {viewing.content}
        </pre>
      )}
    </div>
  );
}
