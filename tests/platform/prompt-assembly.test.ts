/**
 * 提示词装配测试(7-B 死接线守卫)
 *
 * ── 这一课的原话 ────────────────────────────────────────────────
 *
 *   「7-B 之前这段是**死接线**(this.dataDir 存了没用,spawn 只传 { storage }),
 *    Planner/Executor 一直拿模块内 6-9 行 stub,shared/prompts/planner.md 那份
 *    91 行正经提示词是死代码。**改提示词前先确认它真的到达模型**。」
 *
 * 首跑冒烟时业务经理自称「AI 编码助手」—— 同一个病:单元算出来了,从没送达。
 * 所以这组测试要断言的不只是「拼出来的字符串对不对」,更是
 * **「声明了哪些单元」与「实际送达/缺失了什么」必须对得上** ——
 * 静默少送一个单元,agent 就会照常工作,只是不知道那条规矩。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  unitPath, loadPromptUnits, renderRoleBrief, composeSystemPrompt,
} from "../../src/platform/runtime/promptAssembly.js";
import { ROLE_SPECS, PROJECT_ROLES, type ProjectRole } from "../../src/platform/identity/role.js";

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-prompt-"));
  mkdirSync(join(dataDir, "harness", "system_prompts"), { recursive: true });
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

function writeUnit(id: string, body: string): void {
  writeFileSync(unitPath(dataDir, id), body, "utf8");
}

describe("loadPromptUnits · 装载与缺失如实报出", () => {
  it("读得到就装载,读不到就进 missing", () => {
    writeUnit("business_manager.core", "你是业务经理。");
    const r = loadPromptUnits(dataDir, ["business_manager.core", "nope.unit"]);
    expect(r.loaded).toEqual(["business_manager.core"]);
    expect(r.missing).toEqual(["nope.unit"]);
    expect(r.text).toContain("你是业务经理。");
  });

  it("**空白文件算未装载** —— 空的 md 不该产生一个空段污染上下文", () => {
    writeUnit("business_manager.core", "   \n\n  ");
    const r = loadPromptUnits(dataDir, ["business_manager.core"]);
    expect(r.loaded).toEqual([]);
    expect(r.missing).toEqual(["business_manager.core"]);
    expect(r.text).toBe("");
  });

  it("多个单元按声明顺序拼接,并带 id 注释便于排查", () => {
    writeUnit("a.one", "第一段");
    writeUnit("a.two", "第二段");
    const r = loadPromptUnits(dataDir, ["a.one", "a.two"]);
    expect(r.loaded).toEqual(["a.one", "a.two"]);
    expect(r.text.indexOf("第一段")).toBeLessThan(r.text.indexOf("第二段"));
    expect(r.text).toContain("<!-- a.one -->");
    expect(r.text).toContain("<!-- a.two -->");
  });

  it("单元 id 里的点保留在文件名里(与旧系统 communicator.decide.md 同一命名法)", () => {
    expect(unitPath("/x", "worker.core")).toBe("/x/harness/system_prompts/worker.core.md");
  });
});

describe("renderRoleBrief · 从 ROLE_SPECS 机械生成", () => {
  for (const role of PROJECT_ROLES) {
    it(`${role}:简报含中文角色名与边界说明`, () => {
      const brief = renderRoleBrief(role);
      expect(brief).toContain("# 你的角色:");
      expect(brief).toContain("## 你能做的事");
      expect(brief).toContain("## 你**不能**做的事");
      expect(brief).toContain("边界是机制保证的");
    });
  }

  it("**业务经理:唯一客户接口**", () => {
    const b = renderRoleBrief("business_manager");
    expect(b).toContain("唯一");
    expect(b).toContain("对甲方接口");
    expect(b).toContain("向甲方提问");
  });

  it("**其余三个角色:明确「不直接接触甲方」**", () => {
    for (const role of ["project_manager", "worker", "quality_reviewer"] as ProjectRole[]) {
      const b = renderRoleBrief(role);
      expect(b, `${role} 应写明不直接见甲方`).toContain("不直接接触甲方");
      expect(b).toContain("由业务经理转达");
    }
  });

  it("简报的能力清单来自 ceiling —— 改 ROLE_SPECS 它会自动跟着变", () => {
    const b = renderRoleBrief("quality_reviewer");
    expect(b).toContain("查看项目全貌");
    expect(b).toContain("往黑板写工件");
    // 质检不该有代码能力
    expect(b).not.toContain("改代码");
    expect(b).not.toContain("执行命令");
  });

  it("简报列出该角色拿不到的工具(boundaryDeny)", () => {
    const b = renderRoleBrief("worker");
    expect(b).toContain("tell_client");
    expect(b).toContain("convene");
  });

  it("边界措辞是「机制保证」而不是「请你遵守」", () => {
    const b = renderRoleBrief("worker");
    expect(b).toContain("会在**工具层被拒绝**");
    expect(b).toContain("不要尝试绕过");
  });
});

describe("composeSystemPrompt · 简报 + 单元", () => {
  it("简报在前(身份与边界),单元在后(具体工作方式)", () => {
    writeUnit("worker.core", "你负责动手实现。");
    const c = composeSystemPrompt(dataDir, "worker");
    expect(c.text.indexOf("# 你的角色:")).toBeLessThan(c.text.indexOf("你负责动手实现。"));
  });

  it("**声明的单元与装载/缺失必须对得上**(7-B 守卫的核心)", () => {
    for (const role of PROJECT_ROLES) {
      const declared = ROLE_SPECS[role].promptUnits;
      const c = composeSystemPrompt(dataDir, role);
      // 这个 fixture 里一个单元文件都没写 → 全部应当进 missing
      expect([...c.missingUnits].sort()).toEqual([...declared].sort());
      expect(c.loadedUnits).toEqual([]);
    }
  });

  it("写了哪个就装载哪个,没写的进 missing —— 不静默吞掉", () => {
    const declared = ROLE_SPECS.worker.promptUnits;
    const first = declared[0]!;
    writeUnit(first, "worker 的核心职责。");
    const c = composeSystemPrompt(dataDir, "worker");
    expect(c.loadedUnits).toEqual([first]);
    expect([...c.missingUnits].sort()).toEqual(declared.slice(1).sort());
    expect(c.text).toContain("worker 的核心职责。");
  });

  it("即便一个单元都没有,简报仍在 —— 不会拼出空系统提示", () => {
    const c = composeSystemPrompt(dataDir, "project_manager");
    expect(c.text.trim().length).toBeGreaterThan(100);
    expect(c.text).toContain("# 你的角色:项目经理");
  });

  it("简报不会因为盘上没有文件就消失(与缺失单元是两件事)", () => {
    const c = composeSystemPrompt(dataDir, "business_manager");
    expect(c.missingUnits.length).toBeGreaterThan(0);
    expect(c.text).toContain("业务经理");
  });
});
