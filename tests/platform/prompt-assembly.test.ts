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
import { readdirSync, readFileSync } from "node:fs";
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
    expect(unitPath("/x", "research_worker.core")).toBe("/x/harness/system_prompts/research_worker.core.md");
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

  it("**其余四个角色:明确「不直接接触甲方」**", () => {
    // 判据从 PROJECT_ROLES **推导**,不手写名单 —— 手写的那一份在加角色时
    // 会静默地少测一个新角色(循环照跑、测试照绿)。
    const nonClientFacing = PROJECT_ROLES.filter((r) => r !== "business_manager");
    expect(nonClientFacing.length, "非客户接口角色不止一个,否则这圈是空转").toBe(4);
    for (const role of nonClientFacing) {
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
    const b = renderRoleBrief("research_worker");
    expect(b).toContain("tell_client");
    expect(b).toContain("convene");
    // 研究工多一条**这次改动新增**的边界:不产出产品代码
    expect(b).toContain("edit");
    expect(b).toContain("write");
    // 负样本:编码工没有这条边界(它**就是**写代码的那个)
    const c = renderRoleBrief("coding_worker");
    expect(c).not.toContain("下列工具不在你的权限内:tell_client, ask_client, convene, meeting_conclude, project_update, project_close, edit, write");
  });

  it("边界措辞是「机制保证」而不是「请你遵守」", () => {
    const b = renderRoleBrief("research_worker");
    expect(b).toContain("会在**工具层被拒绝**");
    expect(b).toContain("不要尝试绕过");
  });
});

describe("composeSystemPrompt · 简报 + 单元", () => {
  it("简报在前(身份与边界),单元在后(具体工作方式)", () => {
    writeUnit("coding_worker.core", "你负责动手实现。");
    const c = composeSystemPrompt(dataDir, "coding_worker");
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
    const declared = ROLE_SPECS.research_worker.promptUnits;
    const first = declared[0]!;
    writeUnit(first, "研究工的核心职责。");
    const c = composeSystemPrompt(dataDir, "research_worker");
    expect(c.loadedUnits).toEqual([first]);
    expect([...c.missingUnits].sort()).toEqual(declared.slice(1).sort());
    expect(c.text).toContain("研究工的核心职责。");
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

// ── 出厂提示词单元集的覆盖不变式 ──────────────────────────────────

describe("出厂单元集 · 覆盖不变式(仓库 harness/system_prompts/)", () => {
  // 仓库存一份出厂单元集,数据目录那份是用户可改的运行副本。
  // 两件事都要守住:声明了的必须有出厂内容;出厂内容必须有人用。
  const DIR = join(import.meta.dirname, "../../harness/system_prompts");

  function declaredUnits(): Set<string> {
    const s = new Set<string>();
    for (const r of PROJECT_ROLES) for (const u of ROLE_SPECS[r].promptUnits) s.add(u);
    return s;
  }
  function shippedUnits(): Set<string> {
    return new Set(
      readdirSync(DIR).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")),
    );
  }

  it("**每个声明的单元都有出厂内容** —— 缺一个就是一条职责从没告诉过 agent", () => {
    const declared = declaredUnits();
    const shipped = shippedUnits();
    const missing = [...declared].filter((u) => !shipped.has(u));
    expect(missing, `这些单元在 ROLE_SPECS 里声明了但没有出厂内容:${missing.join(", ")}`).toEqual([]);
  });

  it("**出厂内容都被声明引用** —— 没人用的单元文件会烂掉", () => {
    const declared = declaredUnits();
    const orphan = [...shippedUnits()].filter((u) => !declared.has(u));
    expect(orphan, `这些单元文件没有任何角色声明使用:${orphan.join(", ")}`).toEqual([]);
  });

  it("每个单元都非空且不是占位符", () => {
    for (const u of shippedUnits()) {
      const body = readFileSync(join(DIR, `${u}.md`), "utf8");
      expect(body.trim().length, `${u} 内容为空`).toBeGreaterThan(200);
      // ⚠️ **`TODO` 必须带边界**(2026-10-06 修的检查自身的洞)。
      //
      // 原来的 `/TODO|TBD|待补/` 会在 `CLIENT_FACING_TODO_KINDS` 上命中 ——
      // 那是一个**真的标识符**,却让这条断言报出「这个单元像是占位符」,
      // 而它长得像一次成功的检查(与 AGENTS.md「三类静默失败」第 3 条同形)。
      // 收紧成**独立词**之后,`TODO:` / `TODO ` 这类真占位符仍然命中。
      expect(body, `${u} 像是占位符`).not.toMatch(/\bTODO\b|\bTBD\b|待补/);
    }
  });

  it("出厂集能被 composeSystemPrompt 装载(路径与命名法一致)", () => {
    // 把出厂集当数据目录用 —— 装载器应当能全部读到
    for (const role of PROJECT_ROLES) {
      const declared = ROLE_SPECS[role].promptUnits;
      const loaded = loadPromptUnits(join(DIR, "..", ".."), declared);
      expect(loaded.loaded.sort(), `${role} 的单元没能从出厂集装载`).toEqual([...declared].sort());
      expect(loaded.missing).toEqual([]);
    }
  });
});
