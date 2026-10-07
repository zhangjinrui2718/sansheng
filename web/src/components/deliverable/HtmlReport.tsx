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
 * ⚠️ **脚本不执行是设计的一部分,不是缺陷。** 所以 `validateHtmlReport`
 * (仓储层)在写入时就拒绝带 `<script>` / `<iframe>` 的正文 —— 让模型在
 * 写的时候就拿到一条可执行的处置,而不是甲方那边收到一页空白
 * (7-N:见不到现场等于没有现场)。
 *
 * ── 「在新窗口打开」为什么是**下载**而不是 `window.open` ──────────────
 *
 * `window.open(blobUrl)` 打开的页面**没有 sandbox**(blob URL 继承创建者的
 * 来源),等于给内容开了一条能跑脚本、能读本应用存储的路。
 * 「汇报材料要发出去」这个真实需求由**下载 .html 文件**满足 ——
 * 用户在浏览器里打开自己的文件,那是他自己的上下文。
 */
import { memo, useCallback, useMemo, useRef, useState } from "react";

/** 预览区初始高度(px)。iframe 内部滚动,所以这个值只决定「不滚动时露出多少」。 */
const DEFAULT_HEIGHT = 560;

export interface HtmlReportProps {
  /** 工件正文 —— 一份自包含的 HTML 文档(仓储层已校验过)。 */
  html: string;
  /** 下载文件名。不给就用通用名。 */
  fileName?: string;
}

/**
 * 一份 HTML 报告的渲染 + 下载。
 *
 * memo 的理由:工件详情面板会因为父级任一 state 变化而重渲染,而 iframe 的
 * `srcDoc` 变化会**整页重新加载** —— 一份带内联 SVG 架构图的报告重新解析
 * 一次不是免费的,所以正文没变就别让它重载。
 */
export const HtmlReport = memo(function HtmlReport({ html, fileName }: HtmlReportProps) {
  const [expanded, setExpanded] = useState(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

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

  const sandbox = useMemo(() => "" as const, []);

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

      <iframe
        ref={frameRef}
        // ⚠️ 见文件头:空值 sandbox 是这一段的全部安全依据,不要为了「让报告
        // 能用图表库」而加 allow-scripts —— 那等于把本应用来源交出去。
        sandbox={sandbox}
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