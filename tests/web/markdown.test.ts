/**
 * 会话正文 markdown 渲染 —— 把「流式未闭合输入」的实测结论固化成测试
 *
 * 这一批的选型与安全边界都写在 `web/src/lib/markdown.ts` 的文件头里。这里守的是
 * 两组**必须一直成立**的性质:
 *
 *   ① **未闭合的流式输入永不抛异常**,且优雅降级。上一批已经用
 *      react-dom/server 逐阶段探过一遍;现在探针变成真测试,换实现也不能退化。
 *   ② **安全是结构性的**:裸 HTML 一律转义、危险协议链接一律降级成 `href=""`。
 *      任何一条红了,`Markdown.tsx` 里那处 `dangerouslySetInnerHTML` 就不再安全。
 *
 * 唯一需要**处置**的瑕疵是未闭合表格(GFM 会把列数不足的行补齐到表头列数,
 * 流式中表现为幽灵空单元格)—— 处置方式与依据见下面 "未闭合表格" 一节。
 */
import { describe, expect, it } from "vitest";
import { holdBackIncompleteTableRow, markdownToHtml } from "../../web/src/lib/markdown.js";

/** micromark 生成的表格在标签之间带换行;断言「形状」时先去掉换行。 */
const flat = (html: string): string => html.replace(/\n/g, "");

describe("markdown · 未闭合的流式输入不抛异常且优雅降级", () => {
  it("未闭合围栏代码块 → 开一个空代码块,不抛", () => {
    expect(() => markdownToHtml("```")).not.toThrow();
    expect(markdownToHtml("```")).toBe("<pre><code></code></pre>\n");
    expect(markdownToHtml("```ts\nconst a = 1;")).toBe(
      '<pre><code class="language-ts">const a = 1;\n</code></pre>\n',
    );
  });

  it("代码块闭合后,后续普通文字仍是 <p>", () => {
    const html = markdownToHtml("```\ncode\n```\n后续普通文字");
    expect(html).toContain("<pre><code>code\n</code></pre>");
    expect(html).toContain("<p>后续普通文字</p>");
  });

  it("未闭合加粗 → 字面量", () => {
    expect(markdownToHtml("这是 **加粗")).toBe("<p>这是 **加粗</p>");
  });

  it("未闭合行内代码 → 字面量", () => {
    expect(markdownToHtml("这是 `行内代码")).toBe("<p>这是 `行内代码</p>");
  });

  it("未闭合链接 → 链接成立、标题是字面量(不抛)", () => {
    const html = markdownToHtml("这是 [链接](http://x");
    expect(html).toContain('href="http://x"');
    expect(html).toContain("这是 [链接](");
  });
});

describe("markdown · 未闭合表格(唯一的真瑕疵)与其处置", () => {
  const TABLE_THEN_PARTIAL_ROW = "| 列A | 列B |\n| --- | --- |\n| 1 | 2 |\n| 后续文字 |";

  it("非流式:GFM 语义是「补齐到表头列数」,我们**不改写**模型写下的内容", () => {
    const html = markdownToHtml(TABLE_THEN_PARTIAL_ROW, false);
    // 这是 GFM 的表格语义(列数不足补齐),不是解析器 bug —— 行已写完时保持原样。
    expect(flat(html)).toContain("<td>后续文字</td><td></td>");
  });

  it("流式:掐掉未写完的最后一行 → 幽灵空单元格不出现,已写完的行照常渲染", () => {
    const html = flat(markdownToHtml(TABLE_THEN_PARTIAL_ROW, true));
    expect(html).not.toContain("<td></td>");
    expect(html).not.toContain("后续文字");
    // 已写完的部分不受影响
    expect(html).toContain("<th>列A</th>");
    expect(html).toContain("<td>1</td><td>2</td>");
  });

  it("流式:行一旦写完(有换行),按完整行渲染", () => {
    const html = markdownToHtml("| 列A | 列B |\n| --- | --- |\n| 后续文字 |\n", true);
    expect(html).toContain("<td>后续文字</td>");
  });

  it("holdBackIncompleteTableRow 的判据(纯函数边界)", () => {
    // 没有换行结尾 + 最后一行是表格行 → 掐掉那一行
    expect(holdBackIncompleteTableRow("上文\n| 半行")).toBe("上文\n");
    // 已经有换行结尾 = 这一行写完了 → 不动
    expect(holdBackIncompleteTableRow("上文\n| 半行\n")).toBe("上文\n| 半行\n");
    // 不是表格行 → 不动(普通段落流式时不该被吃掉)
    expect(holdBackIncompleteTableRow("上文\n普通文字")).toBe("上文\n普通文字");
    // GFM 表格行最多缩进 3 个空格;4 个空格是缩进代码块,不能当表格行掐
    expect(holdBackIncompleteTableRow("文中\n   | 半行")).toBe("文中\n");
    expect(holdBackIncompleteTableRow("文中\n    | 这是缩进代码块")).toBe(
      "文中\n    | 这是缩进代码块",
    );
    // 空串与纯表格首行
    expect(holdBackIncompleteTableRow("")).toBe("");
    expect(holdBackIncompleteTableRow("| a | b |")).toBe("");
  });
});

describe("markdown · GFM 能力(表格 / 任务列表 / 自动链接 / 代码块)", () => {
  const SAMPLE = [
    "| 事项 | 状态 |",
    "| --- | --- |",
    "| 立项 | 完成 |",
    "",
    "- [x] 已办",
    "- [ ] 待办",
    "",
    "自动链接 https://example.com/a?b=1",
    "",
    "```js",
    "const x = 1",
    "```",
    "",
    "**加粗** 和 ~~删除线~~",
  ].join("\n");

  it("表格 / 任务列表 / 自动链接 / 围栏代码 / 行内样式都在", () => {
    const html = markdownToHtml(SAMPLE);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>事项</th>");
    expect(html).toContain("<td>立项</td>");
    expect(html).toContain('<input type="checkbox" disabled="" checked=""');
    expect(html).toContain('<a href="https://example.com/a?b=1">');
    expect(html).toContain('<code class="language-js">const x = 1');
    expect(html).toContain("<strong>加粗</strong>");
    expect(html).toContain("<del>删除线</del>");
  });

  it("空输入渲染成空串(调用点据此不渲染空 div)", () => {
    expect(markdownToHtml("")).toBe("");
  });
});

describe("markdown · 安全:这段内容是模型产出,可能被用户输入或抓来的网页影响", () => {
  it("裸 HTML 一律转义(默认 allowDangerousHtml: false)", () => {
    expect(markdownToHtml("hello <script>alert(1)</script>")).toBe(
      "<p>hello &lt;script&gt;alert(1)&lt;/script&gt;</p>",
    );
    expect(markdownToHtml("<img src=x onerror=alert(1)>")).toBe(
      "&lt;img src=x onerror=alert(1)&gt;",
    );
    expect(markdownToHtml('<a href="javascript:alert(1)">raw</a>')).not.toContain("<a href=");
  });

  it("裸 HTML 在表格单元格里同样被转义", () => {
    const html = markdownToHtml("| x |\n| --- |\n| <img src=x onerror=1> |");
    expect(html).toContain("&lt;img src=x onerror=1&gt;");
  });

  it("危险协议链接降级成 href=\"\"(大小写与尖括号包裹都不例外)", () => {
    for (const src of [
      "[click](javascript:alert(1))",
      "[click](jAvAsCrIpT:alert(1))",
      "[click](<javascript:alert(1)>)",
      "[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      "[click](vbscript:msgbox(1))",
    ]) {
      const html = markdownToHtml(src);
      expect(html).toContain('<a href="">click</a>');
      expect(html).not.toMatch(/href="(javascript|data|vbscript):/i);
    }
  });

  it("正常链接与其标题/引号仍然正确转义", () => {
    expect(markdownToHtml("[link](https://ok.example.com/p?a=1&b=2)")).toContain(
      '<a href="https://ok.example.com/p?a=1&amp;b=2">link</a>',
    );
    // 图片语法里的引号注入不成标签(整个残缺语法退化成转义后的字面量)
    expect(markdownToHtml('![img](x" onerror="alert(1))')).not.toContain("<img");
  });
});
