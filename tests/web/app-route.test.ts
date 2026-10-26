/**
 * `lib/route.ts` 的判据 —— 「UI 状态住在地址里」这件事必须可验
 *
 * 三条要钉住的东西:
 *   ① **地址 ↔ 状态是可逆的**(解析 → 序列化 → 解析,得到同一份);
 *   ② **坏地址不白屏**(未知路由 ⇒ `chat`,而不是 undefined 的分支);
 *   ③ **它真的被接上了**(App 不再自己 `useState<Route>`,成员页的选中项读地址)。
 *      ③ 单独写一条源码级断言 —— 一个没人调用的 `lib/route.ts` 与本文件描述的
 *      行为在界面上完全一样,而「代码里写了逻辑 ≠ 它有读者」是这仓库的复发性事故。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  HOME,
  ROUTES,
  paramOf,
  parseHash,
  toHash,
  toRoute,
  withParam,
} from "../../web/src/lib/route";

const source = (rel: string): string =>
  readFileSync(resolve(__dirname, "../../web/src", rel), "utf8");

describe("parseHash — 地址 → 状态", () => {
  it("空地址 ⇒ 对话页(默认),不是白屏", () => {
    expect(parseHash("")).toEqual(HOME);
    expect(parseHash("#")).toEqual({ route: "chat", params: {} });
    expect(parseHash("#/")).toEqual({ route: "chat", params: {} });
  });

  it("六个页签 + 关于都能解析(闭合集合与 ROUTES 同源)", () => {
    for (const r of ROUTES) expect(parseHash(`#/${r}`).route).toBe(r);
    expect(ROUTES).toHaveLength(7); // 6 个页签 + about(? 打开),不是 7 个页签
  });

  it("查询串进 params,且已解码", () => {
    expect(parseHash("#/works?work=w_123")).toEqual({
      route: "works",
      params: { work: "w_123" },
    });
    expect(parseHash("#/members?member=a%2F9")).toEqual({
      route: "members",
      params: { member: "a/9" },
    });
  });

  it("整条 URL 也能喂进来(别人贴链接时前面还带着 origin)", () => {
    expect(parseHash("http://127.0.0.1:2718/#/members?member=a_9")).toEqual({
      route: "members",
      params: { member: "a_9" },
    });
  });

  it("未知路由 ⇒ 对话页,且**丢弃**陌生参数(它们属于那条不存在的路由)", () => {
    expect(parseHash("#/nope?x=1")).toEqual(HOME);
    // 变异自检:若把未知路由当成「保留参数」,这里就会变成 { route:"chat", params:{x:"1"} }
    expect(parseHash("#/nope?x=1").params).not.toHaveProperty("x");
  });

  it("裸 `%` 不抛错(手打地址/旧收藏都可能带它)", () => {
    expect(() => parseHash("#/works?work=100%")).not.toThrow();
    expect(parseHash("#/works?work=100%").params["work"]).toBe("100%");
  });

  it("空键被跳过(`?=x` 不是一条参数)", () => {
    expect(parseHash("#/works?=x").params).toEqual({});
  });
});

describe("toHash — 状态 → 地址", () => {
  it("键按字典序:同一份状态只有一个地址字符串", () => {
    expect(toHash({ route: "works", params: { b: "2", a: "1" } })).toBe("#/works?a=1&b=2");
    expect(toHash(parseHash(toHash({ route: "works", params: { b: "2", a: "1" } })))).toBe(
      "#/works?a=1&b=2",
    );
  });

  it("空值参数不写进地址(`member=` 与「没选」应当同形)", () => {
    expect(toHash({ route: "members", params: { member: "" } })).toBe("#/members");
  });

  it("往返:解析 → 序列化 → 解析,不丢东西", () => {
    const loc = { route: "works" as const, params: { work: "w 1", tab: "x&y" } };
    expect(parseHash(toHash(loc))).toEqual(loc);
  });
});

describe("withParam / paramOf / toRoute", () => {
  const loc = { route: "members" as const, params: { member: "a_1" } };

  it("加参数、删参数都返回新对象(不改入参)", () => {
    const added = withParam(loc, "tab", "chats");
    expect(added.params).toEqual({ member: "a_1", tab: "chats" });
    expect(loc.params).toEqual({ member: "a_1" }); // 入参没被改
    expect(withParam(added, "tab", null).params).toEqual({ member: "a_1" });
  });

  it("paramOf:缺失是 null,空串是空串(两件事)", () => {
    expect(paramOf(loc, "nope")).toBeNull();
    expect(paramOf({ route: "members", params: { member: "" } }, "member")).toBe("");
  });

  it("toRoute 默认清空参数 —— 上一个页面的 `work=` 在别的页面是噪音", () => {
    expect(toRoute("memory")).toEqual({ route: "memory", params: {} });
  });
});

describe("接线:这一层真的有人在用", () => {
  it("App 的当前页面读地址,不再自己 useState<Route>", () => {
    const app = source("App.tsx");
    expect(app).toContain("useAppLocation()");
    expect(app).toContain("loc.route");
    // ⚠️ 页面的选中态若回到组件 state,刷新即失忆、链接也不能分享 —— 回归 M2
    expect(app).not.toContain("useState<Route>");
  });

  it("成员页选中的成员来自地址里的 `member`", () => {
    const members = source("routes/Members.tsx");
    expect(members).toContain('paramOf(loc, "member")');
    expect(members).toContain('setParam("member", id)');
    // 变异自检:换回页面私有 state 这一格必须抓到
    expect(members).not.toContain('useState<string | null>(null);\n  const harness');
  });

  it("路由 union 只有一处声明(App re-export,不复制一份)", () => {
    const routes = source("lib/route.ts");
    expect(routes).toContain("export type Route =");
    const app = source("App.tsx");
    expect(app).toContain('export type { Route } from "./lib/route"');
    expect(app).not.toMatch(/export type Route\s*=/);
  });
});
