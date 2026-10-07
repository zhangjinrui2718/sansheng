/**
 * 交付物 · `html_report` 的渲染面
 *
 * ── 为什么是 `<iframe sandbox="" srcDoc>` 而不是 dangerouslySetInnerHTML ──
 *
 * 这一页的内容是**模型写的 HTML**。而模型会照抄它读过的东西 —— worker 从
 * 网上抓的文档、抓到的网页片段,都可能把一段 `<script>` 或恶意标记带进来。
 * 所以「这是我自己人写的」**不能**当成安全依据。
 *
 * 三种做法的取舍:
 *
 *   ① `dangerouslySetInnerHTML` + 事后过滤  → 少写一次过滤就是 XSS。
 *      本项目已经因为这个理由在 `lib/markdown.ts` 选过 micromark 而不是 marked:
 *      「安全性不来自事后过滤,而来自编译器结构上不产生危险 HTML」。
 *   ② `<iframe sandbox="" srcDoc>`          → **本文件**。
 *      空值 sandbox 的语义是:脚本、表单、弹窗、`allow-same-origin`
 *      全部关闭,且该 frame 拿到一个**不透明来源**(opaque origin)——
 *      它拿不到本应用的 DOM、cookie、localStorage,`document.cookie` 是空的。
 *      于是即使内容里塞了 `<script>`,它能碰到的也只有一个空文档。
 *      **这是结构性保证,不是过滤器**:改这个属性等于改掉这一段论证。
 *   ③ `<iframe srcdoc>` 不写 sandbox        → 脚本在本应用来源下执行,
 *      `localStorage`、DOM、WS 全都够得着。**绝对不做**(见下面的「新窗口」)。
 *
 * ⚠️ **`<iframe src="/api/artifacts/:id/content">` 同样是 ③。**
 * 正文改成**现读**之后(设计 `docs/DESIGN-WORKSPACE.md` §4.2:正文住项目仓里
 * 一份文件,不再随列表下发),最容易顺手写成的一条是「那让 iframe 直接去 GET
 * 那个端点好了」—— 那条端点与页面**同源**,于是模型写的 HTML 拿到了本应用的
 * 来源,`sandbox` 连表达「不透明来源」的机会都没有。所以正文**必须**先 fetch
 * 成文本、再经 `srcDoc` 喂进来:`sandbox=""` 是结构性保证,不是过滤器。
 *
 * ⚠️ **脚本不执行是设计的一部分,不是缺陷。** 所以 `validateHtmlReport`
 * (仓储层)在写入时就拒绝带 `<script>` / `<iframe>` 的正文 —— 让模型在
 * 写的时候就拿到一条可执行的处置,而不是甲方那边收到一页空白
 * (7-N:见不到现场等于没有现场)。
 *
 * ── 读不到正文时显示什么 ────────────────────────────────────────
 *
 * `GET /api/artifacts/:id/content` 的 `runtime: "unavailable"` 是**读不到**
 * (文件被删 / 被回滚 / `at` 不可达),**不是空正文**。「读不到」与「报告是空的」
 * 在屏幕上长得一模一样,而处置完全相反 —— 所以本文件把 `problem` 那一行印出来,
 * 并且**根本不渲染 iframe**(空 iframe 会把一次读失败说成「这份报告没有内容」)。
 *
 * ── 「在新窗口打开」为什么是**下载**而不是 `window.open` ──────────────
 *
 * `window.open(blobUrl)` 打开的页面**没有 sandbox**(blob URL 继承创建者的
 * 来源),等于给内容开了一条能跑脚本、能读本应用存储的路。
 * 「汇报材料要发出去」这个真实需求由**下载 .html 文件**满足 ——
 * 用户在浏览器里打开自己的文件,那是他自己的上下文。
 */
import { memo, useCallback, useRef, useState } from "react";
import { useArtifactContent } from "@/lib/data";

/** 预览区初始高度(px)。iframe 内部滚动,所以这个值只决定「不滚动时露出多少」。 */
const DEFAULT_HEIGHT = 560;

export interface HtmlReportProps {
  /**
   * 工件 id —— 正文**现读** `GET /api/artifacts/:id/content`(设计 §4.2)。
   *
   * ⚠️ 这里刻意**不收一个 `html: string` 入参**:那让调用方能把空串传进来,
   * 于是一次读失败在屏幕上就是一页空白 —— 而空白看起来像「这份报告本来就没有
   * 内容」。读取由本组件持有,「读不到」才只有一个落点(下面的 problem 行)。
   */
  artifactId: string;
  /** 读哪一版(提交 sha,`?at=`);省略 = 读 HEAD。 */
  at?: string;
  /** 下载文件名。不给就用通用名。 */
  fileName?: string;
}

/** 「读不到」那一行 —— 三态里唯一不许被跳过的一态。 */
function ContentProblem({
  text,
  detail,
  runtime,
}: {
  text: string;
  detail?: string;
  /** 判别键只给测试用:端点说读不到 vs 请求本身失败。 */
  runtime: "unavailable" | "error";
}) {
  return (
    <div
      className="sansheng-card p-3 text-xs flex flex-col gap-0.5"
      style={{ color: "var(--cinnabar, #b4483c)" }}
      data-content-runtime={runtime}
    >
      <span>{text}</span>
      {detail !== undefined && <span className="ss-meta">{detail}</span>}
    </div>
  );
}

/**
 * 一份 HTML 报告的渲染 + 下载。
 *
 * memo 的理由:工件详情面板会因为父级任一 state 变化而重渲染,而 iframe 的
 * `srcDoc` 变化会**整页重新加载** —— 一份带内联 SVG 架构图的报告重新解析
 * 一次不是免费的,所以正文没变就别让它重载。
 */
export const HtmlReport = memo(function HtmlReport({ artifactId, at, fileName }: HtmlReportProps) {
  const [expanded, setExpanded] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const { data, loading, error } = useArtifactContent(artifactId, at ?? null);

  // 只有真的读到了正文才把 `html` 交给 iframe;读不到时下面会提前返回,
  // `srcDoc` 拿不到空串这条路(见 `ContentProblem`)。
  const html = data !== null && data.runtime === "ok" ? data.content : "";

  const height = expanded ? Math.max(DEFAULT_HEIGHT * 2, 900) : DEFAULT_HEIGHT;

  /**
   * 下载成 `.html` 文件。
   *
   * `URL.createObjectURL` 造出来的 blob URL **继承本应用的来源**,所以只拿它
   * 当 `<a download>` 的目标(浏览器直接下载,页面不执行),**绝不**拿去
   * `window.open` —— 见文件头那段。
   */
  const download = useCallback(() => {
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName ?? "交付报告.html";
    document.body.appendChild(a);
    a.click();
    a.remove();
    // 立刻 revoke 会让部分浏览器的下载中断,延后一拍。
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, [html, fileName]);

  /** iframe 里滚到底时,外层跟着长高 —— 报告通常比一屏长。 */
  const onLoad = useCallback(() => {
    const doc = frameRef.current?.contentDocument;
    if (doc === null || doc === undefined) return;
    // 存根(状态=open)里 contentDocument 是 null:sandbox 不给 same-origin 时
    // 父文档读不到子文档。这正是我们要的 —— 读不到就保持固定高度,不出错。
    const sync = (): void => {
      const el = frameRef.current;
      if (el === null) return;
      const h = Math.max(doc.documentElement?.scrollHeight ?? 0, doc.body?.scrollHeight ?? 0);
      if (h > 0) el.style.height = `${Math.min(h + 8, 8000)}px`;
    };
    sync();
    doc.addEventListener("DOMContentLoaded", sync);
  }, []);

  if (error !== null) {
    return (
      <div className="flex flex-col gap-1" data-deliverable-type="html_report">
        <ContentProblem text={`读不到这份报告的正文:${error}`} runtime="error" />
      </div>
    );
  }

  if (loading || data === null) {
    return (
      <div className="flex flex-col gap-1" data-deliverable-type="html_report">
        <div className="ss-meta">读取正文…</div>
      </div>
    );
  }

  if (data.runtime !== "ok") {
    // 「读不到」**不是**空正文:这一行是两者的分界线,不许被空 iframe 替代。
    return (
      <div className="flex flex-col gap-1" data-deliverable-type="html_report">
        <ContentProblem
          text={`**读不到**这份报告的正文 —— ${data.problem ?? "原因未说明"}。`}
          detail={`(这不是「报告是空的」,是这一次读不到。正文落点:${data.path})`}
          runtime="unavailable"
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1" data-deliverable-type="html_report">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          className="sansheng-button"
          onClick={download}
          title="把这份报告存成 .html 文件(自带样式,可直接发给别人)"
        >
          下载 .html
        </button>
        <button
          type="button"
          className="sansheng-button"
          onClick={() => setExpanded((v) => !v)}
          title="在「一屏」与「整篇」两种高度之间切换"
        >
          {expanded ? "收起" : "展开整篇"}
        </button>
        <span className="ss-meta">
          沙箱渲染:脚本 / 表单 / 外链一律不执行
        </span>
      </div>

      {/*
        ⚠️ 正文是**现读**来的(useArtifactContent),但**必须**经 `srcDoc` 喂进
        这个 frame,`sandbox` 也**必须**保持空值。把它改成 `<iframe src=...>` 就
        让模型写的 HTML 与应用同源 —— 那正是文件头 ③ 描述的形态。
      */}
      <iframe
        ref={frameRef}
        // ⚠️ 见文件头:空值 sandbox 是这一段的全部安全依据,不要为了「让报告
        // 能用图表库」而加 allow-scripts —— 那等于把本应用来源交出去。
        sandbox=""
        srcDoc={html}
        title="HTML 交付报告"
        onLoad={onLoad}
        style={{
          width: "100%",
          height,
          border: "1px solid var(--ink-3)",
          borderRadius: 6,
          background: "#ffffff",
          display: "block",
          transition: "height .15s ease",
        }}
      />
    </div>
  );
});
