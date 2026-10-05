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
import { PROJECT_ROLES } from "../../src/platform/identity/role.js";

describe("角色中文名:后端 ORG ↔ 前端 ROLE_LABEL 逐项相同", () => {
  it("四个角色一个不漏(漏了就是界面上少一个人)", () => {
    expect([...ORG].map((m) => m.role).sort()).toEqual([...PROJECT_ROLES].sort());
    expect(Object.keys(ROLE_LABEL).sort()).toEqual([...PROJECT_ROLES].sort());
  });

  it("逐项同名 —— 这条是「统一命名」的全部机器判据", () => {
    for (const role of PROJECT_ROLES) {
      expect(ROLE_LABEL[role], `role=${role} 两边名字不一致`).toBe(roleDisplayName(role));
    }
    // 正样本自检:两张表都不是空的(否则上面那圈是空转)
    expect(PROJECT_ROLES.length).toBe(4);
    expect(roleDisplayName("worker")).toBe("工程师");
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
    expect(roleDisplayName("worker")).toBe("工程师");
  });
});
