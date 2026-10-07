/**
 * 交付物 · `code_service` 的渲染面(migration 026 / 设计 §3.2)
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
 *   ⑥ **`servicePath` 之内**有 `Dockerfile`(2026-10-08 起不再是「仓库根」)
 *
 * ⇒ 所以这一页可以放心地说「这就是交付的那一个提交」。**但读面仍然防御**:
 * 老行 / 手改的行里可能缺项,缺一项就如实写「读不到」,**不猜、不显示
 * `undefined`、也不编一个默认端口**(同 `vocab.ts` 的「未知取值原样透出」)。
 *
 * ── 两个 sha 不是一回事(设计 §3.2b)────────────────────────────
 *
 *   · `headCommit` = **交付那一刻**的仓库现场(模型照抄 `git rev-parse HEAD`,
 *     这项核对不变);
 *   · `deliverableCommit` = 最后触及 `servicePath` 的提交 = **这版交付物是什么**。
 *     平台每回合都写工件正文并提交 ⇒ HEAD 一直在动,而交付物根本没变。
 *     所以「这版交付物」必须读后者 —— 拿 HEAD 冒充它,屏幕上就会写着与事实
 *     相反的话(平台提交一次工件,交付版本就假动一次)。
 *
 * ── `.gitignore` 吃掉的文件 = 交付物**静默残缺**(设计 §3.2d)────────
 *
 * 交付物的内容 = **被 git 跟踪的文件**。服务目录里被忽略的条目(本地 `.env`、
 * 构建产物)不会出现在甲方 clone 到的东西里。`node_modules` 这类是正常的,
 * 所以这是**告警不是拒绝**,但必须列出来 —— 「没进去的东西」也要看得见。
 * 空数组 = 没有(不是「读不到」);整体读不到由 `service === null` 表达。
 *
 * ── 为什么不由模型在正文里手写这两条 docker 命令 ─────────────────
 *
 * 因为那会多出**第三种写法**:同一件事在「核实过的坐标」与「正文里的一句话」
 * 之间必然漂(模型可能把端口或构建目录写错)。命令从坐标生成,正文只负责讲「为什么」。
 * **构建上下文是 `servicePath`**(交付物边界),不是仓库根 —— 见 `lib/deliverable.ts`。
 */
import { memo, useCallback, useEffect, useState } from "react";
import { errorMessage, getRepoCommits } from "@/lib/api";
import type { RepoCommitsView } from "@shared/types/platform";
import type { CodeServiceView } from "@shared/types/platform";
import { dockerCommands, shortSha } from "@/lib/deliverable";
import { useArtifactContent } from "@/lib/data";
import { ContentDriftNote } from "./ContentDriftNote";

export interface CodeServiceProps {
  /** 工件 id —— 用来读**现读**的提交列表(`GET /api/artifacts/:id/commits`)与正文。 */
  artifactId: string;
  /**
   * 平台核实过的坐标(服务端从 `metadata_json` 解析,见 `transport/views.ts`)。
   * **可空**:`deliverableType` 是 `code_service` 但行里没有坐标(老行 / 手改的行)。
   */
  service: CodeServiceView | null;
  /** 读正文的哪一版(提交 sha);省略 = 读 HEAD。 */
  at?: string;
}

/** 一行坐标。值读不到时显示的是**「读不到」**而不是空白或 `undefined`。 */
function Row({
  label,
  value,
  mono,
  hint,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex items-baseline gap-2" style={{ fontSize: 12, lineHeight: 1.7 }} title={hint}>
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
  repoPath: null, repoName: null, servicePath: null, branch: null,
  headCommit: null, headSubject: null,
  deliverableCommit: null, deliverableSubject: null,
  commitCount: null, dockerfile: null, service: null, port: null,
  files: [], ignoredFiles: [],
};

/**
 * 提交列表 `runtime` 的中文读法。
 *
 * ⚠️ **三态必须分开渲染**,因为它们看起来一样、含义完全不同:
 *   · `runtime: "ok"` + 有提交 → 列出;
 *   · `runtime: "ok"` + 空列表   → 「这个仓库一个提交都没有」(写入时校验过,几乎不可能);
 *   · `runtime: "unavailable"`   → **读不到盘**(仓库被移走 / git 不可用);
 *   · `runtime: "unreachable"`   → **交付提交已不可达**(`reset --hard` 之后只剩 reflog,
 *     设计 §3.2c)。
 * 后两者都带上 `problem`,**都不是**「没有提交」;未知取值原样透出(不猜)。
 */
export function commitsRuntimeLabel(runtime: string): string {
  if (runtime === "unavailable") return "读不到";
  if (runtime === "unreachable") return "提交已不可达";
  return runtime;
}

/**
 * 最近提交 —— **现读**的那条边(设计 §3.2b:`/commits` 按 `servicePath` 过滤)。
 *
 * ⚠️ 非 `ok` 一律不许渲染成空列表:那会把一次读失败说成「这个仓库是空的」。
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
  if (data.runtime !== "ok") {
    return (
      <div
        className="ss-meta"
        style={{ color: "var(--cinnabar, #b4483c)" }}
        data-commits-runtime={data.runtime}
      >
        **{commitsRuntimeLabel(data.runtime)}**仓库提交 —— {data.problem ?? "原因未说明"}。
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

/**
 * 正文(一份 markdown 说明)—— **现读**(设计 §4.2:正文不再随工件下发)。
 *
 * ⚠️ 读不到时印 `problem` 那一行,**不许**留空 —— 「没有说明」与「说明读不到」
 * 在屏幕上长得一样,而处置完全不同。
 */
function ServiceBody({ artifactId, at }: { artifactId: string; at?: string }) {
  const { data, loading, error } = useArtifactContent(artifactId, at ?? null);

  if (error !== null) {
    return (
      <div className="ss-note" style={{ color: "var(--cinnabar, #b4483c)" }}>
        读不到说明正文:{error}
      </div>
    );
  }
  if (loading || data === null) return <div className="ss-meta">读取说明正文…</div>;
  if (data.runtime !== "ok") {
    return (
      <div className="ss-note" style={{ color: "var(--cinnabar, #b4483c)" }} data-content-runtime="unavailable">
        **读不到**说明正文 —— {data.problem ?? "原因未说明"}。
        (这不是「没有说明」,是这次读不到。正文落点:{data.path})
      </div>
    );
  }
  if (data.content.trim() === "") {
    return <div className="ss-meta">这条交付物没有说明正文。</div>;
  }
  return (
    <>
      {/* 索引漂移:一行提示,不是错误(见 ContentDriftNote.tsx 文件头) */}
      <ContentDriftNote drifted={data.drifted} />
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
        {data.content}
      </pre>
    </>
  );
}

export const CodeService = memo(function CodeService({ artifactId, at, service }: CodeServiceProps) {
  const meta = service ?? NO_META;
  const cmds = dockerCommands(meta);
  const head = shortSha(meta.headCommit);
  const delivered = shortSha(meta.deliverableCommit);

  return (
    <div className="flex flex-col gap-2" data-deliverable-type="code_service">
      <div className="ss-section" style={{ fontSize: 12 }}>
        代码服务
      </div>

      <div className="sansheng-card p-2.5 flex flex-col gap-0.5">
        <Row label="服务名" value={meta.service} />
        <Row label="端口" value={meta.port === null ? null : String(meta.port)} />
        <Row
          label="服务目录"
          value={meta.servicePath}
          mono
          hint="交付物的边界与 docker build 的上下文(仓库内相对路径)。仓库根还含 artifacts/ 与 work/,所以构建上下文不能是仓库根。"
        />
        <Row label="分支" value={meta.branch} mono />
        <Row
          label="交付版本"
          value={
            delivered === null
              ? null
              : `${delivered}${meta.deliverableSubject !== null ? ` ${meta.deliverableSubject}` : ""}`
          }
          mono
          hint="最后触及服务目录的提交 = 这版交付物。与 HEAD 不是一回事:平台每回合写工件都会让 HEAD 动,而交付物可能没变。"
        />
        <Row
          label="HEAD"
          value={head === null ? null : `${head}${meta.headSubject !== null ? ` ${meta.headSubject}` : ""}`}
          mono
          hint="交付那一刻的仓库现场(模型照抄 git rev-parse HEAD,写入时核对过)。"
        />
        <Row
          label="交付提交数"
          value={meta.commitCount === null ? null : String(meta.commitCount)}
          hint="按服务目录算(git rev-list --count HEAD -- <servicePath>),不是整个仓库的提交数。"
        />
        <Row label="Dockerfile" value={meta.dockerfile} mono />
        <Row label="仓库" value={meta.repoPath} mono hint="项目仓的根 —— 交付物是它里面的一个目录。" />
      </div>

      <div className="ss-note">
        「交付版本」= 最后触及**服务目录**的提交(这版交付物是什么);「HEAD」= 交付那一刻的
        仓库现场。两者不同是正常的 —— 平台每回合都写工件正文并提交,HEAD 一直在动。
      </div>

      {/*
        §3.2d:服务目录里被 `.gitignore` 忽略的条目**不会**出现在甲方 clone 到的东西里
        ⇒ 交付物静默残缺。`node_modules` 这类是正常的,所以**告警不拒绝**,但必须列出来。
        空数组 = 没有(`service === null` 时也是空 —— 那时坐标整体读不到,不编任何断言)。
      */}
      {meta.ignoredFiles.length > 0 && (
        <div
          className="ss-note"
          data-ignored-files={meta.ignoredFiles.length}
          style={{ borderLeft: "2px solid var(--amber)", paddingLeft: 8 }}
          title="交付物 = 被 git 跟踪的文件。这些被 .gitignore 忽略,甲方 clone 不到 —— 正常的(node_modules / 构建产物)也在其中,所以这是告警不是错误。"
        >
          ⚠️ 交付物**会缺**这 {meta.ignoredFiles.length} 项(被 `.gitignore` 忽略,甲方 clone 不到):
          <div
            className="ss-body"
            style={{ fontSize: 12, color: "var(--bone-dim)", wordBreak: "break-all", marginTop: 2 }}
          >
            {meta.ignoredFiles.join(" · ")}
          </div>
        </div>
      )}

      {cmds === null ? (
        <div className="ss-meta" style={{ color: "var(--cinnabar, #b4483c)" }}>
          服务名、端口或服务目录读不到,所以**不生成部署命令** —— 编一个默认值会让你照着一条错的
          命令去部署(构建上下文写错时,镜像里会混进内部工作区)。
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="ss-meta">在仓库根目录执行(构建上下文 = 交付物边界):</div>
          <Command text={cmds.build} />
          <Command text={cmds.run} />
          <div className="ss-meta">
            这两条命令由**核实过的坐标**生成(端口与服务目录来自交付物本身),不是模型手写的。
          </div>
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        <div className="ss-meta">
          最近提交(现读,不是交付时的快照;按服务目录过滤)
        </div>
        <CommitList artifactId={artifactId} />
      </div>

      {meta.files.length > 0 && (
        <div className="flex flex-col gap-0.5">
          <div className="ss-meta">服务目录的一级条目:</div>
          <div className="ss-body" style={{ fontSize: 12, color: "var(--bone-dim)", wordBreak: "break-all" }}>
            {meta.files.join(" · ")}
          </div>
        </div>
      )}

      <div className="ss-section" style={{ fontSize: 12 }}>
        说明
      </div>
      <ServiceBody artifactId={artifactId} at={at} />
    </div>
  );
});
