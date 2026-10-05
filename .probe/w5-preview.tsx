/**
 * W4 预览:「工件页(产出流程 DAG)」与「成员页(按角色切换 + 正在做什么)」的**静态影子**
 *
 * 为什么要有它:这两个页面的判据都由 `tests/web/*.test.ts` 的 SSR 断言钉着,但
 * **判据过 ≠ 眼睛看得下去**。上一次可读性改造(harness 按角色分栏)也是这么验的
 * (`.probe/harness-by-role-preview.html`)。这里不再手写夹具:数据全部从**跑在
 * 真数据副本上的宿主**取(`/api/projects/:id/{works,artifacts,live,members,
 * member-conversations}` + `/api/harness`),再用**页面自己的组件**渲染 —— 所以
 * 它看到的就是真机打开页面会看到的东西(唯一差别:成员页一次只显示一个成员,
 * 这里把四个都摊开,方便横向比较)。
 *
 * 用法:
 *   node dist/src/cli/index.js platform-serve --data <真数据副本> --port 2732 \
 *        --dispatch-interval 3600000 --scheduler-interval 3600000 &
 *   TSX_TSCONFIG_PATH=tsconfig.web.json npx tsx .probe/w4-preview.tsx
 *
 * ⚠️ **必须带 `TSX_TSCONFIG_PATH=tsconfig.web.json`** —— 根 `tsconfig.json` 里没有
 * `jsx`,tsx 于是走 classic runtime,运行时会报 `React is not defined`(与
 * `vitest.config.ts` 里记着的那条 esbuild JSX 陷阱同源)。web 那份配置里写着
 * `"jsx": "react-jsx"`。
 * ⚠️ 排空定时器与调度器都要调大:宿主跑在**真数据的副本**上,不该顺手跑起一个回合
 * (`--data` 指向副本,所以真库一个字节都不会被改)。
 *
 * 产物:`.probe/w5-works-preview.html` / `.probe/w5-members-preview.html`
 * (内联 dist/web 的构建 CSS,双击即可看;纯静态,没有任何脚本)。
 */
import { writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  ArtifactView, HarnessView, MemberActivityView, MemberConversationView,
  MemberView, ProjectLiveView, ProjectSummary, WorkView,
} from "@shared/types/platform";
import { ArtifactsScreen, WorkDag } from "@/routes/Works";
import { MemberPane, MemberRoleTabs, MemberTabPanels } from "@/routes/Members";
import { RoleHarnessDisclosure } from "@/components/members/RoleHarness";
import { layoutWorkDag } from "@/lib/workGraph";

const PORT = process.env.PORT ?? "2732";
const BASE = `http://127.0.0.1:${PORT}`;

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ── 取真数据 ────────────────────────────────────────────────────

const { projects } = await get<{ projects: ProjectSummary[] }>("/api/projects");
if (projects.length === 0) throw new Error("这个数据目录里没有项目 —— 预览需要至少一个项目");
const project = projects[0] as ProjectSummary;
const P = encodeURIComponent(project.id);

const [{ works }, { artifacts }, { live }, harness] = await Promise.all([
  get<{ works: WorkView[] }>(`/api/projects/${P}/works`),
  get<{ artifacts: ArtifactView[] }>(`/api/projects/${P}/artifacts`),
  get<{ live: ProjectLiveView }>(`/api/projects/${P}/live`),
  get<HarnessView>("/api/harness"),
]);

// ── 构建产物里的 CSS(内联,免得影子页面光秃秃)─────────────────────

const assetDir = join(process.cwd(), "dist/web/assets");
const cssFile = readdirSync(assetDir).find((f) => f.endsWith(".css"));
if (cssFile === undefined) throw new Error("dist/web/assets 里没有 CSS —— 先跑 npm run build:web");
const css = readFileSync(join(assetDir, cssFile), "utf8");

function page(title: string, note: string, body: string): string {
  return `<!doctype html>
<html lang="zh" class="dark"><head><meta charset="utf-8">
<title>${title}</title><style>${css}</style>
<style>
  body { background: var(--ink-0); margin: 0; }
  .w4-note { max-width: 1180px; margin: 0 auto; padding: 14px 16px 0; color: var(--bone-dim); font-size: 12px; line-height: 1.8; }
  .w4-note code { color: var(--jade); }
  .ss-page { max-width: 1180px; }
</style></head>
<body><div class="w4-note">${note}</div><div class="ss-page">${body}</div></body></html>`;
}

// ── ① 工件页(产出流程 DAG)──────────────────────────────────────

const richest =
  works
    .map((w) => ({ w, n: artifacts.filter((a) => a.workId === w.id).length }))
    .sort((x, y) => y.n - x.n)[0]?.w.id ?? null;

const artifactsBody = renderToStaticMarkup(
  createElement(ArtifactsScreen, {
    works,
    artifacts,
    live: { runtime: live.runtime, agents: live.agents },
    now: Date.now(),
    picked: richest,
    onPick: () => {},
    openId: null,
    onToggleDetail: () => {},
  }),
);

writeFileSync(
  join(process.cwd(), ".probe/w5-works-preview.html"),
  page(
    "W5 预览 · 工作项页(推进图)",
    `静态影子(无脚本)· 数据来自 <code>${BASE}</code> 上的真数据副本 · 项目「${project.name}」· ` +
      `${works.length} 个环节 / ${artifacts.length} 件工件(其中 ` +
      `${artifacts.filter((a) => a.workId !== null).length} 件挂在环节上)· ` +
      `live.runtime = <code>${live.runtime}</code>。<br>` +
      `右侧选中态是预览时**自动挑**的「工件最多的那个环节」;真机上是点节点切换。` +
      `「详情」在影子里不展开(它是有状态组件,要按 id 拉一次 <code>GET /api/artifacts/:id</code>)。`,
    artifactsBody,
  ),
);

// ── ② 成员页(按角色切换 + 正在做什么)───────────────────────────

const { members } = await get<{ members: MemberView[] }>(`/api/projects/${P}/members`);
const { groups } = await get<{ groups: MemberConversationView[] }>(
  `/api/projects/${P}/member-conversations`,
);
const byAgent = new Map<string | null, MemberConversationView>(groups.map((g) => [g.agentId, g]));
const activityOf = (agentId: string): MemberActivityView | null =>
  live.agents.find((a) => a.agentId === agentId) ?? null;

const tabs = renderToStaticMarkup(
  createElement(MemberRoleTabs, {
    members,
    active: members[0]?.id ?? null,
    onSelect: () => {},
    activityOf,
    // 页签第二个角标:角色 harness 那边需要注意的处数(与「欠活」不是一回事)
    issuesOf: (agentId) => {
      const m = members.find((x) => x.id === agentId);
      const r = harness.roles.find((x) => x.role === m?.role);
      if (r === undefined) return 0;
      return (
        r.promptUnits.filter((u) => !u.loaded).length +
        (r.toolSet.state === "invalid" ? 1 : 0) +
        r.blockedByCeiling.length +
        r.unknownTools.length
      );
    },
    runtime: live.runtime,
  }),
);

// 真机一次只渲染一个面板;影子里把四个都渲染出来(每个都是「选中它时」的样子)
//
// 组合方式与真机**同一份** `MemberTabPanels`(成员卡片 + 独立的「角色 harness」卡片)。
// ⚠️ 必须是 `createElement(组件, props)` —— 写成 `renderToStaticMarkup(组件, props)`
// 不报错,但它渲染的是一个 **props 为空** 的组件(第二个参数被忽略)⇒ 屏幕上只剩一排
// 页签(第一次改这份影子时踩到了)。
// ⚠️ harness 那一块走**纯展示层** `RoleHarnessDisclosure` 并直接喂真实视图:
// `RoleHarnessSection` 自己 `getHarness()` 而 SSR 不跑 effect,喂它只会停在「正在读取」。
const panes = members
  .map((m) =>
    renderToStaticMarkup(
      createElement(MemberTabPanels, {
        member: createElement(MemberPane, {
          member: m,
          activity: activityOf(m.id),
          conversation: byAgent.get(m.id) ?? null,
          // 影子里这次请求是成功的(数据就是从它拿的)⇒ 如实传 null
          conversationError: null,
          artifacts: artifacts.filter((a) => a.authorAgentId === m.id),
          runtime: live.runtime,
          dispatch: live.dispatch,
          fetchedAt: Date.now(),
          now: Date.now(),
        }),
        harness: createElement(RoleHarnessDisclosure, {
          role: m.role,
          view: harness,
          loading: false,
          error: null,
          // 盘上正文当草稿(影子不编辑);备份份数在影子里不查 ⇒ 显示「—」
          drafts: Object.fromEntries(
            harness.roles.flatMap((r) => r.promptUnits.map((u) => [u.id, u.content])),
          ),
          backups: {},
          onDraftChange: () => {},
          onApplied: () => {},
        }),
      }),
    ),
  )
  .join("\n");

writeFileSync(
  join(process.cwd(), ".probe/w5-members-preview.html"),
  page(
    "W6 预览 · 成员页(harness 已并入)",
    `静态影子(无脚本)· 数据来自 <code>${BASE}</code> 上的真数据副本 · 项目「${project.name}」· ` +
      `${members.length} 个成员 · live.runtime = <code>${live.runtime}</code>,` +
      `runningTurns = ${live.runningTurns},排空兜底间隔 ${live.dispatch.intervalMs}ms、` +
      `上一次 ${live.dispatch.lastRunAgeMs === null ? "本进程还没跑过" : `${Math.round(live.dispatch.lastRunAgeMs / 1000)}s 前`}。<br>` +
      `真机上**一次只显示一个成员**(上面那行页签切换);这里把四个面板都摊开,方便横向比。` +
      `每个成员卡片下面是**独立的「角色 harness」卡片**(2026-10-06 第四刀:从成员面板里拿出来,` +
      `未来角色的 harness 配置就放这里)—— 卡片头常显状态摘要,配置内容默认折叠。` +
      `「对话」那一块也是默认折叠的 <code>&lt;details&gt;</code>(影子里同样折叠,点一下才开)。<br>` +
      `⚠️ 影子里的 harness 卡片走的是**纯展示那一层**(直接喂真实 <code>GET /api/harness</code> 视图);` +
      `真机上那一块是自足的 <code>RoleHarnessSection</code>(自己取数、自己持草稿与备份),行为一致。`,
    `${tabs}<div class="grid gap-4" style="padding-top:12px">${panes}</div>`,
  ),
);

// ── ③ 依赖关系图(**展开**,专门用来核「缠不缠」)──────────────────
//
// 页面里它是默认折叠的;这一份把它摊开,好对着真数据看分层有没有排对。
const dag = layoutWorkDag(works, artifacts);
const dagHtml = renderToStaticMarkup(
  createElement(WorkDag, {
    layout: dag,
    live: { runtime: live.runtime, agents: live.agents },
    selectedId: dag.nodes.find((n) => n.artifactCount > 0)?.work.id ?? null,
    onSelect: () => {},
  }),
);
writeFileSync(
  join(process.cwd(), ".probe/w5-dag-preview.html"),
  page(
    "W5 预览 · 依赖关系图(展开)",
    `静态影子 · 真数据 · 项目「${project.name}」· ${works.length} 个环节 · ` +
      `${dag.layers} 列 · 排不出先后的 ${dag.unlayeredIds.length} 个 · ` +
      `互相咬住的 ${dag.mutualPairs.length} 对。<br>` +
      `实线 = 拆解(子项 → 父项),虚线 = 前置依赖(前置 → 本条) —— **两条边的方向都是先后**,` +
      `所以从左到右就是「先做什么、后做什么」。`,
    dagHtml,
  ),
);

console.log("写好了:");
console.log("  .probe/w5-works-preview.html");
console.log("  .probe/w5-members-preview.html");
console.log("  .probe/w5-dag-preview.html");
