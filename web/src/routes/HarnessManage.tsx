/**
 * 「Harness 管理」—— 跨角色的单元总览与编辑(2026-11-14)
 *
 * ── 它是什么、不是什么 ────────────────────────────────────────────
 *
 * 一屏看清五个角色:左列角色清单(告警角标),右列选中角色的三段(提示词单元 /
 * 工具面 / 代码内常量),顶部一行跨角色的全局问题(缺失单元 / 无效集合文件 /
 * 陌生集合文件)。它是 2026-10-06 那笔裁决的**例外**,不是翻案:
 * 那一刀删的是「顶层平级的一站 + 一行角色页签」(导航恒 6 项仍然成立 —— 本页
 * **没有页签**,入口在成员页 harness 卡的 aside 链接上,地址可分享)。
 *
 * ── 纪律(每一条都有落点)────────────────────────────────────────
 *
 *  1. **事实只来自 `GET /api/harness`,读法只有一份** —— 全部判据复用
 *     `components/harness/judgments.ts`(`roleIssueCount` / `harnessStatusText` /
 *     `harnessGlobalIssues` / `resolveSelectedRole` / `toolCountText` /
 *     `toolSetStateDetail`),编辑器与工具面复用 `harness/PromptUnitEditor.tsx` 与
 *     `harness/Blocks.tsx`。本文件**不写任何状态词**(「已加载 / 缺失 / 求解不了 /
 *     生效中」都不在这里)—— 那是哨兵钉住的
 *     (`tests/web/harness-manage.test.ts`:第二套状态判据不许出现)。
 *  2. **选中态住在地址里**(`#/harness?role=…`),深链接可分享;读法是
 *     `resolveSelectedRole`:没点名才退到第一个角色,点名了不存在就如实说
 *     「没有这个角色」,不静默替换。
 *  3. **四态**走 `ui/DataState`:取数失败是「读不到」,不许说成「没有角色」。
 *  4. **写面只有提示词单元**(保存 / 恢复出厂 / 备份数,经共享编辑器);
 *     工具集合文件本批无写面 —— 如实注明「直接编辑文件」,出处 `harness.toolset`。
 *  5. **代码内常量只读** —— ceiling / writeKinds / boundaryDeny 标注「改不了」
 *     (`RoleConstants`),不让用户去找一个不存在的开关。
 */
import { useMemo } from "react";
import type {
  HarnessView,
  ProjectRole,
  RoleHarnessView,
} from "@shared/types/platform";
import { DataState, remoteOf } from "@/components/ui/DataState";
import { EmptyState, Flag, PageHeader, Pill, Section } from "@/components/ui/primitives";
import { PromptUnitEditor } from "@/components/harness/PromptUnitEditor";
import { RoleConstants, ToolSurface, ToolSetAlerts } from "@/components/harness/Blocks";
import {
  harnessGlobalIssues,
  harnessStatusText,
  resolveSelectedRole,
  roleIssueCount,
  sharedUnitOwners,
  type HarnessGlobalIssue,
} from "@/components/harness/judgments";
import { useHarnessWorkspace } from "@/components/harness/useHarnessWorkspace";
import { paramOf, useAppLocation } from "@/lib/route";

/**
 * 顶部一行**全局状态**:哪几类问题现在存在(跨角色聚合,判据
 * `harnessGlobalIssues`)。空数组 = 数据已 ready 且真的没有问题 —— 那一行写
 * 「没有」,是有据的「没有」,不是「没查」。
 */
export function GlobalStatusBar({ view }: { view: HarnessView }) {
  const issues = harnessGlobalIssues(view);
  if (issues.length === 0) {
    return (
      <div className="ss-meta" style={{ color: "var(--bone-dim)" }}>
        无缺失单元 · 无无效集合文件 · 无陌生集合文件
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      {issues.map((i: HarnessGlobalIssue) => (
        <Flag key={i.kind} tone="cinnabar">
          <span className="ss-meta">{i.headline}</span>
          <span className="ss-body">{i.detail}</span>
        </Flag>
      ))}
    </div>
  );
}

/**
 * 左列角色清单:一行一角色(角色名 + 告警角标)。角标数字来自 `roleIssueCount`
 * —— 与成员页签**同一个判据**;0 处时**不渲染**(把「没问题」刷成一条要读的字,
 * 与成员页签的负样本同一条纪律)。
 *
 * 选中态写进地址(`onSelect` → `?role=`),所以 F5 / 分享链接都落回同一角色。
 */
export function RoleListNav({
  roles,
  active,
  onSelect,
}: {
  roles: readonly RoleHarnessView[];
  /** 当前选中的角色 id;`null` = 还没选(视图里没有角色时) */
  active: ProjectRole | null;
  onSelect: (role: ProjectRole) => void;
}) {
  return (
    <nav className="flex flex-col gap-1" aria-label="角色清单">
      {roles.map((r) => {
        const issues = roleIssueCount(r);
        const activeHere = r.role === active;
        return (
          <button
            key={r.role}
            type="button"
            className="sansheng-button"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
              padding: "6px 9px",
              background: activeHere ? "var(--ink-2)" : "transparent",
              color: activeHere ? "var(--bone)" : "var(--bone-dim)",
              borderColor: activeHere ? "var(--ink-4)" : "transparent",
            }}
            aria-current={activeHere ? "true" : undefined}
            onClick={() => onSelect(r.role)}
          >
            <span style={{ fontSize: 12 }}>{r.displayName}</span>
            {issues > 0 && (
              <Pill tone="cinnabar" title={`harness 有 ${issues} 处需要注意`}>
                {issues}
              </Pill>
            )}
          </button>
        );
      })}
    </nav>
  );
}

/**
 * 右列:选中角色的**三段**。三段的事实与措辞全部来自共享件
 * (`PromptUnitEditor` / `Blocks` / `judgments`),本文件不另写一套。
 */
export function RoleDetailPane({
  role,
  view,
  requested,
  drafts,
  backups,
  onDraftChange,
  onApplied,
}: {
  /** 选中角色;`null` = 视图里没有角色 / 视图为空(两种情况在下面分开说) */
  role: RoleHarnessView | null;
  view: HarnessView;
  /** 地址里点名的角色(`?role=`);`null` = 没点名(默认第一个) */
  requested: string | null;
  drafts: Readonly<Record<string, string>>;
  backups: Readonly<Record<string, number>>;
  onDraftChange: (unitId: string, next: string) => void;
  /** 保存 / 恢复成功 —— 参数是后端**回读**到的正文 */
  onApplied: (unitId: string, content: string) => void;
}) {
  const owners = useMemo(() => sharedUnitOwners(view.roles), [view]);

  if (role === null) {
    // 两种「没有」分开说:视图是空的(不该发生,如实说)vs 地址点名了不存在
    // 的角色(那是深链接指错了地方,**不许**静默退到第一个角色装成功)。
    return view.roles.length === 0 ? (
      <EmptyState>这一份 harness 视图里没有任何角色。</EmptyState>
    ) : (
      <EmptyState>
        这一份 harness 视图里没有角色 {requested}(地址点名的角色不存在;与「它没有
        提示词单元」是两件事)。
      </EmptyState>
    );
  }

  return (
    <article className="sansheng-card p-3 flex flex-col gap-3">
      <header className="flex items-baseline gap-2 flex-wrap">
        <h2 className="ss-title" style={{ fontSize: 15 }}>
          {role.displayName}
        </h2>
        <span className="ss-meta font-mono">{role.role}</span>
        {role.clientFacing && <Pill tone="jade">甲方接口</Pill>}
        <span
          className="ss-meta ml-auto"
          style={{ color: roleIssueCount(role) > 0 ? "var(--cinnabar)" : "var(--bone-dim)" }}
        >
          {harnessStatusText(role)}
        </span>
      </header>

      {/* ① 提示词单元:每单元一行(状态 · 字数 · 备份数),点「编辑」进编辑器。
          编辑器与成员页共用同一份(`harness/PromptUnitEditor`)—— 写面规矩
          (回读值当状态 / 两段式确认)只在那一处实现。 */}
      <Section title="提示词单元" count={role.promptUnits.length}>
        {role.promptUnits.length === 0 ? (
          <div className="ss-note">这个角色没有声明任何提示词单元。</div>
        ) : (
          <div className="flex flex-col">
            {role.promptUnits.map((u) => (
              <PromptUnitEditor
                key={u.id}
                unit={u}
                value={drafts[u.id] ?? u.content}
                backups={backups[u.id]}
                sharedWith={owners.get(u.id) ?? []}
                onChange={(v) => onDraftChange(u.id, v)}
                onApplied={(content) => onApplied(u.id, content)}
              />
            ))}
          </div>
        )}
      </Section>

      {/* ② 工具面:实得工具数 · 集合文件状态与路径 · 越权被拒清单(只读)。
          集合文件本批无写面 —— 注明「直接编辑文件」(出处 harness.toolset)。 */}
      <Section title="工具面" helpId="harness.toolset">
        <div className="flex flex-col gap-2">
          <ToolSurface role={role} />
          <ToolSetAlerts role={role} />
        </div>
      </Section>

      {/* ③ 代码内常量:ceiling / writeKinds / boundaryDeny,只读。 */}
      <Section title="代码内常量">
        <RoleConstants role={role} />
      </Section>
    </article>
  );
}

export function HarnessManagePage() {
  const ws = useHarnessWorkspace();
  const { loc, setParam } = useAppLocation();
  /** 深链接 `#/harness?role=…` —— 选中态住在地址里,不在组件 state。 */
  const requested = paramOf(loc, "role");

  return (
    <div className="ss-page">
      <PageHeader title="Harness 管理" helpId="harness.card" />
      <DataState
        what="harness 视图"
        state={remoteOf(ws.view, ws.error, ws.loading && ws.view === null)}
        loadingLabel="正在读取 harness 视图…"
        unavailable="读不到 harness 视图。"
        errorNote=" —— 这是「读不到 harness 视图」,不是「角色没有提示词单元」。"
      >
        {(view) => {
          const selected = resolveSelectedRole(requested, view.roles);
          return (
            <>
              <GlobalStatusBar view={view} />
              <div className="grid gap-3" style={{ gridTemplateColumns: "minmax(150px, 190px) minmax(0, 1fr)", alignItems: "start" }}>
                <RoleListNav
                  roles={view.roles}
                  active={selected?.role ?? null}
                  onSelect={(r) => setParam("role", r)}
                />
                <RoleDetailPane
                  role={selected}
                  view={view}
                  requested={requested}
                  drafts={ws.drafts}
                  backups={ws.backups}
                  onDraftChange={ws.onDraftChange}
                  onApplied={ws.applyContent}
                />
              </div>
            </>
          );
        }}
      </DataState>
    </div>
  );
}
