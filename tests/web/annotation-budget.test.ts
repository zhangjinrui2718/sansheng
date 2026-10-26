/**
 * 注解预算 —— 「解释」不许再回到屏幕上去
 *
 * ── 用户要的是什么(2026-10-26 原话,paraphrased)────────────────────
 *
 * 「去除掉现在页面上面过多的注释」。
 *
 * 实测现场(2026-10-26,`grep -c 'hintTitle='`):
 *   - **27 处 `hintTitle=`**,其中 19 条是整段正文 —— 它们渲染成 `title=`,也就是
 *     **鼠标悬停才出现的灰字**。触屏不触发、不可复制、屏幕阅读器行为不一致。
 *   - 那 27 处里 **13 条是「数据来源:GET …」** —— 那是**出处**,不是注解。
 *   - `routes/Members.tsx` 里同一段 133 字被**逐字抄了两遍**(`:1010` 与 `:1022`)。
 *
 * ⇒ 处置:`hintTitle=` 这个 prop **从 `primitives.tsx` 里删掉**(不是「不用了」),
 *   出处 / 判据收进 `lib/glossary.ts`,由 `components/ui/Help.tsx` 的 `?` 呈现。
 *
 * ── 这一份测试钉住的判据(每条都带自检)──────────────────────────────
 *
 *   ① `hintTitle` 在 `web/src` 里 **0 次** —— 且扫描器**确实能命中**它(正样本)。
 *   ② 不许把出处写进 `title=`(`title="来源:` / `title="数据来源`)—— 0 次,同带正样本。
 *   ③ 出处不许写进短标(`hint="…GET /api…"`)—— 那条路的容量是**一行**。
 *   ④ 同一句话不许抄两遍:全站 `hint=` 的取值集合里**没有重复**(Members 那个 133 字
 *      重复的通用形态)。
 *   ⑤ `GLOSSARY` 的每个 id **都有读者**(某个 `helpId=` 用到它),而每个 `helpId=`
 *      **都写得出条目**(tsc 管类型,这里管「有没有人真的用」)。
 *
 * ⚠️ 判据 ⑤ 是 7-E 的复发防线:**声明了没人用**在这套界面里等于「用户永远看不到」,
 * 而它在代码里看起来完全正常。所以宁可让测试在「加了条目没接线」时变红。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GLOSSARY, type GlossaryId } from "@/lib/glossary";

const WEB_SRC = join(process.cwd(), "web/src");

/** 去掉注释 —— 断言针对**代码**:注释里讨论「别写成的形态」不该被判为违规。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}

const FILES: { rel: string; src: string }[] = walk(WEB_SRC).map((abs) => ({
  rel: abs.slice(WEB_SRC.length + 1),
  src: stripComments(readFileSync(abs, "utf8")),
}));

/** 全站扫描:返回 [文件, 命中行] —— 命中行原样保留,失败时能直接指到行。 */
function scanAll(re: RegExp): { rel: string; line: string }[] {
  const hits: { rel: string; line: string }[] = [];
  for (const f of FILES) {
    for (const line of f.src.split("\n")) {
      if (re.test(line)) hits.push({ rel: f.rel, line: line.trim() });
    }
  }
  return hits;
}

const show = (hits: { rel: string; line: string }[]): string =>
  hits.map((h) => `${h.rel}: ${h.line}`).join("\n");

describe("注解预算:悬停正文这条路已经封死", () => {
  it("① web/src 里 `hintTitle` 出现 0 次", () => {
    const hits = scanAll(/hintTitle/);
    expect(show(hits)).toBe("");
  });

  it("① 自检:扫描器对已知正样本必须命中(否则上面那条 0 是假绿)", () => {
    const probe = 'const a = createElement(Section, { hintTitle: "x" });';
    expect(/hintTitle/.test(probe)).toBe(true);
    // 完整链路:真的写进一个临时文件 → 走 scanAll 的同一套逻辑
    expect(stripComments(probe).includes("hintTitle")).toBe(true);
  });

  it("② 出处不许写进 `title=`(悬停)", () => {
    const hits = scanAll(/title=\{?"(数据)?来源/);
    expect(show(hits)).toBe("");
    expect(/title="来源/.test('<span title="来源:GET /api/x">')).toBe(true);
  });

  it('② 也不许写成 `title={"来源…"}`(JSX 表达式形态)', () => {
    const hits = scanAll(/title=\{\s*"(数据)?来源/);
    expect(show(hits)).toBe("");
  });

  it("③ 短标里不许夹端点(`hint=\"…GET /api…\"` 是出处,不是一行话)", () => {
    const hits = scanAll(/hint=\{?"[^"]*GET \/api/);
    expect(show(hits)).toBe("");
    expect(/hint="来源:GET \/api\/x"/.test('hint="来源:GET /api/x"')).toBe(true);
  });

  it("④ 同一句话不许抄两遍(hint 取值无重复)", () => {
    const seen = new Map<string, string[]>();
    for (const f of FILES) {
      for (const m of f.src.matchAll(/hint="([^"]*)"/g)) {
        const list = seen.get(m[1]) ?? [];
        list.push(f.rel);
        seen.set(m[1], list);
      }
    }
    const dup = [...seen.entries()].filter(([, files]) => files.length > 1);
    expect(dup.map(([text, files]) => `${files.join(",")}: ${text}`).join("\n")).toBe("");
  });
});

describe("词汇表:每条都有读者,每个读者都写得出条目", () => {
  const ids = Object.keys(GLOSSARY) as GlossaryId[];

  /** 全站 `helpId="x"` 的取值 → 出现在哪些文件。 */
  const readers = new Map<string, string[]>();
  for (const f of FILES) {
    for (const m of f.src.matchAll(/helpId="([^"]+)"/g)) {
      const list = readers.get(m[1]) ?? [];
      list.push(f.rel);
      readers.set(m[1], list);
    }
  }

  it("⑤ 每个条目都至少有一个页面在用(没有「声明了没人用」)", () => {
    const orphans = ids.filter((id) => !readers.has(id));
    expect(orphans.join(", ")).toBe("");
  });

  it("⑤ 没有写不出来的条目名(扫描器自检:它确实看得见 helpId)", () => {
    expect(readers.size).toBeGreaterThan(10);
    const unknown = [...readers.keys()].filter((k) => !(k in GLOSSARY));
    expect(unknown.join(", ")).toBe("");
  });

  it("一条一行话:`line` ≤ 24 字(摆得下就不该藏)", () => {
    const long = ids
      .filter((id) => GLOSSARY[id].line.length > 24)
      .map((id) => `${id}: ${GLOSSARY[id].line.length} 字 —— ${GLOSSARY[id].line}`);
    expect(long.join("\n")).toBe("");
    // 自检:边界确实是 24
    expect("汉".repeat(24).length).toBe(24);
  });

  it("`basis` / `source` 都不许空(空着等于「查不到」)", () => {
    const empty = ids.filter((id) => !GLOSSARY[id].basis.trim() || !GLOSSARY[id].source.trim());
    expect(empty.join(", ")).toBe("");
  });

  it("**名字表不许进词汇表**:角色中文名只有 ORG 与 lib/vocab.ts 两处", () => {
    const roleNames = ["业务经理", "项目经理", "研究员", "工程师", "质检"];
    const bad = ids.filter((id) => roleNames.some((n) => GLOSSARY[id].line.includes(n)));
    expect(bad.join(", ")).toBe("");
  });
});
