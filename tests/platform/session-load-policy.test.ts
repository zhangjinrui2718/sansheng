/**
 * 会话装载策略 · 「会话里进什么,只由平台决定」
 *
 * ── 为什么这组判据必须拿真 SDK 验 ────────────────────────────────
 *
 * SDK 默认把会话目录当成受信任的项目:`.pi/skills`、`.agents/skills`、`AGENTS.md`
 * (会话目录 + 每一级上级 + `<agentDir>`)会自动进会话。三生的会话目录就是项目仓根 ——
 * 角色天天往里写文件。开关写在 `session.ts` 里,而「写了没接上」与「接上了」在
 * 注入的假会话里长得一模一样 ⇒ 这里用**真的 `DefaultResourceLoader`** 配临时目录。
 *
 * ── 负样本 ──────────────────────────────────────────────────────
 *
 * 同一份夹具用 SDK 的**默认选项**装载一次,断言那些文件**确实会被发现** ——
 * 少了这一条,「策略下为空」可能只是夹具本身没牙(与 AGENTS.md「三类静默失败」
 * 第 3 条同形:一个坏掉的检查返回了看起来正常的答案)。
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultResourceLoader, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  reloadSessionResources,
  sessionResourceLoaderOptions,
} from "../../src/platform/runtime/agentRuntime/pi/session.js";

const SESSION_SRC = readFileSync("src/platform/runtime/agentRuntime/pi/session.ts", "utf8");

/** 去注释 —— 判据那几句话本身就写在注释里,不剥等于判据把自己判红了。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/**
 * 检查器(纯函数,吃源码):`createPlatformSession` 这条生产路径上,
 * 装载器的**两个半边**都接上了没有。
 *
 *   半边 1 = 构造参数走 `sessionResourceLoaderOptions`(三个 `no*`);
 *   半边 2 = reload 带 `resolveProjectTrust`(`reloadSessionResources`)。
 *
 * ⚠️ **两个半边缺一不可**:只关磁盘扩展与技能(`no*`)而 reload 时不置「不受信任」,
 * `.pi/settings.json` 照样按受信任项目读;反之亦然。
 */
function checkLoadPolicy(src: string): { usesOptions: boolean; usesReload: boolean; noBareReload: boolean } {
  const code = stripComments(src);
  const body = code.slice(code.indexOf("export async function createPlatformSession"));
  if (body === "") return { usesOptions: false, usesReload: false, noBareReload: false };
  return {
    usesOptions: /sessionResourceLoaderOptions\s*\(/.test(body),
    usesReload: /reloadSessionResources\s*\(\s*loader\s*\)/.test(body),
    // 裸 `loader.reload()`(不带策略)= SDK 默认信任项目目录
    noBareReload: !/\.reload\s*\(\s*\)/.test(body),
  };
}

// ── 夹具:一个「项目仓」──────────────────────────────────────────

let root = "";
let cwd = "";
let agentDir = "";

function write(rel: string, content: string): void {
  const p = join(cwd, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content, "utf8");
}

const SKILL = [
  "---",
  "name: demo",
  "description: 夹具技能 —— 默认策略下应当被 SDK 自动发现",
  "---",
  "# demo",
  "夹具正文。",
].join("\n");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sansheng-load-policy-"));
  cwd = join(root, "projects", "pj_1");
  agentDir = join(root, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  write(".pi/skills/demo/SKILL.md", SKILL);
  write(".agents/skills/another/SKILL.md", SKILL.replace("name: demo", "name: another"));
  write("AGENTS.md", "# 项目仓里的 AGENTS.md\n这一段不该进任何角色的会话。\n");
  // 项目级提示词模板:只在「项目目录受信任」时才会被读(与 skills / 扩展不同,
  // 它不受 noSkills / noExtensions 管)⇒ 它是「reload 时置为不受信任」这一半边的判据。
  write(".pi/prompts/evil.md", "---\ndescription: 夹具模板\n---\n夹具正文");
  // 代码类扩展:只在策略下断言「没被装载」。**不用默认选项跑负样本** ——
  // 那会真的在测试进程里执行这个文件。
  write(".pi/extensions/evil.js", "export default function (pi) { /* 夹具 */ }\n");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("会话装载策略 · 选项与 reload 的两个半边", () => {
  it("选项里三个 `no*` 全为真,且平台传的内联扩展工厂原样保留", () => {
    const factory: ExtensionFactory = () => {};
    const opts = sessionResourceLoaderOptions({
      cwd,
      agentDir,
      appendSystemPrompt: (base) => [...base, "角色提示"],
      extensionFactories: [factory],
    });
    expect(opts.noExtensions).toBe(true);
    expect(opts.noSkills).toBe(true);
    expect(opts.noContextFiles).toBe(true);
    expect(opts.extensionFactories).toHaveLength(1);
    expect(opts.extensionFactories?.[0]).toBe(factory);
    expect(opts.appendSystemPromptOverride?.(["base"])).toEqual(["base", "角色提示"]);
  });

  it("生产路径 `createPlatformSession` 的两个半边都接上了(源码级)", () => {
    const r = checkLoadPolicy(SESSION_SRC);
    expect(r.usesOptions, "装载器没走 sessionResourceLoaderOptions").toBe(true);
    expect(r.usesReload, "reload 没走 reloadSessionResources").toBe(true);
    expect(r.noBareReload, "有一处裸 reload() —— 那是 SDK 默认的「信任项目目录」").toBe(true);
  });

  it("⚠️ 变异自检:换成裸 reload / 绕开选项函数,检查器各自变红", () => {
    expect(checkLoadPolicy(SESSION_SRC.replace("await reloadSessionResources(loader);", "await loader.reload();")).usesReload).toBe(false);
    expect(checkLoadPolicy(SESSION_SRC.replace("await reloadSessionResources(loader);", "await loader.reload();")).noBareReload).toBe(false);
    expect(
      checkLoadPolicy(SESSION_SRC.replace("sessionResourceLoaderOptions({", "({")).usesOptions,
      "绕开选项函数(直接给字面量)时检查器必须变红",
    ).toBe(false);
    // 自检的自检:三次替换都必须真的改到了源码(不匹配时 `replace` 静默原样返回)
    expect(SESSION_SRC).toContain("await reloadSessionResources(loader);");
    expect(SESSION_SRC).toContain("sessionResourceLoaderOptions({");
  });
});

describe("会话装载策略 · 真 SDK 的 DefaultResourceLoader", () => {
  it("策略下:项目仓里的技能、AGENTS.md、扩展一条都进不来", async () => {
    const loader = new DefaultResourceLoader(
      sessionResourceLoaderOptions({
        cwd,
        agentDir,
        appendSystemPrompt: (base) => [...base],
        extensionFactories: [],
      }),
    );
    await reloadSessionResources(loader);
    expect(loader.getSkills().skills.map((s) => s.name)).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);
    expect(loader.getPrompts().prompts.map((t) => t.name)).toEqual([]);
    const paths = loader.getExtensions().extensions.map((e) => e.path);
    expect(paths.some((p) => p.includes(join(cwd, ".pi"))), `扩展里有项目仓的文件:${paths.join(",")}`).toBe(false);
    // 追加的提示词照旧生效(策略不该动平台自己的东西)
    expect(loader.getAppendSystemPrompt()).toEqual([]);
  });

  it("负样本:同一份夹具用 SDK 默认选项装载,技能与 AGENTS.md **确实**会被发现", async () => {
    const loader = new DefaultResourceLoader({ cwd, agentDir });
    await loader.reload();
    const names = loader.getSkills().skills.map((s) => s.name);
    expect(names, "默认选项下夹具技能没被发现 ⇒ 上面那条「策略下为空」证明不了任何事").toContain("demo");
    expect(names).toContain("another");
    const files = loader.getAgentsFiles().agentsFiles.map((f) => f.path);
    expect(files.some((f) => f === join(cwd, "AGENTS.md") || f === join(root, "projects", "pj_1", "AGENTS.md"))).toBe(true);
    // 负样本(信任那一半边):默认选项信任项目目录 ⇒ `.pi/prompts` 被读进来
    expect(loader.getPrompts().prompts.map((t) => t.name)).toContain("evil");
  });
});
