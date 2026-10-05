/**
 * 批次 UI · U2 —— C10「UI 死代码/空头承诺」静态守护
 * (docs/CODE-REVIEW-2026-10-01.md §C10)
 *
 * §C10 列的 5 项里,有几项的本质是「文案/结构承诺了数据面并不存在的东西」,
 * 它们在运行时不会报错,只会静默骗用户。本文件把它们固化成可执行的断言,
 * 防止下一批又把空头承诺写回 UI:
 *
 *   1. `as any`(AGENTS.md 硬规则,web 侧曾在 ToolCallCard.tsx 出现)—— 全仓 0。
 *   2. Agents 页 / AgentPanel 轮询 legacy `GET /api/blackboard/:id`
 *      (upsertBlackboard 全仓无调用方 → 恒 null)—— 不许再引用。
 *   3. TopBar 恒 0 的 currentUsage 渲染成常量文案「本轮 idle」—— 不许硬编码。
 *   4. ChatComposer 对用户承诺「Esc 中断」,但没有 keydown 接线 —— 要么真接线,
 *      要么不许出现这句承诺。
 *
 * 说明:web 侧本批**不引入**测试基建(无 vitest/jsdom DOM 环境),故这里走
 * 源码级断言(读文件 + 字符串判定),与 AGENTS.md「web 无测试基建」一致。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = process.cwd();
const WEB_SRC = join(REPO, "web/src");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

function read(rel: string): string {
  return readFileSync(join(WEB_SRC, rel), "utf8");
}

/** 去掉注释 —— 断言针对**代码**,注释里讨论被修的 bug 不该被判为违规。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const WEB_FILES = walk(WEB_SRC).map((p) => relative(REPO, p));

describe("C10 · web 侧 AGENTS.md 硬规则:as any = 0", () => {
  it("web/src 无 `as any` 断言", () => {
    const hits: string[] = [];
    for (const f of WEB_FILES) {
      const src = stripComments(readFileSync(f, "utf8"));
      src.split("\n").forEach((line, i) => {
        if (/as any\b/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("C10 · 不再轮询恒 null 的 legacy blackboard 端点", () => {
  it("routes/Members.tsx 不引用 `/api/blackboard/${...}` 单数端点", () => {
    const src = stripComments(read("routes/Members.tsx"));
    expect(src).not.toMatch(/\/api\/blackboard\/\$\{/);
  });

  it("components/shell/AgentPanel.tsx 不引用 `/api/blackboard/${...}` 单数端点", () => {
    const src = stripComments(read("components/shell/AgentPanel.tsx"));
    expect(src).not.toMatch(/\/api\/blackboard\/\$\{/);
  });
});

describe("C10 · TopBar 不再渲染恒 0 的 currentUsage 承诺", () => {
  it("TopBar 不含硬编码「本轮 idle」", () => {
    expect(stripComments(read("components/shell/TopBar.tsx"))).not.toContain("本轮 idle");
  });
});

describe("C10 · ChatComposer 的「Esc 中断」要么接线要么不承诺", () => {
  it("出现「Esc 中断」文案时必须同时有 Escape keydown 接线", () => {
    const src = stripComments(read("components/chat/ChatComposer.tsx"));
    const promisesEsc = src.includes("Esc 中断");
    const wired = /Escape/.test(src);
    expect(promisesEsc && !wired).toBe(false);
  });
});

// ── 2026-10-06 追加:两处「会静默说假话」的接线,用源码级断言守住 ──────────
//
// 这两条的失效形态都是**屏幕上说着与事实相反的话**,而没有任何运行时报错 ——
// 正是 §C10 要抓的那一类。web 侧没有 jsdom(见文件头),所以仍然走源码级断言:
// 断言的是「接线在不在」,不是「渲染出来长什么样」(后者由各自页面的 SSR 测试管)。
describe("C10 追加 · 两处诚实接线不许被顺手删掉", () => {
  const members = readFileSync(join(WEB_SRC, "routes/Members.tsx"), "utf8");

  it("① 成员页把对话端点的错误传进面板(「读不到」≠「没有发言」)", () => {
    expect(
      /conversationError=\{conversations\.error\}/.test(members),
      "Members.tsx 必须把 conversations.error 传给 MemberPane —— 删掉它,端点失败时" +
        "每个人的对话块都会显示「还没有发言。」(0 条),而那句话是假的",
    ).toBe(true);
    // 正样本自检:同一条正则对一个**必然不匹配**的串要给 false(防止这条断言恒真)
    expect(/conversationError=\{conversations\.error\}/.test("conversationError={null}")).toBe(false);
  });

  it("② 面板里保存 harness 之后,页签角标那一份必须重取(revision 要接上)", () => {
    expect(
      /useHarnessRoles\(\{\s*revision:\s*harnessRevision\s*\}\)/.test(members),
      "Members.tsx 必须用 revision 驱动 useHarnessRoles —— 否则保存之后角标会一直" +
        "显示旧的「N 处需要注意」,而用户刚把它修完",
    ).toBe(true);
    expect(
      /onHarnessSaved=\{\(\)\s*=>\s*setHarnessRevision/.test(members),
      "保存成功后的通知没有接上(setHarnessRevision)",
    ).toBe(true);
    // 负样本自检:这两个模式都不是「随便什么串都能过」
    expect(/useHarnessRoles\(\{\s*revision:\s*harnessRevision\s*\}\)/.test("const h = useHarnessRoles();")).toBe(false);
    expect(/onHarnessSaved=\{\(\)\s*=>\s*setHarnessRevision/.test("onHarnessSaved={noop}")).toBe(false);
  });
});
