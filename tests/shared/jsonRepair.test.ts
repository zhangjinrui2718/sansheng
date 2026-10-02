/**
 * 截断 JSON 修复的回归测试。
 *
 * 样本 1 是 2026-10-02 真实线上事故(conv_muqsidb0_wgru / todo-2)的原始输出,
 * 逐字取自 artifacts_json 里 exec-err-GfSsLFi0 这条 note 的 body:
 *   `{"outcome":"evidence","evidence":{"title":"百外语音机器人模型层调研：ASR / LLM /
 *    TTS / VAD / 端侧方案","body":"# 模型层技术调研报告…Mac/iOS/Android/Raspberry`
 * 模型在写报告正文时撞上输出上限,半截 JSON 被当成成功返回 → todo failed →
 * cascade 带走下游 3 个 todo。
 */
import { describe, it, expect } from "vitest";
import { parseJsonLenient, repairTruncatedJson } from "../../src/shared/jsonRepair.js";

/** 真实事故样本(截断在 evidence.body 的 markdown 正文中间) */
const REAL_TRUNCATED =
  '{"outcome":"evidence","evidence":{"title":"百外语音机器人模型层调研：ASR / LLM / TTS / VAD / 端侧方案","body":"# 模型层技术调研报告\\n\\n## 一、流式 ASR（自动语音识别）\\n\\n### 1. Whisper 系列（OpenAI）\\n- **Whisper (original)**：MIT，依赖 ffmpeg\\n- **whisper.cpp / whisper-stream**：Mac/iOS/Android/Raspberry';

describe("shared/jsonRepair · 真实事故回归", () => {
  it("救回被截断的 evidence —— title 完整 + body 保留已写部分", () => {
    const r = parseJsonLenient<{
      outcome: string;
      evidence: { title: string; body: string };
    }>(REAL_TRUNCATED);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(true);
    expect(r.value.outcome).toBe("evidence");
    // title 本身没被截断,必须原样救回 —— 这是 Executor.parseOutcome 的硬校验项
    expect(r.value.evidence.title).toBe(
      "百外语音机器人模型层调研：ASR / LLM / TTS / VAD / 端侧方案",
    );
    // body 写到哪儿保留到哪儿,不丢弃已产出内容
    expect(r.value.evidence.body).toContain("# 模型层技术调研报告");
    expect(r.value.evidence.body).toContain("流式 ASR");
    expect(r.value.evidence.body.endsWith("Mac/iOS/Android/Raspberry")).toBe(true);
  });
});

describe("shared/jsonRepair · 不回归", () => {
  it("完整 JSON 原样通过,repaired=false", () => {
    const r = parseJsonLenient<{ outcome: string }>(
      '{"outcome":"evidence","evidence":{"title":"t","body":"b"}}',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(false);
    expect(r.value.outcome).toBe("evidence");
  });

  it("```json 围栏内的完整 JSON 仍能解出(既有行为保持)", () => {
    const r = parseJsonLenient<{ outcome: string }>(
      '结果如下：\n```json\n{"outcome":"failed"}\n```\n以上。',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe("failed");
  });

  it("围栏内的截断 JSON 也能救回", () => {
    const r = parseJsonLenient<{ evidence: { title: string; body: string } }>(
      "```json\n" + REAL_TRUNCATED + "\n```",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(true);
    expect(r.value.evidence.title).toContain("百外语音机器人模型层调研");
  });

  it("纯自然语言(无 JSON)必须失败 —— 不得凭空造产物", () => {
    expect(parseJsonLenient("I cannot help with that.").ok).toBe(false);
    expect(parseJsonLenient("").ok).toBe(false);
    expect(parseJsonLenient("   \n  ").ok).toBe(false);
  });

  it("括号不配对的坏 JSON 走失败,不硬修", () => {
    // ] 关闭了 { —— 真坏数据,不是截断
    expect(repairTruncatedJson('{"a":[1,2}')).toBeNull();
    expect(parseJsonLenient('{"a":[1,2}').ok).toBe(false);
  });
});

describe("shared/jsonRepair · 截断位置矩阵", () => {
  it("截断在对象键名中间 → 丢掉半截键,保留其余", () => {
    const r = parseJsonLenient<{ outcome: string; evidence: Record<string, unknown> }>(
      '{"outcome":"evidence","evidence":{"title":"t","body":"b","met',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(true);
    expect(r.value.outcome).toBe("evidence");
    expect(r.value.evidence.title).toBe("t");
    // 半截的 "met" 键必须消失,不能留下脏字段
    expect(Object.keys(r.value.evidence)).toEqual(["title", "body"]);
  });

  it("截断在数组元素中间 → 保留已写元素", () => {
    const r = parseJsonLenient<{ evidence: { metadata: { sources: string[] } } }>(
      '{"outcome":"evidence","evidence":{"title":"t","metadata":{"sources":["a","b',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.evidence.metadata.sources).toEqual(["a", "b"]);
  });

  it("截断在裸记号(tru)→ 回退到最后一个安全点", () => {
    const r = parseJsonLenient<{ outcome: string }>('{"outcome":"evidence","ok":tru');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(true);
    expect(r.value.outcome).toBe("evidence");
    // 半截的 "ok" 键被丢弃
    expect(Object.keys(r.value)).toEqual(["outcome"]);
  });

  it("字符串里的转义引号不破坏扫描", () => {
    const r = parseJsonLenient<{ evidence: { body: string } }>(
      '{"outcome":"evidence","evidence":{"title":"t","body":"他说\\"这是引号\\"，然后 \\',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.evidence.body).toContain('"这是引号"');
  });

  it("尾随单个反斜杠会被补成偶数,不会吃掉闭引号", () => {
    const r = parseJsonLenient<{ evidence: { body: string } }>(
      '{"outcome":"evidence","evidence":{"title":"t","body":"路径 C:\\\\',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(typeof r.value.evidence.body).toBe("string");
  });

  it("顶层数组被截断也能补齐", () => {
    const r = parseJsonLenient<Array<{ id: string }>>('[{"id":"todo-1"},{"id":"todo-2"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(true);
    expect(r.value.map((t) => t.id)).toEqual(["todo-1", "todo-2"]);
  });

  it("多层嵌套截断:补齐全部未闭合括号", () => {
    const r = parseJsonLenient<{ a: { b: { c: { d: string } } } }>(
      '{"a":{"b":{"c":{"d":"x"',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.a.b.c.d).toBe("x");
  });
});

/**
 * 2026-10-02 真实事故(conv_muqwgghs_4q0u / todo-6,note `exec-err-uBDq-rMU`):
 * MiniMax-M3 交一份长 markdown 表格,结构体的换行是转义过的 `\n`,但正文里
 * 至少有一处写成了**真实换行符**。旧实现里 `repairTruncatedJson` 能把括号补齐、
 * 字符串也能补闭引号,但裸换行仍是字符串里的控制字符,`JSON.parse` 第二次照样
 * 抛 "Bad control character in string literal" → 救回被整体丢弃 → todo failed →
 * cascade 带走下游 todo-7。
 *
 * 已排除的其它可能:前 500 字符逐字合法;全量截断点扫描(303 + 2266 个截断位置)
 * 证明截断本身 100% 能救。唯一剩下的失败面就是本文件这组 case。
 */
describe("shared/jsonRepair · 字符串里的裸控制字符(conv_muqwgghs_4q0u / todo-6)", () => {
  // 现场形状:pretty-print 的结构换行 + 正文里的 markdown 表格**真实换行**。
  // 正文里的引号是合法转义的 \"(只把换行写成裸的),否则就成了另一种坏 JSON。
  // 用模板字面量是为了让「哪几个换行是真的」一眼可见。
  const RAW_NEWLINE_IN_BODY = `{
  "evidence":{
    "title":"主流催收/外呼厂商方案对照与 TCO 估算",
    "body":"## 1. 结论摘要
- 腾讯云 TCCC 与阿里云智能外呼走\\"大厂基础设施型\\"
| 厂商 | ASR | LLM |
| --- | --- | --- |
| 科大讯飞 | 自研 | 星火 |"
  }
}`;

  it("正文含裸换行 → 救回(裸换行转义回 \\n,正文不丢)", () => {
    const r = parseJsonLenient<{ evidence: { title: string; body: string } }>(RAW_NEWLINE_IN_BODY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ev = r.value.evidence;
    // title 是 Executor.parseOutcome 的硬校验项,必须完整救回
    expect(ev.title).toBe("主流催收/外呼厂商方案对照与 TCO 估算");
    // 裸换行被还原成它在合法 JSON 里本来的样子 —— 正文内容一字不丢
    expect(ev.body).toContain("## 1. 结论摘要");
    expect(ev.body).toContain('走"大厂基础设施型"');
    expect(ev.body).toContain("| 厂商 | ASR | LLM |");
    expect(ev.body).toContain("| 科大讯飞 | 自研 | 星火 |");
    expect(ev.body.split("\n").length).toBeGreaterThan(3);
  });

  it("裸换行 + 被 maxTokens 截断 → 仍然救回", () => {
    const r = parseJsonLenient<{ evidence: { title: string; body: string } }>(
      RAW_NEWLINE_IN_BODY.slice(0, RAW_NEWLINE_IN_BODY.length - 40),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.evidence.title).toBe("主流催收/外呼厂商方案对照与 TCO 估算");
  });

  it("裸制表符 / 回车同样被转义,不吞正文", () => {
    const r = parseJsonLenient<{ a: { b: string } }>('{"a":{"b":"列1\t列2\r行尾"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.a.b).toBe("列1\t列2\r行尾");
  });

  it("不回归:本来就合规的转义写法不被二次转义", () => {
    // JSON 源码里的 \n / \t / \\ 都是**两字符**的合法转义,不是裸控制字符。
    // 严格 parse 直接成功(repaired=false),修复层根本不参与,值原样解出。
    const r = parseJsonLenient<{ a: string }>('{"a":"已有\\n转义\\t与\\\\反斜杠"}');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(false);
    // 解出的是「真换行 + 真制表符 + 单个反斜杠」,没有被二次转义成 \\n
    expect(r.value.a).toBe("已有\n转义\t与\\反斜杠");
    expect(r.value.a.includes("\\n")).toBe(false);
  });

  it("不回归:结构体里的真实换行(字符串之外)原样保留,仍是合法 JSON", () => {
    const r = parseJsonLenient<{ a: { b: string } }>(
      '{\n  "a": {\n    "b": "x"\n  }\n}',
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.repaired).toBe(false);
    expect(r.value.a.b).toBe("x");
  });

  it("不回归:纯自然语言仍必须失败 —— 不凭空造产物", () => {
    const r = parseJsonLenient("没有任何 JSON 的自然语言输出");
    expect(r.ok).toBe(false);
  });
});
