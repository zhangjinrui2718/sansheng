/**
 * 词汇表 —— 全站**唯一一份**「这个数字是怎么算出来的」
 *
 * ── 它取代的是什么 ────────────────────────────────────────────────
 *
 * 2026-10-26 复核实测:页面级注解 131 处,其中 19 条 `hintTitle` 共 **2465 字**
 * 悬停正文;而 19 条里 **12 条是「数据来源:GET …」** —— 那不是注解,是**出处**。
 * 出处属于一张表,不属于 19 个悬停。同一个错还被抄过两遍:
 * `routes/Members.tsx:1010` 与 `:1022` 是**逐字相同**的 133 字。
 *
 * ── 三条纪律 ──────────────────────────────────────────────────────
 *
 *  1. **一条一行话**(`line` ≤ 24 字),摆在 `?` 里;`basis`(判据落在哪个文件/符号)
 *     与 `source`(哪个端点 / 哪张表)是**证据**,不是给读者背的。
 *  2. **这里只装「解释」,不装「命名」。** 角色中文名只有一处(`ORG`),前端兜底
 *     是 `lib/vocab.ts` 的 `ROLE_LABEL`(由 `tests/web/role-names.test.ts` 逐字对照)。
 *     在词汇表里再写一张名字表 = 造第二个真相源。
 *  3. **每条都必须有读者**:`tests/web/annotation-budget.test.ts` 会断言每个 id
 *     都在某个 `helpId=` 上被用到。声明了没人用的条目 = 本项目的 7-E 复发。
 *
 * ⚠️ **`line` 是给人看的一句话,不是判据本身。** 判据永远在 `basis` 指向的那个
 * 函数里 —— 改判据要改代码,不要指望改这里。
 */

/** 词汇表 id —— 闭合联合,新增一项就要同时在某个页面上给它一个读者。 */
export type GlossaryId =
  | "notice.stop"
  | "notice.compliance"
  | "notice.other"
  | "client-question"
  | "ask"
  | "change"
  | "blocker"
  | "work.status"
  | "memory.sections"
  | "artifact.no-work"
  | "artifact.dangling"
  | "timeline"
  | "usage.cost"
  | "workspace.read"
  | "artifact.graph"
  | "work.deps"
  | "knowledge.corpus"
  | "harness.card";

export interface GlossaryEntry {
  /** 一句话(≤ 24 字)—— 页面上唯一可见的那部分。 */
  line: string;
  /** 判据落在哪:文件 / 符号。**可 grep、可点开看。** */
  basis: string;
  /** 数据从哪来:端点 / 表 / 契约字段。 */
  source: string;
}

export const GLOSSARY: Record<GlossaryId, GlossaryEntry> = {
  "notice.stop": {
    line: "组织在这里停过,不会再自己动",
    basis: "lib/orgState.ts 的 orgRuntime()(派生状态,不由 projects.status 表达)",
    source: "GET /api/projects/:id/messages 里 kind='system' 且正文首行以「⚠️ 组织停止推进」开头",
  },
  "notice.compliance": {
    line: "那一回合没留工作记录",
    basis: "serve.ts 的 reportUnannouncedTurn(平台不替模型补记录)",
    source: "同上,正文首行以「⚠️ 平台检测」开头",
  },
  "notice.other": {
    line: "认不出类别,原样保留",
    basis: "lib/platformNotices.ts 的 classifyPlatformNotice(只认正文首行前缀)",
    source: "同上,前缀不匹配任何已注册项",
  },
  "client-question": {
    line: "等你拍板,答完落成 decision",
    basis: "ProjectDetail.pendingQuestions —— 持久台账,关掉页面还在",
    source: "GET /api/projects/:id(kind='client_question' 的工件)+ client_questions 表",
  },
  ask: {
    line: "角色之间在说话,你插不上手",
    basis: "契约裁决「甲方看不到横向沟通」⇒ 这一区只读,不进待答队列",
    source: "GET /api/projects/:id/asks(AskView)",
  },
  change: {
    line: "提议 → 评审 → 接受 / 实施",
    basis: "契约 ChangeStatus 闭集(proposed|under_review|accepted|implemented|rejected)",
    source: "GET /api/projects/:id/changes(ChangeView)",
  },
  blocker: {
    line: "卡住了哪些工作项",
    basis: "契约 BlockerSeverity / BlockerStatus 闭集",
    source: "GET /api/projects/:id/blockers",
  },
  "work.status": {
    line: "状态取值是契约的闭合集合",
    basis: "契约 WorkStatus(open|in_progress|blocked|done|failed|cancelled)",
    source: "GET /api/projects/:id/works",
  },
  "memory.sections": {
    line: "两套东西:关于你 / 关于项目",
    basis: "判据是「会不会淡忘」:记忆会淡忘,知识语料只读索引 —— 见 docs/DESIGN-KNOWLEDGE.md",
    source: "记忆 = GET /api/profile + /api/memory/fragments;语料 = GET /api/knowledge",
  },
  "artifact.no-work": {
    line: "workId 为空是合法状态",
    basis: "ArtifactView.workId 可空;决策 / 甲方问答本来就不由某条工作项产出",
    source: "GET /api/projects/:id/artifacts",
  },
  "artifact.dangling": {
    line: "挂着 workId,但那条工作项不在",
    basis: "lib/workGraph.ts 的悬空边处置(如实报出,不静默丢)",
    source: "GET /api/projects/:id/artifacts + /works",
  },
  timeline: {
    line: "横轴是耗时;上区环节,下区工件",
    basis: "lib/timeline.ts(纯函数:x = 时间,不做力导向求解)",
    source: "works + artifacts + GET /api/projects/:id/live",
  },
  "usage.cost": {
    line: "只读观测,平台不会因花钱停下",
    basis: "当前没有预算闸门(用户裁决:先只做 observation)",
    source: "GET /api/projects/:id/usage(窗口 = 含今日共 7 个本地日历日;「平台回合」那桶 = 不挂在任何工作项上的花费)",
  },
  "workspace.read": {
    line: "盘上有什么 + 索引引用了什么",
    basis: "design §4.4 P0 —— 只读,不建目录、不写文件(docs/DESIGN-WORKSPACE.md)",
    source: "GET /api/projects/:id/workspace(深度上限 3 层 / 500 条,到界 truncated=true)",
  },
  "artifact.graph": {
    line: "节点 = 工件,边 = 先后,从左到右读",
    basis: "lib/artifactGraph.ts(实线依据 / 虚线答复 / 点线拆解;反向边不画、只点名)",
    source: "GET /api/projects/:id/artifacts(含 workId 为空的决策与问答)",
  },
  "work.deps": {
    line: "实线拆解,虚线前置;方向都是先后",
    basis: "lib/workGraph.ts —— 子项 → 父项、前置 → 本条;排最上面是因为「谁在等谁」是读这页的第一问",
    source: "GET /api/projects/:id/works + project_assignments",
  },
  "knowledge.corpus": {
    line: "关于项目,不淡忘,agent 只读",
    basis: "lib/knowledgeState.ts 的 corpusStatus(量级 / 时效 / 行与索引是否一致)",
    source: "GET /api/knowledge 与 GET /api/knowledge/chunks(q 有值 = 检索,没值 = 按时间浏览)",
  },
  "harness.card": {
    line: "改得了提示词,改不了 ceiling",
    basis: "ROLE_SPECS.ceiling / writeKinds 是代码内常量;工具集合文件由人直接编辑,界面不提供写面",
    source: "GET /api/harness(单元读盘状态、集合文件状态、备份数)",
  },
};

/**
 * 已知不实之处 —— 「这块界面现在**说不到**的地方」,由 `routes/About.tsx` 全文列出。
 *
 * ⚠️ 它存在的理由与 `runtime: "unavailable"` 那条纪律同源:**读不到就说读不到**。
 * 界面上一句「暂无」有时候不是「确实没有」,而是「这个读面还不存在」——
 * 后者必须被写下来,否则下一次读它的人会把缺口当成结论(AGENTS.md「7-E」那一类)。
 *
 * 验收:每一条都要有一个**能 grep 到的落点**(`where`),`tests/web/about-page.test.ts`
 * 会盯住「不许出现空条目」。
 */
export interface KnownGap {
  /** 一句话(≤ 24 字):什么是缺的 / 什么是会骗人的。 */
  what: string;
  /** 为什么现在是这样 —— **不是**「以后再说」。 */
  why: string;
  /** 证据落点:文件 / 端点 / 迁移。 */
  where: string;
}

export const KNOWN_GAPS: readonly KnownGap[] = [
  {
    what: "知识语料跨项目全局可读",
    why: "语料表没有 tainted / 项目隔离列;tier 只是排序权重,不是可见性边界",
    where: "docs/DESIGN-KNOWLEDGE.md §7 · migrations/030_knowledge_tier.sql",
  },
  {
    what: "成本只有观测,没有上界",
    why: "用户裁决「先只做 observation」:不拦、不警告、不自动停",
    where: "GET /api/projects/:id/usage(byAgent / byWork / byDay)",
  },
  {
    what: "「进行中」只在连接着的时候看得见",
    why: "它来自 WS 在飞轮,不是在库里的第二份真相 —— 断流时这一块会空",
    where: "web/src/stores/chat.ts 的 inFlight · members/AgentConversations.tsx",
  },
  {
    what: "供应商降级是平台级的",
    why: "降级改的是进程级 env;换 provider = 这个项目里所有会话一起换,没有 per-session",
    where: "src/platform/host/serve.ts 的 decideFailover / failoverCandidatesOf",
  },
  {
    what: "降级没有结构化记录",
    why: "只落一条「⚠️ 供应商」会话消息 —— 一周降级了几次没有表可查",
    where: "src/platform/host/serve.ts 的 announceProviderFailover",
  },
  {
    what: "MCP 没有界面,连接状态读不到",
    why: "连接状态在 pi 的 mcp.log 里,平台读不着;connectionState 的类型就是字面量 'unavailable'",
    where: "src/platform/mcp/piConfig.ts · GET /api/mcp/servers",
  },
  {
    what: "已收口项目上的提问不再排队",
    why: "排空器只跑 active 项目 ⇒ 那里没有人会被叫醒来处理;事实仍在项目页",
    where: "src/platform/storage/repo/clientQuestions.ts 的 listAllClientQuestions",
  },
];
