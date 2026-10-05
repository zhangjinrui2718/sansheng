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
 * 产物:`.probe/w5-artifacts-preview.html` / `.probe/w5-members-preview.html`
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
import { ArtifactsScreen } from "@/routes/Artifacts";
import { MemberPane, MemberRoleTabs } from "@/routes/Members";

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
  join(process.cwd(), ".probe/w5-artifacts-preview.html"),
  page(
    "W5 预览 · 工件页(推进图)",
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
    runtime: live.runtime,
  }),
);

// 真机一次只渲染一个面板;影子里把四个都渲染出来(每个都是「选中它时」的样子)
const panes = members
  .map((m) =>
    renderToStaticMarkup(
      createElement(MemberPane, {
        member: m,
        activity: activityOf(m.id),
        conversation: byAgent.get(m.id) ?? null,
        harnessRole: harness.roles.find((r) => r.role === m.role) ?? null,
        artifacts: artifacts.filter((a) => a.authorAgentId === m.id),
        runtime: live.runtime,
        dispatch: live.dispatch,
        fetchedAt: Date.now(),
        now: Date.now(),
      }),
    ),
  )
  .join("\n");

writeFileSync(
  join(process.cwd(), ".probe/w5-members-preview.html"),
  page(
    "W4 预览 · 成员页",
    `静态影子(无脚本)· 数据来自 <code>${BASE}</code> 上的真数据副本 · 项目「${project.name}」· ` +
      `${members.length} 个成员 · live.runtime = <code>${live.runtime}</code>,` +
      `runningTurns = ${live.runningTurns},排空兜底间隔 ${live.dispatch.intervalMs}ms、` +
      `上一次 ${live.dispatch.lastRunAgeMs === null ? "本进程还没跑过" : `${Math.round(live.dispatch.lastRunAgeMs / 1000)}s 前`}。<br>` +
      `真机上**一次只显示一个成员**(上面那行页签切换);这里把四个面板都摊开,方便横向比。` +
      `面板里的「对话」与「角色能力面」在真机上是默认折叠的 <code>&lt;details&gt;</code>(影子里同样是折叠的,点一下才开)。`,
    `${tabs}<div class="grid gap-4" style="padding-top:12px">${panes}</div>`,
  ),
);

console.log("写好了:");
console.log("  .probe/w5-artifacts-preview.html");
console.log("  .probe/w5-members-preview.html");
