/**
 * T4 · 前端**取数**层(`web/src/lib/api.ts` 的两条用量函数)
 *
 * ── 为什么只测 URL,不测数字 ────────────────────────────────────
 *
 * 这一层是**薄 fetch 封装**(文件头写着:任何页面/store 都不许再写 fetch)。
 * 它唯一的自造逻辑就是「路径 + 查询串怎么拼」—— 数字的权威值在后端
 * (`tests/platform/usage-http.test.ts` 守),渲染在 T5。
 * 所以这里只钉三件事:
 *
 *   ① `days` / `limit` **透传**了没(`undefined` 一律不发,让后端用它自己的默认值
 *      —— 前端替后端选窗口 = 两处会漂的真相);
 *   ② `projectId` 与 null(**接待会话**)走的是**两条不同的端点**
 *      (`/projects/:id/usage` vs `/intake/usage`),而不是「项目 id 传空串」;
 *   ③ 非 2xx 仍然抛带 `code` 的 `ApiError`(与全仓其余端点同一条错误语义)。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getIntakeUsage, getProjectUsage } from "../../web/src/lib/api.js";

interface Seen {
  url: string;
}

/** 桩掉 fetch:返回一个合法的空用量视图,并把请求 URL 记下来。 */
function stubApi(routes: Record<string, unknown> = {}): Seen[] {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    seen.push({ url: String(url) });
    const path = String(url).replace("/api", "");
    if (!(path in routes)) {
      return { ok: false, status: 404, statusText: "Not Found", text: async () => "{}" };
    }
    return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(routes[path]) };
  });
  return seen;
}

const EMPTY_USAGE = {
  usage: {
    projectId: "p-1", window: { days: 7, since: 0, until: 1 },
    totals: { input: 0, output: 0, cacheRead: 0, turns: 0 },
    allTime: { input: 0, output: 0, cacheRead: 0, turns: 0 },
    today: { input: 0, output: 0, cacheRead: 0, turns: 0 },
    byAgent: [], byDay: [], byDayTruncated: false, updatedAt: null,
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("用量取数 · 路径与查询串", () => {
  it("项目用量走 `/api/projects/:id/usage`,projectId 要 URL 编码", async () => {
    const seen = stubApi({ "/projects/p%2F1/usage": EMPTY_USAGE });
    await getProjectUsage("p/1");
    expect(seen.map((s) => s.url)).toEqual(["/api/projects/p%2F1/usage"]);
  });

  it("★ 不传 days / limit ⇒ **一个查询参数都不发**(让后端用它自己的默认值)", async () => {
    const seen = stubApi({ "/projects/p-1/usage": EMPTY_USAGE });
    await getProjectUsage("p-1");
    expect(seen[0]!.url).toBe("/api/projects/p-1/usage");
    expect(seen[0]!.url).not.toContain("?");
  });

  it("传了就透传(今日 = days=1;最近 7 天 = days=7)", async () => {
    const seen = stubApi({ "/projects/p-1/usage?days=1": EMPTY_USAGE, "/projects/p-1/usage?days=7&limit=3": EMPTY_USAGE });
    await getProjectUsage("p-1", { days: 1 });
    await getProjectUsage("p-1", { days: 7, limit: 3 });
    expect(seen.map((s) => s.url)).toEqual([
      "/api/projects/p-1/usage?days=1",
      "/api/projects/p-1/usage?days=7&limit=3",
    ]);
  });

  it("★ 接待会话走 `/api/intake/usage`(**不是** projects/空)", async () => {
    const seen = stubApi({ "/intake/usage": EMPTY_USAGE, "/intake/usage?days=7": EMPTY_USAGE });
    await getIntakeUsage();
    await getIntakeUsage({ days: 7 });
    expect(seen.map((s) => s.url)).toEqual(["/api/intake/usage", "/api/intake/usage?days=7"]);
    expect(seen.every((s) => !s.url.includes("/projects/"))).toBe(true);
  });

  it("契约字段原样带回来(`cacheRead` 在;**没有 `cost`**)", async () => {
    stubApi({
      "/projects/p-1/usage": {
        usage: {
          ...EMPTY_USAGE.usage,
          totals: { input: 10398, output: 173, cacheRead: 10240, turns: 2 },
        },
      },
    });
    const r = await getProjectUsage("p-1");
    expect(r.usage.totals).toEqual({ input: 10398, output: 173, cacheRead: 10240, turns: 2 });
    expect(Object.keys(r.usage.totals)).not.toContain("cost");
    expect(JSON.stringify(r)).not.toContain("cost");
  });
});

describe("用量取数 · 错误语义与其余端点一致", () => {
  it("后端 404 ⇒ 抛 `ApiError`,code 取自 body", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => JSON.stringify({ error: { code: "not_found", message: "项目不存在" } }),
    }));
    const err = await getProjectUsage("p-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("not_found");
    expect((err as ApiError).status).toBe(404);
  });
});
