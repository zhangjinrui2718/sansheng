/**
 * Sansheng · 回合后异步智能沉淀(批次 5b-2 · T1,jev 裁决 A 方案)
 *
 * 定位:chat 回合的 Pi message_end 之后(assistant 真回复完成),fire-and-forget
 * 跑一次独立小 LLM 调用,把本轮转录(user raw + assistant 回复 + 少量前文)提炼成
 * D7 形态的结构化记忆 artifacts(kind ∈ intent/hypothesis/note/decision),写入
 * blackboard storage(conversation scope)+ artifactBus.publish("artifact_created")
 * —— UI 工件消费链路(批次 1/3)零改动即可见。
 *
 * 与既有两套记忆的边界(不混):
 *   - fragments 快路径 = 5b-1 feedback(extractFragments 正则,「记住:/我叫/我喜欢」)
 *     + agent_end 的 [reflection] 成本 trace —— 不动;
 *   - 本服务产的是 **artifacts(blackboard)**,不是 fragments;
 *   - task/feedback 的合成 ack turn **不触发**(kernel 只对 Pi handler message_end
 *     挂钩,合成 turn 走 prompt() 内 closeAckTurn,不经该 handler)。
 *
 * 质量闸门(垃圾 summary 自放大事故的教训,5a.5;prompt 与代码双层强制):
 *   - 宁缺毋滥:无实质内容的回合(寒暄/单句问答)→ 模型输出空数组 → 不落库;
 *   - kind 白名单:只收 intent/hypothesis/note/decision(D7 沉淀四形态),其余丢弃;
 *   - title ≤ 60 字(超长截断)/ body < 200 字(超长截断);
 *   - 同 conversation 相似 title 去重(归一化后包含关系即视为重复,含批内去重);
 *   - 每回合最多 SEDIMENT_MAX_PER_TURN(3)条;
 *   - parse 失败 / 超时(默认 8s)/ LLM 抛错 / 无模型 / SANSHENG_SEDIMENT=0 →
 *     静默跳过(log.muted),绝不 throw、绝不影响主路径(kernel 侧另有 .catch 双保险,
 *     审查 C1 教训:unhandled rejection 崩进程)。
 *
 * 测试卫生(与 5b-1 decide 同款三件套):
 *   - env 闸门默认开;tests/setup-env.ts 全局置 SANSHENG_SEDIMENT=0(集成测试普遍
 *     fake apiKey + resolved model,不关则每个 chat 回合都触发真实沉淀请求);
 *   - DI seam:deps.llmCall 注入绕过 env/模型闸门(显式注入 = 显式测试意图,
 *     makeLlmCommunicatorDecide 同款语义);kernel 侧 seam = AgentKernelOptions
 *     .sedimentLlmCall;
 *   - 生产出口 = completeSimple(getModel())(ws.ts makeLlmCall / decide 同款模式)。
 *
 * D7 协议复用:JSON 提取 + artifact 构建 + intent 降级(imperative-missing →
 * hypothesis)直接拆用 communicator.ts 的 parseStructuredOutput(该方法自 5b-2
 * 起由本服务消费,不再是死代码);parse 失败的 fallbackToNote 降级在沉淀路径
 * **刻意不采用** —— 检查 parseError 即整轮跳过(宁缺毋滥,不落「解析失败」note)。
 */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Model } from "@earendil-works/pi-ai";
import { log } from "../../shared/log.js";
import {
  isArtifactAuthor,
  type ArtifactKind,
  type BlackboardArtifact,
} from "../../../shared/types/blackboard.js";
import { artifactBus, makeArtifact } from "../bus/index.js";
import { upsertArtifact, listArtifacts } from "../storage/repo/blackboards.js";
import type { Storage } from "../storage/db.js";
import { parseStructuredOutput } from "./communicator.js";

/* ───────────────────────────── 常量(质量闸门) ───────────────────────────── */

/** 沉淀 LLM 调用超时(ms)。回合后异步,不在主路径,但也不许悬挂 → 8s 硬上限。 */
export const SEDIMENT_LLM_TIMEOUT_MS = 8_000;
/** 输出上限(token):≤3 条 artifacts(title≤60/body<200)足够,防模型跑飞。 */
export const SEDIMENT_LLM_MAX_TOKENS = 800;
/** 每回合最多沉淀条数(任务建议 2-3,取 3;宁缺毋滥)。 */
export const SEDIMENT_MAX_PER_TURN = 3;
/** title 上限(字)。超长截断到此长度(D7 schema:≤60 字)。 */
export const SEDIMENT_TITLE_MAX = 60;
/** body 上限(字)。D7 schema:< 200 字 → 截断后最长 199。 */
export const SEDIMENT_BODY_MAX = 199;
/** kind 白名单:D7 沉淀四形态。其余(todo/evidence/harness_proposal…)一律丢弃。 */
export const SEDIMENT_ALLOWED_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  "intent",
  "hypothesis",
  "note",
  "decision",
]);
/** 转录截断:user raw / assistant 回复 / 前文单条 / 前文条数。 */
const TRANSCRIPT_USER_MAX = 1_000;
const TRANSCRIPT_ASSISTANT_MAX = 2_000;
const TRANSCRIPT_PRIOR_ITEMS = 4;
const TRANSCRIPT_PRIOR_CHARS = 150;

/** 提取 prompt(system)。质量闸门写进 prompt(代码层再强制一遍,双层防线)。 */
export const SEDIMENT_SYSTEM_PROMPT = `你是三生系统的「沉淀器」。沟通员与用户的一轮对话刚刚结束;请从转录中提炼值得长期保留的结构化记忆(artifacts)。

只输出一个 JSON 对象,禁止 markdown 围栏、禁止任何解释文字:
{"artifacts":[{"kind":"...","title":"...","body":"..."}]}

kind 只能四选一:
- intent:用户明确表达了想做什么(含动作目标),每轮最多 1 个;
- decision:对话中已确认的结论或决定,会影响后续行动;
- hypothesis:尚未验证的推断、猜测或待确认的问题;
- note:中性但有信息量的事实、上下文或结果记录。

质量闸门(宁缺毋滥,这是硬性要求):
1. 无实质内容的回合——寒暄、致谢、单句问答、纯闲聊、情绪表达——必须输出 {"artifacts":[]}。
2. 每轮最多 3 条,只保留最有长期价值的;可要可不要的一律不要。
3. title ≤ 60 字,具体、可检索;禁止「对话记录」「用户提问」「本次讨论」这类空泛标题。
4. body < 200 字,提炼信息本身(结论/事实/目标),不复述对话原文,不写过程性废话。
5. 不沉淀沟通员的客套话、系统内部细节、工具输出噪音。
6. 拿不准就输出空数组——错误的沉淀比没有沉淀更糟。`;

/* ───────────────────────────── 类型 ───────────────────────────── */

export interface SedimentLlmDeps {
  /** 返回当前 resolved Model;null → 无模型 → 跳过(不触网)。 */
  getModel: () => Model<any> | null;
  /**
   * DI seam(测试注入):替换默认的 completeSimple 调用。注入时绕过 env/模型
   * 闸门(显式注入 = 显式测试意图,makeLlmCommunicatorDecide 同款语义)。
   */
  llmCall?: (input: { systemPrompt: string; userPrompt: string }) => Promise<string>;
  /** 覆盖超时(ms);默认 8000。 */
  timeoutMs?: number;
  /** 覆盖输出 token 上限;默认 800。 */
  maxTokens?: number;
  /** 覆盖每回合条数上限;默认 3。 */
  maxArtifacts?: number;
}

export interface SedimentTurnInput {
  conversationId: string;
  /** 本回合 user raw 原文(kernel pendingUserText 同源,非 enriched)。 */
  userText: string;
  /** 本回合 assistant 回复全文(Pi message_end buf.textDeltas.join(""))。 */
  assistantText: string;
  /** 触发沉淀的 assistant message id(写进 metadata.sedimentedFrom,可溯源)。 */
  assistantMessageId?: string;
  /** 少量前文(不含本回合;服务内再截断 ≤4 条 × 150 字符)。 */
  recentTranscript?: Array<{ role: "user" | "assistant"; content: string }>;
}

export type SedimentSkipReason =
  | "disabled" // SANSHENG_SEDIMENT=0(测试卫生闸门;注入 llmCall 时绕过)
  | "no_model" // getModel() → null(未配置 provider / kernel 未 start)
  | "empty_turn" // 本回合无文本
  | "timeout" // 超过 timeoutMs
  | "parse_failed" // LLM 输出非合法 D7 JSON(宁缺毋滥 → 整轮跳过)
  | "llm_error"; // LLM 调用抛错(离线/网络/鉴权)

export interface SedimentationResult {
  /** stored=有 artifact 落库+广播;empty=合法输出但无可沉淀(含全部被闸门丢弃);skipped=未跑/失败。 */
  status: "stored" | "empty" | "skipped";
  reason?: SedimentSkipReason;
  /** 实际落库并广播的 artifacts(落库失败的不在此列,也不广播)。 */
  artifacts: BlackboardArtifact[];
  /** 被质量闸门(kind/去重/数量)丢弃的候选条数(observability)。 */
  droppedByGate: number;
}

/* ───────────────────────────── 内部工具 ───────────────────────────── */

function skip(reason: SedimentSkipReason): SedimentationResult {
  return { status: "skipped", reason, artifacts: [], droppedByGate: 0 };
}

/** title 归一化(小写、去空白与标点)→ 去重比较用。 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, SEDIMENT_TITLE_MAX);
}

/**
 * 相似 title 判定(简单包含即可,别过度工程):归一化后相等或互为包含
 * (较短一方 ≥4 字符,防「note」这类超短 title 误杀)。
 */
function titlesSimilar(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (Math.min(na.length, nb.length) < 4) return false;
  return na.includes(nb) || nb.includes(na);
}

function clampTitle(title: string): string {
  const t = title.trim();
  return t.length > SEDIMENT_TITLE_MAX ? t.slice(0, SEDIMENT_TITLE_MAX - 1) + "…" : t;
}

function clampBody(body: string): string {
  const b = body.trim();
  return b.length > SEDIMENT_BODY_MAX ? b.slice(0, SEDIMENT_BODY_MAX) : b;
}

/** 组装 userPrompt:[前文](可选,截断)+ [本回合用户] + [本回合沟通员回复]。 */
function buildSedimentUserPrompt(input: SedimentTurnInput): string {
  const parts: string[] = [];
  const prior = (input.recentTranscript ?? []).slice(-TRANSCRIPT_PRIOR_ITEMS);
  if (prior.length > 0) {
    parts.push("[前文]");
    for (const h of prior) {
      const body = (h.content ?? "").replace(/\s+/g, " ").trim().slice(0, TRANSCRIPT_PRIOR_CHARS);
      if (body) parts.push(`${h.role}: ${body}`);
    }
    parts.push("");
  }
  parts.push("[本回合用户]");
  parts.push(input.userText.trim().slice(0, TRANSCRIPT_USER_MAX));
  parts.push("");
  parts.push("[本回合沟通员回复]");
  parts.push(input.assistantText.trim().slice(0, TRANSCRIPT_ASSISTANT_MAX));
  return parts.join("\n");
}

/* ───────────────────────────── 主入口 ───────────────────────────── */

/**
 * 对一个已完成的 chat 回合跑智能沉淀。**永不 throw**(全部失败路径 → status
 * "skipped"/"empty" + log.muted);调用方(kernel)仍以 .catch 双保险。
 */
export async function sedimentTurn(
  deps: SedimentLlmDeps,
  storage: Storage,
  input: SedimentTurnInput,
): Promise<SedimentationResult> {
  const injected = deps.llmCall;
  // 闸门:未注入 llmCall 时,显式关闭 / 无模型 → 直接跳过(不触网)。
  if (!injected) {
    if (process.env.SANSHENG_SEDIMENT === "0") return skip("disabled");
    if (!deps.getModel()) return skip("no_model");
  }
  if (!input.assistantText.trim() && !input.userText.trim()) return skip("empty_turn");

  // 1) LLM 调用(硬超时;正常路径也清 timer,防悬挂 handle 拖住事件循环)
  const productionCall = async (callInput: {
    systemPrompt: string;
    userPrompt: string;
  }): Promise<string> => {
    const model = deps.getModel();
    if (!model) throw new Error("sediment: no resolved model");
    const result = await completeSimple(model as Parameters<typeof completeSimple>[0], {
      systemPrompt: callInput.systemPrompt,
      messages: [{ role: "user", content: callInput.userPrompt, timestamp: Date.now() }],
    }, { maxTokens: deps.maxTokens ?? SEDIMENT_LLM_MAX_TOKENS });
    if (result.stopReason === "error" || result.errorMessage) {
      throw new Error(result.errorMessage ?? "completeSimple error");
    }
    const out: string[] = [];
    for (const c of result.content) {
      if (c.type === "text") out.push(c.text);
    }
    return out.join("");
  };

  const timeoutMs = deps.timeoutMs ?? SEDIMENT_LLM_TIMEOUT_MS;
  let raw: string;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    raw = await Promise.race([
      (injected ?? productionCall)({
        systemPrompt: SEDIMENT_SYSTEM_PROMPT,
        userPrompt: buildSedimentUserPrompt(input),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("sediment timeout")), timeoutMs);
      }),
    ]);
  } catch (err) {
    const msg = (err as Error)?.message ?? String(err);
    const reason: SedimentSkipReason = msg.includes("sediment timeout") ? "timeout" : "llm_error";
    log.muted(`sedimentation: skip(${reason})conv=${input.conversationId} — ${msg}`);
    return skip(reason);
  } finally {
    if (timer) clearTimeout(timer);
  }

  // 2) D7 parse(拆用 parseStructuredOutput;parseError → 整轮跳过,不落降级 note)
  const parsed = parseStructuredOutput(raw);
  if (parsed.parseError) {
    log.muted(
      `sedimentation: skip(parse_failed) conv=${input.conversationId} — ${parsed.parseError.slice(0, 120)}`,
    );
    return skip("parse_failed");
  }

  // 3) 质量闸门(代码层强制,与 prompt 双层防线)
  const maxPerTurn = deps.maxArtifacts ?? SEDIMENT_MAX_PER_TURN;
  // 既有会话 artifacts 的 title → 去重上下文(读失败 = 无上下文,不阻塞)
  const existingTitles: string[] = [];
  try {
    const existing = listArtifacts(storage.db, {
      scope: "conversation",
      conversationId: input.conversationId,
      limit: 100,
    });
    for (const a of existing) existingTitles.push(a.title);
  } catch (err) {
    log.muted(`sedimentation: dedupe context unavailable (${(err as Error)?.message ?? err})`);
  }

  const kept: BlackboardArtifact[] = [];
  let droppedByGate = 0;
  for (const v of parsed.artifacts) {
    if (kept.length >= maxPerTurn) {
      droppedByGate++;
      continue;
    }
    const candidate = v.artifact;
    // kind 白名单(D7 沉淀四形态)
    if (!SEDIMENT_ALLOWED_KINDS.has(candidate.kind)) {
      droppedByGate++;
      continue;
    }
    const title = clampTitle(candidate.title);
    const body = clampBody(candidate.body);
    // 空 title(含 parse 的 "(untitled)" 默认)/ 空 body → 垃圾,丢弃
    if (!title || title === "(untitled)" || !body) {
      droppedByGate++;
      continue;
    }
    // 去重:与既有会话 artifacts 或本批已留条目相似 → 丢弃
    const dup =
      existingTitles.some((t) => titlesSimilar(title, t)) ||
      kept.some((k) => titlesSimilar(title, k.title));
    if (dup) {
      droppedByGate++;
      continue;
    }
    kept.push(
      makeArtifact({
        kind: candidate.kind,
        title,
        body,
        // author 枚举校验(parseStructuredOutput 不校验 author;防脏值进 UI)
        author: isArtifactAuthor(candidate.author) ? candidate.author : "communicator",
        // 沉淀 = 会话局部记忆(scope/conversationId 代码强制,不信模型输出)
        scope: "conversation",
        conversationId: input.conversationId,
        status: "open",
        refs: candidate.refs,
        metadata: {
          ...(candidate.metadata ?? {}),
          source: "sedimentation",
          ...(input.assistantMessageId ? { sedimentedFrom: input.assistantMessageId } : {}),
          ...(v.downgraded ? { downgraded: v.downgraded } : {}),
        },
      }),
    );
  }

  if (kept.length === 0) {
    return { status: "empty", artifacts: [], droppedByGate };
  }

  // 4) 落库 + 广播(逐条隔离:单条 upsert 失败 → 丢弃该条,不广播未落库的 artifact)
  const stored: BlackboardArtifact[] = [];
  for (const art of kept) {
    try {
      upsertArtifact(storage.db, art);
    } catch (err) {
      droppedByGate++;
      log.muted(
        `sedimentation: upsert failed "${art.title}" (${(err as Error)?.message ?? err})`,
      );
      continue;
    }
    try {
      artifactBus.publish({ type: "artifact_created", artifact: art });
    } catch (err) {
      // 已落库;广播失败只记日志(bus 自身对 handler 抛错也有隔离)
      log.muted(`sedimentation: publish failed "${art.title}" (${(err as Error)?.message ?? err})`);
    }
    stored.push(art);
  }

  if (stored.length === 0) {
    return { status: "empty", artifacts: [], droppedByGate };
  }
  log.muted(
    `sedimentation: stored ${stored.length} artifact(s) for conv=${input.conversationId} (dropped=${droppedByGate})`,
  );
  return { status: "stored", artifacts: stored, droppedByGate };
}
