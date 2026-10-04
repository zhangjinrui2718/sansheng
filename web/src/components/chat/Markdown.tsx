/**
 * markdown 正文块(会话里模型输出的渲染面)
 *
 * ⚠️ **唯一的 `dangerouslySetInnerHTML`。** 安全性不来自事后过滤,而来自
 * `web/src/lib/markdown.ts` 里 micromark 的默认配置:裸 HTML 一律转义、
 * `javascript:` / `data:` / `vbscript:` 链接一律降级为 `href=""`。
 * 那两条不变量由 `tests/web/markdown.test.ts` 逐条断言守住 —— 动渲染配置先跑它。
 *
 * `memo` + `useMemo` 是有用的:流式时每个 delta 都会重渲染当前轮,
 * 没有 memo 的话**每一屏的每一条消息**都会重新解析一遍 markdown(实测
 * 解析是这里最贵的一步)。
 */
import { memo, useMemo } from "react";
import { markdownToHtml } from "@/lib/markdown";

interface Props {
  text: string;
  /** 流式中的正文:未写完的最后一行表格行会被掐掉(见 lib/markdown.ts 文件头)。 */
  streaming?: boolean;
}

export const Markdown = memo(function Markdown({ text, streaming = false }: Props) {
  const html = useMemo(() => markdownToHtml(text, streaming), [text, streaming]);
  if (html.length === 0) return null;
  return <div className="ss-md" dangerouslySetInnerHTML={{ __html: html }} />;
});
