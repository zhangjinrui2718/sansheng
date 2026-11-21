/**
 * 甲方对话面去角色化(v5 Wave C,2026-11-20)
 *
 * **用户裁决**:「和用户交互的地方不需要突出业务经理啥的,就让用户当成一个
 * 对话能力的东西就好了。」对话里只有一个声音 —— 「三生」(或 personaName)。
 *
 * ── 判据与边界 ────────────────────────────────────────────────
 *
 *   · **扫的是字面量**(剥注释后):五个角色中文名不许出现在甲方对话面的源码里。
 *     数据驱动的名字(`askedByName` 等)不在扫描范围 —— 那一侧的处置是卡头
 *     不再打印它(见 ClientQuestionCard)。
 *   · **范围 = 甲方对话面**:`features/chat/**`(流与工作台)+ 
 *     `features/chat/**`(提问卡等甲方动作面)+ `components/deliverable/**`
 *     (交付物查看,现在就长在流里)+ `components/shell/HistoryRail.tsx`(工作台左栏)。
 *   · **明确不扫**:成员页 / 工作项页 / harness / 词汇表 / 关于页 —— 那是**内部视图**
 *     (给用户自己看的组织现场),角色名在那里是事实,不是人格泄漏。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const WEB_SRC = join(process.cwd(), "web/src");

/** 与 annotation-budget 同一条剥注释纪律(注释里讨论反面教材不算违规)。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(p);
  }
  return out;
}

const PERSONA_DIRS = [
  "features/chat",
  "components/deliverable",
];
/** 左栏是工作台的一部分(对话页三件套之一),单列。 */
const PERSONA_FILES = ["components/shell/HistoryRail.tsx"];

const ROLE_NAMES = ["业务经理", "项目经理", "研究员", "工程师", "质检"] as const;

const files = [
  ...PERSONA_DIRS.flatMap((d) => walk(join(WEB_SRC, d))),
  ...PERSONA_FILES.map((f) => join(WEB_SRC, f)),
].map((abs) => relative(WEB_SRC, abs));

describe("甲方对话面 · 角色名零字面量", () => {
  it("扫描范围里有文件(仪器对着空气 = 假绿)", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain("features/chat/ChatSurface.tsx");
    expect(files).toContain("features/chat/MessageList.tsx");
    expect(files).toContain("components/deliverable/DeliveryVerdictActions.tsx");
    expect(files).toContain("components/shell/HistoryRail.tsx");
  });

  it("五个角色中文名一个都不出现(剥注释后)", () => {
    const offenders: string[] = [];
    for (const rel of files) {
      const src = stripComments(readFileSync(join(WEB_SRC, rel), "utf8"));
      for (const name of ROLE_NAMES) {
        if (src.includes(name)) offenders.push(`${rel}: ${name}`);
      }
    }
    expect(offenders.join("\n")).toBe("");
  });

  it("自检:剥注释必须真的起作用(已知注释样本要被剥掉,否则 ① 是假绿)", () => {
    // components/chat 的文件头注释里到处是「业务经理」(设计记录)——
    // 如果剥离失效,上面那条会红;这条用合成样本直接验剥离器。
    const withBlock = "/* 业务经理 */ const a = 1;";
    const withLine = "// 业务经理\nconst b = 2;";
    expect(stripComments(withBlock)).not.toContain("业务经理");
    expect(stripComments(withLine)).not.toContain("业务经理");
    // 负样本:字符串字面量**不**被剥(它就是屏上的字)
    expect(stripComments("const c = \"业务经理\";")).toContain("业务经理");
  });

  it("内部视图保留角色名(范围判据的反面:不要把内部现场也洗掉)", () => {
    const vocab = stripComments(readFileSync(join(WEB_SRC, "lib/vocab.ts"), "utf8"));
    // ROLE_LABEL 是成员页/内部视图的兜底表 —— 它必须**继续**有角色名
    expect(vocab).toContain("业务经理");
  });
});
