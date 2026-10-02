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
import { ensureHarness, loadHarness, roleToolCeiling } from "../../src/server/harness/loader.js";

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
    // 批次 7-E:enabledTools 已删除(它是不存在的工具名的死装饰),改为断言
    // 新的 per-agent 工具集合随 loadHarness 一并读出。
    // 名单从 roleToolCeiling 派生(7-F 起上界含 canvas_* 三件),不在测试里写死
    expect(harness.toolSets.communicator.allowed).toEqual([...roleToolCeiling("communicator")]);
    expect(harness.budget.maxIterations).toBe(5);
  });
});

/* ── 批次 5b-1 · P5:prompt 版本升级链(旧 9 行版 → 5a 44 行版 → 5b-1 版)── */

/**
 * 批次 5a 的出厂默认(44 行版)= loader.ts LEGACY_DEFAULTS.communicator 版本链
 * 第二代条目。必须与其字节一致 —— 若此常量漂移,升级分支会误判「用户编辑过」
 * 而永不升级,P5① 会红(与上方 LEGACY_COMMUNICATOR 相同的守护语义)。
 */
const LEGACY_5A_COMMUNICATOR = `# Communicator (沟通员) · 三生

你是「三生」—— Sansheng 系统的常驻沟通员,用户唯一的对话入口。
始终保持角色一致,用「三生」第一人称、自然口语与用户交流。

## 三重身份

1. **Reactive Input(接收)** — 接用户消息与系统回调,先理解、再决策:
   - chat(闲聊 / 提问 / 讨论)→ 直接回答
   - task(需要多步执行的明确动作请求)→ 交给规划执行链路
   - feedback(「我叫… / 我喜欢… / 记住…」等自我披露)→ 沉淀为用户画像
2. **Plan Producer(沉淀)** — 从对话中提炼结构化记忆(artifact):意图 /
   假设 / 决策 / 笔记,标题清晰、正文简短,它们是记忆不是聊天。
3. **Observer(守望)** — 关注任务状态变化,只在终态(完成 / 失败)时
   主动向用户播报一句话结果。

**输出格式(当前直答模式)**:直接用自然语言回复用户。不要输出 JSON、
不要用代码块包裹回复、不要输出任何结构化协议字段 —— 结构化输出协议属于
管道模式(尚未接线),当前你输出的一切都视为直接展示给用户的自然语言。

## 设计原则

- **不要堆砌信息**:用户读不进去长文。一次回复只讲一个核心要点,克制展开。
- **简短、口语化**:像可靠的老朋友,不像日志系统;不长篇暴露内部细节。
- **artifact 是结构化记忆,不是聊天**:沉淀意图 / 假设 / 笔记时,
  标题 ≤ 60 字,正文 < 200 字,信息密度优先。
- **意图验证失败 → 降级假设**:没有明确动作词、也没有证据支撑的「意图」
  只是假设;体现「我们先看证据再说」,不要替用户拍板。
- **不确定就选假设,别硬选意图**;拿不准用户想做什么时,用一句话确认。

## Observer 最小噪音原则

- 只在任务到达**终态**时打扰用户:完成 → 一句话报关键结果;
  失败 → 一句话说明失败原因。
- 中间状态(排队 / 进行中 / 等待决策 / 被取代)不打扰用户,仅内部记录。
- 同一事件不重复播报;没有实质进展就保持沉默。

## 边界与约束

- 一次只发一条 chat 回复;task 转发后等执行方回报再回话,不抢答。
- **升级用户前先自查**:worker 提问时,先尽力自己解决(读 README /
  查相关文件 / 调工具);确实答不了才升级用户,并附上你已排查的上下文。
- 不越权:资金、删除、对外发送等重大动作必须先向用户确认。
- 诚实:不知道就说不知道;失败就承认失败,不粉饰。`;

describe("harness/loader · P5 prompt 版本升级链(批次 5b-1)", () => {
  it("P5①: 5a 版 44 行出厂默认(未编辑)→ 自动升级到当前新默认", () => {
    const dir = makeDataDir();
    seedPromptFile(dir, "communicator", LEGACY_5A_COMMUNICATOR);
    ensureHarness(dir);
    const after = readFileSync(promptFile(dir, "communicator"), "utf-8");
    expect(after).not.toBe(LEGACY_5A_COMMUNICATOR);
    expect(after).toBe(freshDefaults().communicator);
  });

  it("P5②: 5a 版 + 用户编辑 → 原样保留(升级链不吞用户手笔)", () => {
    const dir = makeDataDir();
    const edited = LEGACY_5A_COMMUNICATOR + "\n\n(我自己加的:说话再短一点。)\n";
    seedPromptFile(dir, "communicator", edited);
    ensureHarness(dir);
    expect(readFileSync(promptFile(dir, "communicator"), "utf-8")).toBe(edited);
  });

  it("P5③: 新默认(5b-1 版)含只读限权条款;行数仍在 40-80;旧 9 行版跨代升级", () => {
    const dir = makeDataDir();
    ensureHarness(dir);
    const comm = readFileSync(promptFile(dir, "communicator"), "utf-8");
    // 5b-1 增量条款:只读限权(P3 机制层约束的 prompt 层呼应)
    expect(comm).toContain("只读不写");
    expect(comm).toContain("规划执行链路");
    const lines = comm.split("\n").length;
    expect(lines).toBeGreaterThanOrEqual(40);
    expect(lines).toBeLessThanOrEqual(80);
    // 跨代升级:旧 9 行版(链第一代)一步直达 5b-1 新默认
    const dir2 = makeDataDir();
    seedPromptFile(dir2, "communicator", LEGACY_COMMUNICATOR);
    ensureHarness(dir2);
    expect(readFileSync(promptFile(dir2, "communicator"), "utf-8")).toBe(comm);
  });
});
