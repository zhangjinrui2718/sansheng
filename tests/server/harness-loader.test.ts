/**
 * 批次 5a · T1 — harness loader 默认 prompt 升级逻辑单测
 *
 * 覆盖 ensureHarness 三分支(绝不静默覆盖用户编辑,harness=雇员手册):
 *   ① 文件恰好等于旧内嵌默认(LEGACY) → 覆盖升级为新默认
 *   ② 文件被用户编辑过(≠旧默认且≠新默认) → 原样保留
 *   ③ 文件已等于新默认 → 跳过(幂等,不重写)
 * 以及 loadHarness 端到端读回。
 *
 * 全部使用 mkdtemp 临时目录,不碰真实 ~/.sansheng。
 */
import { describe, it, expect } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  utimesSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureHarness, loadHarness } from "../../src/server/harness/loader.js";

/**
 * 批次 5a 之前的旧内嵌 communicator 默认(9 行版,无尾换行)。
 * 必须与 loader.ts LEGACY_DEFAULTS.communicator 字节一致 —— 若此常量漂移,
 * 升级分支(①)会误判为「用户编辑过」而永不升级,测试 ① 会红。
 */
const LEGACY_COMMUNICATOR = `# Communicator (沟通员)
你的职责:
- 接收用户消息,先判断是 chat(闲聊直接答)/ task(转 Planner 跑多 agent)/ feedback(更新用户画像)
- Worker 通过 MessageBus 提问时,先尽力自查(查代码 / 调工具);答不了再升级用户
- 用对话风格落平衡(简短、口语化,不要长篇暴露)

约束:
- 一次只发一条 chat 回复;task 转发后等 worker 回报再回话
- 升级用户前先尝试自查(读 README / 看相关文件)
- 保持角色一致:用「三生」第一人称`;

const ALL_ROLES = ["communicator", "planner", "executor", "critic", "memory", "reflection"] as const;

function makeDataDir(): string {
  return mkdtempSync(join(tmpdir(), "sansheng-harness-test-"));
}

function promptFile(dataDir: string, role: string): string {
  return join(dataDir, "harness", "system_prompts", `${role}.md`);
}

/** 在干净临时目录跑一次 ensureHarness,拿到「当前新默认」全文(不依赖 loader 内部导出) */
function freshDefaults(): Record<string, string> {
  const dir = makeDataDir();
  ensureHarness(dir);
  const out: Record<string, string> = {};
  for (const role of ALL_ROLES) {
    out[role] = readFileSync(promptFile(dir, role), "utf-8");
  }
  return out;
}

/** 预置一个 harness/system_prompts/{role}.md 文件(模拟既有机器状态) */
function seedPromptFile(dataDir: string, role: string, content: string): void {
  const dir = join(dataDir, "harness", "system_prompts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(promptFile(dataDir, role), content, "utf-8");
}

describe("harness/loader · ensureHarness 升级逻辑(批次 5a T1)", () => {
  it("① legacy 未编辑文件 → 被替换为新默认", () => {
    const dir = makeDataDir();
    seedPromptFile(dir, "communicator", LEGACY_COMMUNICATOR);
    ensureHarness(dir);

    const after = readFileSync(promptFile(dir, "communicator"), "utf-8");
    expect(after).not.toBe(LEGACY_COMMUNICATOR);
    expect(after).toBe(freshDefaults().communicator);
  });

  it("② 用户编辑过的文件 → 原样保留(绝不静默覆盖)", () => {
    const dir = makeDataDir();
    const edited = `# 我自己的雇员手册\n\n三生,说话短一点,别用 emoji。\n`;
    seedPromptFile(dir, "communicator", edited);
    ensureHarness(dir);
    expect(readFileSync(promptFile(dir, "communicator"), "utf-8")).toBe(edited);

    // 其它角色同样:用户编辑过的 planner 也保留
    const editedPlanner = `# Planner(手改版)\nplan 不超过 3 steps。\n`;
    seedPromptFile(dir, "planner", editedPlanner);
    ensureHarness(dir);
    expect(readFileSync(promptFile(dir, "planner"), "utf-8")).toBe(editedPlanner);
  });

  it("③ 新默认已就位 → 跳过(幂等,不重写文件)", () => {
    const dir = makeDataDir();
    ensureHarness(dir); // 首次生成 = 新默认
    const p = promptFile(dir, "communicator");
    const before = readFileSync(p, "utf-8");

    // 把 mtime 拨到过去;若 ensureHarness 重写了文件,mtime 会变新
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(p, old, old);

    ensureHarness(dir); // 第二次:应当跳过
    const st = statSync(p);
    expect(st.mtime.getTime()).toBe(old.getTime());
    expect(readFileSync(p, "utf-8")).toBe(before);
  });

  it("其它角色的旧默认(与新默认相同)→ 不触发重写;6 个文件齐全", () => {
    const dir = makeDataDir();
    ensureHarness(dir);
    const p = promptFile(dir, "planner");
    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(p, old, old);
    ensureHarness(dir);
    // planner 的 legacy == 新默认 → 命中「等于新默认 → 跳过」分支,mtime 不变
    expect(statSync(p).mtime.getTime()).toBe(old.getTime());
    for (const role of ALL_ROLES) {
      expect(existsSync(promptFile(dir, role))).toBe(true);
    }
  });

  it("全新目录 → 生成 6 个默认文件;communicator 新默认非空、直答模式、无 JSON 输出协议", () => {
    const dir = makeDataDir();
    ensureHarness(dir);
    for (const role of ALL_ROLES) {
      expect(existsSync(promptFile(dir, role))).toBe(true);
    }
    const comm = readFileSync(promptFile(dir, "communicator"), "utf-8");
    // 比旧 9 行 stub 实质扩容(40-80 行区间)
    const lines = comm.split("\n").length;
    expect(lines).toBeGreaterThanOrEqual(40);
    expect(lines).toBeLessThanOrEqual(80);
    // 身份 / 原则 / 人格关键内容在场
    expect(comm).toContain("三生");
    expect(comm).toContain("自然语言");
    expect(comm).not.toContain("已收到:");
    // 不含 D7 结构化输出协议(那是批次 5b 的管道协议;直答模式必须明确禁止 JSON)
    expect(comm).not.toMatch(/只输出一个 JSON|必须输出\s*JSON|每次响应.*JSON/);
    expect(comm).toContain("不要输出 JSON");
  });

  it("端到端:legacy 机器升级后 loadHarness 读回新默认(非空、无 JSON 协议指令)", () => {
    const dir = makeDataDir();
    // 模拟批次 5a 之前的机器:communicator.md 是旧 9 行内嵌默认(其余角色旧==新,无关)
    seedPromptFile(dir, "communicator", LEGACY_COMMUNICATOR);

    ensureHarness(dir); // 升级
    const harness = loadHarness(dir);
    const comm = harness.systemPrompts.communicator;
    expect(comm.length).toBeGreaterThan(0);
    expect(comm).toContain("三生");
    expect(comm).toContain("自然语言");
    expect(comm).not.toMatch(/只输出一个 JSON|必须输出\s*JSON|每次响应.*JSON/);
    // loadHarness 其它字段不受影响
    expect(harness.enabledTools).toContain("fs_read");
    expect(harness.budget.maxIterations).toBe(5);
  });
});
