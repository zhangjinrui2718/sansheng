/**
 * 提示词卫生哨兵(2026-11-16)—— 出厂提示词里**不许混入 shell 代码**。
 *
 * ── 这组用例钉的是哪一次真事故 ────────────────────────────────────
 *
 * `methodology.core.md` 从创建(6d760c4)起,末尾就拖着 3 行 shell 垃圾
 * (`__zcode_status=$? … pwd -P > '/var/folders/…' … exit "$__zcode_status"`)
 * —— 编辑会话的终端退出状态跟踪代码被一起粘进了文件,而它作为三个干活
 * 角色共享的方法论提示词,**每天都在被喂给模型**。没有任何检查会红:
 * 提示词内容没有读者断言,垃圾行也不影响 typecheck。
 *
 * ── 判据 ──────────────────────────────────────────────────────────
 *
 * `harness/system_prompts/*.md` 里不许出现 shell 泄漏特征:
 *   · `__zcode_status`(本次事故的精确签名)
 *   · `pwd -P >`(工作目录跟踪重定向)
 *   · `$(`(命令替换 —— 提示词正文不需要执行任何命令)
 *   · `exit "` 后跟变量的裸 shell 退出语句
 *
 * ⚠️ 检测器自己也要有判据:正样本(历史上真实泄漏的那段)必须被抓到,
 * 负样本(含 `exit` / `$` 字样的正常中文)必须不被误伤 —— 否则检测器
 * 静默退化成永真函数,这组用例就只剩仪式感。
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "../../harness/system_prompts");

/** 单条泄漏特征:pattern + 为什么它是泄漏(报错时给得出人话)。 */
const JUNK_RULES: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /__zcode_status/, why: "终端退出状态跟踪变量(2026-11-16 真事故签名)" },
  { pattern: /pwd -P >/, why: "shell 的工作目录跟踪重定向" },
  { pattern: /\$\(/, why: "shell 命令替换 —— 提示词正文不执行命令" },
  { pattern: /exit\s+"\$\w+"/, why: "裸 shell 退出语句" },
];

/** 返回一个文件命中了哪些泄漏特征(空数组 = 干净)。 */
function junkHits(content: string): string[] {
  return JUNK_RULES.filter((r) => r.pattern.test(content)).map((r) => r.why);
}

describe("提示词卫生 · 出厂文件不许混入 shell 代码", () => {
  it("检测器自检:真实泄漏样本必须被抓到", () => {
    // 历史事故的逐字签名(6d760c4 引入,2026-11-16 清除)
    const leaked = [
      "__zcode_status=$?",
      "if [ \"$__zcode_status\" -eq 0 ]; then pwd -P > '/var/folders/x/cwd'; fi",
      "exit \"$__zcode_status\"",
    ].join("\n");
    const hits = junkHits(leaked);
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it("检测器自检:正常中文不误伤", () => {
    // 含 `exit` / `$` 字样但不是 shell 的正常提示词片段
    const legit = [
      "退出循环(exit)的条件是预算用尽。",
      "价格区间 $5 到 $10 之间。",
      "指标:第 1 波 10 辆坦克在 60 秒内被消灭。",
    ].join("\n");
    expect(junkHits(legit)).toEqual([]);
  });

  it("每个出厂提示词都干净(命中即报文件与原因)", () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
    expect(files.length).toBeGreaterThanOrEqual(15);
    const offenders: string[] = [];
    for (const f of files) {
      const hits = junkHits(readFileSync(join(DIR, f), "utf8"));
      if (hits.length > 0) offenders.push(`${f}: ${hits.join("; ")}`);
    }
    expect(offenders, `这些提示词文件混入了 shell 代码:\n${offenders.join("\n")}`).toEqual([]);
  });
});
