/**
 * 推进图布局的**只读诊断**:拿跑着的宿主上的真数据算一遍 `layoutTimeline`,打印
 * 时间域 / 刻度 / 泳道名宽度。
 *
 * 为什么留它:时间轴那三个「看 markup 看不出来」的问题都是**从这份输出 + 渲染图**
 * 上发现的(见 HANDOFF W5 节):
 *   ① 泳道名超出栏宽(右对齐 ⇒ 溢出到 x<0 被裁);
 *   ② 真数据跨度 31 分钟被最小跨度常量硬撑成 1 小时(图上左右各空四分之一);
 *   ③ 贴边刻度标签被视口裁掉。
 *
 * 用法(先把宿主打在 2733;`--data` 指向**副本**,不碰真库):
 *   cp -R ~/.sansheng /tmp/ss-v5
 *   node dist/src/cli/index.js platform-serve --data /tmp/ss-v5 --port 2733 \
 *        --dispatch-interval 3600000 --scheduler-interval 3600000 &
 *   TSX_TSCONFIG_PATH=tsconfig.web.json npx tsx .probe/tl-probe.mts
 *
 * ⚠️ 它**只读**、只打印,不写任何东西。
 */
import { layoutTimeline, TL_GUTTER, textWidthPx } from "../web/src/lib/timeline.js";
import type { ArtifactView, ProjectLiveView, WorkView } from "../shared/types/platform.js";

const BASE = process.env.BASE ?? "http://127.0.0.1:2733";

interface ProjectRow {
  readonly id: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

const { projects } = await get<{ projects: ProjectRow[] }>("/api/projects");
const first = projects[0];
if (first === undefined) throw new Error("这个数据目录里没有项目");
const P = encodeURIComponent(first.id);

const [{ works }, { artifacts }, { live }] = await Promise.all([
  get<{ works: WorkView[] }>(`/api/projects/${P}/works`),
  get<{ artifacts: ArtifactView[] }>(`/api/projects/${P}/artifacts`),
  get<{ live: ProjectLiveView }>(`/api/projects/${P}/live`),
]);

const tl = layoutTimeline({
  works,
  artifacts,
  now: Date.now(),
  live: { runtime: live.runtime, agents: live.agents },
});

const f = (t: number): string => new Date(t).toLocaleTimeString("zh-CN", { hour12: false });
console.log("domain", f(tl.domain.from), "→", f(tl.domain.to),
  `(跨度 ${Math.round((tl.domain.to - tl.domain.from) / 60000)} 分钟)`);
console.log("ticks ", tl.ticks.map((t) => `${t.label}@${Math.round(t.x)}`).join(" | "));
console.log("泳道(栏宽", TL_GUTTER, "px;**超出即溢出被裁**):");
for (const lane of tl.lanes) {
  const w = Math.round(textWidthPx(lane.label));
  const flag = w > TL_GUTTER - 16 ? "  ⚠️ 溢出,渲染层必须截断" : "";
  console.log(`  ${lane.group.padEnd(4)} "${lane.label}" ${w}px${flag}`);
}
console.log("工件最早", f(Math.min(...artifacts.map((a) => a.createdAt))),
  "最晚", f(Math.max(...artifacts.map((a) => a.updatedAt))),
  `(${tl.marks.length} 个点 / ${tl.spans.length} 条条)`);
