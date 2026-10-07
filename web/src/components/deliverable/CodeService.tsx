/**
 * 交付物 · `code_service` 的渲染面(migration 026)
 *
 * ── 它凭什么敢显示这些坐标 ──────────────────────────────────────
 *
 * 这些值**不是模型写的**,是平台在写入那一刻**去盘上读出来的**
 * (`src/platform/tools/blackboard.ts` 的 `verifyCodeService` →
 * `src/platform/codeservice/git.ts`):
 *
 *   ① 路径存在、在工作根之内(realpath 之后比,符号链接也拦得住)
 *   ② 真的是 git 工作区
 *   ③ 有提交(HEAD 解析得出来)
 *   ④ `headCommit` 与真实 HEAD 一致(不一致就**写不进来**)
 *   ⑤ `branch` 的顶端就是那个提交
 *   ⑥ 仓库根目录有 `Dockerfile`
 *
 * ⇒ 所以这一页可以放心地说「这就是交付的那一个提交」。**但读面仍然防御**:
 * 老行 / 手改的行里可能缺项,缺一项就如实写「读不到」,**不猜、不显示
 * `undefined`、也不编一个默认端口**(同 `vocab.ts` 的「未知取值原样透出」)。
 *
 * ── 为什么不由模型在正文里手写这两条 docker 命令 ─────────────────
 *
 * 因为那会多出**第三种写法**:同一件事在「核实过的坐标」与「正文里的一句话」
 * 之间必然漂(模型可能把端口写错)。命令从坐标生成,正文只负责讲「为什么」。
 */
import { memo, useCallback, useEffect, useState } from "react";
import { errorMessage, getRepoCommits } from "@/lib/api";
import type { RepoCommitsView } from "@shared/types/platform";
import type { CodeServiceView } from "@shared/types/platform";
import { dockerCommands, shortSha } from "@/lib/deliverable";

export interface CodeServiceProps {
  /** 工件 id —— 用来读**现读**的提交列表(`GET /api/artifacts/:id/commits`)。 */
  artifactId: string;
  /** 工件正文 —— 一份 markdown 说明(这个服务是什么 / 怎么构建 / 怎么部署)。 */
  body: string;
  /**
   * 平台核实过的坐标(服务端从 `metadata_json` 解析,见 `transport/views.ts`)。
   * **可空**:`deliverableType` 是 `code_service` 但行里没有坐标(老行 / 手改的行)。
   */
  service: CodeServiceView | null;
}

/** 一行坐标。值读不到时显示的是**「读不到」**而不是空白或 `undefined`。 */
function Row({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div className="flex items-baseline gap-2" style={{ fontSize: 12, lineHeight: 1.7 }}>
      <span className="ss-meta" style={{ flex: "0 0 88px" }}>
        {label}
      </span>
      {value === null ? (
        <span className="ss-meta" style={{ color: "var(--cinnabar, #b4483c)" }}>
          读不到
        </span>
      ) : (
        <span
          className="ss-body"
          style={{
            color: "var(--bone-dim)",
            wordBreak: "break-all",
            fontFamily: mono === true ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined,
          }}
        >
          {value}
        </span>
      )}
    </div>
  );
}

/** 一条可复制的命令。复制成功要说出来 —— 静默成功的按钮等于没做。 */
function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => setCopied(false),
    );
  }, [text]);
  return (
    <div className="flex items-center gap-2">
      <code
        style={{
          flex: 1,
          fontSize: 12,
          padding: "4px 6px",
          background: "var(--ink-1)",
          border: "1px solid var(--ink-3)",
          borderRadius: 6,
          color: "var(--bone)",
          overflowX: "auto",
          whiteSpace: "nowrap",
        }}
      >
        {text}
      </code>
      <button
        type="button"
        className="sansheng-button"
        style={{ padding: "1px 8px", fontSize: 11 }}
        onClick={copy}
        title="复制这条命令"
      >
        {copied ? "已复制" : "复制"}
      </button>
    </div>
  );
}

/** 全空的坐标 —— `service` 为 null 时用它渲染(每一项都会显示「读不到」)。 */
const NO_META: CodeServiceView = {
  repoPath: null, repoName: null, branch: null, headCommit: null, headSubject: null,
  commitCount: null, dockerfile: null, service: null, port: null, files: [],
};

/**
 * 最近提交 —— **现读**的那条边。
 *
 * ⚠️ 三种状态**必须分开渲染**,因为它们看起来一样、含义完全不同:
 *   · `runtime: "ok"` + 有提交 → 列出;
 *   · `runtime: "ok"` + 空列表   → 「这个仓库一个提交都没有」(不可能:写入时校验过);
 *   · `runtime: "unavailable"`   → **读不到**(仓库被移走 / git 不可用),
 *     带上 `problem`。把它渲染成空列表 = 把一次读失败说成「没有提交」。
 */
function CommitList({ artifactId }: { artifactId: string }) {
  const [data, setData] = useState<RepoCommitsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    getRepoCommits(artifactId)
      .then((r) => { if (!cancelled) setData(r); })
      .catch((e: unknown) => { if (!cancelled) setError(errorMessage(e)); });
    return () => { cancelled = true; };
  }, [artifactId]);

  if (error !== null) {
    return <div className="ss-meta" style={{ color: "var(--cinnabar, #b4483c)" }}>读不到提交:{error}</div>;
  }
  if (data === null) return <div className="ss-meta">读取仓库提交…</div>;
  if (data.runtime === "unavailable") {
    return (
      <div className="ss-meta" style={{ color: "var(--cinnabar, #b4483c)" }}>
        **读不到**仓库提交 —— {data.problem ?? "原因未说明"}。
        (这不是「没有提交」,是这次读不到。)
      </div>
    );
  }
  const commits = data.commits ?? [];
  if (commits.length === 0) {
    return <div className="ss-meta">这个仓库一个提交都没有。</div>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {commits.map((c) => (
        <div key={c.sha} className="flex items-baseline gap-2" style={{ fontSize: 12, lineHeight: 1.7 }}>
          <code style={{ color: "var(--bone)", flex: "0 0 auto" }}>{c.shortSha}</code>
          <span className="ss-body" style={{ color: "var(--bone-dim)", wordBreak: "break-word" }}>
            {c.subject || "(无标题提交)"}
          </span>
          <span className="ss-meta ml-auto" style={{ flex: "0 0 auto" }}>
            {c.author}
          </span>
        </div>
      ))}
    </div>
  );
}

export const CodeService = memo(function CodeService({ artifactId, body, service }: CodeServiceProps) {
  const meta = service ?? NO_META;
  const cmds = dockerCommands(meta);
  const head = shortSha(meta.headCommit);

  return (
    <div className="flex flex-col gap-2" data-deliverable-type="code_service">
      <div className="ss-section" style={{ fontSize: 12 }}>
        代码服务
      </div>

      <div className="sansheng-card p-2.5 flex flex-col gap-0.5">
        <Row label="服务名" value={meta.service} />
        <Row label="端口" value={meta.port === null ? null : String(meta.port)} />
        <Row label="分支" value={meta.branch} mono />
        <Row
          label="HEAD"
          value={head === null ? null : `${head}${meta.headSubject !== null ? ` ${meta.headSubject}` : ""}`}
          mono
        />
        <Row label="提交数" value={meta.commitCount === null ? null : String(meta.commitCount)} />
        <Row label="Dockerfile" value={meta.dockerfile} mono />
        <Row label="仓库" value={meta.repoPath} mono />
      </div>

      {cmds === null ? (
        <div className="ss-meta" style={{ color: "var(--cinnabar, #b4483c)" }}>
          服务名或端口读不到,所以**不生成部署命令** —— 编一个默认值会让你照着一条错的命令去部署。
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="ss-meta">在仓库目录里执行:</div>
          <Command text={cmds.build} />
          <Command text={cmds.run} />
          <div className="ss-meta">
            这两条命令由**核实过的坐标**生成(端口来自交付物本身),不是模型手写的。
          </div>
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        <div className="ss-meta">
          最近提交(现读,不是交付时的快照)
        </div>
        <CommitList artifactId={artifactId} />
      </div>

      {meta.files.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <div className="ss-meta">仓库根目录:</div>
          <div className="ss-body" style={{ fontSize: 12, color: "var(--bone-dim)", wordBreak: "break-all" }}>
            {meta.files.join(" · ")}
          </div>
        </div>
      )}

      {body.trim() !== "" && (
        <>
          <div className="ss-section" style={{ fontSize: 12 }}>
            说明
          </div>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontSize: 12,
              lineHeight: 1.7,
              margin: 0,
              padding: "6px 8px",
              background: "var(--ink-1)",
              border: "1px solid var(--ink-3)",
              borderRadius: 6,
              color: "var(--bone-dim)",
            }}
          >
            {body}
          </pre>
        </>
      )}
    </div>
  );
});
