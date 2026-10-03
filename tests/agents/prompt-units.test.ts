/**
 * 批次 7-G · harness 提示词单元(prompt units)
 *
 * 守四件事,按重要性:
 *
 *   1. **反 7-B 死接线(本文件存在的头号理由)**。批次 7-B 的事故是
 *      `system_prompts/{planner,executor}.md` 写好了、版本链也做好了,但
 *      `spawnPlanner` 只传 `{ storage }`,提示词**根本没到达模型**,而当时
 *      没有任何机制能发现这一点 —— describePrompts 只看「文件存在 + 内容比对」,
 *      报的是漂亮的 `default`。
 *      7-G 的修法:注册表 `PROMPT_UNITS` 声明式记录每个单元的 `consumer`,
 *      **本文件到 src/ 里 grep 那条路径**,grep 不到就红。注册表从此不可能
 *      靠「我写了文件」自称在生效。
 *      (tools 侧有同款守卫 tests/server/harness-tool-bridge.test.ts。)
 *
 *   2. **orphan 必须标、且必须给理由**。critic / memory / reflection 零消费方,
 *      7-G 之前它们被报成 `default`(像生效中的配置)。现在 state 必须是
 *      `orphan`,且 `orphanReason` 必填 —— 一个没有理由的 orphan 等于没标注。
 *
 *   3. **出厂默认 === 内置回退值,逐字**。若两者漂移,「用户删了文件 → 回退」
 *      与「全新安装 → 写出厂默认」会给出不同内容,用户看到的 state 自相矛盾。
 *
 *   4. **降级语义**:文件缺失/为空 → `loadHarness` 给空串 → 消费方回退内置常量。
 *      loader 刻意不直接填内置值(那是消费方的回退逻辑,唯一真相)。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BUILTIN_PROMPTS,
  PROMPT_UNITS,
  PROMPT_UNIT_IDS,
  getPromptUnit,
  type PromptUnitId,
} from "../../src/server/harness/promptUnits.js";
import { describePrompts, ensureHarness, loadHarness } from "../../src/server/harness/loader.js";
import { describeHarness, harnessFacets, getFacet } from "../../src/server/harness/facet.js";

/**
 * 仓库根与 src 目录分开:注册表里的 `consumer` 路径是**相对 src/** 的
 * ("kernel/agentKernel.ts:…"),而本文件里手写的检查用 "src/..." 全路径。
 * 两个基准混用过一次,这里显式分开,免得再犯。
 */
const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SRC_DIR = join(REPO_ROOT, "src");
/** 注册表里 `consumer` 的路径是相对 `src/server/` 的("kernel/agentKernel.ts")。 */
const SERVER_DIR = join(SRC_DIR, "server");

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "sansheng-prompt-units-"));
});
afterEach(() => {
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
});

function promptPath(dir: string, unit: string): string {
  return join(dir, "harness", "system_prompts", `${unit}.md`);
}

describe("7-G 提示词注册表 · 自洽性", () => {
  it("10 个单元,id 唯一,且每个都有非空的内置回退值", () => {
    expect(PROMPT_UNIT_IDS).toHaveLength(10);
    expect(new Set(PROMPT_UNIT_IDS).size).toBe(10);
    for (const id of PROMPT_UNIT_IDS) {
      const text = BUILTIN_PROMPTS[id];
      expect(text, `${id} 没有内置回退值`).toBeTruthy();
      expect(text.trim().length, `${id} 内置值是空白`).toBeGreaterThan(0);
    }
  });

  it("enforced=false 的单元必须给 orphanReason(没有理由的 orphan 等于没标注)", () => {
    for (const u of PROMPT_UNITS) {
      if (u.enforced) {
        expect(u.consumer, `${u.id} 声称已生效却没有 consumer`).not.toBe("(无)");
      } else {
        expect(u.orphanReason, `${u.id} 是 orphan 但没写原因`).toBeTruthy();
        expect((u.orphanReason ?? "").length, `${u.id} 的 orphanReason 太敷衍`).toBeGreaterThan(10);
      }
    }
  });

  it("已知的三份死文件确实被标成 orphan(这是 7-G 的行为变更点)", () => {
    for (const id of ["critic", "memory", "reflection"] as const) {
      expect(getPromptUnit(id).enforced, `${id} 应为 orphan`).toBe(false);
    }
    for (const id of [
      "communicator", "communicator.decide", "communicator.align",
      "planner", "executor", "sedimentation", "harness_manager",
    ] as const) {
      expect(getPromptUnit(id).enforced, `${id} 应为 enforced`).toBe(true);
    }
  });

  it("getPromptUnit 对未知 id 抛错(不给 undefined 让调用方自己判)", () => {
    expect(() => getPromptUnit("nope" as PromptUnitId)).toThrow(/unknown prompt unit/);
  });
});

describe("7-G 反 7-B 死接线守卫 · enforced 声称必须在 src/ 里落地", () => {
  it("每个 enforced 单元的 consumer 路径都能在 src/ 里找到(文件 + 关键符号)", () => {
    const byFile = new Map<string, { unit: string; symbol: string }[]>();
    for (const u of PROMPT_UNITS) {
      if (!u.enforced) continue;
      // consumer 两种写法都要吃下:
      //   "kernel/agentKernel.ts:createPiSession → …"(冒号接符号)
      //   "agents/communicator.ts makeLlmCommunicatorDecide"(空格接符号)
      // 用正则而不是 split(箭头/空格)—— 后者对分隔符字符敏感,
      // 第一次写就栽在这上面(路径被截成 "xxx.ts:" )。
      const m = /([\w./-]+\.ts)(?::([\w]+))?(?:\s+([\w]+))?/.exec(u.consumer);
      expect(m, `consumer 格式无法解析:${u.consumer}`).toBeTruthy();
      const relPath = m![1] as string;
      const symbol = (m![2] ?? m![3] ?? "") as string;
      const list = byFile.get(relPath) ?? [];
      list.push({ unit: u.id, symbol });
      byFile.set(relPath, list);
    }
    // 至少要检查到 4 个不同的源文件,否则这条守卫形同虚设
    expect(byFile.size).toBeGreaterThanOrEqual(4);
    for (const [relPath, units] of byFile) {
      const abs = join(SERVER_DIR, relPath);
      expect(existsSync(abs), `consumer 指向的源文件不存在:${relPath}`).toBe(true);
      const src = readFileSync(abs, "utf-8");
      for (const { unit, symbol } of units) {
        if (!symbol) continue;
        expect(src.includes(symbol), `${unit} 声称由 ${relPath} 的 ${symbol} 消费,但那里没有这个符号`).toBe(true);
      }
    }
  });

  it("decide / align / sedimentation / harness_manager 四处真的读了 harness 值(不是只声明)", () => {
    // 这四个是 7-G 从「编译在模块里」搬进版本链的。声明 enforced 却没真读,
    // 就是 7-B 的同款病 —— 所以直接查消费点。
    const checks: Array<[string, string]> = [
      ["src/server/agents/communicator.ts", "communicator.decide"],
      ["src/server/agents/communicator.ts", "communicator.align"],
      ["src/server/kernel/agentKernel.ts", "communicator.decide"],
      ["src/server/kernel/agentKernel.ts", "communicator.align"],
      ["src/server/kernel/agentKernel.ts", "systemPrompts.sedimentation"],
      ["src/server/agents/harnessBoot.ts", "systemPrompts[\"harness_manager\"]"],
    ];
    for (const [rel, needle] of checks) {
      const src = readFileSync(join(REPO_ROOT, rel), "utf-8");
      expect(src.includes(needle), `${rel} 里找不到 ${needle} —— 声称接线了但没读 harness`).toBe(true);
    }
  });

  it("消费点的回退是「harness 空 → 内置常量」,不是「harness 空 → 空 prompt」", () => {
    const comm = readFileSync(join(SRC_DIR, "server/agents/communicator.ts"), "utf-8");
    // decide 与 align 各一处 `deps.systemPrompt?.trim() ? ... : <内置常量>`
    const fallbacks = comm.match(/deps\.systemPrompt\?\.trim\(\) \? deps\.systemPrompt : \w+/g) ?? [];
    expect(fallbacks.length, "decide / align 的 harness 回退表达式不见了").toBeGreaterThanOrEqual(2);
    expect(fallbacks.some((f) => f.includes("DECIDE_SYSTEM_PROMPT"))).toBe(true);
    expect(fallbacks.some((f) => f.includes("ALIGN_SYSTEM_PROMPT"))).toBe(true);

    const sed = readFileSync(join(SRC_DIR, "server/agents/sedimentation.ts"), "utf-8");
    expect(sed).toMatch(/deps\.systemPrompt\?\.trim\(\) \? deps\.systemPrompt : SEDIMENT_SYSTEM_PROMPT/);

    const boot = readFileSync(join(SRC_DIR, "server/agents/harnessBoot.ts"), "utf-8");
    expect(boot).toMatch(/harnessPrompt\.trim\(\) \? harnessPrompt : FALLBACK_HARNESS_PROMPT/);
  });
});

describe("7-G 落盘 · 出厂文件 === 内置回退值(逐字)", () => {
  it("ensureHarness 为全部 10 个单元写出厂文件,且内容与 BUILTIN_PROMPTS 逐字相同", () => {
    ensureHarness(dataDir);
    for (const id of PROMPT_UNIT_IDS) {
      const p = promptPath(dataDir, id);
      expect(existsSync(p), `${id}.md 未生成`).toBe(true);
      expect(readFileSync(p, "utf-8"), `${id}.md 与内置回退值不一致`).toBe(BUILTIN_PROMPTS[id]);
    }
  });

  it("幂等 + 不覆盖用户手笔(与 tools 侧同一套三分支)", () => {
    ensureHarness(dataDir);
    const first = readFileSync(promptPath(dataDir, "planner"), "utf-8");
    ensureHarness(dataDir);
    expect(readFileSync(promptPath(dataDir, "planner"), "utf-8")).toBe(first);

    const edited = `${BUILTIN_PROMPTS.planner}\n\n# 用户手笔\n`;
    writeFileSync(promptPath(dataDir, "planner"), edited, "utf-8");
    ensureHarness(dataDir);
    expect(readFileSync(promptPath(dataDir, "planner"), "utf-8")).toBe(edited);
  });

  it("存量四工具时代的 7-E 提示词文件不会被误判成用户手笔(版本链仍然有效)", () => {
    // 7-E 之前 6 角色的出厂文件与现在一致(内容没变),所以幂等分支就够;
    // 这里只确认 7-G 新增的单元不会让老文件的 state 发生意外变化。
    ensureHarness(dataDir);
    const before = describePrompts(dataDir).find((p) => p.role === "planner")?.state;
    ensureHarness(dataDir);
    const after = describePrompts(dataDir).find((p) => p.role === "planner")?.state;
    expect(before).toBe("default");
    expect(after).toBe(before);
  });
});

describe("7-G state 语义 · orphan 不再冒充 default", () => {
  it("enforced 单元的 state 随文件变化;orphan 单元恒为 orphan", () => {
    ensureHarness(dataDir);
    const byId = new Map(describePrompts(dataDir).map((p) => [p.role, p]));
    for (const id of PROMPT_UNIT_IDS) {
      const info = byId.get(id);
      expect(info, `${id} 缺失`).toBeTruthy();
      if (!getPromptUnit(id).enforced) {
        expect(info!.state, `${id} 必须报 orphan`).toBe("orphan");
      } else {
        expect(info!.state, `${id} 应报 default`).toBe("default");
        expect(info!.consumer.length).toBeGreaterThan(0);
      }
    }
  });

  it("文件被用户编辑 → user_edited;文件清空 → empty(且仍 enforced)", () => {
    ensureHarness(dataDir);
    writeFileSync(promptPath(dataDir, "executor"), "# 我改的\n", "utf-8");
    expect(describePrompts(dataDir).find((p) => p.role === "executor")?.state).toBe("user_edited");

    writeFileSync(promptPath(dataDir, "executor"), "   \n", "utf-8");
    const emptied = describePrompts(dataDir).find((p) => p.role === "executor");
    expect(emptied?.state).toBe("empty");
    expect(emptied?.enforced, "文件空 ≠ 没有消费方").toBe(true);
  });

  it("loadHarness 对缺失/空文件给空串(回退是消费方的事,不是 loader 的)", () => {
    mkdirSync(join(dataDir, "harness", "system_prompts"), { recursive: true });
    const cfg = loadHarness(dataDir);
    expect(cfg.systemPrompts.communicator).toBe("");
    writeFileSync(promptPath(dataDir, "communicator"), BUILTIN_PROMPTS.communicator, "utf-8");
    expect(loadHarness(dataDir).systemPrompts.communicator).toBe(BUILTIN_PROMPTS.communicator);
  });
});

describe("7-G facet 注册表 · 五个面(含两个未实现面)", () => {
  it("注册表含 tools / prompts / skills / rag 四个面,顺序稳定", () => {
    expect(harnessFacets().map((f) => f.id)).toEqual(["tools", "prompts", "skills", "rag"]);
  });

  it("未实现的面:标 implemented=false + 写清缺什么 + 不编造条目", () => {
    for (const id of ["skills", "rag"] as const) {
      const f = getFacet(id);
      expect(f.implemented, `${id} 应未实现`).toBe(false);
      expect(f.notImplementedNote?.length ?? 0, `${id} 缺「缺什么」说明`).toBeGreaterThan(20);
      const dataDir2 = mkdtempSync(join(tmpdir(), `sansheng-facet-${id}-`));
      try {
        expect(f.describe(dataDir2), `${id} 编造了条目`).toEqual([]);
        // ensure 不许写任何出厂文件 —— 未实现的面写空壳目录才是造假
        f.ensure(dataDir2);
        expect(existsSync(join(dataDir2, "harness", "skills"))).toBe(false);
        expect(existsSync(join(dataDir2, "harness", "rag"))).toBe(false);
      } finally {
        rmSync(dataDir2, { recursive: true, force: true });
      }
    }
  });

  it("describeHarness 的条目形状与 HarnessEntry 契约一致(UI / diagnose 靠它渲染)", () => {
    ensureHarness(dataDir);
    const snap = describeHarness(dataDir);
    expect(snap.map((f) => f.id)).toEqual(["tools", "prompts", "skills", "rag"]);
    for (const facet of snap) {
      for (const e of facet.entries) {
        expect(typeof e.id).toBe("string");
        expect(typeof e.enforced).toBe("boolean");
        expect(e.basis.length, `${facet.id}/${e.id} 缺 basis 理由`).toBeGreaterThan(0);
        expect(["factory", "user"]).toContain(e.source);
        expect(Array.isArray(e.warnings)).toBe(true);
        // enforced=false 必须有可读的 basis(缺失原因),不能是空串或 "(无)"
        if (!e.enforced) {
          expect(e.basis, `${facet.id}/${e.id} orphan 没写原因`).not.toBe("(无)");
        }
      }
    }
    const prompts = snap.find((f) => f.id === "prompts");
    expect(prompts?.entries.length).toBe(10);
    const orphan = prompts?.entries.filter((e) => !e.enforced).map((e) => e.id);
    expect(orphan?.sort()).toEqual(["critic", "memory", "reflection"]);
  });

  it("数据目录不存在时不抛(冷启动路径必须安全)", () => {
    const cold = join(dataDir, "never-created");
    expect(() => describeHarness(cold)).not.toThrow();
    const snap = describeHarness(cold);
    expect(snap.length).toBe(4);
    // 没 ensure 过 → 工具面退回出厂,提示词面全 empty
    expect(snap.find((f) => f.id === "tools")?.entries.length).toBe(7);
    expect(snap.find((f) => f.id === "prompts")?.entries.every((e) => e.chars === 0)).toBe(true);
  });
});

describe("7-J 回归 · sedimentation 提示词版本链(我自己踩的第 4 次同款坑)", () => {
  it("5b-2 出厂默认已入链 —— 否则 7-J 改了提示词后存量用户文件被永久误判为用户手笔", async () => {
    const { LEGACY_DEFAULTS } = await import("../../src/server/harness/loader.js");
    const chain = (LEGACY_DEFAULTS as Record<string, string[]>).sedimentation;
    expect(Array.isArray(chain), "sedimentation 没有版本链").toBe(true);
    // 5b-2 初版(D7 四形态版)必须在链里
    const legacy = chain!.find((t) => t.includes("kind 只能四选一"));
    expect(legacy, "5b-2 出厂默认未入链 —— 存量用户的 sedimentation.md 会卡在 user_edited").toBeTruthy();
    expect(legacy).toContain("intent");
  });

  it("7-J 新默认本身不在链里(链只装历史版本,否则升级判定自相矛盾)", async () => {
    const { LEGACY_DEFAULTS } = await import("../../src/server/harness/loader.js");
    const { BUILTIN_PROMPTS } = await import("../../src/server/harness/promptUnits.js");
    const chain = (LEGACY_DEFAULTS as Record<string, string[]>).sedimentation ?? [];
    expect(chain).not.toContain(BUILTIN_PROMPTS.sedimentation);
  });
});
