/**
 * 工具面的「类型 / 名称 / 作用」—— `RoleHarnessView.toolBriefs` 的判据。
 *
 * ── 这一组守着的缺陷形态 ────────────────────────────────────────
 *
 * 用户的原话(2026-10-08):
 *
 *   「工具 做一个表格,按照类型、名称、作用来,现在搞一对英文名称的 list,
 *     完全不知道都有些啥」
 *
 * 界面上要填的「作用」,平台**早就有一份** —— `PlatformTool.description`,写在
 * `src/platform/tools/*.ts` 里,由实现那个工具的人写下。最容易做错的一件事是
 * **在 `briefs.ts` 里另写一份更短、更好读的中文说明**:那一刻起就有了两份关于
 * 「这个工具是干嘛的」的真相,而它们漂开时「界面说的」与「模型拿到的」不一样,
 * 屏幕上完全看不出来。所以本文件的重点判据是**同一性**
 * (`toolBrief(t).purpose === TOOL_INDEX.get(t).description`),不是「差不多」。
 *
 * 另一头是 SDK 内置那 7 个:`read / grep / find / ls / edit / write / bash` 由 Pi SDK
 * 提供实现,平台注册表里**没有**它们,SDK 给的描述是英文 ⇒ 平台补一句中文。
 * 补的那句必须真的有中文(照抄英文描述会让「补了」变成一句空话)。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import {
  ALL_TOOLS, CAPABILITIES, CAPABILITY_GROUP, capabilityGroup, isSdkToolName,
} from "../../src/platform/harness/capability.js";
import { capabilityOfTool } from "../../src/platform/harness/authorize.js";
import { TOOL_INDEX, registrySnapshot } from "../../src/platform/tools/registry.js";
import { SDK_TOOL_PURPOSE, toolBrief, toolBriefs } from "../../src/platform/tools/briefs.js";
import { openPlatformMemoryDb } from "../../src/platform/storage/index.js";
import { insertAgent } from "../../src/platform/storage/repo/agents.js";
import { buildHarnessView } from "../../src/platform/transport/http.js";

const CLOCK = 1_700_000_000_000;
const dirs: string[] = [];
let db: Database.Database | undefined;

afterEach(() => {
  db?.close();
  db = undefined;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

/** 有中文字的个数 —— 用来判「这句真的是中文写的」,而不是把 SDK 的英文粘过来。 */
const hanCount = (s: string): number => (s.match(/[\u4e00-\u9fff]/g) ?? []).length;

describe("组表:能力 → 中文分组(闭合,不许多也不许少)", () => {
  it("键集合 === 能力联合,且每组都有名字", () => {
    expect(Object.keys(CAPABILITY_GROUP).sort()).toEqual([...CAPABILITIES].sort());
    for (const c of CAPABILITIES) {
      expect(capabilityGroup(c).trim().length, `${c} 没有分组名`).toBeGreaterThan(0);
    }
  });

  it("非空自检:这条断言真的在比对两组非空的东西", () => {
    expect(CAPABILITIES.length).toBeGreaterThan(30);
    expect(new Set(Object.values(CAPABILITY_GROUP)).size).toBeGreaterThan(5);
  });
});

describe("每个工具都有 brief(名称 / 来源 / 能力 / 分组 / 作用)", () => {
  it("`ALL_TOOLS` 里一个不漏,而且字段之间自洽", () => {
    for (const t of ALL_TOOLS) {
      const b = toolBrief(t);
      expect(b.name, "名称必须原样 —— 模型调的就是它").toBe(t);
      expect(b.source, `${t} 的来源判错了`).toBe(isSdkToolName(t) ? "sdk" : "platform");
      expect(b.capability, `${t} 的能力 id 与反查表不一致`).toBe(capabilityOfTool(t));
      expect(b.group, `${t} 落到了「未分类」—— 能力↔工具表脱节了`).not.toBe("未分类");
      expect(b.purpose.trim().length, `${t} 没有作用说明`).toBeGreaterThan(0);
    }
    // 非空自检:上面那一圈真的转了 45 个工具(38 平台 + 7 SDK)
    expect(ALL_TOOLS.length).toBe(45);
  });

  it("**平台工具的作用 === 注册表里的 description**(不是这里另抄的一份)", () => {
    for (const [name, tool] of TOOL_INDEX) {
      expect(toolBrief(name).purpose, `${name} 的说明与注册表分叉了`).toBe(tool.description);
    }
    // 正样本:注册表本身非空,否则上面那圈是空转
    expect(TOOL_INDEX.size).toBe(38);
  });

  it("SDK 内置 7 个:各有一句**中文**说明(照抄英文描述不算补)", () => {
    expect(Object.keys(SDK_TOOL_PURPOSE).sort()).toEqual(
      ["bash", "edit", "find", "grep", "ls", "read", "write"],
    );
    for (const [name, purpose] of Object.entries(SDK_TOOL_PURPOSE)) {
      expect(hanCount(purpose), `${name} 的说明里几乎没有中文`).toBeGreaterThan(3);
      expect(toolBrief(name as keyof typeof SDK_TOOL_PURPOSE).purpose).toBe(purpose);
    }
  });

  it("`toolBriefs` 保序、保长(界面按 `tools` 的顺序画表)", () => {
    const names = ["board_list", "read", "memory_search"] as const;
    const out = toolBriefs([...names]);
    expect(out.map((b) => b.name)).toEqual([...names]);
    expect(out.length).toBe(names.length);
  });

  it("覆盖判据的前提仍然成立:没有「进了工具面却没实现」的工具", () => {
    // `toolBrief` 里那条「注册表里没有 ⇒ 这是一条缺陷」的分支现在**不可达**。
    // 它一旦可达,「每个工具都有 brief」那条断言仍会绿(缺陷文案也是非空字符串),
    // 而界面上会出现一条自己承认是缺陷的说明 —— 所以在这里钉死前提。
    expect(registrySnapshot().notYetBuilt).toEqual([]);
  });

  it("负样本自检:能力反查表真的覆盖全部工具(证明上面的自洽断言不是空转)", () => {
    expect(ALL_TOOLS.filter((t) => capabilityOfTool(t) === undefined)).toEqual([]);
  });
});

describe("接线:`GET /api/harness` 的 toolBriefs 与 tools 同序同长", () => {
  it("播种一个角色之后,它的 briefs 逐条对上 tools(而且说明不是空串)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ss-briefs-"));
    dirs.push(dataDir);
    db = openPlatformMemoryDb();
    insertAgent(db, {
      id: "ag_bm", role: "business_manager", specialization: null,
      displayName: "业务经理", createdAt: CLOCK,
    });

    const bm = buildHarnessView(db, dataDir).roles.find((r) => r.role === "business_manager");
    expect(bm).toBeDefined();
    if (bm === undefined) return;
    expect(bm.tools.length, "接待模式下业务经理拿得到 project_open 一类").toBeGreaterThan(0);
    expect(bm.toolBriefs?.map((b) => b.name)).toEqual([...bm.tools]);
    for (const b of bm.toolBriefs ?? []) {
      expect(b.purpose.trim().length, `${b.name} 有名字没说明`).toBeGreaterThan(0);
    }
  });

  it("求解不了的角色:tools 与 toolBriefs 都是空的(**不是**有名字没说明)", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "ss-briefs-"));
    dirs.push(dataDir);
    db = openPlatformMemoryDb(); // 一个 agent 都不种

    for (const r of buildHarnessView(db, dataDir).roles) {
      expect(r.toolsSolved).toBe(false);
      expect(r.tools).toEqual([]);
      expect(r.toolBriefs).toEqual([]);
    }
  });
});
