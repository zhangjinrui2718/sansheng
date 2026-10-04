/**
 * 平台运行时 · 当前项目上下文(注入面 A)
 *
 * ── 它补的是一个被签名证明过的洞 ──────────────────────────────────
 *
 * 2026-10-04 真机跑「立项 → 在项目里说『开工』」时,业务经理的回答是
 * **「当前没有在跑的项目」并提议再开一个新项目** —— 而它当时就在那个项目里,
 * 库里 `projects=1`。根因不在提示词,在签名:
 *
 *   renderRoleBrief(role)               ← 参数只有 role
 *   composeSystemPrompt(dataDir, role)  ← 参数只有 role
 *
 * 也就是说:系统提示 = 机械角色简报 + 盘上提示词单元,**两者都拿不到项目**。
 * 回合消息里注入的 `pendingWork` 只含待办,那一刻是空的。于是这个 agent 手上的
 * 项目信息是**零** —— 它得主动调 `project_read` 才发现自己在哪,而它没调。
 *
 * ── 为什么注入在回合消息里,而不是系统提示里 ──────────────────────
 *
 * 三个理由,第一个是硬约束:
 *
 *   1. **系统提示是会话建立时算一次的。** `composeSystemPrompt` 只在
 *      `createPlatformSession` 里调用;而一个项目的会话是**常驻**的(宿主按
 *      项目缓存)。项目状态会在这个会话活着的时候变 —— `project_update` 改目标、
 *      `project_close` 关项目、成员增减。拼进系统提示等于把一份**建立那一刻的
 *      快照**当成了永久事实,而且它会一直骗下去(没有任何东西会提醒它过期)。
 *   2. 待办注入已经确立了「每回合现算、拼在 user 消息前部」这个形态
 *      (见 `turn.ts` 文件头:重建会话会丢掉历史,而历史正是「它已经查过什么」
 *      的来源)。项目上下文与待办是同一类信息:每回合都在变的现场。
 *   3. `composeTurnMessage` 已经有「系统替我列的东西在前、我该干的事在后」的
 *      分层。项目上下文进那一层,模型看到的就是
 *      **我在哪(项目) → 我手上有什么(待办) → 这回合干什么(任务)**。
 *
 * ── 接待会话:这里如实返回空串 ────────────────────────────────────
 *
 * `projectId === null`(第一个项目之前)没有项目可注入,**保持原样**:空串,
 * 调用方无脑拼接即可。不给它编一段「你还没有项目」的废话 —— 那段话在接待会话
 * 里每回合都会出现,而接待模式的提示词单元已经写清了那一段的规则。
 */
import type Database from "better-sqlite3";
import { getProjectRow, loadProjectRoster } from "../storage/repo/projects.js";
import { getAgent } from "../storage/repo/agents.js";
import { isProjectRole, type ProjectRole } from "../identity/role.js";

const ROLE_NAME: Readonly<Record<ProjectRole, string>> = {
  business_manager: "业务经理",
  project_manager: "项目经理",
  worker: "Worker(执行者)",
  quality_reviewer: "质检审查员",
};

const STATUS_NAME: Readonly<Record<string, string>> = {
  draft: "草稿",
  active: "进行中",
  paused: "暂停",
  done: "已完成",
  abandoned: "已废弃",
};

export interface ProjectContext {
  /** 注入文本。接待会话下是空串。 */
  readonly text: string;
  /** 一句话摘要(日志/诊断),接待会话下如实说明为什么是空的。 */
  readonly summary: string;
  /** 实际注入了哪个项目;`null` = 接待会话 */
  readonly projectId: string | null;
}

/**
 * 渲染「你所在的项目」这一段。**纯查询,无副作用。**
 *
 * 项目不存在时**不静默返回空**:那会让「项目被删了」和「这是一条接待会话」
 * 在模型那边长得一模一样。这里返回一段明说问题的文本 —— 一个 agent 在
 * 指名道姓要它干活的项目里读不到项目,必须看得见。
 */
export function renderProjectContext(
  db: Database.Database,
  agentId: string,
  projectId: string | null,
): ProjectContext {
  if (projectId === null) {
    return { text: "", summary: "(接待会话:还没有项目)", projectId: null };
  }

  const project = getProjectRow(db, projectId);
  if (project === null) {
    return {
      text:
        "## ⚠️ 你所在的项目读不出来\n\n" +
        `平台把你放在项目 \`${projectId}\` 里,但这个项目在库里不存在。\n` +
        "**不要猜项目内容,也不要另开一个项目** —— 把这个情况如实说出来。",
      summary: `(项目 ${projectId} 读不出来)`,
      projectId,
    };
  }

  const me = getAgent(db, agentId);
  const myRole: ProjectRole | null =
    me !== null && isProjectRole(me.role) ? me.role : null;

  const roster = loadProjectRoster(db, projectId);
  const lines: string[] = [
    "## 你所在的项目(平台注入,来源是库,不是用户这句话里说的)",
    "",
    `- 项目 ID:\`${project.id}\``,
    `- 项目名:${project.name}`,
    `- 甲方:${project.client}`,
    `- 状态:${STATUS_NAME[project.status] ?? project.status}(${project.status})`,
    `- 你是:${myRole !== null ? `${ROLE_NAME[myRole]}(\`${myRole}\`)` : `\`${agentId}\`(角色未知)`}`,
    "",
    "### 目标(立项时与甲方对齐的结论)",
    project.goal,
    "",
    `### 项目成员(${roster.length})`,
    ...roster.map(
      (m) =>
        `- ${m.displayName} · ${m.role}${m.specialization !== null ? `/${m.specialization}` : ""} (\`${m.id}\`)`,
    ),
    "",
    "**这就是你此刻所在的项目。** 不要提议「再开一个新项目」来推进它 —— " +
      "新的活属于这个项目。要细节(工作项分布、阻塞、变更)用 `project_read` 查。",
  ];

  return {
    text: lines.join("\n"),
    summary: `项目 ${project.id}「${project.name}」(状态 ${project.status})· 我是 ${myRole ?? agentId}`,
    projectId,
  };
}
