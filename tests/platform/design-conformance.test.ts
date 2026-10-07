/**
 * 设计文档 ↔ 代码常量 一致性测试
 *
 * ── 这个测试为什么存在 ────────────────────────────────────────────
 *
 * `src/platform/**` 里的能力联合、工具映射、四个角色的 ceiling 与 writeKinds,
 * **全部是 `docs/DESIGN-PLATFORM.md` / `docs/DESIGN-AGENTS.md` 的转录**。
 * 转录就会漂移。这个项目已经因为「声称有、实际没有」栽过三次:
 *
 *   - 7-B  harness 提示词声称注入,实际是死接线(planner/executor 一直拿 stub)
 *   - 7-E  `enabledTools: ["fs_read","fs_write","shell","http"]` —— 四个名字在
 *          SDK 的闭合联合里根本不存在,却摆在 /api/harness 里像个配置项
 *   - 8-A  集合文件声称执行者有 13 个工具,工具循环里真的只有 6 个 →
 *          提示词教模型用不存在的工具 → 纪律压力下编造
 *
 * 三次同源:**手写的名单与真实能力之间没有机器连接**。这个测试就是那条连接:
 * 代码偏离设计 = 测试失败,而不是等人记得同步。
 *
 * 与 `npm run check:design` 的分工:
 *   check:design             文档 ↔ 文档(四份手工维护的同一事实)
 *   本测试                    文档 ↔ 代码(转录是否忠实)
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseCapabilityUnion,
  parseToolTable,
  parseMatrix,
  parseFactorySets,
  parseArtifactKinds,
  parseDeliverableTypes,
  parseProtocolKinds,
  parseInlineWriteKinds,
  parseCeilings,
  parsePromptUnits,
  parseClaimedCounts,
} from "../../docs/design-parse.mjs";
import {
  CAPABILITIES,
  CAPABILITY_TOOLS,
  ALL_TOOLS,
  expandCapabilities,
  type Capability,
  type ToolName,
} from "../../src/platform/harness/capability.js";
import {
  PROJECT_ROLES,
  ROLE_SPECS,
  ARTIFACT_KINDS,
  PROTOCOL_CREATED_KINDS,
  WRITEKIND_EXEMPT_KINDS,
  factoryToolset,
  type ProjectRole,
} from "../../src/platform/identity/role.js";
import { DELIVERABLE_TYPES } from "../../src/platform/storage/repo/artifacts.js";

const DOCS = join(import.meta.dirname, "../../docs");
const p1 = readFileSync(join(DOCS, "DESIGN-PLATFORM.md"), "utf8");
const p2 = readFileSync(join(DOCS, "DESIGN-AGENTS.md"), "utf8");

const docCaps = parseCapabilityUnion(p1);
const docTools = parseToolTable(p1);
const docMatrix = parseMatrix(p2);
const docFactory = parseFactorySets(p2);
const docKinds = parseArtifactKinds(p1);
const docDeliverableTypes = parseDeliverableTypes(p1);
const docProtocolKinds = parseProtocolKinds(p1);
const docInlineWK = parseInlineWriteKinds(p2);
const docCeilings = parseCeilings(p2);
const docPromptUnits = parsePromptUnits(p2);
// 计数声明分居两份文档:设计 1 写「N 条 capability 展开成 M 个工具」,
// 设计 2 写「共 N 条 capability」。逐字段取第一个非 null —— 直接展开合并会用
// 后一份的 null 覆盖前一份的真值。
const counts1 = parseClaimedCounts(p1);
const counts2 = parseClaimedCounts(p2);
const docCounts = {
  capabilities: counts1.capabilities ?? counts2.capabilities,
  tools: counts1.tools ?? counts2.tools,
  matrixCapabilities: counts2.matrixCapabilities ?? counts1.matrixCapabilities,
};

/** 显示名(业务经理)→ 角色代号(business_manager)。取自文档标题。 */
const displayToCode = new Map(docFactory.map((f) => [f.role, f.code]));

/** 把 Set 差集渲染成可读文本,失败时一眼看出多了什么少了什么。 */
function diff(actual: Iterable<string>, expected: Iterable<string>): string {
  const a = new Set(actual);
  const b = new Set(expected);
  const extra = [...a].filter((x) => !b.has(x));
  const missing = [...b].filter((x) => !a.has(x));
  const parts: string[] = [];
  if (extra.length) parts.push(`代码多出: ${extra.join(", ")}`);
  if (missing.length) parts.push(`代码缺少: ${missing.join(", ")}`);
  return parts.join(" | ") || "(无差异)";
}

describe("设计文档解析成功(前置)", () => {
  it("五份结构都解析到了", () => {
    expect(docCaps?.size, "设计 1 能力联合").toBeGreaterThan(0);
    expect(docTools?.size, "设计 1 工具展开表").toBeGreaterThan(0);
    expect(docMatrix?.roles.length, "设计 2 角色矩阵").toBe(4);
    expect(docFactory.length, "设计 2 出厂集合").toBe(4);
    expect(docKinds?.size, "设计 1 ArtifactKind").toBeGreaterThan(0);
  });

  it("四份出厂集合 JSON 都合法", () => {
    const bad = docFactory.filter((f) => f.parseError).map((f) => f.role);
    expect(bad, "这些角色的 JSON 解析失败,文档里可能有尾逗号").toEqual([]);
  });
});

describe("E1 · 能力联合 ↔ CAPABILITIES", () => {
  it("集合完全一致", () => {
    const actual = [...CAPABILITIES];
    const expected = [...docCaps.keys()];
    expect(diff(actual, expected)).toBe("(无差异)");
    expect(actual.length).toBe(expected.length);
  });

  it("顺序一致(便于读 diff)", () => {
    expect([...CAPABILITIES]).toEqual([...docCaps.keys()]);
  });
});

describe("E2 · 能力 → 工具展开 ↔ CAPABILITY_TOOLS", () => {
  it("每条能力都有映射条目,且没有多余条目", () => {
    expect(diff(Object.keys(CAPABILITY_TOOLS), [...docCaps.keys()])).toBe("(无差异)");
  });

  it("每条能力的工具列表与文档逐项一致", () => {
    for (const [cap, tools] of docTools) {
      const actual = CAPABILITY_TOOLS[cap as Capability];
      expect(actual, `能力 ${cap} 在 CAPABILITY_TOOLS 里没有条目`).toBeDefined();
      expect([...actual], `能力 ${cap} 的工具列表与设计 1 §3.2 不一致`).toEqual(tools);
    }
  });

  it("工具名全局唯一(否则展开有歧义)", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [cap, tools] of Object.entries(CAPABILITY_TOOLS) as [Capability, readonly ToolName[]][]) {
      for (const t of tools) {
        const prev = seen.get(t);
        if (prev) dupes.push(`${t}: ${prev} 与 ${cap}`);
        else seen.set(t, cap);
      }
    }
    expect(dupes, "同一个工具名挂到了两条能力下").toEqual([]);
  });

  it("ALL_TOOLS 与实际展开一致", () => {
    const fromCaps = [...new Set(Object.values(CAPABILITY_TOOLS).flat())].sort();
    expect([...ALL_TOOLS]).toEqual(fromCaps);
  });
});

describe("E3 · 角色代号 ↔ 文档标题", () => {
  it("PROJECT_ROLES 与文档里的四个角色代号一致", () => {
    const codes = docFactory.map((f) => f.code);
    expect(diff(PROJECT_ROLES, codes)).toBe("(无差异)");
  });
});

describe("E4 · 各角色 ceiling ↔ ROLE_SPECS", () => {
  for (const display of ["业务经理", "项目经理", "Worker", "质检审查员"]) {
    it(`${display} 的 ceiling 与设计 2 一致`, () => {
      const code = displayToCode.get(display) as ProjectRole | undefined;
      expect(code, `文档里找不到角色「${display}」的代号`).toBeDefined();
      const docCeiling = docCeilings?.get(display);
      expect(docCeiling, `解析不到 ${display} 的 Capability Ceiling 段`).toBeDefined();
      expect(
        diff(ROLE_SPECS[code as ProjectRole].ceiling, docCeiling as Set<string>),
        `${display}(${code}) 的 ceiling 与设计 2 §Capability Ceiling 漂移`,
      ).toBe("(无差异)");
    });
  }
});

describe("E5 · 各角色 writeKinds ↔ ROLE_SPECS", () => {
  for (const display of ["业务经理", "项目经理", "Worker", "质检审查员"]) {
    it(`${display} 的 writeKinds 与设计 2 一致`, () => {
      const code = displayToCode.get(display) as ProjectRole;
      const docWK = docInlineWK?.get(display);
      expect(docWK, `解析不到 ${display} 的内联 writeKinds`).toBeDefined();
      expect(
        diff(ROLE_SPECS[code].writeKinds, docWK as Set<string>),
        `${display}(${code}) 的 writeKinds 与设计 2 漂移`,
      ).toBe("(无差异)");
    });
  }
});

describe("E6 · 出厂工具集 = expand(ceiling),且与文档 allow 一致", () => {
  for (const f of docFactory) {
    it(`${f.role} 的出厂 allow 与文档一致`, () => {
      const code = f.code as ProjectRole;
      const derived = factoryToolset(code);
      // 两侧都要对:推导出来的要等于文档 allow(证明文档没写错),
      // 也要等于 ceiling 展开(证明代码没另存名单)。
      expect(
        diff(derived, [...f.allow]),
        `${f.role}:factoryToolset(ceiling) 与设计 2 §出厂工具集合 的 allow 不一致`,
      ).toBe("(无差异)");
      expect(diff(expandCapabilities(ROLE_SPECS[code].ceiling), derived)).toBe("(无差异)");
    });

    it(`${f.role} 的 boundaryDeny 与文档 deny 一致`, () => {
      const code = f.code as ProjectRole;
      expect(
        diff(ROLE_SPECS[code].boundaryDeny, [...f.deny]),
        `${f.role}:boundaryDeny 与设计 2 的 deny 列表不一致`,
      ).toBe("(无差异)");
    });
  }
});

describe("E7 · 工件 kind ↔ ARTIFACT_KINDS", () => {
  it("闭合集与设计 1 §6.1 一致", () => {
    expect(diff(ARTIFACT_KINDS, [...(docKinds as Set<string>)])).toBe("(无差异)");
  });

  it("PROTOCOL_CREATED_KINDS 与设计 1 §6.2 一致", () => {
    expect(diff(PROTOCOL_CREATED_KINDS, [...(docProtocolKinds as Set<string>)])).toBe("(无差异)");
  });

  /**
   * 交付物类型(migration 025)—— 与 kind 是**两个闭集**,同一个病(转录漂移)。
   *
   * 这一条的价值在于它同时挡住两个方向的漂移:文档里多写一个「以后要做的
   * git_repo」而代码没做(文档开始承诺平台造不出来的东西),以及代码里加了
   * 一个而文档没记(设计文档不再是意图的真相)。**两个方向都红。**
   */
  it("交付物类型闭集与设计 1 §6.4 一致(加类型是纯加法,两处必须同步)", () => {
    expect(docDeliverableTypes, "设计 1 §6.4 找不到 DeliverableType 联合").not.toBeNull();
    expect(diff(DELIVERABLE_TYPES, [...(docDeliverableTypes as Set<string>)])).toBe("(无差异)");
  });

  it("WRITEKIND_EXEMPT_KINDS 是 PROTOCOL_CREATED_KINDS 的子集", () => {
    const protocol = new Set<string>(PROTOCOL_CREATED_KINDS);
    const orphans = WRITEKIND_EXEMPT_KINDS.filter((k) => !protocol.has(k));
    expect(
      orphans,
      "例外集里的 kind 必须本来就是协议创建的,否则这条豁免没有意义",
    ).toEqual([]);
  });

  it("除文档化例外外,协议创建的 kind 不在任何角色的 writeKinds 里", () => {
    const forbidden = PROTOCOL_CREATED_KINDS.filter(
      (k) => !(WRITEKIND_EXEMPT_KINDS as readonly string[]).includes(k),
    );
    const bad: string[] = [];
    for (const role of PROJECT_ROLES) {
      for (const k of ROLE_SPECS[role].writeKinds) {
        if ((forbidden as readonly string[]).includes(k)) {
          bad.push(`${role}.writeKinds 含协议创建的 ${k}`);
        }
      }
    }
    expect(bad, "协议工具创建的 kind 不该由模型手写(设计 1 §6.2)").toEqual([]);
  });
});

describe("R1 不变量 · 甲方只与业务经理交互", () => {
  it("只有 business_manager 的 clientFacing 为 true", () => {
    const facing = PROJECT_ROLES.filter((r) => ROLE_SPECS[r].clientFacing);
    expect(facing).toEqual(["business_manager"]);
  });

  it("只有 business_manager 的 ceiling 含 client.*", () => {
    const holders = PROJECT_ROLES.filter((r) =>
      ROLE_SPECS[r].ceiling.some((c) => c === "client.ask" || c === "client.message"),
    );
    expect(holders, "这是整套设计最硬的一条:甲方那道门只有一个把手").toEqual([
      "business_manager",
    ]);
  });

  it("非客户接口角色即便把 client.* 手写进集合文件也拿不到(scope 门在 ceiling 之后)", () => {
    // 这条在 authorize.test.ts 里做行为验证;这里只钉住静态事实:
    // 非 clientFacing 角色的 ceiling 里根本没有 client.*,所以连 ceiling 门都过不了。
    for (const r of PROJECT_ROLES) {
      if (ROLE_SPECS[r].clientFacing) continue;
      const has = ROLE_SPECS[r].ceiling.filter((c) => c.startsWith("client."));
      expect(has, `${r} 不该有 client.* 能力`).toEqual([]);
    }
  });
});

describe("E8 · 文档声称的计数", () => {
  it("设计 1 声称的 capability / tool 数与代码一致", () => {
    expect(docCounts.capabilities, "设计 1 没写「N 条 capability」").not.toBeNull();
    expect(docCounts.capabilities).toBe(CAPABILITIES.length);
    expect(docCounts.tools).toBe(ALL_TOOLS.length);
  });

  it("设计 2 声称的 capability 数与代码一致", () => {
    expect(docCounts.matrixCapabilities).toBe(CAPABILITIES.length);
  });

  it("矩阵覆盖全部能力(没有能力漏出矩阵)", () => {
    const inMatrix = new Set<string>();
    for (const s of docMatrix!.granted.values()) for (const c of s) inMatrix.add(c);
    expect(diff(inMatrix, CAPABILITIES)).toBe("(无差异)");
  });
});

describe("E9 · 各角色 promptUnits ↔ 设计 2 提示词单元表", () => {
  for (const display of ["业务经理", "项目经理", "Worker", "质检审查员"]) {
    it(`${display} 的 promptUnits 与文档一致`, () => {
      const code = displayToCode.get(display) as ProjectRole;
      const docUnits = docPromptUnits?.get(display);
      expect(docUnits, `解析不到 ${display} 的提示词单元表`).toBeDefined();
      expect(
        diff(ROLE_SPECS[code].promptUnits, docUnits as Set<string>),
        `${display}(${code}) 的 promptUnits 与设计 2 漂移`,
      ).toBe("(无差异)");
    });
  }
});
