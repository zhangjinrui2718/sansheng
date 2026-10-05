/**
 * 工件屏 —— **产出流程(工作项 DAG)+ 环节详情**
 *
 * ── 这一版换掉了什么 ────────────────────────────────────────────
 *
 * 上一版按 `kind` 平铺工件:决策一堆、证据一堆、评审发现一堆。它答的是
 * 「**产出了什么**」,答不了「**流程走到哪了**」—— 而工件是流程往前推进的关键
 * 节点,读者要看的第二件事正是后者(用户原话:「工件是整个工作流程在往前推进的
 * 关键节点」)。
 *
 * 这一版把**工作项**画成一张从左到右的 DAG(布局是 `lib/workGraph.ts` 的纯函数,
 * 这里只负责摆),工件通过契约的 `ArtifactView.workId`(migration 014 的产出边)
 * 挂回产出它的那个环节;点节点看该环节的产出。四块各答一个问题:
 *
 *   ① 产出流程 —— 整个项目推进到哪了(节点 = 工作项,边 = 拆解 / 前置依赖);
 *   ② 选中的环节 —— 这一步的负责人、依赖、目标,以及它留下的工件;
 *   ③ 不挂在任何环节上的工件 —— 决策 / 会议 / 变更 / 甲方问答(契约里
 *      `workId === null` 是**合法状态**:它们本来就不由某条工作项产出);
 *   ④ 环节读不到的工件 —— `workId` 指向一条本次没加载到的工作项(读面容错,通常为空)。
 *
 * ── 三条「不许说假话」的落点 ────────────────────────────────────
 *
 *  1. **空 / 0 一律来自真实数组长度**:第三、四块只有真的有条目才渲染;节点上的
 *     `工件 N` 就是布局给的 `artifactCount`;整页的「加载中…」只在
 *     `loading && works.length === 0 && artifacts.length === 0` 时出现
 *     (见 `lib/data.ts` 文件头:「还没查过」不等于「查过了,是空」)。
 *  2. **「读不到运行态」不是「空闲」**:`live === null` 或
 *     `live.runtime === "unavailable"` 时,`workRunningState` 给 `unknown: true`
 *     —— 那时节点边框**不点亮**、也不显示呼吸点,图例处明说运行态读不到;库里
 *     那条 `in_progress` 仍由状态 Pill 如实显示(它是**过去的事实**,不是「此刻」)。
 *  3. **排不出先后的环节不许丢、也不许静默**:`workGraph` 把 Kahn 排序未出队的
 *     节点(= 在依赖环上**或**环的下游)单独排到最后一列,并在 `unlayeredIds` /
 *     `node.unlayered` 上报出来,这里必须写成一行说明 —— 而且**归因只到这一步**
 *     (说「依赖成环」对环下游的节点是一句假归因)。
 *
 * ── 可测性(纯 props)─────────────────────────────────────────────
 *
 * 四块全部抽成**纯 props** 的导出组件(`ArtifactsBody` / `WorkDag` /
 * `WorkDagCanvas` / `WorkNodePanel` / `ArtifactGroups` / `ArtifactRow` /
 * `UnattachedArtifacts` / `DanglingArtifacts`),与 `Harness.tsx` 导出
 * `HarnessRoleTabs` / `HarnessRolePane` 同一处置:`renderToStaticMarkup` + 夹具
 * 就能钉住判据,不起服务、不 stub fetch。`ArtifactsPage` 自己只做三件事:
 * 取数(`useWorks` / `useArtifacts` / `useProjectLive`)、持有两个交互态
 * (选中的环节、展开了详情的那条工件)、项目切换时重置它们。
 *
 * 「详情」保持原行为:**按 id 单独拉一次** `GET /api/artifacts/:id`,不拿列表里
 * 那条凑 —— 契约给了 `/:id` 这条端点,它的存在意义就是「列表里的字段可能不是全量」。
 */
import { useEffect, useMemo, useState } from "react";
import type { ArtifactKind, ArtifactView, WorkView } from "@shared/types/platform";
import {
  Clamp,
  Disclosure,
  EmptyState,
  KV,
  PageHeader,
  Pill,
  Section,
  StatStrip,
  toneColor,
} from "@/components/ui/primitives";
import { useArtifacts, useProjectLive, useWorks } from "@/lib/data";
import { useChatStore } from "@/stores/chat";
import { errorMessage, getArtifact } from "@/lib/api";
import {
  DAG_NODE_H,
  DAG_NODE_W,
  layoutWorkDag,
  splitArtifactsByWork,
  workRunningState,
  type WorkDagLayout,
} from "@/lib/workGraph";
import {
  artifactKindLabel,
  artifactKindTone,
  artifactStatusLabel,
  artifactStatusTone,
  fmtTime,
  workStatusLabel,
  workStatusTone,
} from "@/lib/vocab";

/** 展示顺序:结论类优先,过程类靠后。表里没有的 kind 落在末尾(不丢)。 */
const KIND_ORDER: ArtifactKind[] = [
  "decision",
  "project_brief",
  "work_brief",
  // 交付物是整合的产物,与 decision / *_brief 同属「结论类」,排在过程类之前。
  "deliverable",
  "evidence",
  "review_finding",
  "change_record",
  "meeting_note",
  "hypothesis",
  "client_question",
  "note",
];

/**
 * DAG 只读 live 的**两件事**:运行期来源 + 每个角色的回合闩。
 *
 * 类型**故意收窄**:页面拿到的是 `ProjectLiveView`(它结构化地满足这个形状),
 * 而窄类型让测试能喂一份两行夹具,不必造整张 live 视图 —— 同时也把「DAG 到底
 * 读了 live 的哪一部分」钉在类型上,防止以后顺手多读几个字段。
 */
export interface DagLive {
  readonly runtime: "host" | "unavailable";
  readonly agents: ReadonlyArray<{ readonly agentId: string; readonly turn: unknown | null }>;
}

// ── ① 产出流程:画布 ────────────────────────────────────────────

/**
 * 画布本体(边一层 SVG + 节点一层绝对定位的 button)。
 *
 * **不自己算布局**:`layout` 由 `layoutWorkDag` 给,渲染层只消费 —— 布局是纯函数,
 * 这样它的判据(最长路径分层 / 去重去自环 / 环单列)与这里的摆放判据能在测试里
 * 分开钉。
 */
export function WorkDagCanvas({
  layout,
  live,
  selectedId,
  onSelect,
}: {
  layout: WorkDagLayout;
  live: DagLive | null;
  /** 当前选中的工作项 id(null = 没选) */
  selectedId: string | null;
  /** 点节点:选它;再点一次同一个 ⇒ null(回到「点一个环节看它的产出」) */
  onSelect: (workId: string | null) => void;
}) {
  return (
    // `maxHeight`:横向溢出必须能滚(用户要求),但纵向也要有个上限 —— 一条层里排上
    // 二十个环节时,画布会长到把 ②③④ 全部推出一屏。滚动条本身就是「还有内容」的
    // 可见信号,不会让人以为图就这么多。
    <div className="ss-dag" style={{ maxHeight: 560 }}>
      {/* 内层定尺容器:`.ss-dag` 自己是滚动容器,绝对定位的节点要有它才能定出
          横向滚动范围(`.ss-dag-edges` 也是相对它定位的)。 */}
      <div style={{ position: "relative", width: layout.width, height: layout.height }}>
        <svg className="ss-dag-edges" width={layout.width} height={layout.height} aria-hidden="true">
          {layout.edges.map((e) => (
            <path
              key={`${e.kind}:${e.from}->${e.to}`}
              d={e.path}
              fill="none"
              stroke="var(--bone-mute)"
              strokeWidth={1}
              // 实线 = 拆解(parentWorkId),虚线 = 前置依赖(dependsOn)。
              // 两种关系用**线型**分开;颜色只走既有 token,不新造颜色。
              {...(e.kind === "depends_on" ? { strokeDasharray: "4 3" } : {})}
            />
          ))}
        </svg>

        {layout.nodes.map((n) => {
          const run = workRunningState(n.work, live);
          // 「在跑」只有在**真的知道**时才敢点亮:读不到运行态时,库里的
          // in_progress 仍由第一行的 Pill 如实显示,但它不该冒充「此刻」。
          const lit = run.running && !run.unknown;
          // 没有工件的环节不是「产出工件的环节」—— 让它明显安静(降不透明度),
          // 而不是给它编一个别的状态。
          const quiet = n.artifactCount === 0;
          const selected = n.work.id === selectedId;
          return (
            <button
              key={n.work.id}
              type="button"
              className="ss-dag-node"
              data-running={lit ? "true" : "false"}
              data-selected={selected ? "true" : "false"}
              style={{
                left: n.x,
                top: n.y,
                width: DAG_NODE_W,
                height: DAG_NODE_H,
                opacity: quiet ? 0.55 : 1,
              }}
              title={
                `${n.work.title}\n` +
                `负责人:${n.work.assigneeName}\n` +
                `状态:${workStatusLabel(n.work.status)}(${n.work.status})\n` +
                `挂着的工件:${n.artifactCount}` +
                (n.unlayered ? "\n⚠️ 先后算不出来 —— 这条环节在依赖环上或环的下游" : "")
              }
              onClick={() => onSelect(selected ? null : n.work.id)}
            >
              <span className="flex items-center gap-1.5" style={{ minHeight: 16 }}>
                <Pill tone={workStatusTone(n.work.status)} title={n.work.status}>
                  {workStatusLabel(n.work.status)}
                </Pill>
                {/* 呼吸点只在「确定此刻在跑」时出现;unknown 时给一个**灰的、不动的**
                    点(样式在 globals.css 的 `[data-state="unknown"]`),并且图例处
                    有文字说明 —— 颜色单独承担不了这个区别。 */}
                {run.running && (
                  <span
                    className="ss-live-dot"
                    data-state={run.unknown ? "unknown" : undefined}
                    title={
                      run.unknown
                        ? "运行态读不到:这条工作项在库里还标着「进行中」,但这一刻没有可信的回合快照"
                        : "此刻有回合在跑"
                    }
                  />
                )}
                {n.unlayered && (
                  <span className="ss-meta" style={{ marginLeft: "auto", color: "var(--amber)" }}>
                    环
                  </span>
                )}
              </span>
              <span
                className="ss-body truncate"
                style={{ fontSize: 11, lineHeight: "14px", color: "var(--bone)" }}
              >
                {n.work.title || "(无标题)"}
              </span>
              <span className="ss-meta flex items-center gap-1" style={{ marginTop: "auto" }}>
                <span className="truncate" style={{ maxWidth: 74 }}>
                  {n.work.assigneeName}
                </span>
                <span aria-hidden="true">·</span>
                <span
                  title="挂在这个环节上的工件数(= artifactCount)。契约里 work_id 一条边两个语义(产出 ∪ 关于),所以质检挂在被审那条上的 review_finding 也算在这里。"
                  style={{ whiteSpace: "nowrap" }}
                >
                  工件{" "}
                  <span style={{ color: quiet ? "var(--bone-mute)" : "var(--bone-dim)" }}>
                    {n.artifactCount}
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 图例:三种记号各是什么意思。样式与画布上的边**同一套 token**。 */
export function WorkDagLegend() {
  return (
    <div className="flex items-center gap-3 flex-wrap ss-meta" style={{ marginTop: 6 }}>
      <span className="flex items-center gap-1.5">
        <svg width="18" height="6" aria-hidden="true">
          <path d="M0 3 H18" stroke="var(--bone-mute)" strokeWidth={1} fill="none" />
        </svg>
        实线 = 拆解(parentWorkId)
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="18" height="6" aria-hidden="true">
          <path
            d="M0 3 H18"
            stroke="var(--bone-mute)"
            strokeWidth={1}
            strokeDasharray="4 3"
            fill="none"
          />
        </svg>
        虚线 = 前置依赖(dependsOn)
      </span>
      <span className="flex items-center gap-1.5">
        <span className="ss-live-dot" />
        点 = 此刻在跑
      </span>
    </div>
  );
}

/**
 * 产出流程整块:画布 + 图例 + 两行必须说出口的话。
 *
 * `runtimeUnknown` 的两行小字是这一块的**诚实开关**:运行态读不到时,页面不能
 * 因为「没有点亮的节点」而看起来像「此刻一切空闲」。
 */
export function WorkDag({
  layout,
  live,
  selectedId,
  onSelect,
}: {
  layout: WorkDagLayout;
  live: DagLive | null;
  selectedId: string | null;
  onSelect: (workId: string | null) => void;
}) {
  const unlayered = layout.nodes.filter((n) => n.unlayered);
  // live === null = 「还没拿到过」,与 unavailable 一样属于**读不到** —— 两者都
  // 不许被渲染成「没有在跑」。
  const runtimeUnknown = live === null || live.runtime === "unavailable";
  return (
    <div className="flex flex-col">
      <WorkDagCanvas layout={layout} live={live} selectedId={selectedId} onSelect={onSelect} />
      <WorkDagLegend />
      {runtimeUnknown && (
        <div className="ss-note flex items-start gap-1.5" style={{ marginTop: 4 }}>
          <span
            className="ss-live-dot"
            data-state="unknown"
            style={{ marginTop: 5, flex: "0 0 auto" }}
          />
          {/* 这一句是**多行中文**:用字符串字面量拼,免得 JSX 把换行折成空格,
              在句子中间留出一个空格(中文句子里的空格会被读成排版错误)。 */}
          <span>
            {"运行态读不到:这次只连上了 HTTP 读面,宿主没有接上运行期快照 —— 谁此刻在跑读不到。" +
              "所以节点边框一律不点亮;若某个节点上出现灰色点,那只说明库里那条工作项还标着" +
              "「进行中」,不等于此刻有回合在跑。"}
          </span>
        </div>
      )}
      {unlayered.length > 0 && (
        <div className="ss-note" style={{ marginTop: 4, color: "var(--amber)" }}>
          有 {unlayered.length} 个环节的先后算不出来(在依赖环上或环的下游):
          {unlayered.map((n) => n.work.title || n.work.id).join(" · ")}
          {" —— "}
          {"它们被统一排在最后一列,别按左右位置读先后。" +
            "这不是没算,是这几条依赖互相咬住了(谁该先做没有答案)。"}
        </div>
      )}
      {layout.droppedEdges > 0 && (
        <div className="ss-note" style={{ marginTop: 4 }}>
          另有 {layout.droppedEdges} 条边没有画出来(重复、自环,或指向本次没读到的环节)。
        </div>
      )}
    </div>
  );
}

// ── 工件行 / 工件分组(③ 与 ② 共用同一套渲染代码)──────────────────

/** links 的 rel 是契约里的闭合联合(parent | depends_on | answers);未知值原样透出。 */
const REL_LABEL: Record<string, string> = {
  parent: "父工件",
  depends_on: "依赖",
  answers: "答复",
};

/**
 * 一条工件的摘要行(kind 色点 / status Pill / 标题 / 作者 / 时间 / body 截断),
 * 外加「详情」按钮。② 与 ③ **共用这一个组件** —— 两份渲染代码迟早会长歪。
 *
 * 详情是否展开由父层给(`open` + `onToggle`):一个页面同时只展开一条,
 * 免得一屏里挂出好几段正文。
 */
export function ArtifactRow({
  artifact: a,
  known,
  open,
  onToggle,
}: {
  artifact: ArtifactView;
  /** 本次已加载的工件列表 —— 只用来**顺手**给关联目标显示标题(详情里用) */
  known: readonly ArtifactView[];
  open: boolean;
  onToggle: () => void;
}) {
  const long = a.body.length > 120;
  return (
    <article className="sansheng-card p-2.5" title={a.id}>
      <div className="flex items-center gap-2 flex-wrap">
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 2,
            flex: "0 0 auto",
            background: toneColor(artifactKindTone(a.kind)),
          }}
        />
        <Pill tone={artifactStatusTone(a.status)} title={a.status}>
          {artifactStatusLabel(a.status)}
        </Pill>
        <span className="ss-body" style={{ color: "var(--bone)" }}>
          {a.title || "(无标题)"}
        </span>
        <span className="ss-meta ml-auto">{a.authorName || a.authorAgentId}</span>
        <button
          type="button"
          className="sansheng-button"
          style={{ padding: "1px 8px", fontSize: 11 }}
          title="按 id 拉 GET /api/artifacts/:id,看正文全文与关联关系"
          onClick={onToggle}
        >
          {open ? "收起" : "详情"}
        </button>
      </div>
      {a.body.length > 0 && a.body !== a.title && (
        <>
          <Clamp lines={2} style={{ marginTop: 4 }}>
            {a.body}
          </Clamp>
          {long && (
            <Disclosure summary="全文">
              <div style={{ whiteSpace: "pre-wrap" }}>{a.body}</div>
            </Disclosure>
          )}
        </>
      )}
      <div className="ss-meta mt-1">
        {fmtTime(a.createdAt)}
        {a.links.length > 0 &&
          ` · 关联 ${a.links.map((l) => `${l.rel}→${l.targetId}`).join(" · ")}`}
      </div>
      {open && <ArtifactDetail id={a.id} known={known} />}
    </article>
  );
}

/**
 * 一串工件按 `kind` 分组(顺序沿用 `KIND_ORDER`,组内按 createdAt 倒序)。
 *
 * 分组的依据**只有本次真实返回的 kind**;契约之外的 kind 原样显示英文(落在末尾),
 * 不猜、也不丢。
 */
export function ArtifactGroups({
  artifacts,
  known,
  openId,
  onToggleDetail,
}: {
  artifacts: readonly ArtifactView[];
  known: readonly ArtifactView[];
  /** 当前展开了详情的那条工件 id(null = 都收起) */
  openId: string | null;
  onToggleDetail: (artifactId: string) => void;
}) {
  const groups = useMemo(() => {
    const byKind = new Map<string, ArtifactView[]>();
    for (const a of artifacts) {
      const bucket = byKind.get(a.kind);
      if (bucket) bucket.push(a);
      else byKind.set(a.kind, [a]);
    }
    return [...byKind.entries()]
      .sort((x, y) => {
        const ix = KIND_ORDER.indexOf(x[0] as ArtifactKind);
        const iy = KIND_ORDER.indexOf(y[0] as ArtifactKind);
        return (ix === -1 ? KIND_ORDER.length : ix) - (iy === -1 ? KIND_ORDER.length : iy);
      })
      .map(([kind, rows]) => ({
        kind,
        rows: [...rows].sort((a, b) => b.createdAt - a.createdAt),
      }));
  }, [artifacts]);

  return (
    <div className={artifacts.length > 0 ? "grid gap-4" : undefined}>
      {groups.map(({ kind, rows }) => (
        <Section key={kind} title={artifactKindLabel(kind)} count={rows.length} hint={kind}>
          <div className="grid gap-1.5">
            {rows.map((a) => (
              <ArtifactRow
                key={a.id}
                artifact={a}
                known={known}
                open={openId === a.id}
                onToggle={() => onToggleDetail(a.id)}
              />
            ))}
          </div>
        </Section>
      ))}
    </div>
  );
}

// ── ② 选中的环节 ────────────────────────────────────────────────

/**
 * 一个环节的面板:**这一条工作项是谁的、在等谁、要什么,以及它留下了什么**。
 *
 * `artifacts` 是**只有这个环节的**那几条(调用方用 `splitArtifactsByWork().byWork`
 * 取),不是整个项目的工件 —— 把全项目的工件铺进每个节点是这一版最要防的那种错。
 */
export function WorkNodePanel({
  work,
  works,
  artifacts,
  known,
  openId,
  onToggleDetail,
}: {
  work: WorkView;
  /** 本项目全部工作项 —— 只用来把 dependsOn 的 id 翻成标题 */
  works: readonly WorkView[];
  /** **这个环节**挂着的工件(已按 workId 分好) */
  artifacts: readonly ArtifactView[];
  known: readonly ArtifactView[];
  openId: string | null;
  onToggleDetail: (artifactId: string) => void;
}) {
  const deps = work.dependsOn;
  return (
    <Section
      title="选中的环节"
      count={artifacts.length}
      hintTitle="点 DAG 上的节点切换环节;再点一次同一个节点取消选中。"
      aside={
        <span className="ss-meta font-mono" title="工作项 id">
          {work.id}
        </span>
      }
    >
      <article className="sansheng-card p-3 flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <Pill tone={workStatusTone(work.status)} title={work.status}>
            {workStatusLabel(work.status)}
          </Pill>
          <span className="ss-body" style={{ color: "var(--bone)" }}>
            {work.title || "(无标题)"}
          </span>
        </div>

        <div className="flex flex-col">
          {/* ⚠️ `KV` 的 `title` 是**显示在屏幕上的**注解,不是 HTML 属性(见
              primitives.tsx)—— 长解释一律走真 `title=`,否则首屏会多出两行小字。 */}
          <KV label="负责人" value={work.assigneeName || work.assigneeAgentId} />
          <KV
            label="更新"
            value={<span title="契约 WorkView.updatedAt">{fmtTime(work.updatedAt)}</span>}
          />
          <KV
            label="前置"
            value={
              deps.length === 0 ? (
                <span title="契约 WorkView.dependsOn 为空:这条环节不依赖别的工作项">
                  没有前置依赖
                </span>
              ) : (
                <span
                  className="flex items-center gap-1.5 flex-wrap"
                  title="契约 WorkView.dependsOn:本环节依赖哪些工作项(它们是 DAG 上的虚线入边)"
                >
                  {deps.map((id, i) => {
                    const dep = works.find((w) => w.id === id);
                    return (
                      <span key={id} className="flex items-center gap-1.5">
                        {i > 0 && <span>·</span>}
                        {dep !== undefined ? (
                          <span title={`工作项 id:${id}`}>{dep.title || id}</span>
                        ) : (
                          <span className="ss-meta" title={`工作项 id:${id}`}>
                            {id}(本次列表里没有这条工作项)
                          </span>
                        )}
                      </span>
                    );
                  })}
                </span>
              )
            }
          />
        </div>

        {work.goal.length === 0 ? (
          <div className="ss-note">这条工作项没有写目标(goal 为空)。</div>
        ) : (
          <>
            <Clamp lines={2}>{work.goal}</Clamp>
            <Disclosure summary="目标全文">
              <div style={{ whiteSpace: "pre-wrap" }}>{work.goal}</div>
            </Disclosure>
          </>
        )}

        <div>
          <div className="ss-section" style={{ fontSize: 12 }}>
            它挂着的工件({artifacts.length})
          </div>
          {artifacts.length === 0 ? (
            <div className="ss-note">这条工作项还没有产出工件。</div>
          ) : (
            <ArtifactGroups
              artifacts={artifacts}
              known={known}
              openId={openId}
              onToggleDetail={onToggleDetail}
            />
          )}
        </div>
      </article>
    </Section>
  );
}

// ── ③ 不挂在任何环节上的工件 ────────────────────────────────────

/**
 * `workId === null` 的工件:决策 / 会议记录 / 变更记录 / 甲方问答。
 *
 * 这一块**必须自己带一句说明**:它们不是「还没归位」,而是本来就不由某条工作项
 * 产出(契约 `ArtifactView.workId` 的注释逐字写着这件事)。不写这句,读者会把它
 * 读成「流程漏了几条产出」。
 */
export function UnattachedArtifacts({
  artifacts,
  known,
  openId,
  onToggleDetail,
}: {
  artifacts: readonly ArtifactView[];
  known: readonly ArtifactView[];
  openId: string | null;
  onToggleDetail: (artifactId: string) => void;
}) {
  return (
    <Section
      title="不挂在任何环节上的工件"
      count={artifacts.length}
      hintTitle="这些工件的 workId 为 null —— 契约里这是合法状态:它们不由某条工作项产出。"
    >
      {/* `.ss-dag-orphan`:安静一点,不与主图争注意力(类在 globals.css 里)。 */}
      <div className="ss-dag-orphan">
        <div className="ss-note" style={{ marginBottom: 6 }}>
          {"这些是决策 / 会议记录 / 变更记录 / 甲方问答 —— 它们本来就不由某条工作项产出" +
            "(契约里 ArtifactView.workId 为 null 是合法状态,不是「还没归位」)," +
            "所以它们不出现在上面的流程图上。"}
        </div>
        <ArtifactGroups
          artifacts={artifacts}
          known={known}
          openId={openId}
          onToggleDetail={onToggleDetail}
        />
      </div>
    </Section>
  );
}

// ── ④ 环节读不到的工件 ──────────────────────────────────────────

/**
 * `workId` 指向一条**本次没加载到**的工作项。理论上被外键挡住,但读面必须容错:
 * 直接丢掉它们等于让几条工件无声消失(「见不到的现场等于没有现场」)。
 * 按 workId 分组列出,并写明是**环节读不到**,不是工件没有环节。
 */
export function DanglingArtifacts({
  dangling,
  known,
  openId,
  onToggleDetail,
}: {
  dangling: ReadonlyMap<string, ArtifactView[]>;
  known: readonly ArtifactView[];
  openId: string | null;
  onToggleDetail: (artifactId: string) => void;
}) {
  const entries = [...dangling.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const total = entries.reduce((n, [, rows]) => n + rows.length, 0);
  return (
    <Section
      title="环节读不到的工件"
      count={total}
      hintTitle="它们挂着 workId,但本次没有读到那条工作项(通常是被删了)—— 不是它们没有环节。"
    >
      <div className="grid gap-3">
        {entries.map(([workId, rows]) => (
          <div key={workId}>
            <div className="ss-note" style={{ marginBottom: 4 }}>
              挂在 {workId} 上,但本次读不到这条工作项。
            </div>
            <ArtifactGroups
              artifacts={rows}
              known={known}
              openId={openId}
              onToggleDetail={onToggleDetail}
            />
          </div>
        ))}
      </div>
    </Section>
  );
}

// ── 四块的组织(纯 props,测试直接渲染它)──────────────────────────

/**
 * 工件页的四块。**纯 props**:选择态由 `picked` 传入,默认选中也在这一层定,
 * 于是「默认选谁」这件事可以在测试里被钉住,而不是散在 hook 之间。
 *
 * `picked` 的三态:
 *   - `undefined` —— 用户还没点过任何节点 ⇒ 用**默认选中的环节**;
 *   - `string`    —— 用户点了它;
 *   - `null`      —— 用户明确取消(再点一次选中项),这时只显示图 + 提示。
 *
 * 默认选中的是**布局里第一个有功件的环节**(从左到右、从上到下第一个)—— 它最可能
 * 就是读者想先看的那一步(流程的起点附近),而且「有没有工件」是这一版的分界线:
 * 没有工件的环节给的是一句「还没有产出工件」,先看它没有信息量。
 */
export function ArtifactsBody({
  works,
  artifacts,
  live,
  picked,
  onPick,
  openId,
  onToggleDetail,
}: {
  works: readonly WorkView[];
  artifacts: readonly ArtifactView[];
  live: DagLive | null;
  picked: string | null | undefined;
  onPick: (workId: string | null) => void;
  openId: string | null;
  onToggleDetail: (artifactId: string) => void;
}) {
  const layout = layoutWorkDag(works, artifacts);
  const split = splitArtifactsByWork(artifacts, works);

  const defaultId = layout.nodes.find((n) => n.artifactCount > 0)?.work.id ?? null;
  // 选中的那条工作项可能已经不在本次列表里(项目换了 / 工作项被删)⇒ 退回默认,
  // 不留一个指向空气的选择。
  const selectedId =
    picked === undefined
      ? defaultId
      : picked === null
        ? null
        : layout.nodes.some((n) => n.work.id === picked)
          ? picked
          : defaultId;
  const selectedWork = works.find((w) => w.id === selectedId) ?? null;

  return (
    <div className="grid gap-4">
      <Section
        title="产出流程"
        count={works.length}
        hint="环节 = 工作项;工件挂在产出它的环节上"
        hintTitle="GET /api/projects/:id/works 画节点,GET /api/projects/:id/artifacts 里每条的 workId 把它挂到环节上。边有两条来源:parentWorkId(拆解,实线)与 dependsOn(前置,虚线)。"
      >
        {works.length === 0 ? (
          <EmptyState>
            这个项目还没有工作项 —— 产出流程要等项目经理拆出第一条工作项才有节点。
          </EmptyState>
        ) : (
          <WorkDag layout={layout} live={live} selectedId={selectedId} onSelect={onPick} />
        )}
      </Section>

      {works.length > 0 &&
        (selectedWork === null ? (
          <EmptyState>点一个环节看它的产出。</EmptyState>
        ) : (
          <WorkNodePanel
            work={selectedWork}
            works={works}
            artifacts={split.byWork.get(selectedWork.id) ?? []}
            known={artifacts}
            openId={openId}
            onToggleDetail={onToggleDetail}
          />
        ))}

      {/* ③ 与 ④ 只有**真的有条目**才渲染(空块会被读成「漏了东西」)。 */}
      {split.noWork.length > 0 && (
        <UnattachedArtifacts
          artifacts={split.noWork}
          known={artifacts}
          openId={openId}
          onToggleDetail={onToggleDetail}
        />
      )}

      {split.dangling.size > 0 && (
        <DanglingArtifacts
          dangling={split.dangling}
          known={artifacts}
          openId={openId}
          onToggleDetail={onToggleDetail}
        />
      )}
    </div>
  );
}

// ── 页面:取数 + 两个交互态 ──────────────────────────────────────

export function ArtifactsPage() {
  const projects = useChatStore((s) => s.projects);
  const activeProjectId = useChatStore((s) => s.projectId);
  const [scope, setScope] = useState<string | null>(activeProjectId);
  /** 用户手动选中的环节(见 `ArtifactsBody` 的三态说明)。 */
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  /** 展开了详情的那条工件 id(null = 都收起)。 */
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    // 用户在对话页切了项目 → 工件页跟着切(不然会对着旧项目的工件发呆),
    // 同时把两个交互态清掉:选中项与详情都指向旧项目的 id。
    setScope(activeProjectId);
    setPicked(undefined);
    setOpenId(null);
  }, [activeProjectId]);

  const worksLoad = useWorks(scope);
  const artifactsLoad = useArtifacts({ projectId: scope });
  const liveLoad = useProjectLive(scope);

  const works = worksLoad.data;
  const artifacts = artifactsLoad.data;
  const error = worksLoad.error ?? artifactsLoad.error;
  /**
   * ⚠️ live 只在**没有出错**时当事实。轮询失败后 `useLoad` 会留着上一帧,
   * 拿旧快照渲染「此刻在跑」等于把过去冒充现场 —— 出错时按「读不到」处理
   * (`workRunningState(work, null)` 给 `unknown: true`,界面据此不点亮节点)。
   */
  const live: DagLive | null = liveLoad.error === null ? liveLoad.data : null;

  const unattachedCount = useMemo(
    () => splitArtifactsByWork(artifacts, works).noWork.length,
    [artifacts, works],
  );

  const scopeName =
    scope === null ? "未选项目" : projects.find((p) => p.id === scope)?.name ?? scope;
  /** 「还没查过」与「查过了,是空」必须分开(见 lib/data.ts 文件头)。 */
  const nothingYet = works.length === 0 && artifacts.length === 0;

  return (
    <div className="ss-page">
      <PageHeader
        title="工件"
        hint={`范围:${scopeName}`}
        hintTitle="数据来源:GET /api/projects/:id/artifacts 与 /works、/live。契约没有跨项目的 /api/artifacts。kind / status / work_status 都是契约里的闭合集合。"
        aside={
          <div className="flex items-center gap-1.5 flex-wrap">
            <select
              value={scope ?? ""}
              onChange={(e) => setScope(e.target.value === "" ? null : e.target.value)}
              style={{
                background: "var(--ink-1)",
                border: "1px solid var(--ink-3)",
                borderRadius: 4,
                padding: "2px 4px",
                color: "var(--bone-dim)",
                fontSize: 11,
              }}
              title="选择项目"
            >
              <option value="">选择项目…</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <StatStrip
              items={[
                { label: "环节", value: works.length, title: "本项目的工作项数(GET /works)" },
                { label: "工件", value: artifacts.length, title: "本项目的工件数(GET /artifacts)" },
                {
                  label: "无环节",
                  value: unattachedCount,
                  title: "workId 为 null 的工件数 —— 它们不由某条工作项产出,列在页面下方那一块",
                },
              ]}
            />
          </div>
        }
      />

      {scope === null ? (
        <EmptyState>先在「对话」页的左栏选一个项目,或在上面的选择器里挑一个。</EmptyState>
      ) : error !== null ? (
        <div className="sansheng-card p-3 text-xs" style={{ color: "var(--cinnabar)" }}>
          加载失败:{error}
        </div>
      ) : (worksLoad.loading || artifactsLoad.loading) && nothingYet ? (
        <EmptyState>加载中…</EmptyState>
      ) : nothingYet ? (
        <EmptyState>
          这个项目还没有工作项,也没有工件。项目跑起来后,环节与工件会落在这里。
        </EmptyState>
      ) : (
        <ArtifactsBody
          works={works}
          artifacts={artifacts}
          live={live}
          picked={picked}
          onPick={setPicked}
          openId={openId}
          onToggleDetail={(id) => setOpenId((cur) => (cur === id ? null : id))}
        />
      )}
    </div>
  );
}

// ── 工件详情(有状态:按 id 单独拉一次)──────────────────────────

/**
 * 工件详情。展开时按 id 拉一次 `GET /api/artifacts/:id`。
 *
 * `known` 只用来**顺手**把关联目标的标题显示出来(目标恰好在本次列表里时),
 * 不做二次请求 —— 目标不在列表里就只显示 id,不编一个标题出来。
 *
 * **详情单独拉一次,不拿列表里那条凑**:契约给了 `/:id` 这条端点,它的存在意义
 * 就是「列表里的字段可能不是全量」;用列表项假装详情,等于把那条端点变成死代码。
 */
function ArtifactDetail({ id, known }: { id: string; known: readonly ArtifactView[] }) {
  const [artifact, setArtifact] = useState<ArtifactView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setArtifact(null);
    setError(null);
    getArtifact(id)
      .then((r) => {
        if (cancelled) return;
        setArtifact(r.artifact);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorMessage(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const titleOf = (targetId: string): string | null =>
    known.find((k) => k.id === targetId)?.title ?? null;

  return (
    <div
      className="mt-2"
      style={{ borderTop: "1px solid var(--ink-3)", paddingTop: 6 }}
      title="GET /api/artifacts/:id"
    >
      {error !== null ? (
        <div className="text-xs" style={{ color: "var(--cinnabar)" }}>
          详情加载失败:{error}
        </div>
      ) : loading ? (
        <div className="ss-meta">详情加载中…</div>
      ) : artifact === null ? (
        <div className="ss-meta">读不到这条工件的详情。</div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <Pill tone={artifactKindTone(artifact.kind)} title={artifact.kind}>
              {artifactKindLabel(artifact.kind)}
            </Pill>
            <Pill tone={artifactStatusTone(artifact.status)} title={artifact.status}>
              {artifactStatusLabel(artifact.status)}
            </Pill>
            <span className="ss-body" style={{ color: "var(--bone)" }}>
              {artifact.title || "(无标题)"}
            </span>
            <span className="ss-meta ml-auto">
              {artifact.authorName || artifact.authorAgentId} · {fmtTime(artifact.createdAt)}
            </span>
          </div>

          {artifact.body.length > 0 ? (
            <>
              <div className="ss-section" style={{ fontSize: 12 }}>
                正文
              </div>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  fontSize: 12,
                  lineHeight: 1.7,
                  margin: 0,
                  padding: "6px 8px",
                  background: "var(--ink-1)",
                  border: "1px solid var(--ink-3)",
                  borderRadius: 6,
                  color: "var(--bone-dim)",
                  maxHeight: 420,
                  overflow: "auto",
                }}
              >
                {artifact.body}
              </pre>
            </>
          ) : (
            <div className="ss-note">这条工件没有正文(body 为空)。</div>
          )}

          <div>
            <div className="ss-section" style={{ fontSize: 12 }}>
              关联({artifact.links.length})
            </div>
            {artifact.links.length === 0 ? (
              <div className="ss-note">没有出边 —— 这条工件不挂在别的工件上。</div>
            ) : (
              <div className="flex flex-col">
                {artifact.links.map((l) => {
                  const t = titleOf(l.targetId);
                  return (
                    <KV
                      key={`${l.rel}:${l.targetId}`}
                      label={REL_LABEL[l.rel] ?? l.rel}
                      value={t ?? l.targetId}
                      title={t !== null ? l.targetId : "该目标不在本次列表里,只显示 id"}
                    />
                  );
                })}
              </div>
            )}
          </div>

          <Disclosure summary="原始字段">
            <div className="flex flex-col gap-0.5">
              <span>工件 id:{artifact.id}</span>
              <span>项目 id:{artifact.projectId}</span>
              <span>kind:{artifact.kind}</span>
              <span>status:{artifact.status}</span>
              <span>作者 id:{artifact.authorAgentId}</span>
              <span>作者名(authorName):{artifact.authorName}</span>
              <span>产出它的环节(workId):{artifact.workId ?? "null(不由工作项产出)"}</span>
              <span>创建:{fmtTime(artifact.createdAt)}</span>
              <span>更新:{fmtTime(artifact.updatedAt)}</span>
            </div>
          </Disclosure>
        </div>
      )}
    </div>
  );
}
