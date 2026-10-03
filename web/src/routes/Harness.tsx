/**
 * Sansheng · Harness 页(批次 UI U1 → 产品设计 §6「每个 agent 的雇员手册」;批次 UI U4 收敛)
 *
 * 页面定位(docs/PRODUCT-DESIGN-2026-10-02.md §6):Harness **不是一张全局只读报表**,
 * 而是**每个 agent 的雇员手册** —— 一页说清「谁在跑 / 他读的是哪份手册 / 那份手册现在
 * 真的生效了吗 / 改完什么时候生效」。三档「生效状态」徽章是本页的核心价值:
 * 诚实告诉用户「planner 有一份 3766 字节的手册在生效;harness_manager 压根没有文件,
 * 用的是编译进代码的那份」。诚实 > 好看。
 *
 * ── U4 收敛:这一版把「开发者自述」从页面上撤走,搬进本注释 ────────────────
 * 改之前这页把**写给维护者的说明整段贴在页面上**:每张 agent 卡后面跟着四块带
 * `src/file.ts:123` 行号依据的说明,外加一张把同样的话说第二遍的「手册改动后何时生效」
 * 表(4 行,其中 3 行与卡片重复)。那些句子本身没错,问题是读者要读的字数比产品本身多三倍。
 * 收敛后的规则:
 *   · **结论留在屏幕上**(「改代码后需重启」「proposals 0 · previews 0」);
 *   · **「为什么这么算」进 `title=`**(悬停)或 `<Disclosure>`(点开);
 *   · **「为什么这个系统长成这样」回到本文件头**。以下四件事属于这一类,页面上
 *     不再重复,但一条都没丢:
 *     1. 「生效时机」描述的是**系统事实**(磁盘上的 prompt 改了,代码什么时候重新读到),
 *        不是 UI 自己编的一句「保存即生效」。没有这条信息,改了 prompt 发现没反应
 *        会被直接判定成产品坏了;现在每张卡的「改动生效」行仍然给出结论,依据在该行
 *        的 `title=` 里。
 *        ⚠️ 批次 7-O 之后这句话**多了一层**:写入成功 ≠ 当场生效 —— 沟通员的 Pi
 *        session 被 kernel 缓存,要 invalidate() 才读得到新值,而 invalidate() 会 abort
 *        在飞回合。所以编辑器上「写完立即重建会话」默认**不勾**,由用户自己决定。
 *        (HarnessManager v0 仍是只读 preview 生成器,D15 —— 它的写面不走本节接口,
 *        也不在本页出现。)
 *     2. proposals / previews 为什么**结构上**永远是空的(见下面 §反造假第 1 条);
 *        页面只留一句「暂无提案与实现预览(proposals 0 · previews 0)」。
 *     3. 配置两项为什么标「仅声明未强制」、以及**系统里真实存在的约束在哪**:
 *        沟通员的只读工具 allowlist(kernel → createAgentSession({ tools }))与
 *        `PLANNER_EXECUTOR_MAX_TOKENS = 8192`(ws.ts,批次 7-A)。改页面上的
 *        redLines / budget 数字不会影响任何行为。
 *     4. 徽章三档的字面解释:生效中 = 真被读取并注入模型;硬编码兜底 = 没有自己的文件、
 *        用编译进代码的常量;仅声明未强制 = 展示了但代码里没有任何执行点。这三句现在
 *        是三个徽章各自的 `title=`,页面上只留徽章本身。
 *
 * ── 批次 7-O:本页多了一面 —— 写面(编辑入口,不改动只读视图)───────────────
 *   本页从此**不再是纯只读页**,但只读视图本身一行没改:手册卡 / 工具集合 / 配置 /
 *   notes / 三档徽章仍是同一份 `GET /api/harness` 渲染出来的。编辑是**叠加**在其上
 *   的入口,收起时页面上一个多余的像素都没有。
 *
 *   入口与端点(实现见 components/harness/*,后端见 src/server/http/harnessRoutes.ts):
 *     手册卡 → 「编辑手册」→ components/harness/PromptEditor.tsx
 *       GET  /api/harness/facets/prompts/entries/:id        点开才拉,总表不带全文
 *       PUT  /api/harness/facets/prompts/entries/:id        { content, invalidate? }
 *     工具集合行 → 「编辑」→ components/harness/ToolsEditor.tsx
 *       GET  /api/harness/facets/tools/entries/:id
 *       PUT  /api/harness/facets/tools/entries/:id          { allow, deny, invalidate? }
 *     两者共用 POST /api/harness/facets/:facet/entries/:id/reset { confirm: "reset" }
 *
 *   四条不能省的纪律:
 *     1. **失败原样上屏**。后端 message 里已经说了人话(哪些工具名不认识 / 超限多少
 *        字符 / 角色不在注册表内),前端不翻译不截断(见 facetClient.FacetApiError)。
 *     2. **报成功 = 报真话**。changed=false 就说「未写盘」;backupPath / warnings
 *        一个不折;enforced=false 的条目照写「改了不会有任何效果」。
 *     3. **上界外的工具画不成能勾的框**。inCeiling=false 的复选框 disabled + 名字
 *        划线 + 一句「勾了也不会生效」—— 架构裁决不能被一个 UI 控件稀释掉。
 *     4. **deny 原样回传**。本 UI 不编辑 deny,但绝不在保存时把它吞掉(吞掉等于
 *        保存一次就清空用户的拒绝名单)。
 *
 * ── 数据源:读面唯一 `GET /api/harness`(src/server/http.ts;写面在上面三条路由)──
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
 *   toolSets  : Array<{ role, allow[], deny[], allowed[], blockedByCeiling[],
 *                      enforced, enforceBasis, source:"factory"|"user", warnings[] }>
 *              —— **批次 7-C 新增,真配置**:per-agent 工具集合,来自
 *              ~/.sansheng/harness/tools/{role}.json(src/server/harness/tools.ts)。
 *              `allowed` 是真正交给 SDK 的名单;`blockedByCeiling` 是集合里写了
 *              但被架构上界拒绝的;`enforced:false` = 该角色没有工具执行点,
 *              集合「已就位、未接线」。取代了已删除的 config.enabledTools。
 *   config   : { redLines[], budget{maxIterations,perStepTimeoutMs,maxCostUsd} }
 *              —— 两个字段仍是 harness/loader.ts 的**硬编码字面量**:无磁盘来源、
 *              无消费者、从不强制执行。页面上统一标「仅声明未强制」。
 *   proposals / previews : BlackboardArtifact[] —— 真实读 blackboard storage(scope=global)。
 *   notes    : string[] —— server 如实交代语义边界,原样展示(超过 2 条时默认收起)。
 *
 * ── 反造假纪律(本项目最强的一条,本项目尤其重要)────────────────────────────
 *   1. **不造示例条目**:proposals / previews 没有就是空态。空的原因是**结构性的**,
 *      不是「还没跑到」:manager 只对 kind==="harness_proposal" 且 status==="open"
 *      的工件反应(harnessManager.ts:234),而执行者阻塞时恒产出 kind==="hypothesis"
 *      的工件(executor.ts:346),哪怕 callbackReason 写的正是 "harness_proposal"
 *      (executor.ts:343 同时写进顶层和 metadata);全仓没有任何代码把这两类工件互相
 *      转换 → 触发条件永不满足。修法很小,但不在本批范围。**这里不放任何示例条目。**
 *   2. **不假装配置在生效**:工具集合一栏只展示 API 返回的 `allowed` 并标明
 *      `enforced`(7-C 起 communicator 是生效中,planner / executor 是「已就位、
 *      未接线」—— 它们走 completeSimple 单轮补全,没有工具循环);redLines / budget
 *      仍一律标「仅声明未强制」。集合被上界拒绝的条目要显式画出来(划线 pill),
 *      不让用户以为「我写进去就生效了」。
 *   3. **不承诺本页没有的功能**:见上面 §2(写面)。7-O 之后本页**能写**的只有
 *        prompts / tools 两个面,而且写出去的是磁盘上的配置,不是「运行中的行为」——
 *        「生效中」永远由 enforced / ROLE_CEILING / invalidate 三件事共同决定。
 *        编辑器面板上三行事实(生效时机 / contract 风险 / 零消费方)常驻,就是为了
 *        不让「保存成功」被读成「已经生效」。
 *   4. **徽章由数据推导,不是写死**:state==="empty" → 实际回退的是模块内置 stub
 *      (planner.ts:176 / executor.ts:124)或 SDK 默认,那就标「硬编码兜底」而不是
 *      「生效中」;prompt 摘要缺失时**不给档位**(无从判定就不猜)。
 *   5. **每个数字都来自本次真实 payload**:行数 / 字符数来自 prompts,预算来自 config,
 *      计数来自 manager.stats,工具集合条数来自 toolSets.length,proposals / previews
 *      的计数来自两个数组的 length。空数组渲染诚实空态,不写示例条目。
 *
 * 视觉:沿用既有骨架(`.ss-page` / `sansheng-card` / `sansheng-card-elevated` /
 * `--ink-*` / `--bone*` / `--jade` / `--amber`),不引入新配色、不引新依赖;
 * 展示层构件全部来自 components/ui/primitives.tsx。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Clamp,
  Disclosure,
  EmptyState,
  Flag,
  KV,
  PageHeader,
  Pill,
  Section,
  StatStrip,
  type Tone,
} from "@/components/ui/primitives";
import { PromptEditor } from "@/components/harness/PromptEditor";
import { ToolsEditor } from "@/components/harness/ToolsEditor";

interface HarnessPromptInfo {
  role: string;
  owner: string;
  lines: number;
  chars: number;
  /** 批次 7-G 新增 orphan —— 零消费方,与 empty(有消费方但文件空)是两件事 */
  state: "default" | "legacy_factory" | "user_edited" | "empty" | "orphan";
  enforced: boolean;
  consumer: string;
  apply: string;
  sensitivity: string;
  orphanReason?: string;
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

/**
 * 批次 7-C:per-agent 工具集合(GET /api/harness 的 toolSets 字段)。
 * 字段语义以 src/server/harness/tools.ts 为准,这里只镜像前端要用的部分。
 */
interface HarnessToolSetInfo {
  role: string;
  allow: string[];
  deny: string[];
  /** 真正交给 SDK 的名单 = allow − deny − 架构上界之外 */
  allowed: string[];
  /** allow 里被架构上界拒绝的 —— 提权失败必须画出来,不能静默 */
  blockedByCeiling: string[];
  /** 该角色当前有没有工具执行点;false = 集合已就位但没人应用 */
  enforced: boolean;
  enforceBasis: string;
  source: "factory" | "user";
  warnings: string[];
}

interface HarnessResponse {
  manager: {
    running: boolean;
    stats: HarnessStats | null;
    decideSource: "production-llm" | "injected" | null;
    startedAt: number | null;
  };
  prompts: HarnessPromptInfo[];
  toolSets: HarnessToolSetInfo[];
  harnessManagerPrompt: { source: string; lines: number; editable: boolean; note: string };
  config: {
    redLines: string[];
    budget: { maxIterations: number; perStepTimeoutMs: number; maxCostUsd: number };
  };
  proposals: HarnessArtifact[];
  previews: HarnessArtifact[];
  notes: string[];
}

/* ── 手册覆盖范围 ──────────────────────────────────────────────────────────
 * API 仍返回 6 个角色的 prompt 摘要;critic / memory / reflection 没有实现、
 * 其 md 文件无任何读取方(产品设计 §1),本页**不列为手册卡**。
 * 不列,是因为「永远点不亮的灰行是噪声,不如不列」——不是把它们标成某种状态,
 * 而是整条移除。(它们仍然出现在下方「工具集合」一节:那节按 API 原样列出全部
 *  toolSets,是真配置视图,不是手册视图。) */

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
const TIER_TONE: Record<EffectTier, Tone> = {
  live: "jade",
  builtin: "bone",
  declared: "amber",
};

const TIER_HINT: Record<EffectTier, string> = {
  live: "真被读取并注入模型",
  builtin: "没有自己的文件,用的是编译进代码的常量",
  declared: "展示了,但代码里没有任何执行点",
};

function EffectBadge({ tier, title }: { tier: EffectTier; title?: string }) {
  return (
    <Pill tone={TIER_TONE[tier]} title={title ?? TIER_HINT[tier]}>
      {TIER_LABEL[tier]}
    </Pill>
  );
}

/* ── prompt 状态(复用既有 STATE_LABEL / STATE_TONE 语义,加一层安全取值)─── */

const STATE_LABEL: Record<string, string> = {
  default: "默认",
  legacy_factory: "旧出厂版",
  user_edited: "用户编辑过",
  empty: "空",
  // 批次 7-G:orphan = 零消费方。它与 empty 是两件完全不同的事 ——
  // empty 有消费方(正在用内置常量兜底),orphan 改了文件不会有任何效果。
  // 7-G 之前 orphan 被报成 default,让三份没人读的文件看起来像生效中的配置。
  orphan: "无消费方",
};

const STATE_TONE: Record<string, Tone> = {
  default: "bone",
  legacy_factory: "mute",
  user_edited: "jade",
  empty: "ochre",
  orphan: "ochre",
};

const STATE_HINT: Record<string, string> = {
  default: "等于当前出厂默认",
  user_edited: "用户编辑过 · ensureHarness 永不覆盖",
  legacy_factory: "出厂旧版 · 下次启动会被 ensureHarness 自动升级为当前默认",
  empty: "无文件/空文件 · 不注入 harness prompt,回退内置 stub 或 SDK 默认",
  orphan: "**没有任何读取方** —— 改这个文件不会影响任何行为。它只是历史遗留。",
};

function StatePill({ state }: { state: string }) {
  return (
    <Pill tone={STATE_TONE[state] ?? "bone"} title={STATE_HINT[state] ?? `未知状态:${state}`}>
      {STATE_LABEL[state] ?? "未知"}
    </Pill>
  );
}

/**
 * 批次 7-C:工具名单的渲染件。**名单不写死在前端** —— 全部来自 API 的 toolSets。
 * 三种视觉状态,对应解析器的三条分支:
 *   玉色(allowed)         = 真正交给 SDK 的工具
 *   琥珀划线(blocked)     = 用户在集合文件里写了、被架构上界拒绝的 —— 必须画出来
 *   空(allowed 为空)      = 该角色无工具面
 */
function ToolChips({ set }: { set: HarnessToolSetInfo | undefined }) {
  if (!set) {
    return <span className="ss-note">API 未返回该角色的工具集合</span>;
  }
  if (set.allowed.length === 0 && set.blockedByCeiling.length === 0) {
    return <span className="ss-note">无(集合 allow 为空)</span>;
  }
  return (
    <>
      {set.allowed.map((t) => (
        <Pill key={`ok-${t}`} tone="jade" title="已生效:写进 createAgentSession({ tools })">
          {t}
        </Pill>
      ))}
      {set.blockedByCeiling.map((t) => (
        <Pill
          key={`blocked-${t}`}
          tone="amber"
          title="被架构上界拒绝:集合文件突破不了 ROLE_CEILING,放开它要改代码"
        >
          <s>{t}</s>
        </Pill>
      ))}
    </>
  );
}

/* ── 每个 agent 的档案 ───────────────────────────────────────────────────── */

interface ManualMeta {
  role: ManualRole;
  title: string;
  /** 角色职责 —— 写的是这个 agent 在系统里实际干的事,不是职责说明书 */
  duty: string;
  /** 它的 system prompt 在哪里被读取并注入(徽章判定依据)→ 提示词行的 title= */
  injectBasis: string;
  /** 工具面补充说明 → 工具行的 title=。**工具名单本身不写在这里** —— 7-C 起由 API 的 toolSets 驱动 */
  toolsNote: string;
  /** 文件被改动后,系统什么时候读到(结论上屏) */
  apply: string;
  /** apply 的代码依据 → 改动生效行的 title= */
  applyBasis: string;
}

const MANUAL_META: readonly ManualMeta[] = [
  {
    role: "communicator",
    title: "沟通员",
    duty:
      "用户唯一的对话入口。接住消息后 decide 成 chat / task / clarify / feedback;把对话沉淀成 intent 等结构化工件;worker 升级上来的求助与总线提问也经它转述给用户。由 Pi SDK session 驱动,自己不直接调 LLM。",
    injectBasis: "kernel/agentKernel.ts 每次重建 session 时读盘注入",
    toolsNote:
      "工具集合文件 ~/.sansheng/harness/tools/communicator.json,是全系统唯一真被 enforce 的工具面(kernel → createAgentSession({ tools }))。写与执行类工具被 tools.ts 的架构上界挡住,集合文件突破不了。",
    // 原「生效时机」表的第 2、3 行(两条注入路径)合并成这一句
    apply: "下一次 start / resume / reset;Communicator 实例需 kernel.invalidate()",
    applyBasis:
      "agentKernel.ts:createPiSession 每次建 session 重新 loadHarness;实例被 memoize,构造时读一次",
  },
  {
    role: "planner",
    title: "规划者",
    duty:
      "把一个 intent 拆成 todo DAG(带 dependsOn / parentIntent),planner 产出的每个 todo 就是执行者的一份工单。",
    injectBasis: "agents/orchestrator.ts 构造时读一次盘",
    toolsNote:
      "工具集合文件已就位(tools/planner.json),但 enforced=false:走 ws.ts 的 makeLlmCall → completeSimple 单轮补全,没有工具循环,集合写了也无处应用。",
    apply: "下一次 plan 运行时 —— 不用重启",
    applyBasis: "orchestrator.ts 构造时读一次;每次 run_plan 新建实例(ws.ts)",
  },
  {
    role: "executor",
    title: "执行者",
    duty:
      "领 todo 干活,产出 evidence / decision;干不动时升级成 hypothesis(status=waiting_for_decision)等人拍板;失败沿 dependsOn 向下级联。它的 system prompt 明确建立在「没有工具能力」之上。",
    injectBasis: "agents/orchestrator.ts 构造时读一次盘",
    toolsNote:
      "同 planner:集合文件已就位(tools/executor.json)但 enforced=false,产出靠模型领域知识 + JSON 协议,不是工具调用。",
    apply: "下一次 plan 运行时 —— 不用重启",
    applyBasis: "orchestrator.ts 构造时读一次;每次 run_plan 新建实例(ws.ts)",
  },
];

/** harness_manager 的档案内容随 API 字段变(source / editable),所以单列。 */
const MANAGER_META = {
  role: "harness_manager",
  title: "工装顾问",
  duty:
    "订阅 artifact_created,对 kind=harness_proposal 且 status=open 的工件生成只读的实现预览(绝不写文件;v0 无 apply 语义,D15)。",
  toolsNote:
    "工具集合文件 tools/harness_manager.json 已就位但 enforced=false(decideFn 走 completeSimple 单轮补全),也不允许写盘。页眉右侧的 decideSource 说明它的判断来自 production-llm 还是注入。",
  apply: "需要改代码 —— 它没有 md 文件",
  applyBasis: "agents/harnessManager.ts 的 FALLBACK_HARNESS_PROMPT 编译进代码",
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

const EMPTY_PROMPT_HINT = "无文件 / 空文件 · 不注入 harness prompt,回退内置 stub 或 SDK 默认";

/** 手册卡的渲染模型:4 个角色共用一份骨架,差异全部在这里声明。 */
interface CardModel {
  key: string;
  title: string;
  role: string;
  /** null = API 没给这个角色的摘要,无从判定就不给档位 */
  tier: EffectTier | null;
  duty: string;
  /** 提示词行:真实数字 + 状态 pill */
  promptLine: ReactNode;
  promptTitle: string;
  toolSet: HarnessToolSetInfo | undefined;
  toolsTitle: string;
  apply: string;
  applyTitle: string;
  /** 批次 7-O:叠加在只读卡上的编辑入口(不展开时页面上不存在) */
  editor?: ReactNode;
}

function ManualCard({ card }: { card: CardModel }) {
  return (
    <article className="sansheng-card-elevated p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1.5 min-w-0">
          <span className="text-sm" style={{ color: "var(--bone)" }}>
            {card.title}
          </span>
          <span className="ss-meta truncate" title={card.role}>
            {card.role}
          </span>
        </div>
        {card.tier ? <EffectBadge tier={card.tier} /> : <span className="ss-note">摘要缺失</span>}
      </div>

      <div className="mt-1.5">
        <Clamp lines={2}>{card.duty}</Clamp>
        <Disclosure summary="职责全文">{card.duty}</Disclosure>
      </div>

      <div className="mt-2 grid gap-0.5">
        <KV
          label="提示词"
          value={
            <span className="flex items-center gap-1.5 flex-wrap" title={card.promptTitle}>
              {card.promptLine}
            </span>
          }
        />
        <KV
          label="工具"
          value={
            <span className="flex items-center gap-1.5 flex-wrap" title={card.toolsTitle}>
              {card.toolSet ? (
                <EffectBadge tier={card.toolSet.enforced ? "live" : "declared"} />
              ) : null}
              <ToolChips set={card.toolSet} />
            </span>
          }
        />
        <KV label="改动生效" value={<span title={card.applyTitle}>{card.apply}</span>} />
      </div>

      {/* 批次 7-O:编辑入口叠加在只读卡之下,收起时不渲染任何东西。 */}
      {card.editor}
    </article>
  );
}

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

  // 批次 7-O:写成功后的整页刷新。两个编辑器共用这一个回调 —— 写完必须重拉
  // GET /api/harness,否则卡片上的 state pill / 划线 pill 会停在写之前的样子,
  // 用户会以为「保存了但没生效」。用 useCallback 固定住引用,免得每次渲染都
  // 把编辑器里的编辑态冲掉。
  const refresh = useCallback(() => {
    void load();
  }, [load]);

  if (error) {
    return (
      <div className="ss-page">
        <PageHeader title="Harness" />
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="ss-page">
        <PageHeader title="Harness" />
        <div className="sansheng-card p-4 text-sm opacity-70">{loading ? "加载中…" : "—"}</div>
      </div>
    );
  }

  const { manager, prompts, toolSets, config, proposals, previews, notes, harnessManagerPrompt } =
    data;

  // 只保留手册覆盖的 3 个文件型角色;另外 3 个角色是死文件,不进手册卡。
  const promptByRole = new Map<string, HarnessPromptInfo>();
  for (const p of prompts) {
    if (isManualRole(p.role)) promptByRole.set(p.role, p);
  }

  // 批次 7-C:工具集合同样只按 role 取,**不写死任何工具名**。
  // 名单、被上界拒绝的条目、生效状态全部来自 API 的 toolSets 字段。
  const toolSetByRole = new Map<string, HarnessToolSetInfo>();
  for (const t of toolSets) toolSetByRole.set(t.role, t);

  // 徽章由数据推导:state==="empty" 时真正被注入的是模块内置 stub / SDK 默认,
  // 不是磁盘文件 → 那一档必须如实降级成「硬编码兜底」,不能一律标绿。
  const tierOf = (info: HarnessPromptInfo | undefined): EffectTier =>
    !info || info.state === "empty" ? "builtin" : "live";

  const managerTier: EffectTier =
    harnessManagerPrompt.source === "builtin_fallback" || harnessManagerPrompt.editable === false
      ? "builtin"
      : "live";

  const managerToolSet = toolSetByRole.get(MANAGER_META.role);

  const cards: CardModel[] = [
    ...MANUAL_META.map((meta): CardModel => {
      const info = promptByRole.get(meta.role);
      const toolSet = toolSetByRole.get(meta.role);
      return {
        key: meta.role,
        title: meta.title,
        role: meta.role,
        tier: info ? tierOf(info) : null,
        duty: meta.duty,
        promptLine: info ? (
          <>
            <span style={{ color: "var(--bone-dim)" }}>
              {info.lines} 行 · {info.chars} 字符
            </span>
            <StatePill state={info.state} />
          </>
        ) : (
          <span className="ss-note">API 未返回该角色的 prompt 摘要</span>
        ),
        promptTitle:
          `注入点:${meta.injectBasis}` + (info?.state === "empty" ? ` · ${EMPTY_PROMPT_HINT}` : ""),
        toolSet,
        toolsTitle:
          meta.toolsNote + (toolSet && !toolSet.enforced ? ` · 未接线:${toolSet.enforceBasis}` : ""),
        apply: meta.apply,
        applyTitle: `依据:${meta.applyBasis}`,
        // 批次 7-O:每张手册卡一个提示词编辑入口。unitId 就是 role ——
        // prompts 面的条目 id 即 PROMPT_UNITS 里的单元 id(后端注册表,不是前端编的)。
        editor: <PromptEditor unitId={meta.role} onSaved={refresh} />,
      };
    }),
    {
      key: MANAGER_META.role,
      title: MANAGER_META.title,
      role: MANAGER_META.role,
      tier: managerTier,
      duty: MANAGER_META.duty,
      promptLine: (
        <>
          <span style={{ color: "var(--bone-dim)" }}>{harnessManagerPrompt.lines} 行</span>
          <Pill tone="bone" title={harnessManagerPrompt.note}>
            {harnessManagerPrompt.editable ? "可编辑" : "不可编辑"}
          </Pill>
        </>
      ),
      promptTitle: `来源:${harnessManagerPrompt.source} · ${harnessManagerPrompt.note}`,
      toolSet: managerToolSet,
      toolsTitle:
        MANAGER_META.toolsNote +
        (managerToolSet && !managerToolSet.enforced
          ? ` · 未接线:${managerToolSet.enforceBasis}`
          : ""),
      apply: MANAGER_META.apply,
      applyTitle: `依据:${MANAGER_META.applyBasis}`,
      // 工装顾问的 system prompt 也是真的受管单元(7-G 起 system_prompts/harness_manager.md
      // 进了版本链),所以同样给编辑入口;它「不可编辑」的那部分是 HarnessManager 自己的
      // 实现预览(v0 只读),不是这份手册。
      editor: <PromptEditor unitId={MANAGER_META.role} onSaved={refresh} />,
    },
  ];

  const stats = manager.stats;
  const statItems: Array<{ label: string; value: number; tone: Tone }> = stats
    ? STAT_LABEL.map(({ key, label }) => ({
        label,
        value: stats[key],
        tone: key === "failed" && stats[key] > 0 ? "cinnabar" : "bone",
      }))
    : [];

  const artifactCount = proposals.length + previews.length;

  return (
    <div className="ss-page">
      <PageHeader
        title="Harness"
        hint="每个 agent 读的是哪份手册 · 真的生效了吗 · 7-O 起可原地编辑"
        hintTitle="徽章只陈述代码里的事实。7-O 起本页可编辑提示词与工具集合:写的是磁盘配置,「生效中」仍由 enforced / 上界 / 是否 invalidate 共同决定。"
        aside={
          <>
            <Pill tone={manager.running ? "jade" : "mute"}>
              {manager.running ? "运行中" : "未运行"}
            </Pill>
            <span className="ss-meta">{manager.decideSource ?? "—"}</span>
          </>
        }
      />

      {/* ── 雇员手册:每个 agent 一张卡 ── */}
      <Section
        title="Agent 雇员手册"
        hint="徽章 = 这份手册现在真的生效吗"
        aside={
          <>
            <EffectBadge tier="live" />
            <EffectBadge tier="builtin" />
            <EffectBadge tier="declared" />
          </>
        }
      >
        <div className="grid gap-3 md:grid-cols-2">
          {cards.map((card) => (
            <ManualCard key={card.key} card={card} />
          ))}
        </div>
      </Section>

      {/* ── 工具集合(批次 7-C):真配置,逐角色如实标 ── */}
      <Section
        title="工具集合"
        count={toolSets.length}
        hint="玉色 = 真正交给 SDK · 琥珀划线 = 被架构上界拒绝"
        aside={
          <>
            <EffectBadge tier="live" title="集合已生效:真正交给 SDK" />
            <EffectBadge tier="declared" title="集合已就位,但该角色没有工具执行点" />
          </>
        }
      >
        <div className="sansheng-card p-3 grid gap-1.5">
          {toolSets.length === 0 ? (
            <EmptyState>server 未返回任何角色的工具集合。</EmptyState>
          ) : (
            toolSets.map((t, i) => (
              // 批次 7-O:外层多包一层 grid,让展开后的勾选矩阵占满整行 ——
              // 编辑器是块级面板,塞在 flex 行里会被挤成一条。
              <div key={t.role} className="grid gap-1">
                <div
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 py-1"
                  style={i > 0 ? { borderTop: "1px solid var(--ink-3)" } : undefined}
                >
                  <span className="ss-meta" style={{ minWidth: 104 }}>
                    {t.role}
                  </span>
                  <Pill
                    tone={t.source === "factory" ? "mute" : "cyan"}
                    title={
                      t.source === "factory"
                        ? "集合文件内容等于当前出厂默认,升级时会安全覆盖"
                        : "用户手笔:ensure 不会覆盖,新出厂默认需手动合并"
                    }
                  >
                    {t.source === "factory" ? "出厂默认" : "用户手笔"}
                  </Pill>
                  <EffectBadge tier={t.enforced ? "live" : "declared"} title={t.enforceBasis} />
                  <span className="flex flex-wrap items-center gap-1.5">
                    <ToolChips set={t} />
                  </span>
                  {t.warnings.map((w) => (
                    <Flag key={w} tone="amber">
                      <span className="ss-note">{w}</span>
                    </Flag>
                  ))}
                </div>
                {/* 编辑器放在行外:它是块级面板,塞进 flex 行会被挤成一条。 */}
                <ToolsEditor role={t.role} onSaved={refresh} />
              </div>
            ))
          )}
        </div>
      </Section>

      {/* ── 配置:剩下的两项仍是硬编码字面量(产品设计 §6 ① / §6.1)── */}
      <Section
        title="配置"
        aside={<EffectBadge tier="declared" />}
        hint="硬编码字面量 · 无磁盘来源 · 无消费者"
      >
        <div className="sansheng-card p-3 grid gap-0.5">
          <KV
            label="redLines"
            value={
              config.redLines.length > 0 ? (
                config.redLines.map((r) => (
                  <Pill key={r} tone="amber" title="仅声明未强制 · 改它不影响任何行为">
                    {r}
                  </Pill>
                ))
              ) : (
                <span className="ss-note">无</span>
              )
            }
          />
          <KV
            label="budget"
            title="loader.ts 之外全项目零引用"
            value={
              <span className="ss-meta" style={{ color: "var(--bone-dim)" }}>
                迭代 {config.budget.maxIterations} · 单步 {config.budget.perStepTimeoutMs}ms · 上限 $
                {config.budget.maxCostUsd}
              </span>
            }
          />
          <div className="mt-1">
            <Disclosure summary="为什么标「仅声明未强制」">
              redLines / budget 仍是 harness/loader.ts 的硬编码字面量:没有磁盘来源、没有消费者、
              从不强制执行(enabledTools 已在批次 7-C 删除,由「工具集合」取代)。系统里真实存在、但与
              这两项无关的约束是沟通员的只读工具 allowlist 与 PLANNER_EXECUTOR_MAX_TOKENS = 8192
              (ws.ts,批次 7-A)—— 改上面这两个数字不会影响任何行为。
            </Disclosure>
          </div>
        </div>
      </Section>

      {/* ── Proposals / Previews:空就是空,不造示例 ── */}
      <Section title="自我改进提案 · 实现预览" count={artifactCount}>
        {artifactCount === 0 ? (
          <EmptyState>
            暂无提案与实现预览(proposals {proposals.length} · previews {previews.length})。
          </EmptyState>
        ) : (
          <div className="grid gap-2">
            {[...proposals, ...previews].map((a) => (
              <div key={a.id} className="sansheng-card p-2">
                <div className="ss-meta">
                  {a.kind} · {a.author} · {a.status} · {new Date(a.createdAt).toLocaleString()}
                </div>
                <div className="ss-body" style={{ color: "var(--bone)" }}>
                  {a.title}
                </div>
                {a.body ? <Clamp lines={3}>{a.body}</Clamp> : null}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* ── Manager 运行态 ── */}
      <Section
        title="harness_manager 运行态"
        hint={manager.startedAt ? `启动于 ${new Date(manager.startedAt).toLocaleString()}` : undefined}
      >
        {stats ? (
          <>
            <StatStrip items={statItems} />
            <div className="mt-1">
              <Disclosure summary="计数口径">
                计数为内存态、重启清零(manager 自身无持久化);只有 proposals / previews 会落
                blackboard storage(scope=global)。
              </Disclosure>
            </div>
          </>
        ) : (
          <EmptyState>manager 未启动(无 stats)。</EmptyState>
        )}
      </Section>

      {/* ── Notes —— server 如实交代的语义边界,超过 2 条默认收起 ── */}
      {notes.length > 0 ? (
        <Section title="Notes" count={notes.length}>
          {notes.length > 2 ? (
            <Disclosure summary={`展开 ${notes.length} 条说明`}>
              <ul className="grid gap-1">
                {notes.map((n) => (
                  <li key={n}>· {n}</li>
                ))}
              </ul>
            </Disclosure>
          ) : (
            <ul className="ss-note grid gap-1">
              {notes.map((n) => (
                <li key={n}>· {n}</li>
              ))}
            </ul>
          )}
        </Section>
      ) : null}
    </div>
  );
}
