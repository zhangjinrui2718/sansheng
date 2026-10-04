/**
 * 消息渲染面 —— 把「业务经理的输出此前是裸文本」这件事钉在组件层
 *
 * 上一批的 markdown 探针是**运行时探针**(手工喂字符串看输出);这里把它变成真测试,
 * 并且穿过真实组件(Bubble → Markdown),而不只是调 `lib/markdown.ts` —— 这一批
 * 最容易漏的一环不是解析,而是「组件有没有真的用上它」「哪一类块该用、哪一类不该用」。
 *
 * 形态:node 环境 + `react-dom/server` 的 `renderToStaticMarkup`,**不引 jsdom/RTL**
 * (react-dom 本来就是运行时依赖,SSR 不需要 DOM;`useEffect` 在 SSR 下不执行,
 * 所以滚动那部分天然不参与 —— 它另走 `tests/web/scroll.test.ts` 的纯函数测试)。
 *
 * ⚠️ 渲染的是 `TurnView`(纯 props)而**不是** `MessageList`:后者从 zustand store
 * 取数据,而 zustand 在 SSR 下用的是 server snapshot(`getServerState || getInitialState`
 * —— store 创建时的初值),`setState` 再多次也读不到(实测:渲染出来永远是空态)。
 * JSX 也不能用 —— vitest 的 include 只收 `*.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TurnView } from "@/components/chat/MessageList";
import type { Turn } from "@/stores/chat";

function turn(role: Turn["role"], blocks: Turn["blocks"]): Turn {
  return { id: "t1", role, blocks, startedAt: 0 };
}

function render(role: Turn["role"], blocks: Turn["blocks"], streaming = false): string {
  return renderToStaticMarkup(createElement(TurnView, { turn: turn(role, blocks), streaming }));
}

const MD = "| 模块 | 优先级 |\n| --- | --- |\n| 认证 | **P0** |";

describe("消息渲染 · 助手正文按 markdown 渲染(此前是裸文本)", () => {
  it("表格 / 加粗 / 任务列表 / 代码块都进了 DOM,不再是字面量", () => {
    const html = render("assistant", [
      {
        kind: "text",
        text: `${MD}\n\n- [x] 已办\n\n**加粗**\n\n\`\`\`js\nconst x = 1\n\`\`\``,
      },
    ]);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>模块</th>");
    expect(html).toContain("<strong>P0</strong>");
    // React 反序列化后再序列化,自闭合标签会带上空格
    expect(html).toContain('<input type="checkbox" disabled="" checked="" />');
    expect(html).toContain('<code class="language-js">');
    // 未渲染成 markdown 时,这些会以字面量出现在屏幕上
    expect(html).not.toContain("**P0**");
    expect(html).not.toContain("| 模块 | 优先级 |");
  });

  it("模型输出里的裸 HTML / javascript: 链接不会变成活动的标签", () => {
    const html = render("assistant", [
      { kind: "text", text: "<script>alert(1)</script>\n\n[点我](javascript:alert(1))" },
    ]);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it("用户自己键入的那条按**字面**渲染(不替用户重排他打的字)", () => {
    const html = render("user", [{ kind: "text", text: `${MD}\n\n**加粗**` }]);
    expect(html).not.toContain("<table>");
    expect(html).toContain("**加粗**");
  });

  it("思维链**不**走 markdown(内部推理不是给用户看的正式输出)", () => {
    const html = render("assistant", [{ kind: "thinking", text: MD }]);
    expect(html).not.toContain("<table>");
    expect(html).toContain("思考");
  });
});

describe("消息渲染 · 流式中的未闭合表格不出现幽灵空单元格", () => {
  const PARTIAL = "| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n| 后续文字 |";

  it("流式中的最后一块:掐掉未写完的行(没有 <td></td>)", () => {
    const html = render("assistant", [{ kind: "text", text: PARTIAL }], true);
    expect(html).not.toContain("<td></td>");
    expect(html).toContain("<td>1</td>");
  });

  it("回合结束后(非流式)按完整内容渲染,不偷偷丢内容", () => {
    const html = render("assistant", [{ kind: "text", text: PARTIAL }], false);
    expect(html).toContain("后续文字");
  });
});
