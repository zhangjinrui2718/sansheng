/**
 * 角色中文名**只有一处来源**(2026-10-06)
 *
 * ── 这份测试是怎么来的 ──────────────────────────────────────────
 *
 * 用户的原话:「harness 页面 和 成员页面 的四个角色的命名统一一下,就不要有解释了」。
 * 查下来的事实是同一个角色有**三个**名字:
 *
 *   | 界面 | 名字 | 来源 |
 *   |---|---|---|
 *   | harness 页 | `Worker(执行者)` | `transport/http.ts` 一张私有表(**已删**) |
 *   | 成员页 | `工程师` / `质检` | `agents.display_name`(播种自 `runtime/org.ts`) |
 *   | 前端兜底 | `执行者` / `质检审查员` | `lib/vocab.ts` 的 `ROLE_LABEL` |
 *
 * 三个名字里还有一个**把解释写进了名字**(`Worker(执行者)`)。
 *
 * ── 为什么必须是「跨边界对照」而不是两处各自断言 ─────────────────────
 *
 * 后端(`src/platform/runtime/org.ts` 的 `ORG`)与前端(`web/src/lib/vocab.ts` 的
 * `ROLE_LABEL`)分处两个编译单元,前端**不能**导入服务端模块(项目纪律:server 侧
 * 禁 value import `@shared/*`,反过来 web 也不引 `src/`)。所以「两张表必须逐项相同」
 * 这件事**没有类型系统能保证** —— 它只能由这条测试来钉:
 *
 *   · `ROLE_LABEL` 的每一个词 == `ORG` 里同角色那一行的 `name`;
 *   · 四个角色**一个都不许漏**(漏了就是编译期能过、界面上少一个人);
 *   · 负样本:名字里**不许**出现括号 / 斜杠 / 空格 —— 「不要有解释」这句原话的
 *     机器表达(`Worker(执行者)` 就是被这一条挡下来的那种写法)。
 */
import { describe, expect, it } from "vitest";
import { ROLE_LABEL } from "@/lib/vocab";
import { ORG, roleDisplayName } from "../../src/platform/runtime/org.js";
import { renderRoleBrief } from "../../src/platform/runtime/promptAssembly.js";
import { PROJECT_ROLES, type ProjectRole } from "../../src/platform/identity/role.js";

describe("角色中文名:后端 ORG ↔ 前端 ROLE_LABEL 逐项相同", () => {
  it("五个角色一个不漏(漏了就是界面上少一个人)", () => {
    expect([...ORG].map((m) => m.role).sort()).toEqual([...PROJECT_ROLES].sort());
    expect(Object.keys(ROLE_LABEL).sort()).toEqual([...PROJECT_ROLES].sort());
  });

  it("逐项同名 —— 这条是「统一命名」的全部机器判据", () => {
    for (const role of PROJECT_ROLES) {
      expect(ROLE_LABEL[role], `role=${role} 两边名字不一致`).toBe(roleDisplayName(role));
    }
    // 正样本自检:两张表都不是空的(否则上面那圈是空转)
    expect(PROJECT_ROLES.length).toBe(5);
    expect(roleDisplayName("research_worker")).toBe("研究员");
    expect(roleDisplayName("coding_worker")).toBe("工程师");
  });

  it("负样本:名字里不许有括号 / 斜杠 / 空格(「不要有解释」的机器表达)", () => {
    for (const role of PROJECT_ROLES) {
      const name = ROLE_LABEL[role];
      expect(name, `${name} 里带了括号 —— 那是解释,不是名字`).not.toMatch(/[()（）]/);
      expect(name, `${name} 里带了斜杠/空格`).not.toMatch(/[/\s]/);
      expect(name.length, `${name} 太长,不像一个名字`).toBeLessThanOrEqual(6);
    }
    // 这一条自己也要能被弄红:把旧写法喂进来必须不通过
    expect("Worker(执行者)").toMatch(/[()（）]/);
  });

  it("`roleDisplayName` 查不到角色时**原样透出代号**,而不是空串", () => {
    // 兜底方向是可观测的:界面上出现 `nobody` 看得出「这名字没配」,空串看不出。
    // ⚠️ 用的是一个**根本不存在**的角色名:`worker` 曾经可以这么写,但 2026-10-08
    // 它已经不是角色了(改名叫 `research_worker`),拿它当「查不到」的样本会让
    // 这条断言变成一次**类型错误而不是行为断言**。
    const nobody = "nobody" as ProjectRole;
    expect(roleDisplayName(nobody)).toBe("nobody");
    expect(roleDisplayName(nobody)).not.toBe("");
  });

  /**
   * 角色名的**第三处**写法:`runtime/promptAssembly.ts` 的 `ROLE_NAME`
   * (系统提示里的「# 你的角色:X」)。
   *
   * 它此前写的是 `Worker(执行者)` —— 与 `ORG` 的 `工程师` 当场不同,而且
   * **没有任何检查会红**(当时这份测试只对照 ORG ↔ ROLE_LABEL 两张表)。
   * 2026-10-08 收编之后在这里补上跨边界对照:三张表逐项相同。
   */
  it("第三处:提示词简报里的角色名与 ORG **逐字相同**(不是「包含」)", () => {
    for (const role of PROJECT_ROLES) {
      const brief = renderRoleBrief(role);
      const line = brief.split("\n").find((l) => l.startsWith("# 你的角色:"));
      expect(line, `role=${role} 的简报里没有「# 你的角色:」这一行`).toBeDefined();
      // ⚠️ **`toBe` 而不是 `toContain`** —— 这条断言的第一版写的是
      // `expect(brief).toContain(\`# 你的角色:${roleDisplayName(role)}\`)`,
      // 而那时 `promptAssembly.ts` 里还有一张把 `quality_reviewer` 写成
      // **「质检审查员」** 的表(`ORG` 写的是「质检」)。`"质检审查员"` **包含**
      // `"质检"` ⇒ **假通过** —— 一个坏掉的哨兵返回了一个看起来正常的答案
      // (本项目第 3 类静默失败)。所以这里是逐字相等:多一个字就红。
      expect(line, `role=${role} 的名字与 ORG 漂了`).toBe(`# 你的角色:${roleDisplayName(role)}`);
    }
    // 正样本自检(证明上面那圈真的在跑)+ 负样本(证明判据有牙)
    expect(renderRoleBrief("coding_worker")).toContain("# 你的角色:工程师");
    expect(renderRoleBrief("coding_worker")).not.toContain("Worker(执行者)");
    expect("# 你的角色:质检审查员").not.toBe("# 你的角色:质检");
  });
});
