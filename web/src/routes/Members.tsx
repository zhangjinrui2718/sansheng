/**
 * 成员屏(取代旧的 `Agents.tsx`)
 *
 * ── 为什么换了主体 ──────────────────────────────────────────────
 *
 * 旧页是「Agent 工作面」:从**工件 author** 反推 planner / executor / harness_manager
 * 在不在跑,还画了一张 todo 的 DAG —— 那是旧系统「按 agent 分工 + 计划即 todo」的
 * 读法,而计划概念在新架构里已删除、agent 也不再是自由命名的角色。
 *
 * 新模型里人/角色的真身在两处:
 *   1. **本项目成员** —— `ProjectDetail.members`(MemberView:role / displayName /
 *      specialization),四个固定职能;
 *   2. **每个角色的能力面** —— `GET /api/harness`(ceiling / writeKinds / tools /
 *      clientFacing),这是只读的架构常量视图。
 *
 * 本页把这两件事并排:左边「这个项目里有谁」,右边「每个角色能做什么」。
 * 详情(提示词单元、逐工具名单、是否踩到 ceiling)在 Harness 页。
 */
import { useEffect, useState } from "react";
import type { HarnessView } from "@shared/types/platform";
import { EmptyState, KV, PageHeader, Pill, Section } from "@/components/ui/primitives";
import { getHarness, errorMessage } from "@/lib/api";
import { useProjectMembers } from "@/lib/data";
import { useChatStore } from "@/stores/chat";
import { ROLE_LABEL } from "@/lib/vocab";

export function MembersPage() {
  const projectId = useChatStore((s) => s.projectId);
  const projects = useChatStore((s) => s.projects);
  const { data: members, loading, error } = useProjectMembers(projectId);
  const projectName = projects.find((p) => p.id === projectId)?.name;

  const [harness, setHarness] = useState<HarnessView | null>(null);
  const [harnessError, setHarnessError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHarness()
      .then((h) => {
        if (!cancelled) setHarness(h);
      })
      .catch((e: unknown) => {
        if (!cancelled) setHarnessError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="ss-page">
      <PageHeader
        title="成员"
        hint={projectName}
        hintTitle="本项目成员来自 GET /api/projects/:id/members;角色能力面来自只读的 GET /api/harness。"
      />

      <Section
        title="本项目成员"
        count={members.length}
        hint="四个固定职能:业务经理 / 项目经理 / 执行者 / 质检审查员"
      >
        {!projectId ? (
          <EmptyState>先在「对话」页的左栏选一个项目。</EmptyState>
        ) : error !== null ? (
          <div className="ss-empty" style={{ color: "var(--cinnabar)" }}>
            加载失败:{error}
          </div>
        ) : loading && members.length === 0 ? (
          <EmptyState>加载中…</EmptyState>
        ) : members.length === 0 ? (
          <EmptyState>这个项目还没有成员。</EmptyState>
        ) : (
          <div className="sansheng-card px-3 py-1.5">
            {members.map((m) => (
              <KV
                key={m.id}
                label={ROLE_LABEL[m.role]}
                value={m.displayName}
                title={m.specialization !== null ? `专长 ${m.specialization} · ${m.id}` : m.id}
              />
            ))}
          </div>
        )}
      </Section>

      <Section
        title="角色能力面"
        count={harness?.roles.length ?? 0}
        hint="只读 · 架构常量"
        hintTitle="ceiling 是代码内常量(不是可编辑文件),前端如实标注这一点;工具集合已过三重门控。"
      >
        {harnessError !== null ? (
          <div className="ss-empty" style={{ color: "var(--cinnabar)" }}>
            读取失败:{harnessError}
          </div>
        ) : harness === null ? (
          <EmptyState>加载中…</EmptyState>
        ) : (
          <div className="grid gap-2">
            {harness.roles.map((r) => (
              <article key={r.role} className="sansheng-card p-2.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="ss-body" style={{ color: "var(--bone)" }}>
                    {r.displayName}
                  </span>
                  {r.clientFacing && <Pill tone="jade">甲方接口</Pill>}
                  <span className="ss-meta ml-auto font-mono">{r.role}</span>
                </div>
                <div className="ss-meta mt-1">
                  能力 {r.ceiling.length} 项 · 可写 {r.writeKinds.length} 类 · 实得工具{" "}
                  {r.tools.length} 个
                  {r.blockedByCeiling.length > 0 && ` · 越界 ${r.blockedByCeiling.length} 项`}
                </div>
                {r.tools.length > 0 && (
                  <div className="ss-note mt-0.5" title={r.tools.join(" · ")}>
                    工具:{r.tools.slice(0, 6).join(" · ")}
                    {r.tools.length > 6 ? ` …(+${r.tools.length - 6})` : ""}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
