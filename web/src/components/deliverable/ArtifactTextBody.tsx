/**
 * 普通工件的正文(现读)—— 从 `routes/Works.tsx` 搬出来(v5,2026-11-20)。
 *
 * 搬家的理由:流内展开(Wave B)也要读正文 —— 「三态 + 漂移注记」这套判据
 * 长在路由文件里的话,交付物组件就得 import 一条路由(方向反了)。
 * 搬家 ≠ 改写:判据逐字保留,只把裸 `<pre>` 换成 markdown 渲染 ——
 * 存量交付物与 decision 工件的正文本来就是 markdown,此前印的是字面量
 * (`**加粗**`、表格线)。渲染器与对话同款,清洗边界在 `lib/markdown.ts`。
 *
 * ── 三态必须分开(原判据,逐字继承)────────────────────────────
 *
 * `runtime: "unavailable"` 是**读不到**(文件被删 / 被回滚 / `at` 不可达),
 * 把它显示成「这条工件没有正文」就是把一次读失败说成「本来就没有」。
 * 读不到时印 `problem` 那一行,**不许**留空。
 */
import { useArtifactContent } from "@/lib/data";
import { Markdown } from "@/components/chat/Markdown";
import { ContentDriftNote } from "./ContentDriftNote";
import { RedNote } from "@/components/ui/primitives";

export function ArtifactTextBody({ artifactId }: { artifactId: string }) {
  const { data, loading, error } = useArtifactContent(artifactId);

  if (error !== null) {
    return <RedNote>读不到正文:{error}</RedNote>;
  }
  if (loading || data === null) return <div className="ss-meta">读取正文…</div>;
  if (data.runtime !== "ok") {
    return (
      <RedNote data-content-runtime="unavailable">
        读不到这份正文 —— {data.problem ?? "原因未说明"}。
        (这不是「这条工件没有正文」,是这一次读不到。落点:{data.path})
      </RedNote>
    );
  }
  if (data.content.length === 0) {
    return <div className="ss-note">这条工件的正文是空的。</div>;
  }
  return (
    <>
      <div className="ss-section" style={{ fontSize: 12 }}>
        正文
      </div>
      {/* 索引漂移:一行提示(不是错误、不阻止阅读)—— 见 ContentDriftNote.tsx */}
      <ContentDriftNote drifted={data.drifted} />
      <div
        className="ss-md"
        data-role="artifact-text-body"
        style={{
          maxHeight: 420,
          overflow: "auto",
          padding: "6px 8px",
          background: "var(--ink-1)",
          border: "1px solid var(--ink-3)",
          borderRadius: 6,
          fontSize: 13,
        }}
      >
        <Markdown text={data.content} />
      </div>
    </>
  );
}
