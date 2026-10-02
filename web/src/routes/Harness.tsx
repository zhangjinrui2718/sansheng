/**
 * Sansheng · Harness 页(批次 UI U1 → 产品设计 §6「每个 agent 的雇员手册」)
 *
 * 页面定位(docs/PRODUCT-DESIGN-2026-10-02.md §6):Harness **不是一张全局只读报表**,
 * 而是**每个 agent 的雇员手册** —— 一页说清「谁在跑 / 他读的是哪份手册 / 那份手册现在
 * 真的生效了吗 / 改完什么时候生效」。三档「生效状态」徽章是本页的核心价值:
 * 诚实告诉用户「planner 有一份 3766 字节的手册在生效;harness_manager 压根没有文件,
 * 用的是编译进代码的那份」。诚实 > 好看。
 *
 * ── 数据源:唯一 `GET /api/harness`(src/server/http.ts:260,只读)──────────────
 *   manager  : { running, stats{received,processed,failed,skippedSeen,skippedStorageDedup,
 *                             skippedInFlight,seenSize,inFlightSize},
 *                decideSource: "production-llm"|"injected"|null, startedAt|null }
 *              计数器**内存态**,重启清零(manager 自身无持久化)。
 *   prompts  : Array<{ role, lines, chars, state:"default"|"legacy_factory"|"user_edited"|"empty" }>
 *              —— API 固定返回 6 个角色(loader DEFAULT_PROMPTS 枚举 RoleKind)。
 *              **本页只取其中 3 个**:critic / memory / reflection 的 md 文件全项目
 *              **无任何读取方**(产品设计 §1,用户 2026-10-02 决定暂不实现,界面不列出)。
 *   harnessManagerPrompt : { source:"builtin_fallback", lines, editable:false, note }
 *              —— harness_manager **没有自己的 md 文件**,用的是编译进代码的
 *              FALLBACK_HARNESS_PROMPT(agents/harnessManager.ts:127)。
 *   config   : { enabledTools[], redLines[], budget{maxIterations,perStepTimeoutMs,maxCostUsd} }
 *              —— 三个字段都是 harness/loader.ts:40-42 的**硬编码字面量**:无磁盘来源、
 *              无消费者、从不强制执行。页面上统一标 🟡「仅声明未强制」。
 *   proposals / previews : BlackboardArtifact[] —— 真实读 blackboard storage(scope=global)。
 *   notes    : string[] —— server 如实交代语义边界,原样展示。
 *
 * ── 反造假纪律(本项目最强的一条,本页尤其重要)────────────────────────────
 *   1. **不造示例条目**:proposals / previews 没有就是空态,并写清「为什么结构上永远不会来」
 *      (manager 只认 kind==="harness_proposal",executor 恒发 kind==="hypothesis")。
 *   2. **不假装配置在生效**:enabledTools / redLines / budget 一律标 🟡,并把「真实的
 *      执行点在别处(makeLlmCall 的 PLANNER_EXECUTOR_MAX_TOKENS / communicator 的只读
 *      工具白名单)」摆在旁边对照,不让用户以为改这三个数有用。
 *   3. **不承诺本页没有的功能**:"生效时机"表描述的是「如果文件被改,系统什么时候读到」
 *      这个**系统事实**,本页只读、不提供编辑,仓库当前也没有任何 harness 写接口。
 *   4. **徽章由数据推导,不是写死**:state==="empty" → 实际回退的是模块内置 stub
 *      (planner.ts:176 / executor.ts:124)或 SDK 默认,那就标 🔵 而不是 🟢。
 *
 * 视觉:沿用既有骨架(px-4 pb-4 / sansheng-h2 / sansheng-card / sansheng-text-mute)
 * 与既有 token(--ink-* / --bone* / --jade / --amber),不引入新配色、不引新依赖。
 */
import { useCallback, useEffect, useState } from "react";

interface HarnessPromptInfo {
  role: string;
  lines: number;
  chars: number;
  state: "default" | "legacy_factory" | "user_edited" | "empty";
}

interface HarnessStats {
  received: number;
  processed: number;
  failed: number;
  skippedSeen: number;
  skippedStorageDedup: number;
  skippedInFlight: number;
  seenSize: number;
  inFlightSize: number;
}

interface HarnessArtifact {
  id: string;
  kind: string;
  title: string;
  body: string;
  author: string;
  status: string;
  createdAt: number;
}

interface HarnessResponse {
  manager: {
    running: boolean;
    stats: HarnessStats | null;
    decideSource: "production-llm" | "injected" | null;
    startedAt: number | null;
  };
  prompts: HarnessPromptInfo[];
  harnessManagerPrompt: { source: string; lines: number; editable: boolean; note: string };
  config: {
    enabledTools: string[];
    redLines: string[];
    budget: { maxIterations: number; perStepTimeoutMs: number; maxCostUsd: number };
  };
  proposals: HarnessArtifact[];
  previews: HarnessArtifact[];
  notes: string[];
}

/* ── 手册覆盖范围 ──────────────────────────────────────────────────────────
 * API 仍返回 6 个角色的 prompt 摘要;critic / memory / reflection 没有实现、
 * 其 md 文件无任何读取方(产品设计 §1),本页**不列出**。
 * 三者不列,是因为「永远点不亮的灰行是噪声,不如不列」——
 * 不是把它们标成某种状态,而是整条移除。 */

const MANUAL_ROLES = ["communicator", "planner", "executor"] as const;
type ManualRole = (typeof MANUAL_ROLES)[number];

/** module-level type guard:把 API 的 role 字符串收窄到手册覆盖的角色。 */
function isManualRole(value: string): value is ManualRole {
  return (MANUAL_ROLES as readonly string[]).includes(value);
}

/* ── 三档「生效状态」(产品设计 §6 ①)──────────────────────────────────────── */

type EffectTier = "live" | "builtin" | "declared";

const TIER_LABEL: Record<EffectTier, string> = {
  live: "生效中",
  builtin: "硬编码兜底",
  declared: "仅声明未强制",
};

/** 生效中=玉(jade,系统主色);硬编码兜底=骨(bone,中性灰,表示「在跑但不是文件」);
 *  仅声明未强制=琥(amber,警示色)。全部取自 tokens.css,不新增颜色。 */
const TIER_COLOR: Record<EffectTier, string> = {
  live: "var(--jade)",
  builtin: "var(--bone-dim)",
  declared: "var(--amber)",
};

const TIER_HINT: Record<EffectTier, string> = {
  live: "真被读取并注入模型",
  builtin: "没有自己的文件,用的是编译进代码的常量",
  declared: "展示了,但代码里没有任何执行点",
};

function EffectBadge({ tier, title }: { tier: EffectTier; title?: string }) {
  return (
    <span
      className="font-mono rounded"
      style={{
        fontSize: 10,
        padding: "2px 7px",
        background: tier === "live" ? "var(--jade-soft)" : "var(--ink-2)",
        color: TIER_COLOR[tier],
        whiteSpace: "nowrap",
      }}
      title={title ?? TIER_HINT[tier]}
    >
      <span
        style={{
          display: "inline-block",
          width: 5,
          height: 5,
          borderRadius: 1,
          background: TIER_COLOR[tier],
          marginRight: 5,
          verticalAlign: "middle",
        }}
      />
      {TIER_LABEL[tier]}
    </span>
  );
}

/* ── prompt 状态(复用既有 STATE_LABEL / STATE_TONE 语义,加一层安全取值)─── */

const STATE_LABEL: Record<string, string> = {
  default: "默认",
  legacy_factory: "旧出厂版",
  user_edited: "用户编辑过",
  empty: "空",
};

const STATE_TONE: Record<string, string> = {
  default: "var(--bone-mute)",
  legacy_factory: "var(--bone-mute)",
  user_edited: "var(--jade)",
  empty: "var(--ochre)",
};

function stateLabel(state: string): string {
  return STATE_LABEL[state] ?? "未知";
}

function stateTone(state: string): string {
  return STATE_TONE[state] ?? "var(--ochre)";
}

function StatePill({ state }: { state: string }) {
  return (
    <span
      className="font-mono rounded"
      style={{ fontSize: 10, padding: "1px 6px", background: "var(--ink-2)", color: stateTone(state) }}
      title={
        state === "user_edited"
          ? "用户编辑过 · ensureHarness 永不覆盖"
          : state === "legacy_factory"
            ? "出厂旧版 · 下次启动会被 ensureHarness 自动升级为当前默认"
            : state === "empty"
              ? "无文件/空文件 · 不注入 harness prompt,回退内置 stub 或 SDK 默认"
              : undefined
      }
    >
      {stateLabel(state)}
    </span>
  );
}

/** 行内强调。设计文档用 ** 标重点,UI 里不能直接输出 markdown 记号。 */
function Em({ children }: { children: string }) {
  return (
    <b style={{ color: "var(--bone)", fontWeight: 500 }}>{children}</b>
  );
}

/* ── 每个 agent 的档案 ───────────────────────────────────────────────────── */

interface ManualMeta {
  role: ManualRole;
  title: string;
  /** 角色职责 —— 写的是这个 agent 在系统里实际干的事,不是职责说明书 */
  duty: string;
  /** 它的 system prompt 在哪里被读取并注入(徽章判定的依据) */
  injectBasis: string;
  /** 真实工具面(不是 config.enabledTools —— 那个不生效) */
  tools: string[];
  toolsNote: string;
  /** 文件被改动后,系统什么时候读到 */
  apply: string;
  applyBasis: string;
}

const MANUAL_META: readonly ManualMeta[] = [
  {
    role: "communicator",
    title: "沟通员",
    duty:
      "用户唯一的对话入口。接住消息后 decide 成 chat / task / clarify / feedback;把对话沉淀成 intent 等结构化工件;worker 升级上来的求助与总线提问也经它转述给用户。由 Pi SDK session 驱动,自己不直接调 LLM。",
    injectBasis: "kernel/agentKernel.ts:940 每次重建 session 时读盘注入",
    tools: ["read", "grep", "find", "ls"],
    toolsNote:
      "只读白名单硬编码在 kernel/agentKernel.ts:965,bash / edit / write / powershell 被剥掉 —— 这是代码里真实生效的限权,和下面的 config.enabledTools 不是一回事。",
    apply: "下一次 start / resume / reset",
    applyBasis: "agentKernel.ts:933-940 每次建 session 重新 loadHarness",
  },
  {
    role: "planner",
    title: "规划者",
    duty:
      "把一个 intent 拆成 todo DAG(带 dependsOn / parentIntent),planner 产出的每个 todo 就是执行者的一份工单。",
    injectBasis: "agents/orchestrator.ts:186 构造时读一次盘",
    tools: [],
    toolsNote:
      "无工具面:走 ws.ts:179-226 的 makeLlmCall → completeSimple,只送 systemPrompt + messages。",
    apply: "下一次 plan 运行时 —— 不用重启",
    applyBasis: "orchestrator.ts:183-188 构造时读一次;每次 run_plan 新建实例(ws.ts:327-339)",
  },
  {
    role: "executor",
    title: "执行者",
    duty:
      "领 todo 干活,产出 evidence / decision;干不动时升级成 hypothesis(status=waiting_for_decision)等人拍板;失败沿 dependsOn 向下级联。它的 system prompt 明确建立在「没有工具能力」之上。",
    injectBasis: "agents/orchestrator.ts:188 构造时读一次盘",
    tools: [],
    toolsNote:
      "无工具面:同 planner(makeLlmCall 不挂工具),产出靠模型领域知识 + JSON 协议,不是工具调用。",
    apply: "下一次 plan 运行时 —— 不用重启",
    applyBasis: "orchestrator.ts:183-188 构造时读一次;每次 run_plan 新建实例(ws.ts:327-339)",
  },
];

/** harness_manager 的档案内容随 API 字段变(source / editable),所以单列。 */
const MANAGER_META = {
  title: "工装顾问",
  duty:
    "订阅 artifact_created,对 kind=harness_proposal 且 status=open 的工件生成只读的实现预览(绝不写文件;v0 无 apply 语义,D15)。",
  tools: [] as string[],
  toolsNote:
    "无工具面,也不允许写盘。页眉右侧的 decideSource 说明它的判断来自 production-llm 还是注入。",
  apply: "需要改代码 —— 它没有 md 文件",
  applyBasis: "agents/harnessManager.ts:127 FALLBACK_HARNESS_PROMPT 编译进代码",
} as const;

const STAT_LABEL: Array<{ key: keyof HarnessStats; label: string }> = [
  { key: "received", label: "收到" },
  { key: "processed", label: "已处理" },
  { key: "failed", label: "失败" },
  { key: "skippedSeen", label: "去重" },
  { key: "skippedStorageDedup", label: "落库去重" },
  { key: "skippedInFlight", label: "在飞去重" },
  { key: "seenSize", label: "seen" },
  { key: "inFlightSize", label: "在飞" },
];

/** 「生效时机」表(产品设计 §6 ②)—— 描述系统事实,不是本页提供的功能。 */
const APPLY_TABLE: ReadonlyArray<{ who: string; when: string; basis: string }> = [
  {
    who: "planner / executor",
    when: "下一次 plan 运行时(构造时读一次盘)→ 不用重启",
    basis: "orchestrator.ts:183-188;每次 run_plan 新建实例(ws.ts:327-339)",
  },
  {
    who: "communicator(Pi 直答)",
    when: "下一次 start / resume / reset",
    basis: "agentKernel.ts:933-940",
  },
  {
    who: "communicator(Communicator 实例)",
    when: "需要 kernel 失效重建(kernel.invalidate())",
    basis: "实例被 memoize(agentKernel.ts:213,363-365),构造时读一次",
  },
  {
    who: "harness_manager",
    when: "需要改代码 —— 没有 md 文件",
    basis: "harnessManager.ts:127(编译内置 FALLBACK_HARNESS_PROMPT)",
  },
];

export function HarnessPage() {
  const [data, setData] = useState<HarnessResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/harness");
      const json = (await res.json()) as HarnessResponse & {
        error?: string;
        message?: string;
      };
      if (!res.ok || json.error) {
        setError(json.message ?? json.error ?? `HTTP ${res.status}`);
        setData(null);
      } else {
        setData(json);
        setError(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <main className="px-4 pb-4">
        <h2 className="sansheng-h2">Harness</h2>
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="px-4 pb-4">
        <h2 className="sansheng-h2">Harness</h2>
        <div className="sansheng-card p-4 text-sm opacity-70">{loading ? "加载中…" : "—"}</div>
      </main>
    );
  }

  const { manager, prompts, config, proposals, previews, notes, harnessManagerPrompt } = data;

  // 只保留手册覆盖的 3 个文件型角色;另外 3 个角色是死文件,不进本页。
  const promptByRole = new Map<string, HarnessPromptInfo>();
  for (const p of prompts) {
    if (isManualRole(p.role)) promptByRole.set(p.role, p);
  }

  // 徽章由数据推导:state==="empty" 时真正被注入的是模块内置 stub / SDK 默认,
  // 不是磁盘文件 → 那一档必须如实降级成「硬编码兜底」,不能一律标绿。
  const tierOf = (info: HarnessPromptInfo | undefined): EffectTier =>
    !info || info.state === "empty" ? "builtin" : "live";

  const managerTier: EffectTier =
    harnessManagerPrompt.source === "builtin_fallback" || harnessManagerPrompt.editable === false
      ? "builtin"
      : "live";

  const emptyPromptHint = "无文件 / 空文件 · 不注入 harness prompt,回退内置 stub 或 SDK 默认";

  return (
    <main className="px-4 pb-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="sansheng-h2">Harness</h2>
        <div className="flex items-center gap-2 text-xs font-mono">
          <span
            className="rounded"
            style={{
              padding: "1px 7px",
              fontSize: 10,
              background: manager.running ? "var(--jade-soft)" : "var(--ink-3)",
              color: manager.running ? "var(--jade)" : "var(--bone-mute)",
            }}
          >
            {manager.running ? "● 运行中" : "○ 未运行"}
          </span>
          <span className="sansheng-text-mute">{manager.decideSource ?? "—"}</span>
        </div>
      </div>

      <div className="grid gap-3">
        {/* ── ① 雇员手册:每个 agent 一张卡 ── */}
        <section className="sansheng-card p-4">
          <div className="flex items-baseline justify-between mb-1">
            <h3 className="font-medium">Agent 雇员手册</h3>
            <div className="flex items-center gap-1.5" style={{ fontSize: 10 }}>
              <EffectBadge tier="live" />
              <EffectBadge tier="builtin" />
              <EffectBadge tier="declared" />
            </div>
          </div>
          <p className="sansheng-text-mute mb-3" style={{ fontSize: 11, lineHeight: 1.7 }}>
            徽章三档:生效中 = 真被读取并注入模型;硬编码兜底 = 没有自己的文件,用编译进代码的常量;
            仅声明未强制 = 展示了但代码里不执行。手册只列系统里真实在跑的 agent。
          </p>

          <div className="grid gap-3 md:grid-cols-2">
            {MANUAL_META.map((meta) => {
              const info = promptByRole.get(meta.role);
              const tier = tierOf(info);
              return (
                <article key={meta.role} className="sansheng-card-elevated p-3">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <div className="text-sm" style={{ color: "var(--bone)" }}>
                      {meta.title}
                      <span className="font-mono sansheng-text-mute ml-1.5" style={{ fontSize: 10 }}>
                        {meta.role}
                      </span>
                    </div>
                    {/* 摘要缺失时不给档位 —— 无从判定就不猜,不用「看起来像兜底」糊过去 */}
                    {info ? (
                      <EffectBadge tier={tier} />
                    ) : (
                      <span className="sansheng-text-mute" style={{ fontSize: 10, whiteSpace: "nowrap" }}>
                        摘要缺失
                      </span>
                    )}
                  </div>

                  <p style={{ fontSize: 11, lineHeight: 1.75, color: "var(--bone-dim)" }}>{meta.duty}</p>

                  <div className="sansheng-divider my-2" />

                  <div className="font-mono" style={{ fontSize: 10, color: "var(--bone-mute)" }}>
                    system prompt
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 mt-1" style={{ fontSize: 11 }}>
                    {info ? (
                      <>
                        <span style={{ color: "var(--bone-dim)" }}>{info.lines} 行</span>
                        <span style={{ color: "var(--ink-4)" }}>·</span>
                        <span style={{ color: "var(--bone-dim)" }}>{info.chars} 字符</span>
                        <StatePill state={info.state} />
                      </>
                    ) : (
                      <span className="sansheng-text-mute">API 未返回该角色的 prompt 摘要</span>
                    )}
                  </div>
                  {info?.state === "empty" && (
                    <div className="sansheng-text-mute mt-1" style={{ fontSize: 10, lineHeight: 1.6 }}>
                      {emptyPromptHint}
                    </div>
                  )}
                  <div className="sansheng-text-mute mt-1" style={{ fontSize: 10, lineHeight: 1.6 }}>
                    注入点:{meta.injectBasis}
                  </div>

                  <div className="sansheng-divider my-2" />

                  <div className="font-mono" style={{ fontSize: 10, color: "var(--bone-mute)" }}>
                    真实工具面
                  </div>
                  <div className="flex flex-wrap gap-1.5 mt-1">
                    {meta.tools.length > 0 ? (
                      meta.tools.map((t) => (
                        <span
                          key={t}
                          className="font-mono rounded"
                          style={{
                            fontSize: 10,
                            padding: "2px 7px",
                            background: "var(--jade-soft)",
                            color: "var(--jade)",
                          }}
                        >
                          {t}
                        </span>
                      ))
                    ) : (
                      <span className="sansheng-text-mute" style={{ fontSize: 11 }}>
                        无
                      </span>
                    )}
                  </div>
                  <div className="sansheng-text-mute mt-1" style={{ fontSize: 10, lineHeight: 1.6 }}>
                    {meta.toolsNote}
                  </div>

                  <div className="sansheng-divider my-2" />

                  <div className="font-mono" style={{ fontSize: 10, color: "var(--bone-mute)" }}>
                    手册改动后何时生效
                  </div>
                  <div style={{ fontSize: 11, color: "var(--bone-dim)", lineHeight: 1.7 }}>
                    {meta.apply}
                  </div>
                  <div className="sansheng-text-mute" style={{ fontSize: 10, lineHeight: 1.6 }}>
                    依据:{meta.applyBasis}
                  </div>
                </article>
              );
            })}

            {/* harness_manager:没有 md 文件,内容随 API 的 source / editable 变化 */}
            <article className="sansheng-card-elevated p-3">
              <div className="flex items-center justify-between gap-2 mb-1">
                <div className="text-sm" style={{ color: "var(--bone)" }}>
                  {MANAGER_META.title}
                  <span className="font-mono sansheng-text-mute ml-1.5" style={{ fontSize: 10 }}>
                    harness_manager
                  </span>
                </div>
                <EffectBadge tier={managerTier} />
              </div>

              <p style={{ fontSize: 11, lineHeight: 1.75, color: "var(--bone-dim)" }}>{MANAGER_META.duty}</p>

              <div className="sansheng-divider my-2" />

              <div className="font-mono" style={{ fontSize: 10, color: "var(--bone-mute)" }}>
                system prompt
              </div>
              <div className="flex flex-wrap items-center gap-1.5 mt-1" style={{ fontSize: 11 }}>
                <span style={{ color: "var(--bone-dim)" }}>{harnessManagerPrompt.lines} 行</span>
                <span style={{ color: "var(--ink-4)" }}>·</span>
                <span className="font-mono sansheng-text-mute">{harnessManagerPrompt.source}</span>
                <span
                  className="font-mono rounded"
                  style={{ fontSize: 10, padding: "1px 6px", background: "var(--ink-2)", color: "var(--bone-dim)" }}
                >
                  {harnessManagerPrompt.editable ? "可编辑" : "不可编辑"}
                </span>
              </div>
              <div className="sansheng-text-mute mt-1" style={{ fontSize: 10, lineHeight: 1.6 }}>
                {harnessManagerPrompt.note}
              </div>

              <div className="sansheng-divider my-2" />

              <div className="font-mono" style={{ fontSize: 10, color: "var(--bone-mute)" }}>
                真实工具面
              </div>
              <div className="sansheng-text-mute mt-1" style={{ fontSize: 11 }}>
                无
              </div>
              <div className="sansheng-text-mute mt-1" style={{ fontSize: 10, lineHeight: 1.6 }}>
                {MANAGER_META.toolsNote}
              </div>

              <div className="sansheng-divider my-2" />

              <div className="font-mono" style={{ fontSize: 10, color: "var(--bone-mute)" }}>
                手册改动后何时生效
              </div>
              <div style={{ fontSize: 11, color: "var(--bone-dim)", lineHeight: 1.7 }}>
                {MANAGER_META.apply}
              </div>
              <div className="sansheng-text-mute" style={{ fontSize: 10, lineHeight: 1.6 }}>
                依据:{MANAGER_META.applyBasis}
              </div>
            </article>
          </div>
        </section>

        {/* ── ② 生效时机表(为将来的编辑功能服务,现在只读展示)── */}
        <section className="sansheng-card p-4">
          <h3 className="font-medium mb-1">手册改动后何时生效</h3>
          <p className="sansheng-text-mute mb-2" style={{ fontSize: 11, lineHeight: 1.7 }}>
            这张表描述的是<Em>系统事实</Em>:如果磁盘上的 prompt 文件被改动,代码什么时候重新读到。
            本页只读,不提供编辑;仓库当前也没有任何 harness 写接口。
            没有这张表,改了 prompt 发现没反应会直接被判定成产品坏了。
          </p>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left sansheng-text-mute">
                <th style={{ fontSize: 11 }}>角色</th>
                <th style={{ fontSize: 11 }}>何时生效</th>
                <th style={{ fontSize: 11 }}>依据</th>
              </tr>
            </thead>
            <tbody>
              {APPLY_TABLE.map((row) => (
                <tr key={row.who} style={{ borderTop: "1px solid var(--ink-3)" }}>
                  <td className="py-1.5 pr-3" style={{ fontSize: 11, color: "var(--bone)" }}>
                    {row.who}
                  </td>
                  <td className="py-1.5 pr-3" style={{ fontSize: 11, color: "var(--bone-dim)" }}>
                    {row.when}
                  </td>
                  <td className="py-1.5 sansheng-text-mute" style={{ fontSize: 10 }}>
                    {row.basis}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* ── ③ 配置:三件套全部标 🟡(产品设计 §6 ① / §6.1)── */}
        <section className="sansheng-card p-4">
          <div className="flex items-center justify-between gap-2 mb-1">
            <h3 className="font-medium">配置</h3>
            <EffectBadge tier="declared" />
          </div>
          <p className="sansheng-text-mute mb-3" style={{ fontSize: 11, lineHeight: 1.7 }}>
            enabledTools / redLines / budget 三者都是 harness/loader.ts:40-42 的<Em>硬编码字面量</Em>:
            没有磁盘来源、没有消费者、从不强制执行。budget 的三个字段在 loader.ts 之外全项目零引用。
          </p>

          <div className="font-mono" style={{ fontSize: 10, color: "var(--bone-mute)" }}>
            enabledTools
          </div>
          <div className="flex flex-wrap gap-1.5 mt-1 mb-3">
            {config.enabledTools.length > 0 ? (
              config.enabledTools.map((t) => (
                <span
                  key={t}
                  className="font-mono rounded"
                  style={{ fontSize: 10, padding: "2px 7px", background: "var(--ink-2)", color: "var(--bone-dim)" }}
                >
                  {t}
                </span>
              ))
            ) : (
              <span className="sansheng-text-mute" style={{ fontSize: 11 }}>
                无
              </span>
            )}
          </div>

          <div className="font-mono" style={{ fontSize: 10, color: "var(--bone-mute)" }}>
            redLines
          </div>
          <div className="mt-1 mb-3" style={{ fontSize: 11, color: "var(--amber)", lineHeight: 1.7 }}>
            {config.redLines.length > 0 ? (
              config.redLines.map((r) => <div key={r}>— {r}</div>)
            ) : (
              <span className="sansheng-text-mute">无</span>
            )}
          </div>

          <div className="font-mono" style={{ fontSize: 10, color: "var(--bone-mute)" }}>
            budget
          </div>
          <div className="font-mono mt-1" style={{ fontSize: 10, color: "var(--bone-dim)" }}>
            迭代 {config.budget.maxIterations} · 单步 {config.budget.perStepTimeoutMs}ms · 上限 $
            {config.budget.maxCostUsd}
          </div>

          <div className="sansheng-divider my-3" />

          <div className="grid gap-2" style={{ fontSize: 11, lineHeight: 1.75, color: "var(--bone-dim)" }}>
            <div>
              <span style={{ color: "var(--bone)" }}>系统里真实存在的约束在别处:</span>
              <br />· 沟通员直答 session 的只读工具白名单 —— 硬编码在 kernel/agentKernel.ts:965
              <br />· 规划者 / 执行者的输出上限 —— 硬编码常量 PLANNER_EXECUTOR_MAX_TOKENS = 8192
              (ws.ts:76/204,批次 7-A)
              <br />
              两处都与上面的 config 无关,改这三个数字不会影响任何行为。
            </div>
            <div className="sansheng-text-mute">
              这不是页面的欠债,而是 harness 自身的设计未完成(产品设计 §6.1 已确认)。
              等 harness 有磁盘格式 + 按 agent 化 + budget 至少落一个执行点,它们才会变成真配置;
              在那之前,如实标「仅声明未强制」,不假装即将生效。
            </div>
          </div>
        </section>

        {/* ── ④ Proposals / Previews:空就是空,并写清为什么 ── */}
        <section className="sansheng-card p-4">
          <h3 className="font-medium mb-1">自我改进提案 · 实现预览</h3>
          {proposals.length === 0 && previews.length === 0 ? (
            <>
              <p className="text-sm opacity-80" style={{ lineHeight: 1.7 }}>
                当前没有任何 harness_proposal / implementation_preview 工件(proposals{" "}
                {proposals.length} · previews {previews.length})。
              </p>
              <div className="sansheng-text-mute mt-2" style={{ fontSize: 11, lineHeight: 1.8 }}>
                原因是<Em>结构性的</Em>,不是还没跑到:manager 只对 kind === "harness_proposal" 且
                status === "open" 的工件反应(harnessManager.ts:234),而执行者阻塞时恒产出
                kind === "hypothesis" 的工件(executor.ts:346),哪怕 callbackReason 写的正是
                "harness_proposal"(executor.ts:343 同时写进顶层和 metadata)。
                全仓没有任何代码把这两类工件互相转换 → 触发条件永不满足。
                修法很小,但不在本批范围。<Em>这里不放任何示例条目。</Em>
              </div>
            </>
          ) : (
            <div className="grid gap-2">
              {[...proposals, ...previews].map((a) => (
                <div key={a.id} className="rounded p-2" style={{ background: "var(--ink-1)" }}>
                  <div className="font-mono sansheng-text-mute" style={{ fontSize: 10 }}>
                    {a.kind} · {a.author} · {a.status} · {new Date(a.createdAt).toLocaleString()}
                  </div>
                  <div className="text-sm" style={{ color: "var(--bone)" }}>
                    {a.title}
                  </div>
                  {a.body && (
                    <div className="text-xs mt-1" style={{ color: "var(--bone-dim)", whiteSpace: "pre-wrap" }}>
                      {a.body}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── ⑤ Manager 运行态 ── */}
        <section className="sansheng-card p-4">
          <h3 className="font-medium mb-2">
            harness_manager 运行态
          </h3>
          <div className="sansheng-text-mute mb-2" style={{ fontSize: 11, lineHeight: 1.7 }}>
            启动于 {manager.startedAt ? new Date(manager.startedAt).toLocaleString() : "—"} ·
            计数为<Em>内存态,重启清零</Em>(manager 自身无持久化);只有 proposals / previews
            会落 blackboard storage(scope=global)。
          </div>
          {manager.stats ? (
            <div className="flex flex-wrap gap-1.5">
              {STAT_LABEL.map(({ key, label }) => (
                <span
                  key={key}
                  className="font-mono rounded"
                  style={{
                    fontSize: 10,
                    padding: "2px 7px",
                    background: "var(--ink-2)",
                    color: key === "failed" && (manager.stats?.[key] ?? 0) > 0
                      ? "var(--cinnabar)"
                      : "var(--bone-dim)",
                  }}
                >
                  {label} {manager.stats?.[key] ?? 0}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-sm opacity-70">manager 未启动(无 stats)。</p>
          )}
        </section>

        {/* ── ⑥ Notes —— server 如实交代的语义边界 ── */}
        <section className="sansheng-card p-4">
          <h3 className="font-medium mb-2">Notes</h3>
          {notes.length > 0 ? (
            <ul className="grid gap-1">
              {notes.map((n) => (
                <li key={n} className="sansheng-text-mute" style={{ fontSize: 11, lineHeight: 1.7 }}>
                  · {n}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm opacity-70">server 未返回说明。</p>
          )}
        </section>
      </div>
    </main>
  );
}
