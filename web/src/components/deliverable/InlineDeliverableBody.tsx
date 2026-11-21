/**
 * 流内展开的交付物正文(v5,2026-11-20 Wave B)—— 验收卡的「查看正文」落点。
 *
 * ── 它和 `ArtifactBodySection`(工作项页抽屉)的分工 ────────────────
 *
 * 同一份 `bodyMode` 判据(`lib/deliverable.ts`,唯一落点),两种挂载:
 * 抽屉那一份带事实条 / 关系栏 / 原始字段(工件的结构化详情面);
 * 这一份**只有正文** —— 它住在对话流的验收卡里,甲方要的是「看看交付的东西」,
 * 不是工件档案。判据不分家(都走 `bodyMode`),呈现按场景。
 *
 * ⚠️ 按 id 现取详情(`GET /api/artifacts/:id`):`code_service` 分支需要
 * `codeService` 坐标,而 `AwaitingAcceptanceView` 上没有 —— 懒加载(点开才取),
 * 不给流里背一笔常驻请求。
 */
import { useEffect, useState } from "react";
import { errorMessage, getArtifact } from "@/lib/api";
import type { ArtifactView } from "@shared/types/platform";
import { bodyMode, htmlReportFileName } from "@/lib/deliverable";
import { HtmlReport } from "./HtmlReport";
import { CodeService } from "./CodeService";
import { ArtifactTextBody } from "./ArtifactTextBody";
import { RedNote } from "@/components/ui/primitives";

export function InlineDeliverableBody({ artifactId, title }: { artifactId: string; title: string }) {
  const [artifact, setArtifact] = useState<ArtifactView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setArtifact(null);
    setError(null);
    getArtifact(artifactId)
      .then((r) => { if (!cancelled) setArtifact(r.artifact); })
      .catch((e: unknown) => { if (!cancelled) setError(errorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [artifactId]);

  if (error !== null) {
    return <RedNote>读不到工件详情:{error}</RedNote>;
  }
  if (loading || artifact === null) {
    return <div className="ss-meta">读取工件详情…</div>;
  }
  switch (bodyMode(artifact)) {
    case "html_report":
      // 沙箱 iframe 由 HtmlReport 自己现读正文(sandbox="" + srcDoc,见其文件头)
      return <HtmlReport artifactId={artifact.id} fileName={htmlReportFileName(title, artifact.id)} />;
    case "code_service":
      // 坐标缺项时 CodeService 自己渲染「读不到」行(service=null 的 NO_META 形态)
      return <CodeService artifactId={artifact.id} service={artifact.codeService} />;
    case "text":
      return <ArtifactTextBody artifactId={artifact.id} />;
  }
}
