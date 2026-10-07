/**
 * 交付物的**收货动作**(029)· 读面三态
 *
 * ── 它盯的是「三件事不许混成两件」───────────────────────────────
 *
 * 一份交付物在界面上有三种**处置完全不同**的状态,而它们很容易被写成两种
 * (「已完成 / 未完成」):
 *
 *   · 还没交付      → **等业务经理**(他还没把货交出去)⇒ 不显示任何验收动作;
 *   · 已交付没表态  → **等甲方**(球在他那边)⇒ 这才是「等你验收」;
 *   · 已裁决        → 显示裁决本身(可改判)。
 *
 * 把第一种渲染成第二种 = 让甲方去验收一份**没交到他手上**的东西(后端也会拒:
 * `not_delivered` 409);把第二种渲染成第一种 = 把「有事等你」藏起来
 * —— 真机第一条 `client_question` 就是这么被漏掉的。
 *
 * ⚠️ 还有一条只属于本页的纪律:**「还没表态」不许渲染成任何一种裁决**。
 * `verdict === null` 时必须出现「等你验收」,而**不许**出现「已接受」。
 * 那正是这次改动要治的那句假话(`status='accepted'` 从前的语义)。
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ArtifactAcceptanceView } from "@shared/types/platform";
import { DeliveryVerdictActions } from "@/components/deliverable/DeliveryVerdictActions";

/** 夹具:未收口的项目(`projectClosed` 是必填 —— 漏了会变成 429 那一路的假形状)。 */
const open = (over: Partial<ArtifactAcceptanceView>): ArtifactAcceptanceView => ({
  handedOver: false, verdict: null, note: null, at: null, projectClosed: false, ...over,
});

const render = (acceptance: ArtifactAcceptanceView): string =>
  renderToStaticMarkup(
    createElement(DeliveryVerdictActions, {
      artifactId: "art_1",
      title: "最终交付物",
      acceptance,
    }),
  );

describe("① 还没交付 ⇒ 说明等谁,且**不给**验收动作", () => {
  const html = render(open({ handedOver: false }));

  it("说清「还没交付给你」,并把责任点出来(业务经理)", () => {
    expect(html).toContain("未交付");
    expect(html).toContain("业务经理还没把这份交给你");
  });

  it("负样本:不许出现「接受」/「要改」按钮(没收到货谈不上验收)", () => {
    expect(html).not.toContain(">接受<");
    expect(html).not.toContain(">要改<");
  });

  it("负样本:也不许说「等你验收」(那是另一种状态)", () => {
    expect(html).not.toContain("等你验收");
  });
});

describe("② 已交付、甲方没表态 ⇒ 「等你验收」+ 两个动作", () => {
  const html = render(open({ handedOver: true }));

  it("出现「等你验收」与两个按钮", () => {
    expect(html).toContain("等你验收");
    expect(html).toContain(">接受<");
    expect(html).toContain(">要改<");
    expect(html).toContain("收不收由你说");
  });

  it("**牙**:没表态时不许出现任何裁决字样", () => {
    // 这一条是这次改动的全部意义:在此之前的表里,`accepted`(定稿)会被读成
    // 「已验收」—— 那是把作者的自述当成甲方的表态。
    expect(html).not.toContain("已接受");
    expect(html).not.toContain("已验收");
  });

  it("拒收的理由不强制填(强制填会把人推向「接受」—— 一次假接受比没写理由坏得多)", () => {
    // 提交按钮不在服务端渲染里出现 disabled(它是受控组件的初值 false)
    expect(html).not.toContain('disabled=""');
  });
});

describe("③ 已裁决 ⇒ 显示那一条,并且保留改判入口", () => {
  it("已接受:写「你已经接受了这一版。发现问题可以改判」", () => {
    const html = render(open({ handedOver: true, verdict: "accept", at: 1_700_000_000_000 }));
    expect(html).toContain("已接受");
    expect(html).toContain("可以改判");
    expect(html).not.toContain("等你验收");
  });

  it("要改:**理由原样显示**(那是作者唯一的输入,平台不许改写它)", () => {
    const note = "第三章的接口对不上 —— P95 也没达标";
    const html = render(open({ handedOver: true, verdict: "reject", note, at: 1_700_000_000_000 }));
    expect(html).toContain("要改");
    expect(html).toContain(note);
    expect(html).toContain("平台会把你的理由派回给写它的人");
  });

  it("负样本:没写理由时不许编一个(如实说「不写也行」)", () => {
    const html = render(open({ handedOver: true, verdict: "reject", at: 1 }));
    expect(html).toContain("不写也行");
    expect(html).not.toContain("你说的:");
  });
});

describe("④ 自检:上面那几条断言真的在测不同状态(不是恒真)", () => {
  it("三种状态的标记互不相同", () => {
    const a = render(open({ handedOver: false }));
    const b = render(open({ handedOver: true }));
    const c = render(open({ handedOver: true, verdict: "accept", at: 1 }));
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe("⑤ 项目已收口 ⇒ **不给按钮**,而是说清这是历史事实", () => {
  const html = render(open({ handedOver: true, projectClosed: true }));

  it("写「已交付 · 未被验收」,并说明收口不可逆", () => {
    expect(html).toContain("已交付 · 未被验收");
    expect(html).toContain("收口不可逆");
    expect(html).toContain("开下一个版本");
  });

  it("**牙**:一个按钮都不许有(后端对收口项目一律 409 —— 兑现不了的按钮不是按钮)", () => {
    expect(html).not.toContain(">接受<");
    expect(html).not.toContain(">要改<");
    expect(html).not.toContain("等你验收");
  });

  it("已经裁决过的收口项目:显示那条裁决,并说明不再可改", () => {
    const h = render(open({ handedOver: true, projectClosed: true, verdict: "accept", at: 1 }));
    expect(h).toContain("已接受");
    expect(h).toContain("不再可改");
  });

  it("正样本对照:同一个 `acceptance` 只把 `projectClosed` 翻过来,按钮就回来了", () => {
    // 证明上面那几条不是「组件整体坏了」——差异只来自那一格。
    const live = render(open({ handedOver: true, projectClosed: false }));
    expect(live).toContain(">接受<");
  });
});
