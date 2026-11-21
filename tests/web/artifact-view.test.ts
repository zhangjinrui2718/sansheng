/**
 * 工件 view 能力(v5 Wave B,2026-11-20)—— markdown 化 + 流内展开 + 交付时点文件树
 *
 * 三条判据,各有一个「写反了是空白/漂移」的失败形态:
 *   ① **markdown 化**:正文本来就是 markdown(存量交付物 / code_service 说明),
 *      裸 `<pre>` 把标题与表格印成字面量;渲染器与对话同款(清洗边界 shared/lib/markdown.ts)。
 *   ② **流内展开**:验收卡的「查看正文」懒加载 —— 点开才挂正文组件(流不背常驻请求),
 *      分发走 `bodyMode` 唯一判据(deliverable-render.test.ts 的老朋友)。
 *   ③ **交付时点文件树**:树读 `deliverableCommit`,不读 HEAD —— 平台提交工件
 *      不让「交付的东西」漂动(端点侧判据在 code-service-http.test.ts)。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CodeServiceFilesView } from "../../shared/types/platform";
import type { AwaitingAcceptanceView } from "../../shared/types/platform";
import { FileTreeView } from "../../web/src/components/deliverable/CodeService";
import { ActionRail } from "../../web/src/features/chat/ActionRail";

const WEB_SRC = join(process.cwd(), "web/src");
const source = (rel: string): string =>
  readFileSync(join(WEB_SRC, rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

// ── ① markdown 化 ────────────────────────────────────────────────

describe("① 正文按 markdown 渲染(裸 <pre> 退场)", () => {
  it("ArtifactTextBody 用对话同款渲染器(清洗边界在 shared/lib/markdown.ts,不另立一份)", () => {
    const s = source("components/deliverable/ArtifactTextBody.tsx");
    expect(s).toContain("<Markdown text={data.content} />");
    expect(s).not.toMatch(/<pre/); // 字面量形态退场
    // 三态纪律逐字继承:读不到 ≠ 空正文
    expect(s).toContain("data-content-runtime=\"unavailable\"");
    expect(s).toContain("这条工件的正文是空的。");
  });

  it("CodeService 的说明正文同样 markdown 化(它本来就是 markdown 说明)", () => {
    const s = source("components/deliverable/CodeService.tsx");
    expect(s).toMatch(/<Markdown text=\{data\.content\}/);
  });

  it("★ 文件树真的挂在 CodeService 上(拆掉挂载点 = 「工程师交的东西」看不了,哨兵当场红)", () => {
    const s = source("components/deliverable/CodeService.tsx");
    expect(s).toContain("<FileTree artifactId={artifactId} />");
    // 旧的一级条目拼接行不许回来(同一个事实两处说必然漂)
    expect(s).not.toContain("服务目录的一级条目");
  });

  it("Works 的抽屉分发指向共享的 ArtifactTextBody(判据搬家 ≠ 改写)", () => {
    const works = source("routes/Works.tsx");
    expect(works).toContain("<ArtifactTextBody artifactId={artifact.id} />");
    expect(works).not.toMatch(/function TextArtifactBody/); // 旧定义退场(不出现两份)
  });
});

// ── ② 流内展开(懒加载)─────────────────────────────────────────

describe("② 验收卡的「查看正文」(懒加载,bodyMode 唯一分发)", () => {
  const acc: AwaitingAcceptanceView = {
    artifactId: "art_v",
    title: "最终交付物",
    deliveredAt: 1,
    deliverableType: "html_report",
  };

  it("行动区收起态:只有按钮,不挂正文(流不背常驻请求;展开态挂 InlineDeliverableBody)", () => {
    // V2(2026-11-21):验收操作从流内卡搬进**行动区**(输入区上方),判据不变。
    const rail = renderToStaticMarkup(
      createElement(ActionRail, {
        actions: [{ type: "acceptance", at: 1, a: acc }],
        unavailable: null,
        plan: null,
      }),
    );
    expect(rail).toContain("验收");
    expect(rail).not.toContain("读取工件详情"); // 没点开就不取详情
    // 2026-11-21:验收面板抽成共享件(components/deliverable/AcceptancePanel),
    // 行动区与工件序列页两处消费 —— 动作只有一份实现。
    const s = source("components/deliverable/AcceptancePanel.tsx");
    expect(s).toContain("{showBody && <InlineDeliverableBody");
  });

  it("展开的分发只走 bodyMode(不另立第二份类型判据)", () => {
    const s = source("components/deliverable/InlineDeliverableBody.tsx");
    expect(s).toContain("bodyMode(artifact)");
    expect(s).toMatch(/case "html_report"/);
    expect(s).toMatch(/case "code_service"/);
    expect(s).toMatch(/case "text"/);
  });
});

// ── ③ 交付时点文件树(渲染侧四态;端点侧在 code-service-http.test.ts)──

describe("③ FileTreeView · 四态(读不到 ≠ 没有文件)", () => {
  const ok = (files: string[]): CodeServiceFilesView => ({ runtime: "ok", commit: "abc1234", files });
  const renderTree = (data: CodeServiceFilesView | null, error: string | null = null) =>
    renderToStaticMarkup(
      createElement(FileTreeView, { data, error, selected: null, onSelect: () => {} }),
    );

  it("读失败(请求层)⇒ 如实说,不是空列表", () => {
    const html = renderTree(null, "boom");
    expect(html).toContain("读不到文件树:boom");
  });

  it("还在读 ⇒ 「读取交付文件树…」(没拿到终值不说「没有」)", () => {
    expect(renderTree(null)).toContain("读取文件树…");
  });

  it("unavailable ⇒ 带 runtime 标记 + problem,**不许**渲染成「一个文件都没有」", () => {
    const html = renderTree({ runtime: "unavailable", commit: null, files: null, problem: "提交已不可达" });
    expect(html).toContain('data-files-runtime="unavailable"');
    expect(html).toContain("提交已不可达");
    expect(html).not.toContain("一个文件都没有");
  });

  it("ok + 空列表 ⇒ 「一个文件都没有」(这是真的没有;与上一条是**不同的答案**)", () => {
    expect(renderTree(ok([]))).toContain("一个文件都没有");
  });

  it("ok + 有文件 ⇒ 逐文件可点(相对路径;目录深度缩进)", () => {
    const html = renderTree(ok(["Dockerfile", "src/index.ts", "src/util/format.ts"]));
    expect(html).toContain("Dockerfile");
    expect(html).toContain("index.ts");
    expect(html).toContain("format.ts");
    expect(html.match(/data-role="file-tree"/)).toBeTruthy();
    // 目录前缀作为深度的辅助信息显示(纯路径行会让人数斜杠)
    expect(html).toContain("src");
  });
});
