/**
 * 知识语料状态判据(记忆页「知识语料」段)
 *
 * 这一段的价值全在**判据能不能被证伪**:如果 `corpusStatus` 在任何概览形状下
 * 都回「正常」,那面绿字就是装饰 —— 所以这里有**每个 level 的正样本**
 * 与**边界负样本**(差一条、差一毫秒都不许混过去)。
 */
import { describe, it, expect } from "vitest";
import { corpusStatus, corpusTone, fmtSpan, pendingTotal } from "../../web/src/lib/knowledgeState.js";
import type { KnowledgeOverviewView } from "@shared/types/platform.js";

function overview(over: Partial<KnowledgeOverviewView> = {}): KnowledgeOverviewView {
  return {
    runtime: "ok",
    problem: null,
    at: 1_000_000_000,
    chunks: 10,
    ftsRows: 10,
    sourcesIndexed: { artifacts: 2, messages: 3 },
    pending: { artifacts: 0, messages: 0, preview: [] },
    lastIndexedAt: 999_000_000,
    newestSourceAt: 999_000_000,
    lagMs: 0,
    projects: [],
    ...over,
  };
}

describe("corpusStatus:机制有没有在跑", () => {
  it("正常:行 = FTS、无待索引、无落后", () => {
    const s = corpusStatus(overview());
    expect(s.level).toBe("ok");
    expect(s.label).toContain("一致");
    expect(corpusTone(s.level)).toBe("jade");
  });

  it("读不到 ⇒ unavailable(**不是**「空语料」),并给出下一步", () => {
    const s = corpusStatus(overview({ runtime: "unavailable", problem: "no such table: knowledge_chunks", chunks: 0, ftsRows: 0 }));
    expect(s.level).toBe("unavailable");
    expect(s.detail).toContain("不是");
    expect(s.detail).toContain("重启");
    expect(corpusTone(s.level)).toBe("cinnabar");
  });

  it("行与 FTS 差 1 ⇒ broken(负样本:不能因为「差不多」就放过)", () => {
    expect(corpusStatus(overview({ ftsRows: 9 })).level).toBe("broken");
    expect(corpusStatus(overview({ ftsRows: 11 })).level).toBe("broken");
    expect(corpusStatus(overview({ ftsRows: 10 })).level).toBe("ok");
  });

  it("chunks = 0 且索引一致 ⇒ empty(还没语料,不是坏了)", () => {
    const s = corpusStatus(overview({ chunks: 0, ftsRows: 0, lastIndexedAt: null, newestSourceAt: null, lagMs: null }));
    expect(s.level).toBe("empty");
    expect(corpusTone(s.level)).toBe("mute");
  });

  it("有来源没进语料 ⇒ lagging,并把条数与落后时长说出来", () => {
    const s = corpusStatus(
      overview({
        pending: {
          artifacts: 1, messages: 2,
          preview: [{ sourceKind: "message", sourceId: "m9", projectId: "p1", label: "新的一条" }],
        },
        lagMs: 5 * 60_000,
        at: 1_000_000_000,
        lastIndexedAt: 400_000_000,
      }),
    );
    expect(pendingTotal(overview({ pending: { artifacts: 1, messages: 2, preview: [] } }))).toBe(3);
    expect(s.level).toBe("lagging");
    expect(s.label).toBe("3 条来源还没进语料");
    expect(s.detail).toContain("5 分钟");
    expect(corpusTone(s.level)).toBe("amber");
  });

  it("pending = 0 但时间戳落后 ⇒ 仍然是 lagging(**只看计数会漏掉这一形态**)", () => {
    const s = corpusStatus(overview({ lagMs: 90_000 }));
    expect(s.level).toBe("lagging");
    expect(s.label).toBe("语料落后于来源");
  });
});

describe("fmtSpan / corpusTone 的边界", () => {
  it("45 秒以内 = 刚刚", () => {
    expect(fmtSpan(0)).toBe("刚刚");
    expect(fmtSpan(44_000)).toBe("刚刚");
    expect(fmtSpan(45_000)).toBe("1 分钟");
  });

  it("分钟 / 小时 / 天", () => {
    expect(fmtSpan(5 * 60_000)).toBe("5 分钟");
    expect(fmtSpan(59 * 60_000)).toBe("59 分钟");
    expect(fmtSpan(3 * 3_600_000)).toBe("3 小时");
    expect(fmtSpan(50 * 3_600_000)).toBe("2 天");
  });

  it("负数 / NaN ⇒ 未知(不编一个像真的数字)", () => {
    expect(fmtSpan(-1)).toBe("未知");
    expect(fmtSpan(Number.NaN)).toBe("未知");
  });

  it("五个 level 都有确定的 tone(没有落空的默认色)", () => {
    for (const level of ["ok", "lagging", "empty", "broken", "unavailable"] as const) {
      expect(typeof corpusTone(level)).toBe("string");
    }
  });
});
