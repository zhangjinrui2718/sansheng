/**
 * 夹具必须带**封套字段** —— W1-① 点名的那个运行期 TypeError 的守卫(2026-10-06)
 *
 * ── 为什么需要这份文件(而不是靠 tsc)────────────────────────────
 *
 * W1 把 `message_start` 的 `source` / `trigger` 定成**必填**(契约里两条编译期
 * 断言),`tsc` 会把 `src/` 的每个构造点全部点出来。但:
 *
 *   - `tsconfig.server.json` 的 `exclude` 含 `*.test.ts` 通配(所有测试文件),
 *     `include` 不含 `tests/`;
 *   - `tsconfig.web.json` 只 include `web/src` + `shared/`。
 *
 * ⇒ **`tests/**` 完全不参与 typecheck**。于是一个手搓的 `message_start` 字面量漏填
 * `trigger` 时,编译期一个字都不说,而运行期是:
 *
 *   - 修前:`channelOf` 读 `origin.trigger.kind` ⇒ 一句
 *     `Cannot read properties of undefined` —— 与 7-D/7-M「不要惩罚不携带错误信息的
 *     偏差」正好相反;
 *   - 更糟:如果 store 选择静默降级,那一轮**悄悄走回退判据**,测试照样绿。
 *     (store 现在选择**抛**,见 `web/src/stores/chat.ts` 的 `originOfMessageStart`
 *     —— 那是第二道防线,本文件是第一道。)
 *
 * W1-① 的原话:「新读者一写 `e.trigger.kind` 就会在测试里 TypeError,而编译期抓不到。
 * **这 42 处要同批补。**」这份文件就是那条要求的**机器化**。
 *
 * ── 判据(三条规则,都是**源码级**扫描)──────────────────────────
 *
 *   1. 每个 `type: "message_start"` 的**夹具字面量**(带 `messageId` 的那些)必须带
 *      `source`;`source: "turn"` 的还必须带 `trigger`,`source: "broadcast"` 的
 *      **不许**带 `trigger`(契约是结构性的:`_BroadcastMustNotCarryTrigger`);
 *   2. 每个**手搓的 `Turn` 字面量**(同一个字面量里同时有 `startedAt:` 与
 *      `blocks:`)必须带 `origin` —— 漏了它,`channelOf` 会在 `turn.origin.source`
 *      上抛,而 `tests/` 同样不受 tsc 约束。
 *   3. **每个 `SessionMessageView` 夹具**(判别字段 `agentName:` —— 那是它独有的)
 *      必须带 `origin`(W3-① 起必填)。漏了它 `messageToTurn` 会给出
 *      `origin: undefined`,`channelOf` 读 `turn.origin.source` 时抛一个**看不出
 *      是哪条字段漏了**的 TypeError —— 与规则 2 同一条理由,而这条是**新加的**:
 *      `origin` 是 2026-10-06(W3-①)才变成必填的,存量夹具**(8 处)同批补齐。
 *
 * **唯一的豁免方式**是在那个字面量里写一行注释 `fixture-lint: allow`(故意喂不合法
 * 封套的守卫测试要用)。豁免是**白纸黑字**的,不是静默跳过。
 *
 * ── 为什么敢用源码扫描(以及怎么防「坏掉的检查」)──────────────────
 *
 * 本项目有一条真事故记录:**检查本身静默出错**——它返回一个看起来正常的错误答案。
 * 所以这里的扫描器(`blankComments` / `extractLiteral` / `lintSource`)**自己带正负
 * 样本自检**:必须命中的 + 必须不命中的,两个都对上才用它去看别的。另外还有一条
 * **非空**断言(扫到的 `message_start` 夹具数不许低于 W1 记下的 42)—— 扫描范围
 * 一旦因为路径变动而落空,测试会红,而不是愉快地报 0 个问题。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = process.cwd();
const TESTS = join(REPO, "tests");
/** 本文件自己必须排除:它**必须说出**那两个模式,否则就没法扫别人。 */
const SELF = "tests/web/fixture-envelope-fields.test.ts";
/** 豁免标记:写在一个字面量内部即表示「这里的不合法是故意的」。 */
const ALLOW_MARKER = /fixture-lint:\s*allow/;

function walkTests(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkTests(p, out);
    else if (name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/**
 * 把注释**原地抹成空格**(换行保留)—— 不是删掉。
 *
 * 为什么不直接删(`c10-dead-code.test.ts` 用的是删):这里还要回头到**原文**里读
 * 豁免标记,而删注释会让下标漂移、两处对不上。抹成空格之后 `blanked.length ===
 * src.length`,同一批下标在两边通用。
 */
export function blankComments(src: string): string {
  const chars = src.split("");
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === "/" && chars[i + 1] === "/") {
      while (i < chars.length && chars[i] !== "\n") chars[i++] = " ";
      continue;
    }
    if (chars[i] === "/" && chars[i + 1] === "*") {
      while (i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) {
        if (chars[i] !== "\n") chars[i] = " ";
        i += 1;
      }
      if (i < chars.length) {
        chars[i] = " ";
        chars[i + 1] = " ";
        i += 2;
      }
      continue;
    }
    i += 1;
  }
  return chars.join("");
}

/** 一个源码区间(下标对**原文**与抹注释后的文本都成立,见 `blankComments`)。 */
export interface LiteralRange {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

/**
 * 从 `at` 处的模式向左找它所在的对象字面量,再向右做括号配对。
 *
 * ⚠️ **向左必须按深度走**,而且**花括号与圆括号各算一份深度**。两条都是实测踩出来
 * 的(第一版两条都错,错误方向都是「静默扫到 0 个」):
 *
 *   - 只找「最近的 `{`」:Turn 字面量里 `blocks: [{...}]` 带一对内层花括号 ⇒ 判据
 *     落在那对上面,整个 Turn 一个字面量都扫不到;
 *   - 遇到 `(` / `)` 一律放弃:真实夹具里有
 *     `blocks: [...tools.map((n, i) => ({...}))]` 这种形状 ⇒ 向左先撞到 `map(...)`
 *     的 `)`,那条 Turn 又被静默跳过。
 *
 * 所以:向左 `}` 记 +1、`{` 在花括号深度 0 时才是边界;`(` / `)` 另算一份深度
 * (**不配对**的 `(` 才说明这里是参数表 / 类型签名,返回 `null`);`;` 说明已经走出
 * 这条语句,同样返回 `null`。
 *
 * ⚠️ **已知边界(如实写在这里)**:扫描器不解析字符串字面量 —— 若某个字面量的
 * 属性里写了带**不配对**括号或 `;` 的字符串,它会被跳过(漏报,不是误报)。
 * 下面的**非空**断言(≥42 / ≥5)是这条边界的兜底:漏得太多会红。
 */
export function extractLiteral(src: string, at: number): LiteralRange | null {
  let brace = 0;
  let paren = 0;
  let start = -1;
  for (let i = at - 1; i >= 0; i--) {
    const c = src[i];
    if (c === "}") brace += 1;
    else if (c === "{") {
      if (brace === 0) {
        start = i;
        break;
      }
      brace -= 1;
    } else if (c === ")") paren += 1;
    else if (c === "(") {
      if (paren === 0) return null; // 不配对的 `(`:参数表 / 类型签名,不是字面量
      paren -= 1;
    } else if (c === ";") return null;
  }
  if (start === -1) return null;
  let d = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") d += 1;
    else if (c === "}") {
      d -= 1;
      if (d === 0) return { text: src.slice(start, i + 1), start, end: i + 1 };
    }
  }
  return null;
}

export interface LintFinding {
  readonly line: number;
  readonly problem: string;
}

/**
 * 扫一段源码里的两类夹具。返回违规清单 + 它**实际看过**的夹具数
 * (数目用来做「扫描范围没落空」的断言)。
 */
export function lintSource(src: string): {
  findings: LintFinding[];
  messageStarts: number;
  turnLiterals: number;
  messageViews: number;
} {
  const blanked = blankComments(src);
  const findings: LintFinding[] = [];
  const lineAt = (idx: number) => blanked.slice(0, idx).split("\n").length;
  const allowed = (range: LiteralRange) => ALLOW_MARKER.test(src.slice(range.start, range.end));

  let messageStarts = 0;
  for (const m of blanked.matchAll(/type:\s*"message_start"/g)) {
    const range = extractLiteral(blanked, m.index);
    if (range === null) continue;
    // ⚠️ **只有带 `messageId` 的才算夹具**。另外两种形状都不该被点名:
    //   ① 类型位置 —— `Extract<ServerEvent, { type: "message_start" }>`,字面量里只有 `type`;
    //   ② SDK 自己的事件 —— `tests/platform/turn-usage-write.test.ts` 的
    //      `{ type: "message_start", message: assistantMessage(...) }` 是
    //      `AgentSessionEvent`,不是我们的契约。
    // 这条跳过会不会把夹具一并吞掉?下面那条**非空**断言(≥42)就是防线。
    // 简写属性(`messageId,`)同样算 —— 见下面 `blocks` 那一处的实测量。
    if (!/[\s,{]messageId\s*[:,}]/.test(range.text)) continue;
    messageStarts += 1;
    if (allowed(range)) continue;
    const line = lineAt(m.index);
    const source = /source:\s*"([^"]+)"/.exec(range.text)?.[1];
    if (source === undefined) {
      findings.push({ line, problem: "message_start 夹具缺 source(契约必填)" });
      continue;
    }
    if (source === "broadcast") {
      if (/trigger:/.test(range.text)) {
        findings.push({ line, problem: "播报封套(source: broadcast)不该带 trigger" });
      }
      continue;
    }
    if (source !== "turn") {
      findings.push({ line, problem: `source 取值不认识:${source}` });
      continue;
    }
    if (!/trigger:\s*\{/.test(range.text)) {
      findings.push({ line, problem: "回合封套(source: turn)缺 trigger(契约必填)" });
    }
  }

  let turnLiterals = 0;
  for (const m of blanked.matchAll(/startedAt:/g)) {
    const range = extractLiteral(blanked, m.index);
    if (range === null) continue;
    // ⚠️ 必须认**简写属性**(`{ …, blocks, startedAt: 0, origin }`)—— 只写
    // `/blocks:/` 会把这几处静默跳过(实测:5 个 Turn 字面量只剩 1 个被扫到)。
    if (!/[\s,{]blocks\s*[:,}]/.test(range.text)) continue; // 别的对象也有 startedAt(平台测试的区间类型)
    turnLiterals += 1;
    if (allowed(range)) continue;
    if (!/[\s,{]origin\s*[:,}]/.test(range.text)) {
      findings.push({ line: lineAt(m.index), problem: "手搓的 Turn 字面量缺 origin(必填)" });
    }
  }

  // ── 规则 3:SessionMessageView 夹具必须带 `origin`(W3-①)──────────
  //
  // 判别字段是 `agentName:` —— `SessionMessageView` 独有的那一维(其它视图用
  // `displayName` / `authorName`)。再要求同一个字面量里有 `kind:` 与 `createdAt:`,
  // 免得把「碰巧有个 agentName 字段」的别的对象一并点名。
  let messageViews = 0;
  for (const m of blanked.matchAll(/agentName\s*:/g)) {
    const range = extractLiteral(blanked, m.index);
    if (range === null) continue;
    if (!/[\s,{]kind\s*[:,}]/.test(range.text)) continue;
    if (!/[\s,{]createdAt\s*[:,}]/.test(range.text)) continue;
    messageViews += 1;
    if (allowed(range)) continue;
    if (!/[\s,{]origin\s*[:,}]/.test(range.text)) {
      findings.push({
        line: lineAt(m.index),
        problem: "SessionMessageView 夹具缺 origin(REST 必带,W3-① 起必填)",
      });
    }
  }

  return { findings, messageStarts, turnLiterals, messageViews };
}

describe("夹具扫描器自检(正负样本 —— 坏掉的检查不等于检查失败)", () => {
  it("正样本:带 source / trigger 的 message_start、带 origin 的 Turn 与 SessionMessageView 都通过", () => {
    const ok = `
      s.applyEvent({ type: "message_start", projectId: P, messageId: "m1", role: "assistant", agentId: BM,
        source: "turn", trigger: { kind: "todo", todoKind: "execute_work" } });
      const t = { id: "m1", projectId: P, role: "assistant", agentId: BM, blocks: [{ kind: "text", text: "x" }],
        startedAt: 0, origin: { source: "unknown" } };
      s.applyEvent({ type: "message_start", projectId: P, messageId: "m2", role: "assistant", agentId: BM,
        source: "broadcast" });
      const body = { messages: [
        { id: "h1", projectId: P, agentId: BM, agentName: "业务经理", kind: "assistant", content: "x",
          createdAt: 1, origin: { source: "turn", trigger: { kind: "user" } } },
      ] };
    `;
    const r = lintSource(ok);
    expect(r.findings).toEqual([]);
    expect(r.messageStarts, "两个 message_start 都必须被扫到").toBe(2);
    expect(r.turnLiterals, "那个 Turn 字面量必须被扫到(内层 [{...}] 不许把判据带偏)").toBe(1);
    expect(r.messageViews, "那个 SessionMessageView 夹具必须被扫到").toBe(1);
  });

  it("负样本:漏 source / 漏 trigger / 播报带 trigger / Turn 漏 origin / 视图漏 origin —— 五样都要被点名", () => {
    const bad = `
      s.applyEvent({ type: "message_start", projectId: P, messageId: "m1", role: "assistant", agentId: BM });
      s.applyEvent({ type: "message_start", projectId: P, messageId: "m2", role: "assistant", agentId: BM,
        source: "turn" });
      s.applyEvent({ type: "message_start", projectId: P, messageId: "m3", role: "assistant", agentId: BM,
        source: "broadcast", trigger: { kind: "user" } });
      const t = { id: "m4", projectId: P, role: "assistant", agentId: BM, blocks: [], startedAt: 0 };
      const body = { messages: [
        { id: "m5", projectId: P, agentId: BM, agentName: "业务经理", kind: "assistant", content: "x", createdAt: 1 },
      ] };
    `;
    const r = lintSource(bad);
    expect(r.findings.map((f) => f.problem)).toEqual([
      "message_start 夹具缺 source(契约必填)",
      "回合封套(source: turn)缺 trigger(契约必填)",
      "播报封套(source: broadcast)不该带 trigger",
      "手搓的 Turn 字面量缺 origin(必填)",
      "SessionMessageView 夹具缺 origin(REST 必带,W3-① 起必填)",
    ]);
    expect(r.messageViews, "漏 origin 的那个视图夹具必须被扫到(不是静默 0)").toBe(1);
  });

  it("负样本:**注释里**的 message_start 不算夹具(契约讨论不该被误报)", () => {
    const withComment = `
      // 新读者一写 e.trigger.kind 就会在测试里 TypeError;{ type: "message_start" } 漏填
      /* { type: "message_start", projectId: P, messageId: "m", role: "assistant", agentId: null } */
    `;
    const r = lintSource(withComment);
    expect(r.findings).toEqual([]);
    expect(r.messageStarts).toBe(0);
  });

  it("负样本:`SessionMessageView` **类型定义**里的 agentName 不算夹具", () => {
    // 判别字段之外还要 `kind` + `createdAt` —— 接口声明是 `agentName: string | null;`
    // 这种形状,且没有 `createdAt:`(有的话也要求在字面量里,不是类型里)
    const typesOnly = `
      export interface SessionMessageView {
        id: string;
        agentId: string | null;
        agentName: string | null;
        kind: SessionMessageKind;
        content: string;
      }
    `;
    const r = lintSource(typesOnly);
    expect(r.findings).toEqual([]);
    expect(r.messageViews).toBe(0);
  });

  it("正样本:类型位置(Extract<…>)不算夹具", () => {
    const typesOnly = `
      const starts = events.filter(
        (e): e is Extract<ServerEvent, { type: "message_start" }> => e.type === "message_start",
      );
    `;
    const r = lintSource(typesOnly);
    expect(r.findings).toEqual([]);
    expect(r.messageStarts).toBe(0);
  });

  it("豁免:`fixture-lint: allow` 写在字面量里才放行 —— 且只放行那一个", () => {
    const exempt = `
      s().applyEvent(malformed({
        // fixture-lint: allow —— 这一条**故意**喂不合法封套(守 store 的抛)
        type: "message_start", projectId: P, messageId: "m-bad", role: "assistant", agentId: BM,
        source: "turn",
      }));
      s.applyEvent({ type: "message_start", projectId: P, messageId: "m2", role: "assistant", agentId: BM,
        source: "turn" });
    `;
    const r = lintSource(exempt);
    expect(r.findings.map((f) => f.problem)).toEqual(["回合封套(source: turn)缺 trigger(契约必填)"]);
    expect(r.messageStarts).toBe(2);
  });
});

describe("tests/** 的夹具必须带封套字段(42 处 message_start + Turn 字面量 + 视图夹具)", () => {
  const files = walkTests(TESTS).map((p) => relative(REPO, p)).filter((f) => f !== SELF);

  it("扫描范围非空:找到的测试文件与夹具数都够(W1-① 记的是 42 处)", () => {
    expect(files.length, "至少要扫到几个测试文件").toBeGreaterThan(3);
    let messageStarts = 0;
    let turnLiterals = 0;
    let messageViews = 0;
    for (const f of files) {
      const r = lintSource(readFileSync(join(REPO, f), "utf8"));
      messageStarts += r.messageStarts;
      turnLiterals += r.turnLiterals;
      messageViews += r.messageViews;
    }
    // ⚠️ 这三条是**非空**断言:扫描路径一旦落空,这里会红 —— 而不是愉快地报 0 违规。
    expect(messageStarts, "message_start 夹具数不许低于 W1-① 记下的 42").toBeGreaterThanOrEqual(42);
    expect(turnLiterals, "手搓的 Turn 字面量数不许低于补齐前的 5").toBeGreaterThanOrEqual(5);
    expect(
      messageViews,
      "SessionMessageView 夹具数不许低于 W3-① 补齐前的 8(补齐后是 10:2 旧 + 4 新 + 2 turn-table + 2 app-socket)",
    ).toBeGreaterThanOrEqual(8);
  });

  it("逐文件零违规", () => {
    const violations: string[] = [];
    for (const f of files) {
      const r = lintSource(readFileSync(join(REPO, f), "utf8"));
      for (const finding of r.findings) {
        violations.push(`${f}:${finding.line}: ${finding.problem}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
