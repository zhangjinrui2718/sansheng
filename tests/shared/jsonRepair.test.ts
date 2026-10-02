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
