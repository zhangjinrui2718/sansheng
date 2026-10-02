/**
 * 批次 4a · C4(下)— embeddings cache Map 无界增长
 * (docs/CODE-REVIEW-2026-10-01.md §C4:「每条 1536 doubles,只判 TTL 不删」)
 *
 * 缺陷形态:embeddings.ts 的模块级 `cache = new Map()` 只在读取时判 60s TTL,
 * 从不淘汰条目 → 常驻进程内存随 embed 过的文本数线性增长(每条 1536 维
 * double ≈ 12KB+,永不释放)。
 *
 * 修复契约(选型论证见 embeddings.ts 注释):LRU(Map 插入序 + 命中 delete/re-set
 * + 超限淘汰最旧),上限 `EMBEDDING_CACHE_MAX_ENTRIES`(导出常量)。
 *  - 超上限后最旧条目被淘汰 → 再 embed 触发重新 fetch;
 *  - 最近条目仍命中缓存 → 不 fetch;
 *  - TTL 语义保留。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as embeddings from "../../src/server/storage/embeddings.js";
import { embedText } from "../../src/server/storage/embeddings.js";

const provider = { baseUrl: "http://127.0.0.1:9", apiKey: "k-fake", model: "text-embedding-3-small" };

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("C4 · embeddings cache 上限(LRU)", () => {
  it("导出 EMBEDDING_CACHE_MAX_ENTRIES 常量(有界缓存上限)", () => {
    const cap = (embeddings as Record<string, unknown>).EMBEDDING_CACHE_MAX_ENTRIES;
    // RED(修复前):常量不存在 → undefined
    expect(typeof cap, "embeddings.ts 应导出缓存上限常量").toBe("number");
    expect(cap as number).toBeGreaterThan(0);
    expect(cap as number).toBeLessThanOrEqual(10_000);
  });

  it("超过上限后最旧条目被 LRU 淘汰(重新 fetch),最近条目仍命中(不 fetch)", async () => {
    const cap = (embeddings as Record<string, unknown>).EMBEDDING_CACHE_MAX_ENTRIES;
    expect(typeof cap, "缓存上限常量缺失 → 无法验证淘汰行为").toBe("number");
    const limit = cap as number;
    const fetchMock = stubFetch();

    const text = (i: number): string => `unique-embed-text-${i}-padding`;
    // 灌满 cap + 10 条 → 最旧的 10 条(t0..t9)应被淘汰
    for (let i = 0; i < limit + 10; i++) {
      await embedText(text(i), provider);
    }
    const callsAfterFill = fetchMock.mock.calls.length;
    expect(callsAfterFill).toBe(limit + 10);

    // 最旧条目(t0)已淘汰 → 再 embed 必须重新 fetch
    // RED(修复前):cache 无界 → t0 仍命中(TTL 60s 内)→ 调用数不变
    await embedText(text(0), provider);
    expect(fetchMock.mock.calls.length, "最旧条目应已被 LRU 淘汰 → 重新 fetch").toBe(
      callsAfterFill + 1,
    );

    // 最新条目仍命中 → 不 fetch
    await embedText(text(limit + 9), provider);
    expect(fetchMock.mock.calls.length, "最近条目应命中缓存").toBe(callsAfterFill + 1);
  });

  it("TTL 语义保留:命中缓存时不发起 fetch", async () => {
    const cap = (embeddings as Record<string, unknown>).EMBEDDING_CACHE_MAX_ENTRIES;
    expect(typeof cap).toBe("number");
    const fetchMock = stubFetch();
    await embedText("ttl-check-text", provider);
    const n = fetchMock.mock.calls.length;
    await embedText("ttl-check-text", provider);
    expect(fetchMock.mock.calls.length).toBe(n); // 60s TTL 内命中
  });
});
